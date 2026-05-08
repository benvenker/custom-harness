import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { createHarnessServerHandler } from '../src/server.js';
import type { RunSmithersWorkflowOptions, RunSmithersWorkflowResult } from '../src/app/runSmithersWorkflow.js';
import type { RunOutcomeOptions, RunOutcomeResult } from '../src/app/runOutcome.js';
import type { PlannerOutput } from '../src/planning/schema.js';
import type {
  SmithersRunDetail,
  SmithersRunEventsResult,
  SmithersRunReader,
  SmithersRunSummary,
} from '../src/smithersProject/runReaderTypes.js';

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

function smithersRunSummary(overrides: Partial<SmithersRunSummary> = {}): SmithersRunSummary {
  return {
    runId: 'smithers-run-true',
    parentRunId: null,
    workflowName: 'truth-workflow',
    workflowPath: '/project/.smithers/workflows/truth-workflow.tsx',
    workflowHash: 'hash-true',
    status: 'running',
    createdAtMs: 1000,
    startedAtMs: 1001,
    finishedAtMs: null,
    heartbeatAtMs: 1002,
    runtimeOwnerId: 'owner-true',
    errorJson: null,
    error: null,
    configJson: '{"source":"reader"}',
    config: { source: 'reader' },
    ...overrides,
  };
}

function smithersRunDetail(overrides: Partial<SmithersRunDetail> = {}): SmithersRunDetail {
  const run = overrides.run ?? smithersRunSummary();
  return {
    run,
    nodes: [{
      runId: run.runId,
      nodeId: 'reader-node',
      iteration: 0,
      state: 'running',
      status: 'running',
      lastAttempt: 1,
      updatedAtMs: 1010,
      outputTable: 'reader_outputs',
      label: 'Reader node',
    }],
    attempts: [],
    events: [{
      runId: run.runId,
      seq: 7,
      timestampMs: 1020,
      type: 'reader.event',
      payloadJson: '{"nodeId":"reader-node"}',
      payload: { nodeId: 'reader-node' },
      nodeId: 'reader-node',
      iteration: null,
      attempt: null,
    }],
    frames: [{
      runId: run.runId,
      frameNo: 3,
      createdAtMs: 1030,
      xmlHash: 'xml-hash-true',
      encoding: 'json',
      mountedTaskIdsJson: '["reader-node"]',
      mountedTaskIds: ['reader-node'],
      taskIndexJson: '{"reader-node":{"label":"Reader node"}}',
      taskIndex: { 'reader-node': { label: 'Reader node' } },
      note: 'from fake reader',
    }],
    outputs: [],
    cursors: { nextEventSeq: 8 },
    parseWarnings: [],
    ...overrides,
  };
}

function smithersEventsResult(overrides: Partial<SmithersRunEventsResult> = {}): SmithersRunEventsResult {
  return {
    events: [{
      runId: 'smithers-run-true',
      seq: 11,
      timestampMs: 1040,
      type: 'reader.events-endpoint',
      payloadJson: '{"source":"reader-events"}',
      payload: { source: 'reader-events' },
      nodeId: null,
      iteration: null,
      attempt: null,
    }],
    cursors: { nextEventSeq: 12 },
    ...overrides,
  };
}

function fakeSmithersRunReader(options: {
  runs?: SmithersRunSummary[];
  detail?: SmithersRunDetail | null;
  events?: SmithersRunEventsResult;
  onListRuns?: (options: unknown) => void;
  onGetRunDetail?: (runId: string, options: unknown) => void;
  onListEvents?: (runId: string, options: unknown) => void;
  onClose?: () => void;
} = {}): SmithersRunReader {
  return {
    async listRuns(listOptions) {
      options.onListRuns?.(listOptions);
      return options.runs ?? [smithersRunSummary()];
    },
    async getRunDetail(runId, detailOptions) {
      options.onGetRunDetail?.(runId, detailOptions);
      return options.detail === undefined ? smithersRunDetail({ run: smithersRunSummary({ runId }) }) : options.detail;
    },
    async listEvents(runId, eventsOptions) {
      options.onListEvents?.(runId, eventsOptions);
      return options.events ?? smithersEventsResult({ events: smithersEventsResult().events.map((event) => ({ ...event, runId })) });
    },
    close() {
      options.onClose?.();
    },
  };
}

describe('HTTP server DB-backed Smithers run inspection API', () => {
  it('lists Smithers runs using the injected reader and closes it after the request', async () => {
    const calls: unknown[] = [];
    let closeCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () => fakeSmithersRunReader({
        runs: [smithersRunSummary({ runId: 'reader-list-run', workflowName: 'reader-list' })],
        onListRuns: (options) => calls.push(options),
        onClose: () => { closeCalls += 1; },
      }),
    });

    const response = await handler(new Request('http://localhost/api/smithers/runs?limit=25&status=running&workflowId=reader-list'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      runs: [smithersRunSummary({ runId: 'reader-list-run', workflowName: 'reader-list' })],
    });
    expect(calls).toEqual([{ limit: 25, status: 'running', workflowId: 'reader-list' }]);
    expect(closeCalls).toBe(1);
  });

  it('clamps list limits before passing them to the reader', async () => {
    const calls: unknown[] = [];
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () => fakeSmithersRunReader({ onListRuns: (options) => calls.push(options) }),
    });

    const low = await handler(new Request('http://localhost/api/smithers/runs?limit=-50'));
    const high = await handler(new Request('http://localhost/api/smithers/runs?limit=50000'));

    expect(low.status).toBe(200);
    expect(high.status).toBe(200);
    expect(calls).toEqual([{ limit: 1 }, { limit: 500 }]);
  });

  it('returns Smithers run detail using the injected reader and parsed detail query options', async () => {
    const detail = smithersRunDetail({
      run: smithersRunSummary({ runId: 'reader-detail-run', status: 'finished' }),
      outputs: [{ runId: 'reader-detail-run', nodeId: 'reader-node', iteration: 0, outputTable: 'reader_outputs', row: { source: 'reader-output' } }],
    });
    const calls: Array<{ runId: string; options: unknown }> = [];
    let closeCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () => fakeSmithersRunReader({
        detail,
        onGetRunDetail: (runId, options) => calls.push({ runId, options }),
        onClose: () => { closeCalls += 1; },
      }),
    });

    const response = await handler(new Request('http://localhost/api/smithers/runs/reader-detail-run?eventsAfterSeq=41&eventLimit=2000&frameLimit=0&includeOutputs=true'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, detail });
    expect(calls).toEqual([{ runId: 'reader-detail-run', options: { eventsAfterSeq: 41, eventLimit: 1000, frameLimit: 1, includeOutputs: true } }]);
    expect(closeCalls).toBe(1);
  });

  it('returns a structured 404 and closes the reader when a Smithers run is missing', async () => {
    const calls: Array<{ runId: string; options: unknown }> = [];
    let closeCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () => fakeSmithersRunReader({
        detail: null,
        onGetRunDetail: (runId, options) => calls.push({ runId, options }),
        onClose: () => { closeCalls += 1; },
      }),
    });

    const response = await handler(new Request('http://localhost/api/smithers/runs/missing-run'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'Smithers run not found: missing-run', code: 'SMITHERS_RUN_NOT_FOUND' });
    expect(calls).toEqual([{ runId: 'missing-run', options: {} }]);
    expect(closeCalls).toBe(1);
  });

  it('returns Smithers run events using afterSeq, limit, nodeId, types, and timestamp query options', async () => {
    const events = smithersEventsResult({
      events: [{
        runId: 'reader-events-run',
        seq: 19,
        timestampMs: 1100,
        type: 'reader.typeB',
        payloadJson: '{"source":"events"}',
        payload: { source: 'events' },
        nodeId: null,
        iteration: null,
        attempt: null,
      }],
      cursors: { nextEventSeq: 20 },
    });
    const calls: Array<{ runId: string; options: unknown }> = [];
    let closeCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () => fakeSmithersRunReader({
        events,
        onListEvents: (runId, options) => calls.push({ runId, options }),
        onClose: () => { closeCalls += 1; },
      }),
    });

    const response = await handler(new Request('http://localhost/api/smithers/runs/reader-events-run/events?afterSeq=10&limit=2000&nodeId=reader-node&types=reader.typeA,reader.typeB,,&sinceTimestampMs=1090'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...events });
    expect(calls).toEqual([{ runId: 'reader-events-run', options: { afterSeq: 10, limit: 1000, nodeId: 'reader-node', types: ['reader.typeA', 'reader.typeB'], sinceTimestampMs: 1090 } }]);
    expect(closeCalls).toBe(1);
  });

  it('passes parse warnings through from the Smithers events reader', async () => {
    const events = smithersEventsResult({
      events: [{
        runId: 'reader-events-warning-run',
        seq: 21,
        timestampMs: 1200,
        type: 'reader.bad-json',
        payloadJson: '{bad-json',
        payload: null,
        nodeId: null,
        iteration: null,
        attempt: null,
      }],
      cursors: { nextEventSeq: 21 },
      parseWarnings: [{
        field: 'event.payloadJson',
        message: 'Expected property name or } in JSON at position 1',
        runId: 'reader-events-warning-run',
        seq: 21,
      }],
    } as Partial<SmithersRunEventsResult>);
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () => fakeSmithersRunReader({ events }),
    });

    const response = await handler(new Request('http://localhost/api/smithers/runs/reader-events-warning-run/events'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...events });
  });

  it('uses afterSeq as an alias for eventsAfterSeq on detail requests', async () => {
    const calls: unknown[] = [];
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () => fakeSmithersRunReader({ onGetRunDetail: (_runId, options) => calls.push(options) }),
    });

    const response = await handler(new Request('http://localhost/api/smithers/runs/reader-detail-run?afterSeq=15&includeOutputs=false'));

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ eventsAfterSeq: 15, includeOutputs: false }]);
  });

  it('ignores contradictory legacy runs artifacts for all Smithers run inspection endpoints', async () => {
    const runsDir = tempRunsDir();
    mkdirSync(join(runsDir, 'legacy-false-run'), { recursive: true });
    writeFileSync(join(runsDir, 'index.json'), `${JSON.stringify({ runs: [{ id: 'legacy-false-run', status: 'failed', workflowName: 'legacy-lie' }] })}\n`);
    writeFileSync(join(runsDir, 'legacy-false-run', 'plan.json'), `${JSON.stringify({ raw: { source: 'legacy-plan-lie' }, graph: { nodes: [{ id: 'legacy-node' }] } })}\n`);
    writeFileSync(join(runsDir, 'legacy-false-run', 'run.json'), `${JSON.stringify({ id: 'legacy-false-run', status: 'failed', goal: 'legacy lie' })}\n`);
    writeFileSync(join(runsDir, 'legacy-false-run', 'events.jsonl'), `${JSON.stringify({ type: 'legacy.lie', payload: { source: 'legacy-events' } })}\n`);

    const readerList = smithersRunSummary({ runId: 'reader-true-run', status: 'finished', workflowName: 'reader-truth' });
    const readerDetail = smithersRunDetail({ run: readerList });
    const readerEvents = smithersEventsResult({ events: [{ ...smithersEventsResult().events[0]!, runId: 'reader-true-run', type: 'reader.truth' }] });
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      runsDir,
      projectRoot: process.cwd(),
      createSmithersRunReader: () => fakeSmithersRunReader({ runs: [readerList], detail: readerDetail, events: readerEvents }),
    });

    expect(await (await handler(new Request('http://localhost/api/smithers/runs'))).json()).toEqual({ ok: true, runs: [readerList] });
    expect(await (await handler(new Request('http://localhost/api/smithers/runs/reader-true-run'))).json()).toEqual({ ok: true, detail: readerDetail });
    expect(await (await handler(new Request('http://localhost/api/smithers/runs/reader-true-run/events'))).json()).toEqual({ ok: true, ...readerEvents });
  });

  it('closes the reader when a reader operation throws', async () => {
    let closeCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot: process.cwd(),
      createSmithersRunReader: () => ({
        async listRuns() {
          throw new Error('reader exploded');
        },
        async getRunDetail() {
          throw new Error('should not call detail');
        },
        async listEvents() {
          throw new Error('should not call events');
        },
        close() {
          closeCalls += 1;
        },
      }),
    });

    const response = await handler(new Request('http://localhost/api/smithers/runs'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'reader exploded' });
    expect(closeCalls).toBe(1);
  });
});

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
