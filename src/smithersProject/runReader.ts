import type { AttemptRow, NodeRow, RunRow } from '@smithers-orchestrator/db/adapter';
import { basename, normalize, sep } from 'node:path';
import { openSmithersDbReadOnly, type SmithersDbReadOnlyHandle } from './sqliteReadOnly.js';
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

type CreateSmithersRunReaderOptions = {
  projectRoot: string;
};

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
      const rows = (await handle.adapter.listRuns(options.limit ?? 50, options.status)) as RunRow[];
      return rows.filter((row: RunRow) => matchesWorkflowId(row, options.workflowId)).map((row: RunRow) => toRunSummary(row, []));
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
        handle.adapter.listEventHistory(runId, { afterSeq: -1, limit: eventLimit }),
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
      const rows = await handle.adapter.listEventHistory(runId, {
        afterSeq: options.afterSeq ?? -1,
        limit: clampPositiveInteger(options.limit ?? 200, 1, 1000),
        nodeId: options.nodeId,
        types: options.types,
        sinceTimestampMs: options.sinceTimestampMs,
      });
      const events = (rows as Array<Record<string, unknown>>).map((event) => toRunEvent(runId, event, parseWarnings));
      return {
        events,
        cursors: eventCursor(events),
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

function matchesWorkflowId(row: RunRow, workflowId?: string) {
  if (!workflowId) return true;
  if (row.workflowName === workflowId) return true;
  const workflowPath = row.workflowPath;
  if (!workflowPath) return false;
  const normalized = normalize(workflowPath);
  if (basename(normalized, '.tsx') === workflowId) return true;
  return normalized.endsWith(`${sep}.smithers${sep}workflows${sep}${workflowId}.tsx`);
}

function eventCursor(events: SmithersRunEvent[], lastEventSeq?: number | null) {
  if (typeof lastEventSeq === 'number' && Number.isFinite(lastEventSeq)) {
    return { nextEventSeq: lastEventSeq };
  }
  if (events.length === 0) return { nextEventSeq: null };
  return { nextEventSeq: Math.max(...events.map((event) => event.seq)) };
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
