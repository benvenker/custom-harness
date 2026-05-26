# Investigation: Smithers UI Portability and Installability

## Summary
CustomHarness is **highly feasible to extract into an installable Smithers workflow UI package**, but it is **not installable as-is**. The reusable Smithers substrate already exists in `src/smithersProject/*`, `src/runs/smithersGraph.ts`, and `src/ui/*`; the blocker is boundary collapse in `src/server.ts`, repo-root/static-source assumptions in `web/index.html`, missing package entrypoints, and duplicated browser/MCP UI contracts.

## Symptoms
- User wants to understand whether CustomHarness can become an installable Smithers workflow UI layer for arbitrary Smithers projects.
- Need to evaluate how decoupled the current UI is from Smithers and from this repo's demo/prototype assumptions.
- Need to compare with the MCP apps integration pattern and any prior project that may have pulled UI concerns out more cleanly.

## Background / Prior Research

### MCP Apps / Portable UI Prior Work
- Repo archaeology points to commit `22af403` (`feat: add Smithers workbench authoring foundation`) as the inflection where the project added `docs/feedback/mcp-apps-ui-layer-research-2026-05-09.md`, `docs/plans/portable-smithers-authoring-workbench.md`, `src/mcp/workbenchApp.ts`, and MCP app dependencies.
- Prior docs framed MCP Apps as an additional portable UI surface, not a replacement for the browser UI. Key idea: existing `web/index.html` remains the reference surface, while MCP App UI should call app-specific MCP tools instead of depending on same-origin HTTP.
- The portable-workbench plan called for a pure `WorkbenchService` with HTTP and MCP tool adapters. Current implementation reportedly still keeps much MCP/HTTP adapter logic in `src/server.ts`, and no current `src/workbench/service.ts` was found.
- Untracked/current ADR-0007 reportedly accepts small named MCP/CLI “Paved Path” operations, while keeping lower-level Smithers primitives code-first; app-only `ch_*` tools are UI plumbing, not the canonical agent-facing contract.

### Smithers External API / Runtime Constraints
- Smithers project source lives in `.smithers/workflows`, `.smithers/prompts`, `.smithers/components`, and related workflow-pack files.
- Smithers rendering is React/JSX workflow source → host workflow tree → `GraphSnapshot`. `GraphSnapshot` and persisted Smithers frames are the right graph/history boundary for UI projection.
- Nearest `smithers.db` is canonical Smithers Run State; read via Smithers package/adapter APIs when possible. Useful read surfaces include run, node, event, frame, and output APIs.
- Run control should wrap Smithers CLI/runtime/MCP/gateway operations, not duplicate runtime behavior. Workflow source edits are ordinary file edits but affect resume safety.
- Safe boundary: CustomHarness/portable UI should never manually mutate `_smithers_*` tables or output tables; allowed writes go through Smithers runtime/CLI/API surfaces or ordinary workflow-pack source edits.

### Sibling Project Patterns
- `/Users/ben/code/poolside/poolside-studio-pr486` has the strongest technical analog: an MCP Apps bridge that separates session/service lifecycle, `ui://` resource validation, tool-result reconstruction, IPC adapters, and UI resource loading.
- `/Users/ben/code/poolside/spark-proto/frontend/skills-references/al` is the strongest “pulled-out UI layer” analog: shared foundation/components/copy extracted from a prototype into reusable references.
- Pattern to borrow: separate a portable Smithers/workbench service core and adapters from visual/design-layer extraction. Do not let the browser/MCP App surface become the service boundary.

## Investigator Findings

### 2026-05-26 - Portability/installability investigation

#### Bottom line

The hypothesis is broadly correct, with one important qualification: CustomHarness already has reusable Smithers adapters and UI-state helpers, but they are not yet arranged as an installable product boundary. The reusable pieces are service-like and Smithers-first; the blocking coupling sits mainly in `src/server.ts`, `web/index.html`, package/CLI metadata, and the separate MCP App UI implementation.

CustomHarness can become an installable Smithers workflow UI layer for arbitrary Smithers projects if it extracts a transport-neutral workbench service and packages the UI assets separately from the target project root. Today it is repo-local runnable, not package-installable.

#### Evidence: reusable/service-like pieces already exist

- `src/smithersProject/runReader.ts` is already a focused read adapter: it exports `createSmithersRunReader()` and `smithersRunReaderFromHandle()`, then exposes `listRuns`, `getRunDetail`, and `listEvents` over Smithers DB adapter calls (`src/smithersProject/runReader.ts:43-148`). This is a good candidate to remain a reusable WorkbenchService dependency rather than stay embedded in HTTP handlers.
- `src/smithersProject/sqliteReadOnly.ts` centralizes nearest-`smithers.db` discovery and opens Bun SQLite with `readonly: true` plus `PRAGMA query_only = ON` (`src/smithersProject/sqliteReadOnly.ts:35-58`, `src/smithersProject/sqliteReadOnly.ts:85-104`). This matches the Smithers-first run-inspection rule.
- `src/smithersProject/historicalGraph.ts` builds a historical view from persisted Smithers run frames, not current source (`src/smithersProject/historicalGraph.ts:35-84`), and projects those frames through the existing graph mapper (`src/smithersProject/historicalGraph.ts:87-114`). That is portable UI projection logic, not prototype-only storage.
- `src/runs/smithersGraph.ts` is already a transport-neutral `GraphSnapshot` -> `RenderGraph` mapper, preserving task metadata and Smithers node fields (`src/runs/smithersGraph.ts:1-82`, `src/runs/smithersGraph.ts:105-166`, `src/runs/smithersGraph.ts:181-218`). Despite the `src/runs` path name, this file is reusable projection code.
- `src/ui/*` contains small pure state helpers: run payload/polling in `src/ui/workflowRunUi.ts:18-47`, source-backed inspector state in `src/ui/studioInspector.ts:46-92`, live/historical graph decisions in `src/ui/projectLiveState.ts:56-103` and `src/ui/projectLiveState.ts:112-175`, and Smithers DB overlays in `src/ui/smithersRunOverlay.ts:74-119` plus inspector state in `src/ui/smithersRunOverlay.ts:121-205`.
- `src/smithersProject/cli.ts` already abstracts Smithers run command resolution across project-local, workflow-pack-local, and `bunx smithers-orchestrator` fallback (`src/smithersProject/cli.ts:8-39`). That belongs in a reusable Smithers adapter layer.

Conclusion: there is enough reusable substrate to justify extraction. The main task is not inventing a new adapter; it is moving existing reusable logic behind stable service/client boundaries.

#### Evidence: `src/server.ts` is the biggest service-boundary blocker

`src/server.ts` is a 2.9k-line god module combining transport, service, UI packaging, source mutation, authoring, run inspection, and startup concerns.

- The top-level handler mixes route dispatch for MCP, authoring, run cancel/start, source-field save, source get/save, project/workflow discovery, OpenRouter models, Smithers run listing/detail/events, graph rendering, and static serving (`src/server.ts:66-247`).
- The MCP transport and app-tool registration live in the same file: `mcpResponse()` creates a `WebStandardStreamableHTTPServerTransport` (`src/server.ts:260-286`), while `createCustomHarnessMcpServer()` registers public tools and many app-only `ch_*` tools (`src/server.ts:322-939`).
- MCP app bootstrap/view contract logic is also in the server module: `mcpWorkbenchBootstrap()`, capability flags, graph summarization, hydration limits, and stable view ids (`src/server.ts:940-1139`).
- MCP App HTML/CSS generation is inlined and builds `src/mcp/workbenchApp.ts` at request time through `Bun.build()` (`src/server.ts:1140-1286`). This is UI resource packaging, not workbench service logic.
- Project setup and workflow discovery are embedded as local functions (`src/server.ts:1289-1339`, `src/server.ts:1933-1970`).
- Natural-language workflow creation is embedded end-to-end: create response, id allocation, source generation/repair, validation, filesystem writes, render verification, and trace writing (`src/server.ts:1348-1530`, `src/server.ts:1531-1799`). It also calls OpenRouter directly for authoring (`src/server.ts:2516-2574`) and carries a long Smithers authoring system prompt in server code (`src/server.ts:2628-2715`).
- Smithers run inspection HTTP responses are thin wrappers around a reusable reader, but still live in `server.ts` (`src/server.ts:1803-1931`).
- Graph rendering and the preview input-node overlay live in `server.ts` (`src/server.ts:1972-2042`), although the mapper itself is reusable in `src/runs/smithersGraph.ts`.
- Source editing, including fragile editable-object/string parsing and whole-source writes, is embedded in `server.ts` (`src/server.ts:2044-2261`, `src/server.ts:2314-2350`). This should become a service method with tests and validation, then be called by HTTP/MCP/CLI adapters.
- Run start and cancel are split: run start uses `buildSmithersWorkflowRunCommand()` (`src/server.ts:2473-2514`), but cancel hardcodes `bun node_modules/.bin/smithers cancel` from the project root (`src/server.ts:2352-2388`), bypassing the portable command resolution in `src/smithersProject/cli.ts:24-39`.
- Static serving assumes a root directory with `/web/index.html` and optional TS helper sources available (`src/server.ts:2772-2815`). The process entrypoint also lives here and parses only `--project` and `--workflow` (`src/server.ts:2846-2907`).

Conclusion: extract `WorkbenchService` methods for project discovery, graph render/projection, source get/save, structured field save, run start/cancel, run inspection, workflow creation, and bootstrap summaries. Keep only path matching, `Request`/`Response`, CORS, MCP tool registration, static resources, and process startup in adapters.

#### Evidence: browser UI and MCP App duplicate behavior and expose different contracts

- The browser surface is a single large behavioral reference in `web/index.html`, not a package-ready component tree. It includes markup/style/sample data and a long imperative script; sample/demo data starts immediately after the modal markup (`web/index.html:1539-1565`).
- Browser state is a large set of globals for sample/run/project/workflow/source/drafts/timers/live inspection (`web/index.html:1740-1802`). The MCP App has a separate parallel state model for bootstrap, workflows, selected workflow/node, graph, host context, busy action, and zoom (`src/mcp/workbenchApp.ts:66-76`).
- Browser and MCP both render graph nodes, selection, and zoom independently: MCP graph dimensions/rendering/zoom live at `src/mcp/workbenchApp.ts:267-338` and events at `src/mcp/workbenchApp.ts:465-539`; browser has its own DOM rendering and project state flow, including project graph refresh and debounced preview input (`web/index.html:3919-4027`).
- Browser has richer source-backed inspector and model-selection behavior via pure helpers and same-origin HTTP (`web/index.html:2268-2307`, `web/index.html:2408-2529`). MCP App only shows rendered prompt plus raw editor metadata in its inspector (`src/mcp/workbenchApp.ts:340-362`).
- Browser is tightly coupled to same-origin HTTP routes: `/api/project` and `/api/workflows` (`web/index.html:3848-3871`), `/api/workflows/:id/graph` (`web/index.html:3998-4023`), `/api/workflows/:id/source` (`web/index.html:3794-3828`), `/api/workflows/:id/run` (`web/index.html:3564-3583`), `/api/smithers/runs` (`web/index.html:3301-3327`), plus legacy `/runs/index.json` and `/runs/:id/*.json` compatibility paths (`web/index.html:3221-3233`, `web/index.html:3340-3389`).
- MCP App correctly uses MCP Apps host APIs and app-only tools instead of same-origin fetch: it calls `ch_workflows_list`, `ch_workflow_graph_render`, and `ch_workflow_create_from_prompt` (`src/mcp/workbenchApp.ts:153-190`, `src/mcp/workbenchApp.ts:212-245`). Server-side `ch_*` tools exist for more operations, including source get/save, source-field save, run start/cancel, and Smithers run list/detail/events (`src/server.ts:419-939`), but the MCP App does not yet consume many of them.
- The `ch_*` tools are intentionally app-only UI plumbing via `_meta: { ui: { visibility: ["app"] } }` (`src/server.ts:419-939`). ADR-0007 says these may remain UI plumbing but should not define the agent-facing Smithers workbench contract (`docs/adr/0007-paved-path-tools-and-code-first-smithers-primitives.md:1-16`).
- MCP App host-specific shell behavior is appropriate but non-shareable: host display modes, theme/fonts/style variables, and model-context updates live in `src/mcp/workbenchApp.ts:1-7`, `src/mcp/workbenchApp.ts:113-146`, and `src/mcp/workbenchApp.ts:592-621`.

Conclusion: the MCP App is a useful portable UI proof, but today it duplicates the browser UI instead of sharing a view-model/client layer. The portable boundary should be a shared operation interface (`listWorkflows`, `renderGraph`, `get/saveSource`, `saveSourceField`, `start/cancelRun`, `list/getRuns`, `createWorkflow`) with thin HTTP and MCP transports, plus shared pure graph/inspector/run view-model helpers.

#### Evidence: package/installability blockers

- `package.json` has no `bin`, `main`, `exports`, or `files` fields (`package.json:1-30`). As published, there is no package executable for `bunx custom-harness`/npm-style use.
- README usage is repo-local: `pnpm dev` from this repo or `bun src/server.ts --project /path/to/project --workflow plan-fanout` (`README.md:1-10`). It does not document installation, `bunx`, global/local package use, packaged assets, or peer/project Smithers requirements (`README.md:1-20`).
- `src/index.ts` only delegates to `runCli()` (`src/index.ts:1-8`), and `src/cli.ts` explicitly says `src/index.ts` is help-only and does not run workflows (`src/cli.ts:1-31`). Even if wired as a package `bin`, it would not start the viewer except as help text.
- Server startup still uses `PORT` rather than the documented `CUSTOM_HARNESS_PORT` or `--port`, and `parseServerArgs()` only handles `--project` and `--workflow` (`src/server.ts:2846-2907`).
- Static asset serving couples the asset root to `rootDir`: `/` maps to `/web/index.html` under `rootDir` (`src/server.ts:2772-2815`). The handler defaults `rootDir` to `process.cwd()` and infers project root from that same root if it contains `.smithers` (`src/server.ts:66-76`, `src/server.ts:2886-2888`). Package use needs two roots: package asset root and target Smithers project root.
- Browser code dynamically imports helper modules from absolute source paths such as `/src/ui/studioInspector.js`, `/src/ui/workflowRunUi.js`, `/src/ui/smithersRunOverlay.js`, and `/src/ui/projectLiveState.js` (`web/index.html:2275-2303`). The static server special-cases missing `.js` files by looking for sibling `.ts` files under `rootDir` and building them on demand (`src/server.ts:2776-2794`). Arbitrary Smithers projects will not have these source files unless the full CustomHarness repo is the static root.
- `loadSmithersRuntime()` searches upward from the workflow path for `node_modules/@smithers-orchestrator/engine` and throws if absent (`src/app/smithersRuntime.ts:118-187`). That may be a correct project-runtime requirement, but install docs and adapter behavior need to say whether Smithers is a peer/project dependency or should be resolved from the installed CustomHarness package.
- Run start has a portable-ish command fallback (`src/smithersProject/cli.ts:24-39`), but run cancel does not (`src/server.ts:2352-2388`). This is a concrete arbitrary-project portability bug.

Conclusion: package metadata and asset-root separation are first-order blockers. A package-ready version needs a real bin, explicit asset root, bundled/browser-built UI assets, target-project root separated from package root, documented Smithers dependency expectations, and command parity for run/cancel/render operations.

#### Qualified answer to the hypothesis

Verified:

1. `src/server.ts` is a monolith mixing service logic, HTTP, MCP, static asset packaging, source mutation, OpenRouter authoring, Smithers run inspection, run control, and CLI startup.
2. `src/smithersProject/*`, `src/runs/smithersGraph.ts`, and `src/ui/*` contain reusable Smithers-first adapters/projections/helpers.
3. `src/mcp/workbenchApp.ts` is a portable MCP App proof, but it duplicates browser UI state/rendering and depends on app-only `ch_*` tool contracts.
4. `web/index.html` is the richest behavioral reference, but it is not yet package-ready component UI: it is same-origin HTTP-oriented, global-state-heavy, and source-path-dependent.
5. `package.json`, `README.md`, `src/cli.ts`, `src/index.ts`, and `src/server.ts` do not yet support real `bunx`/npm-style installation for arbitrary projects.

Qualification: the `ch_*` contracts are not themselves bad; they are appropriate MCP App plumbing. The blocker is that they are not backed by a shared operation client/view-model layer and are not the stable agent-facing Smithers contract.

#### Recommended extraction phases

1. **Define `WorkbenchService` without changing behavior.** Move project setup/discovery, graph render/projection, source get/save, structured source-field save, run start/cancel, Smithers run inspection, workflow creation, and bootstrap summaries behind a transport-neutral class/module. Leave HTTP/MCP responses as wrappers.
2. **Normalize operation contracts.** Define one operation interface consumed by browser and MCP: project, workflows, graph render, source get/save, source-field save, create workflow, start/cancel run, list/detail/events. Implement HTTP and MCP client adapters over the same shapes.
3. **Extract browser behavior from `web/index.html`.** Keep it as the visual/behavioral reference, but move graph state, inspector state, run state, source editing, model selection, and create-workflow flow into package-owned modules. Preserve the existing pure helpers in `src/ui/*` and expand them.
4. **Make MCP App a thin shell.** Keep host-specific MCP Apps behavior in `src/mcp/workbenchApp.ts` (display modes, theme/fonts/style variables, model context), but consume the same shared operation/view-model layer as the browser.
5. **Package for installability.** Add a real `bin`, decide whether to ship TS sources or built JS, add `files`/`exports`, bundle or copy `web` assets, separate package asset root from target `--project`, add `--port`/env support, and document `bunx`/npm usage plus Smithers dependency expectations.
6. **Harden arbitrary-project adapters.** Use the same Smithers command resolver for run start and cancel; clarify render/runtime resolution between target project and installed package; add tests that start the packaged server from an arbitrary temp Smithers project cwd with no CustomHarness source tree present.

## Investigation Log

### Phase 1 - Initial Assessment
**Hypothesis:** The current repo may already contain an adapter boundary analogous to the MCP apps integration, but project workflow UI code may still be coupled to this prototype's server, static HTML, legacy `runs/` compatibility, and Smithers-specific local assumptions.
**Findings:** Created this report and began external/background fact-gathering before context_builder.
**Evidence:** `CONTEXT.md` and `docs/smithers-integration-context.md` establish that CustomHarness should preserve Smithers fidelity until the final UI projection step, use Smithers SQLite/API state as canonical, and treat legacy `runs` JSON as compatibility only.
**Conclusion:** Confirmed enough uncertainty to require full architecture investigation.

### Phase 1.5 - Prior Research
**Hypothesis:** Existing MCP Apps work and sibling projects may provide an extraction pattern.
**Findings:** Repo archaeology identified `22af403` as the key MCP Apps/portable workbench inflection; sibling research identified Poolside Studio PR486's MCP Apps bridge as the strongest technical analog and Spark's extracted design references as a UI-layer extraction analog.
**Evidence:** See `## Background / Prior Research`.
**Conclusion:** The target pattern is service/core extraction plus thin UI/transport adapters, not copying the browser UI into each project.

### Phase 2 - Context Builder Assessment
**Hypothesis:** The repo already contains reusable Smithers adapters but lacks an explicit WorkbenchService seam.
**Findings:** context_builder selected the relevant docs/source/tests and independently summarized the same architecture: `src/smithersProject/*`, `src/runs/smithersGraph.ts`, and `src/ui/*` are reusable; `src/server.ts`, `web/index.html`, MCP App duplication, and package metadata are the main blockers.
**Evidence:** Selection included `src/server.ts`, `web/index.html`, `src/mcp/workbenchApp.ts`, `src/smithersProject/*`, `src/ui/*`, relevant ADRs/plans, tests, `package.json`, and `README.md`.
**Conclusion:** Confirmed; needed pair investigator for line-level evidence.

### Phase 3 - Pair Investigation
**Hypothesis:** File-level evidence would confirm boundary collapse and identify exact extraction seams.
**Findings:** Pair investigator appended detailed findings under `## Investigator Findings`, with line references for reusable modules, monolithic server boundaries, UI/MCP duplication, package metadata gaps, and command/source-editing risks.
**Evidence:** `src/server.ts:66-247`, `src/server.ts:419-939`, `src/server.ts:2044-2261`, `src/server.ts:2352-2388`, `src/server.ts:2772-2815`, `package.json:1-30`, `src/cli.ts:1-31`, `src/mcp/workbenchApp.ts:153-245`, `web/index.html` slices, and reusable Smithers adapter files.
**Conclusion:** Confirmed.

### Phase 4 - Spot Check and Oracle Synthesis
**Hypothesis:** The final answer should distinguish feasibility from current installability.
**Findings:** Manual spot-checks confirmed the pair's load-bearing line references. Oracle synthesis framed the root cause as boundary collapse and recommended extracting a transport-neutral `WorkbenchService`, then making HTTP/MCP/CLI thin adapters with separate asset/project roots.
**Evidence:** Spot-checked the line ranges listed above plus `src/smithersProject/runReader.ts:43-148`, `src/smithersProject/sqliteReadOnly.ts:35-104`, and `src/app/smithersRuntime.ts:118-187`.
**Conclusion:** High feasibility, medium extraction effort; not package-ready as-is.

## Root Cause
The root cause is **boundary collapse**: CustomHarness has good Smithers-first internals, but no transport-neutral product boundary yet.

Evidence:
- `src/server.ts:66-247` is the accidental service layer: it dispatches MCP, workflow authoring, run start/cancel, source-field save, source get/save, project/workflow discovery, OpenRouter models, Smithers run list/detail/events, graph render, and static serving.
- `src/server.ts:419-939` registers app-only MCP `ch_*` tools in the same module as HTTP/static/process concerns; those tools call route/service helper functions rather than a clean service object.
- `src/server.ts:1140-1286` bundles MCP App HTML/CSS/resources from inside the server module, mixing UI resource packaging with backend service behavior.
- `src/server.ts:2772-2815` serves `/web/index.html` and dynamically builds `/src/ui/*.ts` helpers from the runtime root, which assumes the CustomHarness source tree is present. An installable package needs separate `assetRoot` and target `projectRoot`.
- `src/server.ts:2846-2907` is the process entrypoint, uses `PORT`, and parses only `--project`/`--workflow`; this is checkout-runnable but not a package CLI.
- `package.json:1-30` has no `bin`, `main`, `exports`, or `files`; `src/cli.ts:1-31` is help-only and explicitly does not run workflows.
- `web/index.html` is a single-file same-origin reference app with global state, legacy sample paths, dynamic `/src/ui/*.js` imports, `/api/*` calls, and legacy `/runs/*` compatibility paths.
- `src/mcp/workbenchApp.ts:153-245` proves a portable MCP App direction by using `app.callServerTool()` and app-only `ch_*` tools, but it duplicates browser graph/inspector/state logic instead of sharing a view-model/client layer.
- `src/server.ts:2044-2261` source-field save trusts client-provided `sourcePath` and patches `const editable` string values directly; for arbitrary projects, the service should resolve source paths server-side from current `Task.meta.editor` using `{ workflowId, nodeId, field, value, expectedSourceHash? }`.
- `src/server.ts:2352-2388` run cancel hardcodes `bun node_modules/.bin/smithers cancel`, while `src/smithersProject/cli.ts:8-39` has the more portable command-resolution pattern used for run start.

Eliminated hypotheses:
- CustomHarness does **not** need a new workflow model or persisted workflow IR. Existing docs and code correctly keep Workflow Source in `.smithers/*`, Workflow Graph as a projection, and Smithers Run State in `smithers.db`.
- Historical Run Inspection is **not** fundamentally coupled to current Workflow Source; `src/smithersProject/historicalGraph.ts` and ADR-0005 use persisted Smithers Run Frames.
- MCP App portability is **not** blocked by same-origin HTTP inside the app; the app already uses MCP tools. The blocker is that those tools and the browser do not share a clean service/client/view-model boundary.

## Recommendations
1. **Create `src/workbench/service.ts` as the extraction seam.** Move transport-neutral operations from `src/server.ts` into a `WorkbenchService`: project discovery, workflow list, graph render, source get/save, source-field save, run start/cancel, Smithers run list/detail/events, historical graph view, bootstrap summaries, and optional authoring.
2. **Split service internals by concern.** Add `src/workbench/project.ts`, `graph.ts`, `source.ts`, `runs.ts`, and optional `authoring.ts`. Keep `src/smithersProject/*`, `src/runs/smithersGraph.ts`, and `src/ui/*` as reusable dependencies rather than rewriting them.
3. **Make HTTP and MCP thin adapters.** Shrink `src/server.ts` or split to `src/http/server.ts` and `src/mcp/server.ts`; route parsing and MCP registration should call `WorkbenchService` directly, not construct synthetic HTTP requests or route helpers.
4. **Separate package assets from target projects.** Replace the current single `rootDir` concept with `assetRoot` for packaged UI/MCP resources and `projectRoot` for the arbitrary Smithers project.
5. **Package for real installability.** Add a real bin such as `custom-harness-smithers`, package exports, built/bundled browser and MCP assets, `files`, `--port`/`--host` options, and documentation for `bunx`/npm-style use plus Smithers dependency resolution.
6. **Harden source editing.** Replace client-provided `sourcePath` saves with server-resolved `{ workflowId, nodeId, field, value, expectedSourceHash? }`, resolving from current `Task.meta.editor`; add atomic writes and stale-write protection.
7. **Normalize Smithers command resolution.** Add a cancel-command builder near `src/smithersProject/cli.ts` and use the same project-local / workflow-pack-local / `bunx` fallback strategy for start, cancel, and future control commands.
8. **Treat `web/index.html` as the behavioral reference for now.** Do not block service extraction on componentizing it. After the service seam exists, move shared browser/MCP operation types and view-model logic into `src/workbench/client/*` and `src/workbench/viewModel/*`.
9. **Make the MCP App the near-term portable UI surface.** Keep host-specific display/theme/model-context behavior in `src/mcp/workbenchApp.ts`, but back it with the shared service and operation contracts.

## Preventive Measures
- Enforce layering: `src/workbench/*` must not import HTTP, MCP, or `web/*`; adapters may import `src/workbench/*`.
- Add tests that MCP tools do not call HTTP route helpers or construct fake `Request` objects after service extraction.
- Add package-mode integration tests where `assetRoot` is a packaged fixture, `projectRoot` is a temp Smithers project, and `cwd` is unrelated.
- Keep existing Smithers-first tests: project-mode Run Inspection reads Smithers SQLite, historical graphs use persisted Run Frames, no current-source fallback for historical runs, no legacy `/runs/*` truth, and `Task.meta.editor` remains the source-edit bridge.
- Make OpenRouter authoring optional; the core installable UI should work without `OPENROUTER_API_KEY`.
- Document whether Smithers runtime is resolved from the target project, `.smithers/node_modules`, package dependency, or `bunx` fallback, and test those paths.
- Avoid introducing a CustomHarness workflow IR or second run database; preserve Smithers concepts until final UI projection.
