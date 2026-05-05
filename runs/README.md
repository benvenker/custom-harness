# Runs data contract

This directory prototypes the archival format for `custom-harness` runs. The UI in `web/index.html` currently renders hardcoded `SAMPLES`; this contract keeps real runs transformable into that same shape without treating the UI mock as the source of truth.

## Produced examples

- `4d780b55-bb8e-44db-9c81-d9e42fda6861/` — current native workflow-path audit run.
- `7862e9b3-52f2-46a6-86a9-04bf5519c30b/` — current native workflow-path checks run.
- `version-2026-05-05T16-53Z/` — harness-path version-flag run.
- `screenshots/` — MCPorter Playwright screenshots of the current UI samples.
- `reference/samples.json` — the hardcoded `SAMPLES` object dumped from the page for comparison.
- `logs/` — raw CLI captures from local runs.

The current workflow runs are real CLI invocations with native `src/index.ts` recorder output and Smithers `onProgress` task lifecycle events. The harness run is a real CLI invocation and reached the Flue worker; the worker edited `src/index.ts` during capture, and that source change was reverted after capture to keep the recorder implementation intact.

## Directory layout

```text
runs/
  <run-id>/
    run.json
    plan.json
    events.jsonl
    artifacts/
      cli.log
  screenshots/
  reference/
  logs/
```

A completed native run should write only inside `runs/<run-id>/` during execution. `screenshots/`, `reference/`, and `logs/` are investigation artifacts from this prototype pass.

## `run.json`

`run.json` is the run index. It should be enough to list runs without loading the plan or event stream.

```ts
type RunJson = {
  id: string;
  goal: string;
  path: "harness" | "workflow";
  model: string;
  started: string;       // ISO 8601
  ended: string | null;  // ISO 8601 when finished
  status: "running" | "succeeded" | "failed" | "cancelled" | string;
  totals: {
    latencyMs: number | null;
    tokens: number | null;
  };
  plan: {
    reason: string;
  };
  sources?: {
    stdout?: string;
  };
  notes?: string;
};
```

Current examples use `null` for latency and tokens because the CLI does not expose reliable totals yet.

## `plan.json`

`plan.json` stores both the planner output and a UI-ready graph.

```ts
type PlanJson = {
  raw: PlannerOutput;
  graph: RenderGraph;
  layout: {
    persisted: boolean;
    coordinateSystem: string;
    nodeWidth: number;
  };
};

type PlannerOutput =
  | { path: "harness"; reason: string }
  | { path: "workflow"; reason: string; workflow: Workflow };

type Workflow = {
  name: string;
  description: string;
  root: WorkflowNode;
};

type WorkflowNode =
  | { type: "task"; name: string; prompt: string }
  | { type: "sequence" | "parallel"; name?: string; children: WorkflowNode[] };
```

`WorkflowNode` is intentionally narrowed to what `src/index.ts` can currently ask the planner to emit and what `src/workflow/runner.ts` can build. `src/types.ts` also includes `branch` and `loop`, but those nodes are not supported by the dynamic Smithers builder yet.

### Layout recommendation

Persist the layout in `plan.json` after planning. The UI is a replay surface, not a layout engine. Persisting `x` and `y` means screenshots and inspector links remain stable across browsers and future renderer tweaks. A renderer can still recompute layout if `layout.persisted === false`, but native runs should write persisted graph coordinates.

## UI render graph

The `graph` object intentionally mirrors the current `SAMPLES` shape.

```ts
type RenderGraph = {
  goal: string;
  path: "harness" | "workflow";
  reason: string;
  latency: string;
  tokens: string;
  runId: string;
  title: string;
  nodes: RenderNode[];
  edges: RenderEdge[];
  defaultSelected: string;
};

type RenderNode = {
  id: string;
  type: "goal" | "planner" | "task" | "harness-worker";
  title: string;
  x: number;
  y: number;
  agent: string;
  prompt: string;
  tools: string[];
  status: "idle" | "running" | "done" | "failed" | string;
  duration?: string;
  decision?: "harness" | "workflow";
  timeline: TimelineEvent[];
};

type TimelineEvent = {
  ts: string;
  tool?: string;
  arg?: string;
  what?: string;
};

type RenderEdge = {
  from: string;
  to: string;
  label?: string;
};
```

## `events.jsonl`

`events.jsonl` is the replay log: one JSON object per line, wall-clock ordered. Every event has common fields:

```ts
type BaseEvent = {
  ts: string;       // ISO 8601
  type: string;     // dotted event name
  runId: string;
  nodeId?: string;
  synthesized?: boolean;
};
```

Use `synthesized: true` when an event was inferred from stdout or plan state rather than emitted natively by the runtime. This matters. The current CLI is chatty but not structured, so most prototype events are synthesized except direct Flue `tool:*` lines and the Smithers error line.

Recommended event names:

```ts
type RunEvent =
  | { type: "run.started"; goal: string }
  | { type: "plan.decision"; path: "harness" | "workflow"; reason: string; rawPlan: PlannerOutput }
  | { type: "agent.init"; nodeId: string; model: string }
  | { type: `tool.${string}`; nodeId: string; arg?: string }
  | { type: `tool.${string}.done`; nodeId: string; arg?: string }
  | { type: `tool.${string}.error`; nodeId: string; arg?: string }
  | { type: "agent.output"; nodeId: string; artifact?: string; text?: string }
  | { type: "task.checkpoint"; nodeId: string; checkpoint?: string }
  | { type: "task.done"; nodeId: string; output?: unknown }
  | { type: "run.error"; message: string; source?: string }
  | { type: "run.done"; status: string };
```

## Transforming a run into the current UI shape

The UI can initially consume `plan.json.graph` directly:

```js
async function loadRun(runId) {
  const plan = await fetch(`/runs/${runId}/plan.json`).then(r => r.json());
  return plan.graph;
}
```

If native runs eventually store only `raw` plus `events.jsonl`, the adapter can derive the same graph:

```js
function toSample(run, plan, events) {
  const graph = plan.graph ?? layoutPlannerOutput(plan.raw);

  for (const ev of events) {
    if (!ev.nodeId) continue;
    const node = graph.nodes.find(n => n.id === ev.nodeId);
    if (!node) continue;

    if (ev.type === "agent.init") {
      node.timeline.push({ ts: ev.ts, tool: "agent.init", arg: ev.model });
    } else if (ev.type.startsWith("tool.")) {
      node.timeline.push({ ts: ev.ts, tool: ev.type.replace(/^tool\./, ""), arg: ev.arg });
    } else if (ev.type === "agent.output") {
      node.timeline.push({ ts: ev.ts, what: ev.text ?? `output → ${ev.artifact}` });
    } else if (ev.type === "task.done") {
      node.status = "done";
      node.timeline.push({ ts: ev.ts, what: "task done" });
    }
  }

  graph.goal = run.goal;
  graph.path = run.path;
  graph.reason = run.plan.reason;
  graph.runId = run.id;
  graph.latency = run.totals.latencyMs == null ? "unknown" : `${run.totals.latencyMs}ms`;
  graph.tokens = run.totals.tokens == null ? "unknown" : String(run.totals.tokens);
  return graph;
}
```

## Minimum native emitter changes

Do not bolt this onto the UI first. Add a tiny run recorder around the existing CLI paths.

### `src/index.ts`

Recommended changes:

1. Create a run id before planning.
2. Create `runs/<runId>/artifacts/`.
3. Write `run.json` immediately with `status: "running"`.
4. Around `plan(goal, context)`, time the call and write:
   - `plan.json.raw`
   - `events.jsonl`: `run.started`, `plan.decision`
5. Pass `{ runId, recorder }` into `runHarness` or `runWorkflow`.
6. On success or failure, update `run.json.ended`, `status`, and totals.

Pseudo-code:

```ts
const runId = crypto.randomUUID();
const recorder = createRunRecorder(runId, { goal });
recorder.event("run.started", { goal });

const started = performance.now();
const result = await plan(goal, context ?? undefined);
recorder.writePlan(result);
recorder.event("plan.decision", { path: result.path, reason: result.reason, rawPlan: result });

try {
  if (result.path === "harness") await runHarness(goal, context, recorder);
  else await runWorkflow(goal, result.workflow, recorder);
  recorder.finish("succeeded");
} catch (err) {
  recorder.event("run.error", { message: String(err) });
  recorder.finish("failed");
  throw err;
}
```

### `src/workflow/runner.ts`

Recommended changes:

1. Use `createSmithers(schemas, { dbPath })` as now.
2. Use `createSmithers(...).outputs[name]` or string output keys instead of reusing one raw Zod object for every task. This blocks all workflow E2E runs today.
3. Build the graph from the planner tree before execution and persist it in `plan.json.graph`.
4. Pass `onProgress` to `runWorkflow` and translate Smithers progress into JSONL events when available.
5. Emit `task.checkpoint`, `task.done`, `agent.output`, and `run.error` from the runner boundary when Smithers does not expose finer-grained task events.

### `.flue/agents/worker.ts` / harness path

Native Flue emits human-readable `[flue] tool:start` lines to stdout today. For reliable replay, prefer one of these:

1. Wrap the child process stdout/stderr in `runHarness()` and parse the stable `[flue] tool:start|done|error` prefix into JSONL events.
2. Better: if Flue exposes an event callback for session tool events, register it inside `.flue/agents/worker.ts` and write structured events from there.

The first option is less invasive and enough for the prototype. The second option is cleaner if Flue's event API is stable.

## UI adapter changes

`web/index.html` can keep its rendering functions. Replace the hardcoded sample lookup with a loader:

```js
async function loadRunGraph(runId) {
  const plan = await fetch(`/runs/${runId}/plan.json`).then(r => r.json());
  return plan.graph;
}
```

Then either:

- keep `SAMPLES` for demos and add a `RUNS` list loaded from `runs/index.json`, or
- replace sample buttons with run buttons generated from `runs/index.json`.

The current renderer requires these fields to be present on every graph node: `id`, `type`, `title`, `x`, `y`, `agent`, `prompt`, `tools`, `status`, and `timeline`. Missing any of those produces blank inspector sections or visually broken cards.

## What was real, synthesized, and blocked

Real:

- UI screenshots were captured with MCPorter Playwright from `http://localhost:4321/`.
- `reference/samples.json` was dumped from the live page.
- CLI stdout/stderr was captured for the audit, checks, and version-flag goals.
- The harness run reached Flue and emitted real `[flue] tool:*` lines.

Synthesized:

- `plan.json.graph` coordinates and node ids were derived to match the current UI contract.
- Earlier prototype `events.jsonl` entries were mostly synthesized because `src/index.ts` did not emit native structured events.
- Earlier workflow task events were synthesized because the Smithers workflow failed before task execution.

Blocked:

- Earlier workflow E2E was blocked by the shared-Zod-output Smithers error; native runs now use fresh schemas and `createSmithers(...).outputs`.
- Accurate tokens are blocked until the planner and runtime expose totals.
- Finer-grained Smithers tool replay remains limited by the current `OpenAIAgent`/Smithers event surface.


## Implementation status

Native recording is now wired into `src/index.ts`, `src/workflow/runner.ts`, and the Flue harness boundary. New CLI runs create `runs/<runId>/run.json`, `plan.json`, `events.jsonl`, `artifacts/cli.log`, and update `runs/index.json`. Smithers workflow events are translated from `onProgress` (`NodeStarted`, `NodeFinished`, `NodeOutput`, `AgentEvent`) into `agent.init`, `task.checkpoint`, buffered `agent.output`, and `task.done`; streamed `NodeOutput` chunks are accumulated per task, written to `artifacts/<node-id>.txt`, and emitted as a single `agent.output` event with `artifact`, `bytes`, and `preview`. Flue `[flue] tool:start|done|error` lines are parsed into `tool.*` events while raw output is still forwarded to the terminal and saved to `artifacts/cli.log`. Planner token usage from the AI SDK is now stored on `plan.decision` and surfaced in `run.json.totals.tokens` / `plan.json.graph.tokens` when provided by the model. The UI graph is still synthesized from planner output, but it is now persisted natively at plan time and updated by native runtime events. A current limitation/deviation is that Smithers `OpenAIAgent` runs do not execute repository tools, so workflow task outputs can be semantically shallow even though the Smithers task lifecycle events are real.
