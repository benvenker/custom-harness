# Code Context

## Files Retrieved
1. `node_modules/smithers-orchestrator/package.json` (lines 1-54) - public facade package; `bin.smithers` points at `src/bin/smithers.js` and depends on `@smithers-orchestrator/*` v0.18.0.
2. `node_modules/smithers-orchestrator/src/bin/smithers.js` (lines 1-35) - public `smithers` bin delegates to local `.smithers/node_modules/.bin/smithers` if present, else imports `@smithers-orchestrator/cli`.
3. `node_modules/@smithers-orchestrator/db/package.json` (lines 1-43) - DB package exports source JS and umbrella `src/index.d.ts` types.
4. `node_modules/@smithers-orchestrator/db/src/sql-message-storage.js` (lines 1-380, 381-720, 721-835) - canonical SQLite `CREATE TABLE`, migrations/indexes, raw SQL helpers, event history query methods.
5. `node_modules/@smithers-orchestrator/db/src/internal-schema/*.js` (selected: `smithersRuns.js`, `smithersNodes.js`, `smithersAttempts.js`, `smithersFrames.js`, `smithersEvents.js`, `smithersToolCalls.js`, `smithersCache.js`, `index.js`; lines 1-full) - Drizzle table objects for `_smithers_*` tables.
6. `node_modules/@smithers-orchestrator/db/src/adapter/RunRow.ts` (lines 1-22), `NodeRow.ts` (1-10), `AttemptRow.ts` (1-17), `DB_RUN_ALLOWED_STATUSES.js` (1-10) - core row/status types.
7. `node_modules/@smithers-orchestrator/db/src/adapter/SmithersDb.js` (lines 520-1165, 1760-1995) and `node_modules/@smithers-orchestrator/db/src/index.d.ts` (lines 480-1225) - public adapter methods for runs, nodes, attempts, outputs, frames, events, approvals, tool calls.
8. `node_modules/@smithers-orchestrator/db/src/output.js` (lines 1-180) and `zodToCreateTableSQL.js` (1-82) - output table access/schema creation helpers.
9. `node_modules/@smithers-orchestrator/db/src/runState/*.js|*.ts` (`RunState.ts` 1-12, `RunStateView.ts` 1-10, `ReasonBlocked.ts` 1-13, `ReasonUnhealthy.ts` 1-8, `computeRunState*.js`, `deriveRunState.js`) - derived run-state API and semantics.
10. `node_modules/@smithers-orchestrator/cli/src/index.js` (lines 458-1217, 1213-1417, 1448-1730, 1722-1836, 2472-2715, 2648-3193, 3400-3505, 4178-4288, 5088-5203, 5340-5405) - CLI commands/options and JSON behavior for `ps`, `logs`, `events`, `chat`, `inspect`, `graph`, `workflow run`.
11. `node_modules/@smithers-orchestrator/cli/src/find-db.js` (lines 1-83) and `dist/find-db.d.ts` (1-50) - direct TS-callable DB discovery/open helpers.
12. `node_modules/@smithers-orchestrator/cli/src/chat.js` (lines 1-207) and `dist/chat.d.ts` (1-92) - direct TS-callable chat parsing/formatting helpers.
13. `node_modules/@smithers-orchestrator/cli/dist/node-detail.d.ts` (lines 1-129) - direct TS-callable node detail aggregation type/function.
14. `node_modules/@smithers-orchestrator/engine/src/events.js` (lines 1-225) and `engine/src/engine.js` (lines 1260-1274, 2538-2578, 2766-3022, 3696-3746, 4234-4265) - event persistence, log path, engine writes to run-state tables.
15. `node_modules/@smithers-orchestrator/driver/src/index.d.ts` (lines 55-90) and `@smithers-orchestrator/engine/src/index.d.ts` (lines 1563-1590) - direct `runWorkflow`, `renderFrame`, `resolveSchema`, `RunOptions` APIs.

## Key Code

### SQLite tables / schema
- `SqlMessageStorage` creates all internal tables in `CREATE_TABLE_STATEMENTS` (`db/src/sql-message-storage.js:13-317`). Core run-state tables:
  - `_smithers_runs` (`lines 16-35`): `run_id` PK, `parent_run_id`, workflow fields, `status`, created/started/finished/heartbeat, `runtime_owner_id`, cancel/hijack fields, VCS fields, `error_json`, `config_json`.
  - `_smithers_nodes` (`37-46`): PK `(run_id,node_id,iteration)`, `state`, `last_attempt`, `updated_at_ms`, `output_table`, `label`.
  - `_smithers_attempts` (`48-64`): PK `(run_id,node_id,iteration,attempt)`, `state`, started/finished/heartbeat, `heartbeat_data_json`, `error_json`, `jj_pointer`, `response_text`, `jj_cwd`, `cached`, `meta_json`.
  - `_smithers_frames` (`66-76`): PK `(run_id,frame_no)`, `xml_json`, `xml_hash`, `encoding`, mounted task/index JSON.
  - `_smithers_events` (`205-211`): PK `(run_id,seq)`, `timestamp_ms`, `type`, `payload_json`.
  - `_smithers_tool_calls` (`190-203`): PK `(run_id,node_id,iteration,attempt,seq)`, tool input/output/status/error JSON.
  - `_smithers_approvals`, `_smithers_human_requests`, `_smithers_signals`, `_smithers_cache`, `_smithers_node_diffs`, `_smithers_ralph`, `_smithers_cron`, snapshots/branches/VCS/memory/scorers also created in same list.
- Indexes/migrations: `_smithers_runs_status_heartbeat_idx`, `_smithers_signals_lookup_idx`, `_smithers_time_travel_audit_lookup_idx` at `sql-message-storage.js:319-326`; legacy ALTERs and `_smithers_runs_parent_idx`/alert indexes at `328-367`.
- Drizzle schema mirrors internal tables in `db/src/internal-schema/*`; exported from `internal-schema/index.js:1-20` and umbrella `db/src/index.js:6-18`.
- Output tables are workflow-defined Drizzle/Zod tables, not fixed `_smithers_*`: `buildOutputRow` injects `runId/nodeId/iteration` (`output.js:13-33`); `getKeyColumns` requires `runId`/`nodeId` (`44-57`); `zodToCreateTableSQL` creates output tables with `run_id`, `node_id`, `iteration`, PK `(run_id,node_id,iteration)` unless input table (`zodToCreateTableSQL.js:36-53`).

### Run/node/task state semantics
- DB statuses allowed: `running`, `waiting-approval`, `waiting-event`, `waiting-timer`, `finished`, `failed`, `cancelled`, `continued` (`adapter/DB_RUN_ALLOWED_STATUSES.js:1-10`).
- Derived `RunState`: `running`, waiting variants, `recovering`, `stale`, `orphaned`, terminal states, `unknown` (`runState/RunState.ts:1-12`).
- `deriveRunState` maps DB `finished|continued -> succeeded`, waiting statuses to blocked reasons, `running` to `running/stale/orphaned` based on heartbeat/runtime owner (`runState/deriveRunState.js:7-86`).
- `computeRunStateFromRow(adapter, run)` loads pending approval/timer/event from adapter (`computeRunStateFromRow.js:9-83`), then calls `deriveRunState`.
- Engine writes task lifecycle:
  - task start inserts/upserts `_smithers_attempts` and `_smithers_nodes` state `in-progress` (`engine/src/engine.js:2538-2568`).
  - task output emits queued `NodeOutput` events with text/stream in payload (`2766-2778`).
  - agent CLI events emit `AgentEvent` payloads (`2982-3022`).
  - task completion upserts workflow output row, updates attempt `finished`, node `finished` (`3696-3734`).
  - run start/resume inserts/updates `_smithers_runs`; waits set DB status waiting-*; terminal updates to finished/failed/cancelled (grep evidence around `engine.js:4398-4537`, `4777-4834`, `4985-5015`, `6365-6840`).

### Events and logs
- Event persistence: `EventBus.persistDb` serializes full event to `payload_json` and uses `insertEventWithNextSeq*` if present (`engine/src/events.js:113-154`).
- Log file: `EventBus.persistLog` writes NDJSON to `join(logDir, "stream.ndjson")` (`events.js:180-205`). It rewrites file with existing prefix + new line (not append stream).
- Canonical log dir: `resolveLogDir(rootDir, runId, logDir)` returns `undefined` if `logDir === null`, `resolve(rootDir, logDir)` if string, else `resolve(rootDir, ".smithers", "executions", runId, "logs")` (`engine/src/engine.js:1260-1274`). Therefore default event log path is `<rootDir>/.smithers/executions/<runId>/logs/stream.ndjson`.
- CLI detached mode writes process stdout/stderr to `<logFileDir>/<runId>.log`, where `logFileDir = options.logDir ?? dirname(workflowPath)` (`cli/src/index.js:1507-1521`). This is separate from EventBus `stream.ndjson`.

### CLI JSON-capable commands
- Global machine output uses Incur format flags: `--format json` / `--format=json` / `jsonl`; `argvRequestsJsonMode` detects format flags and selected command `--json` (`cli/src/index.js:5088-5148`). `setJsonMode(true)` routes console/effect logs to stderr (`util/logger.ts:30-88`; main at `index.js:5340-5353`).
- `ps`: options `status, limit, all, watch, interval` (`index.js:1249-1255`), command at `2655-2701`. Returns `c.ok({ runs: rows })`; use `smithers ps --format json`. Watch mode writes JSON/JSONL if `c.format` is `json/jsonl` via `writeWatchOutput` (`458-474`, `2666-2677`).
- `inspect <runId>`: options `watch, interval` (`1290-1293`), command `3404-3458`. Returns snapshot result via `c.ok(snapshot.result)`, watch respects `--format json/jsonl`. `argvRequestsJsonMode` also treats command-scoped `--json` as JSON mode for inspect, but there is no inspect option schema `json`; safest is `--format json`.
- `logs <runId>`: options `follow, since, tail, followAncestry` (`1258-1263`), command `2705-2715`. It streams human formatted event lines only via `streamRunEventsCommand`; no command JSON option. For JSON events, use `events`.
- `events <runId>`: options include `json`, `groupBy`, `watch` (`1264-1273`), command `2717-2909`. `--json` emits NDJSON lines `{runId,seq,timestampMs,type,payload}` using `buildEventNdjsonLine` (`815-826`); `rewriteEventsJsonFlagArgv` routes raw `--json` to command `-j` (`5176-5186`).
- `chat [runId]`: options `all, follow, tail, stderr` (`1274-1282`), command `2912-3179`. It emits human transcript lines only; no JSON option. To build JSON, call adapter/list events + chat helpers directly.
- `graph <workflow>`: options `runId`, `input` (`1353-1356`), command `4181-4224`; returns JSON-serializable snapshot via `c.ok(...)`, so use `--format json`.
- `workflow run <name>`: options extend `upOptions` plus `prompt` (`1375-1377`), command `1722-1754`; internally calls `executeUpCommand`, returns `RunResult` or detached `{runId,logFile,pid}` through `c.ok` (`1448-1730`). Use `--format json` for machine output; also `workflow <id>` is rewritten to `workflow run <id>` (`5150-5175`).

### Direct TypeScript-callable APIs
- DB open/discovery: `findSmithersDb`, `waitForSmithersDb`, `openSmithersDb`, `findAndOpenDb` exported from `@smithers-orchestrator/cli/find-db` with types in `dist/find-db.d.ts:1-50`; implementation opens Bun SQLite, wraps Drizzle, `ensureSmithersTables`, returns `SmithersDb` + cleanup (`cli/src/find-db.js:56-83`).
- Adapter: import `SmithersDb` from `@smithers-orchestrator/db/adapter` or `@smithers-orchestrator/db`; construct with Drizzle Bun SQLite DB. Main methods in `index.d.ts:480-1225` / `adapter/SmithersDb.js`:
  - runs: `insertRun`, `updateRun`, `heartbeatRun`, `requestRunCancel`, `getRun`, `listRuns`, `listRunAncestry`, `listStaleRunningRuns`, resume claim methods.
  - nodes/attempts: `getNode`, `listNodes`, `listNodeIterations`, `insertNode`, `insertAttempt`, `updateAttempt`, `heartbeatAttempt`, `listAttempts`, `listAttemptsForRun`, `listInProgressAttempts`.
  - outputs: `upsertOutputRow`, `getRawNodeOutput`, `getRawNodeOutputForIteration`, `deleteOutputRow`.
  - events: `insertEventWithNextSeq`, `getLastEventSeq`, `listEventHistory`, `countEventHistory`, `listEvents`, `listEventsByType`.
  - frames/tool calls/approvals: `getLastFrame`, `listFrames`, `listToolCalls`, `listPendingApprovals`, human request methods.
  - Note `RunnableEffect<A,E>` is `Effect.Effect<A,E> & PromiseLike<A>` (`index.d.ts:384-386`), so CLI frequently uses `await adapter.method(...)`; Effect users can compose `*Effect` variants.
- Raw storage: `getSqlMessageStorage`, `ensureSqlMessageStorage`, `SqlMessageStorage.queryAll/queryOne/execute/listEventHistory` from `@smithers-orchestrator/db/sql-message-storage` (`sql-message-storage.js:604-835`, d.ts `260-360`). Useful for raw SQL; rows are snake->camel transformed.
- Run-state: runtime export exists at `@smithers-orchestrator/db/runState` (`runState.js:1-7`): `computeRunState(adapter, runId)`, `computeRunStateFromRow(adapter, run)`, `deriveRunState`, `RUN_STATE_HEARTBEAT_STALE_MS`. Types are TS source files under `db/src/runState/*.ts`; package wildcard export maps types to `src/index.d.ts`, which does **not** include runState declarations, so TS may need local structural types or deep JS import with loose typing.
- Chat helpers: `@smithers-orchestrator/cli/chat` exports `parseChatAttemptMeta`, `chatAttemptKey`, `parseNodeOutputEvent`, `parseAgentEvent`, `selectChatAttempts`, formatters (`dist/chat.d.ts:1-92`; source `chat.js:1-207`).
- Node detail: `@smithers-orchestrator/cli/node-detail` exports `aggregateNodeDetailEffect(adapter,{runId,nodeId,iteration})` and `renderNodeDetailHuman` (`dist/node-detail.d.ts:1-129`).
- Engine: `runWorkflow(workflow, opts)`, `renderFrame`, `resolveSchema` exported from `@smithers-orchestrator/engine` (`engine/src/index.d.ts:1563-1590`). `RunOptions` include `runId`, `input`, `onProgress`, `resume`, `workflowPath`, `rootDir`, `logDir`, `allowNetwork`, limits, hot, auth/config, resumeClaim (`driver/src/index.d.ts:55-78`). Public facade `smithers-orchestrator` depends on engine but does not appear to re-export run-state adapter APIs.

## Architecture
Smithers persists workflow runtime state in a Bun SQLite database (`smithers.db`) using a Drizzle DB plus `SqlMessageStorage`. The engine (`@smithers-orchestrator/engine`) owns writes: it ensures tables, inserts/updates `_smithers_runs`, `_smithers_nodes`, `_smithers_attempts`, upserts workflow output rows, inserts `_smithers_frames`, and emits every lifecycle/chat event through `EventBus`. `EventBus` writes the same event to `_smithers_events` and optionally to `stream.ndjson` under the resolved log dir.

The CLI (`@smithers-orchestrator/cli`) is mostly a thin query/render layer. It finds the nearest `smithers.db` by walking upward, opens a `SmithersDb` adapter, and builds command outputs from adapter methods. `ps` derives live/stale/orphaned state via `computeRunStateFromRow`; `inspect` builds a snapshot from run/nodes/approvals/timers/loops; `logs` tails formatted `_smithers_events`; `events --json` is the actual JSON/NDJSON event stream; `chat` reconstructs transcript from attempts plus `NodeOutput`/`AgentEvent` rows.

CLI machine output generally comes from Incur `--format json`/`jsonl`; only some commands have a command-scoped `--json` (`events`, devtools `tree/diff/output/rewind`, `why`, etc.). `logs` and `chat` do not expose JSON options in this version.

## Start Here
Start with `node_modules/@smithers-orchestrator/cli/src/find-db.js` to open the DB, then `node_modules/@smithers-orchestrator/db/src/adapter/SmithersDb.js` for callable run-state methods. For schema-level details, open `node_modules/@smithers-orchestrator/db/src/sql-message-storage.js` first.
