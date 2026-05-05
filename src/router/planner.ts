import Anthropic from '@anthropic-ai/sdk';
import type { Goal } from '../types.js';
import type { Workflow } from '../workflow/types.js';

const MODEL = 'claude-sonnet-4-6';

export type Plan =
  | { path: 'harness'; reason: string }
  | { path: 'workflow'; reason: string; workflow: Workflow };

const PLANNING_TOOL: Anthropic.Tool = {
  name: 'create_execution_plan',
  description:
    'Decide how to execute the given goal: directly via harness (tool-calling agent loop) or as a structured durable workflow.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        enum: ['harness', 'workflow'],
        description:
          'harness = single agent loop (fast, simple tasks). workflow = multi-step durable execution (complex, parallel, or long-running tasks).',
      },
      reason: {
        type: 'string',
        description: 'One sentence explaining why this execution path was chosen.',
      },
      workflow: {
        type: 'object',
        description:
          'Required when path is "workflow". Defines the full workflow tree.',
        properties: {
          name: {
            type: 'string',
            description: 'Short kebab-case workflow identifier.',
          },
          description: {
            type: 'string',
            description: 'One sentence describing what this workflow does.',
          },
          root: {
            type: 'object',
            description:
              'Root workflow node. Supported types: task, sequence, parallel, branch, loop. ' +
              'task: { type, name, prompt }. ' +
              'sequence: { type, children: WorkflowNode[] }. ' +
              'parallel: { type, children: WorkflowNode[] }. ' +
              'branch: { type, condition, cases: [{when, node}], default? }. ' +
              'loop: { type, condition, body, maxIterations? }.',
          },
        },
        required: ['name', 'description', 'root'],
      },
    },
    required: ['path', 'reason'],
  },
};

const SYSTEM_PROMPT = `You are an intelligent execution planner for an agentic system.

Given a user goal, decide the best execution path:

**harness** — Good for: simple one-shot tasks, quick lookups, small code edits, tasks completable in a single agent loop.

**workflow** — Good for: multi-phase tasks with distinct steps, work that benefits from parallelism, long-running operations where crash-resumability matters, tasks with conditional branching based on intermediate results.

When choosing "workflow", design a workflow tree that:
- Uses \`sequence\` for steps that must happen in order
- Uses \`parallel\` for independent work that can run concurrently
- Uses \`branch\` when the next step depends on prior results
- Uses \`loop\` for iterative refinement
- Gives each \`task\` a clear, actionable prompt that includes what context it needs

Always call the \`create_execution_plan\` tool — never respond with plain text.`;

export async function planExecution(goal: Goal): Promise<Plan> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    tools: [PLANNING_TOOL],
    tool_choice: { type: 'any' },
    messages: [
      {
        role: 'user',
        content:
          `Goal: ${goal.description}` +
          (goal.context ? `\n\nContext: ${goal.context}` : ''),
      },
    ],
  });

  const toolUse = response.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use',
  );
  if (!toolUse) {
    throw new Error('Planner did not call create_execution_plan');
  }

  const input = toolUse.input as {
    path: 'harness' | 'workflow';
    reason: string;
    workflow?: Workflow;
  };

  if (input.path === 'workflow') {
    if (!input.workflow) {
      throw new Error('Planner chose workflow path but did not provide workflow definition');
    }
    return { path: 'workflow', reason: input.reason, workflow: input.workflow };
  }

  return { path: 'harness', reason: input.reason };
}
