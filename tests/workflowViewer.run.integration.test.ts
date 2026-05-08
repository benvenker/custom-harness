import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessServerHandler } from '../src/server.js';

type SmithersRunDetailResponse = {
  ok: true;
  detail: {
    run: {
      runId: string;
      workflowName: string;
      workflowPath: string | null;
      status: string;
    };
    nodes: Array<{
      runId: string;
      nodeId: string;
      iteration: number;
      state: string;
      status: string;
      outputTable: string;
    }>;
    attempts: Array<{
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      state: string;
      status: string;
      responseText: string | null;
    }>;
    events: Array<{
      runId: string;
      seq: number;
      type: string;
      nodeId: string | null;
      iteration: number | null;
      attempt: number | null;
    }>;
    frames: Array<{
      runId: string;
      frameNo: number;
      mountedTaskIds: string[];
      taskIndex: unknown;
    }>;
    outputs: Array<{
      runId: string;
      nodeId: string;
      iteration: number;
      outputTable: string;
      row: Record<string, unknown>;
    }>;
  };
};

function tempProject(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSafeProject() {
  const projectRoot = tempProject('custom-harness-real-run-');
  const workflowsDir = join(projectRoot, '.smithers', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  symlinkSync(join(process.cwd(), 'node_modules'), join(projectRoot, '.smithers', 'node_modules'), 'dir');
  writeFileSync(join(projectRoot, '.smithers', 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  writeFileSync(join(workflowsDir, 'foo.tsx'), `
import React from 'react';
import { createSmithers } from 'smithers-orchestrator';
import { z } from 'zod';

const schemas = { task: z.object({ result: z.string() }) };
const { Workflow, Task, smithers, outputs } = createSmithers(schemas);
const safeAgent = { id: 'safe-agent', async generate() { return { text: JSON.stringify({ result: 'ok' }) }; } };
export default smithers(() => React.createElement(
  Workflow,
  { name: 'safe-run-workflow' },
  React.createElement(Task, { id: 'do-safe-thing', output: outputs.task, agent: safeAgent }, 'Return ok'),
));
`);
  return projectRoot;
}

function writeContradictoryLegacyArtifacts(projectRoot: string, runId: string) {
  const legacyRunDir = join(projectRoot, 'runs', runId);
  mkdirSync(legacyRunDir, { recursive: true });
  writeFileSync(join(projectRoot, 'runs', 'index.json'), JSON.stringify({ runs: [{ id: runId, status: 'legacy-failed' }] }, null, 2));
  writeFileSync(join(legacyRunDir, 'run.json'), JSON.stringify({ id: runId, status: 'legacy-failed', goal: 'legacy artifact' }, null, 2));
  writeFileSync(join(legacyRunDir, 'plan.json'), JSON.stringify({ raw: { source: 'legacy-plan' }, graph: { nodes: [] } }, null, 2));
  writeFileSync(join(legacyRunDir, 'events.jsonl'), `${JSON.stringify({ type: 'LegacyEvent', status: 'legacy-failed' })}\n`);
}

describe('project workflow real run integration', () => {
  it('launches and inspects a real Smithers run from SQLite without trusting legacy run artifacts', async () => {
    const projectRoot = writeSafeProject();
    const handler = createHarnessServerHandler({ rootDir: process.cwd(), projectRoot, workflowId: 'foo' });

    const response = await handler(new Request('http://localhost/api/workflows/foo/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    }));

    expect(response.status).toBe(202);
    expect(existsSync(join(projectRoot, 'node_modules'))).toBe(false);
    const body = await response.json() as {
      ok: boolean;
      runId: string;
      status: string;
      inspection?: { url?: string };
    };
    expect(body.ok).toBe(true);
    expect(body.runId).toMatch(/^run[-_]/);
    expect(body.status).toBeTruthy();
    expect(body.inspection).toEqual({ url: `/api/smithers/runs/${body.runId}` });
    expect(existsSync(join(projectRoot, 'runs'))).toBe(false);

    writeContradictoryLegacyArtifacts(projectRoot, body.runId);
    expect(existsSync(join(projectRoot, 'runs', body.runId, 'plan.json'))).toBe(true);

    const detail = await waitForInspectionDetail(handler, body.inspection.url ?? `/api/smithers/runs/${body.runId}`);

    expect(existsSync(join(projectRoot, 'smithers.db'))).toBe(true);
    expect(detail.run).toEqual(expect.objectContaining({
      runId: body.runId,
      workflowName: 'safe-run-workflow',
      status: 'finished',
    }));
    expect(detail.run.workflowPath).toContain('.smithers/workflows/foo.tsx');
    expect(detail.run.status).not.toBe('legacy-failed');

    expect(detail.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: body.runId,
        nodeId: 'do-safe-thing',
        iteration: 0,
        state: 'finished',
        status: 'finished',
        outputTable: 'task',
      }),
    ]));
    expect(detail.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: body.runId,
        nodeId: 'do-safe-thing',
        iteration: 0,
        attempt: 1,
        state: 'finished',
        responseText: '{"result":"ok"}',
      }),
    ]));
    const eventTypes = detail.events.map((event) => event.type);
    const hasDbEventEvidence = detail.events.some((event) => event.runId === body.runId && event.type.length > 0);
    const hasDbAttemptEvidence = detail.attempts.some((attempt) => attempt.runId === body.runId && attempt.nodeId === 'do-safe-thing');
    expect(hasDbEventEvidence || hasDbAttemptEvidence).toBe(true);
    expect(eventTypes).not.toContain('LegacyEvent');
    expect(detail.frames).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: body.runId,
        frameNo: expect.any(Number),
        mountedTaskIds: expect.arrayContaining(['do-safe-thing::0']),
      }),
    ]));
    expect(detail.frames[0]).not.toHaveProperty('renderGraph');
    expect(detail.frames[0]).not.toHaveProperty('graph');
    expect(detail.outputs).toEqual([
      expect.objectContaining({
        runId: body.runId,
        nodeId: 'do-safe-thing',
        iteration: 0,
        outputTable: 'task',
        row: expect.objectContaining({
          run_id: body.runId,
          node_id: 'do-safe-thing',
          iteration: 0,
          result: 'ok',
        }),
      }),
    ]);
  });
});

async function waitForInspectionDetail(
  handler: (request: Request) => Promise<Response>,
  inspectionUrl: string,
  timeoutMs = 8000,
) {
  let lastStatus = 0;
  let lastBody = '';
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await handler(new Request(`http://localhost${inspectionUrl}?eventsAfterSeq=0&includeOutputs=true&eventLimit=50&frameLimit=5`));
    lastStatus = response.status;
    lastBody = await response.text();

    if (response.status === 200) {
      const parsed = JSON.parse(lastBody) as SmithersRunDetailResponse;
      const detail = parsed.detail;
      if (
        detail.run.status === 'finished'
        && detail.nodes.length > 0
        && (detail.events.length > 0 || detail.attempts.length > 0)
        && detail.frames.length > 0
        && detail.outputs.length > 0
      ) {
        return detail;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for SQLite-backed Smithers run detail; last status=${lastStatus}; body=${lastBody}`);
}
