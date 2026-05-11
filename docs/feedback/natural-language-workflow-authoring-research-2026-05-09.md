# Natural-language workflow authoring research notes

These notes capture the external/background material used to grill the next CustomHarness feature idea. They are reference material only: no implementation was done while writing this note.

## Sources read

- Smithers post: "Background agents are here. Smithers is ready." — <https://smithers.sh/why/background-agents>
- Inngest post: "Background agents are here. Your orchestration isn't ready." — <https://x.com/djfarrelly/status/2052779234234380479>
- Smithers docs index — <https://smithers.sh/llms.txt>
- Smithers docs: "Why React?" — <https://smithers.sh/why-react>
- Smithers docs: "How It Works" — <https://smithers.sh/how-it-works>
- Smithers docs: `renderFrame` — <https://smithers.sh/runtime/render-frame>
- Smithers docs: `<ReviewLoop>` component — <https://smithers.sh/components/review-loop>
- Prior wrong-layer PR #3 — <https://github.com/benvenker/custom-harness/pull/3>
- Existing repo context/plans/ADRs listed in `AGENTS.md` and the feature prompt.

## Takeaways that should shape the feature

### What is good / worth borrowing

- Natural-language creation should target an authoring surface agents already handle well: ordinary TypeScript/JSX Smithers workflow source, not a bespoke JSON graph DSL.
- The useful stable layer is durable orchestration: steps/tasks, state, retries, parallelism, event/control primitives, and observability. CustomHarness should author against that layer instead of choosing a one-off agent topology.
- Smithers' render → extract → execute → persist → re-render loop makes preview/render verification the correct compiler-like feedback loop for generated workflows.
- `renderFrame`/`graph` can verify a generated workflow graph without executing tasks, and preview `outputs` can simulate upstream completions.
- Smithers components such as `ReviewLoop` demonstrate that named patterns should be compositions over primitives, not a second runtime.
- PR #3 had useful agent-facing ergonomics: JSON output, structured errors, help text, MCP/code-mode ideas, and CLI affordances may be worth revisiting after the Smithers-native source path is established.

### What to avoid / known failure modes

- Do not persist workflow drafts under `runs/drafts/` or make `runs/` part of project-mode workflow authoring.
- Do not create a CustomHarness workflow IR, graph JSON source of truth, or draft database.
- Do not render a CustomHarness graph first and then synthesize source later; Smithers source should be canonical from the start.
- Do not make current source a fallback for historical run provenance. Historical inspection stays frame/SQLite-backed.
- Do not expose arbitrary generated TypeScript as "safe" merely because it exists. Rendering imports workflow code, so generated source needs templates, validation, and render verification.
- Do not conflate sandbox/compute isolation with workflow durability. If sandboxing becomes necessary, it is a verification/execution boundary around Smithers source, not a replacement for Smithers state.
- Do not resurrect `meta.studio`; repo language and tests now prefer `Task.meta.editor` as the CustomHarness source-edit bridge.

## Design-tree questions these notes raise

- Is the first user-facing artifact a **Workflow Draft** directly in `.smithers/workflows/<id>.tsx`, or should the feature avoid the word draft and call it a new **Workflow Source** until/unless a publish state exists?
- How deterministic should v1 be: pure templates, LLM-to-constrained spec plus templates, or arbitrary source synthesis with repair?
- What authoring patterns are in scope first: sequence, parallel fanout+synthesis, review gate, map/reduce, approval, loop?
- Which fields must be source-editable on generated tasks: prompt, model, label, and maybe pattern-specific knobs such as reviewer count or max iterations?
- Where should provenance live: `.smithers/docs/workflows/<id>.md`, `.poolside/workflows/creation-traces/<id>/...`, both, or neither for the first slice?
- What minimum safety boundary is required before importing generated workflow source for render verification?
- Should the UI creation flow exist in the MVP, or should the first slice be CLI/server API only and rely on the existing viewer to open the generated workflow?
