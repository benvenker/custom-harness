import type { FlueContext } from '@flue/sdk/client';
import { planExecution } from '../../src/planner.js';
import { runSmithersWorkflow } from '../../src/workflow/runner.js';

export default async function ({
  init,
  payload,
}: FlueContext<{ goal: string; context?: string }>) {
  const { goal, context } = payload;

  // Our planner (Anthropic SDK tool_use) decides: Flue harness or Smithers workflow
  console.log('Planning execution path...');
  const plan = await planExecution({ description: goal, context });
  console.log(`Path: ${plan.path} — ${plan.reason}\n`);

  const agent = await init({
    model: 'anthropic/claude-sonnet-4-6',
    sandbox: 'local',
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = await (agent as any).session('meta-orchestrator');

  if (plan.path === 'harness') {
    // Flue inner agent loop via session.task()
    console.log('--- Harness Mode (Flue session.task) ---\n');
    const fullGoal =
      goal + (context ? `\n\nAdditional context:\n${context}` : '');
    const result = await session.task(fullGoal, { role: 'worker' });
    console.log('\n--- Result ---');
    console.log(result.text);
    return { path: 'harness', output: result.text };
  } else {
    // Smithers durable DAG execution
    console.log(`--- Workflow Mode: ${plan.workflow.name} ---`);
    console.log(`${plan.workflow.description}\n`);
    const output = await runSmithersWorkflow(goal, plan.workflow);
    console.log('\n--- Result ---');
    console.log(output);
    return { path: 'workflow', output };
  }
}
