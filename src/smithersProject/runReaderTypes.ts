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

export type SmithersJsonValue =
  | null
  | boolean
  | number
  | string
  | SmithersJsonValue[]
  | { [key: string]: SmithersJsonValue };

export type SmithersParseWarning = {
  field: string;
  message: string;
  runId?: string;
  nodeId?: string;
  iteration?: number;
  attempt?: number;
  seq?: number;
  frameNo?: number;
};

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
  error: SmithersJsonValue | null;
  configJson: string | null;
  config: SmithersJsonValue | null;
};

export type SmithersRunNode = {
  runId: string;
  nodeId: string;
  iteration: number;
  state: string;
  status: string;
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
  status: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  heartbeatAtMs: number | null;
  heartbeatDataJson: string | null;
  heartbeatData: SmithersJsonValue | null;
  errorJson: string | null;
  error: SmithersJsonValue | null;
  jjPointer: string | null;
  responseText: string | null;
  jjCwd: string | null;
  cached: boolean;
  metaJson: string | null;
  meta: SmithersJsonValue | null;
};

export type SmithersRunFrame = {
  runId: string;
  frameNo: number;
  createdAtMs: number;
  xmlHash: string;
  encoding: string;
  mountedTaskIdsJson: string | null;
  mountedTaskIds: string[];
  taskIndexJson: string | null;
  taskIndex: SmithersJsonValue | null;
  note: string | null;
};

export type SmithersRunEvent = {
  runId: string;
  seq: number;
  timestampMs: number;
  type: string;
  payloadJson: string;
  payload: SmithersJsonValue | null;
  nodeId: string | null;
  iteration: number | null;
  attempt: number | null;
};

export type SmithersRunOutput = {
  runId: string;
  nodeId: string;
  iteration: number;
  outputTable: string;
  row: Record<string, unknown>;
};

export type SmithersRunCursors = {
  nextEventSeq: number | null;
};

export type SmithersRunEventsResult = {
  events: SmithersRunEvent[];
  cursors: SmithersRunCursors;
};

export type SmithersRunDetail = {
  run: SmithersRunSummary;
  nodes: SmithersRunNode[];
  attempts: SmithersRunAttempt[];
  events: SmithersRunEvent[];
  frames: SmithersRunFrame[];
  outputs: SmithersRunOutput[];
  cursors: SmithersRunCursors;
  parseWarnings: SmithersParseWarning[];
};

export type ListRunsOptions = {
  limit?: number;
  status?: string;
  workflowId?: string;
};

export type GetRunDetailOptions = {
  eventLimit?: number;
  frameLimit?: number;
  includeOutputs?: boolean;
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
  listEvents(runId: string, options?: ListEventsOptions): Promise<SmithersRunEventsResult>;
  close(): void;
};
