export type SmithersRunStatus =
  | 'running'
  | 'waiting-approval'
  | 'waiting-event'
  | 'waiting-timer'
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'continued'
  | string;

export type SmithersRunSummary = {
  runId: string;
  parentRunId: string | null;
  workflowName: string;
  workflowPath: string | null;
  workflowHash: string | null;
  status: SmithersRunStatus;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  heartbeatAtMs: number | null;
  runtimeOwnerId: string | null;
  errorJson: string | null;
  configJson: string | null;
};

export type SmithersRunNode = {
  runId: string;
  nodeId: string;
  iteration: number;
  state: string;
  lastAttempt: number | null;
  updatedAtMs: number;
  outputTable: string;
  label: string | null;
};

export type SmithersRunAttempt = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  state: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  heartbeatAtMs: number | null;
  heartbeatDataJson: string | null;
  errorJson: string | null;
  jjPointer: string | null;
  responseText: string | null;
  jjCwd: string | null;
  cached: boolean;
  metaJson: string | null;
};

export type SmithersRunFrame = {
  runId: string;
  frameNo: number;
  createdAtMs: number;
  xmlJson: string;
  xmlHash: string;
  encoding: string;
  mountedTaskIdsJson: string | null;
  taskIndexJson: string | null;
  note: string | null;
};

export type SmithersRunEvent = {
  runId: string;
  seq: number;
  timestampMs: number;
  type: string;
  payloadJson: string;
};

export type SmithersRunDetail = SmithersRunSummary & {
  nodes: SmithersRunNode[];
  attempts: SmithersRunAttempt[];
  events: SmithersRunEvent[];
  lastFrame: SmithersRunFrame | null;
};

export type ListRunsOptions = {
  limit?: number;
  status?: string;
};

export type GetRunDetailOptions = {
  eventLimit?: number;
};

export type ListEventsOptions = {
  afterSeq?: number;
  limit?: number;
  nodeId?: string;
  types?: readonly string[];
  sinceTimestampMs?: number;
};

export type SmithersRunReader = {
  listRuns(options?: ListRunsOptions): Promise<SmithersRunSummary[]>;
  getRunDetail(runId: string, options?: GetRunDetailOptions): Promise<SmithersRunDetail | null>;
  listEvents(runId: string, options?: ListEventsOptions): Promise<SmithersRunEvent[]>;
  close(): void;
};
