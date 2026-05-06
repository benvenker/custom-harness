import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { runOutcome, type RunOutcomeOptions, type RunOutcomeResult } from './app/runOutcome.js';
import {
  runSmithersWorkflow,
  type RunSmithersWorkflowOptions,
  type RunSmithersWorkflowResult,
} from './app/runSmithersWorkflow.js';
import { depsFromEnv } from './cli.js';
import { planSchema, type PlannerOutput } from './planning/schema.js';

type RunOutcomeFn = (options: RunOutcomeOptions) => Promise<RunOutcomeResult>;
type RunSmithersWorkflowFn = (options: RunSmithersWorkflowOptions) => Promise<RunSmithersWorkflowResult>;

export type HarnessServerOptions = {
  rootDir?: string;
  runsDir?: string;
  runOutcome?: RunOutcomeFn;
  runSmithersWorkflow?: RunSmithersWorkflowFn;
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
    kind: 'smithers';
    workflowPath: string;
    input: Record<string, unknown>;
    context?: string;
    promptOverrides?: Record<string, string>;
  };
};

export function createHarnessServerHandler(options: HarnessServerOptions = {}) {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const runsDir = options.runsDir ?? process.env.CUSTOM_HARNESS_RUNS_DIR ?? 'runs';
  const runOutcomeFn = options.runOutcome ?? runOutcome;
  const runSmithersWorkflowFn = options.runSmithersWorkflow ?? runSmithersWorkflow;

  return async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === 'OPTIONS') return json({ ok: true });

      const rerunMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/rerun$/);
      if (request.method === 'POST' && rerunMatch) {
        return await rerunRun({
          runId: decodeURIComponent(rerunMatch[1]),
          request,
          runsDir,
          runOutcome: runOutcomeFn,
          runSmithersWorkflow: runSmithersWorkflowFn,
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/runs') {
        return await startRun({ request, runsDir, runOutcome: runOutcomeFn });
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ ok: false, error: 'Method not allowed' }, 405);
      }

      if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
      return staticFileResponse(rootDir, url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ ok: false, error: message }, 500);
    }
  };
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
  const runId = typeof body.runId === 'string' ? body.runId : crypto.randomUUID();
  const promptOverrides = parsePromptOverrides(body.promptOverrides);
  if (isSmithersGraphExportPlan(existing.rawPlan)) {
    const context = typeof body.context === 'string'
      ? body.context
      : existing.rawPlan.source.context;
    const inheritedOverrides = existing.rawPlan.source.promptOverrides;
    const mergedOverrides = mergeOverrides(inheritedOverrides, promptOverrides);
    launchSmithersRun(args.runSmithersWorkflow, {
      workflowPath: existing.rawPlan.source.workflowPath,
      input: existing.rawPlan.source.input,
      goal: existing.run.goal,
      ...(context === undefined ? {} : { context }),
      ...(mergedOverrides === undefined ? {} : { promptOverrides: mergedOverrides }),
      forkedFrom: args.runId,
      runId,
      runsDir: args.runsDir,
    });
    return json({
      ok: true,
      runId,
      status: 'running',
      path: 'workflow',
      forkedFrom: args.runId,
    }, 202);
  }

  if (promptOverrides !== undefined) {
    return json({ ok: false, error: 'promptOverrides are only supported for Smithers workflow runs' }, 400);
  }
  const plan = planSchema.parse(existing.rawPlan);
  launchRun(args.runOutcome, {
    goal: existing.run.goal,
    context: typeof body.context === 'string' ? body.context : undefined,
    planner: () => plan,
    executorAgent: depsFromEnv().executorAgent,
    runId,
    runsDir: args.runsDir,
  });
  return json({
    ok: true,
    runId,
    status: 'running',
    path: plan.path,
  }, 202);
}

function parsePromptOverrides(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('promptOverrides must be a JSON object of string→string');
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') throw new Error(`promptOverrides[${key}] must be a string`);
    if (!key.trim()) continue;
    if (raw.trim()) out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeOverrides(
  inherited: Record<string, string> | undefined,
  next: Record<string, string> | undefined,
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
  if (typeof body.goal !== 'string' || body.goal.trim() === '') {
    return json({ ok: false, error: 'Missing goal' }, 400);
  }

  const envDeps = depsFromEnv();
  const plan = body.plan === undefined ? null : planSchema.parse(body.plan);
  const runId = typeof body.runId === 'string' ? body.runId : envDeps.runId ?? crypto.randomUUID();
  launchRun(args.runOutcome, {
    goal: body.goal,
    context: typeof body.context === 'string' ? body.context : undefined,
    planner: plan ? () => plan : envDeps.planner,
    executorAgent: envDeps.executorAgent,
    runId,
    runsDir: args.runsDir,
  });
  return json({
    ok: true,
    runId,
    status: 'running',
    path: plan?.path,
  }, 202);
}

function launchRun(runOutcomeFn: RunOutcomeFn, options: RunOutcomeOptions) {
  void runOutcomeFn(options).catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`background run failed before recorder could finish: ${message}`);
  });
}

function launchSmithersRun(runSmithersWorkflowFn: RunSmithersWorkflowFn, options: RunSmithersWorkflowOptions) {
  void runSmithersWorkflowFn(options).catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`background Smithers workflow rerun failed before recorder could finish: ${message}`);
  });
}

function readExistingRun(runsDir: string, runId: string): { run: RunJson; rawPlan: unknown } {
  const safeRunId = safeSegment(runId);
  const runDir = join(runsDir, safeRunId);
  const runPath = join(runDir, 'run.json');
  const planPath = join(runDir, 'plan.json');
  if (!existsSync(runPath)) throw new Error(`Run not found: ${runId}`);
  if (!existsSync(planPath)) throw new Error(`Run has no plan.json: ${runId}`);

  const run = JSON.parse(readFileSync(runPath, 'utf8')) as RunJson;
  const planJson = JSON.parse(readFileSync(planPath, 'utf8')) as PlanJson;
  if (typeof run.goal !== 'string' || run.goal.trim() === '') throw new Error(`Run has no goal: ${runId}`);
  return { run, rawPlan: planJson.raw };
}

function isSmithersGraphExportPlan(value: unknown): value is SmithersGraphExportPlan {
  if (!value || typeof value !== 'object') return false;
  const source = (value as { source?: unknown }).source;
  if (!source || typeof source !== 'object') return false;
  const maybeSource = source as Record<string, unknown>;
  if (maybeSource.kind !== 'smithers'
    || typeof maybeSource.workflowPath !== 'string'
    || !isRecord(maybeSource.input)
    || (maybeSource.context !== undefined && typeof maybeSource.context !== 'string')) {
    return false;
  }
  const overrides = maybeSource.promptOverrides;
  if (overrides !== undefined) {
    if (!isRecord(overrides)) return false;
    for (const v of Object.values(overrides)) {
      if (typeof v !== 'string') return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function staticFileResponse(rootDir: string, pathname: string) {
  const requested = pathname === '/' ? '/web/index.html' : pathname;
  const localPath = safeStaticPath(rootDir, requested);
  if (!existsSync(localPath)) return new Response('Not found\n', { status: 404 });
  const file = Bun.file(localPath);
  return new Response(file, {
    headers: {
      'content-type': contentType(localPath),
      'cache-control': 'no-store, no-cache, must-revalidate',
      pragma: 'no-cache',
      expires: '0',
    },
  });
}

function safeStaticPath(rootDir: string, pathname: string) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded.replace(/^\/+/, '');
  const fullPath = resolve(rootDir, relative);
  if (fullPath !== rootDir && !fullPath.startsWith(`${rootDir}${sep}`)) {
    throw new Error('Invalid path');
  }
  return fullPath;
}

function safeSegment(value: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`Invalid run id: ${value}`);
  return value;
}

function contentType(path: string) {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.jsonl':
    case '.ndjson':
      return 'application/x-ndjson; charset=utf-8';
    case '.txt':
    case '.log':
      return 'text/plain; charset=utf-8';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 4321);
  const server = Bun.serve({
    port,
    fetch: createHarnessServerHandler(),
  });
  process.on('SIGINT', () => {
    server.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    server.stop();
    process.exit(0);
  });
  console.log(`custom-harness web server listening on http://localhost:${port}`);
  await new Promise(() => undefined);
}
