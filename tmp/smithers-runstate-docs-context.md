# Code Context

## Files Retrieved
1. `docs/adr/0001-runs-in-smithers-canonical-location.md` (lines 1-38) - primary accepted ADR for Smithers canonical run state.
2. `docs/adr/0002-prototype-before-poolside-studio-port.md` (lines 1-5) - confirms `custom-harness` is incubation, not long-term app boundary.
3. `docs/adr/0003-reflect-smithers-first-smooth-with-overlays.md` (lines 1-12) - accepted ADR that Poolside/Studio should reflect Smithers first; overlays must not become source of truth.
4. `CONTEXT.md` (lines 81-87, 106-154, 164-166) - local synthesis of Smithers state facts and current CustomHarness/legacy run-state caveats.
5. `docs/plans/alpha-workflow-authoring-and-viewer.md` (lines 1-31, 187-220, 407-410, 601-657, 734-840) - alpha plan: Smithers-native viewer loop, no custom DB, no legacy run artifact dependency.
6. `docs/plans/custom-harness-cli-http-viewer-implementation.md` (lines 17-83, 229-366, 696-700, 813-838, 859-866, 943-964, 1464-1495) - detailed project-mode implementation plan and run-state authority rules.
7. `docs/plans/meta-smithers-editing.md` (lines 1-90, 552-613, 923-943, 1168-1179) - editing plan: no run mutation, no custom DB, historical state is Smithers DB/logs.
8. `/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt` (lines 567-606) - Smithers render/extract/execute/persist/re-render model and SQLite persistence facts.
9. `/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt` (lines 1290-1299) - default NDJSON event log path and CLI log/event access.
10. `/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt` (lines 3346-3352, 6740-6787, 6927-6934, 7071-7096, 9430-9438, 18766-18781, 21144-21158) - `RunSummary`, nearest `smithers.db`, CLI commands, log/db inspection, internal tables, run-state mapping.
11. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/db/src/internal-schema.js` (lines 1-45) - concrete `_smithers_runs` and `_smithers_nodes` schema fields.
12. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/db/src/sql-message-storage.js` (lines 16-96) - SQL DDL for `_smithers_runs`, `_smithers_nodes`, `_smithers_attempts`, `_smithers_frames`, `_smithers_approvals`.
13. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/engine/src/engine.js` (lines 1248-1274, 4938-5058) - root/log-dir resolution and `runWorkflow` inserting Smithers run/input state.
14. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/engine/src/events.js` (lines 176-205) - events append `stream.ndjson` in the configured log dir.
15. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/cli/src/index.js` (lines 1722-1822, 4181-4218) - `workflow run/list/path` use cwd project root; `graph` renders without task execution but loads DB input/outputs by run id.
16. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/cli/src/workflows.js` (lines 15-116) - Smithers-compatible workflow discovery: flat `.smithers/workflows/*.tsx`, kebab-case IDs, metadata comments.
17. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/graph/src/types.ts` (lines 129-190) - `TaskDescriptor` and `GraphSnapshot` shape.
18. `src/runs/recorder.ts` (lines 98-126) - current legacy `runs/<runId>/` writer.
19. `src/app/runSmithersWorkflow.ts` (lines 45-88) - current compatibility run path redirects Smithers logs under the custom run dir.
20. `src/app/renderWorkflowGraph.ts` (lines 24-59) - current compatibility render path writes legacy run artifacts.
21. `src/server.ts` (lines 360-605) - current project-mode endpoints exist, but still mix direct runtime rendering, prompt overrides, legacy fallback, and non-canonical/explicit log-dir behavior.

## Key Code

### Accepted direction: Smithers SQLite/log state is the source of truth

`docs/adr/0001-runs-in-smithers-canonical-location.md` is explicit and accepted:

```md
# Studio runs converge on Smithers canonical run state

The Studio should not maintain a parallel run database as the source of truth. ...
```

Important claims from `docs/adr/0001-runs-in-smithers-canonical-location.md` lines 9-13:

- Run identity (`runId`, status, workflow path/name, parent/fork links) lives in `_smithers_runs` in nearest `smithers.db`.
- Per-run event log defaults to `<smithers workspace directory>/executions/<runId>/logs/stream.ndjson`; it is canonical evidence when enabled, but can be moved or disabled.
- Frame/node/attempt/output/approval/signal state is in SQLite tables, including `_smithers_*` and per-schema output tables.
- Therefore canonical run state is primarily the Smithers SQLite DB; Studio must not require a log file to consider a run real.

Consequences from the same ADR lines 29-33:

```md
- The current `runs/` tree at the repo root becomes legacy.
- The Studio's `runs/index.json` becomes a *derived view*, not a database.
- Studio launch code must call Smithers runtime/CLI surfaces ... It must not create fake Smithers runs by writing Studio JSON files or hand-inserting partial DB rows.
- Studio listing and inspection must work from Smithers DB state first. Logs and Studio overlays are optional enrichments.
```

Status caveat from line 38: accepted direction, but at ADR time not fully implemented; `src/runs/recorder.ts` still wrote `runs/<runId>/` and there was no Smithers DB read path.

### Smithers docs validate the model

`smithersai-smithers.txt` lines 567-606 says Smithers is a render/extract/execute/persist/re-render loop:

```md
Each render produces a snapshot of the workflow plan; the runtime extracts ready tasks from that plan, executes them, persists their outputs, and re-renders. The plan evolves because each render reads the persisted state.
...
Persist. Validated outputs are written to per-schema SQLite tables. Internal `_smithers_*` tables capture node state, attempts, frame snapshots, events, and durable approval/signal state.
```

`smithersai-smithers.txt` lines 6740-6747 states CLI conventions:

```md
Always invoke as `bunx smithers-orchestrator <command>` ...
- Persisted state lives in the nearest `smithers.db` (walk up from the working directory).
- Workflow resolution: `up`, `graph`, `revert`, `replay`, `fork`, ... take a workflow file path. `workflow run <name>` resolves IDs from `.smithers/workflows/<name>.tsx`.
```

`smithersai-smithers.txt` lines 1290-1299 and 9430-9438 confirm logs/inspection:

```md
Events append to `.smithers/executions/<runId>/logs/stream.ndjson` (configure with `logDir` / `--log-dir`; disable with `--no-log`).
...
Per-run NDJSON event log lives at `.smithers/executions/<runId>/logs/stream.ndjson` ... Useful inspection commands: `inspect`, `logs --follow`, `chat`, `why`, `node`, `ps`, `graph`. Most internal state is queryable via SQLite tables prefixed `_smithers_*`.
```

`smithersai-smithers.txt` lines 18766-18781 lists Smithers DB authority:

```md
Internal (managed by `SmithersDb` / `ensureSmithersTables`):
- `_smithers_runs` — run state
- `_smithers_nodes` — node execution state
- `_smithers_attempts` — attempt history
- `_smithers_frames` — frame snapshots
- `_smithers_events` — event history
...
Path: Default: `./smithers.db` (CWD-relative). Configurable via `createSmithers({ dbPath })`.
```

### Source anchors confirm DB schema and run writes

`@smithers-orchestrator/db/src/internal-schema.js` lines 1-20:

```js
export const smithersRuns = sqliteTable("_smithers_runs", {
    runId: text("run_id").primaryKey(),
    parentRunId: text("parent_run_id"),
    workflowName: text("workflow_name").notNull(),
    workflowPath: text("workflow_path"),
    workflowHash: text("workflow_hash"),
    status: text("status").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    startedAtMs: integer("started_at_ms"),
    finishedAtMs: integer("finished_at_ms"),
    heartbeatAtMs: integer("heartbeat_at_ms"),
    ...
});
```

`@smithers-orchestrator/engine/src/engine.js` lines 4938-5015 shows `runWorkflow` inserts input rows and `_smithers_runs` through `adapter.insertRun`, not through CustomHarness JSON.

`@smithers-orchestrator/engine/src/engine.js` lines 1248-1274 and `events.js` lines 176-205 show default log behavior:

```js
function resolveRootDir(opts, workflowPath) {
    if (opts.rootDir) return resolve(opts.rootDir);
    if (workflowPath) return resolve(dirname(workflowPath));
    return resolve(process.cwd());
}
function resolveLogDir(rootDir, runId, logDir) {
    if (logDir === null) return undefined;
    if (typeof logDir === "string") return resolve(rootDir, logDir);
    return resolve(rootDir, ".smithers", "executions", runId, "logs");
}
```

So if Studio wants the default canonical log shape, do not casually override `--log-dir`; if overriding, treat it as a configurable Smithers log artifact, not identity.

### Plans reinforce: CustomHarness is a thin Smithers-native viewer, not a run database

`docs/plans/alpha-workflow-authoring-and-viewer.md` lines 14-31:

```md
The alpha is not a new workflow platform. It is a Smithers-native authoring + verification + visual feedback loop.
...
Smithers remains the authority for workflow files, render behavior, run behavior, logs, DB state, approvals, forks, and runtime semantics.
...
Non-goals: ... A custom run database.
```

`docs/plans/custom-harness-cli-http-viewer-implementation.md` lines 67-83 requires a `SmithersAdapter` boundary and says the adapter must never synthesize Smithers runs by writing CustomHarness JSON. Lines 229-233 make `runs/` internal compatibility only; project-aware commands/endpoints must not expose `--runs-dir` or `CUSTOM_HARNESS_RUNS_DIR` and must never use legacy artifacts to decide whether a Smithers run exists.

`docs/plans/custom-harness-cli-http-viewer-implementation.md` lines 859-866:

```md
Optional run-inspection endpoints, only after they read Smithers canonical DB/runtime state through `SmithersAdapter`:
GET /api/runs
GET /api/runs/:id

In project-aware mode, run endpoints must not be backed by legacy `runs/index.json` as authoritative state.
```

`docs/plans/meta-smithers-editing.md` lines 34-57 maps product concepts to Smithers primitives:

```md
| Historical run state | Smithers DB/logs, `ps`, `inspect`, `chat`, `logs`, `fork`, `replay` | Read-only presentation or links/commands; no custom mutation |
...
- Do not patch Smithers DB rows or output tables to make an old run look edited.
- Do not make CustomHarness overlays required for Smithers to discover, render, or run a workflow.
```

### Current implementation caveats / drift risks

The docs validate the long-term direction, but current code is transitional.

`src/runs/recorder.ts` lines 98-126 still defines legacy custom run artifacts:

```ts
const DEFAULT_RUNS_DIR = 'runs';
const indexPath = join(runsDir, 'index.json');
const runDir = join(runsDir, runId);
const planPath = join(runDir, 'plan.json');
const eventsPath = join(runDir, 'events.jsonl');
```

`src/app/renderWorkflowGraph.ts` lines 24-59 renders with Smithers runtime but immediately creates a `RunRecorder` and writes legacy artifacts. That path is useful compatibility, but should not be the project-mode source of truth.

`src/app/runSmithersWorkflow.ts` lines 45-88 uses Smithers `runWorkflow`, but sets:

```ts
const logDir = join(resolve(recorder.runDir), 'smithers', 'executions');
...
runtime.runWorkflow(workflow, { input, runId, resume: false, rootDir, logDir, workflowPath, ... })
```

That redirects Smithers NDJSON logs under a CustomHarness run folder, not the default `<project>/.smithers/executions/<runId>/logs/stream.ndjson` shape.

`src/server.ts` lines 516-541 has a project graph endpoint implementation, but it calls in-process `renderFrame` directly instead of the planned `SmithersAdapter`. `src/server.ts` lines 543-605 launches project runs, but:

- accepts `promptOverrides` in `workflowRunResponse` (lines 493-512), contrary to meta plan lines 923-943 saying project-mode runs should start from saved source and not carry prompt overrides/pretend outputs as run state;
- falls back to legacy `runSmithersWorkflow` when prompt overrides are present (lines 543-557);
- calls `bun node_modules/.bin/smithers ...` rather than the docs' canonical `bunx smithers-orchestrator ...` (lines 559-576);
- passes explicit `--log-dir .smithers/executions` (lines 575-579), which source `resolveLogDir` treats as the exact directory for `stream.ndjson`, not automatically `<runId>/logs`.

These are implementation caveats, not contradictions of the direction.

## Architecture

Validated target architecture:

1. Poolside/Studio/CustomHarness selects a project root and Smithers workflow from `.smithers/workflows/*.tsx` using Smithers-compatible discovery.
2. Rendering asks Smithers (`graph` or `renderFrame` behind a `SmithersAdapter`) for a `GraphSnapshot`; CustomHarness may project that into a `RenderGraph` for UI cards/edges, but must not persist a separate workflow/run IR as authority.
3. Running calls Smithers runtime/CLI (`runWorkflow`, `workflow run`, `up`, or equivalent), which creates/updates Smithers SQLite rows and optional NDJSON logs.
4. Listing/inspection reads Smithers DB/runtime/log state first. `runs/index.json` can only be a transitional derived/cache view; it must not define existence/status of a Smithers run.
5. Studio/Poolside overlays (layout, labels, warnings, drafts, `meta.studio`) are optional presentation/editing aids. A Smithers run without overlays must still show and remain usable.

Key data flow:

```txt
<project>/.smithers/workflows/*.tsx
  -> Smithers renderFrame/graph -> GraphSnapshot
  -> CustomHarness RenderGraph projection (UI only)

Smithers workflow run
  -> nearest smithers.db (_smithers_runs, _smithers_nodes, _smithers_frames, per-schema outputs, approvals/signals/events)
  -> optional .smithers/executions/<runId>/logs/stream.ndjson
  -> Studio/CustomHarness run list/inspect derived from DB first, logs/overlays second
```

## Start Here

Start with `docs/adr/0001-runs-in-smithers-canonical-location.md`. It is the clearest accepted decision: Smithers SQLite is primary, logs/overlays are enrichments, and `runs/index.json`/`runs/<runId>` are legacy/derived rather than authoritative.

For implementation follow-up, open `src/server.ts` next: project-mode endpoints already exist, but they are where current drift from the documented `SmithersAdapter`/canonical-state model is concentrated.

## Supervisor coordination

No supervisor decision needed. Key caveats/open questions for the next implementer:

- Treat “read Smithers state directly” as “read from Smithers DB/runtime/log sources, preferably through a narrow adapter”; do not manually write `_smithers_runs` or output tables.
- Logs are optional/movable; absence of `stream.ndjson` must not mean “run does not exist.” `_smithers_runs`/SQLite state is primary.
- Render/graph should mean no task execution and no run insertion, but local docs/source show rendering may import workflow code and touch/open Smithers DB/cache files. Tests should document that nuance rather than requiring filesystem purity.
- Smithers CLI should be run from the project root. File-path commands take `.smithers/workflows/<id>.tsx`; `workflow run/list/path` resolve IDs from cwd.
- `graph` defaults `--run-id graph` and source loads persisted input/outputs for that run id; fresh preview should avoid accidentally reading persisted outputs (unique empty preview run id or in-process empty-output adapter path).
- If run logs must land in default canonical shape, be careful with `--root` and avoid overriding `--log-dir` to a flat directory unless intentionally changing Smithers log location.
- Overlay location remains TBD; overlays must be optional and non-authoritative.
