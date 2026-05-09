# Live Smithers Run Inspection — Current State

## Purpose

Document what the Project Workflow Viewer does today when starting and inspecting a currently running Smithers project workflow. This is descriptive, not an implementation plan.

Use this alongside:

- `CONTEXT.md`
- `docs/smithers-integration-context.md`
- `docs/adr/0004-project-mode-run-inspection-reads-smithers-sqlite.md`
- `docs/adr/0005-historical-run-inspection-provenance.md`
- `docs/plans/smithers-inspection-api-expansion.md`

## Terms

- **Workflow Source**: current `.smithers/workflows/*.tsx` and related Smithers workflow-pack files.
- **Workflow Graph**: CustomHarness visual projection, not source of truth.
- **Run**: one Smithers execution.
- **Smithers Run State**: Smithers SQLite-backed state for runs, nodes, attempts, events, frames, and outputs.
- **Run Frame**: persisted Smithers snapshot of rendered workflow structure at a point in execution.
- **Run Inspection**: read-only DB-backed inspection of a Smithers Run.

## Current live-run flow

### 1. Project preview graph loads from current Workflow Source

On project load, the browser calls:

```txt
GET /api/workflows/:workflowId/graph
```

Server path:

- `src/server.ts` → `workflowGraphResponse()`
- Renders current Workflow Source through `renderProjectWorkflowGraph()`.
- Converts Smithers `GraphSnapshot` to CustomHarness `RenderGraph` with `smithersSnapshotToRenderGraph()`.

Browser state:

- `currentWorkflowGraph = graphResponse.graph`
- `SAMPLES._project = currentWorkflowGraph` through `renderProjectGraphForCurrentState()`.

Important consequence:

The graph source at this point is **current Workflow Source**, not Smithers run state.

### 2. User starts a full Smithers run

The browser `Start Full Run` action calls `runWorkflowFresh()` in `web/index.html`.

It posts:

```txt
POST /api/workflows/:workflowId/run
```

Payload is built by `src/ui/workflowRunUi.ts`:

```ts
buildProjectWorkflowRunPayload(input) => { input: { ...input } }
```

Server path:

- `src/server.ts` → `workflowRunResponse()`
- Rejects project-mode prompt overrides.
- Resolves selected workflow file from `.smithers/workflows/:workflowId.tsx`.
- Calls `runProjectWorkflow()`.

`runProjectWorkflow()` launches Smithers CLI detached:

```txt
smithers workflow run <workflowId> --input <json> --detach --format json --root .
```

via `buildSmithersWorkflowRunCommand()` in `src/smithersProject/cli.ts`.

Server returns:

```ts
{
  ok: true,
  runId,
  status,
  inspection: { url: `/api/smithers/runs/${runId}` }
}
```

Important consequence:

The run is created by Smithers. CustomHarness does not write legacy `runs/` artifacts or manually insert Smithers DB rows for project-mode runs.

### 3. Browser enters live inspection polling

After launch, `runWorkflowFresh()` sets:

- `currentRunId = result.runId`
- `currentRunMeta.liveSmithers = true`
- `currentRunMeta.inspectionUrl = result.inspection.url`
- `projectRunInspection = { runId, inspectionUrl, lastEventSeq, status }`

Then it calls:

```js
startProjectRunInspection({ runId, inspectionUrl, initialStatus });
```

Polling happens in `pollProjectRunInspectionOnce()`.

Each poll builds a URL with `src/ui/workflowRunUi.ts`:

```txt
/api/smithers/runs/:runId?eventsAfterSeq=:lastEventSeq&includeOutputs=true
```

The browser retries a bounded number of initial `404`s because a detached Smithers run may not have written its first SQLite rows yet.

Important consequence:

Live run status, attempts, events, frames, and outputs are read from Smithers SQLite through the Smithers Inspection API.

### 4. Poll responses are merged into browser state

On each successful poll:

- The response body is `detail` from `/api/smithers/runs/:runId`.
- New event pages are merged with previous event pages by event `seq`.
- `projectRunInspection.lastEventSeq` advances from `detail.cursors.nextEventSeq`.
- `currentRunMeta.smithersRunDetail = detail`.
- `currentRunMeta.liveSmithers = true`.

Polling stops when `isTerminalSmithersRunStatus(status)` returns true for:

- `finished`
- `failed`
- `cancelled`
- `canceled`

Important consequence:

The live inspector's run state is DB-backed and cursor-based, but graph structure still comes from the preview graph path below.

### 5. Live graph rendering overlays DB state onto the current preview graph

If `currentWorkflowGraph` exists and the selected run is current, polling calls:

```js
renderProjectGraphForCurrentState({
  previewGraph: currentWorkflowGraph,
  liveMode: true,
  liveDetail: detail,
});
```

`src/ui/projectLiveState.ts` calls:

```ts
buildSmithersRunOverlayState({ graph: previewGraph, detail });
```

`src/ui/smithersRunOverlay.ts` overlays:

- DB node state/status
- selected iteration
- raw Smithers status/state metadata

onto matching graph nodes by:

- `graphNode.smithers.nodeId`
- or graph node `id`

Important consequence:

The visual graph's status is DB-backed, but the graph structure, node labels, prompts, model/source-facing metadata, and editor metadata are still from `currentWorkflowGraph`, which was rendered from current Workflow Source.

### 6. Live inspector sections are DB-backed

When a task node is selected, `renderLiveSmithersInspectorSections()` in `web/index.html` reads from `currentRunMeta.smithersRunDetail` and shows:

- run status
- latest DB node state
- attempts
- output rows
- DB events in the current polling window
- frame metadata summaries

It also disables preview-only pretend output controls during live inspection.

Important consequence:

Inspector detail is more DB-backed than the graph itself. Frames are shown only as metadata summaries today, not used as the graph source.

## Current live-run provenance model

Today live runs effectively use two sources:

| UI element              | Source today                                             |
| ----------------------- | -------------------------------------------------------- |
| Graph structure         | current Workflow Source preview (`currentWorkflowGraph`) |
| Graph node status       | Smithers SQLite nodes overlay                            |
| Inspector run state     | Smithers SQLite run row                                  |
| Inspector attempts      | Smithers SQLite attempts                                 |
| Inspector events        | Smithers SQLite events                                   |
| Inspector outputs       | Smithers output tables via reader                        |
| Frame summary           | Smithers `_smithers_frames` metadata                     |
| Graph source provenance | not fully frame-backed                                   |

## Why this matters

This is usually acceptable immediately after launch because the preview graph was rendered from the same Workflow Source that the user just launched.

However, provenance can drift when:

- Workflow Source changes while a run is still active.
- Smithers runtime renders frames that differ from the preview graph.
- The run continues, forks, loops, waits, or otherwise changes frame structure.
- The browser reloads and reconstructs state from current source plus DB status.

In those cases, the live graph may present current Workflow Source structure as if it were the running Run's actual frame structure.

## Relationship to historical run inspection

Historical Run Inspection has the stronger immediate requirement: it should reconstruct the Workflow Graph from the selected Run's persisted Smithers Run Frame, not current Workflow Source.

Live Run Inspection likely wants a similar endpoint eventually:

- Before the first Smithers frame exists: show preview graph as clearly labeled launch preview.
- After a persisted frame exists: prefer latest Run Frame as the live graph source.
- Continue overlaying node/attempt/output/event state from the same Run.

That live-frame transition is not yet designed or implemented.

## Existing tests that describe this behavior

Relevant tests include:

- `tests/workflowViewer.run.test.ts`
  - project workflow run API launches through Smithers CLI and returns inspection URL.
  - project-mode prompt overrides are rejected.

- `tests/workflowViewer.ui.test.ts`
  - live polling uses DB-backed Smithers inspection endpoint.
  - initial 404s are retried.
  - terminal statuses stop polling.
  - `waitForRunToRender` is not used for project Start Full Run.
  - live render state overlays DB state onto preview graph.
  - overlay failures do not claim live Smithers provenance.
  - inspector state uses DB attempts, outputs, events, and frame summaries.

- `tests/workflowViewer.run.integration.test.ts`
  - launches and inspects a real Smithers run from SQLite without trusting legacy run artifacts.

## Open questions

1. Should live Run Inspection switch from preview graph to latest persisted Run Frame as soon as one frame exists?
2. If no frame exists yet, what provenance label should the UI show for the launch preview graph?
3. Should live and historical graph projection share the same server-side `view.graph` code path?
4. How should the UI handle graph structure changes across frames during a live run?
5. Should event polling request `view.graph` every time, only when frame number changes, or through a separate frame/graph endpoint?
6. Should live source-editing controls be disabled once a run is active, or shown only as future-run edits?

## Current recommendation

Do not merge the live-run redesign into the immediate historical-run v1 fix.

First fix historical Run Inspection so selected completed runs use persisted Run Frames as graph source. Then revisit live inspection with this current-state doc as input. The likely live follow-up is: preview graph before first frame, latest frame-backed graph after Smithers persists a frame, with explicit provenance throughout.

Live-run redesign should be treated as blocked on the historical frame-backed graph projection primitives. Once the historical path has a tested server-side frame-to-`RenderGraph` projection, live inspection can decide whether and when to reuse that projection during polling.
