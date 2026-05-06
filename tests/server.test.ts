import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { createHarnessServerHandler } from '../src/server.js';
import type { RunSmithersWorkflowOptions, RunSmithersWorkflowResult } from '../src/app/runSmithersWorkflow.js';
import type { RunOutcomeOptions, RunOutcomeResult } from '../src/app/runOutcome.js';
import type { PlannerOutput } from '../src/planning/schema.js';

function tempRunsDir() {
  return mkdtempSync(join(tmpdir(), 'custom-harness-server-runs-'));
}

function writeExistingRun(runsDir: string, runId: string, plan: PlannerOutput) {
  writeExistingRunWithRawPlan(runsDir, runId, plan, { path: plan.path, reason: plan.reason });
}

function writeExistingRunWithRawPlan(
  runsDir: string,
  runId: string,
  rawPlan: unknown,
  runPlan: { path: 'harness' | 'workflow'; reason: string },
) {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify({
    id: runId,
    goal: 'rerun this workflow',
    path: runPlan.path,
    started: new Date(0).toISOString(),
    ended: new Date(0).toISOString(),
    status: 'succeeded',
    totals: { latencyMs: 1, tokens: null },
    plan: { reason: runPlan.reason },
  }, null, 2)}\n`);
  writeFileSync(join(runDir, 'plan.json'), `${JSON.stringify({ raw: rawPlan, graph: { nodes: [] } }, null, 2)}\n`);
}

describe('HTTP server rerun API', () => {
  it('reruns exported Smithers graph plans through the Smithers execution path', async () => {
    const runsDir = tempRunsDir();
    const smithersPlan = {
      path: 'workflow',
      reason: 'rendered graph',
      source: {
        kind: 'smithers',
        workflowPath: '/tmp/example/.smithers/workflows/custom-code-review.tsx',
        input: { prompt: 'Review current diff' },
      },
    };
    writeExistingRunWithRawPlan(runsDir, 'source-run', smithersPlan, {
      path: 'workflow',
      reason: 'rendered graph',
    });

    const outcomeCalls: RunOutcomeOptions[] = [];
    const smithersCalls: RunSmithersWorkflowOptions[] = [];
    let resolveSmithers: ((result: RunSmithersWorkflowResult) => void) | null = null;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      runsDir,
      runOutcome: async (options): Promise<RunOutcomeResult> => {
        outcomeCalls.push(options);
        throw new Error('planner rerun path should not be called for Smithers graph exports');
      },
      runSmithersWorkflow: async (options): Promise<RunSmithersWorkflowResult> => {
        smithersCalls.push(options);
        return await new Promise<RunSmithersWorkflowResult>((resolve) => {
          resolveSmithers = resolve;
        });
      },
    });

    const response = await handler(new Request('http://localhost/api/runs/source-run/rerun', {
      method: 'POST',
      body: JSON.stringify({ context: 'rerun context', runId: 'smithers-rerun-output' }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      runId: 'smithers-rerun-output',
      status: 'running',
      path: 'workflow',
      forkedFrom: 'source-run',
    });
    expect(outcomeCalls).toHaveLength(0);
    expect(smithersCalls).toHaveLength(1);
    expect(smithersCalls[0]?.workflowPath).toBe('/tmp/example/.smithers/workflows/custom-code-review.tsx');
    expect(smithersCalls[0]?.input).toEqual({ prompt: 'Review current diff' });
    expect(smithersCalls[0]?.context).toBe('rerun context');
    expect(smithersCalls[0]?.goal).toBe('rerun this workflow');
    expect(smithersCalls[0]?.runId).toBe('smithers-rerun-output');
    expect(smithersCalls[0]?.runsDir).toBe(runsDir);
    expect(smithersCalls[0]?.forkedFrom).toBe('source-run');
    expect(smithersCalls[0]?.promptOverrides).toBeUndefined();

    resolveSmithers?.({
      runId: 'smithers-rerun-output',
      status: 'succeeded',
      path: 'workflow',
      runDir: join(runsDir, 'smithers-rerun-output'),
    });
  });

  it('forwards promptOverrides to the Smithers rerun and merges them with inherited overrides', async () => {
    const runsDir = tempRunsDir();
    const smithersPlan = {
      path: 'workflow',
      reason: 'rendered graph',
      source: {
        kind: 'smithers',
        workflowPath: '/tmp/example/.smithers/workflows/custom-code-review.tsx',
        input: { prompt: 'Review current diff' },
        promptOverrides: { 'resolve-source': 'inherited override' },
      },
    };
    writeExistingRunWithRawPlan(runsDir, 'parent-run', smithersPlan, {
      path: 'workflow',
      reason: 'rendered graph',
    });

    const calls: RunSmithersWorkflowOptions[] = [];
    let resolveSmithers: ((result: RunSmithersWorkflowResult) => void) | null = null;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      runsDir,
      runSmithersWorkflow: async (options): Promise<RunSmithersWorkflowResult> => {
        calls.push(options);
        return await new Promise<RunSmithersWorkflowResult>((resolve) => {
          resolveSmithers = resolve;
        });
      },
    });

    const response = await handler(new Request('http://localhost/api/runs/parent-run/rerun', {
      method: 'POST',
      body: JSON.stringify({
        runId: 'forked-run',
        promptOverrides: {
          'review-current-diff': 'edited prompt',
          'resolve-source': 'replaces inherited',
          'blank-key': '   ',
        },
      }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      runId: 'forked-run',
      status: 'running',
      path: 'workflow',
      forkedFrom: 'parent-run',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.forkedFrom).toBe('parent-run');
    expect(calls[0]?.promptOverrides).toEqual({
      'resolve-source': 'replaces inherited',
      'review-current-diff': 'edited prompt',
    });

    resolveSmithers?.({
      runId: 'forked-run',
      status: 'succeeded',
      path: 'workflow',
      runDir: join(runsDir, 'forked-run'),
    });
  });

  it('rejects promptOverrides with a 400 when the existing run is not a Smithers workflow', async () => {
    const runsDir = tempRunsDir();
    writeExistingRun(runsDir, 'planner-run', plan);

    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      runsDir,
      runOutcome: async () => {
        throw new Error('runOutcome should not be invoked when validation fails');
      },
    });

    const response = await handler(new Request('http://localhost/api/runs/planner-run/rerun', {
      method: 'POST',
      body: JSON.stringify({ promptOverrides: { 'foo': 'bar' } }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('promptOverrides');
  });

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
