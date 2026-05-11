# Portable Smithers Authoring Workbench

## Goal

Build the next version of CustomHarness as a **portable Smithers workflow authoring workbench**:

1. A user describes an agentic workflow in natural language.
2. CustomHarness generates ordinary Smithers **Workflow Source** in `.smithers/workflows/*.tsx` using Smithers' TSX/JSX DSL, not React UI components.
3. The generated source is immediately rendered as a Smithers **Workflow Graph**.
4. The user edits source-backed fields through `Task.meta.editor` controls.
5. The user launches a Smithers **Run**.
6. Run inspection reads canonical Smithers SQLite state and persisted Run Frames.
7. The same capability is available through both the existing browser UI and an optional MCP Apps UI.

This is not a pivot away from natural-language authoring. It is a pivot from “local web feature” to “portable Smithers authoring workbench.” MCP Apps becomes one UI adapter over the same service/API.

## Product thesis

Natural-language authoring and MCP Apps are complementary:

- **Natural-language authoring** is the product capability: create useful Smithers workflows quickly.
- **MCP Apps** is a portable UI surface: expose that capability inside MCP hosts without replacing the existing browser UI. It may use React/HTML internally, but it is not the workflow representation.
- **Smithers** remains the canonical workflow runtime and run-state owner.

The core loop should feel like:

```txt
Describe workflow
  → generate Smithers Workflow Source
  → render graph via Smithers
  → edit source-backed prompts/models/labels
  → run via Smithers
  → inspect Smithers SQLite + Run Frames
```

## Non-goals

- No CustomHarness workflow IR.
- No draft database.
- No `runs/drafts`.
- No graph JSON as workflow source of truth.
- No manual writes to Smithers SQLite.
- No MCP App-only runtime or state store.
- No replacement of the existing browser UI in the first iteration.

## Domain constraints

- Generated Workflow Source is ordinary Smithers workflow-pack source from the moment it is written; `.tsx` here means Smithers TSX/JSX DSL, not React UI.
- Draft-ness is metadata/provenance, not a separate entity.
- `Task.meta.editor` is the source-editing bridge; `meta.studio` remains rejected legacy naming.
- Current Workflow Source previews and historical Run Inspection must remain distinct.
- Historical Run Inspection uses persisted Run Frames; it must not backfill graph/prompt/model/editor metadata from current source.
- The existing browser UI is the reference spec for functionality and interaction semantics, not visual styling.

## Architecture

### High-level shape

```txt
                         ┌────────────────────┐
                         │ Smithers Workflow  │
                         │ Source + Runtime   │
                         └─────────┬──────────┘
                                   │
                         ┌─────────▼──────────┐
                         │ WorkbenchService   │
                         │ pure service layer │
                         └────┬─────────┬─────┘
                              │         │
                 ┌────────────▼───┐ ┌───▼──────────────┐
                 │ HTTP Adapter   │ │ MCP Tool Adapter │
                 │ existing web   │ │ MCP Apps backend │
                 └───────┬────────┘ └────────┬─────────┘
                         │                   │
                ┌────────▼───────┐  ┌────────▼────────┐
                │ Browser UI     │  │ MCP App iframe  │
                │ reference spec │  │ portable UI     │
                └────────────────┘  └─────────────────┘
```

### Service layer

Create a service boundary that owns project workflow operations but delegates execution/rendering/persistence to Smithers.

Suggested module:

```txt
src/workbench/service.ts
```

Suggested factory:

```ts
type WorkbenchServiceDeps = {
  renderProjectWorkflowGraph: RenderProjectWorkflowGraphFn;
  runProjectWorkflow: RunProjectWorkflowFn;
  createSmithersRunReader: CreateSmithersRunReaderFn;
  generateWorkflowSource?: GenerateWorkflowSourceFn;
};

function createWorkbenchService(options: {
  projectRoot?: string;
  defaultWorkflowId?: string;
  deps: WorkbenchServiceDeps;
}): WorkbenchService;
```

Suggested service API:

```ts
interface WorkbenchService {
  getProject(): ProjectResponse;
  listWorkflows(): WorkflowsResponse;

  createWorkflowFromPrompt(input: {
    workflowId?: string;
    description: string;
    mode?: WorkflowAuthoringMode;
    overwrite?: boolean;
  }): Promise<CreateWorkflowResult>;

  renderWorkflowGraph(input: {
    workflowId: string;
    input?: Record<string, unknown>;
    outputs?: Record<string, unknown[]>;
  }): Promise<WorkflowGraphResponse>;

  getWorkflowSource(input: {
    workflowId: string;
  }): Promise<WorkflowSourceResponse>;

  saveWorkflowSource(input: {
    workflowId: string;
    source: string;
    expectedSourceHash?: string;
  }): Promise<WorkflowSourceSaveResponse>;

  saveWorkflowSourceField(input: {
    workflowId: string;
    nodeId: string;
    field: string;
    value: string;
    expectedSourceHash?: string;
  }): Promise<WorkflowSourceFieldSaveResponse>;

  startWorkflowRun(input: {
    workflowId: string;
    input: Record<string, unknown>;
  }): Promise<WorkflowRunStartResponse>;

  cancelWorkflowRun(input: {
    workflowId: string;
    runId: string;
  }): Promise<WorkflowRunCancelResponse>;

  listSmithersRuns(input: ListRunsOptions): Promise<SmithersRunsListResponse>;
  getSmithersRunDetail(
    input: { runId: string } & GetRunDetailOptions
  ): Promise<SmithersRunDetailResponse>;
  listSmithersRunEvents(
    input: { runId: string } & ListEventsOptions
  ): Promise<SmithersRunEventsResponse>;

  listOpenRouterModels(): Promise<OpenRouterModelsResponse>;
}
```

The service should return JSON-friendly DTOs already used by the web UI. HTTP routes and MCP tools should become thin adapters.

Important trust boundary: callers do **not** get to provide authoritative `sourcePath` values for structured field edits. `saveWorkflowSourceField` accepts a rendered `nodeId` plus a logical `field`; the service must re-render or reload current workflow metadata, verify that the node still declares that field in `Task.meta.editor`, read the declared `sourcePath` from metadata, and only then patch the supported generated config slot. This prevents browser/MCP clients from smuggling arbitrary source paths into the writer.

## Natural-language authoring design

### Authoring pipeline

```txt
User prompt
  → WorkflowDraftSpec
  → Smithers source template
  → write .smithers/workflows/<id>.tsx
  → write optional provenance doc under .smithers/docs/workflows/<id>.md
  → write optional workbench trace under .smithers/workbench/creation-traces/<id>/<timestamp>.md
  → render with Smithers
  → repair if render fails
  → return workflow id/source path/graph/warnings
```

### `WorkflowAuthoringResult`

The first authoring path asks the model to produce complete Smithers TSX Workflow Source directly. This matches Smithers' authoring thesis: agents are unusually good at JSX/TSX, and Smithers intentionally maps workflow authoring onto that shape.

A structured authoring result is still useful for validation and UI display, but it is not a workflow IR and is not persisted as source of truth.

```ts
type WorkflowAuthoringMode =
  | "sequence"
  | "gather-and-synthesize"
  | "panel"
  | "review-loop"
  | "supervisor"
  | "custom";

type WorkflowAuthoringResult = {
  workflowId: string;
  displayName: string;
  description: string;
  patternHint?: WorkflowAuthoringMode;
  source: string;
  assumptions: string[];
  openQuestions: string[];
  editorCoverage: Array<{
    nodeId: string;
    fields: string[];
  }>;
};
```

### Source pattern

Generated source should be deliberately boring and patchable:

```tsx
const editable = {
  workflow: {
    status: "draft",
    description: "...",
  },
  agents: {
    planner: { model: "openai/gpt-5.5" },
  },
  tasks: {
    plan: {
      label: "Plan",
      prompt: "Read the request and produce a plan for {{userPrompt}}.",
    },
  },
} as const;
```

Each generated task should include `meta.editor` for safe source-backed controls:

```tsx
meta={{
  editor: {
    editable: true,
    fields: {
      label: {
        label: "Display label",
        kind: "text",
        sourcePath: ["tasks", "plan", "label"],
      },
      prompt: {
        label: "Prompt template",
        kind: "multiline-text",
        sourcePath: ["tasks", "plan", "prompt"],
      },
      model: {
        label: "Model",
        kind: "model-select",
        sourcePath: ["agents", "planner", "model"],
      },
    },
  },
}}
```

### Generation strategy

Optimize for the fastest path to a working Smithers graph. Start with **model-authored Smithers TSX** rather than a deterministic pattern-spec generator. The prompt should strongly prefer matching Smithers Pattern Components when the user's request fits one cleanly, because those components are shipped Smithers library components, documented, legible, and already compose the primitives correctly. They are not runtime primitives and they do not become a CustomHarness topology type.

Initial recommended patterns for the authoring prompt:

1. **GatherAndSynthesize**: fan out to multiple specialists/sources, then synthesize.
2. **Panel**: N reviewers/specialists in parallel, then moderator synthesis/vote/consensus.
3. **ReviewLoop**: producer + reviewer, loop until approved.
4. **Supervisor**: boss plans, workers execute in parallel, boss reviews/redelegates.
5. **Sequence fallback**: direct primitive JSX for simple linear flows.

Generation remains source-first: the model returns ordinary `.smithers/workflows/<id>.tsx`. The generated source may import Smithers Pattern Components or expand to primitive JSX; after writing, Smithers rendering decides whether the workflow is valid. No CustomHarness workflow IR is persisted.

If model-authored TSX repeatedly fails to produce renderable workflows, fall back to the more constrained pattern-spec/deterministic-generator path. Do not start there unless the Smithers “agents are good at JSX” premise fails in practice.

### Verification and repair

MVP verification:

1. Ensure `workflowId` is safe and unique unless `overwrite` is true.
2. Write source under `.smithers/workflows/<id>.tsx` only.
3. Render graph through existing Smithers render path.
4. If render fails, run at most one constrained repair pass.
5. Return warnings if repair was needed or if assumptions/open questions remain.

The MVP repair pass may freeform-edit the generated Smithers TSX, but only inside the newly generated workflow file and only to fix render/type/import/Smithers API errors surfaced by verification. Repair must preserve Smithers-first constraints: no CustomHarness runtime, no legacy run artifacts, no manual SQLite writes, and no out-of-root file access.

Future hardening:

- render in a child process with timeout
- static check generated imports
- block network/env access during verification where possible
- diff/approval mode before applying source writes

## MCP Apps design

### Principle

The MCP App is a UI adapter, not a backend. It calls MCP tools. It should not call local HTTP routes directly except in a disposable spike.

### Model-visible MCP tools

#### `open_workflow_workbench`

Launches the MCP App.

```ts
{
  workflowId?: string;
  input?: Record<string, unknown>;
  runId?: string;
}
```

Returns:

- text summary for non-UI hosts
- structured bootstrap state
- `_meta.ui.resourceUri = "ui://custom-harness/workbench.html"`

#### `create_workflow_from_prompt`

Canonical MCP authoring entry point. Allows the user to describe a workflow in chat, have the model call this tool, generate Smithers TSX Workflow Source, and optionally open the workbench on the new workflow.

```ts
{
  workflowId?: string;
  description: string;
  mode?: WorkflowAuthoringMode;
  openWorkbench?: boolean;
}
```

If `openWorkbench` is true and the host supports MCP Apps, link/render the workbench resource after creation.

#### `inspect_smithers_run`

Opens run inspection for a known run.

```ts
{
  runId: string;
  includeOutputs?: boolean;
}
```

### App-only MCP tools

Use `_meta.ui.visibility = ["app"]` for UI operations. The app also includes a "New workflow" form for app-first creation, but chat-first creation through model-visible `create_workflow_from_prompt` remains the canonical MCP path. Both paths call the same `WorkbenchService.createWorkflowFromPrompt`.

- `ch_project_get`
- `ch_workflows_list`
- `ch_workflow_create_from_prompt`
- `ch_workflow_graph_render`
- `ch_workflow_source_get`
- `ch_workflow_source_save`
- `ch_workflow_source_field_save` (`workflowId`, `nodeId`, `field`, `value`, optional `expectedSourceHash`; service resolves `sourcePath` from current `meta.editor`)
- `ch_workflow_run_start`
- `ch_workflow_run_cancel`
- `ch_smithers_runs_list`
- `ch_smithers_run_detail_get`
- `ch_smithers_run_events_list`
- `ch_openrouter_models_list`

### MCP App UI panels

MVP app should mirror the browser UI behaviorally, not visually:

1. Workflow picker
2. New workflow from prompt
3. Runtime input editor
4. Workflow graph preview
5. Node inspector
6. Source-backed field editor
7. Basic advanced source tab: textarea for full `.tsx` source plus Save + Re-render
8. Start/cancel run controls
9. Live run inspection
10. Historical run list/detail

### Model context affordances

Because MCP Apps live inside agent hosts, add explicit handoff controls:

- “Ask agent about this node”
- “Ask agent to improve this prompt”
- “Summarize this run”
- “Generate a follow-up workflow”

Implementation pattern:

1. `app.updateModelContext({ content: [...] })` with compact selected workflow/run/node state.
2. `app.sendMessage({ role: "user", content: [...] })` with the requested action.

Do not automatically send context on every selection change.

## Existing browser UI role

Keep `web/index.html` as the reference UI until the shared UI/client abstractions exist.

The Project Workflow Viewer is the behavioral reference spec for the MCP App. The MCP App should preserve the same component inventory, relative hierarchy, state transitions, provenance language, safety boundaries, and enabled/disabled action semantics. It should not copy the browser UI's colors, ornamental styling, exact dimensions, or single-file implementation structure.

Source editing in the MCP App should be included as a boring advanced escape hatch, not an embedded IDE: use a textarea for the selected workflow `.tsx`, Save + Re-render, conflict/error display, and an optional fullscreen request when the host supports it. Do not make Monaco, VS Code keybindings, a multi-file explorer, arbitrary filesystem browsing, or large-file chunking part of the MVP.

Near-term browser changes:

- add “New workflow from prompt” entry point
- call HTTP adapter for `createWorkflowFromPrompt`
- open generated workflow immediately
- reuse existing graph/source/run inspection flows

Future browser/MCP convergence:

- define a browser-side `WorkbenchClient`
- implement `HttpWorkbenchClient`
- implement `McpWorkbenchClient`
- move graph/inspector helpers into shared browser modules
- reduce duplication between `web/index.html` and MCP App UI over time

## Implementation phases

### Phase 0.5 — MCP App host contract hardening

Purpose: align CustomHarness with Poolside Studio's MCP App Viewer contract before deeper UI polish. Poolside owns the render container; CustomHarness should expose standard MCP Apps resources, compact launch/card data, optional V1 graph hydration, app-only tools, and selected-state model context updates.

Tasks:

1. Keep `open_workflow_workbench` read-only/idempotent and return compact `structuredContent` with `contractVersion`, `launch`, `project`, `workflow`, `graphSummary`, `capabilities`, normalized `error`, and stable `launch.viewId`.
2. For V1 only, allow `graph?: RenderGraph` in `structuredContent` for fast iframe hydration/debugging. Treat it as optional, cap its serialized size, include `graphHydration`/truncation metadata, and require the app to fall back to `ch_workflow_graph_render`.
3. Do not include full `.tsx` source in the launcher result. Source is retrieved/saved only through app-only source tools.
4. Add app-only tools for project, workflow listing, graph render, source get/save/source-field save, run start/cancel, and Smithers run list/detail/events.
5. Keep all `ch_*` UI tools app-only with `_meta.ui.visibility = ["app"]`.
6. Add explicit MCP App resource CSP metadata and keep V1 iframe code free of direct localhost HTTP fetches.
7. Consume host context for theme, fonts/styles, safe area, dimensions, and display mode. Map fullscreen requests to host `requestDisplayMode`.
8. Feature-detect and use `updateModelContext` for selected workflow/node/run/error state; degrade gracefully when the host does not support it.
9. Register teardown handling and stop any future polling/animations before unmount.
10. Keep the container decision out of CustomHarness: no webview mode, no Poolside-specific artifact protocol, no host scraping assumptions.

Acceptance criteria:

- Poolside can render a compact chat card from `launch`/`workflow`/`graphSummary` without inspecting HTML or full graph JSON.
- The iframe can hydrate immediately from `graph` when included and can fetch the graph app-only when missing/truncated.
- App-only tools cover browser-reference project/source/run inspection operations.
- Selection changes can update future model context when the host advertises support.
- The MCP resource remains `text/html;profile=mcp-app` at `ui://custom-harness/workbench.html`.

### Phase 1 — Extract WorkbenchService from existing HTTP implementation

Purpose: refactor existing project workflow behavior out of `src/server.ts` into a shared service seam, without adding product behavior yet. This is not already done; it preserves the current browser/API behavior while making NL authoring and MCP Apps easier.

Tasks:

1. Add `src/workbench/service.ts`.
2. Move project setup/discovery/render/source/run/inspection operations behind service methods.
3. Keep `src/server.ts` routes and response shapes unchanged.
4. Update tests to assert HTTP behavior still passes.

Acceptance criteria:

- `bun test tests/` passes.
- `bun tsc --noEmit` passes.
- No UI behavior changes.
- No new persistence.

### Phase 2 — Model-authored Smithers TSX authoring service

Purpose: ship the core product capability locally.

Tasks:

1. Define `WorkflowAuthoringResult` validation and source safety checks.
2. Implement model-authored Smithers TSX generation with prompt guidance to prefer Smithers Pattern Components (`GatherAndSynthesize`, `Panel`, `ReviewLoop`, `Supervisor`) and primitive `Sequence` fallback.
3. Add `createWorkflowFromPrompt` service method.
4. Add render verification and one TSX repair hook seam.
5. Write provenance doc under `.smithers/docs/workflows/<id>.md` if that directory exists or can be safely created.
6. Write authoring trace/eval material under `.smithers/workbench/creation-traces/<id>/<timestamp>.md`, never `.poolside`.
7. Add HTTP endpoint `POST /api/workflows/create-from-prompt`.

Acceptance criteria:

- Given a prompt, a `.smithers/workflows/<id>.tsx` file is created.
- The source contains `meta.editor`, not `meta.studio`.
- The workflow renders through Smithers.
- Generated workflow appears in `GET /api/workflows`.
- Historical run tests remain unchanged/pass.

### Phase 3 — Browser UI authoring flow

Purpose: make creation usable in the existing reference UI.

Tasks:

1. Add “New workflow from prompt” control.
2. Collect workflow id, description, optional mode.
3. POST to authoring endpoint.
4. Select/open generated workflow.
5. Render graph and show verification/provenance warnings.
6. Allow normal source-backed edits and run launch.

Acceptance criteria:

- User can create, inspect, edit, and run a generated workflow from browser UI.
- Generated workflow uses existing graph/source/run inspection flows.
- No current-source fallback leaks into historical run inspection.

### Phase 4 — MCP server adapter

Purpose: expose the same workbench service through MCP tools.

Tasks:

1. Add `@modelcontextprotocol/sdk` and `@modelcontextprotocol/ext-apps`.
2. Add `src/mcp/server.ts` with stdio entrypoint.
3. Register model-visible launcher/authoring tools.
4. Register app-only service tools.
5. Register `ui://custom-harness/workbench.html` resource.
6. Return text/structured fallbacks for non-UI hosts.

Acceptance criteria:

- MCP client can list tools.
- `create_workflow_from_prompt` creates and renders a workflow without browser UI.
- App-only tools are hidden from model tool list where hosts honor visibility.
- No direct HTTP required for core operations.

### Phase 5 — Minimal MCP App UI

Purpose: prove portable UI without trying to perfectly port the web UI.

Tasks:

1. Add `mcp-app/workbench.html` + TS bundle.
2. Connect with `new App(...)` and register handlers before `connect()`.
3. Implement `McpWorkbenchClient` using `app.callServerTool`.
4. Implement workflow picker, creation form, graph preview, structured node editing, basic advanced source tab, run start, live polling, and run output inspection.
5. Use host theme/safe area/display-mode APIs lightly.
6. Test in `ext-apps` basic-host and one real host if available.

Acceptance criteria:

- `open_workflow_workbench` renders an MCP App iframe in basic-host.
- MCP App lists workflows.
- MCP App creates a workflow from prompt.
- MCP App renders preview graph.
- MCP App supports structured `meta.editor` node edits.
- MCP App supports a basic textarea source edit + Save/Re-render flow.
- MCP App starts a run and polls DB-backed state.
- MCP App can inspect node outputs for selected runs.

### Phase 6 — Convergence and polish

Purpose: reduce duplication and make portable UX feel first-class.

Tasks:

1. Extract shared browser UI modules where practical.
2. Add model-context handoff buttons.
3. Add fullscreen source/graph mode where host supports it.
4. Add host capability/degradation messaging.
5. Add screenshot/e2e coverage for MCP App basic-host.

## Testing strategy

### Service tests

- project setup missing `.smithers`
- workflow discovery
- graph render through Smithers seam
- source get/save
- field save validation
- run start/cancel seams
- Smithers DB reader close-on-error
- generated workflow source path safety
- generated workflow render verification

### Authoring tests

- prompt → `WorkflowDraftSpec`
- spec validation rejects unsafe IDs/source paths
- source generator emits `meta.editor`
- source generator never emits `meta.studio`
- generated sequence renders
- generated Pattern Component workflow renders when the request clearly maps to one
- generated primitive sequence fallback renders for simple linear requests
- overwrite behavior is explicit
- provenance doc is written only under project root

### HTTP tests

- `POST /api/workflows/create-from-prompt`
- existing routes unchanged
- generated workflow appears in `/api/workflows`
- generated workflow graph endpoint works

### UI tests

- browser creation flow opens generated workflow
- graph provenance says current Workflow Source
- source-backed edits still re-render
- live polling still guards against stale run selection
- historical run inspection remains frame-backed

### MCP tests

- MCP tool registration includes model-visible and app-only tools
- UI resource has MIME `text/html;profile=mcp-app`
- tool metadata uses `_meta.ui.resourceUri`
- app-only tools use `visibility: ["app"]`
- basic-host renders app
- MCP App uses tool calls, not direct HTTP fetches, for core workbench operations

## Safety and permissions

### Source writes

- Only write under selected project root.
- Only write `.smithers/workflows/<safe-id>.tsx` and optional `.smithers/docs/workflows/<safe-id>.md`.
- Require explicit overwrite flag for existing workflow IDs.
- Use atomic file writes (`tmp` + rename) for generated source and provenance docs.
- Include source hash or mtime preconditions on save operations that can be triggered by browser and MCP clients.
- On failed save/verification, preserve the previous bytes or roll back byte-for-byte.
- Prefer generated diffs/review mode before broad source edits.

### Generated TypeScript

- Template-first source generation in MVP.
- Validate spec before source generation.
- First slice targets fastest path to a working graph: generate Smithers TSX directly, prefer matching Smithers Pattern Components where they fit, and use primitive sequence fallback otherwise.
- Repair may only revise the spec/config and regenerate templates.
- Render verification with timeout.
- Future child-process/sandbox for render verification.

### Runs

- Launch only through Smithers CLI/runtime surfaces.
- Do not insert Smithers DB rows manually.
- Do not write legacy run artifacts.

### MCP App

- Avoid direct network calls from iframe for core operations.
- Pin `@modelcontextprotocol/ext-apps` and `@modelcontextprotocol/sdk` versions rather than floating broad ranges during the first implementation.
- Validate host MCP Apps capability (`io.modelcontextprotocol/ui`) and supported MIME type before relying on UI rendering.
- Declare resource CSP accurately, and put CSP/permissions on resource metadata, not tool metadata.
- Require explicit MCP `projectRoot` configuration; do not infer from ambient cwd in a host process.
- Treat host support as variable; degrade to text/structured tool output.
- Register App handlers before `connect()`.

## Recommended decision

Proceed with a **two-track but sequential** plan:

1. First build the service seam and natural-language authoring capability.
2. Then expose the same service through MCP tools and MCP Apps.

Do not start with the MCP App UI before extracting the service layer. Without the service seam, the MCP App will either duplicate server logic or depend on local HTTP fetches, which undermines portability.

## First thin slice

The smallest meaningful slice is:

1. Extract `WorkbenchService` while preserving HTTP behavior.
2. Implement `createWorkflowFromPrompt` using model-authored Smithers TSX with prompt guidance to prefer Pattern Components plus primitive sequence fallback.
3. Write `.smithers/workflows/<safe-id>.tsx` with boring `editable` config and `meta.editor` where node-level structured editing is available.
4. Add `POST /api/workflows/create-from-prompt`.
5. Add browser button/modal to create/open generated workflow.
6. Verify generated workflow appears in `/api/workflows`, renders through Smithers, contains `meta.editor` not `meta.studio`, creates no legacy `runs/`, and can be run through Smithers.

After that, MCP Apps becomes a straightforward adapter, not a strategic detour.

## Resolved MVP decisions

1. First generated workflows should be model-authored Smithers TSX, not deterministic CustomHarness template output.
2. The authoring prompt should prefer matching Smithers Pattern Components over hard-coded CustomHarness topology templates, with primitive sequence as fallback.
3. Smithers Pattern Components are importable library components that compose primitives; they are not runtime substrate and must not become a persisted CustomHarness topology model.
4. Provenance docs: `.smithers/docs/workflows/<id>.md` when provenance is enabled.

## Remaining open decisions

1. Which MCP transport should be first: stdio only, or stdio plus Streamable HTTP?
2. Should MCP App support wait until browser authoring works, or should a minimal basic-host spike happen in parallel after service extraction?
3. When should fanout/review-gate templates become part of the default authoring flow?
4. What source-write conflict UX should browser and MCP clients show when `expectedSourceHash` fails?
