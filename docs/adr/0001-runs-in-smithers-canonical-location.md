# Studio runs converge on Smithers canonical run state

The Studio should not maintain a parallel run database as the source of truth. Two surfaces author and consume runs in this project — the Studio UI, and AI agents using Smithers via its CLI — and divergence between them defeats the purpose. Going forward, Studio-launched runs use Smithers' runtime/DB/log conventions so that `bunx smithers-orchestrator ps`, `chat`, `logs`, `fork`, etc. see the same runs the Studio shows, and vice versa.

## What "Smithers canonical run state" actually is

Per CONTEXT.md "Documented Smithers facts" and source anchors:

- **Run identity** (`runId`, status, workflow path/name, parent/fork links) lives in `_smithers_runs` in the nearest `smithers.db`. Sources: `docs/smithersai-smithers.txt:3352`, `docs/smithersai-smithers.txt:6744`, `@smithers-orchestrator/db/src/index.d.ts:1433+`.
- **Per-run event log** defaults to `<smithers workspace directory>/executions/<runId>/logs/stream.ndjson`. Source: `docs/smithersai-smithers.txt:1294`. This is a canonical Smithers log artifact when logging is enabled, but it can be moved with `--log-dir` or disabled with `--no-log`.
- **Frame / node / attempt / output / approval / signal state** is in SQLite tables, including `_smithers_*` tables and per-schema output tables. Sources: `docs/smithersai-smithers.txt:587`, `docs/smithersai-smithers.txt:9396`, `docs/smithersai-smithers.txt:15487`.

So canonical run state is primarily **the Smithers SQLite DB**. The default NDJSON log is important observability evidence when present, but Studio must not require a log file to consider a run real. A Smithers run is not "a folder on disk we can author."

## Studio overlays (intent, not yet implemented)

Studio-specific metadata — rendered graph layout, prompt baselines, UI annotations — is decoration, not run state. It may live alongside Smithers' canonical files (location TBD when implemented), but it must:

- Be optional: a run with no Studio overlay must still be visible and usable in the Studio.
- Never be claimed as authoritative: tearing the overlay off the run must not affect Smithers' ability to operate on the run.

## Considered alternatives

- **Status quo (`<repo>/runs/<runId>/`)** — current custom-harness reality (`src/runs/recorder.ts`). The historical Flue-era split. Smithers DB and logs are not where this tree expects them, so agent CLI tools and Studio diverge.
- **Studio-owned overlay/sidecar under `.smithers/executions/<runId>/studio/`** — places Studio metadata next to Smithers' default log artifacts but inside the Smithers-managed directory. Acceptable only if Smithers itself does not consider that subpath part of its own run state, and only if Studio treats it as optional decoration rather than a mirror of canonical state.

## Consequences

- The current `runs/` tree at the repo root becomes legacy. Migration of existing runs is a one-shot task (or accepting their loss is fine if the prototype can start from empty).
- The Studio's `runs/index.json` becomes a *derived view*, not a database. It should be computed by querying Smithers DB state first, then enriching with logs and Studio overlays when they exist.
- Studio launch code must call Smithers runtime/CLI surfaces (`runWorkflow`, `bunx smithers-orchestrator up`, or equivalent Smithers APIs). It must not create fake Smithers runs by writing Studio JSON files or hand-inserting partial DB rows.
- Studio listing and inspection must work from Smithers DB state first. Logs and Studio overlays are optional enrichments.
- Studio code must tolerate runs with no Studio overlay (e.g. agent-launched runs). Studio overlays degrade gracefully when its own files are missing.
- This decision says nothing about *where* Studio overlays live — that's a smaller, follow-up decision when the Studio's recorder is reworked.

## Status

Accepted as direction. Not yet implemented in code: `src/runs/recorder.ts` still writes to `runs/<runId>/` and there is no Smithers DB read path in the Studio yet. Implementation lands as a separate slice.
