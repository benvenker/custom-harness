# Smithers-First Hardening Follow-ups

Status: implementation-grade plan, bead-ready after final owner review

## Purpose

This plan turns the post-implementation oracle review of CustomHarness project-mode Smithers support into a focused hardening track. The goal is not new product scope. The goal is to close the remaining correctness gaps that could let project-mode drift away from the accepted Smithers-first decisions.

Current direction is solid: project-mode run inspection is backed by Smithers SQLite, project-mode prompt overrides are rejected, legacy `runs/` artifacts are isolated to compatibility flows, and a real Smithers run smoke exists. The remaining work is edge hardening around live UI truth, Smithers CLI invocation portability, reader query semantics, read-only DB discovery, event cursor/warning fidelity, and regression guard quality.

## Required context before implementation

Every implementation agent must preserve these project decisions:

- `AGENTS.md`
- `CONTEXT.md`
- `docs/adr/0001-runs-in-smithers-canonical-location.md`
- `docs/adr/0003-reflect-smithers-first-smooth-with-overlays.md`
- `docs/adr/0004-project-mode-run-inspection-reads-smithers-sqlite.md`
- `docs/plans/live-smithers-run-inspection-task-breakdown.md`

Important local Smithers evidence:

- Smithers workflow IDs are discovered from `<projectRoot>/.smithers/workflows/*.tsx`; workflow commands use `process.cwd()` as project root. Evidence: `node_modules/@smithers-orchestrator/cli/src/workflows.js:11-15`, `node_modules/@smithers-orchestrator/cli/src/workflows.js:84-87`, `node_modules/@smithers-orchestrator/cli/src/index.js:1736-1739`, `node_modules/@smithers-orchestrator/cli/src/index.js:1756-1761`.
- `workflow run` normalizes `--root` to `.` when not supplied and passes it through to detached `up`. Evidence: `node_modules/@smithers-orchestrator/cli/src/index.js:1375-1388`, `node_modules/@smithers-orchestrator/cli/src/index.js:1455-1470`.
- The published `smithers` bin delegates to `<projectRoot>/.smithers/node_modules/.bin/smithers` when invoked from project root and that local bin exists. Evidence: `node_modules/smithers-orchestrator/src/bin/smithers.js:8-24`.
- Smithers adapter `listRuns(limit, status)` applies SQL status filtering and limit before returning rows; for `status === "running"` it includes `continued`. Evidence: `node_modules/@smithers-orchestrator/db/src/adapter/SmithersDb.js:826-839`.

## Non-negotiable invariants

1. Smithers SQLite (`smithers.db`) is authoritative for project-mode run state.
2. CustomHarness `runs/` JSON is legacy/prototype compatibility only.
3. Project-mode run inspection must not depend on `runs/<runId>/plan.json`, `run.json`, or `events.jsonl`.
4. Workflow definitions live in ordinary Smithers workflow-pack source: `.smithers/workflows/*.tsx`, `.smithers/prompts/*`, `.smithers/components/*`.
5. CustomHarness graph data is a visual projection of Smithers `GraphSnapshot`, not persisted workflow truth.
6. Do not build a parallel workflow runtime, run database, or persisted workflow IR.
7. Do not manually mutate `_smithers_*` tables or workflow output tables.
8. Writes must go through Smithers runtime/CLI/API surfaces.
9. DB readers must be read-only and must not import or call Smithers schema mutators.
10. Legacy compatibility may remain, but project-mode must not route through it.

## Current architecture snapshot

### Project-mode run inspection

- `src/smithersProject/sqliteReadOnly.ts:37-51` resolves `<projectRoot>/smithers.db`, opens it with Bun SQLite `readonly: true`, and applies `PRAGMA query_only = ON`.
- `src/smithersProject/runReader.ts:47-117` exposes `SmithersRunReader` methods for runs, run detail, and events.
- `src/server.ts:139-160` routes `GET /api/smithers/runs`, `GET /api/smithers/runs/:runId/events`, and `GET /api/smithers/runs/:runId` to the reader.
- `src/server.ts:411-489` builds query options and closes the reader per request.

### Project-mode run launch

- `src/server.ts:609-642` rejects non-empty project-mode `promptOverrides`, calls the project runner with `{ projectRoot, workflowId, workflowPath, input }`, and returns `inspection.url`.
- `src/server.ts:673-693` currently launches `bun node_modules/.bin/smithers workflow run <workflowId> --input <json> --detach --format json --root .` from `projectRoot`.

### UI live inspection

- `src/ui/workflowRunUi.ts:19-23` builds project Start Full Run payloads as `{ input }` only.
- `web/index.html:2610-2652` starts a project run, sets live Smithers metadata, and starts inspection polling.
- `web/index.html:2487-2557` polls `/api/smithers/runs/:runId?...`, merges event pages, stores `smithersRunDetail`, and applies `buildSmithersRunOverlayState()` when possible.
- `src/ui/smithersRunOverlay.ts:83-119` overlays DB-backed node status onto the preview graph.
- `src/ui/smithersRunOverlay.ts:127-212` builds live inspector state from DB attempts, outputs, events, and frame summaries.
- Legacy `waitForRunToRender()` remains for legacy run artifacts at `web/index.html:2476-2484`; it must stay unreachable from project-mode Start Full Run.

## What is already strong and should not be churned

Do not rewrite these unless a package below explicitly requires it:

- The basic `SmithersRunReader` contract and DTO names.
- The DB-backed `/api/smithers/runs*` endpoint shape.
- Project-mode prompt override rejection.
- The visual projection approach based on `smithersSnapshotToRenderGraph`.
- Legacy `/runs/*` compatibility paths, as long as they remain isolated.
- The real-run integration smoke proving SQLite-backed project-mode inspection.

## Required-before-ship vs nice-to-have

Required before calling the Smithers-first project-mode hardening track complete:

1. Package 1 — live UI render state guard.
2. Package 3 — workflow-filtered run listing correctness.
3. Package 2 — robust Smithers CLI resolution for project runs.
4. Package 5 — events endpoint parse warnings and cursor continuity.
5. The drift-guard subset of Package 6.

Strongly recommended, but can ship one milestone later if bead capacity is tight:

- Package 4 — nearest read-only `smithers.db` discovery. Current `<projectRoot>/smithers.db` behavior is correct for the present server mode, but ADR 0004 says nearest DB; add this before supporting nested project roots or workflow-path entry.
- Integration flake reduction parts of Package 6 that do not guard architectural invariants.

Nice-to-have / explicitly out of current scope:

- Smithers fork/replay UI.
- Workflow authoring beyond existing source save/re-render behavior.
- Historical frame-to-rich-graph reconstruction.
- Deleting legacy `runs/` compatibility paths.

## Package 1 — Live project-mode render state guard

### Goal

Ensure the browser never labels preview graph truth as `Smithers SQLite · live run` truth. During live project-mode inspection, any graph rendered under live provenance must be overlaid with DB-backed `SmithersRunDetail`, or the UI must explicitly exit live mode/provenance first.

### Why this matters

The accepted architecture allows preview graphs as visual projections, but live run status must come from Smithers SQLite. If a preview refresh replaces the displayed graph while live provenance remains active, the UI communicates false run state and violates ADR 0004.

### Current evidence

- `web/index.html:2545-2550` applies DB overlay during polling, but if the overlay helper throws it logs a warning and assigns `SAMPLES._project = currentWorkflowGraph` while `liveSmithers` metadata remains active.
- `web/index.html:2820-2821` in `refreshProjectGraphFromInput()` assigns a fresh preview graph to `SAMPLES._project` and renders it; it does not reapply `currentRunMeta.smithersRunDetail` and does not clear live mode.
- `web/index.html:2487-2557` has the polling path that stores `smithersRunDetail`; this is the state the refresh path should reuse.
- `src/ui/smithersRunOverlay.ts:83-119` already has the correct overlay primitive; the bug is state-machine ownership, not graph mapping.
- Existing UI tests cover payload and polling helpers (`tests/workflowViewer.ui.test.ts:389-529`) and overlay helpers (`tests/workflowViewer.ui.test.ts:532-672`), but not the live-detail → preview-refresh sequence.

### Recommended implementation shape

Add a tiny pure helper, preferably in `src/ui/projectLiveState.ts`, that owns this decision:

```ts
type ProjectRenderedGraphDecision =
  | { mode: 'preview'; graph: RenderGraph; provenance: { liveSmithers: false } }
  | { mode: 'live'; graph: RenderGraph; provenance: { liveSmithers: true; status: string } }
  | { mode: 'live-overlay-error'; graph: null; error: string; provenance: { liveSmithers: false } };
```

The exact type can differ, but behavior must be explicit:

- If `liveMode && liveDetail`, return `buildSmithersRunOverlayState({ graph: previewGraph, detail }).graph` and live provenance.
- If no live detail exists, return preview graph with preview provenance.
- If overlay fails, do **not** return an un-overlaid preview graph with live provenance. Either clear live mode and show preview provenance with an error status, or show an error state and keep the previous live graph.

Update both callsites to use the same helper:

- Poll path: `web/index.html:2487-2557`.
- Preview refresh path: `web/index.html:2815-2823`.

Preferred UX decision: preserve live overlay when `currentRunMeta.smithersRunDetail` exists. If the user edits input/source during a live run, keep the refreshed preview as the visual base but immediately overlay DB state and keep provenance live. Only clear live mode on an explicit action such as selecting a sample, selecting a legacy run, or pressing a future “return to preview” control.

### Bad implementations to avoid

- Do not silently catch overlay errors and show preview status under live provenance.
- Do not copy overlay fallback logic into multiple places.
- Do not make preview graph node `status` the source for live status.
- Do not fetch `runs/<runId>/plan.json` as a fallback for project mode.
- Do not disable preview refresh entirely during a live run; that hides the state bug instead of defining ownership.

### Test-first plan

Write failing tests before implementation:

1. `deriveProjectRenderedGraph()` with `liveMode: true`, preview node `running`, and DB node `finished` returns node visual status `done`, live provenance, and raw Smithers status copy.
2. Preview refresh while `liveDetail` exists still returns an overlaid graph, not the raw refreshed preview graph.
3. Overlay failure does not return preview graph plus `liveSmithers: true`; assert either an error decision or preview provenance with live mode cleared.
4. Existing Start Full Run test still proves payload is `{ input }` only and no legacy `/runs/:id/plan.json` is fetched.
5. Existing live inspector tests still prove pretend output controls are preview-only.

Expected current failing behavior: there is no shared helper, and `refreshProjectGraphFromInput()` currently assigns raw preview graph directly.

### Acceptance criteria

- Project-mode Start Full Run still polls `/api/smithers/runs/:runId`.
- Preview refresh during live mode preserves DB overlay when live detail exists.
- Overlay failure cannot display preview truth as live DB truth.
- Provenance text matches the actual graph source.
- Pretend output controls remain disabled/preview-only in live mode.

### Drift guards

```bash
bun test tests/workflowViewer.ui.test.ts
bun tsc --noEmit
rg -n "waitForRunToRender\(|/runs/\$\{encodeURIComponent\(runId\)\}/plan\.json|promptOverrides" web/index.html
rg -n "events\.jsonl|smithersSnapshotToRenderGraph|_smithers_frames" web/index.html src/ui
```

Review allowed matches: legacy run browser code may mention `events.jsonl`; project live-run code must not.

### Dependencies / ordering notes

- No dependency on reader/server packages.
- Single-writer file: `web/index.html`. Do not run this package concurrently with other UI package work.
- Can run in parallel with Package 3 or Package 4 if those agents do not edit UI files.

## Package 2 — Robust Smithers CLI resolution for project runs

### Goal

Launch project-mode Smithers runs in real workflow-pack layouts without assuming CustomHarness-style root `node_modules`.

### Why this matters

Current project launch can fail for valid Smithers workflow packs whose dependencies live under `.smithers/node_modules`, even though Smithers’ own bin supports local delegation from project root. A project-mode run should use saved Smithers workflow source and project-root Smithers conventions, not a CustomHarness fixture layout.

### Current evidence

- `src/server.ts:673-693` hard-codes `bun node_modules/.bin/smithers ...` from `projectRoot`.
- `tests/workflowViewer.run.integration.test.ts:55-56` symlinks both `projectRoot/node_modules` and `projectRoot/.smithers/node_modules`, which masks the root-binary assumption.
- `node_modules/smithers-orchestrator/src/bin/smithers.js:8-24` delegates a globally resolved/package bin to `.smithers/node_modules/.bin/smithers` when invoked from project root and a local workflow-pack bin exists.
- `node_modules/@smithers-orchestrator/cli/src/index.js:1736-1739` resolves `workflow run <id>` from `process.cwd()`, so the command must run from `projectRoot`.

### Recommended implementation shape

Resolve this open decision now: **use local-first command resolution, with `bunx smithers-orchestrator` as fallback**.

Rationale:

- Local root bin keeps current projects deterministic when they already install Smithers at root.
- `.smithers/node_modules/.bin/smithers` supports the workflow-pack dependency layout directly.
- `bunx smithers-orchestrator` is documented and can delegate to `.smithers/node_modules` when run from project root, but as the only path it may pull a version that differs from the project.

Extract command construction into a pure helper, e.g. `src/smithersProject/cli.ts`:

```ts
type SmithersCliCommand = { cmd: string[]; cwd: string; source: 'root-local' | 'workflow-pack-local' | 'bunx' };
```

Recommended fallback order:

1. If `<projectRoot>/node_modules/.bin/smithers` exists, run `bun <that-relative-or-absolute-bin> workflow run ...` from `projectRoot`.
2. Else if `<projectRoot>/.smithers/node_modules/.bin/smithers` exists, run `bun <that-bin> workflow run ...` from `projectRoot`.
3. Else run `bunx smithers-orchestrator workflow run ...` from `projectRoot`.

Keep the command source-backed and project-rooted:

```bash
workflow run <workflowId> --input '<json>' --detach --format json --root .
```

Do not add `--log-dir .smithers/executions`; Smithers normalizes `workflow run` root to `.` and detached `up` receives `--root .` (`node_modules/@smithers-orchestrator/cli/src/index.js:1375-1388`, `:1455-1470`). DB state remains authoritative even if Smithers’ detached log-file behavior changes.

### Bad implementations to avoid

- Do not run from `.smithers/`; Smithers workflow discovery expects project root.
- Do not require root `node_modules` when `.smithers/node_modules` exists.
- Do not route project-mode runs through `runSmithersWorkflow()` or `createRunRecorder()`.
- Do not reintroduce project-mode `promptOverrides` to work around source edits.
- Do not manually create `smithers.db` or `_smithers_*` rows after spawning.

### Test-first plan

Write failing tests before implementation:

1. Pure command helper test: root local bin exists → chooses `root-local` and includes `workflow run foo --input <json> --detach --format json --root .`.
2. Pure command helper test: only `.smithers/node_modules/.bin/smithers` exists → chooses `workflow-pack-local`, keeps `cwd = projectRoot`, and does not require root `node_modules`.
3. Pure command helper test: no local bin → chooses `bunx smithers-orchestrator ...`.
4. Route-level seam test remains: fake runner receives only `{ projectRoot, workflowId, workflowPath, input }`, no `promptOverrides`.
5. Integration fixture should stop symlinking root `node_modules` solely to satisfy launch. If real `.smithers/node_modules` fixture setup is too slow, keep a fake spawn/command-selection test and document the integration limitation.

Expected current failing behavior: only root `node_modules/.bin/smithers` can be selected.

### Acceptance criteria

- Existing project run route tests continue passing.
- New tests cover root-local, `.smithers`-local, and `bunx` fallback command construction.
- Project runner still returns `inspection.url` through the existing route.
- Integration no longer depends on a root `node_modules` symlink as the only way to launch.

### Drift guards

```bash
bun test tests/workflowViewer.run.test.ts tests/workflowViewer.run.integration.test.ts
bun tsc --noEmit
rg -n "promptOverrides|runSmithersWorkflow\(|--log-dir|createRunRecorder" src/server.ts src/smithersProject
```

Remaining `promptOverrides` matches in `src/server.ts` must be legacy `/api/smithers-runs` or `/api/runs/:id/rerun`, not project `POST /api/workflows/:id/run`.

### Dependencies / ordering notes

- No dependency on Package 1.
- Single-writer file: `src/server.ts`. Do not run concurrently with any other `src/server.ts` work.
- If adding `src/smithersProject/cli.ts`, it can be implemented/tested in parallel, but only one agent should integrate it into `src/server.ts`.

## Package 3 — Correct workflow-filtered run listing

### Goal

Make `SmithersRunReader.listRuns({ workflowId, limit })` return the newest matching workflow runs, not the newest global runs filtered after the limit.

### Why this matters

`/api/smithers/runs?workflowId=foo&limit=N` should be a reliable project-mode run list. Filtering after a global limit can show zero `foo` runs even when matching runs exist just below newer runs for other workflows.

### Current evidence

- `src/smithersProject/runReader.ts:59-62` calls `handle.adapter.listRuns(options.limit ?? 50, options.status)` and then filters with `matchesWorkflowId()`.
- Smithers adapter `listRuns(limit, status)` applies `ORDER BY created_at_ms DESC LIMIT ?` in SQL before CustomHarness sees rows. Evidence: `node_modules/@smithers-orchestrator/db/src/adapter/SmithersDb.js:826-839`.
- `matchesWorkflowId()` already encodes the intended name/path matching at `src/smithersProject/runReader.ts:263-272`.

### Recommended implementation shape

Resolve this open decision now: **localized read-only SQL inside `runReader.ts` is acceptable for this prototype**.

Rationale: Smithers adapter does not currently expose workflow-filtered list semantics. Pulling a huge page and filtering in memory is still approximate. A reader-local SQL query keeps raw SQL contained behind the adapter boundary and preserves ADR 0004’s “through adapter surfaces where possible” intent.

Implement:

- If `workflowId` is absent, keep `handle.adapter.listRuns(limit, status)` behavior.
- If `workflowId` is present, use `handle.queryAll()` with a read-only `SELECT` from `_smithers_runs`.
- Match `workflow_name = ?` OR normalized path suffixes for `.smithers/workflows/<workflowId>.tsx`. SQLite path matching should handle `/` and, if cheap, `\` separators.
- For `status === 'running'`, match Smithers adapter semantics: `(status = 'running' OR status = 'continued')`.
- Otherwise match exact status when supplied.
- Order by `created_at_ms DESC`, then tie-break by `run_id ASC`, then apply `LIMIT ?`.
- Map through `toRunSummary(row, [])` and preserve DTO shape.

### Bad implementations to avoid

- Do not put raw SQL in `src/server.ts`.
- Do not over-fetch a fixed multiplier and call it correct.
- Do not change unfiltered list behavior except tests needed to document tie-breaking.
- Do not add any SQL write statements, schema creation, or migration helpers.
- Do not use legacy `runs/index.json` to supplement lists.

### Test-first plan

Write failing tests before implementation:

1. Fixture with 10 newer `bar` runs and 2 older `foo` runs; `listRuns({ workflowId: 'foo', limit: 2 })` returns both `foo` runs.
2. Same fixture through `/api/smithers/runs?workflowId=foo&limit=2` if a fake reader is insufficient; the route should pass options, while reader test proves semantics.
3. `status: 'running'` with one `running` and one `continued` matching run returns both, matching Smithers adapter behavior.
4. Path-only match where `workflow_name` differs but `workflow_path` ends in `.smithers/workflows/foo.tsx` returns for `workflowId: 'foo'`.

Expected current failing behavior: global limit drops older matching workflow runs.

### Acceptance criteria

- Workflow-filtered list applies workflow filter before limit.
- Unfiltered `listRuns()` remains adapter-backed and compatible.
- `status === 'running'` includes `continued` for parity with Smithers adapter.
- All raw SQL stays in `src/smithersProject/runReader.ts` or a reader-local helper.

### Drift guards

```bash
bun test tests/smithersRunReader.test.ts tests/server.test.ts
bun tsc --noEmit
rg -n "\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b.*_smithers|_smithers_.*\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b" src/smithersProject src/server.ts
rg -n "runs/index\.json|plan\.json|run\.json|events\.jsonl|createRunRecorder" src/smithersProject
```

### Dependencies / ordering notes

- No dependency on UI or CLI packages.
- Can run in parallel with Package 1.
- Should land before Package 5 if both edit `src/smithersProject/runReader.ts` to minimize merge conflicts.

## Package 4 — Nearest read-only Smithers DB discovery

### Goal

Make project-mode run inspection resolve the nearest existing `smithers.db` without creating, migrating, or opening it write-capable.

### Why this matters

ADR 0004 says project-mode run state comes from the nearest `smithers.db`. Current server mode passes a project root, so `<projectRoot>/smithers.db` works today, but nested launch modes or workflow-path entry will need nearest-db semantics. Adding this now prevents future compatibility hacks.

### Current evidence

- `src/smithersProject/sqliteReadOnly.ts:37-44` resolves only `resolve(projectRoot, 'smithers.db')` and throws if missing.
- `src/smithersProject/sqliteReadOnly.ts:47-51` correctly opens readonly and applies `PRAGMA query_only = ON`; preserve this behavior.
- ADR 0004 explicitly says read the nearest `smithers.db` and avoid Smithers CLI `openSmithersDb()` style helpers if they ensure schemas or write.

### Recommended implementation shape

Resolve the open decision as: **support both starts, with `workflowPath`/explicit `dbSearchStart` taking priority over `projectRoot`**.

Implementation details:

- Extend `SqliteReadOnlyOpenOptions` with optional `dbPath` and `dbSearchStart` (or `workflowPath`; prefer the more general `dbSearchStart`).
- Resolution order:
  1. If explicit `dbPath` is supplied, require it to exist and open readonly.
  2. Else if `dbSearchStart` is supplied, walk upward from the file’s directory if it looks like a file path, or from the directory itself, returning the first existing `smithers.db`.
  3. Else walk upward from `projectRoot`, with the first check preserving current `<projectRoot>/smithers.db` behavior.
- Expose `dbPath` on the handle already exists; keep it for diagnostics.
- Never call Smithers schema mutators or CLI DB open helpers.
- Missing DB must remain a controlled `SMITHERS_DB_NOT_FOUND` error and must not create a file.

### Bad implementations to avoid

- Do not import `@smithers-orchestrator/cli/src/find-db.js` if it opens write-capable connections or ensures tables.
- Do not create an empty `smithers.db` to satisfy reads.
- Do not search downward through project trees; nearest DB means upward from a known start.
- Do not silently fall back to legacy `runs/` artifacts when DB is missing.

### Test-first plan

Write failing tests before implementation:

1. Existing project-root DB test still resolves `<projectRoot>/smithers.db`.
2. Nested start path under `<projectRoot>/packages/app/.smithers/workflows/foo.tsx` resolves parent `<projectRoot>/smithers.db`.
3. Explicit `dbPath` resolves that file even if `projectRoot` has a different DB.
4. No DB anywhere returns `SMITHERS_DB_NOT_FOUND` and creates no files in searched directories.
5. Existing write probes still fail through the resolved handle.

Expected current failing behavior: nested start options do not exist and only project-root DB is checked.

### Acceptance criteria

- Current project-root behavior is unchanged.
- Nearest upward DB discovery works from nested directories/file paths.
- The resolved path is visible as `handle.dbPath`.
- Read-only/query-only protections and tests remain intact.

### Drift guards

```bash
bun test tests/smithersRunReader.test.ts
bun tsc --noEmit
rg -n "from ['\"]@smithers-orchestrator/db/ensure|ensureSmithersTables\(|ensureSqlMessageStorage\(|ensureSchema\(" src/smithersProject
rg -n "openSmithersDb\(|findAndOpenDb\(" src/smithersProject
```

### Dependencies / ordering notes

- Can run after Package 3 or in a separate branch if only `sqliteReadOnly.ts` is touched.
- If server starts passing `workflowPath`/`dbSearchStart` into the reader, coordinate with Package 2 because both may edit `src/server.ts`.

## Package 5 — Events endpoint parse warnings and cursor semantics

### Goal

Make `/api/smithers/runs/:runId/events` as robust as detail polling for malformed event JSON and empty event pages.

### Why this matters

The UI polling path needs stable cursors and visibility into parse problems. The detail endpoint already exposes parse warnings; the events endpoint currently turns malformed payloads into `payload: null` without surfacing why, and empty pages can return a null cursor that is awkward for pollers.

### Current evidence

- `src/smithersProject/runReader.ts:100-114` creates `parseWarnings` while mapping events, but returns only `{ events, cursors }`.
- `src/smithersProject/runReader.ts:281-286` returns `{ nextEventSeq: null }` when no events are returned and no `lastEventSeq` argument is supplied.
- `src/server.ts:467-489` passes through whatever `reader.listEvents()` returns.
- `SmithersRunEventsResult` lacks `parseWarnings` at `src/smithersProject/runReaderTypes.ts:103-106`.

### Recommended implementation shape

Resolve the cursor decision now: **`nextEventSeq` means “last seen event seq to send as the next `afterSeq` value.”**

Implement:

- Add `parseWarnings?: SmithersParseWarning[]` to `SmithersRunEventsResult` with a type comment documenting optionality for backward compatibility.
- In `listEvents()`, return parse warnings when non-empty.
- Preserve monotonic cursor on empty pages:
  - Prefer `handle.adapter.getLastEventSeq(runId)` when cheap/available, then `max(lastSeq, afterSeq)`.
  - If adapter last seq is unavailable, return requested `afterSeq` when provided.
  - Keep null only when no events exist and caller supplied no cursor.
- Keep detail endpoint behavior compatible; it may continue returning full `parseWarnings` in `SmithersRunDetail`.

### Bad implementations to avoid

- Do not throw the whole events endpoint on malformed JSON.
- Do not reset `nextEventSeq` to `null` after a poller has supplied `afterSeq=N`.
- Do not change `nextEventSeq` to mean “next row number”; current API uses last seen seq.
- Do not read `events.jsonl` for project-mode timeline enrichment.

### Test-first plan

Write failing tests before implementation:

1. Fixture with malformed event payload: `reader.listEvents('run-bad-json')` returns `parseWarnings` containing `field: 'event.payloadJson'` and still returns the event with `payload: null`.
2. Empty page after `afterSeq=3` returns `cursors.nextEventSeq >= 3`, ideally exactly DB last seq when known.
3. Server endpoint `GET /api/smithers/runs/:runId/events` passes `parseWarnings` through from a fake reader.
4. Existing detail malformed JSON test remains unchanged.

Expected current failing behavior: events endpoint result has no warnings, and empty event pages without last-event context can return null.

### Acceptance criteria

- Events endpoint surfaces parse warnings without failing.
- Empty event pages preserve cursor continuity.
- UI polling still works with `eventsAfterSeq` / `afterSeq` values.
- Type comments clarify cursor meaning.

### Drift guards

```bash
bun test tests/smithersRunReader.test.ts tests/server.test.ts tests/workflowViewer.ui.test.ts
bun tsc --noEmit
rg -n "events\.jsonl" src/smithersProject src/server.ts src/ui web/index.html
```

Review allowed matches: legacy browser paths in `web/index.html` only; no project-mode reader/server/UI live-inspection code should use `events.jsonl`.

### Dependencies / ordering notes

- Prefer after Package 3 to avoid concurrent edits in `runReader.ts`.
- No `src/server.ts` behavior change is needed if the route already spreads the result, but add a server fake-reader passthrough test.

## Package 6 — Test hardening and drift guard sweep

### Goal

Make the Smithers-first guardrails difficult to regress without turning tests into brittle source-text snapshots.

### Why this matters

The current tests are valuable, but some guardrails are regex-heavy and some integration assertions assume specific Smithers event names. We need tests that fail on architectural drift and tolerate harmless upstream Smithers event naming changes.

### Current evidence

- `tests/workflowViewer.ui.test.ts:526-530` uses regex over `web/index.html` to prove `waitForRunToRender()` is absent from the project branch. This is useful but brittle; Package 1 helper tests should become the stronger guard.
- `tests/workflowViewer.run.integration.test.ts:153-157` requires specific event names: `NodePending`, `NodeFinished`, `RunFinished`.
- `docs/plans/live-smithers-run-inspection-task-breakdown.md` lists global drift tripwires that should be encoded where stable.

### Recommended implementation shape

Keep one final sweep bead, but each functional bead must include its own focused tests. Package 6 should only add cross-cutting guards and reduce flake.

Add or strengthen tests for:

- No schema mutator imports in `src/smithersProject/*`.
- No manual SQL writes to `_smithers_*` tables or workflow output tables in project-mode code.
- `/api/smithers/runs*` contradictory legacy artifact trap stays in place.
- Project-mode Start Full Run payload remains `{ input }` only.
- Project-mode live inspection does not fetch `/runs/:id/plan.json`, `/run.json`, or `/events.jsonl`.
- Reader does not call `smithersSnapshotToRenderGraph()` or reconstruct rich `RenderGraph` from `_smithers_frames`.
- Integration smoke requires real SQLite-backed run detail with run row, node evidence, at least one attempt or event, frame metadata when reliably present, and output rows when fixture produces them.

For integration flake:

- Prefer asserting `detail.events.length > 0` and no `LegacyEvent` over exact event names, unless the event names are part of the public contract being tested.
- Keep attempt/output/frame assertions as the stronger proof of SQLite state.
- Preserve the contradictory legacy artifacts test in the real-run smoke.

### Bad implementations to avoid

- Do not replace behavior tests with only `rg` snapshots.
- Do not weaken the real-run smoke into a manually seeded DB test; seeded reader tests are complementary, not a substitute.
- Do not make tests depend on CustomHarness `runs/<runId>/plan.json`.
- Do not add sleeps longer than needed; poll with bounded time and useful failure output.

### Test-first plan

Write failing tests only for missing guards. Suggested additions:

1. Source guard test that scans `src/smithersProject` for schema mutator imports and manual `_smithers_*` write SQL.
2. Source guard test that scans project-mode UI helper/live path for forbidden `/runs/:id/*` fetches where practical.
3. Integration smoke change: replace exact event-name assertion with tolerant event/attempt evidence while still rejecting `LegacyEvent`.
4. If Package 1 creates `projectLiveState.ts`, replace the brittle `waitForRunToRender()` branch regex with helper-level state transition tests and leave only a small route smoke.

### Acceptance criteria

- `bun test tests/` remains fast and deterministic.
- Drift checks fail on project-mode legacy artifact usage or DB mutator imports.
- Real-run integration still proves SQLite-backed inspection.
- Remaining grep-only checks are documented as review tripwires, not the sole proof of behavior.

### Drift guards

```bash
bun test tests/
bun tsc --noEmit
rg -n "from ['\"]@smithers-orchestrator/db/ensure|ensureSmithersTables\(|ensureSqlMessageStorage\(|ensureSchema\(" src/smithersProject
rg -n "\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b.*_smithers|_smithers_.*\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b" src/smithersProject src/server.ts
rg -n "createRunRecorder|runs/index\.json|plan\.json|run\.json|events\.jsonl|workflowGraph" src/smithersProject src/server.ts web/index.html
br dep cycles --json
```

Review allowed matches: legacy compatibility routes/UI and tests may mention `runs/*`; project-mode reader and `/api/smithers/runs*` must not.

### Dependencies / ordering notes

- Run after Packages 1, 2, 3, and 5.
- Can include Package 4 guards if Package 4 lands in the same milestone.
- Avoid large rewrites of `web/index.html`; prefer helper extraction already introduced by Package 1.

## Execution-agent checklist

Use this section when converting packages into beads. Each implementation agent should read exactly the relevant rows before editing, then run the listed grep checks.

### Package 1 checklist — live project-mode render state guard

Read before editing:

- `AGENTS.md`
- `docs/adr/0003-reflect-smithers-first-smooth-with-overlays.md`
- `docs/adr/0004-project-mode-run-inspection-reads-smithers-sqlite.md`
- `web/index.html:2476-2557`
- `web/index.html:2610-2652`
- `web/index.html:2815-2823`
- `src/ui/workflowRunUi.ts`
- `src/ui/smithersRunOverlay.ts`
- `tests/workflowViewer.ui.test.ts:389-672`

Run before editing / during review:

```bash
rg -n "pollProjectRunInspectionOnce|refreshProjectGraphFromInput|SAMPLES\._project|currentRunMeta|smithersRunDetail|setProvenance" web/index.html
rg -n "buildSmithersRunOverlayState|buildSmithersRunInspectorState" src/ui tests/workflowViewer.ui.test.ts
rg -n "waitForRunToRender\(|/runs/" web/index.html
```

### Package 2 checklist — Smithers CLI resolution

Read before editing:

- `CONTEXT.md` CLI/cwd section
- `docs/plans/live-smithers-run-inspection-task-breakdown.md` Task 4
- `src/server.ts:609-693`
- `tests/workflowViewer.run.test.ts`
- `tests/workflowViewer.run.integration.test.ts:1-170`
- `node_modules/smithers-orchestrator/src/bin/smithers.js:8-24`
- `node_modules/@smithers-orchestrator/cli/src/workflows.js:11-15`, `:84-87`
- `node_modules/@smithers-orchestrator/cli/src/index.js:1375-1388`, `:1455-1470`, `:1736-1739`

Run before editing / during review:

```bash
rg -n "node_modules/.bin/smithers|bunx smithers-orchestrator|workflow run|--root|--log-dir|runProjectWorkflow" src/server.ts tests
rg -n "promptOverrides|runSmithersWorkflow\(" src/server.ts tests/workflowViewer.run.test.ts
```

### Package 3 checklist — workflow-filtered run listing

Read before editing:

- `docs/adr/0004-project-mode-run-inspection-reads-smithers-sqlite.md`
- `src/smithersProject/runReader.ts:47-117`
- `src/smithersProject/runReader.ts:263-286`
- `src/smithersProject/sqliteReadOnly.ts`
- `src/smithersProject/runReaderTypes.ts`
- `tests/smithersRunReader.test.ts`
- `node_modules/@smithers-orchestrator/db/src/adapter/SmithersDb.js:826-839`

Run before editing / during review:

```bash
rg -n "listRuns|matchesWorkflowId|workflowId|queryAll|status === ['\"]running" src/smithersProject tests/smithersRunReader.test.ts
rg -n "\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b.*_smithers|_smithers_.*\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b" src/smithersProject src/server.ts
```

### Package 4 checklist — nearest read-only DB discovery

Read before editing:

- `docs/adr/0001-runs-in-smithers-canonical-location.md`
- `docs/adr/0004-project-mode-run-inspection-reads-smithers-sqlite.md`
- `src/smithersProject/sqliteReadOnly.ts`
- `src/smithersProject/runReader.ts:28-49`
- `tests/smithersRunReader.test.ts:1-380`

Run before editing / during review:

```bash
rg -n "resolveSmithersDbPath|openSmithersDbReadOnly|SmithersDbNotFoundError|readonly|query_only|dbPath|projectRoot" src/smithersProject tests/smithersRunReader.test.ts
rg -n "openSmithersDb\(|findAndOpenDb\(|ensureSmithersTables\(" src/smithersProject
```

### Package 5 checklist — events warnings/cursors

Read before editing:

- `src/smithersProject/runReaderTypes.ts:85-116`
- `src/smithersProject/runReader.ts:72-90`
- `src/smithersProject/runReader.ts:100-114`
- `src/smithersProject/runReader.ts:184-207`
- `src/smithersProject/runReader.ts:281-286`
- `src/server.ts:467-489`
- `tests/smithersRunReader.test.ts` malformed JSON and events tests
- `tests/server.test.ts` events endpoint tests
- `src/ui/workflowRunUi.ts:30-75`

Run before editing / during review:

```bash
rg -n "SmithersRunEventsResult|parseWarnings|listEvents|eventCursor|nextEventSeq|afterSeq|eventsAfterSeq" src/smithersProject src/server.ts src/ui tests
rg -n "events\.jsonl" src/smithersProject src/server.ts src/ui web/index.html
```

### Package 6 checklist — drift guard sweep

Read before editing:

- `docs/plans/live-smithers-run-inspection-task-breakdown.md` Global Drift Tripwires
- `tests/server.test.ts` DB-backed Smithers run inspection API tests
- `tests/workflowViewer.ui.test.ts` project live inspection helper tests
- `tests/workflowViewer.run.integration.test.ts`
- `tests/smithersRunReader.test.ts`
- `src/smithersProject/*`
- `src/server.ts` project-mode routes
- `web/index.html` project-mode run paths

Run before editing / during review:

```bash
rg -n "createRunRecorder|runs/index\.json|plan\.json|run\.json|events\.jsonl|workflowGraph" src/smithersProject src/server.ts web/index.html tests
rg -n "smithersSnapshotToRenderGraph|_smithers_frames" src/smithersProject src/ui web/index.html tests
rg -n "from ['\"]@smithers-orchestrator/db/ensure|ensureSmithersTables\(|ensureSqlMessageStorage\(|ensureSchema\(" src/smithersProject tests
```

## Execution order and parallelization

Use the same A/B split as the earlier Smithers run-inspection breakdown:

- **A bead — TDD test writer.** A read/write test agent writes failing tests and guard checks only. It must not edit production files. It must run the focused test command and confirm the failure is for the intended missing behavior, not fixture breakage.
- **B bead — implementation worker.** A separate chat/agent reads this plan, the A-bead test diff, and the A-bead failure output. It makes the minimal production changes needed to pass those tests, then runs focused tests, typecheck, and drift greps.

This split is intentional. It prevents the same agent from shaping both the tests and implementation too tightly, gives reviewers a clean red/green boundary, and makes each bead independently grabbable.

Recommended bead order:

1. **1A — Live render-state guard tests.**
2. **1B — Live render-state guard implementation.**
3. **3A — Workflow-filtered `listRuns()` tests.**
4. **3B — Workflow-filtered `listRuns()` implementation.**
5. **2A — Smithers CLI resolution tests.**
6. **2B — Smithers CLI resolution implementation.**
7. **5A — Events warnings/cursor tests.**
8. **5B — Events warnings/cursor implementation.**
9. **4A — Nearest DB discovery tests.**
10. **4B — Nearest DB discovery implementation.**
11. **6A — Drift/integration guard tests.**
12. **6B — Drift/integration hardening implementation.**

Rationale:

- Package 1 fixes the highest user-visible correctness risk.
- Package 3 is localized reader correctness with clear failing tests.
- Package 2 affects real project launch and integration fixture shape, so do it after the UI truth bug is contained.
- Package 5 is API fidelity and should follow the reader pagination change to avoid merge conflicts.
- Package 4 changes opener semantics but is not blocking current root-project usage.
- Package 6 should sweep after behavior changes land.

Dependency rules:

- Every `B` bead depends on its matching `A` bead.
- `3A/3B` should land before `5A/5B` because both touch `src/smithersProject/runReader.ts`.
- `1B` should land before `6A/6B` so the final sweep can replace brittle UI regex guards with helper-level behavior tests.
- `4A/4B` can move earlier if nested project-root support becomes required, but otherwise keep it after the required-before-ship reader/server fixes.

Parallelization:

- `web/index.html` is single-writer. Package 1 owns it; Package 6 should not edit it concurrently.
- `src/server.ts` is single-writer. Package 2 owns project-run integration; Package 5 should only touch it if adding endpoint passthrough tests requires source changes.
- `src/smithersProject/runReader.ts` is single-writer between Package 3 and Package 5.
- `src/smithersProject/sqliteReadOnly.ts` can be owned by Package 4 independently if no server callsite changes are made.
- A-bead test writers may run in parallel only when they do not edit the same test file. In this plan, `tests/workflowViewer.ui.test.ts`, `tests/smithersRunReader.test.ts`, and `tests/workflowViewer.run.integration.test.ts` are shared choke points, so serialize A beads that touch the same test file.
- UI and reader packages can run in parallel in separate worktrees if they do not share test helper files.

### A-bead test-writer contract

Each A bead should include this contract in the bead body:

- Edit tests only, plus tiny test fixtures if required.
- Do not edit production files.
- Do not weaken existing tests.
- Write the smallest failing tests that capture the package invariant.
- Run the focused test command and record the failing test names and failure messages.
- If the intended seam does not exist yet, write the test against the intended public helper/API and stop after confirming the expected missing-export or missing-behavior failure.
- If a test fixture requires manually seeding SQLite, keep that as a deterministic reader fixture; do not use manually seeded `_smithers_*` rows as the main proof for the real-run integration smoke.

A-bead output should include:

```txt
Tests added/changed:
- ...

Focused command run:
- ...

Expected failure observed:
- ...

Assumptions for B worker:
- ...
```

### B-bead implementation contract

Each B bead should include this contract in the bead body:

- Read this plan section, the matching A-bead diff, and the A-bead failure output before editing.
- Implement only enough production code to satisfy the A-bead tests and package acceptance criteria.
- Keep changes inside the package scope unless a real blocker requires escalation.
- Preserve all non-negotiable Smithers-first invariants.
- Run focused tests, `bun tsc --noEmit`, and the package drift greps.
- Do not create beads, new persistence, fork/replay UI, workflow authoring scope, or project-mode prompt override paths.

B-bead output should include:

```txt
Implementation summary:
- ...

Validation run:
- ...

Drift greps/classification:
- ...

Remaining risks or follow-up:
- ...
```

## Per-bead agent prompts

Use these prompts as the starting text when creating beads. Keep the matching package section above as required reading in each bead.

### 1A — Testing agent prompt: live render-state guard

```txt
Write failing tests only for Package 1: live project-mode render state guard.

Required reading:
- docs/plans/smithers-first-hardening-followups.md Package 1
- web/index.html:2476-2557
- web/index.html:2610-2652
- web/index.html:2815-2823
- src/ui/smithersRunOverlay.ts
- tests/workflowViewer.ui.test.ts

Scope:
- Edit tests/workflowViewer.ui.test.ts only, unless a tiny test fixture/helper expectation is needed.
- Do not edit production files.

Test requirements:
- Add a failing helper-level test for preview refresh while live Smithers detail exists: preview node says running, DB node says finished, rendered graph must show DB-overlaid done status and live provenance.
- Add a failing test proving overlay failure cannot show raw preview graph under Smithers SQLite live provenance.
- Preserve existing assertions that project Start Full Run sends only { input } and does not fetch legacy /runs/:id artifacts.
- Prefer a pure helper seam such as deriveProjectRenderedGraph(). If the seam does not exist, write tests against the intended exported helper and confirm the missing-export failure.

Validation to run:
- bun test tests/workflowViewer.ui.test.ts

Expected failure before implementation:
- Missing helper export or current refresh path cannot preserve DB overlay across preview refresh.

Output:
- Tests added/changed.
- Focused command run.
- Expected failure observed.
- Assumptions for 1B worker.
```

### 1B — Implementation agent prompt: live render-state guard

```txt
Implement Package 1 only: live project-mode render state guard.

Required reading:
- docs/plans/smithers-first-hardening-followups.md Package 1
- 1A test diff and failure output
- web/index.html:2476-2557
- web/index.html:2610-2652
- web/index.html:2815-2823
- src/ui/smithersRunOverlay.ts
- tests/workflowViewer.ui.test.ts

Scope:
- web/index.html
- src/ui/projectLiveState.ts or another tiny src/ui helper if needed
- tests/workflowViewer.ui.test.ts only to align with 1A tests if necessary

Requirements:
- Make poll and preview-refresh paths use one decision helper for live-vs-preview graph rendering.
- If liveMode && liveDetail, overlay DB state onto any refreshed preview graph.
- If overlay fails, do not display preview status under live Smithers provenance.
- Keep project Start Full Run payload as { input } only.
- Do not fetch /runs/:id/plan.json, run.json, or events.jsonl from project live inspection.

Non-goals:
- Do not add fork/replay UI.
- Do not add workflow authoring scope.
- Do not change Smithers reader DTOs.

Validation:
- bun test tests/workflowViewer.ui.test.ts
- bun tsc --noEmit
- rg -n "waitForRunToRender\(|/runs/\$\{encodeURIComponent\(runId\)\}/plan\.json|promptOverrides" web/index.html
- rg -n "events\.jsonl|smithersSnapshotToRenderGraph|_smithers_frames" web/index.html src/ui
```

### 3A — Testing agent prompt: workflow-filtered `listRuns()`

```txt
Write failing tests only for Package 3: workflow-filtered SmithersRunReader listRuns pagination correctness.

Required reading:
- docs/plans/smithers-first-hardening-followups.md Package 3
- src/smithersProject/runReader.ts
- src/smithersProject/runReaderTypes.ts
- tests/smithersRunReader.test.ts
- node_modules/@smithers-orchestrator/db/src/adapter/SmithersDb.js:826-839

Scope:
- Edit tests/smithersRunReader.test.ts only.
- Do not edit production files.

Test requirements:
- Create a deterministic fixture with many newer non-matching runs and older matching foo runs.
- Assert listRuns({ workflowId: 'foo', limit: 2 }) returns the two newest matching foo runs, not an empty/truncated global page.
- Assert status: 'running' includes matching continued runs, matching Smithers adapter behavior.
- Assert path-only workflow match works when workflow_name differs but workflow_path ends with .smithers/workflows/foo.tsx.

Validation to run:
- bun test tests/smithersRunReader.test.ts

Expected failure before implementation:
- Current reader applies adapter limit before workflow filtering, so older matching runs are omitted.

Output:
- Tests added/changed.
- Focused command run.
- Expected failure observed.
- Assumptions for 3B worker.
```

### 3B — Implementation agent prompt: workflow-filtered `listRuns()`

```txt
Implement Package 3 only: workflow-filtered SmithersRunReader listRuns pagination correctness.

Required reading:
- docs/plans/smithers-first-hardening-followups.md Package 3
- 3A test diff and failure output
- src/smithersProject/runReader.ts
- src/smithersProject/sqliteReadOnly.ts
- src/smithersProject/runReaderTypes.ts
- tests/smithersRunReader.test.ts

Scope:
- src/smithersProject/runReader.ts
- src/smithersProject/runReaderTypes.ts only if comments/types are needed
- tests/smithersRunReader.test.ts only to keep 3A tests compiling

Requirements:
- Keep unfiltered listRuns() adapter-backed.
- For workflowId-filtered listRuns(), use reader-local read-only SELECT so workflow filtering happens before LIMIT.
- Match workflow_name or .smithers/workflows/<workflowId>.tsx path suffix.
- Preserve Smithers status semantics: status running includes running and continued.
- Keep raw SQL contained in reader code.

Non-goals:
- Do not edit src/server.ts.
- Do not add schema mutators or write SQL.
- Do not read legacy runs/ artifacts.

Validation:
- bun test tests/smithersRunReader.test.ts tests/server.test.ts
- bun tsc --noEmit
- rg -n "\\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\\b.*_smithers|_smithers_.*\\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\\b" src/smithersProject src/server.ts
- rg -n "runs/index\.json|plan\.json|run\.json|events\.jsonl|createRunRecorder" src/smithersProject
```

### 2A — Testing agent prompt: Smithers CLI resolution

```txt
Write failing tests only for Package 2: robust Smithers CLI resolution for project runs.

Required reading:
- docs/plans/smithers-first-hardening-followups.md Package 2
- src/server.ts:609-693
- tests/workflowViewer.run.test.ts
- tests/workflowViewer.run.integration.test.ts
- node_modules/smithers-orchestrator/src/bin/smithers.js:8-24
- node_modules/@smithers-orchestrator/cli/src/index.js:1375-1388,1455-1470,1736-1739

Scope:
- Edit tests/workflowViewer.run.test.ts and/or tests/workflowViewer.run.integration.test.ts.
- Add test fixtures only if needed.
- Do not edit production files.

Test requirements:
- Add pure command-resolution tests for root-local bin, .smithers-local bin, and bunx fallback.
- Assert every command runs from projectRoot and includes workflow run <id> --input <json> --detach --format json --root .
- Assert project run route still passes no promptOverrides to runner.
- If practical, adjust integration fixture expectation so root node_modules symlink is not required solely for launch.

Validation to run:
- bun test tests/workflowViewer.run.test.ts tests/workflowViewer.run.integration.test.ts

Expected failure before implementation:
- No command helper exists or current implementation only supports node_modules/.bin/smithers at project root.

Output:
- Tests added/changed.
- Focused command run.
- Expected failure observed.
- Assumptions for 2B worker.
```

### 2B — Implementation agent prompt: Smithers CLI resolution

```txt
Implement Package 2 only: robust Smithers CLI resolution for project runs.

Required reading:
- docs/plans/smithers-first-hardening-followups.md Package 2
- 2A test diff and failure output
- src/server.ts:609-693
- tests/workflowViewer.run.test.ts
- tests/workflowViewer.run.integration.test.ts

Scope:
- src/server.ts
- optional new src/smithersProject/cli.ts helper
- tests only to keep 2A tests aligned

Requirements:
- Resolve Smithers CLI local-first: projectRoot/node_modules/.bin/smithers, then projectRoot/.smithers/node_modules/.bin/smithers, then bunx smithers-orchestrator.
- Always run from projectRoot.
- Keep command source-backed: workflow run <workflowId> --input <json> --detach --format json --root .
- Do not add --log-dir unless a focused test proves it is required.
- Project-mode runner must not call runSmithersWorkflow() or create CustomHarness runs/ artifacts.

Non-goals:
- Do not change project-mode prompt override rejection.
- Do not add workflow editing or fork/replay UI.

Validation:
- bun test tests/workflowViewer.run.test.ts tests/workflowViewer.run.integration.test.ts tests/server.test.ts
- bun tsc --noEmit
- rg -n "promptOverrides|runSmithersWorkflow\(|--log-dir|createRunRecorder" src/server.ts src/smithersProject
```

### 5A — Testing agent prompt: events warnings/cursors

```txt
Write failing tests only for Package 5: events endpoint parse warnings and cursor continuity.

Required reading:
- docs/plans/smithers-first-hardening-followups.md Package 5
- src/smithersProject/runReaderTypes.ts
- src/smithersProject/runReader.ts
- src/server.ts:467-489
- tests/smithersRunReader.test.ts
- tests/server.test.ts

Scope:
- Edit tests/smithersRunReader.test.ts and tests/server.test.ts only.
- Do not edit production files.

Test requirements:
- Malformed event payload through reader.listEvents() returns parseWarnings with field event.payloadJson and still returns payload null.
- Empty page after afterSeq=N returns cursors.nextEventSeq >= N, preferably DB last seq when known.
- Server events endpoint passes parseWarnings through from a fake reader.
- Existing detail malformed JSON behavior remains unchanged.

Validation to run:
- bun test tests/smithersRunReader.test.ts tests/server.test.ts

Expected failure before implementation:
- SmithersRunEventsResult has no parseWarnings and empty event cursor can reset to null.

Output:
- Tests added/changed.
- Focused command run.
- Expected failure observed.
- Assumptions for 5B worker.
```

### 5B — Implementation agent prompt: events warnings/cursors

```txt
Implement Package 5 only: events endpoint parse warnings and cursor continuity.

Required reading:
- docs/plans/smithers-first-hardening-followups.md Package 5
- 5A test diff and failure output
- src/smithersProject/runReaderTypes.ts
- src/smithersProject/runReader.ts
- src/server.ts:467-489
- tests/smithersRunReader.test.ts
- tests/server.test.ts

Scope:
- src/smithersProject/runReaderTypes.ts
- src/smithersProject/runReader.ts
- src/server.ts only if route passthrough changes are actually needed
- tests only to keep 5A tests aligned

Requirements:
- Add optional parseWarnings to SmithersRunEventsResult.
- Return event parse warnings from listEvents() without throwing.
- Preserve cursor continuity on empty pages using DB last seq when available, otherwise requested afterSeq.
- Keep nextEventSeq meaning: last seen event seq to pass as next afterSeq.

Non-goals:
- Do not read events.jsonl.
- Do not change detail endpoint shape except compatible type updates.
- Do not add frame-to-graph reconstruction.

Validation:
- bun test tests/smithersRunReader.test.ts tests/server.test.ts tests/workflowViewer.ui.test.ts
- bun tsc --noEmit
- rg -n "events\.jsonl" src/smithersProject src/server.ts src/ui web/index.html
```

### 4A — Testing agent prompt: nearest read-only DB discovery

```txt
Write failing tests only for Package 4: nearest read-only smithers.db discovery.

Required reading:
- docs/plans/smithers-first-hardening-followups.md Package 4
- src/smithersProject/sqliteReadOnly.ts
- src/smithersProject/runReader.ts:28-49
- tests/smithersRunReader.test.ts

Scope:
- Edit tests/smithersRunReader.test.ts only.
- Do not edit production files.

Test requirements:
- Existing project-root smithers.db resolution still passes.
- Nested dbSearchStart or workflow-like path resolves parent smithers.db.
- Explicit dbPath wins over projectRoot when both exist.
- Missing DB anywhere returns controlled SMITHERS_DB_NOT_FOUND and creates no files.
- Read-only write probes still fail through the resolved handle.

Validation to run:
- bun test tests/smithersRunReader.test.ts

Expected failure before implementation:
- Opener only checks <projectRoot>/smithers.db and has no dbPath/dbSearchStart semantics.

Output:
- Tests added/changed.
- Focused command run.
- Expected failure observed.
- Assumptions for 4B worker.
```

### 4B — Implementation agent prompt: nearest read-only DB discovery

```txt
Implement Package 4 only: nearest read-only smithers.db discovery.

Required reading:
- docs/plans/smithers-first-hardening-followups.md Package 4
- 4A test diff and failure output
- src/smithersProject/sqliteReadOnly.ts
- src/smithersProject/runReader.ts:28-49
- tests/smithersRunReader.test.ts

Scope:
- src/smithersProject/sqliteReadOnly.ts
- src/smithersProject/runReader.ts only if constructor options must pass through
- tests only to keep 4A tests aligned

Requirements:
- Add explicit dbPath and dbSearchStart support.
- Search upward only; never search downward.
- Preserve existing projectRoot smithers.db behavior.
- Never create a DB when missing.
- Keep Bun SQLite readonly and PRAGMA query_only protections.

Non-goals:
- Do not import Smithers CLI DB opener/find-db helpers.
- Do not add schema mutators or write-capable open.
- Do not fall back to legacy runs/ artifacts.

Validation:
- bun test tests/smithersRunReader.test.ts
- bun tsc --noEmit
- rg -n "from ['\"]@smithers-orchestrator/db/ensure|ensureSmithersTables\(|ensureSqlMessageStorage\(|ensureSchema\(" src/smithersProject
- rg -n "openSmithersDb\(|findAndOpenDb\(" src/smithersProject
```

### 6A — Testing agent prompt: drift/integration guard sweep

```txt
Write failing tests only for Package 6: final drift guards and integration smoke hardening.

Required reading:
- docs/plans/smithers-first-hardening-followups.md Package 6
- docs/plans/live-smithers-run-inspection-task-breakdown.md Global Drift Tripwires
- tests/server.test.ts
- tests/workflowViewer.ui.test.ts
- tests/workflowViewer.run.integration.test.ts
- tests/smithersRunReader.test.ts

Scope:
- Edit tests only.
- Do not edit production files.

Test requirements:
- Add stable source guard tests for no schema mutator imports in src/smithersProject.
- Add stable guard for no manual SQL writes to _smithers_* tables in project-mode code.
- Keep or strengthen contradictory legacy artifact trap for /api/smithers/runs*.
- Make integration smoke tolerant of Smithers event-name changes: require DB event or attempt evidence, reject LegacyEvent, and keep node/frame/output evidence where reliable.
- If Package 1 added a live-state helper, prefer helper-level tests over brittle regex for project live refresh behavior.

Validation to run:
- bun test tests/server.test.ts tests/workflowViewer.ui.test.ts tests/workflowViewer.run.integration.test.ts tests/smithersRunReader.test.ts

Expected failure before implementation:
- Missing drift guard tests or integration assertions still overfit exact Smithers event names.

Output:
- Tests added/changed.
- Focused command run.
- Expected failure observed.
- Assumptions for 6B worker.
```

### 6B — Implementation agent prompt: drift/integration guard sweep

```txt
Implement Package 6 only: final drift guards and integration smoke hardening.

Required reading:
- docs/plans/smithers-first-hardening-followups.md Package 6
- 6A test diff and failure output
- tests/server.test.ts
- tests/workflowViewer.ui.test.ts
- tests/workflowViewer.run.integration.test.ts
- tests/smithersRunReader.test.ts
- src/smithersProject/*
- src/server.ts project-mode routes
- web/index.html project-mode run paths

Scope:
- Tests and minimal production fixes only if a guard exposes real drift.
- Do not broaden product behavior.

Requirements:
- Make 6A guards pass without weakening Smithers-first invariants.
- Keep real-run smoke SQLite-backed; do not replace it with manually seeded DB as the primary proof.
- Classify any remaining legacy artifact grep matches as legacy-only compatibility paths.

Non-goals:
- Do not add workflow editing, fork/replay UI, new persistence, or prompt override paths.
- Do not manually mutate Smithers DB tables.

Validation:
- bun test tests/
- bun tsc --noEmit
- rg -n "from ['\"]@smithers-orchestrator/db/ensure|ensureSmithersTables\(|ensureSqlMessageStorage\(|ensureSchema\(" src/smithersProject
- rg -n "\\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\\b.*_smithers|_smithers_.*\\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\\b" src/smithersProject src/server.ts
- rg -n "createRunRecorder|runs/index\.json|plan\.json|run\.json|events\.jsonl|workflowGraph" src/smithersProject src/server.ts web/index.html
- br dep cycles --json
```

## Focused validation commands

Run focused checks per package instead of the full suite until final sweep:

```bash
# UI live-state changes
bun test tests/workflowViewer.ui.test.ts
bun tsc --noEmit

# Reader changes
bun test tests/smithersRunReader.test.ts tests/server.test.ts
bun tsc --noEmit
rg -n "from ['\"]@smithers-orchestrator/db/ensure|ensureSmithersTables\(|ensureSqlMessageStorage\(|ensureSchema\(" src/smithersProject
rg -n "\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b.*_smithers|_smithers_.*\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b" src/smithersProject src/server.ts

# Server/run changes
bun test tests/workflowViewer.run.test.ts tests/workflowViewer.run.integration.test.ts tests/server.test.ts
bun tsc --noEmit
rg -n "promptOverrides|runSmithersWorkflow\(|--log-dir|createRunRecorder" src/server.ts src/smithersProject

# Final sweep
bun test tests/
bun tsc --noEmit
br dep cycles --json
git status --short
```

## Out of scope

Do not include these in this hardening track unless a separate plan says otherwise:

- New workflow authoring UI.
- Smithers fork/replay UI.
- Smithers time-travel frame graph reconstruction.
- New CustomHarness run persistence.
- Deleting all legacy `runs/` compatibility paths.
- Project-mode prompt override editing.
- Manual DB migrations or Smithers schema creation.
- A new workflow runtime or run database.

## Bead conversion notes

Convert the packages into A/B beads:

1. `1A` — Live overlay preservation tests across preview refresh.
2. `1B` — Live overlay preservation implementation.
3. `3A` — Workflow-filtered `listRuns()` pagination tests.
4. `3B` — Workflow-filtered `listRuns()` pagination implementation.
5. `2A` — Smithers CLI command resolution tests.
6. `2B` — Smithers CLI command resolution implementation.
7. `5A` — Events endpoint parse warning/cursor tests.
8. `5B` — Events endpoint parse warning/cursor implementation.
9. `4A` — Nearest read-only `smithers.db` discovery tests.
10. `4B` — Nearest read-only `smithers.db` discovery implementation.
11. `6A` — Drift guard and integration smoke hardening tests.
12. `6B` — Drift guard and integration smoke hardening implementation.

Each A bead should include:

- Background and invariant being protected.
- Exact test files likely touched.
- Explicit production-edit prohibition.
- Expected failing behavior and focused command to run.
- Dependency link to any prior B bead required for stable types/seams.

Each B bead should include:

- Background and invariant being protected.
- Exact source files likely touched.
- Matching A-bead tests/failure output as required reading.
- Explicit non-goals.
- Focused validation commands.
- Drift greps.
- Dependency links.
- Single-writer warnings for `src/server.ts`, `web/index.html`, and `src/smithersProject/runReader.ts` where applicable.

## Remaining DECISION NEEDED items

None for the current hardening scope. Previously open questions are resolved as follows:

- CLI resolution: local-first (`projectRoot/node_modules/.bin/smithers`, then `.smithers/node_modules/.bin/smithers`) with `bunx smithers-orchestrator` fallback.
- DB discovery: support explicit `dbPath`, then `dbSearchStart`/workflow-path-adjacent upward search, then `projectRoot` upward search.
- Live preview refresh during a run: preserve DB overlay when live detail exists; clear live mode only through explicit user navigation/actions.
- Events cursor: `nextEventSeq` means last seen event seq for the next `afterSeq`; empty pages preserve caller cursor or DB last seq.
- Test hardening: each functional package owns its tests; keep a final drift-sweep bead for cross-cutting guards.
