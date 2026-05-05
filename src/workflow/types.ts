export type WorkflowNode =
  | TaskNode
  | SequenceNode
  | ParallelNode
  | BranchNode
  | LoopNode;

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

export interface Workflow {
  name: string;
  description: string;
  root: WorkflowNode;
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface TaskResult {
  taskName: string;
  status: TaskStatus;
  output?: unknown;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}
