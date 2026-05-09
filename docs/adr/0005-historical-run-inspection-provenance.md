# Historical run inspection uses persisted Smithers run frames

Accepted. Historical Run Inspection must reconstruct its Workflow Graph from the selected Run's persisted Smithers Run Frame, then overlay node, attempt, output, and event state from that same Run. Current Workflow Source is reserved for previewing, editing, and launching future Runs; it must not be presented as the graph provenance for an already completed Run.

## Decision

- The graph source for historical Run Inspection is the selected Run's persisted Smithers frame data from `_smithers_frames`.
- The default historical view should use the latest fully reconstructed frame for the selected Run.
- The Smithers Inspection API should expose enough frame fidelity to support this, including inflated/parsed frame XML and task index data where available.
- DB-backed run/node/attempt/output/event state remains authoritative for completed run state.
- Current Workflow Source edits affect future Runs, not historical Runs.
- Current Workflow Source may be used only as a temporary, clearly labeled migration fallback when a persisted frame cannot yet be rendered.

## Consequences

- Historical graph labels, task prompts, model/source-facing metadata, and structure should come from the selected Run's persisted Smithers frame/task data, not from the current `.smithers/workflows/*.tsx` file.
- Project-mode run loading should stop overlaying a selected historical run onto `currentWorkflowGraph` as the normal path.
- `SmithersRunReader` / the Smithers Inspection API should preserve Smithers frame fidelity rather than reduce frames to metadata-only summaries.
- Frame navigation/time-travel can be deferred; latest-frame inspection is sufficient for the first historical-run implementation.
- UI provenance should make fallback graph sources visible before relying on historical run views for audits or comparisons.
