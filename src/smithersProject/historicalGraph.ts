import type {
  AgentLike,
  GraphSnapshot,
  TaskDescriptor,
  XmlElement,
  XmlNode,
} from "@smithers-orchestrator/graph";
import {
  smithersSnapshotToRenderGraph,
  type RenderGraph,
} from "../runs/smithersGraph.js";
import { buildSmithersRunOverlayState } from "../ui/smithersRunOverlay.js";
import type {
  SmithersRunDetail,
  SmithersRunDetailView,
  SmithersRunFrame,
  SmithersRunNode,
  SmithersJsonValue,
} from "./runReaderTypes.js";

const NOT_CAPTURED = "unknown / not captured in persisted Smithers Run Frame";

type HistoricalTaskSeed = {
  nodeId: string;
  ordinal?: number;
  iteration?: number;
  label?: string;
  prompt?: string;
  outputTableName?: string;
  dependsOn?: string[];
  needs?: Record<string, string>;
  needsApproval?: boolean;
  approvalMode?: "gate" | "decision" | "select" | "rank";
  worktreeId?: string;
  worktreePath?: string;
  parallelGroupId?: string;
  meta?: Record<string, unknown>;
  agent?: AgentLike;
};

export function addHistoricalRunView(
  detail: SmithersRunDetail
): SmithersRunDetail {
  detail.view = buildHistoricalRunView(detail);
  return detail;
}

export function buildHistoricalRunView(
  detail: SmithersRunDetail
): SmithersRunDetailView {
  const frame = latestFrame(detail.frames);
  if (!frame) {
    return {
      graphSource: {
        kind: "unavailable",
        runId: detail.run.runId,
        fallback: false,
        reason: "No persisted Smithers Run Frame is available for this run.",
      },
    };
  }

  if (!frame.xml) {
    return {
      graphSource: {
        kind: "unavailable",
        runId: detail.run.runId,
        frameNo: frame.frameNo,
        fallback: false,
        reason: "Persisted Smithers Run Frame XML is missing or malformed.",
      },
    };
  }

  try {
    const graph = graphFromFrame(detail, frame);
    return {
      graph,
      graphSource: {
        kind: "smithers-frame",
        runId: detail.run.runId,
        frameNo: frame.frameNo,
        fallback: false,
      },
    };
  } catch (error) {
    return {
      graphSource: {
        kind: "unavailable",
        runId: detail.run.runId,
        frameNo: frame.frameNo,
        fallback: false,
        reason: `Could not project persisted Smithers Run Frame: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

function graphFromFrame(
  detail: SmithersRunDetail,
  frame: SmithersRunFrame
): RenderGraph {
  const snapshot: GraphSnapshot = {
    runId: detail.run.runId,
    frameNo: frame.frameNo,
    xml: frame.xml as XmlNode,
    tasks: descriptorsFromFrame(detail, frame),
  };
  const graph = smithersSnapshotToRenderGraph({
    snapshot,
    goal: historicalGoal(detail),
    path: "workflow",
    reason: "Projected from persisted Smithers Run Frame.",
    runId: detail.run.runId,
    planningLatencyMs: null,
    tokens: null,
    submittedAt: new Date(detail.run.createdAtMs || frame.createdAtMs || 0),
  });
  const overlaid = buildSmithersRunOverlayState({ graph, detail })
    .graph as RenderGraph;
  applyRawHistoricalStatuses(overlaid, detail);
  return overlaid;
}

function descriptorsFromFrame(
  detail: SmithersRunDetail,
  frame: SmithersRunFrame
): TaskDescriptor[] {
  const xmlTasks = taskElements(frame.xml as XmlNode | null);
  const seedsById = taskSeedsByNodeId(frame.taskIndex);
  const nodesById = latestRunNodesById(detail.nodes);
  const seen = new Set<string>();
  const descriptors: TaskDescriptor[] = [];

  xmlTasks.forEach((element, index) => {
    const nodeId = element.props.id;
    if (!nodeId) return;
    seen.add(nodeId);
    const seed = seedsById.get(nodeId) ?? { nodeId };
    descriptors.push(
      toTaskDescriptor({
        seed,
        node: nodesById.get(nodeId),
        element,
        ordinalFallback: index,
      })
    );
  });

  for (const seed of seedsById.values()) {
    if (seen.has(seed.nodeId)) continue;
    descriptors.push(
      toTaskDescriptor({
        seed,
        node: nodesById.get(seed.nodeId),
        element: null,
        ordinalFallback: descriptors.length,
      })
    );
  }

  return descriptors.sort(
    (a, b) => a.ordinal - b.ordinal || a.nodeId.localeCompare(b.nodeId)
  );
}

function toTaskDescriptor(args: {
  seed: HistoricalTaskSeed;
  node?: SmithersRunNode;
  element: XmlElement | null;
  ordinalFallback: number;
}): TaskDescriptor {
  const nodeId = args.seed.nodeId;
  const prompt =
    firstNonEmptyString(
      args.seed.prompt,
      args.element ? textContent(args.element) : undefined
    ) ?? NOT_CAPTURED;
  const label =
    firstNonEmptyString(
      args.element?.props.label,
      args.seed.label,
      args.node?.label
    ) ?? undefined;
  const outputTableName =
    firstNonEmptyString(args.seed.outputTableName, args.node?.outputTable) ??
    "";

  return {
    nodeId,
    ordinal: finiteInteger(args.seed.ordinal) ?? args.ordinalFallback,
    iteration: finiteInteger(args.seed.iteration) ?? args.node?.iteration ?? 0,
    outputTable: null,
    outputTableName,
    needsApproval: args.seed.needsApproval ?? false,
    skipIf: false,
    retries: 0,
    timeoutMs: null,
    heartbeatTimeoutMs: null,
    continueOnFail: false,
    prompt,
    label,
    dependsOn: args.seed.dependsOn,
    needs: args.seed.needs,
    approvalMode: args.seed.approvalMode,
    worktreeId: args.seed.worktreeId,
    worktreePath: args.seed.worktreePath,
    parallelGroupId: args.seed.parallelGroupId,
    agent: args.seed.agent ?? { id: NOT_CAPTURED, generate: async () => ({}) },
    meta: args.seed.meta,
  };
}

function taskSeedsByNodeId(
  taskIndex: SmithersJsonValue | null
): Map<string, HistoricalTaskSeed> {
  const seeds = new Map<string, HistoricalTaskSeed>();
  for (const value of flattenTaskIndex(taskIndex)) {
    const seed = taskSeed(value);
    if (seed) seeds.set(seed.nodeId, seed);
  }
  return seeds;
}

function flattenTaskIndex(value: unknown): unknown[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object")
    return Object.values(value as Record<string, unknown>);
  return [];
}

function taskSeed(value: unknown): HistoricalTaskSeed | null {
  if (!isRecord(value)) return null;
  const nodeId = stringValue(value.nodeId) ?? stringValue(value.id);
  if (!nodeId) return null;
  return {
    nodeId,
    ordinal: finiteInteger(value.ordinal),
    iteration: finiteInteger(value.iteration),
    label: stringValue(value.label),
    prompt: stringValue(value.prompt),
    outputTableName:
      stringValue(value.outputTableName) ?? stringValue(value.outputTable),
    dependsOn: stringArray(value.dependsOn),
    needs: stringRecord(value.needs),
    needsApproval: booleanValue(value.needsApproval),
    approvalMode: approvalModeValue(value.approvalMode),
    worktreeId: stringValue(value.worktreeId),
    worktreePath: stringValue(value.worktreePath),
    parallelGroupId: stringValue(value.parallelGroupId),
    meta: recordValue(value.meta),
    agent: agentValue(value.agent),
  };
}

function latestFrame(frames: SmithersRunFrame[]): SmithersRunFrame | null {
  return frames.reduce<SmithersRunFrame | null>((latest, frame) => {
    if (!latest || frame.frameNo > latest.frameNo) return frame;
    return latest;
  }, null);
}

function taskElements(root: XmlNode | null): XmlElement[] {
  if (!root) return [];
  if (root.kind === "text") return [];
  const tag = stripSmithersPrefix(root.tag).toLowerCase();
  return [
    ...(tag === "task" ? [root] : []),
    ...root.children.flatMap((child) => taskElements(child)),
  ];
}

function latestRunNodesById(
  nodes: SmithersRunNode[]
): Map<string, SmithersRunNode> {
  const latest = new Map<string, SmithersRunNode>();
  for (const node of nodes) {
    const existing = latest.get(node.nodeId);
    if (
      !existing ||
      node.iteration > existing.iteration ||
      (node.iteration === existing.iteration &&
        node.updatedAtMs > existing.updatedAtMs)
    ) {
      latest.set(node.nodeId, node);
    }
  }
  return latest;
}

function applyRawHistoricalStatuses(
  graph: RenderGraph,
  detail: SmithersRunDetail
) {
  const nodesById = latestRunNodesById(detail.nodes);
  graph.nodes = graph.nodes.map((node) => {
    const smithersNodeId = node.smithers?.nodeId ?? node.id;
    const runNode = nodesById.get(smithersNodeId) ?? nodesById.get(node.id);
    return runNode
      ? { ...node, status: runNode.status || runNode.state || node.status }
      : node;
  });
}

function historicalGoal(detail: SmithersRunDetail): string {
  const config = detail.run.config;
  if (isRecord(config)) {
    const input = config.input;
    if (isRecord(input)) {
      const prompt = stringValue(input.prompt) ?? stringValue(input.request);
      if (prompt) return prompt;
    }
  }
  return `Historical Smithers run ${detail.run.runId}`;
}

function textContent(element: XmlElement): string {
  return element.children
    .map((child) => (child.kind === "text" ? child.text : textContent(child)))
    .join("")
    .trim();
}

function stripSmithersPrefix(tag: string) {
  return tag.replace(/^smithers:/, "");
}

function firstNonEmptyString(
  ...values: Array<string | null | undefined>
): string | undefined {
  return values
    .find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0
    )
    ?.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  );
  return filtered.length > 0 ? filtered : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].length > 0
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function approvalModeValue(
  value: unknown
): "gate" | "decision" | "select" | "rank" | undefined {
  return value === "gate" ||
    value === "decision" ||
    value === "select" ||
    value === "rank"
    ? value
    : undefined;
}

function agentValue(value: unknown): AgentLike | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id);
  const model = stringValue(value.model);
  if (!id && !model) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(model ? { model } : {}),
    generate: async () => ({}),
  };
}
