# Live Smithers Run Inspection — Task Breakdown

## Planning assumptions

Verified repo facts:

- Current project-mode HTTP routes live mostly in `src/server.ts`.
  - `GET /api/project`
  - `GET /api/workflows`
  - `GET /api/workflows/:id/graph`
  - `GET /api/workflows/:id/source`
  - `PUT /api/workflows/:id/source`
  - `POST /api/workflows/:id/run`
  - Legacy routes remain:
    - `POST /api/runs`
    - `POST /api/runs/:id/rerun`
    - `POST /api/smithers-runs`
- Current server dependency-injection seams are in `HarnessServerOptions`:
  - `runOutcome`
  - `runSmithersWorkflow`
  - `renderProjectWorkflowGraph`
  - `runProjectWorkflow`
- Current `POST /api/workflows/:id/run` behavior:
  - Parses `body.input`.
  - Parses `body.promptOverrides`.
  - Calls `runProjectWorkflow({ projectRoot, workflowId, workflowPath, input, promptOverrides })`.
  - Returns `{ ok, runId, status }`.
  - Does **not** return `inspection.url`.
- Current built-in `runProjectWorkflow()` in `src/server.ts`:
  - If `promptOverrides` exist, calls legacy `runSmithersWorkflow()`.
  - Otherwise shells out to `bun node_modules/.bin/smithers workflow run ... --detach --format json --root . --log-dir .smithers/executions`.
  - Creates `.smithers/executions` directly.
- Current UI Start Full Run behavior is in `web/index.html` function `runWorkflowFresh()`.
  - In project mode it posts to `/api/workflows/:id/run`.
  - It sets `runIdEl.textContent`.
  - It mutates `currentWorkflowGraph.runId` / `currentWorkflowGraph.runStatus`.
  - It reloads `_project`.
  - It does **not** poll Smithers SQLite.
- Current legacy `/runs/*` usage is concentrated in `web/index.html`:
  - `loadRunsIndex()` fetches `/runs/index.json`.
  - `loadRun()` fetches `/runs/:id/plan.json`, `/runs/:id/run.json`, `/runs/:id/events.jsonl`.
  - `waitForRunToRender()` calls those legacy functions.
- Current project preview graph mapping is `src/runs/smithersGraph.ts`.
  - `smithersSnapshotToRenderGraph()` maps Smithers `GraphSnapshot` to disposable `RenderGraph`.
  - `RenderNode.smithers.meta` is already preserved from `TaskDescriptor.meta`.
  - This is a visual projection, not a persisted workflow IR.
- Existing project-mode tests:
  - `tests/workflowViewer.run.test.ts`
  - `tests/workflowViewer.run.integration.test.ts`
  - `tests/workflowViewer.ui.test.ts`
  - `tests/workflowViewer.graph.test.ts`
  - `tests/workflowViewer.graph.integration.test.ts`
  - `tests/server.test.ts`
- Existing legacy Smithers artifact tests:
  - `tests/runSmithersWorkflow.test.ts`
  - `tests/renderWorkflowGraph.test.ts`
- No `src/smithersProject/` module currently exists.
- Local Smithers DB APIs are inspectable in `node_modules/@smthrs/db`.
  - `SmithersDb` exists at `@smthrs/db/adapter`.
  - Read APIs include `getRun`, `listRuns`, `listNodes`, `listAttemptsForRun`, `listEvents`, `listEventHistory`, `getLastFrame`, `getRawNodeOutputForIteration`.
  - CLI `openSmithersDb()` in `node_modules/@smthrs/cli/src/find-db.js` calls `ensureSmithersTables()`, so it is not suitable for read-only inspection.

## Global Drift Tripwires

Run or encode these as tests/review checks before calling the milestone done:

```bash
# /api/smithers/runs* must ignore contradictory legacy runs/* files.
# Add a server test that creates runs/index.json + runs/<id>/*.json with false data,
# injects/fakes SmithersRunReader with true data, and asserts the endpoint returns reader data.

# Project-mode promptOverrides must return 400.
bun test tests/workflowViewer.run.test.ts
# Include assertion for:
# POST /api/workflows/foo/run { input:{}, promptOverrides:{task:"x"} }
# -> 400 PROJECT_MODE_PROMPT_OVERRIDES_UNSUPPORTED

# Reader code must not import/call schema mutators.
rg -n "from ['\"]@smthrs/db/ensure|ensureSmithersTables\(|ensureSqlMessageStorage\(|ensureSchema\(" src/smithersProject

# Read-only opener write probe must fail.
# tests/smithersRunReader.test.ts should attempt INSERT, CREATE TABLE, DROP TABLE, write PRAGMA
# through the opened connection/test seam and assert failure.

# Project-mode UI must not fetch legacy /runs/:id/plan.json after Start Full Run.
# Add fetch-spy UI/helper test: project start-run calls /api/smithers/runs/:id and not /runs/:id/plan.json.
rg -n "waitForRunToRender\(|/runs/\$\{encodeURIComponent\(runId\)\}/plan\.json" web/index.html
# Expected: legacy functions may remain, but project-mode run-inspection path must not call them.

# First slice must not reconstruct rich graphs from _smithers_frames.
rg -n "_smithers_frames|xml_json|task_index_json|smithersSnapshotToRenderGraph" src/smithersProject
# Expected: reader may expose frame metadata/shallow task indexes; no frame->RenderGraph reconstruction.

# No manual SQL writes to _smithers_* tables or output tables.
rg -n "\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b.*_smithers|_smithers_.*\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b" src/smithersProject src/server.ts

# No new persistent CustomHarness workflow/run IR for project mode.
rg -n "createRunRecorder|runs/index\.json|plan\.json|run\.json|events\.jsonl|graphJson|workflowGraph" src/smithersProject src/server.ts web/index.html
# Expected: matches only in legacy compatibility paths or review-approved visual projection code.
```

## Task graph

```txt
Task 1 — Read-only SQLite opener + SmithersRunReader contract
  -> Task 2 — SmithersRunReader data mapping
      -> Task 3 — DB-backed /api/smithers/runs* endpoints
          -> Task 4 — Project run route hardening
              -> Task 5 — UI Start Full Run switches to SQLite polling
                  -> Task 6 — Graph status overlay + inspector panels
                      -> Task 7 — End-to-end Smithers smoke + drift guard sweep
```

Serial work:

- Tasks 1–2 are serial because the reader contract must settle before consumers depend on DTOs.
- Tasks 3–4 are serial because both edit `src/server.ts`.
- Tasks 5–6 are serial because both edit `web/index.html` and related UI helpers.

Possible parallelism:

- After Task 1, a server agent can write Task 3 against a fake reader while the reader owner completes Task 2.
- After Task 2 DTOs exist, a UI agent can start Task 6 helper tests using fixture `SmithersRunDetail`, but should not edit `web/index.html` until Task 5 lands.

## Tasks

### Task 1 — Read-only SQLite opener + `SmithersRunReader` contract

#### Goal

Create a read-only Smithers DB opening seam and stable `SmithersRunReader` interface without implementing all detail mapping yet.

#### Allowed files / areas

- New `src/smithersProject/sqliteReadOnly.ts`
- New `src/smithersProject/runReaderTypes.ts`
- New `src/smithersProject/runReader.ts`
- New `tests/smithersRunReader.test.ts`
- `package.json` only if an explicit dependency is required

#### Forbidden files / behaviors

- Do not edit `web/index.html`.
- Do not edit `src/server.ts`.
- Do not call or import `ensureSmithersTables()`.
- Do not create `smithers.db` when missing.
- Do not write to `_smithers_*` tables.
- Do not read or write `runs/index.json`, `plan.json`, `run.json`, or `events.jsonl`.

#### Dependencies

None.

#### Parallelization safety

serial only — this task defines the shared reader contract and DTO names consumed by later tasks.

#### Implementation notes

- Resolve DB path as `<projectRoot>/smithers.db`.
- Open using Bun SQLite read-only mode, e.g. `new Database(dbPath, { readonly: true })`.
- Apply `PRAGMA query_only = ON` where supported.
- Construct Smithers adapter with `drizzle(sqlite)` and `new SmithersDb(db)` if compatible.
- Expose `close()`.
- Expose a test-only or documented probe seam sufficient to prove writes fail.
- Define DTOs for run summary/detail/events even if Task 2 fills most arrays later.

#### Tests to write first

- Missing `smithers.db` returns a controlled error and does not create a file.
- Opening an existing DB succeeds.
- `close()` releases the connection.
- `INSERT`, `CREATE TABLE`, `DROP TABLE`, and write PRAGMA probes fail.
- Schema/table list before and after opener use is unchanged.
- Static guard: reader modules do not import/call schema creation helpers.

#### Acceptance criteria

- `SmithersRunReader` type exposes:
  - `listRuns()`
  - `getRunDetail()`
  - `listEvents()`
  - `close()`
- The opener is read-only and fails safely when the DB is missing.
- Tests prove write probes fail.
- The reader implementation has no schema-mutation imports.

#### Validation commands

```bash
bun test tests/smithersRunReader.test.ts
bun tsc --noEmit
rg -n "from ['\"]@smthrs/db/ensure|ensureSmithersTables\(|ensureSqlMessageStorage\(|ensureSchema\(" src/smithersProject
```

#### Drift tripwires

- Grep must show no `ensureSmithersTables` or `ensureSchema` calls in `src/smithersProject`.
- Test must prove missing DB does not create `<projectRoot>/smithers.db`.
- Test must prove write probes fail through the opened connection.
- Review check: no `createRunRecorder` import in `src/smithersProject`.

#### Test-writer prompt

```txt
Write failing tests only for Task 1: read-only Smithers SQLite opener and SmithersRunReader contract.

Scope:
- Edit tests/smithersRunReader.test.ts only.
- Add test fixtures/helpers inside that test file only if needed.

Do not edit production code. Do not add src/smithersProject/* files.

Test requirements:
- Missing <projectRoot>/smithers.db returns a controlled error and does not create a file.
- Opening an existing DB succeeds.
- close() releases the connection or at least prevents further use through the exposed seam.
- INSERT, CREATE TABLE, DROP TABLE, and write PRAGMA probes fail through the opened connection/test seam.
- Schema/table list before and after opener use is unchanged.
- Static guard proves reader modules do not import/call schema creation helpers.
- Assert the exported SmithersRunReader contract exposes listRuns(), getRunDetail(), listEvents(), and close().

Rules:
- Tests should fail because the reader/opener modules do not exist or behavior is missing, not because fixtures are invalid.
- Do not over-specify private implementation beyond the read-only opener and public contract.
- Do not use CustomHarness runs/ JSON.
- Do not manually write _smithers_* rows; generic temporary tables are acceptable only for proving read-only behavior on a test DB before opening it read-only.

Validation to run:
- bun test tests/smithersRunReader.test.ts

Expected result before implementation:
- The targeted test command fails for missing modules or missing read-only behavior.

Stop rules:
- If proving write failure requires a production-code seam that does not exist yet, write the test against the intended public/test seam and stop after confirming the expected missing-export failure.
```

#### Worker prompt

```txt
Implement Task 1 only: add a read-only Smithers SQLite opener and SmithersRunReader contract.

Scope:
- Add src/smithersProject/sqliteReadOnly.ts
- Add src/smithersProject/runReaderTypes.ts
- Add src/smithersProject/runReader.ts
- Add tests/smithersRunReader.test.ts

Non-goals:
- Do not add server endpoints.
- Do not edit web/index.html.
- Do not implement full node/attempt/output mapping yet.
- Do not create beads.
- Do not use CustomHarness runs/ JSON.

Architecture rules:
- Open <projectRoot>/smithers.db read-only.
- Do not import/call ensureSmithersTables or schema migration helpers.
- Apply PRAGMA query_only=ON if supported.
- Return adapter/connection/close handles safely.

Validation:
- bun test tests/smithersRunReader.test.ts
- bun tsc --noEmit
- rg guard for ensureSmithersTables/ensureSchema

Stop rules:
- If SmithersDb cannot be constructed over a read-only Bun SQLite connection, stop and report the exact failure. Keep the interface and tests, but do not switch to write-capable open.
```

### Task 2 — `SmithersRunReader` data mapping

#### Goal

Make `SmithersRunReader` return DB-backed runs, nodes, attempts, events, frames, and optional output rows from Smithers SQLite.

#### Allowed files / areas

- `src/smithersProject/runReader.ts`
- `src/smithersProject/runReaderTypes.ts`
- `src/smithersProject/sqliteReadOnly.ts` only if Task 1 needs small adjustments
- `tests/smithersRunReader.test.ts`

#### Forbidden files / behaviors

- Do not edit server routes.
- Do not edit UI.
- Do not manually write `_smithers_*` rows.
- Do not import workflow source solely to inspect outputs.
- Do not reconstruct rich `RenderGraph` from `_smithers_frames`.
- Do not use legacy `runs/*` files.

#### Dependencies

Task 1.

#### Parallelization safety

serial only — this completes the core DB reader and prevents downstream agents from guessing DTO shapes.

#### Implementation notes

- Use Smithers adapter APIs where possible:
  - `listRuns`, `getRun`
  - `listNodes`
  - `listAttemptsForRun`
  - `listEvents` / `listEventHistory`
  - `getLastFrame` and available frame APIs
  - `getRawNodeOutputForIteration`
- `workflowId` filter is CustomHarness flat workflow id; map to `.smithers/workflows/<id>.tsx` path/name, not a DB column.
- Parse JSON-ish fields defensively:
  - `errorJson`
  - `metaJson`
  - `heartbeatDataJson`
  - event `payload_json`
  - frame task indexes
- Sort attempts deterministically.
- Keep raw Smithers status visible; add visual/status helper only as a separate normalized field.
- Frames may expose row metadata, mounted ids, and task index only. Do not build a historical graph.

#### Tests to write first

- `listRuns()` returns `_smithers_runs` data.
- `workflowId: "foo"` filters by `.smithers/workflows/foo.tsx` path/name.
- Missing `getRunDetail(runId)` returns `null`.
- Nodes appear with node id, iteration, state, output table, label, timestamps.
- Attempts appear sorted by node/iteration/attempt/start time.
- Malformed JSON fields produce field-level parse markers, not thrown endpoint failures.
- `listEvents(afterSeq)` returns only newer events and monotonic cursor.
- `includeOutputs: true` attaches output rows when present and tolerates missing output table/row.
- Frame detail exposes metadata only; no rich graph reconstruction.

#### Acceptance criteria

- Reader returns first-slice `SmithersRunDetail` with:
  - `run`
  - `nodes`
  - `attempts`
  - `events`
  - `frames`
  - `cursors.nextEventSeq`
- Output rows are raw and optional.
- Event `nodeId`, `iteration`, `attempt` are derived from payload when present.
- No reader code uses legacy artifacts or schema mutators.

#### Validation commands

```bash
bun test tests/smithersRunReader.test.ts
bun tsc --noEmit
rg -n "runs/index\.json|plan\.json|run\.json|events\.jsonl|createRunRecorder" src/smithersProject
rg -n "smithersSnapshotToRenderGraph|_smithers_frames" src/smithersProject
```

#### Drift tripwires

- Negative test with malformed JSON must not crash `getRunDetail()`.
- Negative test with missing output table/row must not fail whole detail.
- Grep/review must confirm no `smithersSnapshotToRenderGraph()` call in reader.
- Grep/review must confirm no manual SQL write statements in reader.

#### Test-writer prompt

```txt
Write failing tests only for Task 2: SmithersRunReader data mapping.

Scope:
- Edit tests/smithersRunReader.test.ts only, unless a tiny fixture under tests/fixtures/ is clearly needed.
- Do not edit src/smithersProject/* or any server/UI files.

Test requirements:
- listRuns() returns data from Smithers SQLite run rows.
- workflowId: "foo" filters runs by .smithers/workflows/foo.tsx path/name.
- getRunDetail(runId) returns null for a missing run.
- getRunDetail(runId) returns run, nodes, attempts, events, frames, and cursors.nextEventSeq.
- Nodes include node id, iteration, state/status, output table, label/title, and timestamps when present.
- Attempts are sorted deterministically by node/iteration/attempt/start time.
- Malformed JSON-ish fields produce field-level parse markers/warnings instead of crashing getRunDetail().
- listEvents(afterSeq) returns only newer events and a monotonic cursor.
- includeOutputs: true attaches raw output rows when present and tolerates missing output table/row.
- Frame detail exposes metadata/shallow task index only; no rich RenderGraph reconstruction is expected.

Rules:
- Use deterministic test DB fixtures. Prefer the Smithers adapter/API shape where available, but tests may seed minimal SQLite state needed to exercise the reader.
- Do not call Smithers schema mutators from production code; test setup may create fixture tables directly if that is the only practical way to build a DB.
- Do not read or assert against legacy runs/index.json, plan.json, run.json, or events.jsonl.
- Do not over-specify exact private helper names or raw SQL implementation.

Validation to run:
- bun test tests/smithersRunReader.test.ts

Expected result before implementation:
- New tests fail because mapping, JSON tolerance, event cursoring, output attachment, or frame metadata behavior is missing.

Stop rules:
- If the Smithers installed schema differs from assumptions, keep tests focused on the public DTO contract and report the schema mismatch.
```

#### Worker prompt

```txt
Implement Task 2 only: complete SmithersRunReader data mapping.

Scope:
- src/smithersProject/runReader.ts
- src/smithersProject/runReaderTypes.ts
- tests/smithersRunReader.test.ts

Use Smithers adapter APIs first:
listRuns/getRun/listNodes/listAttemptsForRun/listEvents/listEventHistory/getLastFrame/getRawNodeOutputForIteration.

Non-goals:
- Do not add HTTP endpoints.
- Do not touch UI.
- Do not reconstruct RenderGraph from _smithers_frames.
- Do not import workflow source for outputs.
- Do not read CustomHarness runs/ JSON.

Validation:
- bun test tests/smithersRunReader.test.ts
- bun tsc --noEmit
- grep guards for legacy artifacts and graph reconstruction

Stop rules:
- If a needed Smithers adapter API is unavailable, isolate the gap in runReader.ts with a small read-only raw SQL fallback or stop and report the exact missing API. Do not scatter raw SQL outside the reader.
```

### Task 3 — DB-backed `/api/smithers/runs*` endpoints

#### Goal

Add project-mode run-inspection HTTP endpoints backed only by `SmithersRunReader`.

#### Allowed files / areas

- `src/server.ts`
- `src/smithersProject/runReaderTypes.ts` only for import/type adjustments
- `tests/workflowsServer.test.ts` or `tests/server.test.ts`
- `tests/smithersRunReader.test.ts` only if endpoint tests need shared fixtures

#### Forbidden files / behaviors

- Do not edit `web/index.html`.
- Do not call Smithers DB APIs directly from route handlers except through `SmithersRunReader`.
- Do not read `/runs/index.json` or `runs/<id>/*.json` in these endpoints.
- Do not manually write Smithers DB rows.
- Do not add a CustomHarness run DB.

#### Dependencies

Tasks 1 and 2.

#### Parallelization safety

parallel after Task 2 — can be done by a server owner after reader DTOs are stable; must not overlap with Task 4 in `src/server.ts`.

#### Implementation notes

- Add a `createSmithersRunReader` DI seam to `HarnessServerOptions`.
- Add routes:
  - `GET /api/smithers/runs`
  - `GET /api/smithers/runs/:runId`
  - `GET /api/smithers/runs/:runId/events`
- Query parsing:
  - Clamp `limit`.
  - Parse `eventsAfterSeq`, `afterSeq`, `eventLimit`, `frameLimit`.
  - Parse `includeOutputs=true|false`.
  - Parse `types=a,b,c`.
- Translate missing run detail to `404`.
- Ensure reader lifecycle is explicit: close after request or use clear per-request ownership.
- Keep legacy `/api/runs`, `/api/smithers-runs`, `/runs/*` untouched.

#### Tests to write first

- Endpoint uses fake reader and returns reader data.
- `GET /api/smithers/runs/:runId` returns 404 when reader returns `null`.
- Query parsing/clamping tests.
- Contradictory legacy `runs/*` trap test:
  - Create fake `runs/index.json`, `plan.json`, `run.json`, `events.jsonl`.
  - Inject fake reader with different data.
  - Assert `/api/smithers/runs*` returns reader data.
- Reader `close()` is called.

#### Acceptance criteria

- All three endpoints exist and return stable JSON.
- Endpoint data comes from injected/real `SmithersRunReader`.
- Legacy files cannot influence these endpoints.
- Error responses are structured enough for UI use.

#### Validation commands

```bash
bun test tests/server.test.ts tests/workflowsServer.test.ts tests/smithersRunReader.test.ts
bun tsc --noEmit
rg -n "runs/index\.json|plan\.json|run\.json|events\.jsonl|readExistingRun" src/server.ts
```

#### Drift tripwires

- Trap test must fail if route reads legacy `runs/*`.
- Review check: `/api/smithers/runs*` handlers must not call `readExistingRun()`.
- Review check: all Smithers run-state reads go through `SmithersRunReader`.

#### Test-writer prompt

```txt
Write failing tests only for Task 3: DB-backed /api/smithers/runs* endpoints.

Scope:
- Edit tests/server.test.ts or tests/workflowsServer.test.ts.
- Edit tests/smithersRunReader.test.ts only if shared fixtures are needed.
- Do not edit src/server.ts or any production code.

Test requirements:
- createHarnessServerHandler accepts a fake createSmithersRunReader seam and /api/smithers/runs returns fake reader list data.
- GET /api/smithers/runs/:runId returns fake reader detail data.
- GET /api/smithers/runs/:runId returns 404 when reader returns null.
- GET /api/smithers/runs/:runId/events returns fake reader event data.
- Query parsing/clamping is exercised for limit, eventsAfterSeq/afterSeq, eventLimit, frameLimit, includeOutputs, and types.
- Contradictory legacy runs/* trap: create fake runs/index.json plus runs/<id>/plan.json, run.json, events.jsonl with false data; inject fake reader with true data; assert /api/smithers/runs* returns reader data only.
- Reader close() is called after each request, including error/404 paths where applicable.

Rules:
- Tests should use a fake reader, not real Smithers DB internals.
- Do not test legacy /api/runs, /api/smithers-runs, or /runs/* behavior except as negative trap data.
- Do not over-specify route internals beyond the public JSON and lifecycle contract.
- Do not edit web/index.html.

Validation to run:
- bun test tests/server.test.ts tests/workflowsServer.test.ts tests/smithersRunReader.test.ts

Expected result before implementation:
- Tests fail because the DI seam and /api/smithers/runs* routes do not exist yet.

Stop rules:
- If tests/workflowsServer.test.ts does not exist, put endpoint tests in tests/server.test.ts and note that choice.
```

#### Worker prompt

```txt
Implement Task 3 only: DB-backed /api/smithers/runs* endpoints.

Scope:
- src/server.ts
- tests/server.test.ts or tests/workflowsServer.test.ts

Requirements:
- Add createSmithersRunReader DI seam.
- Add GET /api/smithers/runs.
- Add GET /api/smithers/runs/:runId.
- Add GET /api/smithers/runs/:runId/events.
- Use SmithersRunReader only for run-state reads.
- Add fake-reader endpoint tests, including contradictory legacy runs/* trap.

Non-goals:
- Do not change POST /api/workflows/:id/run yet.
- Do not edit web/index.html.
- Do not delete legacy endpoints.
- Do not use legacy runs JSON for project-mode truth.

Validation:
- bun test tests/server.test.ts tests/workflowsServer.test.ts tests/smithersRunReader.test.ts
- bun tsc --noEmit

Stop rules:
- If route lifecycle for reader close is unclear, choose per-request reader open/close and document it in test names. Do not introduce a long-lived mutable run cache.
```

### Task 4 — Project run route hardening

#### Goal

Make `POST /api/workflows/:id/run` launch only source-backed project runs, reject `promptOverrides`, and return `inspection.url`.

#### Allowed files / areas

- `src/server.ts`
- `tests/workflowViewer.run.test.ts`
- `tests/workflowViewer.run.integration.test.ts`
- Existing Smithers run fixture helpers if needed

#### Forbidden files / behaviors

- Do not edit UI polling/rendering yet.
- Do not route project-mode runs through `runSmithersWorkflow()`.
- Do not accept `promptOverrides` in project mode.
- Do not create or require CustomHarness `runs/` JSON.
- Do not preserve the current `--log-dir .smithers/executions` behavior unless a test proves a canonical replacement is required.

#### Dependencies

Task 3 for shared server route context. Can be done after Task 2 if Task 3 is not started, but do not overlap server edits.

#### Parallelization safety

serial only — same `src/server.ts` ownership as Task 3.

#### Implementation notes

- Change `RunProjectWorkflowFn` options to remove `promptOverrides`.
- In `workflowRunResponse()`, if `body.promptOverrides` is present and non-empty, return:
  - status `400`
  - code `PROJECT_MODE_PROMPT_OVERRIDES_UNSUPPORTED`
  - message explaining project-mode runs use saved Smithers workflow source.
- Return:
  ```json
  {
    "ok": true,
    "runId": "...",
    "status": "...",
    "inspection": { "url": "/api/smithers/runs/<runId>" }
  }
  ```
- Built-in runner should launch Smithers source-backed run only.
- Remove `runSmithersWorkflow()` fallback from project-mode runner.
- Prefer Smithers default canonical log behavior with `--root .`; remove `--log-dir .smithers/executions` unless verified otherwise.

#### Tests to write first

- Run endpoint response includes `inspection.url`.
- `promptOverrides` request returns stable 400 error.
- Fake runner receives only `projectRoot`, `workflowId`, `workflowPath`, `input`.
- Regression: project-mode run does not create `runs/`.
- Spawn/seam test proving prompt override path is not called.
- Integration test updated away from flat `.smithers/executions/<runId>.log` assumptions if needed.

#### Acceptance criteria

- Project-mode route rejects prompt overrides.
- Project-mode route returns `inspection.url`.
- Project-mode runner no longer calls legacy `runSmithersWorkflow()` for prompt overrides.
- Tests reflect Smithers canonical DB/log ownership, not CustomHarness run artifacts.

#### Validation commands

```bash
bun test tests/workflowViewer.run.test.ts tests/workflowViewer.run.integration.test.ts
bun tsc --noEmit
rg -n "promptOverrides|runSmithersWorkflow\(|--log-dir|createRunRecorder" src/server.ts
```

#### Drift tripwires

- Test must assert prompt override body returns `400`.
- Test must assert fake runner call has no `promptOverrides` key.
- Grep/review: any remaining `promptOverrides` in `src/server.ts` must be legacy `/api/smithers-runs` or `/api/runs/:id/rerun`, not project `POST /api/workflows/:id/run`.
- Grep/review: project runner must not call `runSmithersWorkflow()`.

#### Test-writer prompt

```txt
Write failing tests only for Task 4: harden POST /api/workflows/:id/run.

Scope:
- Edit tests/workflowViewer.run.test.ts and tests/workflowViewer.run.integration.test.ts only.
- Do not edit src/server.ts or production code.

Test requirements:
- Successful project-mode run response includes inspection.url = /api/smithers/runs/<runId>.
- Request with non-empty promptOverrides returns HTTP 400 with code PROJECT_MODE_PROMPT_OVERRIDES_UNSUPPORTED and does not invoke the runner.
- Fake runProjectWorkflow receives only projectRoot, workflowId, workflowPath, and input; assert promptOverrides is not present as an own key.
- Regression: project-mode run does not create project-root runs/ artifacts.
- Spawn/seam coverage proves the project-mode prompt override path does not call legacy runSmithersWorkflow().
- Integration expectations no longer depend on flat .smithers/executions/<runId>.log assumptions; DB/inspection URL is the product contract.

Rules:
- Do not delete or weaken existing legacy promptOverrides tests for /api/smithers-runs or rerun paths.
- Do not require UI polling in this task.
- Do not over-specify the exact Smithers CLI binary unless needed by the integration fixture.

Validation to run:
- bun test tests/workflowViewer.run.test.ts tests/workflowViewer.run.integration.test.ts

Expected result before implementation:
- Tests fail because inspection.url is missing, promptOverrides are still forwarded/accepted, or the runner type still includes promptOverrides.

Stop rules:
- If the existing integration fixture is flaky for unrelated Smithers CLI reasons, keep focused unit tests and mark the integration gap clearly.
```

#### Worker prompt

```txt
Implement Task 4 only: harden POST /api/workflows/:id/run.

Scope:
- src/server.ts
- tests/workflowViewer.run.test.ts
- tests/workflowViewer.run.integration.test.ts

Requirements:
- Reject project-mode promptOverrides with 400 PROJECT_MODE_PROMPT_OVERRIDES_UNSUPPORTED.
- Remove promptOverrides from RunProjectWorkflowFn.
- Return inspection.url = /api/smithers/runs/<runId>.
- Do not call legacy runSmithersWorkflow from project-mode runs.
- Do not create CustomHarness runs/ artifacts for project-mode runs.
- Remove --log-dir .smithers/executions unless a test proves a Smithers-canonical replacement is necessary.

Non-goals:
- Do not implement UI polling.
- Do not delete legacy /api/smithers-runs or rerun behavior.

Validation:
- bun test tests/workflowViewer.run.test.ts tests/workflowViewer.run.integration.test.ts
- bun tsc --noEmit
- grep for promptOverrides/runSmithersWorkflow in src/server.ts and classify remaining matches.

Stop rules:
- If removing --log-dir breaks real Smithers run startup, stop and report exact command/stderr. Do not reintroduce CustomHarness run artifacts as a workaround.
```

### Task 5 — Project UI Start Full Run switches to SQLite polling

#### Goal

After project-mode Start Full Run, switch the UI into live run-inspection mode and poll `/api/smithers/runs/:runId` instead of pretending the preview graph is live.

#### Allowed files / areas

- `web/index.html`
- `tests/workflowViewer.ui.test.ts`
- New small UI helper module under `src/ui/` if needed
- `tests/workflowViewer.run.test.ts` only for helper-level request payload assertions

#### Forbidden files / behaviors

- Do not edit Smithers reader internals.
- Do not fetch `/runs/:id/plan.json`, `/run.json`, or `/events.jsonl` in project-mode run inspection.
- Do not call `waitForRunToRender()` from project-mode Start Full Run.
- Do not send `promptOverrides`, pretend outputs, structured drafts, or whole-source drafts in project-mode run payload.
- Do not reconstruct graphs from frames.

#### Dependencies

Task 4.

#### Parallelization safety

serial only — this owns the project-mode Start Full Run path in `web/index.html` and must land before inspector overlays.

#### Implementation notes

- Introduce explicit project live-run state, e.g. `projectRunInspection`.
- Start transition:
  - `POST /api/workflows/:id/run` with `{ input }`.
  - Read `result.inspection.url`.
  - Set current run id.
  - Poll detail endpoint.
- Poll query:
  - `/api/smithers/runs/:runId?eventsAfterSeq=<lastEventSeq>&includeOutputs=true`
- Retry initial `404` briefly for detached-launch race.
- Stop or slow polling on terminal statuses:
  - `finished`
  - `failed`
  - `cancelled`
  - `canceled`
- Keep preview graph available until live detail arrives.
- Header/provenance should indicate `Smithers SQLite · live run`.

#### Tests to write first

- UI helper test: project run payload contains only `{ input }`.
- Fetch spy test: after run success, project mode calls `/api/smithers/runs/:id`.
- Fetch spy test: project mode does not call `/runs/:id/plan.json`.
- Initial 404 retry helper test.
- Terminal status helper test.
- Test that `waitForRunToRender()` is not used by project Start Full Run.

#### Acceptance criteria

- Project-mode Start Full Run enters live run-inspection mode.
- UI polls DB-backed endpoint until terminal status.
- Initial 404 is bounded/retried.
- Legacy run artifact loading remains only for legacy run browser mode.
- No prompt overrides or pretend outputs are sent to project run route.

#### Validation commands

```bash
bun test tests/workflowViewer.ui.test.ts tests/workflowViewer.run.test.ts
bun tsc --noEmit
rg -n "waitForRunToRender\(|/runs/\$\{encodeURIComponent\(runId\)\}/plan\.json|promptOverrides" web/index.html
```

#### Drift tripwires

- Fetch-spy test must fail if project run inspection fetches `/runs/:id/plan.json`.
- Fetch-spy test must fail if project run payload includes `outputs` or `promptOverrides`.
- Review check: `waitForRunToRender()` may remain for legacy mode but must not be reachable from project Start Full Run.

#### Test-writer prompt

```txt
Write failing tests only for Task 5: project UI Start Full Run switches to Smithers SQLite polling.

Scope:
- Edit tests/workflowViewer.ui.test.ts.
- Edit tests/workflowViewer.run.test.ts only if adding helper-level request payload assertions.
- Add a small helper test target expectation only if needed; do not edit production helper/source files.
- Do not edit web/index.html.

Test requirements:
- Project Start Full Run payload contains only { input }; it must not include promptOverrides, outputs, structured drafts, or whole-source drafts.
- After a successful project run response, project mode fetches /api/smithers/runs/:runId or result.inspection.url.
- Project mode does not fetch /runs/:id/plan.json, /runs/:id/run.json, or /runs/:id/events.jsonl during live inspection.
- Initial 404 from /api/smithers/runs/:runId is retried in a bounded way for detached-launch races.
- Polling stops or slows on terminal statuses: finished, failed, cancelled, canceled.
- waitForRunToRender() is not used by the project Start Full Run path.

Rules:
- Prefer pure helper tests if possible; avoid brittle whole-DOM tests unless the existing test style supports them.
- Do not build rich inspector-panel tests here; that belongs to Task 6.
- Do not require frame-to-graph reconstruction.
- Keep legacy run browser tests/behavior out of scope except negative fetch-spy assertions.

Validation to run:
- bun test tests/workflowViewer.ui.test.ts tests/workflowViewer.run.test.ts

Expected result before implementation:
- Tests fail because project Start Full Run currently only updates preview graph state and does not poll /api/smithers/runs/:runId.

Stop rules:
- If web/index.html lacks testable seams, write failing tests that define the intended tiny pure helper API under src/ui/ and report that implementation should extract that helper.
```

#### Worker prompt

```txt
Implement Task 5 only: project UI Start Full Run switches to Smithers SQLite polling.

Scope:
- web/index.html
- tests/workflowViewer.ui.test.ts
- optional small src/ui helper module for pure polling/status helpers

Requirements:
- Project Start Full Run posts only { input } to /api/workflows/:id/run.
- Use response.inspection.url or /api/smithers/runs/:runId.
- Poll /api/smithers/runs/:runId?eventsAfterSeq=...&includeOutputs=true.
- Retry initial 404 briefly.
- Stop/slow on terminal Smithers statuses.
- Do not call waitForRunToRender in project mode.
- Do not fetch /runs/:id/plan.json in project mode.

Non-goals:
- Do not build rich inspector panels yet.
- Do not reconstruct graphs from frames.
- Do not remove legacy run browser.

Validation:
- bun test tests/workflowViewer.ui.test.ts tests/workflowViewer.run.test.ts
- bun tsc --noEmit
- grep project-mode path for waitForRunToRender and /runs/:id/plan.json.

Stop rules:
- If web/index.html becomes too tangled, extract only tiny pure helpers under src/ui/. Do not rewrite the whole UI.
```

### Task 6 — Graph status overlay and inspector panels

#### Goal

Overlay `SmithersRunDetail` onto the existing preview `RenderGraph` and show DB-backed node state, attempts, timeline, frames summary, and output rows in the inspector.

#### Allowed files / areas

- `web/index.html`
- `src/ui/studioInspector.ts`
- New `src/ui/smithersRunOverlay.ts` or similar pure helper
- `tests/workflowViewer.ui.test.ts`
- Existing graph/UI tests if helper extraction requires updates

#### Forbidden files / behaviors

- Do not change reader DTOs except by coordinated minimal type additions.
- Do not reconstruct rich historical graphs from `_smithers_frames`.
- Do not infer completion from preview `RenderGraph` status.
- Do not use legacy `events.jsonl` as project-mode timeline truth.
- Do not enable project-mode prompt override editing as a run path.

#### Dependencies

Tasks 2 and 5.

#### Parallelization safety

parallel after Task 5 — can be done by a UI owner after polling state exists; should not overlap with Task 5 in `web/index.html`.

#### Implementation notes

- Join graph nodes to detail nodes by `node.id` / `smithers.nodeId` to `detail.nodes[].nodeId`.
- If multiple iterations exist, show latest by default and expose iteration.
- Normalize visual classes without hiding raw Smithers status:
  - `finished -> done`
  - `running -> running`
  - `waiting/pending/queued -> pending`
  - `failed -> failed`
  - `cancelled/canceled -> cancelled/failed visual`
- Inspector sections:
  - Smithers run state
  - Attempts
  - Run output
  - Activity timeline
  - Frame summary
- Clear copy should say `Smithers SQLite · live run`.
- Pretend output controls must be disabled or clearly preview-only while live-run mode is active.

#### Tests to write first

- Pure overlay helper test maps DB node `finished` to visual `done`.
- Multiple iteration test chooses latest and exposes iteration.
- Inspector helper test includes attempts/errors/output/timeline.
- Empty output row shows clear empty state.
- Live mode disables/ignores pretend output.
- Raw status remains visible in inspector/header.

#### Acceptance criteria

- Node card status in project live mode comes from `SmithersRunDetail.nodes`, not preview graph state.
- Inspector displays DB attempts, events, and output rows.
- Timeline comes from DB events.
- Frame metadata is shown only as metadata/summary.
- Preview graph remains the visual projection; no new persistent graph IR exists.

#### Validation commands

```bash
bun test tests/workflowViewer.ui.test.ts tests/smithersGraph.test.ts
bun tsc --noEmit
rg -n "events\.jsonl|plan\.json|smithersSnapshotToRenderGraph|_smithers_frames" web/index.html src/ui
```

#### Drift tripwires

- UI test must fail if overlay uses preview `node.status` instead of DB node state.
- UI test must fail if live mode enables pretend output as run state.
- Grep/review: no `events.jsonl` in live-run inspector code.
- Grep/review: no frame-to-RenderGraph reconstruction.

#### Test-writer prompt

```txt
Write failing tests only for Task 6: graph status overlay and inspector panels for project live-run mode.

Scope:
- Edit tests/workflowViewer.ui.test.ts.
- Existing graph/UI tests may be updated only to add expectations for pure helper behavior.
- Do not edit web/index.html, src/ui/studioInspector.ts, or new production helper files.

Test requirements:
- Pure overlay helper maps DB node state/status finished to visual done while preserving raw Smithers status.
- Multiple iterations choose the latest iteration by default and expose the selected iteration in returned state.
- Overlay matches graph nodes by node.id / smithers.nodeId to SmithersRunDetail.nodes[].nodeId.
- Inspector state includes Smithers run state, raw node state, attempts/errors, output rows, event timeline, and frame summary.
- Empty/missing output row produces a clear empty state rather than crashing.
- Live mode disables or clearly marks pretend output controls as preview-only.
- Timeline comes from DB events, not legacy events.jsonl.

Rules:
- Do not change reader DTO tests unless a minimal type gap is discovered; report that gap instead.
- Do not expect rich historical graph reconstruction from frames.
- Do not infer live completion from preview RenderGraph node.status.
- Prefer testing pure helpers over brittle DOM snapshots.

Validation to run:
- bun test tests/workflowViewer.ui.test.ts tests/smithersGraph.test.ts

Expected result before implementation:
- Tests fail because live-run overlay and inspector state helpers do not exist or still use preview graph status.

Stop rules:
- If the existing inspector helper type is too narrow for live details, write tests around the intended minimal extension and report the type addition needed.
```

#### Worker prompt

```txt
Implement Task 6 only: graph status overlay and inspector panels for project live-run mode.

Scope:
- web/index.html
- src/ui/studioInspector.ts
- optional src/ui/smithersRunOverlay.ts
- tests/workflowViewer.ui.test.ts

Requirements:
- Overlay SmithersRunDetail onto existing RenderGraph.
- Node status comes from detail.nodes, matched by nodeId and latest iteration.
- Show raw run/node statuses in inspector.
- Show attempts, event timeline, output row, and frame summary.
- Disable or clearly mark pretend outputs as preview-only during live run inspection.
- Do not reconstruct rich graphs from frames.

Non-goals:
- Do not add fork/replay UI.
- Do not add workflow editing.
- Do not add new persistence.

Validation:
- bun test tests/workflowViewer.ui.test.ts tests/smithersGraph.test.ts
- bun tsc --noEmit

Stop rules:
- If you need additional fields from the reader, add a minimal type request/comment and stop for coordination. Do not bypass the reader by reading DB or legacy files from UI/server code.
```

### Task 7 — End-to-end Smithers smoke + drift guard sweep

#### Goal

Prove a real project-mode Smithers run can be launched, inspected from SQLite, and displayed without relying on legacy run artifacts.

#### Allowed files / areas

- `tests/workflowViewer.run.integration.test.ts`
- `tests/smithersRunReader.test.ts`
- `tests/workflowViewer.ui.test.ts`
- Test fixtures under `tests/fixtures/`
- Minimal source fixes in task-owned files if integration exposes defects

#### Forbidden files / behaviors

- Do not broaden product scope.
- Do not add workflow editing.
- Do not add fork/replay UI.
- Do not add new run persistence.
- Do not make tests depend on `runs/<runId>/plan.json`.
- Do not manually seed Smithers DB as the primary integration proof; use Smithers runtime/CLI to create state.

#### Dependencies

Tasks 1–6.

#### Parallelization safety

parallel after Task 6 — final integration/guard task should run after feature slices land.

#### Implementation notes

- Use tiny executable Smithers workflow fixture similar to existing `tests/workflowViewer.run.integration.test.ts`.
- After `POST /api/workflows/foo/run`, call `/api/smithers/runs/:runId`.
- Assert detail contains real DB-backed run status.
- Assert at least one node, event or attempt, frame, and output row when fixture reliably produces them.
- Assert no project-root `runs/` directory is required.
- Run global grep drift checks and classify any remaining legacy matches.

#### Tests to write first

- Real run start returns `inspection.url`.
- Poll inspection endpoint until run appears.
- Detail endpoint returns run row from SQLite.
- Node state appears from SQLite.
- Event/attempt appears from SQLite, depending on fixture reliability.
- Output row appears if fixture has output.
- Contradictory legacy artifacts do not affect detail endpoint.

#### Acceptance criteria

- Full relevant tests pass.
- Typecheck passes.
- Drift grep checks are clean or documented as legacy-only.
- Final test evidence proves project-mode run truth comes from Smithers SQLite.

#### Validation commands

```bash
bun test tests/smithersRunReader.test.ts tests/workflowViewer.run.test.ts tests/workflowViewer.run.integration.test.ts tests/workflowViewer.ui.test.ts tests/server.test.ts
bun test tests/
bun tsc --noEmit
rg -n "from ['\"]@smthrs/db/ensure|ensureSmithersTables\(|ensureSqlMessageStorage\(|ensureSchema\(" src/smithersProject
rg -n "\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b.*_smithers|_smithers_.*\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b" src/smithersProject src/server.ts
```

#### Drift tripwires

- Integration must fail if `runs/<runId>/plan.json` is required.
- Integration must fail if `/api/smithers/runs/:runId` returns legacy artifact status over DB status.
- Grep/review must classify all remaining legacy artifact references.
- No new persistent CustomHarness workflow/run IR introduced.

#### Test-writer prompt

```txt
Write failing tests only for Task 7: end-to-end Smithers smoke and drift guard sweep.

Scope:
- Edit tests/workflowViewer.run.integration.test.ts.
- Edit tests/smithersRunReader.test.ts and tests/workflowViewer.ui.test.ts only for final integration assertions.
- Add test fixtures under tests/fixtures/ if needed.
- Do not make broad production changes.

Test requirements:
- Real project-mode Smithers run starts through POST /api/workflows/:id/run.
- Response includes inspection.url.
- Polling inspection.url eventually returns a DB-backed run detail row from Smithers SQLite.
- Detail includes node state from SQLite.
- Detail includes at least one event or attempt when the fixture reliably produces it.
- Detail includes frame metadata when reliably present.
- Detail includes output row if the fixture workflow produces output.
- Test does not depend on CustomHarness runs/<runId>/plan.json, run.json, or events.jsonl.
- Contradictory legacy artifacts do not affect /api/smithers/runs/:runId.

Rules:
- The primary integration proof must use Smithers runtime/CLI to create state; do not manually seed _smithers_* rows as the main proof.
- Keep the fixture tiny and deterministic.
- Do not add workflow editing, fork/replay UI, new persistence, or overlay storage.
- It is acceptable to keep deterministic reader fixture tests alongside the real-run smoke if Smithers event/output timing is flaky.

Validation to run:
- bun test tests/workflowViewer.run.integration.test.ts tests/smithersRunReader.test.ts tests/workflowViewer.ui.test.ts

Expected result before implementation/final fixes:
- Tests fail if inspection still depends on legacy artifacts or real Smithers state is not exposed through /api/smithers/runs/:runId.

Stop rules:
- If the real Smithers fixture is flaky, preserve the smallest reliable smoke test, keep deterministic reader tests for the rest, and report the flake rather than switching to legacy runs/ artifacts.
```

#### Worker prompt

```txt
Implement Task 7 only: end-to-end Smithers smoke and drift guard sweep.

Scope:
- tests/workflowViewer.run.integration.test.ts
- tests/smithersRunReader.test.ts
- tests/workflowViewer.ui.test.ts
- tests/fixtures as needed
- Minimal bug fixes only in files touched by previous tasks

Requirements:
- Real project-mode run starts through POST /api/workflows/:id/run.
- Response includes inspection.url.
- /api/smithers/runs/:runId reads SQLite and returns run/node/attempt-or-event/frame/output evidence.
- Test must not depend on CustomHarness runs/ JSON.
- Run grep drift checks and document/classify remaining legacy-only matches in test comments or final summary.

Non-goals:
- Do not add editing/fork/replay.
- Do not create beads.
- Do not manually seed _smithers_* rows as the main proof.

Validation:
- bun test tests/
- bun tsc --noEmit
- global drift grep checks

Stop rules:
- If real Smithers run fixture is flaky, keep a smaller integration proof plus deterministic reader fixture, and report the flake. Do not replace SQLite inspection with legacy runs/ artifacts.
```

## Recommended Execution Order

Recommended for AFK execution: **one agent serially**.

Reason:

- The highest-risk files are shared choke points: `src/server.ts` and `web/index.html`.
- The architectural drift risk is mostly cross-slice: reader DTOs, server route behavior, and UI polling must agree.
- A single serial agent is less likely to accidentally reintroduce `runs/` JSON as project-mode truth or preserve `promptOverrides`.

Semi-AFK alternative:

- Agent A owns Tasks 1–2 (`src/smithersProject/*`, `tests/smithersRunReader.test.ts`).
- Agent B starts Task 3 only after Task 1 exports stable types, using a fake reader seam.
- Agent C starts UI helper tests after Task 2 DTOs exist, but must wait to edit `web/index.html` until Task 5.
- Merge order must still be Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7.

Do **not** run multiple agents concurrently on `src/server.ts` or `web/index.html` in the same worktree.

## Out-of-scope follow-ups

- Workflow editing.
- Metadata-backed source field saving.
- Smithers fork/replay UI.
- Smithers time-travel/frame-rich graph reconstruction.
- Custom DB path discovery beyond `<projectRoot>/smithers.db`.
- New CustomHarness workflow/run persistence.
- Deleting legacy `runs/` compatibility paths.
- Manual writes to `_smithers_*` tables or workflow output tables.
- Making `RenderGraph` a persisted workflow IR.
- Project-mode ad-hoc `promptOverrides` or “run with edits” behavior.
