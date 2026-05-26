# Paved Path tools and code-first Smithers primitives

Status: accepted

CustomHarness will expose a small set of named agent-facing **Paved Path** operations for common Smithers workbench jobs, while lower-level Smithers primitives should be available through code-first wrappers or scripts that agents can discover and compose on demand. This keeps the high-value routes obvious without forcing every Smithers primitive into the MCP tool catalog, and it preserves an escape hatch for advanced agents to script Smithers-native operations without round-tripping every intermediate result through model context.

## Consequences

- Paved Paths such as create, understand, change, run, debug, and repair should have concise first-class MCP/CLI entrypoints.
- When a Paved Path has a meaningful side-effect boundary, split the planning step from the write/execute step. For example, workflow creation should have a natural-language Smithers-grounded planning operation before the operation that writes workflow-pack source.
- Workflow planning must be grounded in Smithers concepts and reference material, not generic agent-workflow intuition; a shipped skill/reference bundle should teach agents the Smithers authoring model used by the Paved Paths.
- The Smithers authoring skill/reference bundle should be exposed as an MCP resource so external agents and Paved Path implementations can rely on the same Smithers-grounded guidance.
- The create/change Paved Paths should account for Smithers' scaffolded default workflows before generating new source from scratch. A request may be best served by running a default workflow as-is, tuning its prompts/configuration, forking/copying it into a new workflow, or creating a genuinely new workflow.
- Smithers-native primitives such as workflow discovery, graph rendering, run inspection, event queries, node output reads, approvals, signals, fork, and replay should remain composable behind those Paved Paths.
- If a primitive catalog grows large, prefer progressive disclosure through on-disk code wrappers, generated definitions, or a small discovery surface instead of exposing every primitive as an upfront MCP tool.
- The CustomHarness app-only `ch_*` tools may remain UI plumbing, but they should not define the agent-facing Smithers workbench contract.
