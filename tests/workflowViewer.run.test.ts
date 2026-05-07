import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHarnessServerHandler } from '../src/server.js';

function tempProject(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeWorkflow(projectRoot: string, id: string) {
  const workflowsDir = join(projectRoot, '.smithers', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, `${id}.tsx`), 'export default {}\n');
}

describe('project workflow run API', () => {
  it('launches the selected workflow through the runner seam and returns Smithers run status', async () => {
    const projectRoot = tempProject('custom-harness-workflow-run-');
    writeWorkflow(projectRoot, 'foo');
    const calls: Array<{ projectRoot: string; workflowId: string; workflowPath: string; input: Record<string, unknown> }> = [];
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      workflowId: 'foo',
      runProjectWorkflow: async (options) => {
        calls.push(options);
        return { runId: 'run_test_123', status: 'detached' };
      },
    });

    const response = await handler(new Request('http://localhost/api/workflows/foo/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { prompt: 'Ship the alpha' } }),
    }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, runId: 'run_test_123', status: 'detached' });
    expect(calls).toEqual([{
      projectRoot: resolve(projectRoot),
      workflowId: 'foo',
      workflowPath: join(resolve(projectRoot), '.smithers', 'workflows', 'foo.tsx'),
      input: { prompt: 'Ship the alpha' },
    }]);
    expect(existsSync(join(projectRoot, 'runs'))).toBe(false);
    expect(existsSync(join(projectRoot, '.poolside'))).toBe(false);
  });

  it('rejects unknown workflow IDs before invoking the runner', async () => {
    const projectRoot = tempProject('custom-harness-workflow-run-missing-');
    writeWorkflow(projectRoot, 'foo');
    let runCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      workflowId: 'foo',
      runProjectWorkflow: async () => {
        runCalls += 1;
        return { runId: 'should-not-run', status: 'detached' };
      },
    });

    const response = await handler(new Request('http://localhost/api/workflows/missing/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    }));

    expect(response.status).toBe(404);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Workflow not found: missing');
    expect(runCalls).toBe(0);
  });
});
