# Smithers Integration Context

Smithers is foundational third-party infrastructure for CustomHarness. CustomHarness should integrate with Smithers rather than recreate Smithers concepts in a parallel product model.

Primary Smithers reference material currently lives at:

- `/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt`

Read that file, plus the installed package source under `node_modules/@smthrs/`, before changing Smithers workflow rendering, execution, run inspection, frame handling, or SQLite integration. Prefer Smithers package/adapter read APIs when they exist; use centralized read-only SQL only for Smithers state that the installed package does not expose.

## Role of Smithers

Smithers owns:

- Workflow source conventions: `.smithers/workflows/*.tsx`, prompts, components, and Smithers config.
- Workflow rendering: source-defined workflows render to Smithers `GraphSnapshot` / frame data.
- Workflow execution: tasks, agents, approvals, waits, retries, forks/continuations, and output writing run through Smithers runtime/CLI/API surfaces.
- Canonical run state: the nearest `smithers.db` contains `_smithers_runs`, `_smithers_nodes`, `_smithers_attempts`, `_smithers_events`, `_smithers_frames`, output tables, approvals, signals, snapshots, and related state.

CustomHarness owns:

- A browser workbench over Smithers project workflows.
- Read-only HTTP access to Smithers run state for the browser.
- Visual projection of Smithers graph/frame/run state into CustomHarness UI components.
- Source-editing conveniences backed by ordinary Smithers workflow-pack files.
- Compatibility with legacy CustomHarness `runs/` artifacts while the prototype migrates.

## Integration rule

Preserve Smithers concepts and fidelity until the final UI projection step.

Good:

```txt
Smithers SQLite / Smithers package APIs
  -> CustomHarness Smithers Inspection API
  -> Smithers-native-ish run/frame/node/attempt/output JSON
  -> UI projection to RenderGraph
```

Avoid:

```txt
Smithers SQLite
  -> CustomHarness-specific run DTO
  -> lossy graph-first model
  -> attempts to recover Smithers provenance later
```

## API boundary

The CustomHarness Smithers Inspection API is a CustomHarness-owned adapter over the installed Smithers dependency. It is not a plan to migrate code upstream into Smithers.

The API should:

- Be read-only for project-mode run inspection.
- Expose a broad Smithers-state inspection surface rather than a minimal UI-specific DTO; include the relevant Smithers run-state tables and output rows so the UI can decide later what to show.
- Use Smithers vocabulary: run, node, attempt, event, frame, output, approval, signal, snapshot.
- Compute CustomHarness visual graph projections server-side as optional view data, while preserving the Smithers-native-ish inspection data as the primary representation.
- Normalize mechanically where useful for web transport, such as camelCase field names and parsed JSON companions.
- Preserve raw Smithers fields where provenance matters, especially frame `xmlJson`, `encoding`, `taskIndexJson`, mounted task IDs, output table names, and run workflow path/hash.
- Return parsed companions where useful, especially parsed frame `xml` and parsed `taskIndex`, after server-side frame inflation/reconstruction.
- Use Smithers' own adapter/package behavior for frame reconstruction, including delta-encoded frames; do not implement a parallel CustomHarness frame codec unless Smithers' API cannot provide the needed data.
- Prefer installed Smithers adapter/type read surfaces over hand-written SQL. If raw SQL is needed for missing inspection data, centralize it in `src/smithersProject` and keep it read-only.
- Reconstruct historical graphs from the selected run's persisted Smithers frames, not from current workflow source.

The API should not:

- Invent a CustomHarness canonical run database.
- Treat `runs/` JSON artifacts as project-mode truth.
- Collapse frame/task/output data into a graph-only response as the primary run representation.
- Manually mutate `_smithers_*` tables or workflow output tables.

Implementation should land API/reader fidelity first, with focused tests around frame reconstruction, parsed frame XML, task index preservation, broad Smithers table/state mapping, and optional server-side graph projection. UI changes should consume that tested API shape rather than duplicate Smithers interpretation in browser code.

Do not underscope the inspection API merely to avoid mapping work. Broad read-only Smithers DB/API mapping is acceptable when it preserves fidelity and simplifies later UI decisions; LLM coding agents can generate and test the mechanical mapping efficiently.

## Historical run viewing

Historical Run Inspection should use the selected run's latest fully reconstructed persisted Smithers frame as the default graph source, then overlay node/attempt/output/event state from the same run.

Historical task prompts, models, labels, and source-facing metadata come only from the inspected run's persisted Smithers state. If a value was not captured in Smithers run/frame/task state, show it as unknown or not captured; do not silently fill it from current Workflow Source.

Current Workflow Source is for previewing, editing, and future runs. It may be a clearly labeled fallback while implementation is incomplete, but it must not be presented as historical provenance for a completed run. Frame navigation/time-travel is out of scope for the first historical-run implementation.

## Source editing

Workflow Source remains ordinary Smithers workflow-pack source. CustomHarness may use `Task.meta.editor` as a source-editing bridge, but that metadata is CustomHarness-owned and must not be treated as Smithers core state or historical run truth.

Historical Run Inspection is read-only by default. Source editing may remain available as an explicit “edit current workflow source” action for future runs, but node-level edit controls should not appear as if they mutate the selected historical run.
