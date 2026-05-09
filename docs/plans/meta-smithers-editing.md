# Meta Smithers editing plan

## Goal

Turn the CustomHarness Smithers viewer into a small, understandable workflow editing loop where rendered Smithers nodes expose safe, intentional edit controls through Smithers `meta` metadata.

The user should be able to:

1. Open a Smithers workflow.
2. Understand what is source, input, preview, output, and run state.
3. Click a node and see what parts of that node are editable.
4. Edit prompts/models/labels for future runs without mutating an existing run.
5. Save edits into workflow source, preferably as a new workflow copy when experimenting.
6. Re-render and run the edited workflow through Smithers.

This is not a visual workflow runtime. It is a Smithers-native workflow authoring surface.

## Smithers evidence this plan relies on

This plan must stay anchored to Smithers primitives. If implementation needs behavior not covered here, read the Smithers docs/source first and either use the native primitive or mark the gap as an upstream Smithers capability request.

Local evidence checked for this plan:

- `/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt:567-606`: Smithers is a render → extract → execute → persist → re-render loop. The UI should reflect that loop instead of inventing a separate runtime model.
- `/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt:895-927`: workflow packs live under `.smithers/` with `workflows`, `prompts`, `components`, agents, config, and execution artifacts.
- `/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt:6740-6787`, `:6927-6934`, `:7071-7096`: `workflow run`, `graph`, `workflow list`, `workflow path`, and `workflow create` are the native CLI surfaces this app should mirror or call.
- `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/graph/src/types.ts`: `GraphSnapshot` is `{ runId, frameNo, xml, tasks }`; `TaskDescriptor` carries `nodeId`, dependencies, agent, prompt, output schema/table, label, and `meta?: Record<string, unknown>`.
- `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/graph/src/extract.js`: task `raw.meta` is preserved into `TaskDescriptor.meta`; this is the Smithers primitive that makes `meta.studio` viable.
- `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/cli/src/workflows.js`: workflow discovery is flat `.smithers/workflows/*.tsx`; workflow ids use lowercase kebab-case; source/display comments are already parsed by Smithers discovery.
- `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/engine/src/engine.js`: `runWorkflow` persists input and run identity into Smithers state. The app should start runs through Smithers, not fabricate run rows or mutate completed run internals.
- `docs/adr/0001-runs-in-smithers-canonical-location.md`: canonical run state is Smithers DB/log state, not CustomHarness `runs/` JSON.
- `docs/adr/0003-reflect-smithers-first-smooth-with-overlays.md`: Poolside/CustomHarness overlays may smooth labels, layout, drafts, and warnings, but Smithers owns workflow structure, runtime behavior, run state, forks, prompts, agents, schemas, and reusable components.

### Smithers primitive mapping

| Product concept in this plan | Smithers primitive to use | What the app may add |
| --- | --- | --- |
| Workflow identity/listing | `.smithers/workflows/*.tsx`, `workflow list`, `workflow path`, Smithers workflow id validation | Selected workflow state in the viewer |
| Workflow source editing | Ordinary `.smithers/workflows/*.tsx`, `.smithers/prompts/*`, `.smithers/components/*` | Metadata-backed form controls that patch source files |
| Graph preview | `renderFrame` / `graph` producing `GraphSnapshot` | Visual layout/card rendering of that snapshot |
| Node identity | `TaskDescriptor.nodeId` and Smithers task ids | Display selection state and inspector panels |
| Prompt preview | Rendered task prompt from `TaskDescriptor.prompt` | Labels explaining that it is rendered, not the source template |
| Editability | `TaskDescriptor.meta` populated from Smithers `Task` `meta` prop | A `meta.studio` convention for form shape and source destinations |
| Preview input | `ctx.input` used during render and run | Local textarea and debounced preview render |
| Downstream preview with fake outputs | `SmithersCtx` output snapshot supplied to render-only previews | Local-only pretend output editor clearly labelled preview-only |
| Full execution | `workflow run` / `runWorkflow` using saved workflow source and input | Start button and result copy with Smithers run id |
| Historical run state | Smithers DB/logs, `ps`, `inspect`, `chat`, `logs`, `fork`, `replay` | Read-only presentation or links/commands; no custom mutation |
| Workflow copy | A new discoverable `.smithers/workflows/<id>.tsx` file using Smithers id rules | Save-as-copy UX and viewer switch |

### Anti-drift rules

- Do not create a CustomHarness workflow IR. The graph shown in the UI is a rendering of Smithers `GraphSnapshot` plus layout data.
- Do not store prompt/model/label edits in a CustomHarness run or browser-only override if the user expects future Smithers runs to use them. Save them into Smithers workflow-pack source.
- Do not patch Smithers DB rows or output tables to make an old run look edited. Use Smithers-native fork/replay APIs later if run editing becomes a product requirement.
- Do not infer source edit locations from arbitrary JSX. If `meta.studio` does not declare a safe source target, show read-only preview plus **Edit source (.tsx)**.
- Do not make CustomHarness overlays required for Smithers to discover, render, or run a workflow.
- Do not call bare `smithers`; Smithers docs say to use `bunx smithers-orchestrator` from the project root for CLI workflows.

## Product principles

### 1. Source is canonical

Workflow edits must become ordinary Smithers workflow-pack files, usually under:

```txt
.smithers/workflows/<workflow-id>.tsx
.smithers/prompts/*
.smithers/components/*
```

The UI may provide friendlier controls, but those controls are just an editor for Smithers source.

### 2. Existing runs are not silently rewritten

The editor must not patch completed or running Smithers DB rows to pretend a historical run was different.

If a user edits a node after inspecting a run, the expected behavior is:

```txt
inspect run → edit workflow source/copy → start a new run
```

Later, if Smithers exposes first-class fork/replay/edit-output semantics, the UI can call those Smithers-native APIs. Until then, no custom run mutation.

### 3. Preview overlays are explicitly temporary

Preview input and pretend node outputs are design-time aids. They help the user see what downstream prompts would look like. They are not run state.

The UI must label them as preview-only.

### 4. Metadata describes editability

Rendered Smithers nodes may include `meta.studio` that tells the viewer what fields can be edited and where those edits should be saved.

The UI should not guess source locations from arbitrary TypeScript when metadata is available.

### 5. Safe experimentation should be cheap

Users should feel free to try edits. The default for meaningful workflow edits should be either:

- save to current workflow source when the user explicitly chooses that, or
- save as a workflow copy/fork for experimentation.

The UI should make the destination obvious before writing.

---

## User mental model to support

The UI should teach this model through labels and behavior:

```txt
Workflow source defines the graph.
Preview input renders task prompts.
Node outputs feed downstream nodes.
Runs execute the workflow and create Smithers run state.
Edits change future runs, not past runs.
```

### Definitions shown in the UI

- **Workflow source**: the `.tsx` / prompt files that define nodes, agents, models, dependencies, and prompt templates.
- **Preview input**: sample input used to render prompts before running.
- **Rendered prompt**: what Smithers computes for a task from source + preview input + available outputs.
- **Pretend output**: a temporary value used to preview downstream nodes.
- **Run**: a canonical Smithers execution with its own run id and Smithers state.

---

## Desired user experience

### Opening a workflow

Given the user starts:

```bash
bun --watch src/server.ts --project <project> --workflow <workflow-id>
```

The page should show:

- Workflow name/id.
- Source path.
- Project root.
- A clear **Preview input** field.
- A graph preview.
- Buttons:
  - **Start full run**
  - **Edit source**
  - eventually **Save as workflow copy**

The page should not foreground legacy `runs/` controls in project mode.

#### Acceptance behavior

- The user can tell which workflow is open without looking at the terminal.
- The top input does not look like the workflow title.
- Legacy actions such as **Rerun Selected** are hidden or disabled in project workflow mode.
- Empty/missing Smithers setup shows setup guidance, not a demo graph.

### Editing preview input

When the user types into the preview input field:

- The graph re-renders.
- Task prompts that use `ctx.input` update.
- The UI indicates this is preview-only until a run is started.

#### Acceptance behavior

- If a task prompt contains `USER REQUEST: ${ctx.input.prompt}`, changing preview input changes the rendered prompt text.
- The workflow source file is not modified by changing preview input.
- The UI makes it clear that this input will be used when **Start full run** is clicked.

### Inspecting a node

When the user clicks a task node, the inspector should show:

1. Node identity:
   - task id
   - label/title
   - agent kind
   - model, if known
   - output table/schema name, if known
2. Rendered prompt preview.
3. Editable fields declared by `meta.studio`.
4. Optional pretend output editor.
5. Source/edit destination.

The inspector must distinguish:

- rendered prompt preview,
- editable prompt template,
- pretend output,
- run output.

#### Acceptance behavior

- A user can explain whether they are editing source or only previewing output.
- If a node is not editable, the inspector says why or offers source editing.
- If a node is editable, the inspector shows explicit save controls.

### Editing a task prompt

When a task declares an editable prompt through metadata, the inspector should show a prompt-template editor.

Example user flow:

1. Click `variant-claude`.
2. Edit the prompt to be more Claude-specific.
3. Click **Save to workflow** or **Save as copy**.
4. The graph re-renders.
5. The node now shows the edited rendered prompt.
6. **Start full run** runs the edited workflow.

#### Acceptance behavior

- Editing the prompt updates the workflow source/config slot indicated by metadata.
- The rendered graph updates after save.
- The user sees whether the edit was saved to current workflow or a copied workflow.
- The edit survives browser refresh because it is source-backed.
- The edit does not mutate any existing run.

### Editing a node model

When a task declares editable agent/model metadata, the inspector should show model controls.

Example user flow:

1. Click `variant-claude`.
2. Change model from `claude-sonnet-4-6` to `claude-opus-4-6`.
3. Save.
4. Re-render.
5. Start a new run.

#### Acceptance behavior

- The UI shows the current model.
- The UI either offers known model options or accepts text with validation.
- Saving changes the workflow source/config slot indicated by metadata.
- The change is visible after refresh.
- Future runs use the new model.

### Editing labels and display names

The user should be able to rename how a node appears without changing its task identity unless they explicitly edit the id.

Preferred first version:

- editable label/title: yes
- editable task id: no, or advanced-only

#### Acceptance behavior

- Changing a label updates the graph title/card title.
- Dependencies do not break because task ids stay stable.
- The UI explains that task id is the stable identity used by Smithers.

### Editing structure: sequence vs parallel

This is more complex and should come after prompt/model editing.

User story:

> I want to run these three reviewer nodes in parallel instead of serial.

First version should be constrained to metadata-backed structures, not arbitrary JSX rewriting.

Possible UX:

- A group/section inspector shows **Execution mode: sequence / parallel**.
- User changes mode.
- Save as workflow copy by default.
- Graph re-renders with changed layout.

#### Acceptance behavior

- Structure edits are only available when metadata identifies a safe editable group.
- The UI defaults to save-as-copy for structure edits.
- The graph re-renders and preserves node ids where possible.
- If dependencies would become invalid, the UI refuses the edit with a clear message.

### Pretend node output for downstream preview

The user may want to see downstream prompts as if an earlier node already produced an output.

Example:

1. Click `concept`.
2. Enter pretend JSON output:

```json
{
  "title": "Lua hello world",
  "objective": "Create a one-line Lua script that prints hello world.",
  "constraints": ["Keep it one line"],
  "openQuestions": []
}
```

3. Apply to preview.
4. Downstream nodes re-render with that concept included.

#### Acceptance behavior

- The pretend output editor is clearly labeled preview-only.
- Applying pretend output does not modify workflow source.
- Applying pretend output does not modify Smithers DB/run state.
- Downstream prompts update if the workflow reads that node output.
- Clearing the pretend output returns to the previous render.

### Starting a full run

When the user starts a run from project mode:

- The UI sends current preview input.
- If there are unsaved source edits, the UI blocks or asks to save/discard.
- If there are temporary overrides/pretend outputs, the UI clearly states whether they are included or ignored.

Preferred first version:

- source edits must be saved before run,
- preview input is included,
- pretend outputs are ignored for actual run,
- prompt/model source edits are included because they are saved.

#### Acceptance behavior

- The user sees the run id after launch.
- The UI says this is a full Smithers run from the current workflow source.
- The UI does not imply the preview graph is live run state.
- Canonical Smithers commands are shown for inspection:

```bash
bunx smithers-orchestrator ps
bunx smithers-orchestrator inspect <run-id>
bunx smithers-orchestrator chat <run-id> --follow
bunx smithers-orchestrator logs <run-id>
```

### Save as workflow copy

Users should be able to experiment without destroying the previous generated workflow.

Suggested UX:

1. User edits prompt/model/structure.
2. Click **Save as copy**.
3. UI asks for a workflow id, defaulting to `<old-id>-v2` or `<old-id>-experiment`.
4. New file is written under `.smithers/workflows/<new-id>.tsx`.
5. Viewer switches to the new workflow.
6. Graph re-renders.

#### Acceptance behavior

- Original workflow file remains unchanged.
- New workflow is discoverable through Smithers workflow list/discovery.
- Viewer switches to the new workflow id.
- Browser refresh opens the selected/new workflow if the server was started with that workflow id, or shows a clear mismatch if not.

---

## Metadata contract proposal

This section is intentionally product-facing. Exact TypeScript shapes can change, but the underlying carrier should remain Smithers `Task` `meta`, which Smithers preserves into `TaskDescriptor.meta` during graph extraction.

A Smithers task may declare Studio editing metadata:

```tsx
<Task
  id="variant-claude"
  label="Variant Claude"
  agent={agents.claude}
  output={outputs.variant}
  meta={{
    studio: {
      editable: true,
      fields: {
        prompt: {
          label: "Prompt template",
          kind: "multiline-text",
          sourcePath: ["tasks", "variant-claude", "prompt"]
        },
        model: {
          label: "Model",
          kind: "model-select",
          sourcePath: ["agents", "claude", "model"]
        },
        label: {
          label: "Display label",
          kind: "text",
          sourcePath: ["tasks", "variant-claude", "label"]
        }
      }
    }
  }}
>
  {editable.tasks["variant-claude"].prompt}
</Task>
```

The UI should use metadata to answer:

- Is this node editable?
- Which fields are editable?
- What form control should be shown?
- Where should the edit be saved?
- Is the edit safe to save in-place, or should it default to save-as-copy?

### Metadata display behavior

If metadata is present:

- Show structured edit controls.
- Populate each control from the source/config slot identified by metadata, not from the rendered prompt when those differ.
- Save edits to the declared source path after revalidating that the node and field are still editable.

If metadata is absent:

- Show rendered prompt read-only.
- Offer **Edit source (.tsx)**.
- Do not guess how to patch arbitrary code.

### First-milestone save seam

Use one metadata-backed save path for structured controls. This is an app/API seam for editing ordinary Smithers source files; it is not a new Smithers runtime primitive and must not create a parallel workflow representation. Route names can change, but the implementation should have this shape:

```http
PATCH /api/workflows/:workflowId/source-fields
```

Request shape:

```json
{
  "mode": "current",
  "edits": [
    { "nodeId": "variant-claude", "field": "prompt", "value": "New prompt template" }
  ]
}
```

Copy request shape:

```json
{
  "mode": "copy",
  "newWorkflowId": "foo-v2",
  "edits": [
    { "nodeId": "variant-claude", "field": "model", "value": "claude-opus-4-6" }
  ]
}
```

Response shape:

```json
{
  "ok": true,
  "workflowId": "foo-v2",
  "workflowPath": "/project/.smithers/workflows/foo-v2.tsx",
  "copiedFrom": "foo",
  "graph": { "nodes": [] }
}
```

Server rules:

- The server re-renders or reloads the workflow metadata before applying an edit. Client-provided field names are inputs, not authority.
- The server uses Smithers workflow discovery rules for workflow ids and paths, matching `.smithers/workflows/*.tsx` and lowercase kebab-case ids.
- The server rejects edits when the node is gone, the field is not declared in `meta.studio.fields`, the `sourcePath` is missing, or the source slot is not a supported scalar/string slot.
- The first version patches generated workflow config slots, not arbitrary JSX. If generated workflows need editing, they should expose stable config objects such as `editable.tasks[taskId].prompt`, `editable.tasks[taskId].label`, and `editable.agents[agentId].model`.
- Saving returns a freshly rendered graph so the client does not need to infer whether the edit worked.
- Whole-source editing through `/api/workflows/:id/source` can remain as the escape hatch, but structured controls should not use whole-file replacement.

### Verification conventions for implementing agents

Use the existing Bun test style in `tests/workflowViewer.*.test.ts` and `tests/smithersGraph.test.ts`. When behavior depends on Smithers semantics, prefer tests that use real Smithers `createSmithers`, `Task`, `Workflow`, `renderFrame`, or the Smithers CLI rather than hand-rolled objects.

Fixture rules:

- Build temp projects under `mkdtempSync(join(tmpdir(), ...))`.
- Create `.smithers/workflows/<id>.tsx` explicitly.
- For real Smithers render/run fixtures, symlink `node_modules` into `.smithers/node_modules` and write `.smithers/package.json` with `{ "type": "module" }`, matching the current integration tests.
- Use render-only agents that throw if executed when testing graph rendering.
- Snapshot source bytes before any preview-only operation and compare bytes after the operation.
- Assert the absence of legacy side effects: no project-root `runs/` and no `.poolside` unless the behavior explicitly creates Smithers execution logs.

Recommended verification commands:

```bash
bun test tests/smithersGraph.test.ts tests/workflowViewer.graph.test.ts
bun test tests/workflowViewer.source.test.ts tests/workflowViewer.run.test.ts
bun test tests/workflowViewer.graph.integration.test.ts tests/workflowViewer.run.integration.test.ts
bun test tests/
bun tsc --noEmit
```

For UI behavior, prefer extracting small pure helpers from `web/index.html` rather than adding a large browser test harness. Test the helper output for labels, disabled states, pending-edit state, and payload construction; keep one manual browser smoke test for layout and click wiring.

### State taxonomy for implementation

Keep these states separate in code and tests. Most bugs in this feature will come from accidentally mixing them.

- **Saved workflow source**: bytes on disk under `.smithers/workflows/*.tsx` and related prompt/component files. This is the only thing prompt/model/label saves should mutate.
- **Rendered graph**: Smithers render output for current source + preview input + pretend outputs. It is disposable and can always be recomputed.
- **Preview input**: local user input sent to graph renders and to `Start full run`. It is not dirty source state.
- **Pretend output**: local downstream-preview data sent only to graph renders. It is not sent to `Start full run`.
- **Structured edit draft**: unsaved prompt/model/label field values. These block `Start full run` until saved or discarded.
- **Whole-source draft**: unsaved contents of the fallback `.tsx` editor. This also blocks `Start full run` until saved or discarded.
- **Smithers run state**: run id, logs, DB rows, and execution output created by Smithers. Source editing must not mutate this.

Implementation implication:

```txt
preview input change  -> graph render only
pretend output change -> graph render only
structured save       -> source write -> graph render
whole-source save     -> source write -> graph render
start full run        -> Smithers run from saved source + preview input
```

### Route responsibility map

Keep endpoint responsibilities narrow:

- `GET /api/workflows`: discover workflow files only.
- `GET /api/workflows/:id/graph`: render saved source with optional preview input and pretend outputs; no writes and no runs.
- `GET /api/workflows/:id/source`: return whole source for fallback editing.
- `PUT /api/workflows/:id/source`: replace whole source from the fallback editor, then the client re-renders.
- `PATCH /api/workflows/:id/source-fields`: apply metadata-backed structured edits to source/config slots; return a re-rendered graph.
- `POST /api/workflows/:id/run`: start a Smithers run from saved source and preview input; ignore pretend outputs and reject/avoid unsaved source edits on the client.

A failing test should usually make it obvious which route broke. If a route both writes source and starts a run, the implementation has crossed a boundary.

### Per-slice done checklist

Before marking any slice done, the implementing agent should answer these in the PR/summary:

- What source bytes can this behavior write, if any?
- Which state bucket does the user input belong to: preview input, pretend output, structured edit draft, whole-source draft, or run state?
- Which test proves historical Smithers runs were not mutated?
- Which test proves failed validation leaves source unchanged?
- Which command was run, and did it pass?

### Guardrail tests to add as slices land

These are not first-pass blockers because the repo still has legacy CustomHarness run paths. Add them as focused tests when the project-mode implementation reaches the matching slice. The goal is to catch agents drifting into a custom workflow/runtime layer instead of using Smithers source, graph, and run primitives.

ADR 0004 adds the run-state rule for project mode: read Smithers SQLite through a read-only Smithers run-state adapter. Do not bridge project-mode inspection through CustomHarness `runs/` JSON artifacts.

#### 1. Project graph preview has no CustomHarness run side effects

When `GET /api/workflows/:id/graph` renders a project workflow:

- It must not create project-root `runs/`.
- It must not create `.poolside`.
- It must not create `.smithers/executions` because graph preview should not start a Smithers run.
- It may import workflow code and touch Smithers-owned DB/cache files if Smithers does that during render.

Suggested test location: `tests/workflowViewer.graph.test.ts` and real-render coverage in `tests/workflowViewer.graph.integration.test.ts`.

#### 2. Project run payload stays Smithers-native

When `POST /api/workflows/:id/run` starts a project workflow:

- The request sent to the runner contains workflow id/path and preview `input`.
- It does not contain `promptOverrides`, pretend `outputs`, structured edit drafts, or whole-source draft contents.
- Prompt/model changes affect the run only after they are saved into workflow-pack source.

Suggested test location: `tests/workflowViewer.run.test.ts` plus UI helper tests for payload construction.

#### 3. Structured source edits write source, not run state

When the metadata-backed source-field save endpoint is implemented:

- Prompt/model/label saves modify only declared `.smithers/` source/config slots.
- Failed saves leave source byte-for-byte unchanged.
- Saves do not create CustomHarness `runs/` artifacts.
- Saves do not patch Smithers run rows or output tables.

Suggested test location: `tests/workflowViewer.source.test.ts`.

#### 4. No persistent CustomHarness workflow IR

The app may keep `RenderGraph` as a visual projection of `GraphSnapshot`, but it must not introduce a persistent CustomHarness workflow graph as source of truth.

Suggested check:

```bash
rg -n "workflowGraph|graphJson|plan\.json|run\.json|createRunRecorder|promptOverrides" src web tests
```

For each match, the implementing agent should classify it as:

- legacy run-browser path,
- visual projection only,
- Smithers compatibility adapter,
- or drift that needs removal.

#### 5. Smithers CLI/runtime usage stays explicit

Project-mode implementation should use Smithers CLI/runtime surfaces. Avoid bare `smithers`, manual DB row insertion, or fake run records.

Suggested check:

```bash
rg -n "node_modules/.bin/smithers|bunx smithers(?!-orchestrator)|insertRun|_smithers_runs|promptOverrides" src web tests
```

Expected rule:

- `bunx smithers-orchestrator ...` is acceptable in docs/commands.
- Direct Smithers runtime APIs are acceptable when the code is intentionally using Smithers as the runtime.
- Manual Smithers DB writes or fake run JSON are not acceptable for project-mode source editing or run launch.

#### 6. Project-mode run inspection reads Smithers SQLite

When project-mode run inspection is implemented:

- Run existence/status comes from Smithers SQLite, especially `_smithers_runs`, not `runs/index.json`.
- Node status comes from `_smithers_nodes` / `_smithers_attempts`, not preview-card state.
- Timeline/events come from `_smithers_events`; `stream.ndjson` may enrich or tail output but must not be required.
- Frames come from `_smithers_frames` / Smithers graph APIs, not CustomHarness `plan.json`.
- The adapter is read-only. It must not issue manual writes to `_smithers_*` tables.

Suggested test location: a future `tests/smithersRunReader.test.ts` plus project-mode API tests. Use Smithers runtime/CLI to create state, then inspect it through the reader.

---

## Test-driven implementation plan

Use strict red-green-refactor. One behavior at a time. Keep each slice shippable and testable through the current Bun test suite before moving on.

### Slice 1 — metadata reaches the UI graph

Behavior test:

```txt
Given a fake Smithers graph task with meta.studio.editable = true
When GET /api/workflows/foo/graph is called
Then the returned graph node includes the studio metadata needed by the inspector
```

Implementation notes:

- Smithers `TaskDescriptor` already has `meta?: Record<string, unknown>` in `@smithers-orchestrator/graph`.
- Extend `RenderNode.smithers` in `src/runs/smithersGraph.ts` with `meta?: Record<string, unknown>`.
- Copy `descriptor?.meta` into `node.smithers.meta` for task nodes.
- Do not serialize metadata from arbitrary XML props; use the descriptor because that is where non-string metadata survives.

Test additions:

- Add a mapper unit test in `tests/smithersGraph.test.ts` with `task('editable-task', { meta: { studio: { editable: true, fields: { prompt: { label: 'Prompt template', kind: 'multiline-text', sourcePath: ['tasks', 'editable-task', 'prompt'] } } } } })`.
- Add or extend `tests/workflowViewer.graph.test.ts` so the fake renderer returns a task descriptor with the same metadata and `/api/workflows/foo/graph` includes it.
- Add a control assertion for a sibling task with no metadata: `node.smithers.meta` is `undefined` or does not contain `studio`, and the node still appears.

Assertions:

- `node.smithers.meta.studio.editable` is present.
- `node.smithers.meta.studio.fields.prompt.sourcePath` survives as an array, not a stringified value.
- Existing graph nodes without metadata still render.
- Metadata preservation does not change graph layout, title, prompt, or edges.

Verification command:

```bash
bun test tests/smithersGraph.test.ts tests/workflowViewer.graph.test.ts
```

### Slice 2 — non-editable nodes are read-only

Behavior test:

```txt
Given a project workflow graph node without studio metadata
When the user selects the node
Then the inspector shows rendered prompt preview and an Edit Source fallback, but no structured save controls
```

Implementation notes:

- Replace the current project-mode rule that treats every task as editable. A task is structured-editable only when `node.smithers.meta.studio.editable === true` and it has at least one supported field.
- Non-editable project nodes may still show the pretend output editor because pretend output is preview-only; they must not show prompt/model/label save controls.
- Extract a helper from the inline UI script if needed, for example `studioFieldsForNode(node)` and `inspectorModeForNode(node, currentWorkflowId)`, so the behavior can be unit-tested without browser automation.

Test additions:

- Add a UI helper test for an unannotated task in project mode.
- Assert the generated inspector state has `structuredFields: []`, `canSaveStructuredEdits: false`, and `canEditSource: true`.
- Assert the copy contains “Rendered prompt” and “computed from workflow source + preview input”.
- Assert the copy does not contain “Temporary override”, “Prompt template”, “Save to workflow”, or “Run with edits”.

Assertions:

- Copy says rendered prompt is computed from source + preview input.
- No prompt/model save button appears.
- Source editor remains available.
- Existing run-mode prompt override behavior is either removed from project mode or clearly separated from source-backed editing.

Verification command:

```bash
bun test tests/workflowViewer.ui.test.ts
```

If no UI helper file exists yet, create the smallest one needed rather than testing the full browser page.

### Slice 3 — editable prompt field appears from metadata

Behavior test:

```txt
Given a graph node with meta.studio.fields.prompt
When the user selects the node
Then the inspector shows a Prompt template textarea populated from the metadata/source value
```

Implementation notes:

- Use `meta.studio.fields.prompt.kind === 'multiline-text'` to pick a textarea.
- The editable template and rendered prompt are different concepts. Show both when both values are available:
  - **Rendered prompt preview**: `node.prompt`, computed by Smithers for the current preview input.
  - **Prompt template**: the source-backed value from the metadata field.
- If the metadata does not include an explicit current/source value, fetch source field values from the server using the declared source paths. Do not populate the template editor from `node.prompt` when the prompt includes preview input interpolation.
- Keep labels exact: use “Prompt template”, not “Agent prompt override”.

Test additions:

- Use a fixture where source prompt template is `USER REQUEST: ${ctx.input.prompt}` and preview input is `Ship the alpha`.
- Assert rendered preview contains `Ship the alpha`.
- Assert the textarea value contains the template/source value, not only the rendered prompt.
- Assert the field exposes the destination, for example `.smithers/workflows/foo.tsx · tasks.variant-claude.prompt`.
- Assert a save button is visible and is labelled **Save to workflow** or **Save as copy**, not **Start run with override**.

Assertions:

- Textarea label is “Prompt template”.
- UI distinguishes rendered prompt preview from editable template.
- Save button is visible.
- The field destination is visible before the user writes.

Verification command:

```bash
bun test tests/workflowViewer.ui.test.ts
```

### Slice 4 — saving prompt edit updates workflow source

Behavior test:

```txt
Given a workflow with an editable config block and meta sourcePath for a task prompt
When the user changes the prompt and saves
Then the workflow file is updated and the graph re-renders with the new prompt
```

Implementation notes:

- Implement the structured save API before wiring the button.
- Patch only supported generated config slots. A recommended generated shape is:

```tsx
const editable = {
  tasks: {
    'variant-claude': {
      label: 'Variant Claude',
      prompt: 'Original prompt template'
    }
  }
} as const;
```

- For the first version, support string fields in object-literal config blocks. Reject computed expressions, missing paths, duplicate paths, or non-string destinations.
- After writing, call the existing graph renderer with current preview input and pretend outputs so the response proves the edit took effect.
- Clear the saved field from the client pending-edit map after a successful save.

Test additions:

- API test: source before/after changes only the configured prompt string.
- API test: `Task id` remains `variant-claude`; dependencies still reference the same id.
- API test: response graph node prompt includes the changed template rendered with preview input.
- Negative test: missing source path returns 400 with an error naming the node id, field, and missing path.
- Negative test: unannotated node id returns 400 and leaves the source byte-for-byte unchanged.
- Regression test: no project-root `runs/`, `.poolside`, or Smithers execution log is created by saving source.

Assertions:

- Source file changed at the intended config path only.
- Task id remains unchanged.
- Graph re-render includes changed prompt.
- Existing runs are not modified.
- Failed saves leave source unchanged.

Verification command:

```bash
bun test tests/workflowViewer.source.test.ts tests/workflowViewer.graph.test.ts
```

### Slice 5 — editable model field appears and saves

Behavior test:

```txt
Given a graph node with editable model metadata
When the user changes the model and saves
Then the workflow source updates and future runs use the new model value
```

Implementation notes:

- The current model may be on the task agent descriptor, on `meta.studio.fields.model.value`, or in the generated source config. Prefer the metadata/source value when present.
- First-version validation can be conservative:
  - non-empty string,
  - no control characters,
  - optional provider allow-list if the workflow metadata declares `options`.
- Save through the same structured source API as prompt edits.
- After save, re-render and show the updated model in both the inspector identity area and the model control.

Test additions:

- UI helper test: a `model-select` field renders as a select when `options` are present and as a text input when no options exist.
- API test: changing `editable.agents.claude.model` updates source and the re-rendered graph reports the new model.
- Run seam test: after saving, `POST /api/workflows/foo/run` calls `runProjectWorkflow` with no `promptOverrides`; the model change comes from workflow source.
- Negative test: empty model returns 400 and preserves source.
- Negative test: source path points at a prompt field but field kind is `model-select`; server rejects the mismatch or missing target clearly.

Assertions:

- Current model is visible.
- Edited model persists after refresh.
- Save errors are clear if model value is invalid or source path is missing.
- Future run requests do not send model as ad-hoc run state.

Verification command:

```bash
bun test tests/workflowViewer.source.test.ts tests/workflowViewer.run.test.ts
```

### Slice 6 — preview input updates rendered prompt but not source

Behavior test:

```txt
Given an editable workflow loaded in project mode
When the user changes Preview input
Then rendered prompts update but workflow source remains unchanged
```

Implementation notes:

- Keep using `GET /api/workflows/:id/graph?input=...` for preview renders.
- Label the top textarea **Preview input** in project mode and keep it visually distinct from the workflow name/id.
- Debounced re-render should preserve selected node, inspector scroll, unsaved structured field drafts, and pretend outputs.
- Preview input should not create prompt overrides or write workflow source.

Test additions:

- API test using the existing render seam: call `/api/workflows/foo/graph?input={"prompt":"A"}` then with `{"prompt":"B"}` and assert the renderer receives both inputs.
- Integration test with a real render-only workflow: prompt includes `ctx.input.prompt`; changed input changes `graph.nodes[].prompt`.
- Source invariant: read workflow source before and after both graph calls and assert exact byte equality.
- UI helper test: project mode labels the input as “Preview input” and start-run copy says the input will be sent to Smithers.
- Regression test: no `runs/`, `.poolside`, or `.smithers/executions` directory is created by preview input changes.

Assertions:

- Graph prompt includes new input.
- Source file is byte-for-byte unchanged.
- UI labels this as preview input.
- The selected workflow id and source path remain visible while editing input.

Verification command:

```bash
bun test tests/workflowViewer.graph.test.ts tests/workflowViewer.graph.integration.test.ts tests/workflowViewer.ui.test.ts
```

### Slice 7 — pretend output updates downstream preview only

Behavior test:

```txt
Given a workflow where primary-plan reads concept output
When the user enters pretend concept output
Then primary-plan prompt includes that pretend concept
And no workflow source or Smithers run DB state is modified
```

Implementation notes:

- Continue passing pretend outputs through `GET /api/workflows/:id/graph?outputs=...`.
- Map node id to output table with `node.smithers.outputTableName`; fall back to node id only when no table name exists.
- Store pretend output in client state only. It should not be included in `/api/workflows/:id/run`.
- Label the editor **Pretend output for downstream preview** and include “Preview-only. Ignored by Start full run.”
- Validate JSON before applying; show the parse error without changing current preview state.

Test additions:

- API seam test: `outputs` query param parses into `{ concept: [{ nodeId: 'concept', iteration: 0, title: 'Lua hello world' }] }` for the renderer.
- Integration test with a render-only workflow that reads the concept output and interpolates it into a downstream prompt.
- Source invariant: workflow file is byte-for-byte unchanged after applying and clearing pretend output.
- Run seam test: after pretend output is applied, `POST /api/workflows/foo/run` payload includes only `input`, not `outputs`.
- UI helper test: invalid JSON keeps the previous pretend output and returns copy that starts with `Output must be JSON`.
- Clearing test: after clearing, the downstream prompt returns to the no-output render.

Assertions:

- Downstream prompt changes.
- Source file unchanged.
- No new run id is created.
- Clearing pretend output restores prior render.
- Actual run requests ignore pretend outputs.

Verification command:

```bash
bun test tests/workflowViewer.graph.test.ts tests/workflowViewer.graph.integration.test.ts tests/workflowViewer.run.test.ts
```

### Slice 8 — start full run uses saved workflow source and preview input

Behavior test:

```txt
Given saved prompt/model edits and preview input
When the user clicks Start full run
Then CustomHarness launches Smithers with the workflow id and input
And the response shows the Smithers run id
```

Implementation notes:

- The first-version project-mode run payload should be `{ input }` only after source-backed edits are saved.
- Remove project-mode `promptOverrides` from `runWorkflowFresh`; prompt/model edits should already be in source.
- The server should call the Smithers CLI path for source-backed runs, not the compatibility `runSmithersWorkflow` prompt-override path.
- Show the run id and canonical Smithers inspection commands in the UI after a successful start.

Test additions:

- Unit/seam test: saved source edit, then `/api/workflows/foo/run` invokes `runProjectWorkflow` with `workflowId`, `workflowPath`, and `input`; it does not include `promptOverrides` or `outputs`.
- UI helper test: run success copy includes the run id and the four commands:
  - `bunx smithers-orchestrator ps`
  - `bunx smithers-orchestrator inspect <run-id>`
  - `bunx smithers-orchestrator chat <run-id> --follow`
  - `bunx smithers-orchestrator logs <run-id>`
- Integration test can keep the existing safe real Smithers run, but add input assertion if the fixture echoes input into output/logs.
- Regression test: no legacy custom-harness `runs/` directory is created for project-mode Smithers runs.

Assertions:

- Run request includes preview input.
- Run starts from workflow source, not unsaved UI state.
- Pretend outputs are not sent as run state.
- UI shows run id and canonical Smithers inspection commands.

Verification command:

```bash
bun test tests/workflowViewer.run.test.ts tests/workflowViewer.run.integration.test.ts tests/workflowViewer.ui.test.ts
```

### Slice 9 — unsaved edits block run

Behavior test:

```txt
Given the user changed an editable field but did not save
When the user clicks Start full run
Then the UI asks to save or discard before running
```

Implementation notes:

- Track unsaved structured edits separately from preview input and pretend outputs.
- Preview input alone must not block a run.
- Pretend outputs alone must not block a run, but the confirmation/copy must say they are ignored.
- Blocking should happen on the client before any network request. The server is still protected because structured source edits only happen through the save endpoint.

Test additions:

- UI helper test: unsaved prompt edit sets `canStartRun: false` and returns actions `Save`, `Discard`, `Cancel`.
- UI helper test: saving clears the dirty field and `canStartRun` becomes true.
- UI helper test: discard resets the field to the last saved/source value and `canStartRun` becomes true.
- Run seam test: when unsaved edit state exists, no `POST /api/workflows/:id/run` request is constructed.
- Negative control: changed preview input with no unsaved source edits allows run.
- Negative control: pretend output with no unsaved source edits allows run but produces ignored-preview copy.

Assertions:

- No Smithers run starts while unsaved edits exist.
- User can save then run.
- User can discard then run.
- Preview input is not treated as an unsaved source edit.

Verification command:

```bash
bun test tests/workflowViewer.ui.test.ts tests/workflowViewer.run.test.ts
```

### Slice 10 — save as workflow copy

Behavior test:

```txt
Given an editable workflow
When the user saves edits as a copy named foo-v2
Then .smithers/workflows/foo-v2.tsx exists
And the viewer switches to foo-v2
And foo remains unchanged
```

Implementation notes:

- Use the same structured save endpoint with `mode: 'copy'`.
- Validate `newWorkflowId` with the existing discovery-compatible pattern: lowercase alphanumeric segments joined by hyphens.
- Refuse overwrite if `.smithers/workflows/<newWorkflowId>.tsx` already exists.
- Apply edits to the copied source after copying, not to the original.
- Return the new workflow id/path and a fresh graph. The client should set `currentWorkflowId` to the new id and clear dirty fields for that workflow.

Test additions:

- API test: original file bytes unchanged; new file exists and contains the edited field.
- Discovery test: `/api/workflows` lists `foo-v2` after copy.
- Graph test: response graph and a follow-up `/api/workflows/foo-v2/graph` render the edited prompt/model.
- Negative test: invalid id such as `Foo_V2`, `../foo`, or empty id returns 400 and writes no file.
- Negative test: existing target id returns 409 or 400 and writes no changes.
- UI helper test: after successful copy, selected workflow id is `foo-v2`, source destination copy updates to the new path, and old dirty state for `foo` is not reused.

Assertions:

- Original source unchanged.
- New source includes edits.
- New workflow is discoverable.
- Graph re-renders for new workflow.
- Browser refresh/server mismatch copy is clear if the server was started with `--workflow foo` but the UI is viewing `foo-v2`.

Verification command:

```bash
bun test tests/workflowViewer.source.test.ts tests/workflowViewer.discovery.test.ts tests/workflowViewer.graph.test.ts tests/workflowViewer.ui.test.ts
```

### Slice 11 — structure edit is only offered for metadata-backed groups

Behavior test:

```txt
Given a workflow group with meta.studio editable structure metadata
When the group is selected
Then the UI offers sequence/parallel controls
```

Implementation notes:

- Do this after prompt/model editing is stable.
- First version should only inspect metadata-backed group/host nodes. It should not rewrite arbitrary nested JSX.
- The metadata must identify:
  - group id,
  - supported modes,
  - source path for the mode/config slot,
  - child task ids controlled by the group.
- Default the save action to **Save as copy** for structure edits.
- Before saving, validate that each child id still exists and that transformed dependencies would still point at existing ids.

Test additions:

- Mapper test: group metadata reaches the group node if Smithers exposes it in host descriptors or supported XML metadata.
- UI helper test: controls appear for annotated groups and never for unannotated `Sequence`/`Parallel`/arbitrary JSX.
- API test: valid `sequence -> parallel` edit on a generated config slot writes a copy by default and preserves child task ids.
- Negative test: dependency points to a removed/missing child id; save is refused with a message naming the invalid dependency.
- Negative test: unannotated group edit request returns 400 and leaves source unchanged.

Assertions:

- Controls do not appear for arbitrary unannotated JSX.
- Save-as-copy is default for structure edits.
- Invalid transformations are refused with clear copy.
- Node ids are preserved unless the user explicitly edits ids in a later advanced feature.

Verification command:

```bash
bun test tests/smithersGraph.test.ts tests/workflowViewer.source.test.ts tests/workflowViewer.ui.test.ts
```

---

## Milestone-level acceptance checklist

Use this as the final review for the first milestone before handing it to users.

### Metadata and inspector

- Editable fields appear only from `meta.studio.fields`.
- Unannotated nodes are read-only except for the source fallback and preview-only pretend output.
- Inspector labels distinguish **Rendered prompt preview**, **Prompt template**, **Pretend output**, and **Run output**.
- The inspector shows task id, display label, agent id/kind, model when known, output table/schema when known, and source destination.

### Source saves

- Prompt/model/label saves go through metadata-backed source paths.
- Failed structured saves leave source byte-for-byte unchanged.
- Save success returns or triggers a fresh graph render.
- Browser refresh shows the saved value because the value is source-backed.
- Existing Smithers run ids, logs, and DB rows are not patched.

### Preview behavior

- Preview input changes rendered prompts that read `ctx.input`.
- Preview input changes do not modify source.
- Pretend outputs update downstream prompts that read prior node outputs.
- Pretend outputs do not modify source, do not create a run id, and are ignored by `Start full run`.

### Run behavior

- `Start full run` is blocked by unsaved structured or whole-source edits.
- `Start full run` is not blocked by preview input.
- `Start full run` warns/copies clearly when pretend outputs exist because they are ignored.
- The run request includes workflow id/path and preview input, not source drafts or pretend outputs.
- Success copy shows the run id and canonical Smithers inspection commands.

### Copy behavior

- Save-as-copy leaves the original workflow unchanged.
- The copied workflow has a valid discoverable id.
- The viewer switches to the copied workflow and re-renders it.
- Dirty state from the original workflow does not leak into the copied workflow.

## Manual browser smoke test

After automated tests pass, do one manual pass in project workflow mode:

```bash
bun --watch src/server.ts --project <fixture-project> --workflow foo
```

Smoke steps:

1. Confirm the header shows workflow id, source path, and project root.
2. Type preview input and confirm a prompt using `ctx.input.prompt` changes.
3. Select an unannotated node and confirm there are no structured save controls.
4. Select an annotated node and confirm rendered prompt preview and editable prompt template are separate controls.
5. Save a prompt edit and refresh the browser; confirm the edit remains.
6. Apply pretend output to an upstream node; confirm a downstream prompt changes.
7. Clear pretend output; confirm the downstream prompt returns to the previous render.
8. Make an unsaved prompt edit and click **Start full run**; confirm the UI blocks the run.
9. Save or discard the edit, then start a run; confirm the UI shows the Smithers run id and inspection commands.
10. Save as copy and confirm the original `.tsx` file is unchanged.

---

## Suggested first milestone

Do not start with full structure editing.

Before building deeper live-run UX, add a read-only Smithers run-state reader for project mode. It should read `smithers.db` through Smithers DB/runtime APIs and expose runs, node state, attempts, events, frames, and outputs. This is the foundation for making **Activity timeline** and graph task statuses truthful.

First editing milestone should be:

1. Preserve `meta` in graph JSON.
2. Update generated workflows to include editable metadata for prompts/models.
3. Show metadata-backed prompt/model editor in inspector.
4. Save to workflow source/config.
5. Re-render.
6. Start a new full run.

That gives the user the main loop:

```txt
run → inspect → tweak each agent prompt/model → save → rerun whole workflow
```

without touching existing run state.

## Open questions

- Should prompt edits save directly into `.tsx`, or into `.smithers/prompts/*.mdx` referenced by the workflow?
- Should save-in-place or save-as-copy be the default for generated workflows?
- What model list should the UI offer for Claude, Codex/OpenAI, Gemini, and Pi agents?
- Should `meta.studio` be treated as a CustomHarness/Poolside convention, or proposed upstream as a Smithers first-class convention?
- How should structure edits be represented so sequence/parallel changes are safe and understandable?
- How should the UI surface Smithers-native fork/replay later without confusing it with source editing?
- What exact TypeScript API should `SmithersRunReader` expose for DB-backed runs, node states, attempts, events, frames, and output rows?

## Non-goals for this plan

- No custom workflow runtime.
- No custom run database.
- No mutation of completed/running Smithers run internals.
- No arbitrary AST editor for every possible TypeScript expression.
- No drag-and-drop visual workflow editor in the first milestone.
- No live execution state viewer unless backed by Smithers canonical state.
