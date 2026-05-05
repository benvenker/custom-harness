export interface Goal {
  description: string;
  context?: string;
}

export interface AgentResult {
  success: boolean;
  output: string;
  error?: string;
}

export type ExecutionPath = 'harness' | 'workflow';
