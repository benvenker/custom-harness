# Domain Docs

How engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout

This is a single-context repo.

Read the shared domain docs at the repo root:

- `CONTEXT.md` — canonical language for CustomHarness / Smithers workflow workbench concepts.
- `docs/adr/` — accepted architectural decisions.
- `docs/smithers-integration-context.md` — required for Smithers workflow rendering, execution, run inspection, frame handling, or SQLite integration.

`CONTEXT-MAP.md` is not used in this repo right now.

## Before exploring, read these

For any non-trivial work, read:

1. `CONTEXT.md`
2. ADRs in `docs/adr/` that touch the area you're about to work in

For Smithers-related work, also read:

1. `docs/smithers-integration-context.md`
2. `/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt`
3. relevant installed package source under `node_modules/@smithers-orchestrator/`

If a referenced file is missing in a future checkout, proceed silently and use the available docs.

## Use the glossary's vocabulary

When your output names a domain concept in an issue title, refactor proposal, hypothesis, test name, or UI copy, use the term as defined in `CONTEXT.md`.

Do not drift to synonyms the glossary explicitly avoids. Examples:

- Use **Workflow Source**, not visual graph as source of truth.
- Use **Workflow Graph** for a projection, not a persisted workflow model.
- Use **Run Inspection** for DB-backed run viewing, not legacy `runs/` browsing.
- Use **Smithers Run State** for native SQLite-backed state, not a CustomHarness run DTO.

If the concept you need is not in the glossary yet, note it for `/grill-with-docs` instead of inventing new project language casually.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding it:

> _Contradicts ADR-0005 (historical run inspection uses persisted Smithers run frames) — but worth reopening because…_

## File structure

Current single-context structure:

```txt
/
├── CONTEXT.md
├── docs/
│   ├── smithers-integration-context.md
│   └── adr/
│       ├── 0001-runs-in-smithers-canonical-location.md
│       └── ...
└── src/
```
