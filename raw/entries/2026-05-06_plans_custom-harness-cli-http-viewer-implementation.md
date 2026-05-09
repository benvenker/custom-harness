---
id: "plans_custom-harness-cli-http-viewer-implementation"
date: "2026-05-06"
time: "12:00:00"
source_type: "markdown"
filepath: "docs/plans/custom-harness-cli-http-viewer-implementation.md"
title: "Custom Harness CLI + local HTTP viewer implementation plan"
category: "plans"
---
# Custom Harness CLI + local HTTP viewer implementation plan

## Decision

Keep the alpha implementation in this repo (`custom-harness`) for now.

Reasons:

- This repo already has a working Smithers graph/render prototype.
- The existing web UI already renders a useful DAG/card view from a Smithers-derived graph shape.
- It can move faster outside Poolside Studio while the UX/product loop is still changing.
- Poolside Studio agents can call a CLI and users can copy-paste a local server command today.
- The code can be structured so the useful core can later move into Poolside Studio or an internal package.

Long-term, this should not remain a separate product boundary. It is an alpha harness for proving the workflow-authoring/viewer loop.

## Goal

Build a CLI-first local viewer that can target any Poolside project root, discover Smithers workflows in that project, render them through Smithers, run them through Smithers, and serve a simple browser UI.

Primary alpha command:

```bash
cd /Users/ben/code/custom-harness
bun src/server.ts --project /path/to/poolside-project --workflow workflow-id
```

Accept environment-variable equivalents for easier agent-generated commands:

```bash
CUSTOM_HARNESS_PROJECT_ROOT=/path/to/poolside-project \
CUSTOM_HARNESS_WORKFLOW_ID=workflow-id \
bun src/server.ts
```

## Non-goals

- Do not build a native Poolside Studio Workflows panel yet.
- Do not build MCP first.
- Do not create a Poolside workflow runtime, IR, or compiler.
- Do not replace Smithers run state with `runs/<runId>/` JSON artifacts.
- Do not solve full prompt-draft/fork UX in this slice.

## Architecture

Introduce a small project-targeting layer that everything else uses.

```txt
src/
  smithersProject/
    paths.ts          # resolve project root, .smithers dir, workflow paths
    discover.ts       # list workflows using Smithers-compatible rules
    adapter.ts        # SmithersAdapter interface and CLI-backed implementation
    graph.ts          # map Smithers adapter render output to RenderGraph
    run.ts            # launch workflow through SmithersAdapter
    types.ts          # ProjectTarget, DiscoveredWorkflow, Render result types
  cli.ts              # add project-aware list/render/run/serve commands
  server.ts           # local HTTP server and static UI
  runs/               # legacy internal compatibility only; not project-mode source of truth
  app/                # existing app helpers; migrate/reuse gradually
web/
  index.html          # initially keep; update to call /api/workflows endpoints
```

The core rule: project-aware functions take `projectRoot` explicitly. Avoid relying on `process.cwd()` except at process startup / CLI parsing boundaries.

### SmithersAdapter boundary

All render, run, and Smithers-readiness behavior must go through a narrow `SmithersAdapter`. The CLI, HTTP server, and UI must not call `renderFrame`, `runWorkflow`, legacy `runSmithersWorkflow`, or legacy run artifact writers directly.

Alpha default:

- Prefer shelling out to the project-local Smithers CLI/runtime using the canonical Smithers command convention: `bunx smithers-orchestrator ...`.
- Verify the exact cwd, command names, flags, and output behavior before implementation.
- In-process `renderFrame` may exist only behind `SmithersAdapter` as a fallback if the project-local CLI is proven insufficient, or as a fake/test seam.

The adapter must expose at least:

- `doctorProject(target)`
- `renderWorkflow({ projectRoot, workflowId, input, mode })`
- `runWorkflow({ projectRoot, workflowId, input })`

The adapter must never synthesize Smithers runs by writing custom-harness JSON files.

## Command surface

Add or revise CLI commands around project roots:

```bash
bun src/index.ts workflows list --project /path/to/project
bun src/index.ts workflows render --project /path/to/project --workflow foo --input '{"prompt":"..."}'
bun src/index.ts workflows run --project /path/to/project --workflow foo --input '{"prompt":"..."}'
bun src/server.ts --project /path/to/project --workflow foo
```

Compatibility aliases are fine internally if faster, but the workflow-authoring skill and help examples should use the canonical `workflows <command>` form.

The workflow-authoring skill only needs the server command at first, but CLI doctor/list/inspect/render/run make the system easier for agents to validate.

### Agent-facing CLI documentation requirements

The CLI is an agent tool surface. Poolside Agent, Hermes, Goose, and local coding agents should be able to discover how to use it from terminal help alone, without reading this plan.

Documentation requirements:

- Every command has `--help`.
- Help text is written for both humans and agents.
- Help examples are copy-pasteable from a fresh terminal.
- Help output states exact inputs, outputs, side effects, and exit codes.
- JSON output exists for agent automation.
- Errors include the failing path/flag and the next command to try.

Required help commands:

```bash
bun src/index.ts --help
bun src/index.ts workflows --help
bun src/index.ts workflows list --help
bun src/index.ts workflows inspect --help
bun src/index.ts workflows render --help
bun src/index.ts workflows run --help
bun src/index.ts workflows doctor --help
bun src/server.ts --help
```

Required global flags:

```txt
--project <path>       Poolside project root containing .smithers/
--json                 Print machine-readable JSON
--pretty               Pretty-print JSON output when --json is used
--quiet                Suppress non-essential logs
--help, -h             Show help
```

Required server flags:

```txt
--project <path>       Poolside project root containing .smithers/
--workflow <id>        Initial Smithers workflow ID to open
--port <number>        Local viewer port, default 4321
--open                 Open the viewer URL after starting the server
--help, -h             Show help
```

Environment variable equivalents:

```txt
CUSTOM_HARNESS_PROJECT_ROOT
CUSTOM_HARNESS_WORKFLOW_ID
CUSTOM_HARNESS_INPUT_JSON
CUSTOM_HARNESS_PORT
```

### Workflow ID validation

Alpha workflow IDs are flat Smithers entrypoint IDs.

Valid ID regex:

`^[a-z0-9][a-z0-9-]*$`

A workflow ID maps exactly to:

`<project>/.smithers/workflows/<workflow-id>.tsx`

Reject:

- path separators `/` or `\`
- extensions such as `.tsx`
- nested paths
- display names such as `Weekly Slack Digest`
- uppercase letters
- underscores
- `.` or `..`

Invalid IDs return:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_WORKFLOW_ID",
    "message": "Workflow ID must match ^[a-z0-9][a-z0-9-]*$.",
    "fix": "Use a flat kebab-case ID such as weekly-slack-digest."
  }
}
```

### CLI JSON and error contract

For every command with `--json`:

- stdout must contain exactly one JSON object.
- stdout must not contain banners, logs, warnings, progress text, or stack traces.
- Human-readable logs/warnings go to stderr.
- `--quiet` suppresses non-essential stderr output.
- Success shape starts with `{ "ok": true, ... }`.
- Failure shape is:

```json
{
  "ok": false,
  "error": {
    "code": "SMITHERS_NOT_SETUP",
    "message": "No .smithers directory found for project.",
    "path": "/path/to/project/.smithers",
    "flag": "--project",
    "fix": "Ask the user before running Smithers setup."
  }
}
```

Stable error codes:

- `INVALID_FLAGS`
- `INVALID_INPUT_JSON`
- `PROJECT_NOT_FOUND`
- `SMITHERS_NOT_SETUP`
- `INVALID_WORKFLOW_ID`
- `WORKFLOW_NOT_FOUND`
- `SMITHERS_RENDER_FAILED`
- `SMITHERS_RUN_FAILED`
- `READINESS_FAILED`
- `PORT_UNAVAILABLE`

Exit codes remain documented, but JSON error codes are the primary agent contract.

### Legacy artifact policy

Legacy `runs/` artifacts are internal compatibility only.

New project-aware workflow commands and HTTP endpoints must not expose `--runs-dir` or `CUSTOM_HARNESS_RUNS_DIR`. If temporary viewer artifacts are still needed internally during the transition, they must be undocumented as a user/agent-facing contract, labeled non-authoritative in logs/debug output, never used to decide whether a Smithers run exists, and replaceable by Smithers DB/log reads.

#### `workflows list`

Purpose: list Smithers workflows discovered in a project.

Example:

```bash
bun src/index.ts workflows list --project /path/to/project --json
```

Agent-facing JSON shape:

```json
{
  "ok": true,
  "projectRoot": "/path/to/project",
  "smithersDir": "/path/to/project/.smithers",
  "workflows": [
    {
      "id": "code-review",
      "displayName": "Code Review",
      "entryFile": "/path/to/project/.smithers/workflows/code-review.tsx",
      "sourceType": "user"
    }
  ]
}
```

Side effects: none.

Exit codes:

- `0` success, even when no workflows exist.
- `2` invalid flags/input.
- `3` project root missing.
- `4` `.smithers/` missing.

#### `workflows inspect`

Purpose: resolve one workflow ID and report its paths/metadata without rendering.

Example:

```bash
bun src/index.ts workflows inspect --project /path/to/project --workflow code-review --json
```

Agent-facing JSON shape:

```json
{
  "ok": true,
  "workflow": {
    "id": "code-review",
    "displayName": "Code Review",
    "entryFile": "/path/to/project/.smithers/workflows/code-review.tsx",
    "sourceType": "user"
  }
}
```

Side effects: none.

#### `workflows render`

Purpose: ask Smithers to render a workflow graph without executing tasks.

Example:

```bash
bun src/index.ts workflows render \
  --project /path/to/project \
  --workflow code-review \
  --input '{"prompt":"Review the current diff"}' \
  --json
```

Agent-facing JSON shape:

```json
{
  "ok": true,
  "workflow": {
    "id": "code-review",
    "displayName": "Code Review",
    "entryFile": "/path/to/project/.smithers/workflows/code-review.tsx"
  },
  "render": {
    "mode": "fresh",
    "createdRun": false,
    "adapter": "smithers-cli",
    "source": {
      "kind": "smithers",
      "workflowFile": "/path/to/project/.smithers/workflows/code-review.tsx"
    }
  },
  "graph": {
    "title": "Code Review",
    "nodes": [],
    "edges": []
  }
}
```

Side effects: should not execute tasks and must not create a Smithers run. Fresh render mode must not invent a run ID. If later support is added for rendering against an existing Smithers run/frame, that is a separate `mode: "run-context"` path and must require an existing Smithers `runId`.

#### `workflows run`

Purpose: launch a real Smithers run for a workflow.

Example:

```bash
bun src/index.ts workflows run \
  --project /path/to/project \
  --workflow code-review \
  --input '{"prompt":"Review the current diff"}' \
  --json
```

Agent-facing JSON shape:

```json
{
  "ok": true,
  "runId": "run-...",
  "status": "running",
  "workflow": { "id": "code-review", "displayName": "Code Review" }
}
```

Side effects: starts a Smithers run and writes Smithers canonical DB/log state. It must not synthesize Smithers runs by writing JSON only.

#### `workflows doctor`

Purpose: diagnose whether the project can be used by the viewer/CLI.

Example:

```bash
bun src/index.ts workflows doctor --project /path/to/project --json
```

Checks:

- project root exists
- `.smithers/` exists
- `.smithers/package.json` exists
- workflow discovery works
- selected workflow exists, if `--workflow` is supplied
- Smithers render command/runtime is available
- project-local Smithers dependencies appear installed

Agent-facing JSON shape:

```json
{
  "ok": false,
  "checks": [
    { "name": "project-root", "ok": true, "path": "/path/to/project" },
    { "name": "smithers-dir", "ok": false, "path": "/path/to/project/.smithers", "fix": "Run Smithers setup before viewing workflows." }
  ]
}
```

Side effects: none.

#### Server help

`bun src/server.ts --help` must show:

- all flags/env vars
- default URL
- copy-paste examples
- API endpoint summary
- reminder that this is an alpha external viewer

The workflow-authoring skill should rely only on documented commands and should prefer commands that work when copy-pasted into a fresh terminal.

### Draft help text

Implement help output close to the following text. Exact wrapping can differ, but the content and examples should be present so agents can run `--help` and know what to do.

#### Top-level help: `bun src/index.ts --help`

```txt
custom-harness — alpha Smithers workflow CLI and local viewer

USAGE
  bun src/index.ts workflows <command> [options]
  bun src/index.ts graph-workflow --workflow <workflow.tsx> [options]   # legacy
  bun src/index.ts --goal "<goal>"                                      # legacy

WORKFLOW COMMANDS
  workflows list       List Smithers workflows in a Poolside project
  workflows inspect    Resolve one workflow ID to its source file and metadata
  workflows render     Render a Smithers workflow graph without executing tasks
  workflows run        Start a real Smithers run for a workflow
  workflows doctor     Diagnose project/.smithers readiness for this viewer

GLOBAL OPTIONS
  --project <path>     Poolside project root containing .smithers/
                       Env: CUSTOM_HARNESS_PROJECT_ROOT
  --json               Print machine-readable JSON for agents
  --pretty             Pretty-print JSON output
  --quiet              Suppress non-essential logs
  --help, -h           Show help

EXAMPLES
  bun src/index.ts workflows list --project /Users/ben/obsidian/vaults/poolside
  bun src/index.ts workflows render --project /Users/ben/obsidian/vaults/poolside --workflow weekly-slack-digest --json
  bun src/index.ts workflows run --project /Users/ben/obsidian/vaults/poolside --workflow weekly-slack-digest --input '{"prompt":"Summarize today"}' --json

NOTES
  Smithers source files and Smithers DB/log state are authoritative.
  Legacy custom-harness artifacts, if any are produced internally, are not Smithers runs.
  Use `bun src/server.ts --help` to launch the local visual viewer.
```

#### Workflows namespace help: `bun src/index.ts workflows --help`

```txt
custom-harness workflows — inspect, render, and run Smithers workflows in a project

USAGE
  bun src/index.ts workflows <command> --project <path> [options]

COMMANDS
  list       List workflows discovered under <project>/.smithers/workflows/*.tsx
  inspect    Show source path and metadata for one workflow ID
  render     Ask Smithers to render a workflow graph without executing tasks
  run        Launch a real Smithers run for a workflow
  doctor     Check whether a project is ready for workflow viewing/running

REQUIRED OPTION
  --project <path>     Poolside project root containing .smithers/
                       Env: CUSTOM_HARNESS_PROJECT_ROOT

COMMON OPTIONS
  --workflow <id>      Smithers workflow ID, e.g. code-review for .smithers/workflows/code-review.tsx
                       Env: CUSTOM_HARNESS_WORKFLOW_ID
  --input <json>       Workflow input JSON object
                       Env: CUSTOM_HARNESS_INPUT_JSON
  --json               Print machine-readable JSON
  --pretty             Pretty-print JSON output
  --quiet              Suppress non-essential logs
  --help, -h           Show help

EXAMPLES
  bun src/index.ts workflows doctor --project /path/to/project
  bun src/index.ts workflows list --project /path/to/project --json
  bun src/index.ts workflows render --project /path/to/project --workflow code-review --input '{"prompt":"Review diff"}'

AUTHORITY MODEL
  This CLI reflects Smithers. It does not define a separate Poolside workflow runtime.
  Workflow existence comes from .smithers/workflows/*.tsx.
  Run state comes from Smithers runtime/DB/logs.
```

#### List help: `bun src/index.ts workflows list --help`

```txt
custom-harness workflows list — list Smithers workflows in a Poolside project

USAGE
  bun src/index.ts workflows list --project <path> [--json] [--pretty]

REQUIRED
  --project <path>     Poolside project root containing .smithers/
                       Env: CUSTOM_HARNESS_PROJECT_ROOT

OPTIONS
  --json               Print machine-readable JSON for agents
  --pretty             Pretty-print JSON output
  --quiet              Suppress non-essential logs
  --help, -h           Show help

WHAT IT READS
  <project>/.smithers/workflows/*.tsx

WHAT IT WRITES
  Nothing.

EXAMPLES
  bun src/index.ts workflows list --project /Users/ben/obsidian/vaults/poolside
  bun src/index.ts workflows list --project /Users/ben/obsidian/vaults/poolside --json --pretty

JSON OUTPUT
  {
    "ok": true,
    "projectRoot": "/path/to/project",
    "smithersDir": "/path/to/project/.smithers",
    "workflows": [
      {
        "id": "code-review",
        "displayName": "Code Review",
        "entryFile": "/path/to/project/.smithers/workflows/code-review.tsx",
        "sourceType": "user"
      }
    ]
  }

EXIT CODES
  0  Listed workflows successfully, including empty lists
  2  Invalid flags or invalid --project value
  3  Project root does not exist
  4  .smithers/ does not exist in the project
```

#### Inspect help: `bun src/index.ts workflows inspect --help`

```txt
custom-harness workflows inspect — resolve one Smithers workflow ID

USAGE
  bun src/index.ts workflows inspect --project <path> --workflow <id> [--json] [--pretty]

REQUIRED
  --project <path>     Poolside project root containing .smithers/
                       Env: CUSTOM_HARNESS_PROJECT_ROOT
  --workflow <id>      Smithers workflow ID, e.g. code-review for .smithers/workflows/code-review.tsx
                       Env: CUSTOM_HARNESS_WORKFLOW_ID

OPTIONS
  --json               Print machine-readable JSON for agents
  --pretty             Pretty-print JSON output
  --quiet              Suppress non-essential logs
  --help, -h           Show help

WHAT IT READS
  <project>/.smithers/workflows/*.tsx
  The selected workflow entrypoint header comments, when present:
    // smithers-display-name: ...
    // smithers-source: ...

WHAT IT WRITES
  Nothing.

EXAMPLES
  bun src/index.ts workflows inspect --project /Users/ben/obsidian/vaults/poolside --workflow weekly-slack-digest
  bun src/index.ts workflows inspect --project /Users/ben/obsidian/vaults/poolside --workflow weekly-slack-digest --json

JSON OUTPUT
  {
    "ok": true,
    "workflow": {
      "id": "weekly-slack-digest",
      "displayName": "Weekly Slack Digest",
      "entryFile": "/path/to/project/.smithers/workflows/weekly-slack-digest.tsx",
      "sourceType": "user"
    }
  }

EXIT CODES
  0  Workflow resolved
  2  Invalid flags or missing --workflow
  3  Project root does not exist
  4  .smithers/ does not exist in the project
  5  Workflow ID not found
```

#### Render help: `bun src/index.ts workflows render --help`

```txt
custom-harness workflows render — render a Smithers workflow graph without running tasks

USAGE
  bun src/index.ts workflows render --project <path> --workflow <id> [--input <json>] [--json] [--pretty]

REQUIRED
  --project <path>     Poolside project root containing .smithers/
                       Env: CUSTOM_HARNESS_PROJECT_ROOT
  --workflow <id>      Smithers workflow ID, e.g. code-review for .smithers/workflows/code-review.tsx
                       Env: CUSTOM_HARNESS_WORKFLOW_ID

OPTIONS
  --input <json>       Workflow input JSON object. Default: {}
                       Env: CUSTOM_HARNESS_INPUT_JSON
  --json               Print machine-readable JSON for agents
  --pretty             Pretty-print JSON output
  --quiet              Suppress non-essential logs
  --help, -h           Show help

WHAT IT READS
  <project>/.smithers/workflows/<workflow>.tsx
  Imported Smithers components/prompts/agents used by that workflow
  Smithers project dependencies under <project>/.smithers/node_modules when required

WHAT IT WRITES
  Nothing.

WHAT IT DOES NOT DO
  It does not execute agents or tasks.
  It does not create a Smithers run.
  It does not mutate workflow source.

EXAMPLES
  bun src/index.ts workflows render --project /Users/ben/obsidian/vaults/poolside --workflow weekly-slack-digest
  bun src/index.ts workflows render --project /Users/ben/obsidian/vaults/poolside --workflow weekly-slack-digest --input '{"prompt":"Summarize today"}' --json --pretty

JSON OUTPUT
  {
    "ok": true,
    "workflow": {
      "id": "weekly-slack-digest",
      "displayName": "Weekly Slack Digest",
      "entryFile": "/path/to/project/.smithers/workflows/weekly-slack-digest.tsx"
    },
    "render": {
      "mode": "fresh",
      "createdRun": false,
      "adapter": "smithers-cli",
      "source": {
        "kind": "smithers",
        "workflowFile": "/path/to/project/.smithers/workflows/weekly-slack-digest.tsx"
      }
    },
    "graph": {
      "title": "Weekly Slack Digest",
      "nodes": [],
      "edges": []
    }
  }

EXIT CODES
  0  Render succeeded
  2  Invalid flags or invalid --input JSON
  3  Project root does not exist
  4  .smithers/ does not exist in the project
  5  Workflow ID not found
  6  Smithers render failed
```

#### Run help: `bun src/index.ts workflows run --help`

```txt
custom-harness workflows run — launch a real Smithers run for a workflow

USAGE
  bun src/index.ts workflows run --project <path> --workflow <id> [--input <json>] [--json] [--pretty]

REQUIRED
  --project <path>     Poolside project root containing .smithers/
                       Env: CUSTOM_HARNESS_PROJECT_ROOT
  --workflow <id>      Smithers workflow ID, e.g. code-review for .smithers/workflows/code-review.tsx
                       Env: CUSTOM_HARNESS_WORKFLOW_ID

OPTIONS
  --input <json>       Workflow input JSON object. Default: {}
                       Env: CUSTOM_HARNESS_INPUT_JSON
  --run-id <id>        Explicit Smithers run ID. Default: generated by Smithers/runtime
  --json               Print machine-readable JSON for agents
  --pretty             Pretty-print JSON output
  --quiet              Suppress non-essential logs
  --help, -h           Show help

WHAT IT READS
  <project>/.smithers/workflows/<workflow>.tsx
  Imported Smithers components/prompts/agents used by that workflow
  Smithers config and dependencies

WHAT IT WRITES
  Smithers canonical run state through Smithers runtime/CLI:
    Smithers SQLite DB state
    Smithers execution logs when logging is enabled
  Internal alpha compatibility artifacts may also be written for the viewer, but they are not public API and are not authoritative Smithers run state.

WHAT IT DOES NOT DO
  It does not create fake Smithers runs by writing JSON files only.
  It does not mutate workflow source.

EXAMPLES
  bun src/index.ts workflows run --project /Users/ben/obsidian/vaults/poolside --workflow weekly-slack-digest --input '{"prompt":"Summarize today"}'
  bun src/index.ts workflows run --project /Users/ben/obsidian/vaults/poolside --workflow weekly-slack-digest --input '{"prompt":"Summarize today"}' --json

JSON OUTPUT
  {
    "ok": true,
    "runId": "run-...",
    "status": "running",
    "workflow": {
      "id": "weekly-slack-digest",
      "displayName": "Weekly Slack Digest"
    }
  }

EXIT CODES
  0  Run started or completed successfully, depending on run mode
  1  Smithers run failed
  2  Invalid flags or invalid --input JSON
  3  Project root does not exist
  4  .smithers/ does not exist in the project
  5  Workflow ID not found
  6  Smithers runtime/CLI failed before producing a run ID
```

#### Doctor help: `bun src/index.ts workflows doctor --help`

```txt
custom-harness workflows doctor — diagnose whether a project is ready for workflow viewing/running

USAGE
  bun src/index.ts workflows doctor --project <path> [--workflow <id>] [--json] [--pretty]

REQUIRED
  --project <path>     Poolside project root to inspect
                       Env: CUSTOM_HARNESS_PROJECT_ROOT

OPTIONS
  --workflow <id>      Optional workflow ID to validate
                       Env: CUSTOM_HARNESS_WORKFLOW_ID
  --json               Print machine-readable JSON for agents
  --pretty             Pretty-print JSON output
  --quiet              Suppress non-essential logs
  --help, -h           Show help

CHECKS
  project-root         Project root exists and is a directory
  smithers-dir         <project>/.smithers exists
  package-json         <project>/.smithers/package.json exists
  node-modules         Smithers dependencies appear installed
  workflows-dir        <project>/.smithers/workflows exists
  workflow-discovery   Workflows can be discovered
  selected-workflow    --workflow exists, if supplied
  render-available     Smithers render/runtime path appears callable

WHAT IT WRITES
  Nothing.

EXAMPLES
  bun src/index.ts workflows doctor --project /Users/ben/obsidian/vaults/poolside
  bun src/index.ts workflows doctor --project /Users/ben/obsidian/vaults/poolside --workflow weekly-slack-digest --json --pretty

JSON OUTPUT
  {
    "ok": false,
    "projectRoot": "/path/to/project",
    "checks": [
      {
        "name": "smithers-dir",
        "ok": false,
        "path": "/path/to/project/.smithers",
        "fix": "Initialize Smithers for this project before viewing workflows."
      }
    ]
  }

EXIT CODES
  0  All required checks passed
  2  Invalid flags
  7  One or more readiness checks failed
```

#### Server help: `bun src/server.ts --help`

```txt
custom-harness viewer — local HTTP viewer for Smithers workflows

USAGE
  bun src/server.ts --project <path> [--workflow <id>] [--port <number>] [--open]

REQUIRED
  --project <path>     Poolside project root containing .smithers/
                       Env: CUSTOM_HARNESS_PROJECT_ROOT

OPTIONS
  --workflow <id>      Workflow to open initially
                       Env: CUSTOM_HARNESS_WORKFLOW_ID
  --port <number>      Local HTTP port. Default: 4321
                       Env: CUSTOM_HARNESS_PORT
  --input <json>       Initial workflow input JSON. Default: {}
                       Env: CUSTOM_HARNESS_INPUT_JSON
  --open               Open the viewer URL in the default browser
  --help, -h           Show help

WHAT IT READS
  <project>/.smithers/workflows/*.tsx
  Smithers files imported by selected workflows
  Smithers run state when run inspection is enabled

WHAT IT WRITES
  The server itself should not create .smithers/ automatically.
  Running a workflow writes Smithers canonical run state through Smithers.
  Internal alpha compatibility artifacts may be written for UI support and must be labeled non-authoritative.

HTTP ENDPOINTS
  GET  /api/project
  GET  /api/workflows
  GET  /api/workflows/:id/graph
  POST /api/workflows/:id/run

OPTIONAL LATER ENDPOINTS
  GET  /api/runs      Only when backed by Smithers canonical state
  GET  /api/runs/:id  Only when backed by Smithers canonical state

EXAMPLES
  bun src/server.ts --project /Users/ben/obsidian/vaults/poolside --workflow weekly-slack-digest
  bun src/server.ts --project /Users/ben/obsidian/vaults/poolside --workflow weekly-slack-digest --port 4321 --open

OPEN
  http://localhost:4321

ALPHA WARNING
  This is an external alpha viewer. It reflects Smithers state. Smithers source files and Smithers DB/log state remain authoritative. Any internal viewer artifacts are non-authoritative.

EXIT CODES
  0  Server exited cleanly
  2  Invalid flags
  3  Project root does not exist
  4  .smithers/ does not exist in the project
  8  Port unavailable or server failed to start
```

## HTTP API surface

Add project-aware API endpoints for the viewer. Required alpha endpoints:

```txt
GET  /api/project
GET  /api/workflows
GET  /api/workflows/:id/graph?input=<json>
POST /api/workflows/:id/run
```

Optional run-inspection endpoints, only after they read Smithers canonical DB/runtime state through `SmithersAdapter`:

```txt
GET  /api/runs
GET  /api/runs/:id
```

In project-aware mode, run endpoints must not be backed by legacy `runs/index.json` as authoritative state. Initial response shapes can be simple, but API errors should use the same `{ ok:false, error:{ code, message, path?, flag?, fix? } }` shape as the CLI where practical.

### `GET /api/project`

```json
{
  "projectRoot": "/path/to/project",
  "smithersDir": "/path/to/project/.smithers",
  "hasSmithers": true,
  "defaultWorkflowId": "foo"
}
```

### `GET /api/workflows`

```json
{
  "workflows": [
    {
      "id": "foo",
      "displayName": "Foo",
      "entryFile": "/path/to/project/.smithers/workflows/foo.tsx",
      "sourceType": "user"
    }
  ]
}
```

Use Smithers-compatible discovery. Current Smithers discovery is flat `.smithers/workflows/<id>.tsx`; reflect that rather than inventing nested identity.

### `GET /api/workflows/:id/graph`

Render selected workflow through Smithers and return the existing `RenderGraph` shape used by `web/index.html`, plus raw Smithers metadata where useful:

```json
{
  "ok": true,
  "workflow": {
    "id": "foo",
    "displayName": "Foo",
    "entryFile": "/path/to/project/.smithers/workflows/foo.tsx"
  },
  "render": {
    "mode": "fresh",
    "createdRun": false,
    "adapter": "smithers-cli",
    "source": {
      "kind": "smithers",
      "workflowFile": "/path/to/project/.smithers/workflows/foo.tsx"
    }
  },
  "graph": { "title": "Foo", "nodes": [], "edges": [] }
}
```

### `POST /api/workflows/:id/run`

Launch a real Smithers run for the selected workflow.

Request:

```json
{
  "input": { "prompt": "Review current diff" }
}
```

Response:

```json
{
  "ok": true,
  "runId": "...",
  "status": "running"
}
```

The implementation must call Smithers runtime/CLI through `SmithersAdapter` rather than synthesize a run. Any internal UI-compatible artifacts are non-authoritative and must not be used to decide whether the Smithers run exists.

## UI behavior

Start with the existing `web/index.html` visual language and make it project-aware.

Required alpha UI:

- Show selected project root.
- Show `.smithers/` missing state with explicit setup guidance, but do not auto-create it.
- List discovered workflows.
- Let user select workflow.
- Render selected workflow as cards/edges from Smithers graph output.
- Provide a simple JSON input textarea.
- Provide **Run workflow** button.
- Show started run ID and basic status.

Nice-to-have after the first loop works:

- Poll run status.
- Show logs link / output snippets.
- List recent Smithers runs from DB rather than legacy `runs/index.json`.
- Show creation spec/doc link if present.

## Agent user stories and behavior tests

These stories define what we want to prove behaviorally. They are intentionally scoped to the CLI + local HTTP viewer alpha and should drive TDD tests before implementation.

### Story 1 — Workflow authoring agent verifies a generated workflow exists

**As** a Poolside workflow-authoring agent  
**I want** to list workflows in the target project after writing files  
**So that** I can confirm the workflow I generated is discoverable before handing commands back to the user.

Acceptance:

- Given a project root with `.smithers/workflows/weekly-slack-digest.tsx`
- When the agent runs:

  ```bash
  bun src/index.ts workflows list --project <project> --json
  ```

- Then the command exits `0`
- And JSON includes `ok: true`
- And `workflows[]` includes `id: "weekly-slack-digest"`
- And the command writes nothing.

TDD target:

- CLI dispatch test with temp project fixture.
- Discovery unit test for flat Smithers workflow files.
- No side-effect assertion: no new files outside expected temp fixture.

### Story 2 — Agent gets actionable setup failure when `.smithers/` is missing

**As** a workflow-authoring agent  
**I want** a clear readiness error when a project has not been set up for Smithers  
**So that** I can ask the user before initializing anything.

Acceptance:

- Given a project root without `.smithers/`
- When the agent runs:

  ```bash
  bun src/index.ts workflows list --project <project> --json
  ```

- Then the command exits with the documented missing-Smithers code
- And JSON includes `ok: false`
- And the error includes the missing `.smithers` path
- And the error suggests explicit setup/initialization
- And the command does not create `.smithers/`.

TDD target:

- CLI error-path test.
- Project-target resolver test.
- Assert `.smithers/` still does not exist after command.

### Story 3 — Agent inspects one workflow before rendering/running it

**As** a workflow-authoring agent  
**I want** to resolve a workflow ID to its source path and metadata  
**So that** I can include exact paths in the handoff message and diagnose typos.

Acceptance:

- Given `.smithers/workflows/code-review.tsx` with optional `smithers-display-name` and `smithers-source` comments
- When the agent runs:

  ```bash
  bun src/index.ts workflows inspect --project <project> --workflow code-review --json
  ```

- Then the command exits `0`
- And JSON includes the absolute `entryFile`
- And JSON includes display/source metadata when present.

TDD target:

- Metadata parsing test.
- Workflow-not-found test with documented exit/error shape.

### Story 4 — Agent renders a workflow without spending model tokens or running tasks

**As** a workflow-authoring agent  
**I want** to render the generated workflow graph without executing it  
**So that** I can catch structural/source errors before asking the user to run it.

Acceptance:

- Given a valid Smithers workflow fixture
- When the agent runs:

  ```bash
  bun src/index.ts workflows render --project <project> --workflow code-review --input '{"prompt":"Review diff"}' --json
  ```

- Then the command exits `0`
- And JSON includes a graph with nodes/edges derived from Smithers render output
- And no task/agent execution occurs
- And no Smithers run is created merely by rendering.
- And JSON includes `render.createdRun: false`.
- And public JSON does not include a fake `runId: "graph"`.

TDD target:

- Render test with fixture agent that would fail if executed.
- Assert returned graph contains expected task IDs.
- Assert `render.createdRun === false`.
- Assert no public `graph.runId` exists.
- Assert no canonical run row or execution log is created by render if test fixture makes that observable.

### Story 5 — Human opens a local viewer with a copy-paste command

**As** Ben dogfooding from Poolside Studio  
**I want** the skill to give me a copyable local viewer command  
**So that** I can paste it into a terminal and immediately inspect the workflow.

Acceptance:

- Given a project root and workflow ID
- When the user runs:

  ```bash
  bun src/server.ts --project <project> --workflow <workflow>
  ```

- Then the server starts on the default port
- And prints the viewer URL
- And `GET /api/project` returns the target project
- And `GET /api/workflows` includes the selected workflow
- And opening `/` loads the static UI.

TDD target:

- Server option parsing test.
- Handler tests for `/api/project` and `/api/workflows`.
- Static file serving regression test.

### Story 6 — Viewer renders selected workflow from API, not legacy run files

**As** a dogfood user  
**I want** the viewer to show a workflow graph before any run exists  
**So that** I can inspect generated workflows without relying on legacy `runs/<id>/plan.json` artifacts.

Acceptance:

- Given a project with a workflow and no legacy run artifacts
- When the viewer loads
- Then it fetches project/workflow APIs
- And renders the selected workflow graph from `/api/workflows/:id/graph`
- And does not require a prior run artifact.

TDD target:

- Browser-light or DOM/unit test if practical.
- At minimum, API test proving graph endpoint works without `runs/`.
- Do not use legacy run loading in the project-aware workflow path.

### Story 7 — Agent launches a real Smithers run through CLI

**As** a workflow-authoring agent  
**I want** to start a workflow run from the CLI  
**So that** I can smoke-test a generated workflow and report the run ID.

Acceptance:

- Given an executable Smithers workflow fixture
- When the agent runs:

  ```bash
  bun src/index.ts workflows run --project <project> --workflow smoke-test --input '{"prompt":"hello"}' --json
  ```

- Then the command calls Smithers runtime/CLI
- And returns `ok: true`, `runId`, and `status`
- And does not synthesize a Smithers run by writing JSON files only.

TDD target:

- Unit test with injectable run adapter/fake Smithers runner verifying CLI dispatch.
- Integration test with a tiny executable Smithers fixture if reliable.
- Assertion that fake JSON-only path is not used for canonical run creation.

### Story 8 — Agent diagnoses readiness before writing or running

**As** a workflow-authoring agent  
**I want** a doctor command with structured checks  
**So that** I can choose the next action without guessing from stack traces.

Acceptance:

- Given a missing project, missing `.smithers`, missing workflow, or missing dependencies
- When the agent runs:

  ```bash
  bun src/index.ts workflows doctor --project <project> --workflow maybe-missing --json
  ```

- Then JSON includes named checks with `ok`, `path`, and `fix` fields where applicable
- And the command writes nothing
- And exit code distinguishes readiness failure from CLI misuse.

TDD target:

- Doctor unit tests for each failure mode.
- JSON schema-ish assertions for check entries.

### Story 9 — Workflow-authoring agent interviews user before generating source

**As** a workflow-authoring agent  
**I want** to interview the user, optionally through generated forms such as `pi-interview`, before writing Smithers files  
**So that** the generated workflow has a clear goal, inputs, DAG shape, agents, outputs, and constraints instead of being a vague one-shot codegen attempt.

Acceptance:

- Given a user asks for a new workflow in a Poolside project chat
- The agent asks clarifying questions until it can state a concrete workflow spec
- If structured input would reduce ambiguity, the agent uses a generated form/interview surface with fields such as:
  - workflow name/display name
  - project root
  - user goal
  - workflow inputs
  - task/DAG outline
  - required tools/connectors/agents
  - expected outputs/artifacts
  - success criteria
  - constraints and non-goals
- The agent shows a final workflow spec and asks for confirmation before writing source
- The agent does not create or mutate `.smithers/` before explicit user confirmation
- The confirmed spec is saved as documentation/provenance and used to generate ordinary Smithers files.

Example form payload for `pi-interview`-style tools:

```json
{
  "title": "Create Smithers workflow",
  "description": "Answer these fields so I can draft a Smithers workflow spec before writing files.",
  "questions": [
    {
      "id": "workflowName",
      "type": "text",
      "question": "What should this workflow be called?",
      "context": "Use a short human name. I will derive a kebab-case Smithers workflow ID."
    },
    {
      "id": "goal",
      "type": "text",
      "question": "What should the workflow accomplish?"
    },
    {
      "id": "inputs",
      "type": "text",
      "question": "What inputs should the workflow accept?",
      "context": "Examples: prompt, date range, channels, repository path, output path."
    },
    {
      "id": "dag",
      "type": "text",
      "question": "What are the major steps or branches in the workflow?",
      "context": "A rough ordered list is fine; mention anything that can run in parallel."
    },
    {
      "id": "outputs",
      "type": "text",
      "question": "What should the workflow produce?",
      "context": "Examples: Markdown digest, JSON findings, changed files, PR summary."
    },
    {
      "id": "constraints",
      "type": "text",
      "question": "Any constraints, approvals, or things this workflow must not do?"
    }
  ]
}
```

TDD target:

- If the workflow-authoring skill becomes repo-owned, add golden tests for:
  - it asks questions/form fields before writing when prompt is under-specified
  - it emits a workflow spec before source
  - it refuses to write before confirmation
  - its final source-generation prompt includes the confirmed spec
- For now, include this as skill acceptance criteria and use manual dogfood transcripts as eval material.

### Story 10 — Workflow-authoring skill hands off exact next steps

**As** the workflow-authoring skill  
**I want** to end with generated paths and a viewer command  
**So that** the user can continue without asking what to run.

Acceptance:

- Given a workflow was created or updated
- The final answer includes:
  - workflow entrypoint path
  - workflow spec path
  - verification commands run and results
  - exact viewer command
  - URL to open after server starts

TDD target:

- This is primarily a skill/test-fixture acceptance check, not core CLI code.
- Later, write a golden-output test for the skill handoff format if the skill becomes repo-owned.

## TDD plan

Before implementation, run the TDD skill against these stories and create tests first.

Recommended first test files:

```txt
tests/workflowId.validation.test.ts
tests/cliJsonContract.test.ts
tests/smithersProject.paths.test.ts
tests/smithersProject.discover.test.ts
tests/smithersAdapter.contract.test.ts
tests/workflowsCli.test.ts
tests/workflowsServer.test.ts
tests/workflowsRender.test.ts
tests/workflowsRun.test.ts
```

Test helpers should create temporary project roots with minimal `.smithers/` structure. Prefer dependency injection for Smithers render/run calls so CLI/server behavior can be tested without slow real agent execution.

## Revised implementation sequence

### Step 1 — Verify Smithers CLI/runtime and define adapter

Acceptance:

- Exact Smithers graph/run/status commands are documented, including cwd and output format.
- `SmithersAdapter` interface exists with a CLI-backed implementation stub and fake test implementation.
- CLI/server code can be tested without real Smithers execution.

Validation command:

```bash
bun test tests/smithersAdapter.contract.test.ts
```

### Step 2 — Project paths, workflow ID validation, and discovery

Acceptance:

- `--project` or `CUSTOM_HARNESS_PROJECT_ROOT` resolves to an absolute project root.
- Missing project root gives a clear error.
- Missing `.smithers/` gives a clear not-set-up response, not an automatic write.
- Workflow IDs match `^[a-z0-9][a-z0-9-]*$` and reject paths/extensions/display names.
- Workflow discovery returns flat Smithers workflows from `<project>/.smithers/workflows/*.tsx`.

Validation command:

```bash
bun test tests/workflowId.validation.test.ts tests/smithersProject.paths.test.ts tests/smithersProject.discover.test.ts
```

### Step 3 — CLI contract for doctor/list/inspect

Acceptance:

- Required help commands exist.
- `--json` stdout contains exactly one JSON object.
- Failures use stable `{ ok:false, error:{ code, message, path?, flag?, fix? } }` shapes.
- Commands write nothing.

Validation command:

```bash
bun test tests/workflowsCli.test.ts tests/cliJsonContract.test.ts
```

### Step 4 — Render through `SmithersAdapter`

Acceptance:

- `workflows render --project <project> --workflow <id>` resolves the workflow entrypoint.
- Rendering asks Smithers through `SmithersAdapter` and returns the current `RenderGraph` shape plus render metadata.
- Rendering does not execute tasks.
- Rendering does not create a Smithers run.
- Public JSON includes `render.createdRun:false` and does not include fake `runId: "graph"`.

Validation command:

```bash
bun test tests/workflowsRender.test.ts
bun src/index.ts workflows render --project tests/fixtures/smithers-project --workflow smoke --json
```

### Step 5 — Local HTTP viewer API

Acceptance:

- `bun src/server.ts --project <project> --workflow <id>` starts the server.
- `GET /api/project` returns project metadata.
- `GET /api/workflows` returns workflows.
- `GET /api/workflows/:id/graph` returns render graph via `SmithersAdapter`.
- Static UI still loads.
- Run-inspection endpoints are omitted or backed by Smithers canonical state, not legacy `runs/index.json`.

Validation command:

```bash
bun test tests/workflowsServer.test.ts
```

### Step 6 — UI consumes workflow APIs instead of legacy run files

Acceptance:

- On load, UI fetches `/api/project` and `/api/workflows`.
- If a default workflow was supplied, it renders that workflow.
- User can switch workflows.
- Project workflow view does not require `runs/index.json`, `run.json`, or `plan.json`.
- Missing `.smithers/` shows setup guidance without creating files.

Validation command:

```bash
bun test tests/web.workflowViewer.test.ts
```

If no DOM test harness exists yet, validate through server API tests plus one manual browser smoke test.

### Step 7 — Run selected workflow through `SmithersAdapter`

Acceptance:

- `workflows run` and `POST /api/workflows/:id/run` call Smithers through `SmithersAdapter`.
- Response includes real `runId` and status.
- No fake Smithers DB rows or JSON-only runs are created.
- Any internal UI artifacts are labeled non-authoritative and are not public contract.

Validation command:

```bash
bun test tests/workflowsRun.test.ts
bun src/index.ts workflows run --project tests/fixtures/smithers-project --workflow smoke --json
```

### Step 8 — Workflow-authoring skill handoff/provenance contract

Acceptance:

- Skill instructions say to interview first and write ordinary Smithers files only after confirmation.
- Saved workflow spec path is `<project>/.smithers/docs/workflows/<workflow-id>.md`.
- Optional creation trace path is `<project>/.poolside/workflows/creation-traces/<workflow-id>/<timestamp>.md`.
- Skill response includes workflow path, spec path, verification command results, exact viewer command, and URL.
- The handoff command works against the generated workflow.

Validation command:

```bash
bun src/index.ts workflows doctor --project <project> --workflow <workflow-id> --json
bun src/index.ts workflows render --project <project> --workflow <workflow-id> --json
bun src/server.ts --project <project> --workflow <workflow-id>
```

## Testing plan

Use Bun tests.

Add fixture helpers that create temporary Smithers project roots:

```txt
/tmp/project/.smithers/package.json
/tmp/project/.smithers/workflows/foo.tsx
```

Tests:

- workflow ID validation
- project root resolution
- missing `.smithers/`
- workflow discovery
- SmithersAdapter contract/fake adapter
- CLI JSON stdout/stderr and error shapes
- render selected workflow with `createdRun:false` and no fake run ID
- server `/api/project`
- server `/api/workflows`
- server `/api/workflows/:id/graph`
- CLI parse/dispatch for `--project` / `--workflow`

Run:

```bash
bun test tests/
bun tsc --noEmit
```

## Risks and mitigations

### Smithers module resolution from external projects

Risk: in-process `loadWorkflow` may resolve dependencies incorrectly if the target project has its own `.smithers/node_modules`.

Mitigation: prefer project-local Smithers CLI for alpha by default. Keep in-process loading only behind `SmithersAdapter` as a fallback/test seam after CLI behavior is verified insufficient for a specific case.

### Current UI depends on `runs/<runId>/plan.json`

Risk: existing UI is tied to legacy artifact files.

Mitigation: new workflow preview path should consume `/api/workflows/:id/graph` directly. Keep legacy run loading only for existing prototype runs outside the project-aware contract until replaced.

### Scope creep into native Poolside Studio integration

Risk: building Electron integration too early slows dogfooding.

Mitigation: keep alpha as copy-paste CLI + local HTTP viewer until the loop is clearly useful.

### Accidental Smithers reimplementation

Risk: adding convenience APIs drifts into separate workflow semantics.

Mitigation: every render/run/fork feature must map to Smithers runtime/CLI/DB concepts. Poolside/custom-harness metadata is only presentation/provenance.

## Verify before implementation

Do not assume these Smithers behaviors from this plan. Verify them against the local Smithers package/docs or command output before implementation:

- Exact command/cwd for rendering an external project workflow.
- Whether `bunx smithers-orchestrator graph <workflow>` supports machine-readable output or needs adapter parsing.
- Whether graph render creates no DB/log run state.
- Exact run command and how to capture `runId`.
- How to query Smithers run status/list/logs canonically.
- How project-local `.smithers/node_modules` resolution works when called from custom-harness.
- Whether Smithers init can safely create `<project>/.smithers/` from project root.
- Exact `GraphSnapshot` fields needed by the UI mapper.