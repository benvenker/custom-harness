import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { GraphSnapshot } from "@smithers-orchestrator/graph";
import {
  runOutcome,
  type RunOutcomeOptions,
  type RunOutcomeResult,
} from "./app/runOutcome.js";
import {
  runSmithersWorkflow,
  type RunSmithersWorkflowOptions,
  type RunSmithersWorkflowResult,
} from "./app/runSmithersWorkflow.js";
import { loadSmithersRuntime, loadWorkflow } from "./app/smithersRuntime.js";
import { depsFromEnv } from "./cli.js";
import { planSchema, type PlannerOutput } from "./planning/schema.js";
import { smithersSnapshotToRenderGraph } from "./runs/smithersGraph.js";
import { buildSmithersWorkflowRunCommand } from "./smithersProject/cli.js";
import { addHistoricalRunView } from "./smithersProject/historicalGraph.js";
import { createSmithersRunReader as defaultCreateSmithersRunReader } from "./smithersProject/runReader.js";
import type {
  GetRunDetailOptions,
  ListEventsOptions,
  ListRunsOptions,
  SmithersRunReader,
} from "./smithersProject/runReaderTypes.js";

type RunOutcomeFn = (options: RunOutcomeOptions) => Promise<RunOutcomeResult>;
type RunSmithersWorkflowFn = (
  options: RunSmithersWorkflowOptions
) => Promise<RunSmithersWorkflowResult>;
type RenderProjectWorkflowGraphFn = (options: {
  projectRoot: string;
  workflowId: string;
  workflowPath: string;
  input?: Record<string, unknown>;
  outputs?: Record<string, unknown[]>;
}) => Promise<GraphSnapshot>;
type RunProjectWorkflowFn = (options: {
  projectRoot: string;
  workflowId: string;
  workflowPath: string;
  input: Record<string, unknown>;
}) => Promise<{ runId: string; status: string }>;

type CreateSmithersRunReaderFn = (options: {
  projectRoot: string;
}) => SmithersRunReader | Promise<SmithersRunReader>;

export type HarnessServerOptions = {
  rootDir?: string;
  runsDir?: string;
  projectRoot?: string;
  workflowId?: string;
  runOutcome?: RunOutcomeFn;
  runSmithersWorkflow?: RunSmithersWorkflowFn;
  renderProjectWorkflowGraph?: RenderProjectWorkflowGraphFn;
  runProjectWorkflow?: RunProjectWorkflowFn;
  createSmithersRunReader?: CreateSmithersRunReaderFn;
};

type RunJson = {
  id: string;
  goal: string;
};

type PlanJson = {
  raw: unknown;
};

type SmithersGraphExportPlan = {
  path?: unknown;
  reason?: unknown;
  source: {
    kind: "smithers";
    workflowPath: string;
    input: Record<string, unknown>;
    context?: string;
    promptOverrides?: Record<string, string>;
  };
};

export function createHarnessServerHandler(options: HarnessServerOptions = {}) {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const runsDir =
    options.runsDir ?? process.env.CUSTOM_HARNESS_RUNS_DIR ?? "runs";
  const projectRoot = options.projectRoot
    ? resolve(options.projectRoot)
    : undefined;
  const defaultWorkflowId = options.workflowId;
  const runOutcomeFn = options.runOutcome ?? runOutcome;
  const runSmithersWorkflowFn =
    options.runSmithersWorkflow ?? runSmithersWorkflow;
  const renderProjectWorkflowGraphFn =
    options.renderProjectWorkflowGraph ?? renderProjectWorkflowGraph;
  const runProjectWorkflowFn = options.runProjectWorkflow ?? runProjectWorkflow;
  const createSmithersRunReaderFn =
    options.createSmithersRunReader ?? defaultCreateSmithersRunReader;

  return async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") return json({ ok: true });

      const rerunMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/rerun$/);
      if (request.method === "POST" && rerunMatch) {
        return await rerunRun({
          runId: decodeURIComponent(rerunMatch[1]),
          request,
          runsDir,
          runOutcome: runOutcomeFn,
          runSmithersWorkflow: runSmithersWorkflowFn,
        });
      }

      if (request.method === "POST" && url.pathname === "/api/smithers-runs") {
        return await startSmithersRun({
          request,
          runsDir,
          runSmithersWorkflow: runSmithersWorkflowFn,
        });
      }

      if (request.method === "POST" && url.pathname === "/api/runs") {
        return await startRun({ request, runsDir, runOutcome: runOutcomeFn });
      }

      const workflowRunCancelMatch = url.pathname.match(
        /^\/api\/workflows\/([^/]+)\/runs\/([^/]+)\/cancel$/
      );
      if (request.method === "POST" && workflowRunCancelMatch) {
        return await workflowRunCancelResponse({
          projectRoot,
          workflowId: decodeURIComponent(workflowRunCancelMatch[1]),
          runId: decodeURIComponent(workflowRunCancelMatch[2]),
        });
      }

      const workflowRunMatch = url.pathname.match(
        /^\/api\/workflows\/([^/]+)\/run$/
      );
      if (request.method === "POST" && workflowRunMatch) {
        return await workflowRunResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          workflowId: decodeURIComponent(workflowRunMatch[1]),
          runProjectWorkflow: runProjectWorkflowFn,
        });
      }

      const workflowSourceFieldMatch = url.pathname.match(
        /^\/api\/workflows\/([^/]+)\/source-field$/
      );
      if (request.method === "PUT" && workflowSourceFieldMatch) {
        return await workflowSourceFieldResponse({
          request,
          projectRoot,
          workflowId: decodeURIComponent(workflowSourceFieldMatch[1]),
        });
      }

      const workflowSourceMatch = url.pathname.match(
        /^\/api\/workflows\/([^/]+)\/source$/
      );
      if (request.method === "PUT" && workflowSourceMatch) {
        return await workflowSourceResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          workflowId: decodeURIComponent(workflowSourceMatch[1]),
          write: true,
        });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }

      if (url.pathname === "/api/project") {
        return json(projectResponse({ projectRoot, defaultWorkflowId }));
      }

      if (url.pathname === "/api/workflows") {
        return json(workflowsResponse({ projectRoot, defaultWorkflowId }));
      }

      if (url.pathname === "/api/openrouter/models") {
        return await openRouterModelsResponse();
      }

      if (url.pathname === "/api/smithers/runs") {
        return await smithersRunsListResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          createSmithersRunReader: createSmithersRunReaderFn,
        });
      }

      const smithersRunEventsMatch = url.pathname.match(
        /^\/api\/smithers\/runs\/([^/]+)\/events$/
      );
      if (smithersRunEventsMatch) {
        return await smithersRunEventsResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          runId: decodeURIComponent(smithersRunEventsMatch[1]),
          createSmithersRunReader: createSmithersRunReaderFn,
        });
      }

      const smithersRunDetailMatch = url.pathname.match(
        /^\/api\/smithers\/runs\/([^/]+)$/
      );
      if (smithersRunDetailMatch) {
        return await smithersRunDetailResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          runId: decodeURIComponent(smithersRunDetailMatch[1]),
          createSmithersRunReader: createSmithersRunReaderFn,
        });
      }

      const graphMatch = url.pathname.match(
        /^\/api\/workflows\/([^/]+)\/graph$/
      );
      if (graphMatch) {
        return await workflowGraphResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          workflowId: decodeURIComponent(graphMatch[1]),
          renderProjectWorkflowGraph: renderProjectWorkflowGraphFn,
        });
      }

      const sourceMatch = url.pathname.match(
        /^\/api\/workflows\/([^/]+)\/source$/
      );
      if (sourceMatch) {
        return await workflowSourceResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          workflowId: decodeURIComponent(sourceMatch[1]),
          write: false,
        });
      }

      if (url.pathname === "/favicon.ico")
        return new Response(null, { status: 204 });
      return staticFileResponse(rootDir, url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof RequestValidationError ? 400 : 500;
      return json({ ok: false, error: message }, status);
    }
  };
}

async function startSmithersRun(args: {
  request: Request;
  runsDir: string;
  runSmithersWorkflow: RunSmithersWorkflowFn;
}) {
  const body = await readJsonBody(args.request);
  if (
    typeof body.workflowPath !== "string" ||
    body.workflowPath.trim() === ""
  ) {
    return json({ ok: false, error: "Missing workflowPath" }, 400);
  }
  if (!isRecord(body.input)) {
    return json({ ok: false, error: "Missing input" }, 400);
  }

  const runId =
    typeof body.runId === "string" ? body.runId : crypto.randomUUID();
  const promptOverrides = parsePromptOverrides(body.promptOverrides);
  launchSmithersRun(args.runSmithersWorkflow, {
    workflowPath: body.workflowPath,
    input: body.input,
    goal:
      typeof body.goal === "string" && body.goal.trim() ? body.goal : undefined,
    context: typeof body.context === "string" ? body.context : undefined,
    ...(promptOverrides === undefined ? {} : { promptOverrides }),
    runId,
    runsDir: args.runsDir,
  });
  return json(
    {
      ok: true,
      runId,
      status: "running",
      path: "workflow",
    },
    202
  );
}

async function rerunRun(args: {
  runId: string;
  request: Request;
  runsDir: string;
  runOutcome: RunOutcomeFn;
  runSmithersWorkflow: RunSmithersWorkflowFn;
}) {
  const body = await readJsonBody(args.request);
  const existing = readExistingRun(args.runsDir, args.runId);
  const runId =
    typeof body.runId === "string" ? body.runId : crypto.randomUUID();
  const promptOverrides = parsePromptOverrides(body.promptOverrides);
  if (isSmithersGraphExportPlan(existing.rawPlan)) {
    const context =
      typeof body.context === "string"
        ? body.context
        : existing.rawPlan.source.context;
    const inheritedOverrides = existing.rawPlan.source.promptOverrides;
    const mergedOverrides = mergeOverrides(inheritedOverrides, promptOverrides);
    launchSmithersRun(args.runSmithersWorkflow, {
      workflowPath: existing.rawPlan.source.workflowPath,
      input: existing.rawPlan.source.input,
      goal: existing.run.goal,
      ...(context === undefined ? {} : { context }),
      ...(mergedOverrides === undefined
        ? {}
        : { promptOverrides: mergedOverrides }),
      forkedFrom: args.runId,
      runId,
      runsDir: args.runsDir,
    });
    return json(
      {
        ok: true,
        runId,
        status: "running",
        path: "workflow",
        forkedFrom: args.runId,
      },
      202
    );
  }

  if (promptOverrides !== undefined) {
    return json(
      {
        ok: false,
        error: "promptOverrides are only supported for Smithers workflow runs",
      },
      400
    );
  }
  const plan = planSchema.parse(existing.rawPlan);
  launchRun(args.runOutcome, {
    goal: existing.run.goal,
    context: typeof body.context === "string" ? body.context : undefined,
    planner: () => plan,
    executorAgent: depsFromEnv().executorAgent,
    runId,
    runsDir: args.runsDir,
  });
  return json(
    {
      ok: true,
      runId,
      status: "running",
      path: plan.path,
    },
    202
  );
}

function parsePromptOverrides(
  value: unknown
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value))
    throw new RequestValidationError(
      "promptOverrides must be a JSON object of string-to-string values"
    );
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string")
      throw new RequestValidationError(
        `promptOverrides[${key}] must be a string`
      );
    if (!key.trim()) continue;
    if (raw.trim()) out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeOverrides(
  inherited: Record<string, string> | undefined,
  next: Record<string, string> | undefined
) {
  if (!inherited && !next) return undefined;
  const merged = { ...(inherited ?? {}), ...(next ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function startRun(args: {
  request: Request;
  runsDir: string;
  runOutcome: RunOutcomeFn;
}) {
  const body = await readJsonBody(args.request);
  if (typeof body.goal !== "string" || body.goal.trim() === "") {
    return json({ ok: false, error: "Missing goal" }, 400);
  }

  const envDeps = depsFromEnv();
  const plan = body.plan === undefined ? null : planSchema.parse(body.plan);
  const runId =
    typeof body.runId === "string"
      ? body.runId
      : (envDeps.runId ?? crypto.randomUUID());
  launchRun(args.runOutcome, {
    goal: body.goal,
    context: typeof body.context === "string" ? body.context : undefined,
    planner: plan ? () => plan : envDeps.planner,
    executorAgent: envDeps.executorAgent,
    runId,
    runsDir: args.runsDir,
  });
  return json(
    {
      ok: true,
      runId,
      status: "running",
      path: plan?.path,
    },
    202
  );
}

function launchRun(runOutcomeFn: RunOutcomeFn, options: RunOutcomeOptions) {
  void runOutcomeFn(options).catch((error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(
      `background run failed before recorder could finish: ${message}`
    );
  });
}

function launchSmithersRun(
  runSmithersWorkflowFn: RunSmithersWorkflowFn,
  options: RunSmithersWorkflowOptions
) {
  void runSmithersWorkflowFn(options).catch((error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(
      `background Smithers workflow rerun failed before recorder could finish: ${message}`
    );
  });
}

function readExistingRun(
  runsDir: string,
  runId: string
): { run: RunJson; rawPlan: unknown } {
  const safeRunId = safeSegment(runId);
  const runDir = join(runsDir, safeRunId);
  const runPath = join(runDir, "run.json");
  const planPath = join(runDir, "plan.json");
  if (!existsSync(runPath)) throw new Error(`Run not found: ${runId}`);
  if (!existsSync(planPath)) throw new Error(`Run has no plan.json: ${runId}`);

  const run = JSON.parse(readFileSync(runPath, "utf8")) as RunJson;
  const planJson = JSON.parse(readFileSync(planPath, "utf8")) as PlanJson;
  if (typeof run.goal !== "string" || run.goal.trim() === "")
    throw new Error(`Run has no goal: ${runId}`);
  return { run, rawPlan: planJson.raw };
}

function isSmithersGraphExportPlan(
  value: unknown
): value is SmithersGraphExportPlan {
  if (!value || typeof value !== "object") return false;
  const source = (value as { source?: unknown }).source;
  if (!source || typeof source !== "object") return false;
  const maybeSource = source as Record<string, unknown>;
  if (
    maybeSource.kind !== "smithers" ||
    typeof maybeSource.workflowPath !== "string" ||
    !isRecord(maybeSource.input) ||
    (maybeSource.context !== undefined &&
      typeof maybeSource.context !== "string")
  ) {
    return false;
  }
  const overrides = maybeSource.promptOverrides;
  if (overrides !== undefined) {
    if (!isRecord(overrides)) return false;
    for (const v of Object.values(overrides)) {
      if (typeof v !== "string") return false;
    }
  }
  return true;
}

function projectResponse(args: {
  projectRoot?: string;
  defaultWorkflowId?: string;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return setup;
  return {
    ok: true,
    projectRoot: setup.projectRoot,
    smithersDir: setup.smithersDir,
    defaultWorkflowId: args.defaultWorkflowId,
  };
}

function workflowsResponse(args: {
  projectRoot?: string;
  defaultWorkflowId?: string;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return setup;
  return {
    ok: true,
    projectRoot: setup.projectRoot,
    smithersDir: setup.smithersDir,
    defaultWorkflowId: args.defaultWorkflowId,
    workflows: discoverProjectWorkflows(setup.projectRoot),
  };
}

async function smithersRunsListResponse(args: {
  request: Request;
  projectRoot?: string;
  defaultWorkflowId?: string;
  createSmithersRunReader: CreateSmithersRunReaderFn;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  return await withSmithersRunReader(
    setup.projectRoot,
    args.createSmithersRunReader,
    async (reader) => {
      const url = new URL(args.request.url);
      const options: ListRunsOptions = compactOptions({
        limit: parseIntegerParam(url.searchParams, "limit", {
          min: 1,
          max: 500,
        }),
        status: stringParam(url.searchParams, "status"),
        workflowId: stringParam(url.searchParams, "workflowId"),
      });
      const runs = await reader.listRuns(options);
      return json({ ok: true, runs });
    }
  );
}

async function smithersRunDetailResponse(args: {
  request: Request;
  projectRoot?: string;
  defaultWorkflowId?: string;
  runId: string;
  createSmithersRunReader: CreateSmithersRunReaderFn;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  return await withSmithersRunReader(
    setup.projectRoot,
    args.createSmithersRunReader,
    async (reader) => {
      const url = new URL(args.request.url);
      const eventsAfterSeq =
        parseIntegerParam(url.searchParams, "eventsAfterSeq", {
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        }) ??
        parseIntegerParam(url.searchParams, "afterSeq", {
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        });
      const options: GetRunDetailOptions = compactOptions({
        eventsAfterSeq,
        eventLimit: parseIntegerParam(url.searchParams, "eventLimit", {
          min: 1,
          max: 1000,
        }),
        frameLimit: parseIntegerParam(url.searchParams, "frameLimit", {
          min: 1,
          max: 100,
        }),
        includeOutputs: booleanParam(url.searchParams, "includeOutputs"),
      });
      const detail = await reader.getRunDetail(args.runId, options);
      if (!detail) {
        return json(
          {
            ok: false,
            error: `Smithers run not found: ${args.runId}`,
            code: "SMITHERS_RUN_NOT_FOUND",
          },
          404
        );
      }
      return json({ ok: true, detail: addHistoricalRunView(detail) });
    }
  );
}

async function smithersRunEventsResponse(args: {
  request: Request;
  projectRoot?: string;
  defaultWorkflowId?: string;
  runId: string;
  createSmithersRunReader: CreateSmithersRunReaderFn;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  return await withSmithersRunReader(
    setup.projectRoot,
    args.createSmithersRunReader,
    async (reader) => {
      const url = new URL(args.request.url);
      const options: ListEventsOptions = compactOptions({
        afterSeq: parseIntegerParam(url.searchParams, "afterSeq", {
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        }),
        limit: parseIntegerParam(url.searchParams, "limit", {
          min: 1,
          max: 1000,
        }),
        nodeId: stringParam(url.searchParams, "nodeId"),
        types: csvParam(url.searchParams, "types"),
        sinceTimestampMs: parseIntegerParam(
          url.searchParams,
          "sinceTimestampMs",
          { min: 0, max: Number.MAX_SAFE_INTEGER }
        ),
      });
      const result = await reader.listEvents(args.runId, options);
      return json({ ok: true, ...result });
    }
  );
}

async function withSmithersRunReader(
  projectRoot: string,
  createSmithersRunReader: CreateSmithersRunReaderFn,
  callback: (reader: SmithersRunReader) => Promise<Response>
) {
  const reader = await createSmithersRunReader({ projectRoot });
  try {
    return await callback(reader);
  } finally {
    reader.close();
  }
}

function projectSetup(args: {
  projectRoot?: string;
  defaultWorkflowId?: string;
}) {
  if (!args.projectRoot) {
    return {
      ok: false as const,
      status: "setup-needed",
      error: "Missing --project for project workflow viewer",
    };
  }
  const smithersDir = join(args.projectRoot, ".smithers");
  if (!existsSync(smithersDir)) {
    return {
      ok: false as const,
      status: "setup-needed",
      projectRoot: args.projectRoot,
      smithersDir,
      defaultWorkflowId: args.defaultWorkflowId,
      error: `Smithers setup needed: ${smithersDir} does not exist`,
    };
  }
  return { ok: true as const, projectRoot: args.projectRoot, smithersDir };
}

function discoverProjectWorkflows(projectRoot: string) {
  const workflowsDir = join(projectRoot, ".smithers", "workflows");
  if (!existsSync(workflowsDir)) return [];
  return readdirSync(workflowsDir)
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => file.slice(0, -".tsx".length))
    .filter((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id, path: join(workflowsDir, `${id}.tsx`) }));
}

async function workflowGraphResponse(args: {
  request: Request;
  projectRoot?: string;
  defaultWorkflowId?: string;
  workflowId: string;
  renderProjectWorkflowGraph: RenderProjectWorkflowGraphFn;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  const workflow = discoverProjectWorkflows(setup.projectRoot).find(
    (candidate) => candidate.id === args.workflowId
  );
  if (!workflow)
    return json(
      { ok: false, error: `Workflow not found: ${args.workflowId}` },
      404
    );

  const url = new URL(args.request.url);
  const inputParam = url.searchParams.get("input");
  const outputsParam = url.searchParams.get("outputs");
  const input = inputParam ? parseJsonObject(inputParam, "input") : {};
  const outputs = outputsParam ? parseJsonOutputs(outputsParam) : {};
  console.log("[project-graph]", workflow.id, input, outputs);
  const snapshot = await args.renderProjectWorkflowGraph({
    projectRoot: setup.projectRoot,
    workflowId: workflow.id,
    workflowPath: workflow.path,
    input,
    outputs,
  });
  const graph = smithersSnapshotToRenderGraph({
    snapshot,
    goal: projectInputPrompt(input) || `No initial workflow prompt yet.`,
    path: "workflow",
    reason: "Rendered Smithers workflow graph without executing tasks.",
    runId: snapshot.runId,
    planningLatencyMs: null,
    tokens: null,
    submittedAt: new Date(),
  });
  applyProjectWorkflowInputNode(graph, workflow.id, input);
  return json({
    ok: true,
    workflowId: workflow.id,
    workflowPath: workflow.path,
    graph,
  });
}

function projectInputPrompt(input: Record<string, unknown>) {
  const prompt = input.prompt ?? input.request;
  return typeof prompt === "string" ? prompt.trim() : "";
}

function applyProjectWorkflowInputNode(
  graph: ReturnType<typeof smithersSnapshotToRenderGraph>,
  workflowId: string,
  input: Record<string, unknown>
) {
  const prompt = projectInputPrompt(input);
  const inputNode = graph.nodes.find((node) => node.id === "goal");
  if (!inputNode) return;
  inputNode.title = "Initial workflow prompt";
  inputNode.agent = "ctx.input.prompt";
  inputNode.prompt =
    prompt ||
    "No initial workflow prompt yet. Select this node to add runtime input.";
  inputNode.smithers = {
    kind: "input",
    tag: "custom-harness:workflow-input",
    props: { workflowId },
  };
  graph.goal = inputNode.prompt;
  graph.defaultSelected = "goal";
}

async function workflowSourceFieldResponse(args: {
  request: Request;
  projectRoot?: string;
  workflowId: string;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  const workflow = discoverProjectWorkflows(setup.projectRoot).find(
    (candidate) => candidate.id === args.workflowId
  );
  if (!workflow)
    return json(
      { ok: false, error: `Workflow not found: ${args.workflowId}` },
      404
    );
  const body = await readJsonBody(args.request);
  const sourcePath = body.sourcePath;
  const value = body.value;
  if (
    !Array.isArray(sourcePath) ||
    sourcePath.length < 2 ||
    !sourcePath.every(
      (part) => typeof part === "string" && /^[a-zA-Z0-9_-]+$/.test(part)
    )
  ) {
    return json(
      {
        ok: false,
        error: "sourcePath must be an array of safe string segments",
      },
      400
    );
  }
  if (typeof value !== "string")
    return json({ ok: false, error: "value must be a string" }, 400);

  const source = readFileSync(workflow.path, "utf8");
  const nextSource = replaceEditableStringValue(
    source,
    sourcePath as string[],
    value
  );
  if (readEditableStringValue(nextSource, sourcePath as string[]) !== value) {
    throw new RequestValidationError(
      `Structured save did not update ${sourcePath.join(".")}`
    );
  }
  writeFileSync(workflow.path, nextSource);
  return json({
    ok: true,
    workflowId: workflow.id,
    workflowPath: workflow.path,
    sourcePath,
    value,
  });
}

function readEditableStringValue(source: string, sourcePath: string[]) {
  const parsed = parseEditableAgentModelPath(sourcePath);
  const block = findEditableObjectBlock(source, "agents");
  const property = findObjectProperty(block, parsed.agentId);
  const modelMatch = /model\s*:\s*(["'`])([\s\S]*?)(\1)/m.exec(property.value);
  return modelMatch?.[2] ? unescapeQuotedString(modelMatch[2]) : null;
}

function replaceEditableStringValue(
  source: string,
  sourcePath: string[],
  value: string
) {
  const parsed = parseEditableAgentModelPath(sourcePath);
  const agentsBlock = findEditableObjectBlock(source, "agents");
  const agentProperty = findObjectProperty(agentsBlock, parsed.agentId);
  const modelMatch = /model\s*:\s*(["'`])([\s\S]*?)(\1)/m.exec(
    agentProperty.value
  );
  if (!modelMatch || modelMatch.index === undefined) {
    throw new RequestValidationError(
      `Could not find editable.agents.${parsed.agentId}.model in workflow source`
    );
  }
  const quote = modelMatch[1];
  const modelValueStart =
    agentProperty.valueStart +
    modelMatch.index +
    modelMatch[0].indexOf(quote) +
    1;
  const modelValueEnd = modelValueStart + modelMatch[2].length;
  return `${source.slice(0, modelValueStart)}${escapeForQuotedString(value, quote)}${source.slice(modelValueEnd)}`;
}

function parseEditableAgentModelPath(sourcePath: string[]) {
  if (sourcePath.length !== 3 || sourcePath[0] !== "agents") {
    throw new RequestValidationError(
      "Only editable.agents.<id>.model fields are supported for structured saves right now"
    );
  }
  const [, agentId, fieldName] = sourcePath;
  if (fieldName !== "model")
    throw new RequestValidationError(
      "Only agent model fields are supported for structured saves right now"
    );
  return { agentId };
}

function findEditableObjectBlock(source: string, propertyName: string) {
  const editableIndex = source.indexOf("const editable");
  if (editableIndex < 0)
    throw new RequestValidationError(
      "Could not find editable object in workflow source"
    );
  const propertyMatch = new RegExp(
    `${escapeRegExp(propertyName)}\\s*:\\s*\\{`,
    "m"
  ).exec(source.slice(editableIndex));
  if (!propertyMatch || propertyMatch.index === undefined)
    throw new RequestValidationError(
      `Could not find editable.${propertyName} in workflow source`
    );
  const openBrace =
    editableIndex + propertyMatch.index + propertyMatch[0].lastIndexOf("{");
  const closeBrace = findMatchingBrace(source, openBrace);
  return {
    source,
    start: openBrace,
    end: closeBrace,
    body: source.slice(openBrace + 1, closeBrace),
  };
}

function findObjectProperty(
  block: { source: string; start: number; end: number; body: string },
  propertyName: string
) {
  const propertyMatch = new RegExp(
    `${escapeRegExp(propertyName)}\\s*:\\s*\\{`,
    "m"
  ).exec(block.body);
  if (!propertyMatch || propertyMatch.index === undefined)
    throw new RequestValidationError(
      `Could not find ${propertyName} in workflow source`
    );
  const openBrace =
    block.start + 1 + propertyMatch.index + propertyMatch[0].lastIndexOf("{");
  const closeBrace = findMatchingBrace(block.source, openBrace);
  return {
    valueStart: openBrace,
    valueEnd: closeBrace + 1,
    value: block.source.slice(openBrace, closeBrace + 1),
  };
}

function findMatchingBrace(source: string, openBrace: number) {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new RequestValidationError(
    "Could not parse editable object braces in workflow source"
  );
}

function unescapeQuotedString(value: string) {
  return value
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\([\\"'`])/g, "$1");
}

function escapeForQuotedString(value: string, quote: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(new RegExp(escapeRegExp(quote), "g"), `\\${quote}`)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function openRouterModelsResponse() {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return json(
        {
          ok: false,
          error: `OpenRouter /models returned ${response.status} ${response.statusText}`,
        },
        502
      );
    }
    const data = await response.json();
    const rows = Array.isArray((data as { data?: unknown }).data)
      ? (data as { data: unknown[] }).data
      : [];
    const models = rows
      .filter(isRecord)
      .map((model) => ({
        id: typeof model.id === "string" ? model.id : "",
        name: typeof model.name === "string" ? model.name : undefined,
        contextLength:
          typeof model.context_length === "number"
            ? model.context_length
            : undefined,
      }))
      .filter((model) => model.id.length > 0)
      .sort((a, b) => a.id.localeCompare(b.id));
    return json({ ok: true, models });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 502);
  }
}

async function workflowSourceResponse(args: {
  request: Request;
  projectRoot?: string;
  defaultWorkflowId?: string;
  workflowId: string;
  write: boolean;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  const workflow = discoverProjectWorkflows(setup.projectRoot).find(
    (candidate) => candidate.id === args.workflowId
  );
  if (!workflow)
    return json(
      { ok: false, error: `Workflow not found: ${args.workflowId}` },
      404
    );

  if (!args.write) {
    return json({
      ok: true,
      workflowId: workflow.id,
      workflowPath: workflow.path,
      source: readFileSync(workflow.path, "utf8"),
    });
  }

  const body = await readJsonBody(args.request);
  if (typeof body.source !== "string")
    return json({ ok: false, error: "source must be a string" }, 400);
  writeFileSync(workflow.path, body.source);
  return json({
    ok: true,
    workflowId: workflow.id,
    workflowPath: workflow.path,
  });
}

async function workflowRunCancelResponse(args: {
  projectRoot?: string;
  workflowId: string;
  runId: string;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  const workflow = discoverProjectWorkflows(setup.projectRoot).find(
    (candidate) => candidate.id === args.workflowId
  );
  if (!workflow)
    return json(
      { ok: false, error: `Workflow not found: ${args.workflowId}` },
      404
    );
  const proc = Bun.spawn(
    [
      "bun",
      "node_modules/.bin/smithers",
      "cancel",
      args.runId,
      "--format",
      "json",
    ],
    {
      cwd: setup.projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = stdout.trim()
    ? parseJsonObject(stdout, "smithers cancel response")
    : {};
  if (exitCode !== 0 && output.code !== "RUN_NOT_ACTIVE") {
    return json(
      {
        ok: false,
        error:
          output.message ??
          (stderr || stdout || `Smithers cancel failed with exit ${exitCode}`),
        ...output,
      },
      500
    );
  }
  return json({
    ok: true,
    runId: args.runId,
    status: output.status ?? "cancelled",
    ...output,
  });
}

async function workflowRunResponse(args: {
  request: Request;
  projectRoot?: string;
  defaultWorkflowId?: string;
  workflowId: string;
  runProjectWorkflow: RunProjectWorkflowFn;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  const workflow = discoverProjectWorkflows(setup.projectRoot).find(
    (candidate) => candidate.id === args.workflowId
  );
  if (!workflow)
    return json(
      { ok: false, error: `Workflow not found: ${args.workflowId}` },
      404
    );
  const body = await readJsonBody(args.request);
  const input = body.input === undefined ? {} : body.input;
  if (!isRecord(input))
    return json({ ok: false, error: "input must be a JSON object" }, 400);
  const promptOverrides = parsePromptOverrides(body.promptOverrides);
  if (promptOverrides !== undefined) {
    return json(
      {
        ok: false,
        code: "PROJECT_MODE_PROMPT_OVERRIDES_UNSUPPORTED",
        error:
          "Project-mode runs use saved Smithers workflow source and do not support promptOverrides.",
      },
      400
    );
  }

  const result = await args.runProjectWorkflow({
    projectRoot: setup.projectRoot,
    workflowId: workflow.id,
    workflowPath: workflow.path,
    input,
  });
  return json(
    {
      ok: true,
      runId: result.runId,
      status: result.status,
      inspection: { url: `/api/smithers/runs/${result.runId}` },
    },
    202
  );
}

async function renderProjectWorkflowGraph(options: {
  projectRoot: string;
  workflowId: string;
  workflowPath: string;
  input?: Record<string, unknown>;
  outputs?: Record<string, unknown[]>;
}): Promise<GraphSnapshot> {
  return await withCwd(options.projectRoot, async () => {
    const workflow = await loadWorkflow(options.workflowPath);
    const runtime = await loadSmithersRuntime(options.workflowPath);
    const runId = `custom-harness-graph-${crypto.randomUUID()}`;
    const ctx = new runtime.SmithersCtx({
      runId,
      iteration: 0,
      input: options.input ?? {},
      outputs: options.outputs ?? {},
      zodToKeyName: workflow.zodToKeyName,
    });
    return (await runtime.runPromise(
      runtime.renderFrame(workflow as never, ctx, {
        baseRootDir: options.projectRoot,
        workflowPath: options.workflowPath,
      })
    )) as GraphSnapshot;
  });
}

async function runProjectWorkflow(options: {
  projectRoot: string;
  workflowId: string;
  workflowPath: string;
  input: Record<string, unknown>;
}): Promise<{ runId: string; status: string }> {
  const command = buildSmithersWorkflowRunCommand(options);
  const proc = Bun.spawn(command.cmd, {
    cwd: command.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Smithers workflow run failed with exit ${exitCode} via ${command.source}: ${stderr || stdout}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Smithers workflow run returned invalid JSON via ${command.source}: ${message}; stdout=${stdout}; stderr=${stderr}`
    );
  }
  if (!isRecord(parsed) || typeof parsed.runId !== "string") {
    throw new Error(
      `Smithers workflow run response missing runId via ${command.source}: ${stdout}`
    );
  }
  return {
    runId: parsed.runId,
    status: typeof parsed.status === "string" ? parsed.status : "running",
  };
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RequestValidationError(`Invalid JSON ${label}: ${message}`);
  }
  if (!isRecord(parsed))
    throw new RequestValidationError(`${label} must be a JSON object`);
  return parsed;
}

function parseJsonOutputs(text: string): Record<string, unknown[]> {
  const parsed = parseJsonObject(text, "outputs");
  const out: Record<string, unknown[]> = {};
  for (const [table, rows] of Object.entries(parsed)) {
    if (!Array.isArray(rows))
      throw new RequestValidationError(`outputs.${table} must be an array`);
    out[table] = rows;
  }
  return out;
}

function parseIntegerParam(
  params: URLSearchParams,
  name: string,
  bounds: { min: number; max: number }
) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new RequestValidationError(`${name} must be a number`);
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)));
}

function booleanParam(params: URLSearchParams, name: string) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new RequestValidationError(`${name} must be true or false`);
}

function stringParam(params: URLSearchParams, name: string) {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const value = raw.trim();
  return value ? value : undefined;
}

function csvParam(params: URLSearchParams, name: string) {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function compactOptions<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, option]) => option !== undefined)
  ) as T;
}

async function readJsonBody(
  request: Request
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  return parseJsonObject(text, "request body");
}

class RequestValidationError extends Error {}

async function staticFileResponse(rootDir: string, pathname: string) {
  const requested = pathname === "/" ? "/web/index.html" : pathname;
  const localPath = safeStaticPath(rootDir, requested);
  if (!existsSync(localPath)) {
    if (localPath.endsWith(".js")) {
      const tsPath = `${localPath.slice(0, -".js".length)}.ts`;
      if (existsSync(tsPath)) {
        const output = await Bun.build({
          entrypoints: [tsPath],
          target: "browser",
          format: "esm",
          minify: false,
          sourcemap: "none",
        });
        if (!output.success) {
          return new Response(
            output.logs.map((log) => log.message).join("\n") ||
              "Build failed\n",
            { status: 500 }
          );
        }
        return new Response(output.outputs[0], {
          headers: staticHeaders("text/javascript; charset=utf-8"),
        });
      }
    }
    return new Response("Not found\n", { status: 404 });
  }
  const file = Bun.file(localPath);
  return new Response(file, {
    headers: staticHeaders(contentType(localPath)),
  });
}

function staticHeaders(contentTypeValue: string) {
  return {
    "content-type": contentTypeValue,
    "cache-control": "no-store, no-cache, must-revalidate",
    pragma: "no-cache",
    expires: "0",
  };
}

function safeStaticPath(rootDir: string, pathname: string) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded.replace(/^\/+/, "");
  const fullPath = resolve(rootDir, relative);
  if (fullPath !== rootDir && !fullPath.startsWith(`${rootDir}${sep}`)) {
    throw new Error("Invalid path");
  }
  return fullPath;
}

function safeSegment(value: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(value))
    throw new Error(`Invalid run id: ${value}`);
  return value;
}

function contentType(path: string) {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".jsonl":
    case ".ndjson":
      return "application/x-ndjson; charset=utf-8";
    case ".txt":
    case ".log":
      return "text/plain; charset=utf-8";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 4321);
  const cliOptions = parseServerArgs(process.argv.slice(2));
  const server = Bun.serve({
    port,
    fetch: createHarnessServerHandler(cliOptions),
  });
  process.on("SIGINT", () => {
    server.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.stop();
    process.exit(0);
  });
  console.log(
    `custom-harness web server listening on http://localhost:${port}`
  );
  if (cliOptions.projectRoot) {
    console.log(
      `project workflow viewer: ${cliOptions.projectRoot}${cliOptions.workflowId ? `#${cliOptions.workflowId}` : ""}`
    );
  }
  await new Promise(() => undefined);
}

function parseServerArgs(args: string[]): HarnessServerOptions {
  const out: HarnessServerOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project") {
      const value = args[i + 1];
      if (!value) throw new Error("Missing value for --project");
      out.projectRoot = value;
      i += 1;
    } else if (arg === "--workflow") {
      const value = args[i + 1];
      if (!value) throw new Error("Missing value for --workflow");
      out.workflowId = value;
      i += 1;
    } else if (arg === "--runs-dir") {
      const value = args[i + 1];
      if (!value) throw new Error("Missing value for --runs-dir");
      out.runsDir = value;
      i += 1;
    }
  }
  return out;
}
