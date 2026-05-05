import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6';

// --- Workflow node types (used by runner.ts and orchestrator.ts) ---

export interface TaskNode {
  type: 'task';
  name: string;
  prompt: string;
}

export interface SequenceNode {
  type: 'sequence';
  name?: string;
  children: WorkflowNode[];
}

export interface ParallelNode {
  type: 'parallel';
  name?: string;
  children: WorkflowNode[];
}

export interface BranchNode {
  type: 'branch';
  name?: string;
  condition: string;
  cases: Array<{ when: string; node: WorkflowNode }>;
  default?: WorkflowNode;
}

export interface LoopNode {
  type: 'loop';
  name?: string;
  condition: string;
  body: WorkflowNode;
  maxIterations?: number;
}

export type WorkflowNode =
  | TaskNode
  | SequenceNode
  | ParallelNode
  | BranchNode
  | LoopNode;

export interface Workflow {
  name: string;
  description: string;
  root: WorkflowNode;
}

export interface Goal {
  description: string;
  context?: string;
}

export type Plan =
  | { path: 'harness'; reason: string }
  | { path: 'workflow'; reason: string; workflow: Workflow };

// --- Planner ---

const PLANNING_TOOL: Anthropic.Tool = {
  name: 'create_execution_plan',
  description:
    'Decide how to execute the given goal: via a direct Flue agent loop (harness) or a durable Smithers workflow DAG.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        enum: ['harness', 'workflow'],
        description:
          'harness = Flue session.task(), one agent loop. workflow = Smithers durable DAG, multi-step crash-resumable.',
      },
      reason: {
        type: 'string',
        description: 'One sentence explaining the choice.',
      },
      workflow: {
        type: 'object',
        description: 'Required when path is "workflow".',
        properties: {
          name: { type: 'string', description: 'Short kebab-case identifier.' },
          description: { type: 'string', description: 'One sentence summary.' },
          root: {
            type: 'object',
            description:
              'Root WorkflowNode. Types: ' +
              'task {type,name,prompt}, ' +
              'sequence {type,children[]}, ' +
              'parallel {type,children[]}, ' +
              'branch {type,condition,cases:[{when,node}],default?}, ' +
              'loop {type,condition,body,maxIterations?}',
          },
        },
        required: ['name', 'description', 'root'],
      },
    },
    required: ['path', 'reason'],
  },
};

const SYSTEM_PROMPT = `You are an execution planner for a meta-harness that combines Flue (agent harness) and Smithers (durable workflow engine).

Choose "harness" for: simple one-shot tasks, quick lookups, small code edits — anything a single focused agent can do without needing persistence.

Choose "workflow" for: multi-phase tasks, work that benefits from parallelism, long-running tasks where crash-resumability matters, or tasks with conditional branching on intermediate results.

When choosing "workflow", design a Smithers-native workflow tree:
- sequence: steps that must run in order
- parallel: independent steps that can run concurrently
- task: a single focused LLM step with a clear actionable prompt
- Keep task prompts self-contained — each task runs independently

Always call create_execution_plan.`;

export async function planExecution(goal: Goal): Promise<Plan> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
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
  if (!toolUse) throw new Error('Planner did not call create_execution_plan');

  const input = toolUse.input as {
    path: 'harness' | 'workflow';
    reason: string;
    workflow?: Workflow;
  };

  if (input.path === 'workflow') {
    if (!input.workflow)
      throw new Error('Planner chose workflow but gave no workflow definition');
    return { path: 'workflow', reason: input.reason, workflow: input.workflow };
  }

  return { path: 'harness', reason: input.reason };
}
