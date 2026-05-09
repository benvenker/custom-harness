# CustomHarness / Smithers Workflow Context

CustomHarness is the prototype repository for a visual workbench around Smithers-backed agentic workflows. Smithers is foundational third-party infrastructure for this project: it owns workflow execution, workflow graph rendering, and canonical SQLite run state. The product/repo name may change, but the domain language should stay close to Smithers' own workflow/run/task/source terms rather than replacing them with a heavy metaphor.

## Language

**CustomHarness**:
The prototype repository and implementation currently used to explore a Smithers workflow workbench.
_Avoid_: Treating CustomHarness as a long-term product/domain name

**Smithers**:
The foundational third-party source-defined agent workflow runtime dependency that renders workflow graphs, executes agent tasks, and persists canonical run state to SQLite.
_Avoid_: Calling the product Smithers, treating Smithers as only a visualization library, assuming CustomHarness can change Smithers upstream

**Agentic Workflow**:
A source-defined sequence/graph of LLM-agent tasks intended to run autonomously while preserving human inspection and intervention points.
_Avoid_: Harness, script, demo graph

**Workflow Source**:
The Smithers workflow-pack files that define an agentic workflow, primarily `.smithers/workflows/*.tsx` plus related prompts/components.
_Avoid_: Visual graph as source of truth, persisted workflow IR

**Workflow Graph**:
A visual projection of a Smithers `GraphSnapshot` used for previewing and inspecting workflow structure.
_Avoid_: Persisted workflow model, canonical DAG database

**Run**:
One Smithers execution of a workflow using a specific input and source/configuration at launch time.
_Avoid_: Sortie as canonical UI term, legacy run folder as project-mode identity

**Smithers Run State**:
The native SQLite-backed Smithers records for a Run, including runs, nodes, attempts, events, frames, outputs, approvals, signals, and snapshots.
_Avoid_: CustomHarness run DTO as canonical state, lossy compatibility model

**Smithers Inspection API**:
A read-only CustomHarness web/API surface that exposes Smithers Run State from the installed Smithers dependency without inventing a second run model.
_Avoid_: Product-owned run database, lossy graph-first endpoint, upstream Smithers feature plan

**Run Frame**:
A persisted Smithers snapshot of a Run's rendered workflow structure at a point in execution.
_Avoid_: Current Workflow Source as historical graph provenance

**Run Inspection**:
A read-only view of a Smithers run using SQLite-backed run, node, attempt, event, frame, and output state.
_Avoid_: Reading project-mode truth from `runs/` JSON

**Run Output**:
The persisted result row(s) produced by a Smithers task and shown to humans as readable text/markdown plus raw JSON when needed.
_Avoid_: Artifact only, stdout only

**Task Model**:
The model used by a Smithers task's agent.
_Avoid_: Viewer model, Studio model

**Task Prompt**:
The prompt or prompt template used by a Smithers task.
_Avoid_: Viewer prompt, temporary override when the source is being edited

**Editor Metadata**:
CustomHarness-owned metadata under Smithers `Task.meta.editor` that maps rendered task data back to editable Workflow Source values.
_Avoid_: Smithers core feature, Studio metadata, viewer data

**Legacy Run Artifacts**:
The old CustomHarness `runs/<runId>/` JSON files kept for compatibility with earlier harness/demo flows.
_Avoid_: Canonical project-mode run state

**Project Workflow Viewer**:
The current browser surface in CustomHarness for rendering, launching, inspecting, and lightly editing one Smithers project workflow.
_Avoid_: Calling it the whole product, project mode as a standalone noun

## Relationships

- **CustomHarness** uses **Smithers** as an external workflow runtime and persistence substrate for project workflows.
- **Workflow Source** renders into a **Workflow Graph**; the graph is a projection, not source of truth.
- A **Run** is created by launching **Workflow Source** with runtime input.
- A **Run** produces **Smithers Run State** in `smithers.db` and may produce optional observability logs.
- A historical **Run Inspection** uses the selected **Run**'s **Run Frame** as its **Workflow Graph** source; current **Workflow Source** is for previewing, editing, and future **Runs**.
- **Smithers Inspection API** reads **Smithers Run State** and may additionally provide UI projections, but those projections are not the primary run representation.
- **Run Output** belongs to a Smithers node/iteration and is displayed by **Run Inspection**.
- **Task Model** and **Task Prompt** are workflow data in **Workflow Source** and affect future **Runs**, not already completed runs.
- Historical **Run Inspection** is read-only; source editing remains an explicit current-source action for future **Runs**, not an inline edit to the selected historical node.
- Historical task prompts, models, labels, and source-facing metadata come only from the inspected **Run**'s persisted Smithers state; missing values should be shown as unknown/not captured, not filled from current **Workflow Source**.
- **Editor Metadata** is a bridge from rendered Smithers tasks back to safe source-editing controls; it is not canonical run state.
- **Legacy Run Artifacts** may remain for compatibility but must not decide project workflow truth.
- CustomHarness adapters should preserve **Smithers Run State** fidelity until the final UI projection step; reducing it early into a CustomHarness-specific interface loses provenance without adding authority.
- The **Smithers Inspection API** is owned by CustomHarness and shaped around the installed Smithers package; it is not a plan to migrate code or concepts upstream into Smithers.

## Example dialogue

> **Dev:** "Can I edit the graph directly and save it as the workflow?"
> **Domain expert:** "Not yet. The Workflow Graph is a projection. Edit Workflow Source or source-backed fields; Smithers remains the runtime source of truth."
>
> **Dev:** "After a refresh, where did my run go?"
> **Domain expert:** "The run is still in Smithers SQLite. Project Workflow Viewer should list it through Run Inspection, not through legacy `runs/` files."
>
> **Dev:** "If I change a model in the inspector, does it change the run I'm looking at?"
> **Domain expert:** "No. Model Configuration is written to Workflow Source and affects future runs; historical Run Inspection stays tied to the run that already happened."

## Flagged ambiguities

- The product/project name remains unresolved. Candidates discussed included Mass Driver, Mech Yard, Foundry, Armory, and others; none should replace canonical workflow terms in the UI yet.
- "Project mode" was used to mean the server flag, the browser state, and the current UI surface. Prefer **Project Workflow Viewer** for the UI and **Run Inspection** for the DB-backed run view.
- "Harness" was used for both legacy CustomHarness execution and Smithers-backed workflows. Reserve **Legacy Run Artifacts** / legacy harness language for old `runs/` compatibility paths; use **Agentic Workflow** for Smithers-backed work.
- "Graph" was used as if it might be a persisted workflow IR. In this context, **Workflow Graph** is only a visual projection of Smithers state.
- Mech/Robotech language may be useful as branding, but should not become canonical developer-facing terminology unless it proves useful through repeated use.
- Resolved direction: historical **Run Inspection** should not overlay Smithers DB state onto the current **Workflow Graph**. It should reconstruct the inspected graph from the selected **Run**'s persisted **Run Frame**, with current-source graph rendering only as a clearly labeled fallback during migration.
- `Task.meta.studio` was rejected as legacy prototype naming during this discussion. **Editor Metadata** now lives under `Task.meta.editor`; no compatibility promise is kept for prototype-only `meta.studio` fixtures.
