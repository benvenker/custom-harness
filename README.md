# custom-harness

A local visual workbench for Smithers workflow-pack source and Smithers run state.

```bash
# from this repo, .smithers/ is inferred
pnpm dev

# or target an explicit Smithers workflow-pack project
bun src/server.ts --project /path/to/project --workflow plan-fanout
```

CustomHarness does not own workflow execution or run state. Smithers remains the source of truth for:

- workflow source under `.smithers/workflows/*.tsx`
- workflow graph rendering
- workflow execution
- SQLite-backed runs, frames, events, attempts, and outputs

The browser UI provides a convenient way to preview graphs, edit source-backed `meta.editor` fields, start Smithers runs, and inspect Smithers SQLite state.
