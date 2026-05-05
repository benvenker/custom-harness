import Anthropic from '@anthropic-ai/sdk';
import type {
  Workflow,
  WorkflowNode,
  TaskNode,
  BranchNode,
  LoopNode,
  TaskResult,
} from './types.js';
import {
  createRun,
  updateRunStatus,
  saveTaskResult,
  getCompletedTasks,
  findResumableRun,
} from './persistence.js';
import type { AgentResult } from '../types.js';

const MODEL = 'claude-sonnet-4-6';

interface Ctx {
  runId: string;
  goal: string;
  completed: Record<string, TaskResult>;
  client: Anthropic;
}

export async function runWorkflow(
  workflow: Workflow,
  goal: string,
): Promise<AgentResult> {
  const client = new Anthropic();

  const existingRunId = findResumableRun(workflow.name, goal);
  let runId: string;
  let completed: Record<string, TaskResult>;

  if (existingRunId) {
    runId = existingRunId;
    completed = getCompletedTasks(runId);
    const skipped = Object.keys(completed).length;
    console.log(`  Resuming run ${runId} — skipping ${skipped} completed task(s)`);
  } else {
    runId = crypto.randomUUID();
    completed = {};
    createRun(runId, workflow.name, goal);
    console.log(`  Run ID: ${runId}`);
  }

  const ctx: Ctx = { runId, goal, completed, client };

  try {
    await executeNode(workflow.root, ctx);
    updateRunStatus(runId, 'completed');

    const summary = Object.entries(ctx.completed)
      .map(([name, r]) => `  ${name}: ${JSON.stringify(r.output)}`)
      .join('\n');
    return {
      success: true,
      output: `Workflow "${workflow.name}" completed.\n\nTask results:\n${summary}`,
    };
  } catch (e) {
    updateRunStatus(runId, 'failed');
    return { success: false, output: `Workflow failed: ${e}`, error: String(e) };
  }
}

async function executeNode(node: WorkflowNode, ctx: Ctx): Promise<void> {
  switch (node.type) {
    case 'task':
      await executeTask(node, ctx);
      break;
    case 'sequence':
      for (const child of node.children) await executeNode(child, ctx);
      break;
    case 'parallel':
      await Promise.all(node.children.map((child) => executeNode(child, ctx)));
      break;
    case 'branch':
      await executeBranch(node, ctx);
      break;
    case 'loop':
      await executeLoop(node, ctx);
      break;
  }
}

async function executeTask(node: TaskNode, ctx: Ctx): Promise<void> {
  if (ctx.completed[node.name]) {
    console.log(`  [skip] ${node.name}`);
    return;
  }

  console.log(`  [run]  ${node.name}`);
  const startedAt = new Date();

  saveTaskResult(ctx.runId, { taskName: node.name, status: 'running', startedAt });

  const priorContext = buildPriorContext(ctx.completed);
  const userPrompt = priorContext
    ? `${node.prompt}\n\n---\nPrior task results:\n${priorContext}`
    : node.prompt;

  try {
    const response = await ctx.client.messages.create({
      model: MODEL,
      max_tokens: 8096,
      system: [
        {
          type: 'text',
          text: `You are executing one step in a durable workflow. Overall goal: ${ctx.goal}\n\nComplete the task and provide a clear, structured response.`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const output = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    const result: TaskResult = {
      taskName: node.name,
      status: 'completed',
      output,
      startedAt,
      completedAt: new Date(),
    };
    saveTaskResult(ctx.runId, result);
    ctx.completed[node.name] = result;
    console.log(`  [done] ${node.name}`);
  } catch (e) {
    const result: TaskResult = {
      taskName: node.name,
      status: 'failed',
      error: String(e),
      startedAt,
      completedAt: new Date(),
    };
    saveTaskResult(ctx.runId, result);
    throw new Error(`Task "${node.name}" failed: ${e}`);
  }
}

async function executeBranch(node: BranchNode, ctx: Ctx): Promise<void> {
  const priorContext = buildPriorContext(ctx.completed);
  const caseNames = node.cases.map((c) => `"${c.when}"`).join(', ');

  const response = await ctx.client.messages.create({
    model: MODEL,
    max_tokens: 256,
    system: 'You are a workflow condition evaluator. Respond with only the matching case name.',
    messages: [
      {
        role: 'user',
        content: `Condition: ${node.condition}\n\nAvailable cases: ${caseNames}\n\nContext:\n${priorContext}\n\nWhich case applies? Reply with only the case name, exactly as listed.`,
      },
    ],
  });

  const chosen = (
    response.content.find((c): c is Anthropic.TextBlock => c.type === 'text')
      ?.text ?? ''
  ).trim();

  const matched = node.cases.find(
    (c) =>
      c.when.toLowerCase() === chosen.toLowerCase() ||
      chosen.toLowerCase().includes(c.when.toLowerCase()),
  );

  if (matched) {
    await executeNode(matched.node, ctx);
  } else if (node.default) {
    await executeNode(node.default, ctx);
  }
}

async function executeLoop(node: LoopNode, ctx: Ctx): Promise<void> {
  const max = node.maxIterations ?? 10;
  for (let i = 0; i < max; i++) {
    const priorContext = buildPriorContext(ctx.completed);
    const response = await ctx.client.messages.create({
      model: MODEL,
      max_tokens: 64,
      system: 'You are a loop condition evaluator. Reply with only "continue" or "stop".',
      messages: [
        {
          role: 'user',
          content: `Condition: ${node.condition}\nIteration: ${i + 1}/${max}\n\nContext:\n${priorContext}`,
        },
      ],
    });

    const decision = (
      response.content.find((c): c is Anthropic.TextBlock => c.type === 'text')
        ?.text ?? ''
    )
      .toLowerCase()
      .trim();

    if (decision.startsWith('stop')) break;
    await executeNode(node.body, ctx);
  }
}

function buildPriorContext(completed: Record<string, TaskResult>): string {
  return Object.entries(completed)
    .map(([name, r]) => `### ${name}\n${r.output}`)
    .join('\n\n');
}
