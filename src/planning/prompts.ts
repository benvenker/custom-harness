import type { WorkflowNode } from '../types.js';

export const PLANNER_SYSTEM_PROMPT = `You are an execution planner for a Smithers-first durable outcome runner.

Choose "harness" for simple one-shot tasks, quick lookups, and small focused changes that one CLI agent can complete.
Choose "workflow" for multi-phase tasks, parallel work, long-running operations, or tasks with distinct sequential stages.

When choosing "workflow", define a root WorkflowNode tree. Supported node types:
  task       { type, name, prompt }
  sequence   { type, name?, children: WorkflowNode[] }
  parallel   { type, name?, children: WorkflowNode[] }

Return only JSON matching the required schema.`;

export function buildPlannerPrompt(goal: string, context?: string) {
  return `Goal: ${goal}${context ? `\n\nContext: ${context}` : ''}`;
}

export function buildHarnessPrompt(goal: string, context?: string) {
  return [
    `Goal: ${goal}`,
    context ? `Additional context:\n${context}` : null,
    TASK_OUTPUT_CONTRACT,
  ].filter(Boolean).join('\n\n');
}

export function buildTaskPrompt(args: {
  goal: string;
  context?: string;
  task: Extract<WorkflowNode, { type: 'task' }>;
  upstream?: Array<{ from: string; result?: string; artifact?: string }>;
}) {
  return [
    `Overall goal: ${args.goal}`,
    args.context ? `Additional context:\n${args.context}` : null,
    args.upstream && args.upstream.length > 0
      ? [
          'Upstream task outputs:',
          ...args.upstream.map((item) =>
            [
              `From ${item.from}:`,
              item.artifact ? `Artifact: ${item.artifact}` : null,
              item.result ? item.result : null,
            ].filter(Boolean).join('\n'),
          ),
        ].join('\n\n')
      : null,
    `Task: ${args.task.name}`,
    args.task.prompt,
    TASK_OUTPUT_CONTRACT,
  ].filter(Boolean).join('\n\n');
}

const TASK_OUTPUT_CONTRACT =
  'When complete, return a final answer as JSON matching this exact shape: {"result":"<your complete task output as a string>"}.';
