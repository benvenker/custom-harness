import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { GraphSnapshot } from '@smithers-orchestrator/graph';
import { NODE_WIDTH, smithersSnapshotToRenderGraph, type RenderEdge, type RenderGraph, type RenderNode, type TimelineEvent } from './smithersGraph.js';
import type { Workflow, WorkflowNode } from '../types.js';

type RunPath = 'harness' | 'workflow';
type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | string;

type PlannerOutput = {
  path: RunPath;
  reason: string;
  workflow?: Workflow;
};

type PlanSummary = {
  path: RunPath;
  reason: string;
};

type SmithersRenderedPlan = {
  path: 'workflow';
  reason: string;
  source: {
    kind: 'smithers';
    workflowPath: string;
    input: Record<string, unknown>;
    context?: string;
    promptOverrides?: Record<string, string>;
  };
};

type RunTotals = {
  latencyMs: number | null;
  tokens: number | null;
};

type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  [key: string]: unknown;
};

type RunJson = {
  id: string;
  goal: string;
  path: RunPath;
  model: string;
  started: string;
  ended: string | null;
  status: RunStatus;
  totals: RunTotals;
  plan: { reason: string };
  sources?: { stdout?: string };
  notes?: string;
  forkedFrom?: string;
  overrides?: { promptOverrides?: Record<string, string> };
};

type PlanJson = {
  raw: PlannerOutput | SmithersRenderedPlan;
  graph: RenderGraph;
  layout: {
    persisted: boolean;
    coordinateSystem: string;
    nodeWidth: number;
  };
};

type RunIndex = {
  runs: Array<{
    id: string;
    goal: string;
    path: RunPath;
    started: string;
    status: RunStatus;
    forkedFrom?: string;
  }>;
};

type BaseEvent = {
  ts: string;
  type: string;
  runId: string;
  nodeId?: string;
  synthesized?: boolean;
  [key: string]: unknown;
};

export type RunRecorder = ReturnType<typeof createRunRecorder>;

const DEFAULT_RUNS_DIR = 'runs';
const TASK_COLUMNS = [80, 380, 680];
const GOAL_X = 380;
const GOAL_Y = 30;
const PLAN_X = 380;
const PLAN_Y = 230;
const FIRST_TASK_Y = 480;
const TASK_ROW_STEP = 240;
const PLANNER_PROMPT =
  'Classify the goal as harness (single Smithers CLI-agent task) or workflow (Smithers DAG). For workflow, define a tree of task / sequence / parallel nodes.';

export function createRunRecorder(
  runId: string,
  opts: { goal: string; model?: string },
  options: { runsDir?: string; forkedFrom?: string } = {},
) {
  const runsDir = options.runsDir ?? DEFAULT_RUNS_DIR;
  const indexPath = join(runsDir, 'index.json');
  const runDir = join(runsDir, runId);
  const artifactsDir = join(runDir, 'artifacts');
  const cliLogPath = join(artifactsDir, 'cli.log');
  const planPath = join(runDir, 'plan.json');
  const eventsPath = join(runDir, 'events.jsonl');
  const started = new Date();
  let initialized = false;
  let rawPlan: PlanSummary | null = null;
  let planJson: PlanJson | null = null;
  let planningLatencyMs: number | null = null;
  let totals: RunTotals = { latencyMs: null, tokens: null };
  const outputBuffers = new Map<string, string>();
  const outputArtifacts = new Map<string, { artifact: string; bytes: number; preview: string }>();
  const recordedTaskInputs = new Set<string>();
  let currentRun: RunJson = {
    id: runId,
    goal: opts.goal,
    // The planner has not decided yet. This temporary value is corrected in
    // run.json as soon as writePlan() receives the planner output.
    path: 'harness',
    model: opts.model ?? 'unknown',
    started: started.toISOString(),
    ended: null,
    status: 'running',
    totals,
    plan: { reason: 'Planning not completed yet.' },
    sources: { stdout: 'artifacts/cli.log' },
    ...(options.forkedFrom === undefined ? {} : { forkedFrom: options.forkedFrom }),
  };

  function ensureInitialized() {
    if (initialized) return;
    mkdirSync(artifactsDir, { recursive: true });
    writeRunJson();
    updateRunIndex(runsDir, indexPath, currentRun);
    initialized = true;
  }

  function writeRunJson() {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(currentRun, null, 2)}\n`);
  }

  function writePlanJson() {
    if (!planJson) return;
    mkdirSync(runDir, { recursive: true });
    writeFileSync(planPath, `${JSON.stringify(planJson, null, 2)}\n`);
  }

  function syncRunFromPlan(plan: PlanSummary) {
    currentRun = {
      ...currentRun,
      path: plan.path,
      plan: { reason: plan.reason },
    };
    writeRunJson();
    updateRunIndex(runsDir, indexPath, currentRun);
  }

  function findNode(nodeId?: string) {
    if (!nodeId || !planJson) return null;
    return planJson.graph.nodes.find((node) => node.id === nodeId) ?? null;
  }

  function updateGraphForEvent(ev: BaseEvent) {
    if (!planJson) return;
    const graph = planJson.graph;
    const node = findNode(ev.nodeId);
    if (ev.type === 'plan.decision') {
      const planner = graph.nodes.find((n) => n.id === 'plan');
      if (planner) {
        planner.status = 'done';
        planner.decision = ev.path as RunPath;
        pushTimeline(planner, { tool: 'generateObject', arg: 'planSchema' }, ev.ts);
        pushTimeline(planner, { what: `decision = ${String(ev.path)}` }, ev.ts);
        if (typeof ev.reason === 'string') pushTimeline(planner, { what: truncate(ev.reason, 96) }, ev.ts);
      }
      return;
    }
    if (!node) return;

    if (ev.type === 'agent.init') {
      node.status = 'running';
      pushTimeline(node, { tool: 'agent.init', arg: typeof ev.model === 'string' ? ev.model : undefined }, ev.ts);
    } else if (ev.type === 'task.started') {
      node.status = 'running';
      pushTimeline(node, { what: 'task started' }, ev.ts);
    } else if (ev.type.startsWith('tool.')) {
      node.status = 'running';
      const tool = ev.type.replace(/^tool\./, '');
      pushTimeline(node, { tool, arg: typeof ev.arg === 'string' ? ev.arg : undefined }, ev.ts);
      if (ev.type.endsWith('.error')) node.status = 'failed';
    } else if (ev.type === 'agent.output') {
      const bytes = typeof ev.bytes === 'number' ? formatBytes(ev.bytes) : null;
      const preview = typeof ev.preview === 'string' ? ` · “${truncate(ev.preview, 90)}”` : '';
      const artifact = typeof ev.artifact === 'string' ? ` · ${ev.artifact}` : '';
      if (typeof ev.artifact === 'string') node.outputArtifact = ev.artifact;
      if (typeof ev.preview === 'string') node.outputPreview = ev.preview;
      if (typeof ev.bytes === 'number') node.outputBytes = ev.bytes;
      pushTimeline(node, { what: `output${bytes ? ` · ${bytes}` : ''}${preview}${artifact}` }, ev.ts);
    } else if (ev.type === 'task.checkpoint') {
      if (ev.checkpoint === 'started') node.status = 'running';
      pushTimeline(node, { what: `checkpoint · ${String(ev.checkpoint ?? 'updated')}` }, ev.ts);
    } else if (ev.type === 'task.done') {
      node.status = 'done';
      pushTimeline(node, { what: 'task done' }, ev.ts);
    } else if (ev.type === 'run.error') {
      node.status = 'failed';
      pushTimeline(node, { what: `error · ${truncate(String(ev.message ?? 'unknown'), 120)}` }, ev.ts);
    }
  }

  function persistGraph() {
    if (planJson) writePlanJson();
  }

  return {
    runId,
    runDir,
    artifactsDir,
    cliLogPath,
    get rawPlan() {
      return rawPlan;
    },
    event(type: string, payload: Record<string, unknown> = {}) {
      ensureInitialized();
      const ev: BaseEvent = {
        ts: new Date().toISOString(),
        type,
        runId,
        ...payload,
      };
      appendFileSync(eventsPath, `${JSON.stringify(ev)}\n`);
      updateGraphForEvent(ev);
      persistGraph();
    },
    writePlan(plan: PlannerOutput, options: { planningLatencyMs?: number; tokens?: number | null; usage?: TokenUsage | null } = {}) {
      ensureInitialized();
      rawPlan = plan;
      if (typeof options.planningLatencyMs === 'number') planningLatencyMs = options.planningLatencyMs;
      const tokens = options.tokens ?? options.usage?.totalTokens;
      if (typeof tokens === 'number' || tokens === null) totals = { ...totals, tokens };
      syncRunFromPlan(plan);
      planJson = buildPlanJson({
        runId,
        goal: opts.goal,
        plan,
        planningLatencyMs,
        tokens: totals.tokens,
        submittedAt: started,
      });
      writePlanJson();
    },
    writeSmithersGraphSnapshot(snapshot: GraphSnapshot) {
      ensureInitialized();
      if (!rawPlan || !planJson) return;
      const previousGraph = planJson.graph;
      const graph = smithersSnapshotToRenderGraph({
        snapshot,
        runId,
        goal: opts.goal,
        path: rawPlan.path,
        reason: rawPlan.reason,
        planningLatencyMs,
        tokens: totals.tokens,
        submittedAt: started,
      });
      mergeRuntimeNodeState(graph, previousGraph);
      planJson = {
        ...planJson,
        graph,
      };
      writePlanJson();
    },
    writeSmithersPlanSnapshot(
      snapshot: GraphSnapshot,
      options: {
        reason: string;
        workflowPath: string;
        input: Record<string, unknown>;
        context?: string;
        promptOverrides?: Record<string, string>;
        planningLatencyMs?: number;
        tokens?: number | null;
      },
    ) {
      ensureInitialized();
      const summary: PlanSummary = { path: 'workflow', reason: options.reason };
      rawPlan = summary;
      if (typeof options.planningLatencyMs === 'number') planningLatencyMs = options.planningLatencyMs;
      if ('tokens' in options) totals = { ...totals, tokens: options.tokens ?? null };
      if (options.promptOverrides && Object.keys(options.promptOverrides).length > 0) {
        currentRun = {
          ...currentRun,
          overrides: { promptOverrides: { ...options.promptOverrides } },
        };
      }
      syncRunFromPlan(summary);
      planJson = {
        raw: {
          path: 'workflow',
          reason: options.reason,
          source: {
            kind: 'smithers',
            workflowPath: options.workflowPath,
            input: options.input,
            ...(options.context === undefined ? {} : { context: options.context }),
            ...(options.promptOverrides && Object.keys(options.promptOverrides).length > 0
              ? { promptOverrides: { ...options.promptOverrides } }
              : {}),
          },
        },
        graph: smithersSnapshotToRenderGraph({
          snapshot,
          runId,
          goal: opts.goal,
          path: 'workflow',
          reason: options.reason,
          planningLatencyMs,
          tokens: totals.tokens,
          submittedAt: started,
        }),
        layout: {
          persisted: true,
          coordinateSystem: 'web/index.html canvas pixels',
          nodeWidth: NODE_WIDTH,
        },
      };
      writePlanJson();
    },
    appendCli(text: string) {
      ensureInitialized();
      appendFileSync(cliLogPath, text);
    },
    appendAgentOutput(nodeId: string, text: string) {
      if (!text) return;
      outputBuffers.set(nodeId, `${outputBuffers.get(nodeId) ?? ''}${text}`);
    },
    recordTaskInput(nodeId: string, inputs: Array<{ from: string; label: string; value: unknown }>) {
      ensureInitialized();
      if (recordedTaskInputs.has(nodeId) || inputs.length === 0) return;
      recordedTaskInputs.add(nodeId);
      const payload = inputs.map((input) => ({
        from: input.from,
        label: input.label,
        bytes: Buffer.byteLength(JSON.stringify(input.value) ?? '', 'utf8'),
        value: input.value,
      }));
      const artifact = `artifacts/${safeArtifactName(nodeId)}.inputs.json`;
      writeFileSync(join(runDir, artifact), `${JSON.stringify(payload, null, 2)}\n`);
      const summary = payload.map((input) => `${input.label} (${formatBytes(input.bytes)})`).join(', ');
      this.event('task.checkpoint', {
        nodeId,
        checkpoint: `input ← ${summary} · ${artifact}`,
        artifact,
        inputs: payload.map(({ from, label, bytes }) => ({ from, label, bytes })),
        synthesized: false,
      });
    },
    flushAgentOutput(nodeId: string, options: { synthesized?: boolean } = {}) {
      ensureInitialized();
      const text = outputBuffers.get(nodeId);
      if (!text) return;
      outputBuffers.delete(nodeId);
      const bytes = Buffer.byteLength(text, 'utf8');
      const artifact = `artifacts/${safeArtifactName(nodeId)}.txt`;
      const preview = previewText(text);
      writeFileSync(join(runDir, artifact), text);
      outputArtifacts.set(nodeId, { artifact, bytes, preview });
      this.event('agent.output', {
        nodeId,
        artifact,
        bytes,
        preview,
        synthesized: options.synthesized ?? false,
      });
    },
    outputArtifactFor(nodeId: string) {
      return outputArtifacts.get(nodeId)?.artifact;
    },
    finish(status: RunStatus, nextTotals: Partial<RunTotals> = {}) {
      ensureInitialized();
      for (const nodeId of [...outputBuffers.keys()]) this.flushAgentOutput(nodeId);
      totals = {
        latencyMs: nextTotals.latencyMs ?? Date.now() - started.getTime(),
        tokens: nextTotals.tokens ?? totals.tokens,
      };
      currentRun = {
        ...currentRun,
        ended: new Date().toISOString(),
        status,
        totals,
      };
      if (planJson) {
        planJson.graph.latency = `${totals.latencyMs}ms`;
        planJson.graph.tokens = totals.tokens == null ? 'unknown' : String(totals.tokens);
        writePlanJson();
      }
      writeRunJson();
      updateRunIndex(runsDir, indexPath, currentRun);
    },
  };
}

function buildPlanJson(args: {
  runId: string;
  goal: string;
  plan: PlannerOutput;
  planningLatencyMs: number | null;
  tokens: number | null;
  submittedAt: Date;
}): PlanJson {
  const graph = buildLegacyGraph(args);
  return {
    raw: args.plan,
    graph,
    layout: {
      persisted: true,
      coordinateSystem: 'web/index.html canvas pixels',
      nodeWidth: NODE_WIDTH,
    },
  };
}

function buildLegacyGraph(args: {
  runId: string;
  goal: string;
  plan: PlannerOutput;
  planningLatencyMs: number | null;
  tokens: number | null;
  submittedAt: Date;
}): RenderGraph {
  const nodes: RenderNode[] = [
    {
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
    },
    {
      id: 'plan',
      type: 'planner',
      title: 'Planner',
      x: PLAN_X,
      y: PLAN_Y,
      agent: 'generateObject · planSchema',
      prompt: PLANNER_PROMPT,
      tools: ['zod', 'generateObject'],
      status: 'done',
      decision: args.plan.path,
      timeline: [
        { ts: timeOnly(args.submittedAt), tool: 'agent.init', arg: 'planner' },
        { ts: timeOnly(args.submittedAt), what: 'checkpoint · planner prompt prepared' },
      ],
    },
  ];
  const edges: RenderEdge[] = [{ from: 'goal', to: 'plan', label: '' }];

  if (args.plan.path === 'harness' || !args.plan.workflow) {
    nodes.push({
      id: 'worker',
      type: 'harness-worker',
      title: 'Worker · Smithers CLI task',
      x: TASK_COLUMNS[1],
      y: FIRST_TASK_Y,
      agent: 'smithers · CLI AgentLike',
      prompt: `Goal: ${args.goal}`,
      tools: ['read', 'write', 'edit', 'bash', 'done'],
      status: 'idle',
      timeline: [],
    });
    edges.push({ from: 'plan', to: 'worker', label: 'harness' });
    return finishGraph(args, nodes, edges, 'worker', 'Smithers CLI Task');
  }

  const layout = layoutLegacyPlannerWorkflow(args.plan.workflow.root);
  for (const node of layout.nodes) {
    nodes.push({
      id: node.id,
      type: 'task',
      title: node.title,
      x: node.x,
      y: node.y,
      agent: 'smithers · OpenAIAgent',
      prompt: node.prompt,
      tools: [],
      status: 'idle',
      timeline: [],
    });
  }
  const planEdgeLabel = firstExecutableChild(args.plan.workflow.root)?.type === 'parallel' ? 'parallel' : '';
  layout.entries.forEach((entry, index) => edges.push({ from: 'plan', to: entry, label: index === 0 ? planEdgeLabel : '' }));
  edges.push(...layout.edges);

  return finishGraph(
    args,
    nodes,
    edges,
    layout.nodes[0]?.id ?? 'plan',
    args.plan.workflow.name,
  );
}

function finishGraph(
  args: {
    runId: string;
    goal: string;
    plan: PlannerOutput;
    planningLatencyMs: number | null;
    tokens: number | null;
  },
  nodes: RenderNode[],
  edges: RenderEdge[],
  defaultSelected: string,
  title: string,
): RenderGraph {
  return {
    goal: args.goal,
    path: args.plan.path,
    reason: args.plan.reason,
    latency: args.planningLatencyMs == null ? 'unknown' : `${args.planningLatencyMs}ms`,
    tokens: args.tokens == null ? 'unknown' : String(args.tokens),
    runId: args.runId,
    title,
    nodes,
    edges,
    defaultSelected,
    source: { kind: 'legacy-planner-workflow', note: 'Fallback used before a Smithers GraphSnapshot is available.' },
  };
}

function mergeRuntimeNodeState(next: RenderGraph, previous: RenderGraph) {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  for (const node of next.nodes) {
    const old = previousById.get(node.id);
    if (!old) continue;
    node.status = old.status;
    node.duration = old.duration;
    node.decision = old.decision ?? node.decision;
    node.outputArtifact = old.outputArtifact;
    node.outputPreview = old.outputPreview;
    node.outputBytes = old.outputBytes;
    node.timeline = old.timeline;
  }
}

type LayoutTask = {
  id: string;
  title: string;
  prompt: string;
  row: number;
  x: number;
  y: number;
};

type LayoutResult = {
  nodes: LayoutTask[];
  edges: RenderEdge[];
  entries: string[];
  exits: string[];
  maxRow: number;
  rootKind: WorkflowNode['type'];
};

export function taskNodeIds(root: WorkflowNode): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  function visit(node: WorkflowNode) {
    if (node.type === 'task') {
      const id = uniqueSlug(node.name, used);
      ids.set(node.name, id);
      return;
    }
    if (node.type === 'sequence' || node.type === 'parallel') node.children.forEach(visit);
  }
  visit(root);
  return ids;
}

function layoutLegacyPlannerWorkflow(root: WorkflowNode): LayoutResult {
  const used = new Set<string>();
  const nodes: LayoutTask[] = [];
  const edges: RenderEdge[] = [];

  function walk(node: WorkflowNode, row: number): LayoutResult {
    if (node.type === 'task') {
      const task: LayoutTask = {
        id: uniqueSlug(node.name, used),
        title: node.name,
        prompt: node.prompt,
        row,
        x: TASK_COLUMNS[1],
        y: taskY(row),
      };
      nodes.push(task);
      return { nodes: [task], edges: [], entries: [task.id], exits: [task.id], maxRow: row, rootKind: 'task' };
    }

    if (node.type === 'parallel') {
      const childResults = node.children.map((child) => walk(child, row));
      return {
        nodes: childResults.flatMap((r) => r.nodes),
        edges: childResults.flatMap((r) => r.edges),
        entries: childResults.flatMap((r) => r.entries),
        exits: childResults.flatMap((r) => r.exits),
        maxRow: Math.max(row, ...childResults.map((r) => r.maxRow)),
        rootKind: 'parallel',
      };
    }

    if (node.type === 'sequence') {
      const childResults: LayoutResult[] = [];
      let cursorRow = row;
      for (const child of node.children) {
        const result = walk(child, cursorRow);
        childResults.push(result);
        cursorRow = result.maxRow + 1;
      }
      for (let i = 1; i < childResults.length; i += 1) {
        const previous = childResults[i - 1];
        const current = childResults[i];
        const label = previous.rootKind === 'parallel' ? 'barrier' : current.rootKind === 'parallel' ? 'parallel' : '';
        previous.exits.forEach((from, fromIndex) =>
          current.entries.forEach((to, toIndex) =>
            edges.push({ from, to, label: fromIndex === 0 && toIndex === 0 ? label : '' }),
          ),
        );
      }
      return {
        nodes: childResults.flatMap((r) => r.nodes),
        edges,
        entries: childResults[0]?.entries ?? [],
        exits: childResults.at(-1)?.exits ?? [],
        maxRow: Math.max(row, ...childResults.map((r) => r.maxRow)),
        rootKind: 'sequence',
      };
    }

    throw new Error(`Unsupported workflow node type in recorder layout: ${node.type}`);
  }

  const result = walk(root, 0);
  assignColumns(nodes);
  return { ...result, nodes, edges };
}

function firstExecutableChild(node: WorkflowNode): WorkflowNode | null {
  if (node.type === 'task' || node.type === 'parallel') return node;
  if (node.type === 'sequence') return node.children[0] ? firstExecutableChild(node.children[0]) : null;
  return null;
}

function assignColumns(nodes: LayoutTask[]) {
  const rows = new Map<number, LayoutTask[]>();
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

function taskY(row: number) {
  return FIRST_TASK_Y + row * TASK_ROW_STEP;
}

function uniqueSlug(value: string, used: Set<string>) {
  const base =
    value
      .toLowerCase()
      .replace(/\.md\b/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'task';
  let next = base;
  let i = 2;
  while (used.has(next)) {
    next = `${base}-${i}`;
    i += 1;
  }
  used.add(next);
  return next;
}

function updateRunIndex(runsDir: string, indexPath: string, run: RunJson) {
  mkdirSync(runsDir, { recursive: true });
  const index = loadRunIndex(runsDir, indexPath);
  const entry: RunIndex['runs'][number] = {
    id: run.id,
    goal: run.goal,
    path: run.path,
    started: run.started,
    status: run.status,
    ...(run.forkedFrom === undefined ? {} : { forkedFrom: run.forkedFrom }),
  };
  const withoutCurrent = index.runs.filter((item) => item.id !== run.id);
  const runs = [entry, ...withoutCurrent].sort((a, b) => Date.parse(b.started) - Date.parse(a.started));
  writeFileSync(indexPath, `${JSON.stringify({ runs }, null, 2)}\n`);
}

function loadRunIndex(runsDir: string, indexPath: string): RunIndex {
  if (existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as RunIndex;
      if (Array.isArray(parsed.runs)) return parsed;
    } catch {
      // Fall through to rebuilding from run.json files.
    }
  }
  return rebuildRunIndex(runsDir);
}

function rebuildRunIndex(runsDir: string): RunIndex {
  if (!existsSync(runsDir)) return { runs: [] };
  const runs = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(runsDir, entry.name, 'run.json'))
    .filter((path) => existsSync(path))
    .flatMap((path) => {
      try {
        const run = JSON.parse(readFileSync(path, 'utf8')) as RunJson;
        return [
          {
            id: run.id,
            goal: run.goal,
            path: run.path,
            started: run.started,
            status: run.status,
            ...(run.forkedFrom === undefined ? {} : { forkedFrom: run.forkedFrom }),
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => Date.parse(b.started) - Date.parse(a.started));
  return { runs };
}

function pushTimeline(node: RenderNode, event: Omit<TimelineEvent, 'ts'>, ts: string) {
  node.timeline.push({ ts: ts.slice(11, 19), ...event });
}

function timeOnly(date: Date) {
  return date.toISOString().slice(11, 19);
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function safeArtifactName(nodeId: string) {
  return (
    nodeId
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'output'
  );
}

function previewText(text: string) {
  return truncate(text.replace(/\s+/g, ' ').trim(), 120);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`;
}
