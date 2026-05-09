# Use editor metadata for source-editable Smithers task fields

Accepted. CustomHarness needs a small metadata convention to map rendered Smithers tasks back to safe edits in Workflow Source, because Smithers `GraphSnapshot` preserves generic `Task.meta` but does not know how arbitrary `.tsx` constants map back to source locations. The convention should be named `Task.meta.editor`, not `Task.meta.studio`, because it is an editor/source-mapping bridge rather than a Studio product feature or Smithers core runtime concept.

## Consequences

- `Task Model` and `Task Prompt` remain real workflow data in Workflow Source.
- `Task.meta.editor.fields` describes which source values the UI may edit and how to edit them.
- Existing prototype-only `Task.meta.studio` fixtures should be migrated or discarded rather than preserved as a compatibility surface.
- The Project Workflow Viewer must not treat editor metadata as canonical run state.
