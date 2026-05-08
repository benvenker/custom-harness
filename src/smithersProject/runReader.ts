import type { AttemptRow, NodeRow, RunRow } from '@smithers-orchestrator/db/adapter';
import { basename, normalize, sep } from 'node:path';
import { openSmithersDbReadOnly, type SmithersDbReadOnlyHandle, type SqliteReadOnlyOpenOptions } from './sqliteReadOnly.js';
import type {
  GetRunDetailOptions,
  ListEventsOptions,
  ListRunsOptions,
  SmithersJsonValue,
  SmithersParseWarning,
  SmithersRunAttempt,
  SmithersRunDetail,
  SmithersRunEvent,
  SmithersRunEventsResult,
  SmithersRunFrame,
  SmithersRunNode,
  SmithersRunOutput,
  SmithersRunReader,
  SmithersRunSummary,
} from './runReaderTypes.js';

type CreateSmithersRunReaderOptions = SqliteReadOnlyOpenOptions;

type FrameRow = {
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

type EventHistoryRow = {
  runId?: string;
  seq?: number;
  timestampMs?: number;
  type?: string;
  payloadJson?: string | null;
};

type ParseContext = Omit<SmithersParseWarning, 'field' | 'message'>;

export function createSmithersRunReader(options: CreateSmithersRunReaderOptions): SmithersRunReader {
  return smithersRunReaderFromHandle(openSmithersDbReadOnly(options));
}

export function smithersRunReaderFromHandle(handle: SmithersDbReadOnlyHandle): SmithersRunReader {
  let closed = false;

  function assertOpen() {
    if (closed) throw new Error(`SmithersRunReader is closed: ${handle.dbPath}`);
  }

  return {
    async listRuns(options: ListRunsOptions = {}) {
      assertOpen();
      if (options.workflowId) {
        return listWorkflowRuns(handle, options).map((row: RunRow) => toRunSummary(row, []));
      }
      const rows = (await handle.adapter.listRuns(options.limit ?? 50, options.status)) as RunRow[];
      return rows.map((row: RunRow) => toRunSummary(row, []));
    },

    async getRunDetail(runId: string, options: GetRunDetailOptions = {}) {
      assertOpen();
      const run = await handle.adapter.getRun(runId);
      if (!run) return null;

      const eventLimit = clampPositiveInteger(options.eventLimit ?? 200, 1, 1000);
      const frameLimit = clampPositiveInteger(options.frameLimit ?? 1, 1, 100);
      const parseWarnings: SmithersParseWarning[] = [];

      const [nodes, attempts, events, frames, lastEventSeq] = await Promise.all([
        handle.adapter.listNodes(runId),
        handle.adapter.listAttemptsForRun(runId),
        handle.adapter.listEventHistory(runId, { afterSeq: options.eventsAfterSeq ?? -1, limit: eventLimit }),
        listFrameMetadata(handle, runId, frameLimit),
        handle.adapter.getLastEventSeq(runId),
      ]) as [NodeRow[], AttemptRow[], Array<Record<string, unknown>>, FrameRow[], number | undefined];

      const mappedNodes = nodes.map(toRunNode).sort(compareNodeRows);
      const mappedAttempts = attempts.map((attempt: AttemptRow) => toRunAttempt(attempt, parseWarnings)).sort(compareAttemptRows);
      const mappedEvents = events.map((event) => toRunEvent(runId, event, parseWarnings));
      const mappedFrames = frames.map((frame: FrameRow) => toRunFrame(frame, parseWarnings));
      const outputs = options.includeOutputs ? await listOutputs(handle, mappedNodes) : [];

      return {
        run: toRunSummary(run, parseWarnings),
        nodes: mappedNodes,
        attempts: mappedAttempts,
        events: mappedEvents,
        frames: mappedFrames,
        outputs,
        cursors: eventCursor(mappedEvents, lastEventSeq),
        parseWarnings,
      } satisfies SmithersRunDetail;
    },

    async listEvents(runId: string, options: ListEventsOptions = {}) {
      assertOpen();
      const parseWarnings: SmithersParseWarning[] = [];
      const [rows, lastEventSeq] = await Promise.all([
        handle.adapter.listEventHistory(runId, {
          afterSeq: options.afterSeq ?? -1,
          limit: clampPositiveInteger(options.limit ?? 200, 1, 1000),
          nodeId: options.nodeId,
          types: options.types,
          sinceTimestampMs: options.sinceTimestampMs,
        }),
        handle.adapter.getLastEventSeq(runId),
      ]);
      const events = (rows as Array<Record<string, unknown>>).map((event) => toRunEvent(runId, event, parseWarnings));
      return {
        events,
        cursors: eventCursor(events, lastEventSeq, options.afterSeq),
        ...(parseWarnings.length > 0 ? { parseWarnings } : {}),
      } satisfies SmithersRunEventsResult;
    },

    close() {
      if (closed) return;
      closed = true;
      handle.close();
    },
  };
}

function toRunSummary(row: RunRow, parseWarnings: SmithersParseWarning[]): SmithersRunSummary {
  return {
    runId: row.runId,
    parentRunId: row.parentRunId,
    workflowName: row.workflowName,
    workflowPath: row.workflowPath,
    workflowHash: row.workflowHash,
    status: row.status,
    createdAtMs: row.createdAtMs,
    startedAtMs: row.startedAtMs,
    finishedAtMs: row.finishedAtMs,
    heartbeatAtMs: row.heartbeatAtMs,
    runtimeOwnerId: row.runtimeOwnerId,
    errorJson: row.errorJson,
    error: parseJsonField(row.errorJson, 'run.errorJson', parseWarnings, { runId: row.runId }),
    configJson: row.configJson,
    config: parseJsonField(row.configJson, 'run.configJson', parseWarnings, { runId: row.runId }),
  };
}

function toRunNode(row: NodeRow): SmithersRunNode {
  return {
    runId: row.runId,
    nodeId: row.nodeId,
    iteration: row.iteration,
    state: row.state,
    status: row.state,
    lastAttempt: row.lastAttempt,
    updatedAtMs: row.updatedAtMs,
    outputTable: row.outputTable,
    label: row.label,
  };
}

function toRunAttempt(row: AttemptRow, parseWarnings: SmithersParseWarning[]): SmithersRunAttempt {
  const context = { runId: row.runId, nodeId: row.nodeId, iteration: row.iteration, attempt: row.attempt };
  return {
    runId: row.runId,
    nodeId: row.nodeId,
    iteration: row.iteration,
    attempt: row.attempt,
    state: row.state,
    status: row.state,
    startedAtMs: row.startedAtMs,
    finishedAtMs: row.finishedAtMs,
    heartbeatAtMs: row.heartbeatAtMs,
    heartbeatDataJson: row.heartbeatDataJson,
    heartbeatData: parseJsonField(row.heartbeatDataJson, 'attempt.heartbeatDataJson', parseWarnings, context),
    errorJson: row.errorJson,
    error: parseJsonField(row.errorJson, 'attempt.errorJson', parseWarnings, context),
    jjPointer: row.jjPointer,
    responseText: row.responseText,
    jjCwd: row.jjCwd,
    cached: row.cached,
    metaJson: row.metaJson,
    meta: parseJsonField(row.metaJson, 'attempt.metaJson', parseWarnings, context),
  };
}

function toRunFrame(row: FrameRow, parseWarnings: SmithersParseWarning[]): SmithersRunFrame {
  const context = { runId: row.runId, frameNo: row.frameNo };
  const mountedTaskIds = parseJsonField(row.mountedTaskIdsJson, 'frame.mountedTaskIdsJson', parseWarnings, context);
  return {
    runId: row.runId,
    frameNo: row.frameNo,
    createdAtMs: row.createdAtMs,
    xmlHash: row.xmlHash,
    encoding: row.encoding,
    mountedTaskIdsJson: row.mountedTaskIdsJson,
    mountedTaskIds: Array.isArray(mountedTaskIds) ? mountedTaskIds.filter((value): value is string => typeof value === 'string') : [],
    taskIndexJson: row.taskIndexJson,
    taskIndex: parseJsonField(row.taskIndexJson, 'frame.taskIndexJson', parseWarnings, context),
    note: row.note,
  };
}

function toRunEvent(runId: string, row: Record<string, unknown>, parseWarnings: SmithersParseWarning[]): SmithersRunEvent {
  const event = row as EventHistoryRow;
  const seq = Number(event.seq ?? 0);
  const payloadJson = typeof event.payloadJson === 'string' ? event.payloadJson : 'null';
  const payload = parseJsonField(payloadJson, 'event.payloadJson', parseWarnings, { runId, seq });
  const payloadObject = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  return {
    runId: typeof event.runId === 'string' ? event.runId : runId,
    seq,
    timestampMs: Number(event.timestampMs ?? 0),
    type: String(event.type ?? ''),
    payloadJson,
    payload,
    nodeId: stringValue(payloadObject?.nodeId),
    iteration: numberValue(payloadObject?.iteration),
    attempt: numberValue(payloadObject?.attempt),
  };
}

function parseJsonField(
  value: string | null | undefined,
  field: string,
  parseWarnings: SmithersParseWarning[],
  context: ParseContext,
): SmithersJsonValue | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    return JSON.parse(value) as SmithersJsonValue;
  } catch (error) {
    parseWarnings.push({
      ...context,
      field,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function listFrameMetadata(handle: SmithersDbReadOnlyHandle, runId: string, frameLimit: number): Promise<FrameRow[]> {
  const lastFrame = await handle.adapter.getLastFrame(runId);
  if (!lastFrame) return [];
  if (frameLimit === 1) return [lastFrame as FrameRow];
  const chain = await handle.adapter.listFrameChainDesc(runId, Number(lastFrame.frameNo), frameLimit);
  return (chain as FrameRow[]).sort((a, b) => a.frameNo - b.frameNo);
}

async function listOutputs(handle: SmithersDbReadOnlyHandle, nodes: SmithersRunNode[]): Promise<SmithersRunOutput[]> {
  const outputs: SmithersRunOutput[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!node.outputTable || seen.has(`${node.outputTable}\0${node.runId}\0${node.nodeId}\0${node.iteration}`)) continue;
    seen.add(`${node.outputTable}\0${node.runId}\0${node.nodeId}\0${node.iteration}`);
    const row = await handle.adapter.getRawNodeOutputForIteration(
      node.outputTable,
      node.runId,
      node.nodeId,
      node.iteration,
    );
    if (!row) continue;
    outputs.push({
      runId: node.runId,
      nodeId: node.nodeId,
      iteration: node.iteration,
      outputTable: node.outputTable,
      row,
    });
  }
  return outputs;
}

function listWorkflowRuns(handle: SmithersDbReadOnlyHandle, options: ListRunsOptions): RunRow[] {
  const workflowId = options.workflowId;
  if (!workflowId) return [];

  const limit = clampPositiveInteger(options.limit ?? 50, 1, 1000);
  const whereParts = [
    `(workflow_name = ? OR workflow_path LIKE ? ESCAPE '\\' OR workflow_path LIKE ? ESCAPE '\\')`,
  ];
  const params: Array<string | number> = [
    workflowId,
    `%/.smithers/workflows/${escapeSqlLike(workflowId)}.tsx`,
    `%\\.smithers\\workflows\\${escapeSqlLike(workflowId)}.tsx`,
  ];

  if (options.status) {
    if (options.status === 'running') {
      whereParts.push(`status IN ('running', 'continued')`);
    } else {
      whereParts.push(`status = ?`);
      params.push(options.status);
    }
  }
  params.push(limit);

  type RunSqlRow = Omit<RunRow, 'status'> & { status: string };
  return handle.queryAll<RunSqlRow>(`
    SELECT
      run_id AS runId,
      parent_run_id AS parentRunId,
      workflow_name AS workflowName,
      workflow_path AS workflowPath,
      workflow_hash AS workflowHash,
      status,
      created_at_ms AS createdAtMs,
      started_at_ms AS startedAtMs,
      finished_at_ms AS finishedAtMs,
      heartbeat_at_ms AS heartbeatAtMs,
      runtime_owner_id AS runtimeOwnerId,
      error_json AS errorJson,
      config_json AS configJson
    FROM _smithers_runs
    WHERE ${whereParts.join(' AND ')}
    ORDER BY created_at_ms DESC, run_id ASC
    LIMIT ?
  `, params) as RunRow[];
}

function matchesWorkflowId(row: RunRow, workflowId?: string) {
  if (!workflowId) return true;
  if (row.workflowName === workflowId) return true;
  const workflowPath = row.workflowPath;
  if (!workflowPath) return false;
  const normalized = normalize(workflowPath);
  if (basename(normalized, '.tsx') === workflowId) return true;
  return normalized.endsWith(`${sep}.smithers${sep}workflows${sep}${workflowId}.tsx`);
}

function escapeSqlLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function eventCursor(events: SmithersRunEvent[], lastEventSeq?: number | null, requestedAfterSeq?: number) {
  if (typeof lastEventSeq === 'number' && Number.isFinite(lastEventSeq)) {
    return { nextEventSeq: typeof requestedAfterSeq === 'number' ? Math.max(lastEventSeq, requestedAfterSeq) : lastEventSeq };
  }
  if (events.length === 0) {
    return { nextEventSeq: typeof requestedAfterSeq === 'number' ? requestedAfterSeq : null };
  }
  const maxEventSeq = Math.max(...events.map((event) => event.seq));
  return { nextEventSeq: typeof requestedAfterSeq === 'number' ? Math.max(maxEventSeq, requestedAfterSeq) : maxEventSeq };
}

function compareNodeRows(a: SmithersRunNode, b: SmithersRunNode) {
  return a.nodeId.localeCompare(b.nodeId) || a.iteration - b.iteration;
}

function compareAttemptRows(a: SmithersRunAttempt, b: SmithersRunAttempt) {
  return (
    a.startedAtMs - b.startedAtMs ||
    a.nodeId.localeCompare(b.nodeId) ||
    a.iteration - b.iteration ||
    a.attempt - b.attempt
  );
}

function clampPositiveInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export type { CreateSmithersRunReaderOptions };
export type {
  GetRunDetailOptions,
  ListEventsOptions,
  ListRunsOptions,
  SmithersRunAttempt,
  SmithersRunDetail,
  SmithersRunEvent,
  SmithersRunEventsResult,
  SmithersRunFrame,
  SmithersRunNode,
  SmithersRunOutput,
  SmithersRunReader,
  SmithersRunSummary,
} from './runReaderTypes.js';
