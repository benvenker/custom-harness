import type {
  SmithersRunAttempt,
  SmithersRunDetail,
  SmithersRunEvent,
  SmithersRunFrame,
  SmithersRunNode,
  SmithersRunOutput,
} from '../smithersProject/runReaderTypes.js';

export type OverlayRenderNode = {
  id: string;
  type: string;
  title?: string;
  status?: string;
  prompt?: string;
  smithers?: {
    nodeId?: string;
    meta?: unknown;
    [key: string]: unknown;
  };
  timeline?: unknown[];
  [key: string]: unknown;
};

export type OverlayRenderGraph = {
  nodes: OverlayRenderNode[];
  edges?: Array<{ from: string; to: string; label?: string }>;
  [key: string]: unknown;
};

export type SmithersNodeOverlay = {
  graphNodeId: string;
  nodeId: string;
  selectedIteration: number;
  rawStatus: string;
  rawState: string;
  visualStatus: string;
  source: 'smithers-db';
};

type SmithersNodeOverlayWithRow = SmithersNodeOverlay & {
  node: SmithersRunNode;
};

export type SmithersRunOverlayState = {
  graph: OverlayRenderGraph;
  provenanceLabel: string;
  nodeOverlays: SmithersNodeOverlay[];
  visibleCopy: string[];
};

export type SmithersRunInspectorState = {
  provenanceLabel: string;
  run: { runId: string; rawStatus: string };
  selectedNode: {
    graphNodeId: string;
    nodeId: string;
    selectedIteration: number;
    rawStatus: string;
    rawState: string;
  } | null;
  attempts: Array<{
    nodeId: string;
    iteration: number;
    attempt: number;
    rawStatus: string;
    rawState: string;
    errorText: string | null;
    responseText: string | null;
  }>;
  outputs: {
    empty: boolean;
    emptyMessage: string | null;
    rows: Array<{ nodeId: string; iteration: number; outputTable: string; row: Record<string, unknown> }>;
  };
  timeline: Array<{ seq: number; type: string; nodeId: string | null; source: 'smithers-db'; timestampMs: number }>;
  frames: Array<{ frameNo: number; mountedTaskIds: string[]; kind: 'summary'; createdAtMs: number; note: string | null }>;
  pretendOutputControls: { enabled: boolean; mode: 'preview-only' | 'live'; help: string };
  visibleCopy: string[];
};

const PROVENANCE_LABEL = 'Smithers SQLite · live run';

export function buildSmithersRunOverlayState(options: {
  graph: OverlayRenderGraph;
  detail: SmithersRunDetail;
}): SmithersRunOverlayState {
  const nodeOverlays = buildNodeOverlays(options.graph, options.detail);
  const byGraphId = new Map(nodeOverlays.map((overlay) => [overlay.graphNodeId, overlay]));
  const graph: OverlayRenderGraph = {
    ...options.graph,
    runId: options.detail.run.runId,
    runStatus: options.detail.run.status,
    nodes: options.graph.nodes.map((node) => {
      const overlay = byGraphId.get(node.id);
      if (!overlay) return { ...node };
      return {
        ...node,
        status: overlay.visualStatus,
        smithers: {
          ...node.smithers,
          nodeId: overlay.nodeId,
          rawStatus: overlay.rawStatus,
          rawState: overlay.rawState,
          iteration: overlay.selectedIteration,
          statusSource: 'smithers-db',
        },
      };
    }),
  };

  return {
    graph,
    provenanceLabel: PROVENANCE_LABEL,
    nodeOverlays: nodeOverlays.map(({ node: _node, ...overlay }) => overlay),
    visibleCopy: [
      PROVENANCE_LABEL,
      `raw run status: ${options.detail.run.status}`,
      ...nodeOverlays.flatMap((overlay) => [
        `${overlay.nodeId} iteration ${overlay.selectedIteration}`,
        `raw status: ${overlay.rawStatus}`,
        `raw state: ${overlay.rawState}`,
      ]),
    ],
  };
}

export function buildSmithersRunInspectorState(options: {
  graph: OverlayRenderGraph;
  detail: SmithersRunDetail;
  selectedGraphNodeId: string;
  liveMode: true;
}): SmithersRunInspectorState {
  const selectedOverlay = buildNodeOverlays(options.graph, options.detail)
    .find((overlay) => overlay.graphNodeId === options.selectedGraphNodeId) ?? null;
  const selectedNodeId = selectedOverlay?.nodeId ?? graphNodeById(options.graph, options.selectedGraphNodeId)?.smithers?.nodeId ?? options.selectedGraphNodeId;
  const selectedIteration = selectedOverlay?.selectedIteration ?? null;
  const nodeAttempts = filterBySelectedNodeIteration(options.detail.attempts, selectedNodeId, selectedIteration)
    .map(toInspectorAttempt);
  const outputRows = filterBySelectedNodeIteration(options.detail.outputs, selectedNodeId, selectedIteration)
    .map((output) => ({
      nodeId: output.nodeId,
      iteration: output.iteration,
      outputTable: output.outputTable,
      row: output.row,
    }));
  const timeline = filterEventsForNode(options.detail.events, selectedNodeId)
    .map((event) => ({
      seq: event.seq,
      type: event.type,
      nodeId: event.nodeId,
      source: 'smithers-db' as const,
      timestampMs: event.timestampMs,
    }));
  const frames = options.detail.frames.map(toFrameSummary);
  const emptyMessage = 'No Smithers output rows recorded for this node yet.';
  const pretendOutputHelp = 'Preview graph output is not live Smithers run state.';

  const visibleCopy = [
    PROVENANCE_LABEL,
    `raw run status: ${options.detail.run.status}`,
    ...(selectedOverlay ? [
      `raw node status: ${selectedOverlay.rawStatus}`,
      `raw node state: ${selectedOverlay.rawState}`,
      `iteration ${selectedOverlay.selectedIteration}`,
    ] : ['No DB node state recorded for this graph node yet.']),
    'Attempts',
    ...nodeAttempts.flatMap((attempt) => [
      `attempt ${attempt.attempt}`,
      attempt.rawStatus,
      attempt.errorText ?? '',
    ]),
    'Run output',
    ...(outputRows.length === 0 ? [emptyMessage] : outputRows.flatMap((output) => [
      output.nodeId,
      JSON.stringify(output.row),
    ])),
    'Activity timeline',
    ...timeline.map((event) => event.type),
    'Frame summary',
    ...frames.map((frame) => `frame ${frame.frameNo} · ${frame.mountedTaskIds.join(', ')}`),
    pretendOutputHelp,
  ].filter((value) => value.length > 0);

  return {
    provenanceLabel: PROVENANCE_LABEL,
    run: { runId: options.detail.run.runId, rawStatus: options.detail.run.status },
    selectedNode: selectedOverlay ? {
      graphNodeId: selectedOverlay.graphNodeId,
      nodeId: selectedOverlay.nodeId,
      selectedIteration: selectedOverlay.selectedIteration,
      rawStatus: selectedOverlay.rawStatus,
      rawState: selectedOverlay.rawState,
    } : null,
    attempts: nodeAttempts,
    outputs: {
      empty: outputRows.length === 0,
      emptyMessage: outputRows.length === 0 ? emptyMessage : null,
      rows: outputRows,
    },
    timeline,
    frames,
    pretendOutputControls: {
      enabled: false,
      mode: 'preview-only',
      help: pretendOutputHelp,
    },
    visibleCopy,
  };
}

function buildNodeOverlays(graph: OverlayRenderGraph, detail: SmithersRunDetail): SmithersNodeOverlayWithRow[] {
  const latestByNodeId = latestNodesByNodeId(detail.nodes);
  const overlays: SmithersNodeOverlayWithRow[] = [];
  for (const graphNode of graph.nodes) {
    const smithersNodeId = typeof graphNode.smithers?.nodeId === 'string' && graphNode.smithers.nodeId.length > 0
      ? graphNode.smithers.nodeId
      : graphNode.id;
    const dbNode = latestByNodeId.get(smithersNodeId) ?? latestByNodeId.get(graphNode.id);
    if (!dbNode) continue;
    overlays.push({
      graphNodeId: graphNode.id,
      nodeId: dbNode.nodeId,
      selectedIteration: dbNode.iteration,
      rawStatus: dbNode.status,
      rawState: dbNode.state,
      visualStatus: visualStatusForSmithersNode(dbNode),
      source: 'smithers-db',
      node: dbNode,
    });
  }
  return overlays;
}

function latestNodesByNodeId(nodes: SmithersRunNode[]): Map<string, SmithersRunNode> {
  const latest = new Map<string, SmithersRunNode>();
  for (const node of nodes) {
    const existing = latest.get(node.nodeId);
    if (!existing || node.iteration > existing.iteration || (node.iteration === existing.iteration && node.updatedAtMs > existing.updatedAtMs)) {
      latest.set(node.nodeId, node);
    }
  }
  return latest;
}

function visualStatusForSmithersNode(node: SmithersRunNode): string {
  const raw = `${node.status || node.state || ''}`.toLowerCase();
  if (raw === 'finished' || raw === 'succeeded' || raw === 'success' || raw === 'done') return 'done';
  if (raw === 'running' || raw === 'in_progress' || raw === 'in-progress') return 'running';
  if (raw === 'failed' || raw === 'error') return 'failed';
  if (raw === 'cancelled' || raw === 'canceled') return 'failed';
  if (raw === 'waiting' || raw === 'pending' || raw === 'queued' || raw.startsWith('waiting-')) return 'pending';
  return raw || 'pending';
}

function graphNodeById(graph: OverlayRenderGraph, id: string): OverlayRenderNode | undefined {
  return graph.nodes.find((node) => node.id === id);
}

function filterBySelectedNodeIteration<T extends { nodeId: string; iteration: number }>(
  rows: T[],
  nodeId: string,
  iteration: number | null,
): T[] {
  return rows.filter((row) => row.nodeId === nodeId && (iteration === null || row.iteration === iteration));
}

function filterEventsForNode(events: SmithersRunEvent[], nodeId: string): SmithersRunEvent[] {
  return events.filter((event) => event.nodeId === nodeId || event.nodeId === null);
}

function toInspectorAttempt(attempt: SmithersRunAttempt): SmithersRunInspectorState['attempts'][number] {
  return {
    nodeId: attempt.nodeId,
    iteration: attempt.iteration,
    attempt: attempt.attempt,
    rawStatus: attempt.status,
    rawState: attempt.state,
    errorText: stringifyError(attempt.error),
    responseText: attempt.responseText,
  };
}

function toFrameSummary(frame: SmithersRunFrame): SmithersRunInspectorState['frames'][number] {
  return {
    frameNo: frame.frameNo,
    mountedTaskIds: frame.mountedTaskIds,
    kind: 'summary',
    createdAtMs: frame.createdAtMs,
    note: frame.note,
  };
}

function stringifyError(error: unknown): string | null {
  if (error == null) return null;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
