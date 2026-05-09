import { buildSmithersRunOverlayState, type OverlayRenderGraph, type SmithersRunOverlayState } from './smithersRunOverlay.js';
import type { SmithersRunDetail, SmithersRunGraphSource } from '../smithersProject/runReaderTypes.js';

const LIVE_PROVENANCE_LABEL = 'Smithers SQLite · live run';
const HISTORICAL_FRAME_PROVENANCE_LABEL = 'Smithers Run Frame · historical run';
const HISTORICAL_UNAVAILABLE_PROVENANCE_LABEL = 'Smithers Run Frame unavailable';

export type ProjectRenderedGraphDecision =
  | {
    mode: 'preview';
    graph: OverlayRenderGraph;
    provenance: { liveSmithers: false; label?: string; status?: string; error?: string };
    visibleCopy: string[];
    error?: string;
  }
  | {
    mode: 'live';
    graph: OverlayRenderGraph;
    provenance: { liveSmithers: true; label: string; status: string; error?: string };
    visibleCopy: string[];
    error?: string;
  }
  | {
    mode: 'live-overlay-error';
    graph: OverlayRenderGraph;
    provenance: { liveSmithers: false; label: string; status: 'preview'; error: string };
    visibleCopy: string[];
    error: string;
  };

export type ProjectHistoricalRunGraphDecision =
  | {
    mode: 'historical-frame';
    graph: OverlayRenderGraph;
    provenance: {
      historicalSmithers: true;
      label: string;
      runId: string;
      status: string;
      graphSource: SmithersRunGraphSource;
    };
    visibleCopy: string[];
  }
  | {
    mode: 'historical-unavailable';
    graph: OverlayRenderGraph;
    provenance: {
      historicalSmithers: true;
      label: string;
      runId: string;
      status: string;
      graphSource: SmithersRunGraphSource;
      error: string;
    };
    visibleCopy: string[];
    error: string;
  };

export function deriveProjectRenderedGraph(options: {
  previewGraph: OverlayRenderGraph;
  liveMode?: boolean;
  liveDetail?: SmithersRunDetail | null;
  overlayBuilder?: (options: { graph: OverlayRenderGraph; detail: SmithersRunDetail }) => Pick<SmithersRunOverlayState, 'graph' | 'provenanceLabel' | 'visibleCopy'>;
}): ProjectRenderedGraphDecision {
  if (!options.liveMode || !options.liveDetail) {
    return {
      mode: 'preview',
      graph: options.previewGraph,
      provenance: { liveSmithers: false },
      visibleCopy: [],
    };
  }

  const overlayBuilder = options.overlayBuilder ?? buildSmithersRunOverlayState;
  try {
    const overlay = overlayBuilder({ graph: options.previewGraph, detail: options.liveDetail });
    const status = String(options.liveDetail.run?.status ?? 'unknown');
    return {
      mode: 'live',
      graph: overlay.graph,
      provenance: {
        liveSmithers: true,
        label: overlay.provenanceLabel || LIVE_PROVENANCE_LABEL,
        status,
      },
      visibleCopy: overlay.visibleCopy ?? [overlay.provenanceLabel || LIVE_PROVENANCE_LABEL, `raw status: ${status}`],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: 'live-overlay-error',
      graph: options.previewGraph,
      provenance: {
        liveSmithers: false,
        label: 'Preview graph · live overlay failed',
        status: 'preview',
        error: message,
      },
      visibleCopy: ['Preview graph · live overlay failed', `Smithers live overlay failed: ${message}`],
      error: message,
    };
  }
}

export function deriveHistoricalProjectRunGraph(options: {
  detail: SmithersRunDetail;
  workflowId?: string | null;
}): ProjectHistoricalRunGraphDecision {
  const runId = String(options.detail.run?.runId ?? 'unknown');
  const status = String(options.detail.run?.status ?? 'unknown');
  const graphSource = options.detail.view?.graphSource ?? {
    kind: 'unavailable' as const,
    runId,
    fallback: false as const,
    reason: 'Smithers Inspection API did not provide historical graph provenance.',
  };

  if (options.detail.view?.graph && graphSource.kind === 'smithers-frame') {
    const graph = normalizeHistoricalGraph(options.detail.view.graph as OverlayRenderGraph, options.detail, graphSource);
    const label = `${HISTORICAL_FRAME_PROVENANCE_LABEL} · ${runId} · frame ${graphSource.frameNo}`;
    return {
      mode: 'historical-frame',
      graph,
      provenance: {
        historicalSmithers: true,
        label,
        runId,
        status,
        graphSource,
      },
      visibleCopy: [
        HISTORICAL_FRAME_PROVENANCE_LABEL,
        `Smithers run ${runId}`,
        `frame ${graphSource.frameNo}`,
        `raw run status: ${status}`,
      ],
    };
  }

  const reason = graphSource.kind === 'unavailable'
    ? graphSource.reason
    : 'Smithers Inspection API did not include a frame-backed historical graph.';
  const unavailableSource: SmithersRunGraphSource = graphSource.kind === 'unavailable'
    ? graphSource
    : { kind: 'unavailable', runId, frameNo: graphSource.frameNo, fallback: false, reason };
  const graph = unavailableHistoricalGraph({
    runId,
    status,
    workflowId: options.workflowId ?? options.detail.run?.workflowName ?? null,
    reason,
    frameNo: unavailableSource.frameNo,
  });
  const label = `${HISTORICAL_UNAVAILABLE_PROVENANCE_LABEL} · ${runId}`;
  return {
    mode: 'historical-unavailable',
    graph,
    provenance: {
      historicalSmithers: true,
      label,
      runId,
      status,
      graphSource: unavailableSource,
      error: reason,
    },
    visibleCopy: [
      HISTORICAL_UNAVAILABLE_PROVENANCE_LABEL,
      `Smithers run ${runId}`,
      ...(unavailableSource.frameNo == null ? [] : [`frame ${unavailableSource.frameNo}`]),
      reason,
      'No current Workflow Source graph fallback was used.',
    ],
    error: reason,
  };
}

function normalizeHistoricalGraph(
  graph: OverlayRenderGraph,
  detail: SmithersRunDetail,
  graphSource: Extract<SmithersRunGraphSource, { kind: 'smithers-frame' }>,
): OverlayRenderGraph {
  return {
    ...graph,
    runId: detail.run.runId,
    runStatus: detail.run.status,
    reason: typeof graph.reason === 'string' && graph.reason.length > 0
      ? graph.reason
      : 'Projected from persisted Smithers Run Frame.',
    source: {
      ...((graph.source && typeof graph.source === 'object') ? graph.source : {}),
      kind: 'smithers' as const,
      frameNo: graphSource.frameNo,
      note: `Smithers Run Frame · ${detail.run.runId} · frame ${graphSource.frameNo}`,
    },
    nodes: Array.isArray(graph.nodes)
      ? graph.nodes.map((node) => ({ ...node, status: visualStatus(node.status) }))
      : [],
  };
}

function unavailableHistoricalGraph(args: {
  runId: string;
  status: string;
  workflowId: string | null;
  reason: string;
  frameNo?: number;
}): OverlayRenderGraph {
  const title = args.workflowId ? `Historical run · ${args.workflowId}` : 'Historical Smithers run';
  return {
    goal: `Historical Smithers run ${args.runId}`,
    path: 'workflow',
    reason: `Frame-backed graph unavailable: ${args.reason}`,
    latency: 'unknown',
    tokens: 'unknown',
    runId: args.runId,
    runStatus: args.status,
    title,
    nodes: [
      {
        id: 'historical-graph-unavailable',
        type: 'goal',
        title: 'Historical graph unavailable',
        x: 380,
        y: 30,
        agent: 'Smithers Inspection API',
        prompt: `${args.reason}\n\nNo current Workflow Source graph fallback was used for this historical run.`,
        tools: [],
        status: 'failed',
        timeline: [],
        smithers: {
          kind: 'unavailable',
          tag: 'custom-harness:historical-graph-unavailable',
          props: {
            runId: args.runId,
            ...(args.frameNo == null ? {} : { frameNo: String(args.frameNo) }),
          },
        },
      },
    ],
    edges: [],
    defaultSelected: 'historical-graph-unavailable',
    source: {
      kind: 'smithers' as const,
      ...(args.frameNo == null ? {} : { frameNo: args.frameNo }),
      note: 'historical graph unavailable; no current-source fallback',
    },
  };
}

function visualStatus(status: unknown): string {
  const raw = String(status || '').toLowerCase();
  if (raw === 'finished' || raw === 'succeeded' || raw === 'success') return 'done';
  if (raw === 'cancelled' || raw === 'canceled') return 'failed';
  if (raw === 'waiting' || raw === 'queued' || raw.startsWith('waiting-')) return 'pending';
  return raw || 'pending';
}
