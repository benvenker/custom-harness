import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { createHarnessServerHandler } from '../src/server.js';
import type { RunOutcomeOptions, RunOutcomeResult } from '../src/app/runOutcome.js';
import type { PlannerOutput } from '../src/planning/schema.js';

function tempRunsDir() {
  return mkdtempSync(join(tmpdir(), 'custom-harness-server-runs-'));
}

function writeExistingRun(runsDir: string, runId: string, plan: PlannerOutput) {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify({
    id: runId,
    goal: 'rerun this workflow',
    path: plan.path,
    started: new Date(0).toISOString(),
    ended: new Date(0).toISOString(),
    status: 'succeeded',
    totals: { latencyMs: 1, tokens: null },
    plan: { reason: plan.reason },
  }, null, 2)}\n`);
  writeFileSync(join(runDir, 'plan.json'), `${JSON.stringify({ raw: plan, graph: { nodes: [] } }, null, 2)}\n`);
}

describe('HTTP server rerun API', () => {
  it('starts a rerun immediately by reusing its goal and raw planner output', async () => {
    const runsDir = tempRunsDir();
    writeExistingRun(runsDir, 'source-run', plan);

    const calls: RunOutcomeOptions[] = [];
    let resolveRun: ((result: RunOutcomeResult) => void) | null = null;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      runsDir,
      runOutcome: async (options): Promise<RunOutcomeResult> => {
        calls.push(options);
        const planned = typeof options.planner === 'function' ? await options.planner() : null;
        expect(planned).toEqual(plan);
        return await new Promise<RunOutcomeResult>((resolve) => {
          resolveRun = resolve;
        });
      },
    });

    const response = await handler(new Request('http://localhost/api/runs/source-run/rerun', {
      method: 'POST',
      body: JSON.stringify({ context: 'keep it short', runId: 'rerun-output' }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      runId: 'rerun-output',
      status: 'running',
      path: 'workflow',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.goal).toBe('rerun this workflow');
    expect(calls[0]?.context).toBe('keep it short');
    expect(calls[0]?.runsDir).toBe(runsDir);

    resolveRun?.({
      runId: 'rerun-output',
      status: 'succeeded',
      path: 'workflow',
      runDir: join(runsDir, 'rerun-output'),
    });
  });

  it('starts a new run immediately and returns a known run id', async () => {
    const runsDir = tempRunsDir();
    const calls: RunOutcomeOptions[] = [];
    let resolveRun: ((result: RunOutcomeResult) => void) | null = null;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      runsDir,
      runOutcome: async (options): Promise<RunOutcomeResult> => {
        calls.push(options);
        return await new Promise<RunOutcomeResult>((resolve) => {
          resolveRun = resolve;
        });
      },
    });

    const response = await handler(new Request('http://localhost/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        goal: 'start this workflow',
        runId: 'new-run-output',
        plan,
      }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      runId: 'new-run-output',
      status: 'running',
      path: 'workflow',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.goal).toBe('start this workflow');
    expect(calls[0]?.runId).toBe('new-run-output');

    resolveRun?.({
      runId: 'new-run-output',
      status: 'succeeded',
      path: 'workflow',
      runDir: join(runsDir, 'new-run-output'),
    });
  });
});

const plan: PlannerOutput = {
  path: 'workflow',
  reason: 'existing plan',
  workflow: {
    name: 'Existing Workflow',
    description: 'Reuse this DAG',
    root: { type: 'task', name: 'Existing Task', prompt: 'Do the existing task' },
  },
};
