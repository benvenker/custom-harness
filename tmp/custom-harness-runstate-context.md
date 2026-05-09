# Code Context

## Files Retrieved
1. `src/server.ts` (lines 165-193) - `/api/smithers-runs` launch path; starts `runSmithersWorkflow` in background and returns `202 running`.
2. `src/server.ts` (lines 302-313) - background launch helpers for legacy and Smithers runs.
3. `src/server.ts` (lines 404-466) - project workflow graph render endpoint; returns a render-only graph from a Smithers `GraphSnapshot`.
4. `src/server.ts` (lines 490-520, 543-611) - project workflow run endpoint; currently usually calls detached Smithers CLI, not CustomHarness run artifacts.
5. `src/server.ts` (lines 646-676, 706-743) - static file serving and server CLI args (`--project`, `--workflow`, `--runs-dir`).
6. `src/app/runSmithersWorkflow.ts` (lines 35-113) - CustomHarness Smithers workflow runner; writes `runs/<id>` artifacts and records Smithers progress.
7. `src/app/runSmithersWorkflow.ts` (lines 115-155, 165-232) - render snapshot helper and workflow override/agent fallback patching.
8. `src/app/renderWorkflowGraph.ts` (lines 24-72) - render-only CLI/app path that writes run artifacts but does not execute tasks.
9. `src/runs/recorder.ts` (lines 111-170) - run recorder initialization, `run.json`, `index.json`, artifact paths.
10. `src/runs/recorder.ts` (lines 182-234, 242-289, 292-350, 398-420) - event-to-graph status updates, Smithers snapshot writes, finish behavior.
11. `src/runs/recorder.ts` (lines 555-567, 715-728) - preserves runtime node state when graph snapshot is refreshed; updates run index.
12. `src/runs/smithersGraph.ts` (lines 13-65, 102-157, 160-206, 329-337) - render graph types and Smithers `GraphSnapshot` mapper.
13. `src/workflows/outcomeWorkflow.tsx` (lines 342-374, 392-407) - Smithers progress event adapter used by both planner-run and exported-workflow paths.
14. `web/index.html` (lines 1289-1319, 1336-1459) - browser state and graph/node render functions.
15. `web/index.html` (lines 1780-1968) - inspector rendering; project preview explicitly says it is not live run state.
16. `web/index.html` (lines 2124-2181, 2212-2364) - status UI, polling, `runs/index.json`, `plan.json`, `run.json`, `events.jsonl` loading.
17. `web/index.html` (lines 2394-2476, 2568-2603, 2658-2676) - run launch UI for goal runs, project workflow runs, fresh Smithers runs, and project graph preview refresh.
18. `runs/index.json` (lines 1-20) - current legacy CustomHarness run index, only two failed harness runs.
19. `runs/3fa17c09-76c1-4299-aad3-94d16d0bdc71/run.json` (lines 1-19) and `events.jsonl` (lines 1-8) - current failed legacy run artifact shape.
20. `runs/3fa17c09-76c1-4299-aad3-94d16d0bdc71/smithers/executions/stream.ndjson` (lines 1-19) - raw Smithers event stream for a CustomHarness run.
21. `.smithers/executions/stream.ndjson` (lines 1-33) - raw Smithers project-run stream containing run/node state for detached project runs.
22. `.harness/smithers/executions/stream.ndjson` (lines 1-120) - older CustomHarness/Smithers stream artifact with very verbose token-by-token `NodeOutput` events.
23. `tests/runSmithersWorkflow.test.ts` (lines 17-51, 170-199) - verifies `runSmithersWorkflow` creates UI-compatible artifacts and fallback agent output.
24. `tests/workflowViewer.run.integration.test.ts` (lines 39-62) - verifies project workflow runs currently do **not** create `runs/` artifacts.
25. `tests/workflowViewer.graph.test.ts` (lines 105-143) - verifies project graph endpoint renders without legacy run artifacts.

## Key Code

### Smithers launch paths

`src/server.ts` has two distinct Smithers-related launch paths:

```ts
// /api/smithers-runs
launchSmithersRun(args.runSmithersWorkflow, {
  workflowPath: body.workflowPath,
  input: body.input,
  goal: typeof body.goal === 'string' && body.goal.trim() ? body.goal : undefined,
  context: typeof body.context === 'string' ? body.context : undefined,
  ...(promptOverrides === undefined ? {} : { promptOverrides }),
  runId,
  runsDir: args.runsDir,
});
return json({ ok: true, runId, status: 'running', path: 'workflow' }, 202);
```
`src/server.ts` lines 178-193.

This path uses `runSmithersWorkflow` and therefore writes CustomHarness-compatible `runs/<runId>/run.json`, `plan.json`, `events.jsonl`, artifacts, and `runs/index.json`.

```ts
// /api/workflows/:id/run default path
const proc = Bun.spawn([
  'bun',
  'node_modules/.bin/smithers',
  'workflow',
  'run',
  options.workflowId,
  '--input', JSON.stringify(options.input),
  '--detach',
  '--format', 'json',
  '--root', '.',
  '--log-dir', '.smithers/executions',
], { cwd: options.projectRoot, stdout: 'pipe', stderr: 'pipe' });
```
`src/server.ts` lines 553-570.

This project-mode path returns a Smithers run id/status, but it does **not** create `runs/<id>` viewer artifacts. The integration test asserts `existsSync(join(projectRoot, 'runs'))` is false (`tests/workflowViewer.run.integration.test.ts` lines 51-56).

There is one exception: if `promptOverrides` are passed to `/api/workflows/:id/run`, `runProjectWorkflow` calls `runSmithersWorkflow` directly (`src/server.ts` lines 548-552). That means edited project runs already use viewer-compatible artifacts, but normal project `Start Full Run` does not.

### Graph render path

Project graph preview is render-only:

```ts
const snapshot = await args.renderProjectWorkflowGraph({ ... });
const graph = smithersSnapshotToRenderGraph({
  snapshot,
  goal: projectInputPrompt(input) || `No initial workflow prompt yet.`,
  path: 'workflow',
  reason: 'Rendered Smithers workflow graph without executing tasks.',
  runId: snapshot.runId,
  planningLatencyMs: null,
  tokens: null,
  submittedAt: new Date(),
});
applyProjectWorkflowInputNode(graph, workflow.id, input);
return json({ ok: true, workflowId: workflow.id, workflowPath: workflow.path, graph });
```
`src/server.ts` lines 421-442.

The mapper initializes task nodes as idle except planner nodes:

```ts
status: id === 'plan' ? 'done' : 'idle',
timeline: [],
smithers: { kind: 'task', tag: element.tag, props: element.props, nodeId: id, ... }
```
`src/runs/smithersGraph.ts` lines 178-206.

### CustomHarness run recorder already supports live-ish UI state

`runSmithersWorkflow` writes an initial graph snapshot before executing, then records progress events, then writes a final graph snapshot:

```ts
const frame = await renderSnapshot(...);
recorder.writeSmithersPlanSnapshot(frame, { reason: 'Rerun exported Smithers workflow.', workflowPath, input, ... });

const result = await runtime.runPromise(
  runtime.runWorkflow(workflow as never, {
    input,
    runId,
    resume: false,
    rootDir,
    logDir,
    workflowPath,
    onProgress: (event: unknown) => emitSmithersEvent({ event, recorder, plan: null }),
  }),
);

const finalFrame = await renderSnapshot(...);
recorder.writeSmithersGraphSnapshot(finalFrame);
```
`src/app/runSmithersWorkflow.ts` lines 72-104.

`emitSmithersEvent` maps key Smithers runtime events into CustomHarness recorder events:

```ts
if (event.type === 'NodeStarted' && nodeId) {
  recorder.event('agent.init', ...);
  recorder.event('task.started', ...);
  recorder.event('task.checkpoint', { checkpoint: 'started' });
} else if (event.type === 'NodeFinished' && nodeId) {
  recorder.flushAgentOutput(nodeId);
  recorder.event('task.done', ...);
} else if (event.type === 'NodeFailed') {
  recorder.event('run.error', { nodeId, message: `Smithers node failed: ${nodeId ?? 'unknown'}` });
} else if (event.type === 'NodeOutput' && nodeId && typeof event.text === 'string') {
  recorder.appendAgentOutput(nodeId, event.text);
}
```
`src/workflows/outcomeWorkflow.tsx` lines 351-372.

Recorder events update node status/timeline and persist `plan.json` on each event (`src/runs/recorder.ts` lines 182-234, 242-255). This is the bridge the web UI already consumes.

Important limitation: `NodeOutput` only buffers text; output artifacts are flushed on `NodeFinished` or run finish, not continuously. So live output text does not show until task finish unless this changes.

### Web UI current run feedback

The viewer reads static run artifacts, not Smithers execution state directly:

```js
const [planResp, runResp, eventsResp] = await Promise.all([
  fetch(`/runs/${encodeURIComponent(runId)}/plan.json`, { cache: "no-store" }),
  fetch(`/runs/${encodeURIComponent(runId)}/run.json`,  { cache: "no-store" }),
  fetch(`/runs/${encodeURIComponent(runId)}/events.jsonl`, { cache: "no-store" }),
]);
...
SAMPLES._live = graph;
loadSample("_live");
scheduleRunRefresh(runId, runMeta.status);
```
`web/index.html` lines 2273-2342.

Polling is every 3 seconds while `run.json.status === "running"`:

```js
if (status !== "running") return;
runRefreshTimer = setTimeout(() => {
  if (currentRunId !== runId) return;
  const ta = inspector.querySelector("#promptEditArea");
  if (ta && document.activeElement === ta) {
    scheduleRunRefresh(runId, status);
    return;
  }
  loadRun(runId, { silent: true, preserveStatus: true });
}, 3000);
```
`web/index.html` lines 2166-2181.

Project mode loads a preview graph and empties the runs picker:

```js
projectModeAvailable = true;
currentProject = { ...project, workflows: workflows.workflows ?? [] };
currentWorkflowId = selected;
currentWorkflowGraph = graphResponse.graph;
SAMPLES._project = graphResponse.graph;
loadSample("_project");
...
runsBar.classList.add("empty");
runsSelect.innerHTML = "";
```
`web/index.html` lines 2589-2602.

When `Start Full Run` is clicked in project mode, the UI posts to `/api/workflows/:id/run` and only mutates the preview graph run id/status; it does **not** call `waitForRunToRender` or load a live run:

```js
const result = await postJson(`/api/workflows/${encodeURIComponent(currentWorkflowId)}/run`, { input });
setRunActionStatus(`Started ${shortId(result.runId)} · ${result.status}`, runStatusKind(result.status));
runIdEl.textContent = result.runId;
if (currentWorkflowGraph) {
  currentWorkflowGraph.runId = result.runId;
  currentWorkflowGraph.runStatus = result.status;
  SAMPLES._project = currentWorkflowGraph;
  loadSample("_project");
}
```
`web/index.html` lines 2420-2431.

The project inspector text says the current graph is not live state:

```html
This preview is not live run state.
```
`web/index.html` lines 1846-1851.

### Legacy/current run artifacts

Current `runs/index.json` contains two failed harness runs only (`runs/index.json` lines 1-20). One example run has `status: "failed"`, `path: "harness"`, and no completed plan (`runs/3fa17c09-.../run.json` lines 1-19). Its `events.jsonl` records planner start/failure and final agent output (`runs/3fa17c09-.../events.jsonl` lines 1-8).

There are also raw Smithers streams:
- CustomHarness run stream: `runs/3fa17c09-.../smithers/executions/stream.ndjson` lines 1-19 includes `RunStarted`, `NodePending`, `FrameCommitted`, `SnapshotCaptured`, `NodeStarted`, `NodeOutput`, `AgentEvent`, `TaskHeartbeat`, `NodeFailed`, `RunFailed`.
- Project detached stream: `.smithers/executions/stream.ndjson` lines 1-33 includes multiple `run-*` ids and node state for `plan-fanout`, including `NodePending`, `NodeStarted`, `NodeFinished`, `NodeFailed`, `RunFailed`.

## Architecture

There are three related but different concepts currently sharing the viewer:

1. **Legacy/planner CustomHarness runs** (`POST /api/runs`)
   - `server.ts` launches `runOutcome` in background.
   - `runOutcome` builds an internal Smithers workflow and uses `createRunRecorder`.
   - Recorder writes `runs/<runId>/run.json`, `plan.json`, `events.jsonl`, `artifacts/*`, `smithers/executions/stream.ndjson`.
   - Web UI can load and poll these via `/runs/...` static files.

2. **Exported Smithers workflow runs** (`POST /api/smithers-runs`, reruns of Smithers graph exports, or project runs with prompt overrides)
   - `server.ts` launches `runSmithersWorkflow` in background.
   - `runSmithersWorkflow` renders an initial `GraphSnapshot`, writes `plan.json`, executes the workflow with `onProgress`, maps progress events through `emitSmithersEvent`, then writes a final snapshot.
   - Web UI can load/poll these because they use the same `runs/<runId>` artifact contract.

3. **Project workflow preview + detached Smithers run** (`--project`, `/api/workflows/:id/graph`, `/api/workflows/:id/run`)
   - Preview graph endpoint renders a `GraphSnapshot` and returns JSON directly; no `runs/` artifacts.
   - Normal project run endpoint shells out to `smithers workflow run --detach --log-dir .smithers/executions`; no CustomHarness run recorder, no `runs/index.json`, no `plan.json` for the viewer.
   - UI stays in `_project` preview mode and only displays the returned run id/status string.

To show live Smithers run state in the viewer, the key mismatch is #3: project Smithers execution state is in Smithers' `.smithers/executions` stream/log/db world, while the viewer only understands CustomHarness `runs/<id>` artifacts.

## Likely Files To Change

1. `src/server.ts`
   - Most likely change point.
   - Minimal path: make `runProjectWorkflow` use `runSmithersWorkflow` for all project workflow runs (not just prompt override runs), and ensure it passes `runsDir` and runs with the correct project cwd/root semantics.
   - Alternatively add a project live-run endpoint that creates/updates CustomHarness run artifacts from detached Smithers streams, but that is a larger bridge.

2. `web/index.html`
   - In `runWorkflowFresh()` project branch, after `/api/workflows/:id/run`, call `waitForRunToRender(result.runId)` and switch into `_live` mode if the server now creates `runs/<id>` artifacts.
   - Decide how project mode and live mode coexist: current `projectModeAvailable` disables `Plan & Run`/`Rerun Selected` and empties run picker.
   - Consider adding status copy like `Started … · opening live run...` and a fallback if artifacts are not ready.

3. `src/app/runSmithersWorkflow.ts`
   - Ensure project workflow runs execute with `process.cwd()` set to `projectRoot`, or add `projectRoot/rootDir` option. Current helper resolves `workflowPath` against `process.cwd()` and infers `rootDir` from `.smithers` path; server's direct call from project mode would need to preserve this.
   - If live output is required during a running task, add periodic/streaming flush behavior for `NodeOutput` rather than waiting for `NodeFinished`.

4. `src/runs/recorder.ts`
   - Existing event-to-plan persistence is usable.
   - Potential changes: handle more Smithers events (`NodePending`, `TaskHeartbeat`, `TokenUsageReported`, `RunStarted`, `RunFailed`, `FrameCommitted`) and/or write a lightweight `runtime.json` if UI needs run-level status richer than `run.json.status`.
   - If streaming output is wanted, add append/update artifact behavior during `NodeOutput`.

5. `src/workflows/outcomeWorkflow.tsx`
   - `emitSmithersEvent` is the adapter to extend for richer live state.
   - Currently ignores pending/heartbeat/token events and AgentEvent note/message updates except CLI action kinds and completed answers.

6. `src/runs/smithersGraph.ts`
   - Likely unchanged for minimal slice.
   - Change only if live state needs to display Smithers-specific statuses beyond `idle/running/done/failed`, attempts, iterations, or branch/frame evolution.

7. Tests likely to update/add:
   - `tests/workflowViewer.run.integration.test.ts` currently asserts no `runs/` artifacts for project runs; this will change if project runs become viewer-compatible.
   - `tests/workflowViewer.run.test.ts` should assert `runsDir`/live-run behavior is forwarded.
   - `tests/runSmithersWorkflow.test.ts` can cover `projectRoot/rootDir` if added.
   - `tests/workflowViewer.ui.test.ts` may need UI expectation updates if project Start Full Run auto-switches to live run.

## Current Behavior Summary

- The viewer can already show live-ish state for runs that are written to `runs/<id>` by `createRunRecorder`.
- Polling is artifact-based (`plan.json`, `run.json`, `events.jsonl`), not SSE/websocket.
- `runSmithersWorkflow` already creates those artifacts and updates node status/timeline during the run.
- Project workflow preview is render-only and explicitly not live state.
- Project `Start Full Run` currently launches Smithers in detached CLI mode, writes under `.smithers/executions`, and leaves the UI on the preview graph with only run id/status feedback.
- Current repo `runs/` artifacts are legacy failed harness examples, not useful live project workflow examples.

## Risks / Open Questions

- **Root/cwd correctness:** `runSmithersWorkflow` uses `process.cwd()` to resolve workflow path and `inferSmithersRootDir()` for Smithers root. Project runs via server may need a `projectRoot` option or `withCwd(projectRoot, ...)` wrapper.
- **Detached vs managed execution:** Switching project runs from detached Smithers CLI to in-process `runSmithersWorkflow` changes semantics. It may keep the HTTP background task alive in the server process and may not behave like `smithers workflow run --detach`.
- **Run id shape:** Detached Smithers CLI returns ids like `run-*`; `runSmithersWorkflow` currently uses UUID unless provided. UI supports both, but tests may assert `run[-_]` for project runs.
- **Output streaming:** Current live UI will show node status/timeline during a task, but task output artifacts are flushed at finish. `.harness/smithers/executions/stream.ndjson` shows token-level `NodeOutput`; mapping all of that directly to UI could be noisy and large.
- **Intermediate graph frames:** Dynamic workflows may commit new frames during execution. Current CustomHarness graph is initial snapshot + final snapshot; `FrameCommitted`/`SnapshotCaptured` progress events are ignored because they do not include the full snapshot.
- **Index visibility:** The runs dropdown reads `/runs/index.json` from the harness server root/runsDir. If project root differs from harness root, decide whether live project runs should write to harness `runsDir`, project `runsDir`, or both.
- **Back compat tests:** Several workflow viewer tests intentionally verify no legacy artifacts for preview/run paths. Those assertions reflect current design and will need deliberate updates if live run state becomes first-class.

## Minimal Next Slice Recommendation

Do the smallest artifact-bridge slice, not a full Smithers DB/stream viewer:

1. Change project `Start Full Run` server path to produce CustomHarness artifacts by using `runSmithersWorkflow` for normal `/api/workflows/:id/run` as well as override runs.
   - Add/pass `runsDir` into `runProjectWorkflow` options.
   - Run it in the project root context or add `projectRoot/rootDir` to `RunSmithersWorkflowOptions`.
2. Change `web/index.html` project branch in `runWorkflowFresh()` to call `waitForRunToRender(result.runId)` and auto-switch to `_live` once `plan.json` exists.
3. Keep the existing 3s polling. It is enough to show live node running/done/failed status from recorder events.
4. Defer richer Smithers stream support (heartbeats, token usage, incremental output, dynamic frame updates) until after live artifact-backed project runs work end-to-end.

## Start Here

Start with `src/server.ts` around `workflowRunResponse` and `runProjectWorkflow` (lines 490-611). That is where project runs currently bypass CustomHarness artifacts. Then update `web/index.html` `runWorkflowFresh()` project branch (lines 2415-2436) to load the newly-created `runs/<id>` artifacts instead of staying on the preview graph.

## Supervisor coordination

Not needed; no blocking decision requested during scouting.
