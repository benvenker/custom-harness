# Smithers Inspection API Expansion Plan

## Purpose

Make project-mode Run Inspection faithful to Smithers Run State, starting with the narrow historical-graph provenance fix.

The long-term direction is a broad, read-only Smithers Inspection API over the installed Smithers dependency and `smithers.db`. The v1 scope is smaller: preserve enough Run Frame fidelity to reconstruct historical Workflow Graphs from the selected Run's persisted Smithers Run Frame, then have the browser consume that tested projection instead of current Workflow Source.

## Required context

Read these before implementation:

- `CONTEXT.md` — canonical domain language.
- `docs/agents/domain.md` — domain-doc consumer rules for agent skills.
- `docs/smithers-integration-context.md` — Smithers' role as foundational third-party infrastructure.
- `/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt` — downloaded Smithers reference docs.
- Installed Smithers package source under `node_modules/@smthrs/`.
- `docs/adr/0001-runs-in-smithers-canonical-location.md` — Smithers DB is canonical run state.
- `docs/adr/0003-reflect-smithers-first-smooth-with-overlays.md` — reflect Smithers first; overlays are presentation aids.
- `docs/adr/0004-project-mode-run-inspection-reads-smithers-sqlite.md` — project-mode inspection reads Smithers SQLite.
- `docs/adr/0005-historical-run-inspection-provenance.md` — historical inspection uses persisted Smithers run frames.
- `docs/adr/0006-editor-metadata-for-source-editing.md` — `Task.meta.editor` is a source-editing bridge, not run truth.

Relevant implementation files today:

- `src/smithersProject/runReader.ts`
- `src/smithersProject/runReaderTypes.ts`
- `src/smithersProject/sqliteReadOnly.ts`
- `src/server.ts`
- `src/runs/smithersGraph.ts`
- `src/ui/smithersRunOverlay.ts`
- `src/ui/projectLiveState.ts`
- `web/index.html`

Relevant tests today:

- `tests/smithersRunReader.test.ts`
- `tests/server.test.ts`
- `tests/smithersGraph.test.ts`
- `tests/workflowViewer.ui.test.ts`

## Ubiquitous language

Use the terms from `CONTEXT.md`:

- **Smithers** — third-party foundational runtime dependency.
- **Workflow Source** — `.smithers/workflows/*.tsx` plus related Smithers workflow-pack files.
- **Run** — one Smithers execution.
- **Smithers Run State** — native SQLite-backed Smithers records for a Run.
- **Smithers Inspection API** — CustomHarness read-only web/API surface over Smithers Run State.
- **Run Frame** — persisted Smithers snapshot of a Run's rendered workflow structure.
- **Workflow Graph** — visual projection of Smithers graph/frame state, not source of truth.
- **Run Inspection** — read-only view of a Smithers run.
- **Editor Metadata** — CustomHarness-owned `Task.meta.editor` source-editing bridge.
- **Legacy Run Artifacts** — old `runs/<runId>/` JSON compatibility artifacts.

## Non-negotiable decisions

1. Smithers is external infrastructure and the source of truth for project-mode Run state.
2. Preserve Smithers concepts and fidelity until the final UI projection step.
3. Prefer installed Smithers package/adapter read APIs over raw SQL.
4. Use centralized read-only SQL only for Smithers state not exposed by the package.
5. Do not underscope merely to avoid mapping work, but do not expand v1 beyond the historical graph provenance fix.
6. Keep CustomHarness `RenderGraph` as optional view data, not the primary Run representation.
7. Historical Run Inspection is read-only and uses persisted Run Frames.
8. Current Workflow Source is for previewing, editing, and launching future Runs only.
9. Missing historical prompt/model/source-facing values must show as unknown/not captured, not be filled from current Workflow Source.
10. Do not manually mutate `_smithers_*` tables or workflow output tables.

## Current problem

Current project run loading uses `currentWorkflowGraph` — the graph rendered from current Workflow Source — and overlays selected Run state onto it. This can make historical views display current source structure, labels, prompts, models, or editor metadata as if they belonged to the selected historical Run.

`SmithersRunReader` also reduces frame data to metadata-only summaries. It does not expose inflated frame `xmlJson` or parsed `xml`, which prevents reconstructing historical Workflow Graphs from persisted Run Frames.

## Target architecture

```txt
Smithers package + smithers.db
  -> CustomHarness SmithersRunReader / Inspection API
  -> broad Smithers-native-ish inspection JSON
  -> optional server-side view projection (`view.graph`)
  -> browser UI
```

Avoid:

```txt
Smithers DB
  -> lossy CustomHarness run DTO
  -> current Workflow Source graph
  -> DB state overlay
```

## Desired API shape

`GET /api/smithers/runs/:runId` remains the convenient inspection bundle. For v1, broaden it only enough to carry high-fidelity frame data and optional historical graph projection. Keep `/api/smithers/runs/:runId/events` for polling/high-volume event reads.

Possible query shape:

```txt
GET /api/smithers/runs/:runId?include=nodes,attempts,events,frames,outputs,approvals,signals,snapshots,humanRequests,view
```

Default can include common data, but the design should stay Smithers-shaped, not UI-shaped. Approvals, signals, snapshots, human requests, alerts/scorers/cache are future expansion unless discovered as necessary for the historical graph fix.

Target response direction:

```ts
type SmithersRunInspection = {
  run: SmithersRunSummary;
  nodes: SmithersRunNode[];
  attempts: SmithersRunAttempt[];
  events: SmithersRunEvent[];
  frames: SmithersRunFrameInspection[];
  outputs: SmithersRunOutput[];
  approvals?: SmithersApproval[];
  signals?: SmithersSignal[];
  snapshots?: SmithersSnapshot[];
  humanRequests?: SmithersHumanRequest[];
  parseWarnings: SmithersParseWarning[];
  cursors: SmithersRunCursors;
  view?: {
    graph?: RenderGraph;
    graphSource: {
      kind: "smithers-frame" | "unavailable";
      runId: string;
      frameNo?: number;
      fallback: false;
      reason?: string;
    };
  };
};

type SmithersRunFrameInspection = {
  runId: string;
  frameNo: number;
  createdAtMs: number;
  xmlHash: string;
  encoding: string;
  xmlJson: string; // inflated/reconstructed via Smithers adapter where possible
  xml: XmlNode | null; // parsed companion
  mountedTaskIdsJson: string | null;
  mountedTaskIds: string[];
  taskIndexJson: string | null;
  taskIndex: unknown; // parsed companion; preserve Smithers shape
  note: string | null;
};
```

Naming may change during implementation, but preserve Smithers vocabulary and keep raw fields next to parsed companions where provenance matters.

## V1 scope

In scope now:

- Inventory Smithers read surfaces enough to avoid duplicating frame behavior.
- Preserve frame `xmlJson`, parsed `xml`, `taskIndexJson`, and parsed `taskIndex`.
- Use Smithers adapter/package frame inflation for latest frames.
- Add optional server-side `view.graph` from the latest persisted Run Frame.
- For v1, include `detail.view` by default on `GET /api/smithers/runs/:runId`; no `include=view` query is required for the first historical implementation.
- Update browser historical Run Inspection to consume `detail.view.graph`.
- Disable or separate source-editing controls during historical inspection.

Out of scope for v1:

- Broad mapping of every Smithers table.
- Approvals/signals/snapshots/human requests unless needed for the graph provenance fix.
- Frame picker/time-travel UI.
- Pagination/lazy-loading for large non-frame data.

## Implementation plan

### Slice 1 — inventory Smithers read surfaces for frames

Goal: understand what the installed Smithers dependency exposes for frames and related graph reconstruction before adding CustomHarness SQL.

Tasks:

- Inspect `node_modules/@smthrs/db/src/adapter.js` and type declarations.
- List stable read methods for runs, nodes, attempts, frames, and events already used by the current reader.
- Identify which frame methods already perform important behavior, especially delta inflation.
- Identify missing frame/task-index read surfaces that require centralized read-only SQL in `src/smithersProject`.
- Note, but do not implement, future read surfaces for approvals, signals, snapshots, human requests, alerts/scorers/cache.

Deliverable:

- Add an inventory section to this plan or a short follow-up doc/checklist summarizing adapter methods and SQL gaps.

Acceptance criteria:

- We know how to obtain inflated latest frame data through Smithers package APIs.
- Any planned raw SQL for frame data is justified by a missing package read surface.
- No implementation slice begins by duplicating Smithers frame-codec behavior.

#### Slice 1 inventory result — 2026-05-09

Installed Smithers already exposes the frame reads needed for historical v1; CustomHarness should use those adapter methods rather than copying frame-codec behavior.

Relevant Smithers package files:

- `node_modules/@smthrs/db/src/adapter.js`
  - Read methods for current inspection: `getRun`, `listRuns`, `listNodes`, `listAttemptsForRun`, `listEventHistory`, `getLastEventSeq`, `getRawNodeOutputForIteration`.
  - Frame methods: `getLastFrame`, `listFrames`, `listFrameChainDesc`, `inflateFrameRow`, `reconstructFrameXml`.
  - Future read surfaces noted but out of v1: `listSignals`, `listPendingApprovals`, `listApprovalHistoryForNode`, `listPendingHumanRequests`, `listAlerts`, `listScorerResults`, `listCacheByNode`.
- `node_modules/@smthrs/db/src/index.d.ts`
  - Exports `FrameRow` with `runId`, `frameNo`, `createdAtMs`, `xmlJson`, `xmlHash`, `encoding`, `mountedTaskIdsJson`, `taskIndexJson`, and `note`.
  - Exports frame-codec helpers, but CustomHarness should not call them for normal inspection when adapter inflation is available.
- `node_modules/@smthrs/db/src/frame-codec.js`
  - Implements `normalizeFrameEncoding`, `parseFrameDelta`, `applyFrameDelta`, and `applyFrameDeltaJson`; these are used by the adapter during inflation.
- `node_modules/@smthrs/graph/src/utils/xml.js`
  - Exposes `parseXmlJson(json)` and `canonicalizeXml(node)` at runtime through the `@smthrs/graph/utils/xml` subpath. Type declarations for that subpath may need a local shim if TypeScript import ergonomics fail.
- Smithers examples that already read frames this way:
  - `node_modules/@smthrs/server/src/gatewayRoutes/getDevToolsSnapshot.js` uses `adapter.getLastFrame()` for the latest frame and `adapter.listFrames(...).find(...)` for a requested historical frame before parsing `xmlJson`.
  - `node_modules/@smthrs/server/src/gatewayRoutes/streamDevTools.js` obtains latest frames through the same adapter-backed route.
  - `node_modules/@smthrs/cli/src/tui/components/FramesPane.jsx` calls `adapter.listFrames(runId, 500)` and parses returned `xmlJson`.

Frame inflation behavior:

- Use `adapter.getLastFrame(runId)` for the default/latest historical graph source. It returns an inflated `FrameRow` because it calls `inflateFrameRow()`.
- Use `adapter.listFrames(runId, limit, afterFrameNo?)` for multi-frame inspection. It inflates each returned row through `inflateFrameRow()` with a local cache.
- Avoid exposing `adapter.listFrameChainDesc()` rows directly in CustomHarness API responses. That method returns raw frame rows and is useful to `reconstructFrameXml()`, but delta rows are not inflated unless passed through the adapter inflation path.
- `inflateFrameRow(row)` normalizes `encoding`; when `encoding === "delta"`, it calls `reconstructFrameXml()` to walk back to a non-delta/keyframe and apply Smithers frame deltas.
- `reconstructFrameXml()` is the canonical installed behavior for delta reconstruction. Do not implement a CustomHarness frame codec while this method is available.

Current CustomHarness reader status:

- `src/smithersProject/sqliteReadOnly.ts` opens `smithers.db` with `readonly: true`, sets `PRAGMA query_only = ON`, and creates a Smithers `SmithersDb` adapter over that handle.
- `src/smithersProject/runReader.ts` already uses adapter APIs for most inspection reads: `listRuns`, `getRun`, `listNodes`, `listAttemptsForRun`, `listEventHistory`, `getLastEventSeq`, `getLastFrame`, and `getRawNodeOutputForIteration`.
- The only current CustomHarness raw SQL is `listWorkflowRuns()` in `src/smithersProject/runReader.ts`, which filters `_smithers_runs` by workflow id/path because the installed adapter has no workflow-id-specific list method. This fallback is centralized behind the read-only handle and remains justified.
- `toRunFrame()` currently receives `xmlJson` from Smithers but drops it. It preserves `taskIndexJson` and parsed `taskIndex`, but not parsed frame XML.
- `listFrameMetadata()` currently uses `getLastFrame()` for `frameLimit === 1`, which is good, but uses `listFrameChainDesc()` for `frameLimit > 1`, which can expose non-inflated delta rows. Future code should switch multi-frame reads to `adapter.listFrames()` or explicitly inflate rows through the adapter.

Gaps and implications for later slices:

- No raw SQL is needed for latest-frame historical graph v1; use `getLastFrame()`.
- No raw SQL is needed for multi-frame API responses if `listFrames()` is sufficient. Raw SQL should only be considered for a future exact `getFrame(runId, frameNo)` if `listFrames(...).find(...)` is inadequate.
- CustomHarness must parse `FrameRow.xmlJson` into a parsed `xml` companion while preserving the original inflated `xmlJson`. Malformed XML JSON should create field-level parse warnings and not drop the run detail.
- `taskIndexJson` may contain only minimal task entries (`nodeId`, `ordinal`, `iteration`) in current Smithers engine writes, so historical prompts/models/editor metadata may genuinely be unavailable. Later graph projection must show unknown/not captured instead of filling from current Workflow Source.
- Broad output, approval, signal, snapshot, human-request, alert, scorer, and cache mapping remains future work unless required for the historical graph provenance fix.

### Slice 2 — broaden `SmithersRunReader` types

Goal: make the internal TypeScript contract capable of carrying Smithers Run State without losing frame fidelity.

Tasks:

- Extend `src/smithersProject/runReaderTypes.ts` with high-fidelity frame fields: `xmlJson`, parsed `xml`, parsed `taskIndex`.
- Add include/query option types if useful.
- Leave approvals, signals, snapshots, and human requests as future optional collections unless implementation discovers they are required for frame graph provenance.
- Keep raw JSON fields and parsed companions side-by-side.
- Keep mechanical camelCase normalization; do not rename Smithers concepts into CustomHarness product concepts.

Acceptance criteria:

- Frame `xmlJson` is representable in the public reader/API type.
- Parsed frame `xml` is representable without discarding parse warnings.
- `taskIndexJson` and parsed `taskIndex` are preserved.
- Future optional collections can be added later without breaking existing callers.

### Slice 3 — implement reader mapping

Goal: read broad Smithers state safely and faithfully.

Tasks:

- Prefer Smithers adapter read methods.
- Use `adapter.getLastFrame()` / `adapter.listFrames()` where possible so delta-encoded frames are inflated by Smithers.
- Parse frame `xmlJson` into `xml`, but preserve `xmlJson`.
- Preserve `taskIndexJson` and parsed `taskIndex` without over-interpreting it.
- Do not add broad non-frame collections in v1 unless required for graph provenance.
- Centralize any fallback SQL in `src/smithersProject` and keep it read-only.

Acceptance criteria:

- Latest frame data includes inflated `xmlJson` even when the stored row was delta-encoded.
- Malformed JSON produces field-level parse warnings without dropping the whole Run detail.
- Missing optional frame/task-index data degrades to warnings or unavailable fields, not crashes.
- Existing read-only guarantees remain intact.

### Slice 4 — server-side historical graph projection

Goal: provide a tested optional `view.graph` projection from persisted Smithers frame data.

Tasks:

- Build a server-side projection function that converts the selected/latest frame into the graph source for `smithersSnapshotToRenderGraph`.
- Use the latest fully reconstructed frame by default.
- Overlay node/attempt/output/event status from the same Run.
- Return the projection as optional `detail.view.graph`.
- Return explicit `view.graphSource` provenance.
- If projection is unavailable, return `graphSource.kind === 'unavailable'` and omit `detail.view.graph`. Do not use current Workflow Source as a historical fallback in v1.

Important constraint:

Smithers frame `taskIndexJson` may not include full `TaskDescriptor` fields like prompt, agent, or model. If unavailable, historical prompt/model labels must show unknown/not captured rather than filling from current Workflow Source.

Acceptance criteria:

- `view.graph.source.frameNo` or `view.graphSource.frameNo` matches the selected frame.
- Projection does not read or require `.smithers/workflows/*.tsx` current source.
- Historical graph provenance is visible in the response.
- Fallbacks are explicit and test-covered.

### Slice 5 — tests first

Goal: lock the API shape before UI changes.

Tests to add/update:

- `tests/smithersRunReader.test.ts`
  - frame `xmlJson` is exposed, not stripped.
  - frame `xml` parses from `xmlJson`.
  - latest delta frame is inflated/reconstructed through Smithers adapter behavior.
  - `taskIndexJson` and parsed `taskIndex` are preserved.
  - future broad Smithers state collections remain out of v1 unless required.
  - malformed frame/task JSON creates parse warnings.

- `tests/server.test.ts`
  - `/api/smithers/runs/:runId` returns high-fidelity frame data.
  - `detail.view` is included by default for v1 when projection is available or explicitly unavailable.
  - optional `view.graph` reports `graphSource.kind === 'smithers-frame'` and matching `frameNo`.
  - unavailable frame/projection cases are explicitly marked with `graphSource.kind === 'unavailable'`; `fallback-current-source` is not valid for historical v1.

- `tests/smithersGraph.test.ts` or new projection tests
  - graph projection from persisted frame does not require current Workflow Source.
  - historical graph source provenance points to the selected Run/Frame.
  - missing prompt/model fields remain unknown/not captured.

Acceptance criteria:

- Tests can verify the API without browser changes.
- UI work becomes mostly replacing data source wiring.

### Slice 6 — browser UI update

Goal: make project historical Run Inspection consume the tested Inspection API projection.

Tasks:

- Update `web/index.html` `loadProjectRun()` path to prefer `detail.view.graph` for selected historical runs.
- Stop using `currentWorkflowGraph` as the normal graph source for selected historical runs.
- Keep current Workflow Source preview for workflow editing and future runs.
- Disable node-level source-editing controls while inspecting historical runs.
- Show unknown/not captured for historical prompt/model/source-facing values missing from run state.
- Display graph provenance: Smithers Run id and frame no.

Acceptance criteria:

- Selecting a historical run does not re-render graph structure from current source.
- Editing controls do not appear inline as if they mutate historical nodes.
- Current workflow preview/edit path still works.
- Existing live-run polling still works or has a clearly separated path.

Browser-like UI verification guidance for agents:

- Keep TDD/unit/helper tests as the primary acceptance gate. Use browser-like checks only to verify visible UI behavior that unit tests cannot fully cover.
- Prefer a project-provided browser harness if one is added and documented in `package.json` or project docs. If no project harness exists, use the shared Playwright MCP server through `mcporter`.
- Before using Playwright, verify the shared server instead of launching a parallel runtime: `command -v mcporter`, `mcporter config list`, and `mcporter list playwright --schema`. In this repo, the configured server is named `playwright` and runs Chrome via `npx -y @playwright/mcp@latest --extension --browser=chrome`.
- Use snapshots and console/network checks for evidence, not screenshots alone: navigate to the local viewer, select a historical run fixture, assert provenance copy, assert no stale preview graph/current-source-only labels appear, and assert no inline historical “Save to workflow” controls appear.
- Do not require browser automation for server-only beads (`bdz`, `f52`). It is expected for UI beads (`71e`, `nuu`) after the relevant tests pass or when debugging UI behavior.

## Suggested bead breakdown

1. Inventory installed Smithers frame/read APIs and DB gaps.
2. Extend `SmithersRunReader` frame types with `xmlJson`, parsed `xml`, and parsed `taskIndex`.
3. Implement high-fidelity latest-frame mapping using Smithers frame inflation.
4. Add/adjust API tests for high-fidelity frame inspection and graph provenance.
5. Add server-side historical graph projection from persisted frames.
6. Update browser historical run loading to consume `detail.view.graph`.
7. Disable historical source-editing controls and show missing provenance honestly.

## Non-goals for first implementation

- Frame picker/time-travel UI.
- Writing to Smithers SQLite.
- Replacing Smithers runtime or workflow source conventions.
- Deleting legacy `runs/` compatibility paths.
- Making `Task.meta.editor` a Smithers core concept.
- Building a CustomHarness frame codec if Smithers adapter APIs can inflate frames.

## Risks and mitigations

- **Risk:** Smithers frame `taskIndexJson` lacks full task descriptor details.
  - **Mitigation:** Render unknown/not captured rather than falling back to current source.

- **Risk:** Broad API responses become large.
  - **Mitigation:** Keep bundle endpoint convenient but support include flags and existing event subresource polling.

- **Risk:** Raw SQL duplicates Smithers adapter behavior.
  - **Mitigation:** inventory adapter reads first; centralize and justify any SQL fallback.

- **Risk:** UI conflates preview, live inspection, and historical inspection.
  - **Mitigation:** explicit graph source provenance and read-only historical mode.

## Open questions for later grilling

1. Which broad Smithers tables/read surfaces are essential for v1 besides runs/nodes/attempts/events/frames/outputs?
2. After v1, should `detail.view` stay default on the bundle endpoint or move behind `include=view` for large-run performance?
3. How should very large outputs/events be paginated or lazily loaded?
4. How should the UI distinguish live Run Inspection from completed historical Run Inspection?
5. How much raw DB row shape should be exposed versus mechanically camelCased normalized shape?
