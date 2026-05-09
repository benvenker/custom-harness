---
name: custom-harness-smithers
description: CustomHarness Smithers-first project rules for workflow rendering, execution, editing, and run inspection. Use for any task touching Smithers workflow source, Smithers SQLite, Run Inspection, Run Frames, RenderGraph projection, or the Project Workflow Viewer.
---

# CustomHarness Smithers Project Rules

Before changing Smithers workflow rendering, execution, editing, run inspection, frame handling, or SQLite integration, read:

- `CONTEXT.md`
- `docs/agents/domain.md`
- `docs/smithers-integration-context.md`
- `/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt`
- `docs/adr/0001-runs-in-smithers-canonical-location.md`
- `docs/adr/0003-reflect-smithers-first-smooth-with-overlays.md`
- `docs/adr/0004-project-mode-run-inspection-reads-smithers-sqlite.md`
- `docs/adr/0005-historical-run-inspection-provenance.md`
- `docs/adr/0006-editor-metadata-for-source-editing.md`

Rules:

- Treat Smithers as foundational third-party infrastructure.
- Do not build a parallel workflow runtime or project-mode run database.
- Workflow definitions live in ordinary Smithers workflow-pack source: `.smithers/workflows/*.tsx`, `.smithers/prompts/*`, `.smithers/components/*`.
- Project-mode run state is Smithers SQLite state in the nearest `smithers.db`; read it through Smithers package APIs/adapters where possible.
- Do not manually mutate `_smithers_*` tables or workflow output tables.
- Keep CustomHarness graph data as a visual projection of Smithers `GraphSnapshot` / persisted Run Frame data, not a persisted workflow IR.
- Treat legacy `runs/` JSON as compatibility-only.

Historical Run Inspection v1:

- Historical run graph source is the selected Run's persisted Smithers Run Frame, not current Workflow Source.
- Current Workflow Source is for previewing, editing, and launching future Runs.
- Missing historical prompt/model/source-facing values should show as unknown/not captured, not be filled from current Workflow Source.
