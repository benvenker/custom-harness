# Project-mode run inspection reads Smithers SQLite

Status: accepted

Project-mode CustomHarness and the future Studio run viewer should inspect Smithers runs from Smithers' SQLite state. They should not bridge project-mode runs through CustomHarness `runs/<runId>/` JSON artifacts.

This extends ADR 0001. ADR 0001 chose Smithers canonical run state over a parallel Studio run database. This ADR narrows the implementation direction for project-mode run inspection: the viewer should read the nearest `smithers.db` through Smithers APIs/adapter surfaces and treat NDJSON logs as optional observability.

## Decision

- Workflow definition remains ordinary Smithers workflow-pack source: `.smithers/workflows/*.tsx`, `.smithers/prompts/*`, `.smithers/components/*`, and related Smithers config.
- Project-mode run state is read from Smithers SQLite as the authoritative source.
- CustomHarness should introduce a read-only `SmithersRunReader`/adapter for project-mode inspection. It should wrap Smithers DB/runtime APIs where possible rather than issuing raw SQL throughout the UI/server.
- The reader should expose run, node, attempt, event, frame, and output views needed by the UI, derived from Smithers state.
- NDJSON logs under `.smithers/executions/**/stream.ndjson` are observability artifacts. They may enrich the UI, but absence or relocation of a log file must not make a Smithers run disappear.
- CustomHarness `runs/index.json`, `runs/<runId>/plan.json`, `run.json`, and `events.jsonl` remain legacy/prototype compatibility artifacts. They are not authoritative for project-mode Smithers workflows.
- CustomHarness/Studio must not manually mutate `_smithers_*` rows or workflow output tables. Writes happen through Smithers runtime/CLI/API surfaces such as `runWorkflow`, `workflow run`, `fork`, `replay`, approval APIs, or future Smithers-supported edit/replay APIs.

## Evidence

Smithers' documented execution model is render, extract, execute, persist, and re-render. The docs state that validated outputs are written to per-schema SQLite tables, while internal `_smithers_*` tables capture node state, attempts, frames, events, approvals, and signals. Source: `/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt:567-606`.

Smithers docs also say persisted state lives in the nearest `smithers.db`, and workflow commands are rooted in Smithers workflow-pack files. Source: `/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt:6740-6787`.

The installed DB schema creates the run-state tables CustomHarness needs to read:

- `_smithers_runs` for run identity, status, workflow path/name, parent links, heartbeat, and config.
- `_smithers_nodes` for per-node execution state.
- `_smithers_attempts` for attempt lifecycle, errors, response text, and metadata.
- `_smithers_frames` for frame snapshots.
- `_smithers_events` for event history.

Source: `node_modules/@smithers-orchestrator/db/src/sql-message-storage.js:13-76` and `:205-211`.

`runWorkflow` writes input rows and inserts/updates `_smithers_runs` through the Smithers DB adapter. Source: `node_modules/@smithers-orchestrator/engine/src/engine.js:4938-5050`.

Smithers resolves default log output separately from DB state. `resolveLogDir` defaults to `<rootDir>/.smithers/executions/<runId>/logs`, and `EventBus.persistLog` writes `stream.ndjson` there when logging is enabled. Sources: `node_modules/@smithers-orchestrator/engine/src/engine.js:1248-1274` and `node_modules/@smithers-orchestrator/engine/src/events.js:176-205`.

Smithers already exposes DB-backed inspection surfaces. `ps` opens the nearest DB via `findAndOpenDb()` and returns JSON-capable run rows. Source: `node_modules/@smithers-orchestrator/cli/src/index.js:2648-2701`. DB discovery/opening helpers are available in `node_modules/@smithers-orchestrator/cli/src/find-db.js:1-83`.

Existing project decisions already require this direction:

- ADR 0001: Studio run state converges on Smithers canonical run state.
- ADR 0003: Studio reflects Smithers first and uses overlays only as presentation aids.

## Consequences

- The next run-state implementation slice should build a read-only Smithers run-state reader before adding richer live-run UI.
- Project-mode endpoints such as `GET /api/smithers/runs/:runId` should be backed by Smithers DB/runtime APIs, not by `runs/index.json` or `runs/<runId>/plan.json`.
- The project-mode graph can still use `src/runs/smithersGraph.ts` as a visual projection of Smithers `GraphSnapshot`, but live status/timeline/output should come from SQLite state.
- Logs can be linked, tailed, or displayed when present, but UI status must be correct without them.
- Legacy CustomHarness run artifacts may remain for older harness/demo flows during migration. They should be labelled compatibility paths and not used to decide whether a project-mode Smithers run exists.
- Tests for project-mode run inspection should create or open Smithers state and assert against DB-backed run/node/event data.

## Non-goals

- This ADR does not require deleting `src/runs/recorder.ts` immediately.
- This ADR does not define Studio overlay storage.
- This ADR does not authorize manual writes to Smithers SQLite tables.
- This ADR does not require a full live graph renderer in one slice.

## Current implementation caveat

This is not fully implemented in `custom-harness` yet. Current code still has legacy artifact paths:

- `src/runs/recorder.ts` writes `runs/<runId>/` artifacts.
- `src/app/runSmithersWorkflow.ts` records Smithers runs into CustomHarness-compatible artifacts for compatibility paths.
- `web/index.html` still has legacy `/runs/*` browsing logic.

Project-mode work should move away from those paths by adding a Smithers SQLite reader and then wiring the project-mode UI to that reader.
