# MCP Apps as a portable CustomHarness UI layer

Date: 2026-05-09
Repo researched: `modelcontextprotocol/ext-apps` @ `1d091e2` (`@modelcontextprotocol/ext-apps` npm latest `1.7.1`)

## Summary

MCP Apps is a good fit as an **additional UI surface** for CustomHarness, not a replacement for the current browser UI.

The current `web/index.html` should remain the reference implementation / functional spec. An MCP App can expose the same Smithers workbench capabilities inside Claude, ChatGPT, VS Code, Goose, Postman/MCPJam-style hosts, etc. The key shift is that the UI should stop assuming same-origin HTTP endpoints and instead talk through MCP tools, especially `visibility: ["app"]` tools hidden from the model.

The right shape is:

- keep Smithers as canonical source/run state
- extract the existing HTTP route bodies into a pure `WorkbenchService`
- expose that service through both:
  - existing HTTP routes (`/api/workflows`, `/api/smithers/runs`, etc.)
  - a new MCP server with MCP Apps metadata and app-only tools
- build a small MCP App bundle that initially mirrors the current workflow viewer flows
- later modularize/reuse current web UI components, but do not block on that

## What MCP Apps actually is

MCP Apps extends MCP with tool-declared UI resources. The server registers a normal MCP tool plus a `ui://...` HTML resource. When a compatible host calls the tool, it fetches that resource and renders it in a sandboxed iframe.

Core lifecycle:

1. server exposes tools/list with `_meta.ui.resourceUri`
2. host calls tool
3. host reads UI resource (`text/html;profile=mcp-app`)
4. view initializes over `postMessage`
5. host sends tool input/result to the view
6. view calls server tools through the host for refreshes/actions

Important details from source/docs:

- UI resources use the `ui://` URI scheme and are rendered as sandboxed iframe HTML resources.
- MIME type is `text/html;profile=mcp-app`.
- Tool metadata uses `_meta.ui.resourceUri`; the SDK helper also writes the older flat `ui/resourceUri` key for compatibility.
- Tools can be visible to the model, the app, or both. `visibility: ["app"]` is the main mechanism for UI-only actions like polling, form saves, pagination, and run cancellation.
- Hosts advertise support through MCP extension capability `io.modelcontextprotocol/ui` with supported MIME types.
- Views can call `app.callServerTool`, `app.readServerResource`, `app.updateModelContext`, `app.sendMessage`, `app.requestDisplayMode`, etc.
- CSP is restrictive by default. Network domains must be declared on resource `_meta.ui.csp`; direct localhost fetches from the iframe are not portable.

## Implication for CustomHarness

The existing HTTP UI currently does same-origin `fetch('/api/...')`. An MCP App iframe usually will not share that origin, and portable hosts may not permit direct network access at all. So the MCP App should treat MCP tools as its backend.

This is the major architecture fork:

### Option A — direct HTTP from iframe

The MCP App loads current-ish HTML and keeps calling `http://localhost:<port>/api/...` with CSP `connectDomains`.

Pros:

- fastest proof of concept
- minimal server code

Cons:

- not truly portable
- requires localhost tunnel/stable origin for remote hosts
- gets into CORS/CSP/host-domain quirks
- duplicates host-mediated MCP semantics poorly

Verdict: useful only as a throwaway spike.

### Option B — MCP tools as UI backend

The MCP App calls app-only MCP tools. The host proxies those tool calls to our MCP server. No direct browser network access is required.

Pros:

- portable across compliant hosts
- keeps model-facing tool list small
- works with sandbox restrictions
- gives us typed, auditable UI operations
- cleanly shares business logic with HTTP routes if we extract a service layer

Cons:

- more upfront refactor
- current `web/index.html` is monolithic, so code reuse is initially limited
- some hosts may vary in UI feature support

Verdict: the right product direction.

## Proposed CustomHarness MCP surface

Start with one model-facing app launcher plus app-only operations.

### Model-visible tools

#### `open_workflow_workbench`

Purpose: open the interactive CustomHarness/Smithers workbench.

Input:

```ts
{
  workflowId?: string,
  input?: Record<string, unknown>,
  runId?: string
}
```

Behavior:

- returns text summary for non-UI hosts
- returns structuredContent with project/workflow/run bootstrap data
- has `_meta.ui.resourceUri = "ui://custom-harness/workbench.html"`

#### `show_workflow_graph`

Purpose: let the agent intentionally open a specific workflow graph in UI.

Input:

```ts
{ workflowId: string, input?: Record<string, unknown> }
```

This can share the same app resource but bootstrap directly into graph mode.

#### `inspect_smithers_run`

Purpose: open a historical/live run inspection UI.

Input:

```ts
{ runId: string, includeOutputs?: boolean }
```

This is useful when the user asks the agent “show me that run”.

### App-only tools

These should use `_meta.ui.visibility = ["app"]` unless we intentionally want the agent to call them too.

- `ch_project_get`
- `ch_workflows_list`
- `ch_workflow_graph_render`
- `ch_workflow_source_get`
- `ch_workflow_source_save`
- `ch_workflow_source_field_save`
- `ch_workflow_run_start`
- `ch_workflow_run_cancel`
- `ch_smithers_runs_list`
- `ch_smithers_run_detail_get`
- `ch_smithers_run_events_list`
- `ch_openrouter_models_list`

This maps closely to current project-mode HTTP routes:

- `GET /api/project`
- `GET /api/workflows`
- `GET /api/workflows/:id/graph`
- `GET/PUT /api/workflows/:id/source`
- `PUT /api/workflows/:id/source-field`
- `POST /api/workflows/:id/run`
- `POST /api/workflows/:id/runs/:runId/cancel`
- `GET /api/smithers/runs`
- `GET /api/smithers/runs/:runId`
- `GET /api/smithers/runs/:runId/events`
- `GET /api/openrouter/models`

## UI design inside an MCP App

Use the current browser UI as the reference spec. The MCP App should support the same conceptual panels:

1. **Workflow picker**
   - list `.smithers/workflows/*.tsx`
   - select workflow
   - show setup-needed state when no project or no `.smithers`

2. **Current Workflow Source preview graph**
   - render Smithers `GraphSnapshot` projection
   - selected node inspector
   - graph provenance clearly says current source, not historical run

3. **Runtime input editor**
   - edit `input.prompt` / workflow input JSON
   - re-render preview with input

4. **Source editor**
   - full `.tsx` source editor
   - save and re-render
   - field-level edits for supported `Task.meta.editor` fields

5. **Run controls**
   - start Smithers run
   - show run id/status
   - cancel run when active

6. **Live run inspection**
   - poll Smithers DB detail/events via app-only tools
   - overlay DB node state onto preview/current graph only for the selected live run
   - use persisted Run Frames for historical runs; never fall back to current source for historical graphs

7. **Historical run browser**
   - list recent Smithers runs
   - load selected run
   - show outputs/events/attempts/frame summary

8. **Model handoff affordances**
   - “Ask agent about selected node” button uses `app.updateModelContext` then `app.sendMessage`
   - selecting a node can update model context with a compact summary, but should not spam the host on every mousemove

## Implementation plan

### Phase 0 — keep current UI; define service boundary

Extract current server route logic into pure service functions, for example:

```ts
src / workbench / service.ts;
```

Shape:

```ts
createWorkbenchService({ projectRoot, defaultWorkflowId, deps })
  .getProject()
  .listWorkflows()
  .renderWorkflowGraph({ workflowId, input, outputs })
  .getWorkflowSource({ workflowId })
  .saveWorkflowSource({ workflowId, source })
  .saveWorkflowSourceField({ workflowId, sourcePath, value })
  .startWorkflowRun({ workflowId, input })
  .cancelWorkflowRun({ workflowId, runId })
  .listSmithersRuns(opts)
  .getSmithersRunDetail(runId, opts)
  .listSmithersRunEvents(runId, opts);
```

Then HTTP routes become thin adapters. MCP tools become another thin adapter. This prevents MCP Apps from becoming a parallel runtime.

### Phase 1 — minimal MCP server + app resource

Add `src/mcp/server.ts`:

- creates `McpServer`
- registers `open_workflow_workbench` with `_meta.ui.resourceUri`
- registers `ui://custom-harness/workbench.html`
- registers app-only tools over `WorkbenchService`
- supports stdio first, HTTP later

Add package deps:

- `@modelcontextprotocol/sdk`
- `@modelcontextprotocol/ext-apps`
- probably `zod` is already present

### Phase 2 — simple MCP App bundle

Add something like:

```txt
mcp-app/
  workbench.html
  src/main.ts
  src/backend.ts
  src/graph.ts
  vite.config.ts
```

The first version can be simpler than the current UI:

- workflow dropdown
- render graph as SVG/HTML boxes
- inspector
- start run
- polling live detail

It should be built to `dist/mcp-app/workbench.html` as a single HTML resource.

### Phase 3 — shared UI backend abstraction

Define a browser-side interface:

```ts
interface WorkbenchClient {
  getProject(): Promise<ProjectResponse>;
  listWorkflows(): Promise<WorkflowsResponse>;
  renderWorkflowGraph(args): Promise<GraphResponse>;
  getWorkflowSource(args): Promise<SourceResponse>;
  saveWorkflowSource(args): Promise<SaveResponse>;
  startWorkflowRun(args): Promise<RunStartResponse>;
  getSmithersRunDetail(args): Promise<RunDetailResponse>;
}
```

Implement:

- `HttpWorkbenchClient` for current browser UI
- `McpWorkbenchClient` for MCP App (`app.callServerTool`)

Only after that should we consider migrating chunks of `web/index.html` into shared modules.

### Phase 4 — host-aware polish

MCP host constraints and capabilities should drive UI behavior:

- request fullscreen for source editing / graph inspection when available
- use host theme variables where possible
- use `safeAreaInsets` on mobile/desktop hosts
- avoid direct downloads unless `downloadFile` is supported
- use `updateModelContext` for selected run/node summaries
- degrade to structured text output in non-UI hosts

## Risks / gotchas from ext-apps repo

- **Host support varies.** MCP Apps is an extension, not core MCP. Non-supporting hosts should get normal text/structured data.
- **Current host/API stability is still moving.** Recent issues include resource subscription proposals, missing host capability fields, CSP `unsafe-eval` / wasm discussion, and basic-host bugs around `_meta` forwarding.
- **Do not rely on direct network access from the iframe.** CSP defaults are restrictive; direct localhost fetches damage portability.
- **Do not put CSP/permissions on tool metadata.** In current SDK types, `McpUiToolMeta.csp` and `.permissions` are `never`; CSP belongs on the UI resource metadata.
- **Register handlers before `connect()`.** The SDK warns about late handler registration because one-shot notifications may be missed.
- **Polling should be app-only tools.** The system-monitor example uses a model-facing tool for initial static data and an app-only polling tool for live stats. This maps exactly to Smithers run inspection.
- **Historical run inspection must stay frame-backed.** The MCP App should preserve our current invariant: historical `view.graph` comes from persisted Smithers frames, never current workflow source fallback.

## Recommended decision

Support MCP Apps as a second UI option, with the existing browser UI as the reference spec.

Do **not** replace the browser UI yet. The browser UI is still valuable for:

- fast local debugging
- deterministic tests
- reference behavior while hosts vary
- development without MCP host setup

But design new UI/API work so it can flow through the shared `WorkbenchService` and MCP app-only tools. That makes CustomHarness genuinely portable without inventing another workflow runtime.

## Acceptance criteria for a first spike

A successful spike should prove:

1. A compatible MCP host can call `open_workflow_workbench` and render an iframe.
2. The app lists workflows from the configured project.
3. The app renders a Smithers preview graph for a workflow.
4. The app starts a Smithers run and receives a run id.
5. The app polls DB-backed run detail/events through app-only tools.
6. No MCP App path writes legacy `runs/` artifacts or mutates Smithers DB directly.
7. A non-UI host still gets useful text/structured data from model-visible tools.

## Source notes

Primary source evidence:

- `README.md`: supported-client claim and high-level flow: tool declares `ui://`, host renders sandbox iframe, bidirectional communication.
- `docs/overview.md`: progressive enhancement, lifecycle, tool visibility, host context, display modes, security.
- `docs/quickstart.md`: `registerAppTool`, `registerAppResource`, `RESOURCE_MIME_TYPE`, `App.connect`, `app.callServerTool` pattern.
- `docs/patterns.md`: app-only polling tools, chunked data, `updateModelContext`, `requestDisplayMode`.
- `docs/csp-cors.md`: all network origins must be declared in `_meta.ui.csp`; stable `domain` is host-specific.
- `docs/testing-mcp-apps.md`: local basic-host and compatible-host test paths.
- `src/spec.types.ts`: `McpUiToolMeta`, `McpUiResourceCsp`, `McpUiHostCapabilities`, `McpUiClientCapabilities`.
- `src/server/index.ts`: server helpers and `getUiCapability`.
- `src/app.ts`: View-side `App` methods.
- `examples/basic-host/src/implementation.ts`: reference host `AppBridge` / sandbox proxy / tool result delivery.
- `examples/system-monitor-server`: model-facing initial data plus app-only polling tool.
