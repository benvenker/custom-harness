import type { AttemptRow, NodeRow, RunRow } from '@smithers-orchestrator/db/adapter';
import { openSmithersDbReadOnly, type SmithersDbReadOnlyHandle } from './sqliteReadOnly.js';
import type {
  GetRunDetailOptions,
  ListEventsOptions,
  ListRunsOptions,
  SmithersRunAttempt,
  SmithersRunDetail,
  SmithersRunEvent,
  SmithersRunFrame,
  SmithersRunNode,
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
  payloadJson?: string;
};

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
      const rows = await handle.adapter.listRuns(options.limit ?? 50, options.status);
      return rows.map(toRunSummary);
    },

    async getRunDetail(runId: string, options: GetRunDetailOptions = {}) {
      assertOpen();
      const run = await handle.adapter.getRun(runId);
      if (!run) return null;

      const [nodes, attempts, events, lastFrame] = await Promise.all([
        handle.adapter.listNodes(runId),
        handle.adapter.listAttemptsForRun(runId),
        handle.adapter.listEventHistory(runId, { afterSeq: -1, limit: options.eventLimit ?? 200 }),
        handle.adapter.getLastFrame(runId),
      ]);

      return {
        ...toRunSummary(run),
        nodes: nodes.map(toRunNode),
        attempts: attempts.map(toRunAttempt),
        events: (events as Array<Record<string, unknown>>).map((event: Record<string, unknown>) => toRunEvent(runId, event)),
        lastFrame: lastFrame ? toRunFrame(lastFrame as FrameRow) : null,
      };
    },

    async listEvents(runId: string, options: ListEventsOptions = {}) {
      assertOpen();
      const rows = await handle.adapter.listEventHistory(runId, {
        afterSeq: options.afterSeq ?? -1,
        limit: options.limit ?? 200,
        nodeId: options.nodeId,
        types: options.types,
        sinceTimestampMs: options.sinceTimestampMs,
      });
      return (rows as Array<Record<string, unknown>>).map((event: Record<string, unknown>) => toRunEvent(runId, event));
    },

    close() {
      if (closed) return;
      closed = true;
      handle.close();
    },
  };
}

function toRunSummary(row: RunRow): SmithersRunSummary {
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
    configJson: row.configJson,
  };
}

function toRunNode(row: NodeRow): SmithersRunNode {
  return {
    runId: row.runId,
    nodeId: row.nodeId,
    iteration: row.iteration,
    state: row.state,
    lastAttempt: row.lastAttempt,
    updatedAtMs: row.updatedAtMs,
    outputTable: row.outputTable,
    label: row.label,
  };
}

function toRunAttempt(row: AttemptRow): SmithersRunAttempt {
  return {
    runId: row.runId,
    nodeId: row.nodeId,
    iteration: row.iteration,
    attempt: row.attempt,
    state: row.state,
    startedAtMs: row.startedAtMs,
    finishedAtMs: row.finishedAtMs,
    heartbeatAtMs: row.heartbeatAtMs,
    heartbeatDataJson: row.heartbeatDataJson,
    errorJson: row.errorJson,
    jjPointer: row.jjPointer,
    responseText: row.responseText,
    jjCwd: row.jjCwd,
    cached: row.cached,
    metaJson: row.metaJson,
  };
}

function toRunFrame(row: FrameRow): SmithersRunFrame {
  return {
    runId: row.runId,
    frameNo: row.frameNo,
    createdAtMs: row.createdAtMs,
    xmlJson: row.xmlJson,
    xmlHash: row.xmlHash,
    encoding: row.encoding,
    mountedTaskIdsJson: row.mountedTaskIdsJson,
    taskIndexJson: row.taskIndexJson,
    note: row.note,
  };
}

function toRunEvent(runId: string, row: Record<string, unknown>): SmithersRunEvent {
  const event = row as EventHistoryRow;
  return {
    runId: typeof event.runId === 'string' ? event.runId : runId,
    seq: Number(event.seq ?? 0),
    timestampMs: Number(event.timestampMs ?? 0),
    type: String(event.type ?? ''),
    payloadJson: String(event.payloadJson ?? 'null'),
  };
}

export type { CreateSmithersRunReaderOptions };
export type {
  GetRunDetailOptions,
  ListEventsOptions,
  ListRunsOptions,
  SmithersRunAttempt,
  SmithersRunDetail,
  SmithersRunEvent,
  SmithersRunFrame,
  SmithersRunNode,
  SmithersRunReader,
  SmithersRunSummary,
} from './runReaderTypes.js';
