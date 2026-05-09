# Grill-with-docs session notes — 2026-05-08

## Context

We used the `grill-with-docs` skill to clarify the domain language for the CustomHarness/Smithers workflow workbench after a long implementation session. The repo has become more Smithers-focused and is evolving from a legacy CustomHarness run viewer toward a UI/workbench for Smithers-backed agentic workflows.

## Decisions resolved

### Keep Smithers-aligned terminology

We explored fun names/metaphors including Mass Driver, Mech Yard, Foundry, Armory, Arsenal, Gantry, Proving Ground, Skunkworks-like naming, and fabrication-related names. The user liked the vibe of Mass Driver/Mech Yard but agreed that metaphor-heavy language becomes a translation tax in developer tools.

Decision: keep canonical docs/UI language close to Smithers terms. Do not replace workflow/run/task/source/output with mech/sortie/loadout/etc. Metaphor can remain branding later, but not domain language.

### CustomHarness is prototype/repo, not product name

`CustomHarness` remains the repository/prototype implementation name. The long-term product/library name is unresolved.

### Smithers is runtime/source/state substrate

Smithers should be documented as the source-defined agent workflow runtime that renders workflow graphs, executes agent tasks, and persists canonical state to SQLite. This app should not be described as replacing Smithers or as a separate runtime.

### Editor metadata replaces Studio metadata

We clarified that Smithers owns generic `Task.meta`, but `Task.meta.studio.fields` was our prototype convention. Since we are not calling this product Studio, we chose **Editor Metadata** under `Task.meta.editor`.

- `Task Model` and `Task Prompt` are real workflow data in Workflow Source.
- `Task.meta.editor.fields` maps rendered tasks back to safe source editing controls.
- `Task.meta.studio` was rejected as legacy prototype naming; no compatibility promise is needed for current test fixtures.

Implemented during session:

- `.smithers/workflows/plan-fanout.tsx` emits `meta.editor`.
- `src/ui/studioInspector.ts/js` reads `meta.editor` only.
- Tests/fixtures were migrated from `meta.studio` to `meta.editor`.

### Historical run provenance / frames

We initially created ADR 0005 saying historical run inspection must distinguish run-time provenance from current Workflow Source. Later the user pushed back: Smithers persists run frames in SQLite, so why not use them?

After checking actual SQLite/schema:

```sql
_smithers_frames(run_id, frame_no, created_at_ms, xml_json, xml_hash, encoding, mounted_task_ids_json, task_index_json, note)
```

For a completed `plan-fanout` run, `_smithers_frames` includes XML JSON and task index data. Therefore historical graph projection should eventually use persisted Smithers frame data instead of overlaying onto the current workflow preview graph.

Revised target architecture:

- Current workflow preview: render current Workflow Source.
- Historical run viewing: reconstruct graph from selected run's persisted Smithers frame (`_smithers_frames`) and then overlay DB-backed status/output/events from the same run.
- Current source should only be used for editing/future-run preview, not as the graph source for completed historical runs.

This needs more design in the next session.

## Docs changed in this session

### `CONTEXT.md`

Replaced the previous code-investigation memo with a real domain context. Important terms now include:

- CustomHarness
- Smithers
- Agentic Workflow
- Workflow Source
- Workflow Graph
- Run
- Run Inspection
- Run Output
- Task Model
- Task Prompt
- Editor Metadata
- Legacy Run Artifacts
- Project Workflow Viewer

Also includes relationships, example dialogue, and flagged ambiguities.

### Old `CONTEXT.md`

Moved to:

`docs/feedback/code-context-smithers-implementation-investigation.md`

### ADRs created

- `docs/adr/0005-historical-run-inspection-provenance.md`
- `docs/adr/0006-editor-metadata-for-source-editing.md`

ADR 0005 may need follow-up edits after the next session, because we revised our understanding: persisted frames likely make historical run projection feasible and desirable.

## Implementation changes after commit `bd85360`

There are uncommitted changes at the end of this session:

- `CONTEXT.md`
- `docs/adr/0005-historical-run-inspection-provenance.md`
- `docs/adr/0006-editor-metadata-for-source-editing.md`
- `docs/feedback/code-context-smithers-implementation-investigation.md`
- `src/ui/studioInspector.ts`
- `src/ui/studioInspector.js`
- `tests/smithersGraph.test.ts`
- `tests/workflowViewer.graph.test.ts`
- `tests/workflowViewer.ui.test.ts`

Untracked local/prototype artifacts remain and should generally be ignored unless user says otherwise:

- `.poolside/tasks/**`
- `runs/**`

## Validation run after metadata migration

The following passed:

```bash
bun test tests/workflowViewer.ui.test.ts tests/smithersGraph.test.ts tests/workflowViewer.graph.test.ts
bun tsc --noEmit
```

Full suite passed earlier after UI/run-history/output-view work:

```bash
bun test tests/
bun tsc --noEmit
```

## Suggested next grilling topic

Continue with historical run graph projection:

Question to ask next:

> Should historical run viewing use the selected run's persisted Smithers frame as the graph source, rather than current Workflow Source?

Recommended answer:

> Yes. Historical run viewing should reconstruct the Workflow Graph from `_smithers_frames` for the selected run, then overlay node/attempt/output/event state from that same run. Current Workflow Source should be reserved for preview/editing/future runs.

Open design questions:

1. Which frame is authoritative for a run view? Latest frame? Last frame with full `xml_json`? User-selectable frames?
2. Do we need frame navigation/time-travel in the UI now, or only latest historical frame?
3. Should `SmithersRunReader` expose a full historical `GraphSnapshot`, or should a separate adapter method produce `RenderGraph` server-side?
4. Should ADR 0005 be updated to state this stronger decision?
5. How does this affect output viewer, model labels, prompt labels, and source edit controls while inspecting a historical run?

## Restart prompt

Use the prompt below to resume.
