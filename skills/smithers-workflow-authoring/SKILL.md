---
name: smithers-workflow-authoring
description: Author, repair, and verify Smithers workflows from natural language using Smithers workflow-pack files and CLI feedback. Use when creating or modifying `.smithers/workflows/*.tsx`, generating Smithers workflow specs, debugging Smithers graph/render/run failures, or turning a user workflow idea into valid Smithers source.
---

# Smithers Workflow Authoring

You are creating ordinary Smithers workflow-pack files, not a new workflow runtime.

## Read before guessing APIs

Project context:

- `CONTEXT.md`
- `docs/adr/0001-runs-in-smithers-canonical-location.md`
- `docs/adr/0002-prototype-before-poolside-studio-port.md`
- `docs/adr/0003-reflect-smithers-first-smooth-with-overlays.md`
- `docs/plans/alpha-workflow-authoring-and-viewer.md`

Smithers docs/source anchors:

- `/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt`
  - lines 567-606: render / execute / persist model
  - lines 895-927: workflow-pack layout
  - lines 6740-6787: `workflow run` / `up` behavior
  - lines 6927-6934: `graph` command
  - lines 7071-7096: workflow create/list/path behavior
- `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/cli/src/workflows.js`
- `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/cli/src/index.js`
- `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/engine/src/engine.js`
- `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/graph/src/types.ts`

Official docs:

- https://smithers.sh/installation
- https://smithers.sh/cli/overview
- https://smithers.sh/cli/quickstart
- https://smithers.sh/runtime/render-frame
- https://smithers.sh/runtime/run-workflow
- https://smithers.sh/how-it-works
- https://smithers.sh/reference/types

## Authoring loop

1. Understand the request. Ask only necessary clarifying questions.
2. Draft and confirm a concise workflow spec before mutating files.
3. Write normal `.smithers/` workflow-pack files.
4. Self-verify with Smithers CLI from the project root.
5. Repair from CLI feedback until graph render succeeds or a real blocker is documented.
6. Save verification/repair trace material.
7. Hand back the CustomHarness viewer command.

Required spec fields:

- workflow ID
- display name
- user goal
- inputs
- major DAG/tasks
- agents/tools needed
- outputs/artifacts
- constraints/non-goals
- open questions

## File creation

Prefer Smithers scaffolding:

```bash
cd <project>
bunx smithers-orchestrator init
bunx smithers-orchestrator workflow create <workflow-id>
```

Then edit ordinary Smithers files, for example:

- `<project>/.smithers/workflows/<workflow-id>.tsx`
- `<project>/.smithers/prompts/*.mdx`
- `<project>/.smithers/components/*.tsx`
- `<project>/.smithers/docs/workflows/<workflow-id>.md`

The workflow spec is documentation/provenance, not runtime state.

## Mandatory self-verification

Run from the Smithers project root, not from `.smithers/`:

```bash
bunx smithers-orchestrator workflow list --format json
bunx smithers-orchestrator workflow path <workflow-id> --format json
bunx smithers-orchestrator graph .smithers/workflows/<workflow-id>.tsx --input '{}' --format json
```

Render verification means no task execution and no Smithers run launch. It may still import workflow code and touch Smithers-owned DB/cache files.

Optional smoke run only when safe/useful:

```bash
bunx smithers-orchestrator workflow run <workflow-id> --input '{}' --detach --format json
```

## Repair loop

For every failed command:

1. Record command, exit code, stdout/stderr excerpt.
2. Read the Smithers error carefully.
3. Inspect generated workflow/component/prompt files.
4. Consult docs/source anchors above.
5. Make the smallest repair.
6. Rerun the failed command.
7. Repeat until render succeeds or document the blocker.

Do not hand back a viewer command unless verification ran, or explicitly say why it could not run.

## Trace and documentation

Write a workflow doc after confirmation:

`<project>/.smithers/docs/workflows/<workflow-id>.md`

Include original request, confirmed spec, files written, verification table, repair attempts, known issues, and viewer command.

Strongly recommended workbench trace:

`<project>/.smithers/workbench/creation-traces/<workflow-id>/<timestamp>.md`

Trace contents:

- original user request
- clarifying Q&A
- confirmed spec
- files written
- every verification command
- exit codes
- useful stdout/stderr excerpts
- repair attempts
- final result
- user feedback / lessons for future skill improvement

This trace is eval/provenance material, not Smithers runtime state.

## Viewer handoff

After CLI verification succeeds, hand back a hot-reloading viewer command by default:

```bash
cd /Users/ben/code/custom-harness
bun --watch src/server.ts --project <project> --workflow <workflow-id>
```

Open `http://localhost:4321` to inspect the graph and launch the workflow through Smithers.

If port 4321 is already busy, pick an explicit port:

```bash
PORT=4322 bun --watch src/server.ts --project <project> --workflow <workflow-id>
```

Use non-watch mode only when the user explicitly wants a stable long-running process:

```bash
bun src/server.ts --project <project> --workflow <workflow-id>
```
