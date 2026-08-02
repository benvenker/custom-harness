# Alpha Smithers workflow authoring and viewer loop

## Goal

Build the smallest end-to-end dogfood loop for Smithers workflow authoring:

1. A user describes a desired workflow in natural language.
2. A Smithers workflow-authoring skill guides an agent to create or edit valid Smithers workflow-pack files.
3. The agent self-verifies the workflow using Smithers CLI feedback.
4. The user opens a simple CustomHarness viewer to visually inspect the workflow graph.
5. The user can launch the workflow through Smithers.
6. The skill records enough trace/log material to improve future workflow generation.

The alpha is not a new workflow platform. It is a **Smithers-native authoring + verification + visual feedback loop**.

## Product shape

The alpha has two pieces:

1. **A Smithers workflow-authoring skill** — the high-leverage part. It gives any chosen coding agent the Smithers docs, source anchors, authoring procedure, CLI verification loop, and logging habits needed to turn natural language into usable Smithers workflows.
2. **A thin CustomHarness viewer loop** — the visual feedback part. It reuses the existing CustomHarness web UI/graph mapper so a user can open a generated Smithers workflow, inspect the graph, and start a run.

Smithers remains the authority for workflow files, render behavior, run behavior, logs, DB state, approvals, forks, and runtime semantics. CustomHarness only selects a project/workflow, renders a visual graph, and launches a run through Smithers.

## Non-goals

Do not build:

- A native Poolside Studio Workflows panel.
- A new workflow IR, compiler, runtime, or storage model.
- A custom run database.
- A full CLI product around CustomHarness.
- A visual workflow editor.
- Fork, draft, prompt-promotion, or branch-management UX.
- Run history UI beyond showing a started run ID/status.
- Deep Smithers feature-management UI.

Do not frame this as “disabling” Smithers features. Smithers may already support richer behavior through its own CLI/runtime. The alpha viewer simply does not need custom UI for those features yet.

---

## Alpha artifact 1 — Smithers workflow-authoring skill

Create a skill, likely named:

```txt
smithers-workflow-authoring
```

Suggested description:

```md
Author, repair, and verify Smithers workflows from natural language using Smithers workflow-pack files and CLI feedback. Use when creating or modifying `.smithers/workflows/*.tsx`, generating Smithers workflow specs, debugging Smithers graph/render/run failures, or turning a user workflow idea into valid Smithers source.
```

The skill should teach any chosen agent how to:

- Use Smithers vocabulary.
- Read Smithers docs/source before guessing APIs.
- Convert natural language into a short workflow spec.
- Write ordinary `.smithers/` workflow-pack files.
- Run Smithers CLI verification.
- Repair from Smithers CLI errors.
- Hand back viewer commands.
- Save trace/log material for later skill improvement.

### Skill resource pack

The skill should include or link to these resources.

#### Local project context

```txt
CONTEXT.md
docs/adr/0001-runs-in-smithers-canonical-location.md
docs/adr/0002-prototype-before-poolside-studio-port.md
docs/adr/0003-reflect-smithers-first-smooth-with-overlays.md
```

#### Local Smithers docs/source

```txt
/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt
/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smthrs/
/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/smthrs/
```

Important anchors:

```txt
docs/smithersai-smithers.txt:567-606      render/execute/persist model
docs/smithersai-smithers.txt:895-927      workflow pack layout
docs/smithersai-smithers.txt:6740-6787    workflow run / up behavior
docs/smithersai-smithers.txt:6927-6934    graph command
docs/smithersai-smithers.txt:7071-7096    workflow create/list/path behavior
```

Useful source files:

```txt
@smthrs/cli/src/workflows.js
@smthrs/cli/src/index.js
@smthrs/engine/src/engine.js
@smthrs/graph/src/types.ts
```

#### Official docs

```txt
https://smithers.sh/installation
https://smithers.sh/cli/overview
https://smithers.sh/cli/quickstart
https://smithers.sh/runtime/render-frame
https://smithers.sh/runtime/run-workflow
https://smithers.sh/how-it-works
https://smithers.sh/reference/types
```

### Skill workflow

#### Step 1 — Understand the request

The skill should ask only necessary clarifying questions. Avoid long interviews when the request is already concrete.

Required spec fields:

```txt
workflow ID
display name
user goal
inputs
major DAG/tasks
agents/tools needed
outputs/artifacts
constraints/non-goals
open questions
```

If the request is under-specified, ask. If it is clear, draft a spec directly.

#### Step 2 — Confirm before writing

Before writing files, show a concise spec:

```md
## Proposed Smithers workflow

ID: weekly-slack-digest
Goal: Summarize selected Slack messages into a Markdown digest.
Inputs:
- date range
- channel list
Tasks:
1. Collect messages
2. Cluster by topic
3. Draft digest
4. Review / polish
Outputs:
- Markdown digest
Assumptions:
- Slack access/tooling exists or will be provided by the chosen agent.
```

Then ask for confirmation before mutating `.smithers/`.

#### Step 3 — Write normal Smithers files

Prefer Smithers scaffolding:

```bash
cd <project>
bunx smthrs init
bunx smthrs workflow create <workflow-id>
```

Then edit ordinary Smithers files:

```txt
<project>/.smithers/workflows/<workflow-id>.tsx
<project>/.smithers/prompts/*.mdx
<project>/.smithers/components/*.tsx
<project>/.smithers/docs/workflows/<workflow-id>.md
```

The workflow spec is documentation/provenance, not runtime state.

### Agent self-verification loop

The agent must not stop at “files written.” It must use Smithers CLI as the compiler/test-runner feedback loop.

Run from the project root.

#### Required check 1 — discovery

```bash
cd <project>
bunx smthrs workflow list --format json
```

Confirms Smithers discovers the workflow.

#### Required check 2 — path resolution

```bash
cd <project>
bunx smthrs workflow path <workflow-id> --format json
```

Confirms the workflow ID resolves to the intended file.

#### Required check 3 — render/compile feedback

```bash
cd <project>
bunx smthrs graph .smithers/workflows/<workflow-id>.tsx --input '{}' --format json
```

Confirms Smithers can render the graph without executing tasks.

Important nuance: “render verification” means no task execution and no Smithers run launch. It does **not** mean Smithers cannot import workflow code or touch its own DB/cache as part of rendering.

#### Repair loop

If any command fails:

1. Save the command, exit code, and useful stdout/stderr excerpt.
2. Read the Smithers error.
3. Inspect generated workflows/components/prompts.
4. Consult Smithers docs/source anchors.
5. Make the smallest repair.
6. Rerun the failed command.
7. Repeat until render succeeds or there is a real external blocker.

#### Optional smoke run

Only when safe/useful:

```bash
cd <project>
bunx smthrs workflow run <workflow-id> --input '{}' --detach --format json
```

The default verification is graph render. Smoke run is optional because it may spend model/API/tool resources.

#### Handoff rule

The skill should not hand the user a viewer command until Smithers CLI verification has run, unless it explicitly says verification could not be run and why.

### Logging and learning loop

The skill should save enough evidence to improve itself later.

#### Workflow spec

Required after confirmation:

```txt
<project>/.smithers/docs/workflows/<workflow-id>.md
```

Suggested contents:

```md
# <Display Name>

## Original request

...

## Confirmed spec

...

## Files written

...

## Verification

| Command | Exit | Result |
|---|---:|---|
| `bunx smthrs workflow list --format json` | 0 | workflow discovered |
| `bunx smthrs graph ...` | 0 | graph rendered |

## Repair attempts

...

## Known issues / follow-ups

...
```

#### Creation trace

Optional but strongly recommended for alpha dogfood:

```txt
<project>/.poolside/workflows/creation-traces/<workflow-id>/<timestamp>.md
```

Trace should include:

- Poolside/chat context reference if available.
- Agent/session/run ID if available.
- Original user request.
- Clarifying questions and answers.
- Confirmed spec.
- Files written.
- Every verification command.
- Exit codes.
- Useful stdout/stderr excerpts.
- Repair attempts.
- Final result.
- User feedback, including blunt notes such as “this is broken because…”.
- Lessons for future skill improvement.

This trace is not runtime state. It is evaluation material.

---

## Alpha artifact 2 — Thin CustomHarness viewer loop

Use existing CustomHarness UI pieces:

```txt
web/index.html
src/server.ts
src/runs/smithersGraph.ts
```

### Desired command

```bash
cd /Users/ben/code/custom-harness
bun src/server.ts --project /path/to/project --workflow workflow-id
```

### Minimal behavior

- Resolve target project root.
- Discover `.smithers/workflows/*.tsx` workflows.
- Render the selected workflow graph through Smithers/current renderer.
- Reuse the existing graph/card UI.
- Run the selected workflow through Smithers.
- Show run ID/status.

### Minimal API

```txt
GET  /api/project
GET  /api/workflows
GET  /api/workflows/:id/graph
POST /api/workflows/:id/run
```

#### `GET /api/project`

Returns:

```json
{
  "projectRoot": "/path/to/project",
  "smithersDir": "/path/to/project/.smithers",
  "defaultWorkflowId": "weekly-slack-digest"
}
```

If `.smithers/` is missing, return a setup-needed response. Do not create `.smithers/` from a passive viewer request.

#### `GET /api/workflows`

Returns discovered workflows from:

```txt
<project>/.smithers/workflows/*.tsx
```

Use Smithers-compatible flat discovery. Do not invent nested IDs or grouping for alpha.

#### `GET /api/workflows/:id/graph`

Renders the selected workflow and maps it through the existing CustomHarness graph/card mapper.

Implementation can use either:

- the existing in-process `renderFrame` path with empty outputs, or
- Smithers CLI `graph`, once output shape is verified.

Do not overbuild this. The goal is visual inspection.

#### `POST /api/workflows/:id/run`

Launches the selected workflow through Smithers and returns run ID/status.

---

## TDD plan

Use red-green-refactor. Do **not** write all tests first. One behavior, one failing test, smallest implementation, repeat.

Tests should verify public behavior through server endpoints, CLI commands, or skill-generated artifacts. Avoid tests that lock in private helper names or implementation shape.

### Testing principles for this alpha

- **Behavior over structure:** tests should describe what the user/agent can do, not what modules exist.
- **One seam for Smithers:** fake Smithers only at the outer render/run boundary. Do not mock internal CustomHarness graph/layout code when testing viewer output.
- **Hard-to-fake assertions:** assert meaningful fields, not just `status === 200`.
- **No legacy artifact dependency:** project-aware viewer tests should pass without `runs/index.json`, `run.json`, or `plan.json` existing.
- **No accidental setup writes:** passive discovery/render tests must prove they did not create `.smithers/`, `.poolside/`, or legacy `runs/` artifacts.
- **Real Smithers gets one integration slice:** most tests use fakes; one focused integration test proves the real Smithers render path still works.
- **No broad snapshot dumping:** avoid huge snapshots of UI/JSON. Assert important graph IDs, labels, source metadata, and run response fields.

### Test fixtures

Use temporary directories for all project-mode tests. Do not reuse this repo’s real `.smithers/` or `runs/` directories.

Minimal project fixture:

```txt
<tmp>/project-ok/
  .smithers/
    package.json
    workflows/
      foo.tsx
      bar.tsx
      not-a-workflow.md
      bad_name.tsx
      Nested.tsx
```

Expected discovery for the fixture:

```txt
foo
bar
```

Ignored entries:

```txt
not-a-workflow.md
bad_name.tsx
Nested.tsx
```

If implementation chooses to delegate discovery directly to Smithers CLI instead of local flat scanning, align expected behavior with the observed Smithers CLI output. The test should still prove CustomHarness returns the workflows the viewer needs and does not invent nested/custom IDs.

Missing setup fixture:

```txt
<tmp>/project-no-smithers/
  README.md
```

No-side-effect sentinel:

Before each passive endpoint test, record the fixture tree. After the request, assert these paths do not exist unless the fixture created them:

```txt
<project>/.smithers/              # for missing-setup fixture only
<project>/.poolside/
<custom-harness>/runs/
<tmp>/runs/
```

### Fake Smithers renderer contract

Use a fake renderer only to prove CustomHarness calls the render seam and maps the result into viewer JSON.

The fake should return a small Smithers-like graph with at least two task nodes and one dependency. It should include sentinel data that would be lost if the endpoint returned a hand-written placeholder graph.

Example behavior to assert, not exact implementation:

```txt
fake GraphSnapshot contains tasks: collect-input, write-summary
GET /api/workflows/foo/graph returns graph nodes containing collect-input and write-summary
GET /api/workflows/foo/graph returns an edge or dependency relationship between them
GET /api/workflows/foo/graph marks source as Smithers-derived
```

Do not let the test pass if the endpoint returns an empty graph, static fixture, or legacy `runs/<id>/plan.json` data.

### Fake Smithers runner contract

Use a fake runner to prove the run endpoint passes through project root, workflow ID, and input, then returns the Smithers-produced run ID/status.

The fake should fail the test if:

- the workflow ID is not the requested ID,
- the project root is not the temp project root,
- the input body is dropped or replaced,
- the endpoint tries to read legacy `runs/` state before launching.

---

## Red-green slices

### Slice 1 — server accepts project/workflow

RED test:

```txt
Given a temp project with `.smithers/workflows/foo.tsx`
When the server is created/launched with `--project <tmp> --workflow foo`
Then `GET /api/project` returns the absolute project root, Smithers dir, and default workflow ID.
```

Assertions:

- `projectRoot` is absolute.
- `smithersDir` is `<projectRoot>/.smithers`.
- `defaultWorkflowId` is `foo`.
- The response does not mention legacy `runsDir`.

GREEN:

- Add minimal server option parsing / handler context.
- Add `/api/project`.

Validation:

```bash
bun test tests/workflowViewer.project.test.ts
```

Do not proceed to Slice 2 until this passes.

### Slice 2 — missing setup is visible and non-mutating

RED test:

```txt
Given a project directory without `.smithers/`
When `GET /api/project` or `GET /api/workflows` is called
Then the response clearly indicates Smithers setup is needed
And `.smithers/` is still absent after the request.
```

Assertions:

- HTTP response is not a generic 500.
- Response includes the missing path or an equivalent setup-needed signal.
- `.smithers/` was not created.
- `.poolside/` was not created.

GREEN:

- Add missing-Smithers handling.
- Do not call `smthrs init` from passive viewer endpoints.

Validation:

```bash
bun test tests/workflowViewer.project.test.ts
```

### Slice 3 — viewer discovers workflows

RED test:

```txt
Given `.smithers/workflows/foo.tsx` and `.smithers/workflows/bar.tsx`
When `GET /api/workflows` is called
Then response includes `foo` and `bar`.
```

Assertions:

- Workflows include IDs and entry file paths.
- Entry paths point under the temp project, not this repo.
- Non-workflow files are ignored.
- Invalid workflow-looking files are ignored or reported consistently with verified Smithers behavior.
- No legacy run files are required.

GREEN:

- Add flat workflow discovery or delegate to Smithers CLI discovery.

Validation:

```bash
bun test tests/workflowViewer.discovery.test.ts
```

### Slice 4 — graph endpoint uses render seam and graph mapper

RED test:

```txt
Given a fake Smithers renderer returning a tiny GraphSnapshot
When `GET /api/workflows/foo/graph` is called
Then response contains a viewer graph with the fake task IDs and dependency relationship.
```

Assertions:

- Response includes `ok: true` or an equivalent success signal.
- Response includes the selected workflow ID/path.
- Graph nodes include the fake task IDs.
- Graph is not empty.
- Graph source is Smithers-derived.
- No `runs/index.json`, `run.json`, or `plan.json` exists or is read to satisfy the request.

GREEN:

- Wire graph endpoint to an injected renderer.
- Reuse `src/runs/smithersGraph.ts` or equivalent existing graph mapper.

Validation:

```bash
bun test tests/workflowViewer.graph.test.ts
```

### Slice 5 — graph endpoint rejects unknown workflow IDs

RED test:

```txt
Given a project with only `foo.tsx`
When `GET /api/workflows/missing/graph` is called
Then response is a clear not-found error and the renderer is not called.
```

Assertions:

- Unknown workflow does not fall back to the default workflow.
- Unknown workflow does not construct arbitrary paths from unchecked input.
- Renderer call count is zero.

GREEN:

- Resolve workflow ID through discovery/path resolution before rendering.

Validation:

```bash
bun test tests/workflowViewer.graph.test.ts
```

### Slice 6 — real Smithers graph render works once

RED integration test:

```txt
Given a minimal real Smithers workflow fixture
When the real render path renders it
Then Smithers render succeeds and the viewer graph contains expected task/card labels.
```

Assertions:

- Test uses real Smithers render/graph path, not the fake renderer.
- At least one expected task ID appears.
- The render path does not execute task agents.
- The test documents any Smithers-owned DB/cache files that appear during render instead of pretending render is filesystem-pure.

This test may be skipped behind an integration flag if local Smithers dependencies are unavailable, but it must be runnable by a developer before declaring the alpha done.

Validation:

```bash
bun test tests/workflowViewer.graph.integration.test.ts
```

### Slice 7 — run endpoint launches via runner seam

RED test:

```txt
Given a fake Smithers runner returning `run_test_123`
When `POST /api/workflows/foo/run` is called with input JSON
Then response includes `runId: run_test_123`
And the fake runner received project root, workflow ID, and input.
```

Assertions:

- Response status is accepted/successful.
- Response includes run ID and status.
- Input body is passed through.
- Unknown workflow IDs fail before runner invocation.
- Endpoint does not synthesize success by writing a legacy JSON-only run.

GREEN:

- Add run endpoint with injected runner.

Validation:

```bash
bun test tests/workflowViewer.run.test.ts
```

### Slice 8 — real Smithers run command is verified once

RED integration/spike test or documented manual spike:

```txt
Given a minimal safe Smithers workflow
When the real run path launches it
Then Smithers returns a run ID/status and CustomHarness returns that same run ID/status.
```

Assertions:

- Run command is executed from the project root.
- Command shape is documented.
- stdout/stderr/exit code shape is recorded.
- Log location is recorded.

This may start as a manual spike transcript before becoming an automated integration test.

Validation command to spike:

```bash
cd <project>
bunx smthrs workflow run <workflow-id> --input '{}' --detach --format json
```

### Slice 9 — UI consumes project workflow APIs

RED test, if a DOM test harness exists:

```txt
Given API fixtures for project/workflows/graph
When `web/index.html` loads
Then it shows project root, workflow list, selected workflow, and graph cards.
```

Assertions:

- UI does not require `/runs/index.json` to show a project workflow graph.
- UI fetches project/workflow graph endpoints for project mode.
- Empty/missing Smithers state shows setup guidance, not a blank crash.

If no DOM harness exists, do a manual browser smoke test after API tests.

Validation:

```bash
bun test tests/web.workflowViewer.test.ts
```

Manual fallback:

```bash
bun src/server.ts --project <fixture-project> --workflow foo
open http://localhost:4321
```

### Slice 10 — skill trace format

If the Smithers skill is repo-owned, add a lightweight golden test for its logging template.

RED test:

```txt
Given a completed authoring attempt object
When trace markdown is generated
Then it includes original request, confirmed spec, files written, verification commands, exit codes, repair attempts, final status, and viewer command.
```

Assertions:

- Trace includes failed and successful verification attempts.
- Trace includes enough stdout/stderr excerpt to debug without rerunning immediately.
- Trace clearly labels itself as eval/provenance, not runtime state.

GREEN:

- Add a tiny deterministic trace template/helper if useful.
- Do not make this a large subsystem.

---

## Minimal implementation order

1. Write the Smithers workflow-authoring skill draft.
2. Slice 1: `/api/project` with TDD.
3. Slice 2: missing setup behavior with TDD.
4. Slice 3: workflow discovery with TDD.
5. Slice 4: graph endpoint with a fake renderer test.
6. Slice 5: unknown workflow errors with TDD.
7. Slice 6: verify real Smithers graph command/output once.
8. Wire real render path.
9. Slice 7: run endpoint with a fake runner test.
10. Slice 8: verify real Smithers run command/output once.
11. Wire real run path.
12. Slice 9: UI consumes project workflow APIs.
13. Update the skill to emit final viewer command and trace/log instructions.
14. Dogfood on one real workflow request and save the trace.

Do not skip red-green by writing all tests first. Each slice should start with one failing behavior test, then the smallest code change that makes it pass.

---

## Smithers command spike

Before wiring real render/run, verify these once and record results in the plan/trace.

From a Smithers project root:

```bash
bunx smthrs workflow list --format json
bunx smthrs workflow path <workflow-id> --format json
bunx smthrs graph .smithers/workflows/<workflow-id>.tsx --input '{}' --format json
bunx smthrs workflow run <workflow-id> --input '{}' --detach --format json
```

Record:

- Exact stdout shape.
- Stderr behavior.
- Exit code on success/failure.
- Whether commands must run from project root.
- Whether `graph` creates or touches Smithers-owned DB/cache files.
- Where run logs appear.
- Whether `graph` output maps cleanly to existing `src/runs/smithersGraph.ts`.

The spike is not a product feature. It is evidence for the thinnest reliable render/run bridge.

---

## Acceptance criteria

Alpha is done when:

- A Smithers workflow-authoring skill exists and points agents to the right docs/source.
- Given a natural-language request, an agent can produce a confirmed workflow spec.
- After approval, the agent writes ordinary Smithers files.
- The agent self-verifies with Smithers CLI, especially `workflow list`, `workflow path`, and `graph`.
- Failed verification attempts are logged with commands, errors, and repairs.
- The skill returns a copy-paste CustomHarness viewer command.
- CustomHarness opens the target project/workflow.
- The viewer shows the rendered workflow graph without requiring legacy `runs/` artifacts.
- The viewer can launch the workflow through Smithers and show run ID/status.
- Tests cover project selection, missing setup, discovery, graph rendering, run launch, and at least one real Smithers render path.
- No custom workflow semantics or custom run database are introduced.

## Core loop to optimize

```txt
User says what they want
  ↓
Skill-guided agent writes Smithers workflow
  ↓
Agent runs Smithers CLI verification
  ↓
Agent repairs until graph renders
  ↓
Agent logs what happened
  ↓
User opens CustomHarness viewer
  ↓
User visually inspects/runs workflow
  ↓
Feedback improves skill
```
