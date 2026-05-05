import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { runSmithersWorkflow } from './workflow/runner.js';
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

const MODEL = 'anthropic/claude-sonnet-4-5';

// --- Planner (AI SDK generateObject — provider-agnostic structured output) ---

const planSchema = z.object({
  path: z.enum(['harness', 'workflow']),
  reason: z.string(),
  workflow: z
    .object({
      name: z.string(),
      description: z.string(),
      // root is intentionally z.any() — recursive Zod types don't serialise
      // cleanly to JSON Schema for generateObject; we validate shape at runtime
      root: z.any(),
    })
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
  const { object } = await generateObject({
    model: openrouter()(MODEL),
    schema: planSchema,
    system: PLANNER_PROMPT,
    prompt: `Goal: ${goal}` + (context ? `\n\nContext: ${context}` : ''),
  });
  return object;
}

// --- Execution paths ---

async function runHarness(goal: string, context?: string) {
  const fullGoal = goal + (context ? `\n\nAdditional context:\n${context}` : '');
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
    { stdout: 'inherit', stderr: 'inherit', env: { ...process.env } },
  );
  return proc.exited;
}

async function runWorkflow(goal: string, workflow: Workflow) {
  console.log(`--- Workflow Mode: ${workflow.name} ---`);
  console.log(`${workflow.description}\n`);
  const output = await runSmithersWorkflow(goal, workflow);
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

  console.log('Planning...');
  const result = await plan(goal, context ?? undefined);
  console.log(`Path: ${result.path} — ${result.reason}\n`);

  if (result.path === 'harness') {
    console.log('--- Harness Mode (Flue session.task) ---\n');
    await runHarness(goal, context ?? undefined);
  } else if (result.workflow) {
    await runWorkflow(goal, result.workflow as Workflow);
  } else {
    console.error('Planner chose workflow but returned no workflow definition');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
