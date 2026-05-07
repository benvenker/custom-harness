# Live Smithers run inspection plan

## Goal

Add truthful **live Smithers run inspection** to CustomHarness project mode.

After a user starts a workflow from the project workflow viewer, the UI should stop pretending that the preview graph is live state. It should inspect the real Smithers run from the project's `smithers.db`, then overlay Smithers node, attempt, event, frame, and output state onto the existing visual graph projection.

This plan is intentionally narrow. It does not add workflow editing, source patching, replay/fork UI, or a new run database.

## Scope guardrails

### In scope

- A read-only `SmithersRunReader` for project-mode Smithers SQLite inspection.
- DB-backed project-mode run endpoints:
  - `GET /api/smithers/runs`
  - `GET /api/smithers/runs/:runId`
  - `GET /api/smithers/runs/:runId/events`
- A project-mode Start Full Run transition from preview mode to live run-inspection mode.
- Status, attempt, event, frame, and output overlays on the existing `RenderGraph` cards/inspector.
- Focused TDD tests proving project-mode run truth comes from Smithers SQLite, not legacy `runs/` JSON.

### Out of scope

- No CustomHarness run DB.
- No new persistent workflow IR.
- No manual mutation of `_smithers_*` tables or workflow output tables.
- No deletion of legacy `runs/` compatibility paths in this slice.
- No Smithers fork/replay UI.
- No historical frame-to-rich-graph reconstruction beyond the overlay needed for the live run view.
- No workflow source editing beyond rejecting project-mode ad-hoc prompt overrides.

## 1. Architecture summary

Project-mode run flow after this change:

```txt
Start Full Run
  → POST /api/workflows/:id/run
  → Smithers runtime/CLI creates real run state in smithers.db
  → response includes { runId, inspection.url }
  → UI switches from preview mode to run-inspection mode
  → UI polls /api/smithers/runs/:runId
  → server reads Smithers SQLite through SmithersRunReader
  → graph cards remain a visual projection of GraphSnapshot
  → DB node/attempt/event/output state is overlaid onto those cards
```

Authoritative state:

- **Run identity/status:** Smithers SQLite `_smithers_runs`
- **Node status:** `_smithers_nodes`
- **Attempts/errors:** `_smithers_attempts` plus `_smithers_runs.error_json`
- **Timeline:** `_smithers_events`
- **Frames:** `_smithers_frames`
- **Outputs:** workflow output tables referenced by `_smithers_nodes.output_table`

Non-authoritative compatibility artifacts:

- `runs/index.json`
- `runs/<runId>/plan.json`
- `runs/<runId>/run.json`
- `runs/<runId>/events.jsonl`
- project-mode preview graph status fields such as `currentWorkflowGraph.runStatus`

Project-mode run inspection must never use those compatibility artifacts to decide whether a Smithers run exists, what its status is, or what a node produced.

## 2. Smithers evidence and model constraints

### Project decisions

- ADR 0004 requires project-mode run inspection from Smithers SQLite and introduces `SmithersRunReader`; legacy `runs/` artifacts are not authoritative (`docs/adr/0004-project-mode-run-inspection-reads-smithers-sqlite.md`).
- ADR 0001 says canonical run state is primarily Smithers SQLite. NDJSON logs are optional observability evidence.
- ADR 0003 says CustomHarness/Studio must reflect Smithers first, not invent workflow/run semantics.

### Smithers DB/schema evidence

Smithers defines these run-state tables in `node_modules/@smithers-orchestrator/db/src/sql-message-storage.js`:

- `_smithers_runs`
- `_smithers_nodes`
- `_smithers_attempts`
- `_smithers_frames`
- `_smithers_events`

Useful Smithers adapter read APIs exist for most of the reader:

- runs: `getRun`, `listRuns`
- nodes: `listNodes`, `getNode`, `countNodesByState`
- attempts: `listAttempts`, `listAttemptsForRun`
- events: `listEventHistory`, `listEvents`
- frames: `getLastFrame`, `listFrames`
- output rows: `getRawNodeOutputForIteration`

Use these adapter APIs first. Raw SQL is acceptable only for small gaps that the adapter cannot express, and those reads must stay inside `SmithersRunReader`.

### Runtime behavior evidence

- `runWorkflow` writes input and inserts/updates `_smithers_runs`.
- Smithers persists render frames into `_smithers_frames` during execution.
- Smithers default log directory is `<rootDir>/.smithers/executions/<runId>/logs` when no explicit `logDir` is supplied.
- `stream.ndjson` logs are observability; the Smithers CLI can inspect from DB state.

### Current CustomHarness caveats to fix

Current behavior that this plan changes:

- `POST /api/workflows/:id/run` exists in `src/server.ts`, but it currently returns only `{ ok, runId, status }`.
- The project run endpoint currently accepts `promptOverrides`. If overrides are present, it routes to the legacy `runSmithersWorkflow()` path, which writes CustomHarness `runs/` artifacts. Project mode must reject this path.
- The default project run launcher currently passes `--log-dir .smithers/executions`. This likely bypasses Smithers' per-run default log dir. Remove this override unless a test proves an explicit per-run log dir is needed.
- The web project Start Full Run path currently just overlays `runId`/`runStatus` onto `currentWorkflowGraph` and reloads `_project`. It does not inspect SQLite.
- Legacy UI code still reads `/runs/index.json`, `/runs/:id/plan.json`, `/runs/:id/run.json`, and `/runs/:id/events.jsonl`; leave this for non-project compatibility only.

## 3. Read-only DB access requirements

`SmithersRunReader` must open the nearest project `smithers.db` read-only and must not run schema creation or migrations.

Do not use Smithers CLI `openSmithersDb()` as-is for the reader because it calls `ensureSmithersTables()`. That is a write-capable setup path, not a read-only inspection path.

### Read-only opener contract

Create:

```txt
src/smithersProject/sqliteReadOnly.ts
```

The helper should:

1. Resolve the DB path for the project root.
   - First version: `<projectRoot>/smithers.db`, matching Smithers' default DB when commands run from project root.
   - If Smithers config later supports custom DB paths, add that as a separate verified enhancement.
2. Fail if the DB file is missing.
3. Open with an explicit read-only flag.
   - Bun SQLite: `new Database(path, { readonly: true })`.
   - If using `better-sqlite3`: `new Database(path, { readonly: true, fileMustExist: true })`.
4. Enable defense-in-depth read-only behavior where supported:
   - `PRAGMA query_only = ON`
5. Construct the Smithers DB adapter around that connection without calling `ensureSmithersTables()`.
6. Return both the adapter and the underlying connection/close handle so `close()` releases the DB.

### Read-only tests

Tests must prove:

- Missing `smithers.db` returns a controlled error and does not create a file.
- Opening the reader does not create, alter, or migrate schema.
- `INSERT`, `CREATE TABLE`, `DROP TABLE`, and write PRAGMAs fail through the opened connection if a test seam exposes the connection.
- Table list/schema version before and after reader calls is unchanged.
- Reader calls can succeed while Smithers has WAL sidecar files present.
- The implementation does not import or call `ensureSmithersTables()`.

If current Smithers adapter APIs cannot be constructed over a read-only SQLite connection, mark that as an upstream Smithers gap and keep the reader behind a small interface so the implementation can be swapped later.

## 4. Proposed module/API map

### New files

```txt
src/smithersProject/runReader.ts
src/smithersProject/runReaderTypes.ts
src/smithersProject/sqliteReadOnly.ts
```

### Server test seam

Add a dependency-injection seam to the server options, similar to existing render/run seams:

```ts
type CreateSmithersRunReader = (projectRoot: string) => SmithersRunReader;
```

Use this in tests so endpoint behavior can be proven without depending on a real Smithers run for every server test.

### `SmithersRunReader` minimal API

```ts
type SmithersRunReader = {
  listRuns(opts?: {
    limit?: number;
    status?: string;
    workflowId?: string; // CustomHarness workflow id; map to workflowPath/name before filtering.
  }): Promise<SmithersRunSummary[]>;

  getRunDetail(runId: string, opts?: {
    eventsAfterSeq?: number;
    eventLimit?: number;
    frameLimit?: number;
    includeOutputs?: boolean;
  }): Promise<SmithersRunDetail | null>;

  listEvents(runId: string, opts?: {
    afterSeq?: number;
    limit?: number;
    nodeId?: string;
    types?: string[];
  }): Promise<{ events: SmithersRunEvent[]; nextAfterSeq: number }>;

  close(): void;
};
```

Important: Smithers `_smithers_runs` has `workflow_name` and `workflow_path`; it does **not** have a `workflow_id` column. `workflowId` in this CustomHarness API means the flat Smithers workflow id from `.smithers/workflows/<id>.tsx`. Implement filtering by resolving the workflow id to an absolute/normalized workflow path and filtering Smithers run rows by `workflowPath` or Smithers workflow name as appropriate. Do not invent or persist a workflow-id column.

### DTO returned to UI

`SmithersRunDetail` should include this first-slice shape:

```ts
type SmithersRunDetail = {
  run: {
    id: string;
    workflowName?: string;
    workflowPath?: string;
    status: string;        // raw DB status
    derivedStatus?: string; // optional Smithers-derived/computed state
    parentRunId?: string;
    createdAtMs?: number;
    startedAtMs?: number;
    finishedAtMs?: number;
    heartbeatAtMs?: number;
    error?: unknown;
  };
  nodes: Array<{
    nodeId: string;
    iteration: number;
    state: string;
    updatedAtMs?: number;
    outputTable?: string;
    label?: string;
    lastAttempt?: number;
    outputRow?: unknown;
  }>;
  attempts: Array<{
    nodeId: string;
    iteration: number;
    attempt: number;
    state: string;
    startedAtMs?: number;
    finishedAtMs?: number;
    error?: unknown;
    responseText?: string;
    cached?: boolean;
    meta?: unknown;
  }>;
  events: Array<{
    seq: number;
    timestampMs?: number;
    type: string;
    payload: unknown;
    nodeId?: string;     // derived from payload when present, not a DB column
    iteration?: number;  // derived from payload when present
    attempt?: number;    // derived from payload when present
  }>;
  frames: Array<{
    frameNo: number;
    createdAtMs?: number;
    xmlHash?: string;
    xml?: unknown;
    mountedTaskIds?: string[];
    taskIndex?: Array<{ nodeId: string; ordinal?: number; iteration?: number }>;
    note?: string;
  }>;
  cursors: {
    nextEventSeq: number;
  };
};
```

Return both normalized fields and raw Smithers details only when useful for debugging. Keep raw output rows under `outputRow` because output tables may use raw DB column names (`run_id`, `node_id`, snake_case schema fields, JSON text columns).

## 5. Table/API mapping details

### Run status

- Table: `_smithers_runs`
- Preferred APIs: `adapter.getRun(runId)`, `adapter.listRuns(limit, status)`
- Missing run: return `null` from `getRunDetail()`, and HTTP should translate that to `404`.
- `status` should expose the raw Smithers status.
- `derivedStatus` may use Smithers `computeRunStateFromRow` if available without writes.

### Node status

- Table: `_smithers_nodes`
- Preferred APIs: `adapter.listNodes(runId)`, `adapter.getNode(runId, nodeId, iteration)`, `adapter.countNodesByState(runId)`.
- The UI overlay should match nodes by `nodeId` first and `iteration` second.
- Do not infer completion from preview graph structure.

### Attempts/errors

- Table: `_smithers_attempts`
- Preferred APIs: `adapter.listAttemptsForRun(runId)` and, where needed, `adapter.listAttempts(runId, nodeId, iteration)`.
- Sort attempts deterministically by:
  1. node id
  2. iteration
  3. attempt number
  4. started timestamp
- Parse JSON-ish fields defensively. A malformed `error_json`, `meta_json`, or heartbeat payload should not crash the whole detail endpoint; include a parse error marker for that field.

### Events/timeline

- Table: `_smithers_events`
- Preferred APIs: `adapter.listEvents(runId, afterSeq, limit)` for polling and `adapter.listEventHistory(runId, query)` for node/type filtering.
- `_smithers_events` does not have node id / iteration / attempt columns. Those are derived from parsed `payload_json` when Smithers includes them.
- `nextEventSeq` should be monotonic: if events were returned, `max(seq)`; otherwise keep the requested `afterSeq`.
- NDJSON logs may enrich a later UI, but DB event history is the first-slice truth.

### Frames

- Table: `_smithers_frames`
- Preferred APIs: `adapter.getLastFrame(runId)` and `adapter.listFrames(runId, limit, afterFrameNo)`.
- Use adapter APIs instead of raw SQL because Smithers may store delta frames that need inflation/reconstruction.
- Do not assume frames contain rich `TaskDescriptor` prompt/output metadata. Smithers frame task indexes are shallow (`nodeId`, ordinal, iteration). First version should expose frame rows and overlay DB state on the current preview/run-context graph.
- Historical exact graph reconstruction from frame XML/task descriptors is deferred.

### Output rows

- Tables: workflow output tables named by `_smithers_nodes.output_table`.
- Preferred first-slice API: `adapter.getRawNodeOutputForIteration(outputTable, runId, nodeId, iteration)`.
- Missing output table, missing output row, or nodes without `output_table` should be tolerated.
- Do not import workflow source solely to read outputs in the first slice.
- Keep raw output row available. Normalize only obvious wrapper columns if the UI needs it; do not silently coerce schema-specific payloads.

## 6. HTTP endpoints

### Add: `GET /api/smithers/runs`

Query:

```txt
limit=50
status=<smithers-status>
workflowId=<custom-harness-workflow-id>
```

Response:

```json
{
  "ok": true,
  "runs": [
    {
      "id": "run-...",
      "workflowName": "code-review",
      "workflowPath": "/project/.smithers/workflows/code-review.tsx",
      "status": "running",
      "derivedStatus": "running",
      "createdAtMs": 123,
      "startedAtMs": 124,
      "finishedAtMs": null,
      "heartbeatAtMs": 125
    }
  ]
}
```

Acceptance:

- Backed by `SmithersRunReader.listRuns()`.
- Does not read `runs/index.json`.
- `workflowId` filter maps to workflow path/name; it is not a Smithers DB column.
- `limit` is clamped to a safe maximum.

### Add: `GET /api/smithers/runs/:runId`

Query:

```txt
eventsAfterSeq=<number>
eventLimit=<number>
frameLimit=<number>
includeOutputs=true|false
```

Response:

```json
{
  "ok": true,
  "detail": {
    "run": { "id": "run-...", "status": "running" },
    "nodes": [],
    "attempts": [],
    "events": [],
    "frames": [],
    "cursors": { "nextEventSeq": 42 }
  }
}
```

Acceptance:

- Backed by `SmithersRunReader.getRunDetail()`.
- Returns `404` when the DB has no row for the run.
- Tolerates the detached-launch race: client can retry 404 for a short window.
- Does not read `runs/<runId>/plan.json`, `run.json`, or `events.jsonl`.

### Add: `GET /api/smithers/runs/:runId/events`

Query:

```txt
afterSeq=<number>
limit=<number>
nodeId=<node-id>
types=<comma-separated-list>
```

Response:

```json
{
  "ok": true,
  "events": [],
  "nextAfterSeq": 42
}
```

Acceptance:

- Backed by `SmithersRunReader.listEvents()`.
- Parses payload JSON defensively.
- Computes `nextAfterSeq` monotonically.
- Does not tail NDJSON logs in the first slice.

### Change: `POST /api/workflows/:id/run`

Current project-mode route should become:

```json
{
  "ok": true,
  "runId": "run-...",
  "status": "running",
  "inspection": {
    "url": "/api/smithers/runs/run-..."
  }
}
```

Implementation requirements:

- Keep launching through Smithers runtime/CLI.
- Reject `promptOverrides` in project mode with `400` and a clear error:

  ```json
  {
    "ok": false,
    "error": {
      "code": "PROJECT_MODE_PROMPT_OVERRIDES_UNSUPPORTED",
      "message": "Project-mode runs must use saved Smithers workflow source; promptOverrides are a legacy run-browser feature."
    }
  }
  ```

- Do not route project-mode runs through legacy `runSmithersWorkflow()`.
- Remove `--log-dir .smithers/executions` from the Smithers CLI spawn unless a test proves a verified per-run path is needed.
- Preserve `--root .` when launching from project root so Smithers default state/log paths are project-rooted.

## 7. UI polling/rendering plan

### Project run-inspection state

Add explicit project live-run state, separate from preview graph state:

```js
let projectRunInspection = null;
// {
//   runId,
//   workflowId,
//   graph,
//   detail,
//   lastEventSeq,
//   pollTimer,
//   retry404Count
// }
```

Do not overload `currentWorkflowGraph.runStatus` as the source of truth for a live run.

### Start Full Run transition

Replace current preview-overlay behavior with:

```txt
preview mode
  click Start Full Run
  POST /api/workflows/:id/run with { input }
  receive { runId, inspection.url }
  set currentRunId = runId
  clear/disable pretend outputs for actual run inspection
  enter run-inspection mode
  call loadSmithersRun(runId)
  poll until terminal status
```

Run request payload must include preview `input` only. It must not include:

- prompt overrides
- pretend outputs
- structured source edit drafts
- whole-source drafts

### Poll behavior

- Call `GET /api/smithers/runs/:runId?eventsAfterSeq=<lastEventSeq>&includeOutputs=true`.
- Poll every 500–1000ms while run status is non-terminal.
- Slow down or stop when terminal.
- Treat initial `404` as a detached-launch race for a small bounded retry window, then show a real error.

Terminal statuses should be based on Smithers vocabulary. At minimum:

```txt
finished  -> success/done
failed    -> failed
cancelled -> cancelled/terminal
canceled  -> cancelled/terminal, if emitted by any Smithers path
```

Keep raw status visible in the inspector/header even when the UI maps it to a visual class.

### Graph overlay behavior

- Keep current `RenderGraph` layout as visual projection of Smithers `GraphSnapshot`.
- Overlay node status by joining `graph.nodes[].id` to `detail.nodes[].nodeId`.
- Preserve the preview graph if no live frame graph is available yet.
- Do not reconstruct a rich graph from `_smithers_frames` in this slice.
- If multiple iterations exist, show the latest node state by default and include iteration in the inspector.

Visual status normalization should cover both legacy and Smithers statuses:

```txt
finished -> done
succeeded -> done          # legacy compatibility
running -> running
waiting / pending / queued -> pending
failed -> failed
cancelled / canceled -> failed or cancelled visual, but raw status visible
```

### Inspector behavior

When a node is selected during run-inspection mode, inspector sections should show:

1. **Smithers run state**
   - run id
   - raw run status
   - derived/visual status
   - node id and iteration
   - node state from `_smithers_nodes`
2. **Attempts**
   - attempt number
   - state
   - start/finish timestamps
   - cached flag
   - error summary when present
   - response text preview when present
3. **Run output**
   - output table
   - raw output row, formatted as JSON
   - clear empty state if no output row exists yet
4. **Activity timeline**
   - events from `_smithers_events`, newest or chronological with clear labels
   - parsed node/attempt information from event payload when present

Header/provenance copy should say:

```txt
Smithers SQLite · live run
```

Preview input remains locally available, but changing it while inspecting a live run should either be disabled or clearly marked as affecting only Back to Preview.

### Calls project mode must not make

During project-mode run inspection, do not call:

- `waitForRunToRender()`
- `/runs/index.json`
- `/runs/:id/plan.json`
- `/runs/:id/run.json`
- `/runs/:id/events.jsonl`

Those remain legacy compatibility paths only.

## 8. Legacy paths left untouched

Do not delete or rewrite these in this slice:

- `src/runs/recorder.ts`
- `src/app/renderWorkflowGraph.ts`
- `src/app/runSmithersWorkflow.ts`
- Legacy endpoints:
  - `POST /api/runs`
  - `POST /api/runs/:id/rerun`
  - `POST /api/smithers-runs`
- Legacy web run browser for demo/compat mode:
  - `/runs/index.json`
  - `/runs/:id/plan.json`
  - `/runs/:id/run.json`
  - `/runs/:id/events.jsonl`

But project-mode code must not depend on them.

## 9. TDD implementation slices

Use strict red-green-refactor. Keep each slice independently shippable.

### Slice 1 — read-only DB opener + reader contract

Behavior:

```txt
Given an existing Smithers smithers.db
When CustomHarness opens SmithersRunReader
Then it can read runs without schema mutation
And attempted writes fail
And close releases the connection
```

Acceptance:

- `src/smithersProject/sqliteReadOnly.ts` opens existing `smithers.db` read-only.
- Missing DB fails without creating a file.
- `ensureSmithersTables()` is not imported or called.
- `PRAGMA query_only=ON` or equivalent defense-in-depth is applied where supported.
- `SmithersRunReader` exposes `listRuns`, `getRunDetail`, `listEvents`, and `close`.

Tests:

- `tests/smithersRunReader.test.ts`
  - missing DB does not create file
  - opening/closing works
  - read query succeeds
  - write probe fails
  - schema/table list unchanged before/after reader calls
- Optional static guard in test or review checklist:
  - no `ensureSmithersTables` import in `src/smithersProject/runReader.ts` or `sqliteReadOnly.ts`

Validation:

```bash
bun test tests/smithersRunReader.test.ts
bun tsc --noEmit
```

### Slice 2 — run summaries and status from Smithers DB

Behavior:

```txt
Given Smithers-created run rows
When listRuns() and getRunDetail(runId) are called
Then run identity/status comes from _smithers_runs
And missing run returns null
```

Acceptance:

- `listRuns()` returns run summaries from Smithers DB.
- `getRunDetail()` returns `run` details from `_smithers_runs`.
- Missing run returns `null`.
- `workflowId` filtering maps workflow id to workflow path/name; no DB `workflow_id` is assumed.
- Status normalization helper maps Smithers `finished` to UI `done` without hiding raw status.

Tests:

- Reader unit test using a small seeded DB or a Smithers-created fixture.
- Workflow filter test proving `workflowId: "foo"` matches `.smithers/workflows/foo.tsx` path/name.
- Missing run test.
- Status normalization test for `finished`, `running`, `failed`, `cancelled`, and legacy `succeeded`.

Validation:

```bash
bun test tests/smithersRunReader.test.ts tests/workflowViewer.ui.test.ts
```

### Slice 3 — nodes, attempts, and errors

Behavior:

```txt
Given a run with node and attempt rows
When getRunDetail(runId) is called
Then detail.nodes and detail.attempts reflect Smithers SQLite state
And malformed JSON fields do not crash the endpoint
```

Acceptance:

- `getRunDetail()` includes nodes from `_smithers_nodes`.
- Attempts are sorted deterministically by node/iteration/attempt/start time.
- `error_json`, `meta_json`, and heartbeat data are parsed defensively.
- Node status overlay uses `_smithers_nodes.state`, not preview graph state.

Tests:

- Node rows appear with node id, iteration, state, output table, timestamps.
- Attempts appear with attempt number, state, response text, cached flag, error.
- Malformed JSON field produces a field-level parse marker, not a 500.
- Graph overlay helper maps DB `finished` node state to a done visual class.

Validation:

```bash
bun test tests/smithersRunReader.test.ts tests/workflowViewer.ui.test.ts
```

### Slice 4 — event timeline polling

Behavior:

```txt
Given event rows with increasing seq values
When listEvents(runId, { afterSeq }) is called
Then only newer events are returned
And nextAfterSeq advances monotonically
```

Acceptance:

- Uses Smithers adapter `listEvents`/`listEventHistory`.
- Parses payload JSON defensively.
- Derives `nodeId`, `iteration`, and `attempt` from payload when present.
- Supports `nodeId` and `types` filtering without requiring non-existent DB columns.

Tests:

- `afterSeq` returns only events with greater `seq`.
- Empty result preserves requested cursor.
- Payload parse failure is represented safely.
- Node/type filters work through adapter query or reader-side filtering.

Validation:

```bash
bun test tests/smithersRunReader.test.ts
```

### Slice 5 — output rows

Behavior:

```txt
Given node rows with output_table values
When getRunDetail(runId, { includeOutputs: true }) is called
Then each node includes its raw output row when present
And missing outputs are tolerated
```

Acceptance:

- Uses `getRawNodeOutputForIteration(outputTable, runId, nodeId, iteration)`.
- Does not import workflow source solely to inspect outputs.
- Missing table/row does not fail the whole run detail.
- Raw output row remains available; normalization is minimal.

Tests:

- Output row attached to matching node.
- Node without output table has no output row and no error.
- Missing output row is tolerated.
- Raw snake_case columns remain accessible for debugging.

Validation:

```bash
bun test tests/smithersRunReader.test.ts
```

### Slice 6 — DB-backed server endpoints

Behavior:

```txt
Given a project-mode server with a SmithersRunReader seam
When /api/smithers/runs endpoints are called
Then responses come from the reader
And legacy runs JSON is never read
```

Acceptance:

- Add `GET /api/smithers/runs`.
- Add `GET /api/smithers/runs/:runId`.
- Add `GET /api/smithers/runs/:runId/events`.
- All three are backed by the injected or real `SmithersRunReader`.
- Reader is closed after request handling or reused with clear lifecycle ownership.
- Errors use project API JSON shapes.
- No code path reads `runs/index.json`, `plan.json`, `run.json`, or `events.jsonl` for these endpoints.

Tests:

- Server endpoint tests with fake reader.
- `404` for missing run.
- Query parsing/clamping tests for `limit`, `afterSeq`, `includeOutputs`.
- A trap test where legacy `runs/` files exist with contradictory data and endpoint still returns fake reader/DB data.

Validation:

```bash
bun test tests/workflowsServer.test.ts tests/smithersRunReader.test.ts
```

### Slice 7 — Start Full Run response and prompt override rejection

Behavior:

```txt
Given project mode
When POST /api/workflows/:id/run starts a run
Then response includes inspection.url
And promptOverrides are rejected instead of using legacy run artifacts
```

Acceptance:

- `POST /api/workflows/:id/run` returns `inspection.url`.
- Project-mode `promptOverrides` request returns `400`.
- `runProjectWorkflow` signature no longer accepts project-mode `promptOverrides`.
- Project-mode run does not call `runSmithersWorkflow()`.
- Smithers CLI spawn removes `--log-dir .smithers/executions` unless replaced by a verified per-run log dir.
- Existing tests that expected flat `.smithers/executions/stream.ndjson` are updated to Smithers canonical behavior or removed if logs are not part of the assertion.

Tests:

- Run endpoint response includes `/api/smithers/runs/<runId>`.
- Prompt override body gets stable 400 error.
- Fake project runner receives only `projectRoot`, `workflowId`, `workflowPath`, and `input`.
- Spawn argument test or seam test proves no legacy prompt override path.
- Regression test: project-mode run response does not require or create CustomHarness `runs/` JSON.

Validation:

```bash
bun test tests/workflowViewer.run.test.ts tests/workflowViewer.run.integration.test.ts
```

### Slice 8 — UI switches to DB inspection after Start Full Run

Behavior:

```txt
Given the user starts a project workflow run
When the run endpoint returns runId and inspection.url
Then the UI polls /api/smithers/runs/:runId
And does not fetch legacy /runs/:id artifacts
```

Acceptance:

- Add project run-inspection state separate from preview graph state.
- After run success, call `loadSmithersRun(result.runId)` or equivalent.
- Poll the DB-backed endpoint until terminal status.
- Initial `404` is retried briefly.
- Project-mode code does not call `waitForRunToRender()`.
- Project-mode code does not call `/runs/:id/plan.json`, `/run.json`, or `/events.jsonl`.

Tests:

- UI helper test for start-run success transition.
- Fetch spy test proving project mode calls `/api/smithers/runs/:id`.
- Fetch spy test proving project mode does not call legacy `/runs/:id/plan.json`.
- Initial 404 retry helper test.
- Terminal status helper test for `finished`, `failed`, `cancelled`.

Validation:

```bash
bun test tests/workflowViewer.run.test.ts tests/workflowViewer.ui.test.ts
```

### Slice 9 — graph status overlay and inspector panels

Behavior:

```txt
Given a preview RenderGraph and SmithersRunDetail
When the UI renders run-inspection mode
Then node cards show DB-backed status
And the inspector shows attempts, timeline, and output rows
```

Acceptance:

- Preview `RenderGraph` remains a visual projection; status overlay is derived from `SmithersRunDetail`.
- Node cards map DB states to visual statuses while preserving raw status in accessible text/inspector.
- Inspector shows node state, attempts/errors, output row, and event timeline.
- Pretend output controls are disabled or clearly preview-only and ignored while live-run mode is active.
- Back to Preview returns to `/api/workflows/:id/graph` and clears live polling.

Tests:

- Pure helper test overlays node status by node id.
- Inspector helper test renders attempts/errors/output/timeline sections.
- Multiple iterations test chooses latest by default and exposes iteration.
- Back to Preview helper clears poll timer/live state.
- Pretend outputs are ignored/disabled in run-inspection mode.

Validation:

```bash
bun test tests/workflowViewer.ui.test.ts
```

### Slice 10 — end-to-end Smithers smoke

Behavior:

```txt
Given a tiny executable Smithers workflow fixture
When a project-mode run is started
Then the API/UI can inspect run, node, attempt, event, frame, and output state from SQLite
And no project-mode legacy runs artifacts are required
```

Acceptance:

- Real Smithers run creates DB state.
- `GET /api/smithers/runs/:runId` returns run details from DB.
- At least one node status appears.
- At least one attempt or event appears, depending on fixture behavior.
- Output row appears if fixture has output.
- No project-mode assertion depends on `runs/<runId>/plan.json`.
- Full test suite and typecheck pass.

Validation:

```bash
bun test tests/
bun tsc --noEmit
```

## 10. Parallel implementation plan for agents

Keep DB/schema work single-owner. Do not run multiple writers over the same files in the main worktree.

Feasible parallel tracks after Slice 1 interfaces are agreed:

### Track A — reader foundation

Files:

- `src/smithersProject/sqliteReadOnly.ts`
- `src/smithersProject/runReader.ts`
- `src/smithersProject/runReaderTypes.ts`
- `tests/smithersRunReader.test.ts`

Owns slices 1–5. This is the single owner for Smithers DB access.

### Track B — server endpoint wiring

Files:

- `src/server.ts`
- `tests/workflowsServer.test.ts`
- `tests/workflowViewer.run.test.ts`

Can start after Track A exports stable interfaces or against a fake reader seam. Owns Slice 6 and the server half of Slice 7.

### Track C — UI state and helpers

Files:

- `web/index.html`
- UI helper modules/tests if extracted
- `tests/workflowViewer.ui.test.ts`

Can start with a mocked `SmithersRunDetail` shape after `runReaderTypes.ts` exists. Owns Slices 8–9.

### Track D — integration smoke

Files:

- Smithers fixture helpers/tests only
- `tests/workflowViewer.run.integration.test.ts`

Starts after A+B are green. Owns Slice 10 and updates any stale integration expectations around Smithers log dirs.

Coordination rules:

- Track A defines DTOs and status normalization names before B/C consume them.
- Track B must not add direct SQL; all run-state reads go through `SmithersRunReader`.
- Track C must not read legacy `/runs/*` in project mode.
- Only one track edits `src/server.ts` at a time unless using isolated worktrees.
- If using parallel worker agents, give them non-overlapping file ownership and merge through review after each slice.

## 11. Risks and open questions

- **Read-only Smithers adapter open:** Local evidence suggests constructing `SmithersDb` over an explicit read-only SQLite connection is feasible, but if Smithers APIs require a write-capable adapter, file an upstream gap and keep the reader interface stable.
- **Custom DB paths:** First slice assumes the nearest project `smithers.db` at project root. If Smithers config supports non-default DB paths, support that only after verifying the config surface.
- **Frame → GraphSnapshot:** `_smithers_frames` stores XML and shallow task indexes, not clearly full `TaskDescriptor` prompts. Use status overlay first; defer exact historical graph reconstruction.
- **Detached launch race:** UI may poll before `_smithers_runs` row exists. Handle temporary 404 with bounded retry.
- **Output table normalization:** Output rows may use snake_case/camelCase and JSON text depending schema. Normalize minimally and keep raw row available.
- **Current `--log-dir` override:** Passing `--log-dir .smithers/executions` likely bypasses per-run default log dirs. Remove the override unless a test proves a canonical replacement.
- **Dependency imports:** If importing `@smithers-orchestrator/db` directly from CustomHarness, make it an explicit dependency rather than relying on transitive package layout.
- **Status vocabulary drift:** Smithers uses `finished` for successful terminal runs in current evidence; legacy UI expects `succeeded`. Keep a small status-normalization helper with tests instead of scattering string checks.

## 12. Milestone acceptance checklist

Before calling the milestone done:

- [ ] `SmithersRunReader` opens `smithers.db` read-only and does not call schema mutation helpers.
- [ ] Missing DB does not create a DB file.
- [ ] Reader returns runs, nodes, attempts, events, frames, and output rows from Smithers state.
- [ ] `GET /api/smithers/runs*` endpoints are backed by the reader.
- [ ] `POST /api/workflows/:id/run` returns `inspection.url`.
- [ ] Project-mode `promptOverrides` are rejected, not routed to legacy artifacts.
- [ ] Project-mode Start Full Run polls `/api/smithers/runs/:runId`.
- [ ] Project-mode live run UI does not fetch `/runs/:id/plan.json`, `/run.json`, or `/events.jsonl`.
- [ ] Node card status comes from `_smithers_nodes` while raw DB status remains visible.
- [ ] Inspector shows attempts/errors, DB events, and output rows.
- [ ] Legacy run browser paths still work or are left untouched for compatibility.
- [ ] Tests and typecheck pass.

## 13. Final implementation handoff prompt

Implement live Smithers run inspection for CustomHarness project mode.

Read first:

- `AGENTS.md`
- `CONTEXT.md`
- `docs/adr/0001-runs-in-smithers-canonical-location.md`
- `docs/adr/0003-reflect-smithers-first-smooth-with-overlays.md`
- `docs/adr/0004-project-mode-run-inspection-reads-smithers-sqlite.md`
- `docs/plans/custom-harness-cli-http-viewer-implementation.md`
- `docs/plans/meta-smithers-editing.md`

Constraints:

- Do not build a CustomHarness run DB.
- Do not use `runs/index.json`, `plan.json`, `run.json`, or `events.jsonl` for project-mode Smithers run truth.
- Do not manually mutate `_smithers_*` or output tables.
- `SmithersRunReader` must be read-only.
- Keep `RenderGraph` a visual projection/overlay, not persistent workflow IR.
- Reject project-mode `promptOverrides`; prompt/model changes must be source-backed before the run starts.

Tasks:

1. Add `src/smithersProject/sqliteReadOnly.ts`, `runReaderTypes.ts`, and `runReader.ts`.
2. Read runs/nodes/attempts/events/frames/outputs from Smithers SQLite via Smithers adapter APIs where possible.
3. Add DB-backed endpoints:
   - `GET /api/smithers/runs`
   - `GET /api/smithers/runs/:runId`
   - `GET /api/smithers/runs/:runId/events`
4. Change `POST /api/workflows/:id/run` to return `inspection.url` and reject project-mode `promptOverrides`.
5. Change project-mode Start Full Run UI to poll `/api/smithers/runs/:runId` after launch.
6. Overlay real node status, attempts/errors, timeline, and outputs onto the existing project graph.
7. Leave legacy `runs/` paths untouched for non-project compatibility.

Write tests first:

- `tests/smithersRunReader.test.ts`
- server endpoint tests with a fake reader seam
- run endpoint tests for `inspection.url` and prompt override rejection
- UI helper tests proving project mode does not fetch `/runs/:id/plan.json`
- integration smoke test with a tiny real Smithers workflow

Validate with:

```bash
bun test tests/
bun tsc --noEmit
```
