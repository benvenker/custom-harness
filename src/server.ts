import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { runOutcome, type RunOutcomeOptions, type RunOutcomeResult } from './app/runOutcome.js';
import { depsFromEnv } from './cli.js';
import { planSchema, type PlannerOutput } from './planning/schema.js';

type RunOutcomeFn = (options: RunOutcomeOptions) => Promise<RunOutcomeResult>;

export type HarnessServerOptions = {
  rootDir?: string;
  runsDir?: string;
  runOutcome?: RunOutcomeFn;
};

type RunJson = {
  id: string;
  goal: string;
};

type PlanJson = {
  raw: unknown;
};

export function createHarnessServerHandler(options: HarnessServerOptions = {}) {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const runsDir = options.runsDir ?? process.env.CUSTOM_HARNESS_RUNS_DIR ?? 'runs';
  const runOutcomeFn = options.runOutcome ?? runOutcome;

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
}) {
  const body = await readJsonBody(args.request);
  const existing = readExistingRun(args.runsDir, args.runId);
  const runId = typeof body.runId === 'string' ? body.runId : crypto.randomUUID();
  launchRun(args.runOutcome, {
    goal: existing.run.goal,
    context: typeof body.context === 'string' ? body.context : undefined,
    planner: () => existing.plan,
    executorAgent: depsFromEnv().executorAgent,
    runId,
    runsDir: args.runsDir,
  });
  return json({
    ok: true,
    runId,
    status: 'running',
    path: existing.plan.path,
  }, 202);
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

function readExistingRun(runsDir: string, runId: string): { run: RunJson; plan: PlannerOutput } {
  const safeRunId = safeSegment(runId);
  const runDir = join(runsDir, safeRunId);
  const runPath = join(runDir, 'run.json');
  const planPath = join(runDir, 'plan.json');
  if (!existsSync(runPath)) throw new Error(`Run not found: ${runId}`);
  if (!existsSync(planPath)) throw new Error(`Run has no plan.json: ${runId}`);

  const run = JSON.parse(readFileSync(runPath, 'utf8')) as RunJson;
  const planJson = JSON.parse(readFileSync(planPath, 'utf8')) as PlanJson;
  if (typeof run.goal !== 'string' || run.goal.trim() === '') throw new Error(`Run has no goal: ${runId}`);
  return { run, plan: planSchema.parse(planJson.raw) };
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
