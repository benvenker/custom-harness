# Reflect Smithers first; smooth with overlays

Status: accepted

Poolside Studio should first reflect Smithers' native workflow, component, render, run, fork, and persistence model instead of redesigning those conventions in the product layer. Poolside-specific metadata should smooth the UX with labels, grouping, draft status, layout, warnings, and onboarding, but must not become the source of truth for workflow existence, execution semantics, fork lineage, or run state.

## Consequences

- Smithers owns workflow structure, runtime behavior, run state, forks/branches, prompts, agents, schemas, and reusable components unless we explicitly decide to change Smithers itself.
- Poolside overlays are presentation and workflow-management aids, not implementation details required to run a Smithers workflow.
- Earlier discussion about workflow groups, drafts, detached component instances, branch-tree views, and prompt-edit promotion should be treated as UX/product language over Smithers state or future design artifacts, not as required v1 storage/compilation machinery.
- If a desired UX requires a capability Smithers lacks, the default move is to add or expose that capability in Smithers rather than create a parallel Poolside runtime model.
