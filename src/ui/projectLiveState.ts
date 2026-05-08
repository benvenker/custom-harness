import { buildSmithersRunOverlayState, type OverlayRenderGraph, type SmithersRunOverlayState } from './smithersRunOverlay.js';
import type { SmithersRunDetail } from '../smithersProject/runReaderTypes.js';

const LIVE_PROVENANCE_LABEL = 'Smithers SQLite · live run';

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
