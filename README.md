# custom-harness

A local visual workbench for Smithers workflow-pack source and Smithers run state.

```bash
# from this repo, .smithers/ is inferred
pnpm dev

# or target an explicit Smithers workflow-pack project
bun src/server.ts --project /path/to/project --workflow plan-fanout
```

## MCP server

The same HTTP server exposes a streamable MCP endpoint at `/mcp`.

```bash
# Default: UI at http://localhost:4321 and MCP at http://localhost:4321/mcp
pnpm dev

# If your MCP host/Studio connector is configured for another port:
PORT=4324 pnpm dev
```

Use this connector URL in an MCP host such as Poolside Studio:

```txt
http://localhost:4321/mcp
```

or, when using the alternate port example:

```txt
http://localhost:4324/mcp
```

If a desktop/Electron host reports `fetch failed` with `localhost`, try the loopback address instead:

```txt
http://127.0.0.1:4324/mcp
```

The endpoint provides workflow authoring and workbench tools including:

- `open_workflow_workbench`
- `create_workflow_from_prompt`

App-only helper tools are also exposed for the embedded workbench UI. Natural-language workflow creation requires `OPENROUTER_API_KEY` in the server environment.

Quick health checks:

```bash
curl http://localhost:4321/api/project
curl -i -H 'Accept: text/event-stream, application/json' http://localhost:4321/mcp
```

CustomHarness does not own workflow execution or run state. Smithers remains the source of truth for:

- workflow source under `.smithers/workflows/*.tsx`
- workflow graph rendering
- workflow execution
- SQLite-backed runs, frames, events, attempts, and outputs

The browser UI provides a convenient way to preview graphs, edit source-backed `meta.editor` fields, start Smithers runs, and inspect Smithers SQLite state.
