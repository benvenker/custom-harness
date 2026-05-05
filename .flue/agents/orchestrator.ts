import * as v from 'valibot';
import type { FlueContext } from '@flue/sdk/client';
import { runSmithersWorkflow } from '../../src/workflow/runner.js';

// --- Plan schema (valibot — Flue's native structured output library) ---

const taskNodeSchema = v.object({
  type: v.literal('task'),
  name: v.string(),
  prompt: v.string(),
});

// Valibot requires v.lazy() for recursive types
type WorkflowNodeInput = v.InferInput<typeof taskNodeSchema> | {
  type: 'sequence' | 'parallel';
  name?: string;
  children: WorkflowNodeInput[];
};

const workflowNodeSchema: v.GenericSchema<WorkflowNodeInput> = v.union([
  taskNodeSchema,
  v.object({
    type: v.union([v.literal('sequence'), v.literal('parallel')]),
    name: v.optional(v.string()),
    children: v.array(v.lazy(() => workflowNodeSchema)),
  }),
]);

const planSchema = v.union([
  v.object({
    path: v.literal('harness'),
    reason: v.string(),
  }),
  v.object({
    path: v.literal('workflow'),
    reason: v.string(),
    workflow: v.object({
      name: v.string(),
      description: v.string(),
      root: workflowNodeSchema,
    }),
  }),
]);

// --- Agent handler ---

export default async function ({
  init,
  payload,
}: FlueContext<{ goal: string; context?: string }>) {
  const { goal, context } = payload;
  const fullGoal = goal + (context ? `\n\nAdditional context:\n${context}` : '');

  const agent = await init({
    model: 'anthropic/claude-sonnet-4-6',
    sandbox: 'local',
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = await (agent as any).session('meta-orchestrator');

  // Use Flue's native session.prompt() + valibot schema for structured output.
  // Provider-agnostic: swap the model string in init() to change LLM.
  console.log('Planning execution path...');
  const plan = await session.prompt(
    `You are an execution planner for a meta-harness combining Flue (agent harness) and Smithers (durable workflow engine).

Choose "harness" for: simple one-shot tasks, quick lookups, small code changes — anything one focused agent can do in a single loop.
Choose "workflow" for: multi-phase tasks, parallel work, long-running operations needing crash-resumability, or tasks with distinct sequential stages.

When choosing "workflow", design a Smithers workflow tree using:
- sequence: steps that must run in order
- parallel: independent steps that can run concurrently
- task: a single LLM step with a clear self-contained prompt

Goal: ${fullGoal}`,
    { result: planSchema },
  );

  console.log(`Path: ${plan.path} — ${plan.reason}\n`);

  if (plan.path === 'harness') {
    // Flue's session.task() runs an inner agent loop with sandbox + tools
    console.log('--- Harness Mode (Flue session.task) ---\n');
    const result = await session.task(fullGoal, { role: 'worker' });
    console.log('\n--- Result ---');
    console.log(result.text);
    return { path: 'harness', output: result.text };
  } else {
    // Smithers handles durable multi-step DAG execution
    console.log(`--- Workflow Mode: ${plan.workflow.name} ---`);
    console.log(`${plan.workflow.description}\n`);
    const output = await runSmithersWorkflow(goal, plan.workflow);
    console.log('\n--- Result ---');
    console.log(output);
    return { path: 'workflow', output };
  }
}
