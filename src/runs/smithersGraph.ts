import type { GraphSnapshot, TaskDescriptor, XmlElement, XmlNode } from '@smthrs/graph';

type RunPath = 'harness' | 'workflow';
type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | string;

export type TimelineEvent = {
  ts: string;
  tool?: string;
  arg?: string;
  what?: string;
};

export type ControlFlowBadge = {
  kind: 'loop' | 'branch' | 'parallel';
  label: string;
  detail?: string;
  hostId?: string;
  groupId?: string;
  maxIterations?: string;
  maxConcurrency?: string;
  onMaxReached?: string;
};

export type RenderNode = {
  id: string;
  type: 'goal' | 'planner' | 'task' | 'harness-worker' | 'smithers-host';
  title: string;
  x: number;
  y: number;
  agent: string;
  prompt: string;
  tools: string[];
  status: RunStatus;
  duration?: string;
  decision?: RunPath;
  outputArtifact?: string;
  outputPreview?: string;
  outputBytes?: number;
  timeline: TimelineEvent[];
  smithers?: {
    kind: string;
    tag: string;
    props?: Record<string, string>;
    nodeId?: string;
    ordinal?: number;
    outputTableName?: string;
    dependsOn?: string[];
    needs?: Record<string, string>;
    needsApproval?: boolean;
    approvalMode?: string;
    worktreeId?: string;
    worktreePath?: string;
    parallelGroupId?: string;
    controlFlow?: ControlFlowBadge[];
    meta?: Record<string, unknown>;
  };
};

export type RenderEdge = {
  from: string;
  to: string;
  label?: string;
};

export type RenderGraph = {
  goal: string;
  path: RunPath;
  reason: string;
  latency: string;
  tokens: string;
  runId: string;
  title: string;
  nodes: RenderNode[];
  edges: RenderEdge[];
  defaultSelected: string;
  source?: {
    kind: 'smithers' | 'legacy-planner-workflow';
    frameNo?: number;
    note?: string;
  };
};

export type SmithersGraphMapperArgs = {
  snapshot: GraphSnapshot;
  goal: string;
  path: RunPath;
  reason: string;
  runId: string;
  planningLatencyMs: number | null;
  tokens: number | null;
  submittedAt: Date;
};

type LayoutNode = RenderNode & { row: number };

type LayoutResult = {
  nodes: LayoutNode[];
  edges: RenderEdge[];
  entries: string[];
  exits: string[];
  maxRow: number;
  rootKind: string;
};

const NODE_WIDTH = 280;
const TASK_COLUMNS = [80, 380, 680];
const GOAL_X = 380;
const GOAL_Y = 30;
const FIRST_TASK_Y = 230;
const TASK_ROW_STEP = 240;
const STRUCTURAL_TAGS = new Set(['workflow', 'sequence', 'parallel']);
const PRESERVED_HOST_TAGS = new Set(['approval', 'branch', 'loop', 'worktree']);

export function smithersSnapshotToRenderGraph(args: SmithersGraphMapperArgs): RenderGraph {
  const tasksById = new Map(args.snapshot.tasks.map((task) => [task.nodeId, task]));
  const usedHostIds = new Set<string>();
  const xml = asElement(args.snapshot.xml);
  const title = xml?.props.name ?? 'Smithers Workflow';
  const goalNode: RenderNode = {
    id: 'goal',
    type: 'goal',
    title: 'User goal',
    x: GOAL_X,
    y: GOAL_Y,
    agent: 'user',
    prompt: args.goal,
    tools: [],
    status: 'done',
    timeline: [{ ts: timeOnly(args.submittedAt), what: 'submitted' }],
    smithers: {
      kind: 'goal',
      tag: 'custom-harness:goal',
    },
  };

  const layout = xml
    ? layoutSmithersElement(xml, {
      row: 0,
      tasksById,
      usedHostIds,
      path: [],
      runPath: args.path,
      controlFlow: [],
    })
    : emptyLayout();

  assignColumns(layout.nodes);
  const nodes: RenderNode[] = [
    goalNode,
    ...layout.nodes.map(({ row: _row, ...node }) => node),
  ];
  const edges = dedupeEdges([
    ...layout.entries.map((entry, index) => ({ from: 'goal', to: entry, label: index === 0 ? '' : '' })),
    ...layout.edges,
    ...descriptorDependencyEdges(args.snapshot.tasks),
  ]);

  return {
    goal: args.goal,
    path: args.path,
    reason: args.reason,
    latency: args.planningLatencyMs == null ? 'unknown' : `${args.planningLatencyMs}ms`,
    tokens: args.tokens == null ? 'unknown' : String(args.tokens),
    runId: args.runId,
    title,
    nodes,
    edges,
    defaultSelected: defaultSelected(nodes),
    source: { kind: 'smithers', frameNo: args.snapshot.frameNo },
  };
}

function layoutSmithersElement(
  element: XmlElement,
  args: {
    row: number;
    tasksById: Map<string, TaskDescriptor>;
    usedHostIds: Set<string>;
    path: number[];
    runPath: RunPath;
    controlFlow: ControlFlowBadge[];
  },
): LayoutResult {
  const tag = canonicalHostKind(stripSmithersPrefix(element.tag));

  if (tag === 'task') {
    const id = element.props.id;
    if (!id) return emptyLayout(args.row);
    const descriptor = args.tasksById.get(id);
    const node: LayoutNode = {
      id,
      type: id === 'plan' ? 'planner' : args.runPath === 'harness' && id === 'worker' ? 'harness-worker' : 'task',
      title: taskTitle(element, descriptor),
      x: TASK_COLUMNS[1],
      y: taskY(args.row),
      row: args.row,
      agent: describeAgent(descriptor),
      prompt: descriptor?.prompt ?? textContent(element),
      tools: id === 'plan' ? ['zod', 'generateObject'] : [],
      status: id === 'plan' ? 'done' : 'idle',
      decision: id === 'plan' ? args.runPath : undefined,
      timeline: [],
      smithers: {
        kind: 'task',
        tag: element.tag,
        props: element.props,
        nodeId: id,
        ordinal: descriptor?.ordinal,
        outputTableName: descriptor?.outputTableName,
        dependsOn: descriptor?.dependsOn,
        needs: descriptor?.needs,
        needsApproval: descriptor?.needsApproval,
        approvalMode: descriptor?.approvalMode,
        worktreeId: descriptor?.worktreeId,
        worktreePath: descriptor?.worktreePath,
        parallelGroupId: descriptor?.parallelGroupId,
        controlFlow: controlFlowForTask(descriptor, args.controlFlow),
        meta: descriptor?.meta,
      },
    };
    return { nodes: [node], edges: [], entries: [id], exits: [id], maxRow: args.row, rootKind: 'task' };
  }

  const childElements = element.children.flatMap((child, index) => {
    const childElement = asElement(child);
    return childElement ? [{ element: childElement, index }] : [];
  });

  if (tag === 'parallel') {
    const parallelBadge = controlFlowBadgeForHost('parallel', element, stableHostId('parallel', args.path, new Set()));
    const childResults = childElements.map(({ element: child, index }) =>
      layoutSmithersElement(child, {
        ...args,
        row: args.row,
        path: [...args.path, index],
        controlFlow: mergeControlFlow(args.controlFlow, [parallelBadge]),
      }),
    );
    return {
      nodes: childResults.flatMap((result) => result.nodes),
      edges: childResults.flatMap((result) => result.edges),
      entries: childResults.flatMap((result) => result.entries),
      exits: childResults.flatMap((result) => result.exits),
      maxRow: Math.max(args.row, ...childResults.map((result) => result.maxRow)),
      rootKind: 'parallel',
    };
  }

  if (tag === 'workflow' || tag === 'sequence') {
    return layoutSequence(childElements.map(({ element }) => element), args, tag);
  }

  if (PRESERVED_HOST_TAGS.has(tag)) {
    const id = element.props.id ?? stableHostId(tag, args.path, args.usedHostIds);
    const hostBadge = controlFlowBadgeForHost(tag, element, id);
    const node: LayoutNode = {
      id,
      type: 'smithers-host',
      title: hostTitle(tag),
      x: TASK_COLUMNS[1],
      y: taskY(args.row),
      row: args.row,
      agent: 'smithers · host',
      prompt: `${element.tag}${Object.keys(element.props).length > 0 ? ` ${JSON.stringify(element.props)}` : ''}`,
      tools: [],
      status: 'idle',
      timeline: [],
      smithers: {
        kind: tag,
        tag: element.tag,
        props: element.props,
        controlFlow: hostBadge ? mergeControlFlow(args.controlFlow, [hostBadge]) : args.controlFlow,
      },
    };
    const children = layoutSequence(childElements.map(({ element: child }) => child), {
      ...args,
      row: args.row + 1,
      controlFlow: hostBadge ? mergeControlFlow(args.controlFlow, [hostBadge]) : args.controlFlow,
    }, tag);
    return {
      nodes: [node, ...children.nodes],
      edges: [
        ...children.entries.map((entry, index) => ({ from: id, to: entry, label: index === 0 ? '' : '' })),
        ...children.edges,
      ],
      entries: [id],
      exits: children.exits.length > 0 ? children.exits : [id],
      maxRow: Math.max(args.row, children.maxRow),
      rootKind: tag,
    };
  }

  if (!STRUCTURAL_TAGS.has(tag)) {
    const children = layoutSequence(childElements.map(({ element: child }) => child), args, tag);
    return {
      ...children,
      rootKind: tag,
    };
  }

  return emptyLayout(args.row);
}

function layoutSequence(
  children: XmlElement[],
  args: {
    row: number;
    tasksById: Map<string, TaskDescriptor>;
    usedHostIds: Set<string>;
    path: number[];
    runPath: RunPath;
    controlFlow: ControlFlowBadge[];
  },
  rootKind: string,
): LayoutResult {
  const childResults: LayoutResult[] = [];
  let cursorRow = args.row;
  children.forEach((child, index) => {
    const result = layoutSmithersElement(child, {
      ...args,
      row: cursorRow,
      path: [...args.path, index],
    });
    childResults.push(result);
    cursorRow = result.maxRow + 1;
  });

  const edges: RenderEdge[] = childResults.flatMap((result) => result.edges);
  for (let i = 1; i < childResults.length; i += 1) {
    const previous = childResults[i - 1];
    const current = childResults[i];
    const label = previous.rootKind === 'parallel' ? 'barrier' : current.rootKind === 'parallel' ? 'parallel' : '';
    previous.exits.forEach((from, fromIndex) => {
      current.entries.forEach((to, toIndex) => {
        edges.push({ from, to, label: fromIndex === 0 && toIndex === 0 ? label : '' });
      });
    });
  }

  return {
    nodes: childResults.flatMap((result) => result.nodes),
    edges,
    entries: childResults[0]?.entries ?? [],
    exits: childResults.at(-1)?.exits ?? [],
    maxRow: Math.max(args.row, ...childResults.map((result) => result.maxRow)),
    rootKind,
  };
}

function descriptorDependencyEdges(tasks: readonly TaskDescriptor[]): RenderEdge[] {
  return tasks.flatMap((task) => {
    const explicitDeps = [
      ...(task.dependsOn ?? []),
      ...Object.values(task.needs ?? {}),
    ];
    return [...new Set(explicitDeps)].map((from) => ({
      from,
      to: task.nodeId,
      label: 'dependsOn',
    }));
  });
}

function dedupeEdges(edges: RenderEdge[]): RenderEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (!edge.from || !edge.to || edge.from === edge.to) return false;
    const key = `${edge.from}\0${edge.to}\0${edge.label ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assignColumns(nodes: LayoutNode[]) {
  const rows = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    const row = rows.get(node.row) ?? [];
    row.push(node);
    rows.set(node.row, row);
  }
  for (const rowNodes of rows.values()) {
    if (rowNodes.length === 1) {
      rowNodes[0].x = TASK_COLUMNS[1];
    } else {
      rowNodes.forEach((node, index) => {
        node.x = TASK_COLUMNS[index] ?? TASK_COLUMNS[0] + index * 300;
      });
    }
  }
}

function asElement(node: XmlNode | null): XmlElement | null {
  return node?.kind === 'element' ? node : null;
}

function stripSmithersPrefix(tag: string) {
  return tag.replace(/^smithers:/, '');
}

function canonicalHostKind(tag: string) {
  return tag === 'ralph' ? 'loop' : tag;
}

function hostTitle(tag: string) {
  if (tag === 'loop') return 'Loop';
  if (tag === 'branch') return 'Branch';
  if (tag === 'parallel') return 'Parallel';
  return titleCase(tag);
}

function controlFlowBadgeForHost(
  tag: string,
  element: XmlElement,
  hostId: string,
): ControlFlowBadge | null {
  if (tag === 'loop') {
    const maxIterations = element.props.maxIterations;
    const onMaxReached = element.props.onMaxReached;
    return {
      kind: 'loop',
      hostId,
      label: maxIterations ? `LOOP · max ${maxIterations}` : 'LOOP',
      detail: [
        maxIterations ? `maxIterations=${maxIterations}` : '',
        onMaxReached ? `onMaxReached=${onMaxReached}` : '',
      ].filter(Boolean).join(' · ') || undefined,
      maxIterations,
      onMaxReached,
    };
  }
  if (tag === 'branch') {
    return {
      kind: 'branch',
      hostId,
      label: 'BRANCH',
      detail: element.props.id ? `id=${element.props.id}` : undefined,
    };
  }
  if (tag === 'parallel') {
    const maxConcurrency = element.props.maxConcurrency;
    return {
      kind: 'parallel',
      groupId: element.props.id ?? hostId,
      label: maxConcurrency ? `PARALLEL · max ${maxConcurrency}` : 'PARALLEL',
      detail: maxConcurrency ? `maxConcurrency=${maxConcurrency}` : undefined,
      maxConcurrency,
    };
  }
  return null;
}

function controlFlowForTask(
  descriptor: TaskDescriptor | undefined,
  inherited: ControlFlowBadge[],
): ControlFlowBadge[] | undefined {
  const inheritedHasParallel = inherited.some((badge) => badge.kind === 'parallel');
  const fromDescriptor = descriptor?.parallelGroupId && !inheritedHasParallel
    ? [{
      kind: 'parallel' as const,
      groupId: descriptor.parallelGroupId,
      label: descriptor.parallelMaxConcurrency
        ? `PARALLEL · max ${descriptor.parallelMaxConcurrency}`
        : 'PARALLEL',
      detail: descriptor.parallelMaxConcurrency
        ? `maxConcurrency=${descriptor.parallelMaxConcurrency}`
        : undefined,
      maxConcurrency: descriptor.parallelMaxConcurrency == null
        ? undefined
        : String(descriptor.parallelMaxConcurrency),
    }]
    : [];
  const merged = mergeControlFlow(inherited, fromDescriptor);
  return merged.length > 0 ? merged : undefined;
}

function mergeControlFlow(
  base: ControlFlowBadge[],
  extra: Array<ControlFlowBadge | null | undefined>,
): ControlFlowBadge[] {
  const merged: ControlFlowBadge[] = [];
  const seen = new Set<string>();
  for (const badge of [...base, ...extra]) {
    if (!badge) continue;
    const key = `${badge.kind}:${badge.hostId ?? badge.groupId ?? badge.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(badge);
  }
  return merged;
}

function textContent(element: XmlElement): string {
  return element.children
    .map((child) => child.kind === 'text' ? child.text : child.kind === 'element' ? textContent(child) : '')
    .join('')
    .trim();
}

function taskTitle(element: XmlElement, descriptor?: TaskDescriptor) {
  return element.props.label ?? descriptor?.label ?? titleCase((element.props.id ?? descriptor?.nodeId ?? 'task').replace(/[-_]+/g, ' '));
}

function describeAgent(descriptor?: TaskDescriptor) {
  const agent = descriptor?.agent;
  if (Array.isArray(agent)) return `smithers · ${agent.length} agents`;
  if (agent && typeof agent === 'object') {
    const model = (agent as { model?: unknown }).model;
    const id = (agent as { id?: unknown }).id;
    if (typeof model === 'string' && model) return `smithers · ${model}`;
    if (typeof id === 'string' && id) return `smithers · ${id}`;
  }
  return 'smithers · task agent';
}

function defaultSelected(nodes: RenderNode[]) {
  return nodes.find((node) => node.id !== 'goal' && node.id !== 'plan')?.id
    ?? nodes.find((node) => node.id === 'plan')?.id
    ?? nodes[0]?.id
    ?? 'goal';
}

function emptyLayout(row = 0): LayoutResult {
  return { nodes: [], edges: [], entries: [], exits: [], maxRow: row, rootKind: 'empty' };
}

function stableHostId(tag: string, path: number[], used: Set<string>) {
  const base = `${tag}-${path.join('-') || 'root'}`;
  let next = base;
  let index = 2;
  while (used.has(next)) {
    next = `${base}-${index}`;
    index += 1;
  }
  used.add(next);
  return next;
}

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function taskY(row: number) {
  return FIRST_TASK_Y + row * TASK_ROW_STEP;
}

function timeOnly(date: Date) {
  return date.toISOString().slice(11, 19);
}

export { NODE_WIDTH };
