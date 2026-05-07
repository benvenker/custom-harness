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

describe('HTTP server Smithers create API', () => {
  it('starts a Smithers workflow run from workflowPath and input', async () => {
    const runsDir = tempRunsDir();
    const outcomeCalls: RunOutcomeOptions[] = [];
    const smithersCalls: RunSmithersWorkflowOptions[] = [];
    let resolveSmithers: ((result: RunSmithersWorkflowResult) => void) | null = null;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      runsDir,
      runOutcome: async (options): Promise<RunOutcomeResult> => {
        outcomeCalls.push(options);
        throw new Error('planner run path should not be called for direct Smithers workflow runs');
      },
      runSmithersWorkflow: async (options): Promise<RunSmithersWorkflowResult> => {
        smithersCalls.push(options);
        return await new Promise<RunSmithersWorkflowResult>((resolve) => {
          resolveSmithers = resolve;
        });
      },
    });

    const response = await handler(new Request('http://localhost/api/smithers-runs', {
      method: 'POST',
      body: JSON.stringify({
        workflowPath: '/tmp/example/.smithers/workflows/custom-code-review.tsx',
        input: { prompt: 'Review current diff' },
        goal: 'Custom code review experiment',
        context: 'from workflow studio',
        runId: 'smithers-created-run',
      }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      runId: 'smithers-created-run',
      status: 'running',
      path: 'workflow',
    });
    expect(outcomeCalls).toHaveLength(0);
    expect(smithersCalls).toHaveLength(1);
    expect(smithersCalls[0]?.workflowPath).toBe('/tmp/example/.smithers/workflows/custom-code-review.tsx');
    expect(smithersCalls[0]?.input).toEqual({ prompt: 'Review current diff' });
    expect(smithersCalls[0]?.goal).toBe('Custom code review experiment');
    expect(smithersCalls[0]?.context).toBe('from workflow studio');
    expect(smithersCalls[0]?.runId).toBe('smithers-created-run');
    expect(smithersCalls[0]?.runsDir).toBe(runsDir);
    expect(smithersCalls[0]?.forkedFrom).toBeUndefined();
    expect(smithersCalls[0]?.promptOverrides).toBeUndefined();

    resolveSmithers?.({
      runId: 'smithers-created-run',
      status: 'succeeded',
      path: 'workflow',
      runDir: join(runsDir, 'smithers-created-run'),
    });
  });

  it('rejects invalid promptOverrides without starting a Smithers run', async () => {
    const runsDir = tempRunsDir();
    const smithersCalls: RunSmithersWorkflowOptions[] = [];
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      runsDir,
      runSmithersWorkflow: async (options): Promise<RunSmithersWorkflowResult> => {
        smithersCalls.push(options);
        throw new Error('runSmithersWorkflow should not be invoked when validation fails');
      },
    });

    const response = await handler(new Request('http://localhost/api/smithers-runs', {
      method: 'POST',
      body: JSON.stringify({
        workflowPath: '/tmp/example/.smithers/workflows/custom-code-review.tsx',
        input: { prompt: 'Review current diff' },
        promptOverrides: { 'resolve-source': 42 },
      }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('promptOverrides[resolve-source]');
    expect(smithersCalls).toHaveLength(0);
  });

  it('forwards promptOverrides when creating a Smithers workflow run', async () => {
    const runsDir = tempRunsDir();
    const smithersCalls: RunSmithersWorkflowOptions[] = [];
    let resolveSmithers: ((result: RunSmithersWorkflowResult) => void) | null = null;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      runsDir,
      runSmithersWorkflow: async (options): Promise<RunSmithersWorkflowResult> => {
        smithersCalls.push(options);
        return await new Promise<RunSmithersWorkflowResult>((resolve) => {
          resolveSmithers = resolve;
        });
      },
    });

    const response = await handler(new Request('http://localhost/api/smithers-runs', {
      method: 'POST',
      body: JSON.stringify({
        workflowPath: '/tmp/example/.smithers/workflows/custom-code-review.tsx',
        input: { prompt: 'Review current diff' },
        runId: 'smithers-created-with-overrides',
        promptOverrides: {
          'resolve-source': 'Resolve the source from this edited prompt.',
          'empty-value': '   ',
        },
      }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(202);
    expect(smithersCalls).toHaveLength(1);
    expect(smithersCalls[0]?.promptOverrides).toEqual({
      'resolve-source': 'Resolve the source from this edited prompt.',
    });

    resolveSmithers?.({
      runId: 'smithers-created-with-overrides',
      status: 'succeeded',
      path: 'workflow',
      runDir: join(runsDir, 'smithers-created-with-overrides'),
    });
  });

  it('requires workflowPath and input when creating a Smithers workflow run', async () => {
    const runsDir = tempRunsDir();
    const smithersCalls: RunSmithersWorkflowOptions[] = [];
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      runsDir,
      runSmithersWorkflow: async (options): Promise<RunSmithersWorkflowResult> => {
        smithersCalls.push(options);
        throw new Error('runSmithersWorkflow should not be invoked when validation fails');
      },
    });

    const missingWorkflowPath = await handler(new Request('http://localhost/api/smithers-runs', {
      method: 'POST',
      body: JSON.stringify({ input: { prompt: 'Review current diff' } }),
      headers: { 'content-type': 'application/json' },
    }));
    const missingInput = await handler(new Request('http://localhost/api/smithers-runs', {
      method: 'POST',
      body: JSON.stringify({ workflowPath: '/tmp/example/.smithers/workflows/custom-code-review.tsx' }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(missingWorkflowPath.status).toBe(400);
    expect(await missingWorkflowPath.json()).toEqual({ ok: false, error: 'Missing workflowPath' });
    expect(missingInput.status).toBe(400);
    expect(await missingInput.json()).toEqual({ ok: false, error: 'Missing input' });
    expect(smithersCalls).toHaveLength(0);
  });

  it('returns a 400 for malformed JSON request bodies', async () => {
    const runsDir = tempRunsDir();
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      runsDir,
    });

    const response = await handler(new Request('http://localhost/api/smithers-runs', {
      method: 'POST',
      body: '{"workflowPath":',
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Invalid JSON');
  });

  it('keeps POST /api/runs on the planner-backed run path', async () => {
    const runsDir = tempRunsDir();
    const outcomeCalls: RunOutcomeOptions[] = [];
    const smithersCalls: RunSmithersWorkflowOptions[] = [];
    let resolveRun: ((result: RunOutcomeResult) => void) | null = null;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      runsDir,
      runOutcome: async (options): Promise<RunOutcomeResult> => {
        outcomeCalls.push(options);
        return await new Promise<RunOutcomeResult>((resolve) => {
          resolveRun = resolve;
        });
      },
      runSmithersWorkflow: async (options): Promise<RunSmithersWorkflowResult> => {
        smithersCalls.push(options);
        throw new Error('runSmithersWorkflow should not be invoked for POST /api/runs');
      },
    });

    const response = await handler(new Request('http://localhost/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        goal: 'start this workflow',
        runId: 'planner-run-output',
        plan,
      }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(202);
    expect(outcomeCalls).toHaveLength(1);
    expect(outcomeCalls[0]?.goal).toBe('start this workflow');
    expect(smithersCalls).toHaveLength(0);

    resolveRun?.({
      runId: 'planner-run-output',
      status: 'succeeded',
      path: 'workflow',
      runDir: join(runsDir, 'planner-run-output'),
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
