import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { runSmithersWorkflow } from './workflow/runner.js';
import { createRunRecorder, type RunRecorder } from './runs/recorder.js';
import type { Workflow } from './types.js';

// --- Provider ---

function openrouter() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  return createOpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  });
}

const MODEL = 'anthropic/claude-sonnet-4-6';

// --- Planner (AI SDK generateObject — provider-agnostic structured output) ---

// Concrete finite-depth schema for WorkflowNode — Claude rejects z.any() / {}
// in structured output. Three levels of nesting covers all realistic plans.
const taskNode = z.object({ type: z.literal('task'), name: z.string(), prompt: z.string() });
const compositeL2 = z.object({
  type: z.enum(['sequence', 'parallel']),
  name: z.string().optional(),
  children: z.array(taskNode),
});
const nodeL2 = z.union([taskNode, compositeL2]);
const compositeL1 = z.object({
  type: z.enum(['sequence', 'parallel']),
  name: z.string().optional(),
  children: z.array(nodeL2),
});
const workflowNodeSchema = z.union([taskNode, compositeL1]);

const planSchema = z.object({
  path: z.enum(['harness', 'workflow']),
  reason: z.string(),
  workflow: z
    .object({ name: z.string(), description: z.string(), root: workflowNodeSchema })
    .optional(),
});

const PLANNER_PROMPT = `You are an execution planner for a meta-harness combining Flue (agent harness) and Smithers (durable workflow engine).

Choose "harness" for: simple one-shot tasks, quick lookups, small code changes — one focused agent can do it in a single loop.
Choose "workflow" for: multi-phase tasks, parallel work, long-running operations that need crash-resumability, or tasks with distinct sequential stages.

When choosing "workflow", define a root WorkflowNode tree. Supported node types:
  task       { type, name, prompt }
  sequence   { type, name?, children: WorkflowNode[] }
  parallel   { type, name?, children: WorkflowNode[] }`;

async function plan(goal: string, context?: string) {
  const result = await generateObject({
    model: openrouter()(MODEL),
    schema: planSchema,
    system: PLANNER_PROMPT,
    prompt: `Goal: ${goal}` + (context ? `\n\nContext: ${context}` : ''),
  });
  return { output: result.object, usage: result.usage };
}

// --- Execution paths ---

async function runHarness(goal: string, context: string | undefined, recorder: RunRecorder) {
  const fullGoal = goal + (context ? `\n\nAdditional context:\n${context}` : '');
  recorder.event('agent.init', { nodeId: 'worker', model: MODEL, synthesized: false });
  const proc = Bun.spawn(
    [
      'node_modules/.bin/flue',
      'run',
      'worker',
      '--target',
      'node',
      '--id',
      crypto.randomUUID(),
      '--payload',
      JSON.stringify({ goal: fullGoal }),
    ],
    { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
  );

  await Promise.all([
    pipeFlueStream(proc.stdout, recorder),
    pipeFlueStream(proc.stderr, recorder),
  ]);

  const exitCode = await proc.exited;
  recorder.event('agent.output', { nodeId: 'worker', artifact: 'artifacts/cli.log', synthesized: false });
  if (exitCode === 0) {
    recorder.event('task.done', { nodeId: 'worker', output: { exitCode }, synthesized: false });
  } else {
    recorder.event('run.error', { message: `Flue worker exited with ${exitCode}`, source: 'flue' });
    throw new Error(`Flue worker exited with ${exitCode}`);
  }
}

async function pipeFlueStream(stream: ReadableStream<Uint8Array> | null, recorder: RunRecorder) {
  if (!stream) return;
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    process.stdout.write(text);
    recorder.appendCli(text);
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) parseFlueLine(line, recorder);
  }
  const tail = decoder.decode();
  if (tail) {
    process.stdout.write(tail);
    recorder.appendCli(tail);
    pending += tail;
  }
  if (pending) parseFlueLine(pending, recorder);
}

function parseFlueLine(line: string, recorder: RunRecorder) {
  const match = line.match(/^\[flue\]\s+tool:(start|done|error)\s+(\S+)(?:\s+(.*))?$/);
  if (!match) return;
  const [, phase, name, arg] = match;
  const suffix = phase === 'start' ? '' : `.${phase}`;
  recorder.event(`tool.${name}${suffix}`, {
    nodeId: 'worker',
    arg: arg?.trim() || undefined,
    synthesized: false,
  });
}

async function runWorkflow(goal: string, workflow: Workflow, recorder: RunRecorder) {
  console.log(`--- Workflow Mode: ${workflow.name} ---`);
  console.log(`${workflow.description}\n`);
  const output = await runSmithersWorkflow(goal, workflow, recorder);
  console.log('\n--- Result ---');
  console.log(output);
}

// --- CLI ---

function parseArgs(args: string[]) {
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };
  return {
    goal: get('--goal'),
    context: get('--context'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printHelp() {
  console.log(`
custom-harness — meta-harness: Flue for agents, Smithers for workflows

USAGE
  bun src/index.ts --goal "<goal>"

HOW IT WORKS
  1. generateObject() plans: harness or workflow
  2. harness  → flue run worker  (Flue session.task inner agent loop)
  3. workflow → Smithers DAG     (crash-resumable, SQLite-checkpointed)

Provider: OpenRouter  (set OPENROUTER_API_KEY)
Model:    ${MODEL}

OPTIONS
  --goal <text>      Goal to accomplish (required)
  --context <text>   Additional context
  --help             Show this help
`);
}

async function main() {
  const { goal, context, help } = parseArgs(process.argv.slice(2));

  if (help) { printHelp(); process.exit(0); }
  if (!goal) { printHelp(); process.exit(1); }

  console.log(`\nGoal: ${goal}`);
  if (context) console.log(`Context: ${context}`);
  console.log('');

  const runId = crypto.randomUUID();
  const recorder = createRunRecorder(runId, { goal, model: MODEL });
  const runStartedAt = Date.now();
  recorder.event('run.started', { goal });

  let result: Awaited<ReturnType<typeof plan>> | null = null;
  try {
    console.log('Planning...');
    const planStartedAt = performance.now();
    result = await plan(goal, context ?? undefined);
    const plannerOutput = result.output;
    const planningLatencyMs = Math.round(performance.now() - planStartedAt);
    recorder.writePlan(plannerOutput, { planningLatencyMs, usage: result.usage });
    recorder.event('plan.decision', {
      path: plannerOutput.path,
      reason: plannerOutput.reason,
      rawPlan: plannerOutput,
      usage: result.usage,
    });
    console.log(`Path: ${plannerOutput.path} — ${plannerOutput.reason}`);
    console.log(`Run ID: ${runId}\n`);

    if (plannerOutput.path === 'harness') {
      console.log('--- Harness Mode (Flue session.task) ---\n');
      await runHarness(goal, context ?? undefined, recorder);
    } else if (plannerOutput.workflow) {
      await runWorkflow(goal, plannerOutput.workflow as Workflow, recorder);
    } else {
      throw new Error('Planner chose workflow but returned no workflow definition');
    }

    recorder.event('run.done', { status: 'succeeded' });
    recorder.finish('succeeded', { latencyMs: Date.now() - runStartedAt });
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recorder.event('run.error', { message, source: result?.output.path ?? 'cli' });
    recorder.finish('failed', { latencyMs: Date.now() - runStartedAt });
    throw err;
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
