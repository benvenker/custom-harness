# Code Context

## Files Retrieved

1. `CONTEXT.md` (lines 1-34, 99-106, 116-129) - repo's claimed Smithers facts and current implementation summary.
2. `docs/plans/alpha-workflow-authoring-and-viewer.md` (lines 25-42, 132-153, 157-179, 181-194) - current alpha workflow/user-flow plan and open verification question.
3. `docs/plans/custom-harness-cli-http-viewer-implementation.md` (lines 67-83, 85-98, 229-233, 298-366) - current detailed CLI/viewer plan, adapter requirement, legacy-artifact policy, render/run contracts.
4. `/Users/ben/code/agents/smithers/code-review/docs/smithersai-smithers.txt` (lines 567-606, 895-927, 1290-1299, 6740-6787, 6927-6934, 7071-7096) - Smithers runtime model, workflow pack layout, CLI command catalog, log location.
5. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/smithers-orchestrator/src/create.js` (lines 197-284) - `createSmithers` cwd/db behavior and DB/table side effects when importing workflows.
6. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/smithers-orchestrator/src/bin/smithers.js` (lines 1-35) - local-bin delegation behavior relevant to `bunx smithers-orchestrator` vs project-local runtime.
7. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/cli/src/workflows.js` (lines 15-116) - actual workflow discovery, ID validation, metadata parsing, scaffold output.
8. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/cli/src/index.js` (lines 50-82, 1449-1523, 1722-1822, 4181-4218, 4518-4589, 4778-4847) - actual CLI load/cwd, `up`, `workflow *`, `graph`, `replay`, `fork` implementations.
9. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/engine/src/engine.js` (lines 1248-1274, 3972-3999, 4938-5050) - root/log path defaults, `renderFrame`, run DB insertion and input persistence.
10. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/engine/src/events.js` (lines 176-205) - NDJSON `stream.ndjson` write implementation.
11. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/db/src/snapshot.js` (lines 55-76, 84-127) - Smithers graph loads persisted input/outputs by run id.
12. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/driver/src/SmithersCtx.js` (lines 38-118) - `SmithersCtx` output accessors and `outputMaybe` semantics.
13. `/Users/ben/code/agents/smithers/code-review/.smithers/node_modules/@smithers-orchestrator/graph/src/types.ts` (lines 3-10, 129-190) - `GraphSnapshot`/XML/task shape.
14. `/Users/ben/code/agents/smithers/code-review/.smithers/workflows/code-review.tsx` (lines 108-179) - concrete state-sensitive Smithers workflow.
15. `/Users/ben/code/agents/smithers/code-review/.smithers/workflows/research-plan-implement.tsx` (lines 35-109) - concrete wrapper/state-sensitive workflow.
16. `src/app/renderWorkflowGraph.ts` (lines 1-79) - current custom-harness render-only implementation.
17. `src/app/runSmithersWorkflow.ts` (lines 1-134, 181-223) - current custom-harness run glue and prompt override behavior.
18. `src/app/smithersRuntime.ts` (lines 1-64) - current in-process runtime/workflow module loading.
19. `src/runs/recorder.ts` (lines 98-174, 271-345) - current legacy `runs/` artifact writer and Smithers graph snapshot adapter.
20. `src/runs/smithersGraph.ts` (lines 1-121, 125-260, 261-368) - current renderer graph mapping/layout semantics.
21. `src/server.ts` (lines 1-112, 120-168, 233-270, 296-360) - current HTTP server endpoints and static serving.
22. `src/cli.ts` (lines 17-73, 76-111, 160-170) - current CLI command surface and env vars.
23. `web/index.html` (lines 1837-2007, 2110-2185) - current browser reads `runs/` JSON and posts to legacy endpoints.
24. `tests/renderWorkflowGraph.test.ts` (lines 15-52) and `tests/runSmithersWorkflow.test.ts` (lines 17-49) - tests documenting current renderer/run artifacts.

## Key Code

### Smithers docs/package facts that validate or correct the plan

Smithers is render/execute/persist/re-render, not a separate static DAG model. `docs/smithersai-smithers.txt` says each render extracts a `GraphSnapshot`, execution persists outputs, and later renders read persisted state (lines 567-606). `GraphSnapshot` itself is just `{ runId, frameNo, xml, tasks }` (`@smithers-orchestrator/graph/src/types.ts` lines 185-190), with task descriptors carrying dependencies, prompt, agent, output table, approval flags, etc. (lines 129-176).

Workflow pack layout claim is accurate: `init` creates `.smithers/workflows`, `.smithers/prompts`, `.smithers/components`, `.smithers/package.json`, `.smithers/agents.ts`, `.smithers/smithers.config.ts`, `.smithers/tickets`, `.smithers/executions`, etc. (`docs/smithersai-smithers.txt` lines 895-927). Implementation also ensures `prompts`, `components`, `workflows`, `tickets`, and `executions` (`workflow-pack.js` lines 2844-2858) and writes `.smithers/.gitignore` ignoring `node_modules/`, `executions/`, `runs/`, `sandboxes/`, `state/`, `tmp/`, `*.db`, `*.sqlite` (`workflow-pack.js` lines 2766-2768).

CLI naming/cwd details:

```js
// @smithers-orchestrator/cli/src/workflows.js lines 15-77
const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function workflowsDir(root) { return join(root, ".smithers", "workflows"); }
export function discoverWorkflows(root) {
  const dir = workflowsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith(".tsx")) ...
}
export function resolveWorkflow(id, root) {
  const workflow = discoverWorkflows(root).find((candidate) => candidate.id === id);
  if (!workflow) throw new SmithersError("RUN_NOT_FOUND", `Workflow not found: ${id}`, { id, root });
  return workflow;
}
```

`workflow run/list/path/create/doctor` all use `process.cwd()` as project root (`@smithers-orchestrator/cli/src/index.js` lines 1722-1822). `up` and `graph` take workflow **file paths**, not IDs; `workflow run <name>` resolves IDs from `.smithers/workflows/<name>.tsx` (`docs/smithersai-smithers.txt` lines 6740-6750, 6927-6934, 7071-7096). Practical command pattern for a Poolside project root is therefore:

```bash
cd /path/to/project
bunx smithers-orchestrator workflow list --format json
bunx smithers-orchestrator workflow path weekly-slack-digest --format json
bunx smithers-orchestrator graph .smithers/workflows/weekly-slack-digest.tsx --input '{...}' --format json
bunx smithers-orchestrator workflow run weekly-slack-digest --input '{...}' --detach --format json
```

`CONTEXT.md` is right that docs prefer `bunx smithers-orchestrator`, not bare `smithers` (`docs/smithersai-smithers.txt` lines 895-905). But the installed package's bin is named `smithers` (`smithers-orchestrator/package.json` lines 33-35), and `src/bin/smithers.js` delegates to `./.smithers/node_modules/.bin/smithers` only when cwd is the **project root** (lines 1-35). I observed `cd /Users/ben/code/agents/smithers/code-review && bunx smithers-orchestrator workflow list --format json` worked and discovered workflows; `cd .../.smithers && bunx smithers-orchestrator workflow list --format json` failed from bunx temp deps in this environment, while `./node_modules/.bin/smithers workflow list` from inside `.smithers` returned `[]` because it looks for `.smithers/workflows` under cwd. Implication: run Smithers CLI from project root, not `.smithers/`, and pass `.smithers/workflows/<id>.tsx` for file-path commands.

`graph` implementation is render-only in the sense of no task execution/run insertion, but not side-effect-free:

```js
// @smithers-orchestrator/cli/src/index.js lines 4189-4218
const resolvedWorkflowPath = resolve(process.cwd(), c.args.workflow);
const workflow = await loadWorkflow(c.args.workflow);
ensureSmithersTables(workflow.db);
const inputRow = c.options.input ? parseJsonInput(...) : inputTable ? ((await loadInput(..., c.options.runId)) ?? {}) : {};
const outputs = await loadOutputs(workflow.db, schema, c.options.runId);
const ctx = new SmithersCtx({ runId: c.options.runId, iteration: 0, input: inputRow ?? {}, outputs });
const snap = await Effect.runPromise(renderFrame(workflow, ctx, { baseRootDir, workflowPath: resolvedWorkflowPath }));
return c.ok(JSON.parse(JSON.stringify(snap, ...)));
```

`createSmithers` opens/creates `./smithers.db` relative to `process.cwd()` by default and creates/migrates schema tables when the workflow module is imported (`smithers-orchestrator/src/create.js` lines 197-284). `graph` also calls `ensureSmithersTables` (line 4194). I observed no new `.smithers/executions` files and `ps` stayed empty after `graph`, but DB/schema/WAL touch is possible. So the plan phrase “no side effects” should be softened: “does not execute tasks and does not insert a Smithers run; may import workflow and ensure/open DB tables.”

Render state sensitivity is real. `SmithersCtx.outputMaybe()` delegates to persisted output snapshot (`SmithersCtx.js` lines 73-107); CLI graph loads input and outputs for `--run-id` before rendering (above). Fresh render defaults to run id `graph` (`docs/smithersai-smithers.txt` lines 6927-6934), so if an old run id named `graph` has outputs, fresh preview can be polluted unless the adapter chooses a known-empty unique run id or supplies empty outputs in-process. Example state-sensitive workflow: `code-review.tsx` first renders `analyze`, then conditionally renders `Approval`/`fix` only if `analysis` exists (lines 108-179). `research-plan-implement.tsx` reads `ctx.outputMaybe("research")`, `ctx.outputMaybe("plan")`, `ctx.outputs.review`, etc. and changes prompts/loop behavior based on prior outputs (lines 35-109).

Run state location: default Smithers logs are under `<rootDir>/.smithers/executions/<runId>/logs/stream.ndjson` (`engine.js` lines 1267-1274; events write `stream.ndjson` at `events.js` lines 184-194). CLI `up` default root is workflow parent dir (`docs` lines 6773-6787; `engine.js` lines 1248-1259), so `up .smithers/workflows/foo.tsx` from project root defaults to rootDir `.smithers/workflows` and log path `.smithers/workflows/.smithers/executions/...` unless `--root /path/to/project` is passed. `workflow run <id>` resolves entryFile then calls the same `executeUpCommand` without setting root; same concern. Alpha runner should pass `--root <projectRoot>` if it wants canonical `<project>/.smithers/executions/...` logs.

DB run state is primary. `runWorkflow` inserts `_smithers_runs` and input rows (`engine.js` lines 4938-5050); `_smithers_nodes`, `_smithers_attempts`, `_smithers_frames`, and `_smithers_events` hold node state, attempt history, frames, and event history (`@smithers-orchestrator/db/src/sql-message-storage.js` lines 13-76 and 205-211); `loadOutputs` reads per-schema tables by `runId` (`snapshot.js` lines 84-127). NDJSON logs are observability, not identity.

Project-mode run inspection should therefore read Smithers SQLite state through a read-only adapter. ADR 0004 records this implementation direction: workflow source remains `.smithers` source files, project-mode run state comes from `smithers.db`, CustomHarness `runs/` JSON is legacy compatibility, and CustomHarness/Studio must not manually mutate Smithers DB rows.

Smithers has native fork/time-travel CLI surfaces: `replay` and `fork` take workflow file path, `--run-id`, `--frame`, optional input overrides/reset nodes/label, and can resume (`@smithers-orchestrator/cli/src/index.js` lines 4518-4589 and 4778-4847). This challenges any alpha reliance on custom `forkedFrom` JSON as long-term fork semantics.

### Current custom-harness implementation reality

Current render-only path:

```ts
// src/app/renderWorkflowGraph.ts lines 24-55
const workflowPath = resolve(process.cwd(), options.workflowPath);
const recorder = createRunRecorder(runId, ...);
const workflow = await loadWorkflow(workflowPath);
const runtime = await loadSmithersRuntime(workflowPath);
const ctx = new runtime.SmithersCtx({ runId, iteration: 0, input, outputs: {}, zodToKeyName: workflow.zodToKeyName });
const frame = await runtime.runPromise(runtime.renderFrame(workflow as never, ctx, { baseRootDir: dirname(workflowPath), workflowPath }));
recorder.writeSmithersPlanSnapshot(frame, ...);
```

This is a fresh/pre-run graph preview with empty outputs, but it writes legacy `runs/<runId>/run.json`, `plan.json`, `events.jsonl`, `artifacts/cli.log` (`renderWorkflowGraph.test.ts` lines 15-52). It does not use Smithers CLI, and does not load persisted run context.

Current run path:

```ts
// src/app/runSmithersWorkflow.ts lines 45-88
const recorder = createRunRecorder(... { runsDir: options.runsDir, forkedFrom });
const rootDir = inferSmithersRootDir(workflowPath); // project root if path contains /.smithers/
const logDir = join(resolve(recorder.runDir), 'smithers', 'executions');
...
const result = await runtime.runPromise(runtime.runWorkflow(workflow as never, {
  input, runId, resume: false, rootDir, logDir, workflowPath, onProgress: ...
}));
```

It uses Smithers `runWorkflow`, but redirects Smithers NDJSON logs to `<custom-harness-run-dir>/smithers/executions/stream.ndjson`, not canonical `.smithers/executions/<runId>/logs/stream.ndjson` (`src/app/runSmithersWorkflow.ts` lines 54-88; test expects `smithers/executions/stream.ndjson`, lines 17-49). It also pre-renders/final-renders with empty outputs (`renderSnapshot`, lines 115-134), so final graph may not reflect conditionally mounted tasks unless they are present without persisted outputs. It wraps workflow build for prompt overrides/fallback agents (`lines 181-223`), which is useful UX sketch but not native Smithers fork/source editing.

Current workflow/runtime loader is in-process and resolves nearest `node_modules/@smithers-orchestrator/engine` from the workflow path (`src/app/smithersRuntime.ts` lines 29-64). It imports workflow modules by file URL (lines 20-27). That can work for `.smithers/node_modules`, but means process cwd still matters for `createSmithers()` default `./smithers.db` unless the workflow uses explicit `dbPath`.

Current recorder is legacy `runs/`-first:

```ts
// src/runs/recorder.ts lines 98-122
const DEFAULT_RUNS_DIR = "runs";
const runsDir = options.runsDir ?? DEFAULT_RUNS_DIR;
const runDir = join(runsDir, runId);
const planPath = join(runDir, "plan.json");
const eventsPath = join(runDir, "events.jsonl");
```

`writeSmithersPlanSnapshot` turns a `GraphSnapshot` into custom `plan.json.graph` and `raw.source.kind='smithers'` (`src/runs/recorder.ts` lines 292-345). The browser depends on these files: it loads `/runs/index.json`, `/runs/<id>/plan.json`, `/runs/<id>/run.json`, `/runs/<id>/events.jsonl` (`web/index.html` lines 1837-2007). It starts runs via `/api/runs` and `/api/smithers-runs`, not project-aware workflow endpoints (`web/index.html` lines 2110-2185; `src/server.ts` lines 49-72, 88-112).

Current graph mapper already gives a useful DAG/card view from Smithers XML/tasks. It lays out tasks/sequence/parallel and preserves approval/branch/loop/worktree host nodes (`src/runs/smithersGraph.ts` lines 73-121, 125-260), then adds descriptor dependency edges (`lines 315-327`). It is a UI adapter, not a runtime IR. This is reusable behind a new adapter without rewriting visual rendering.

Current CLI is minimal legacy: `graph-workflow --workflow <path>` and planner mode (`src/cli.ts` lines 17-73). It exposes `--runs-dir` and `CUSTOM_HARNESS_RUNS_DIR` (`src/cli.ts` lines 30-33, 160-170), contrary to project-mode plan.

## Architecture

Smithers' native architecture: project root cwd + `.smithers/` workflow pack -> workflow TSX imports `createSmithers` -> import opens/creates `smithers.db` relative to cwd unless `dbPath` is configured -> `renderFrame` turns JSX + `SmithersCtx` into `GraphSnapshot` -> `runWorkflow` persists input, `_smithers_runs`, frames/nodes/outputs/events, and NDJSON logs.

Custom-harness architecture today: CLI/server starts in custom-harness repo -> in-process import of arbitrary workflow path -> hand-constructed empty-output `SmithersCtx` for preview -> custom mapper creates `RenderGraph` -> recorder writes `runs/<id>/plan.json` for web UI. Running uses Smithers engine but still routes logs/state presentation through custom `runs/` artifacts in compatibility paths. Browser still has `/runs/*` JSON browsing logic.

The project-mode architecture should reuse existing graph projection code while changing run-state boundaries:

- Keep `src/runs/smithersGraph.ts` as the graph mapper. It already consumes real `GraphSnapshot` and outputs the styled card graph.
- Add a small project/workflow resolver first (`projectRoot`, `smithersDir`, `workflowId -> .smithers/workflows/<id>.tsx`) using Smithers' actual flat rules and metadata parsing. This can be a few functions; no need for a large new folder tree immediately.
- Use Smithers CLI from **project root** for discovery/run. For rendering, CLI `graph` is fine if you accept DB/table touch and choose run id carefully; in-process `renderFrame` with empty outputs remains the cleanest “fresh preview must not use persisted outputs” path, but put it behind the adapter.
- Pass `--root <projectRoot>` when launching runs through `up`/`workflow run` if canonical `.smithers/executions/<runId>/logs` is desired.
- Do not try to make `runs/` canonical. For project-mode run inspection, add a read-only Smithers run-state reader over `smithers.db` and use `runs/` only for legacy compatibility paths.

## Start Here

Start with `src/server.ts` and `web/index.html`: they are the current product boundary. `server.ts` has no `--project/--workflow` parsing and only legacy `/api/runs` + `/api/smithers-runs`; `web/index.html` only knows `/runs/*` JSON. The shortest alpha path is to add project-aware endpoints that return discovered workflows and a `RenderGraph` built from Smithers `GraphSnapshot`, while keeping the existing `smithersGraph.ts` renderer mapper.

## Supervisor coordination

No supervisor decision needed. Practical challenges to the alpha plan:

- “No side effects” for render should mean no task execution and no Smithers run insertion, not no filesystem/DB touch. Workflow import/`graph` can create/open `smithers.db` and ensure tables.
- Run Smithers CLI from project root, not from `.smithers/`. File-path commands need `.smithers/workflows/<id>.tsx`; ID commands are under `workflow *`.
- Use `--root <projectRoot>` on run launch if logs must land under `<project>/.smithers/executions/<runId>/logs/stream.ndjson`.
- Fresh graph preview should avoid persisted outputs. CLI `graph` defaults `--run-id graph` and loads outputs for that id; either pass a unique preview run id known to have no outputs or keep empty-output in-process render behind the adapter.
- Current custom-harness final run render still uses empty outputs, so conditional post-run graph inspection is not Smithers-accurate yet.
- The plan can avoid implementing a full new CLI hierarchy before dogfooding: server `--project --workflow`, workflow discovery, render endpoint, and run endpoint are enough for the alpha loop; CLI list/render/run can follow once server path is proven.
