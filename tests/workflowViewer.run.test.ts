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
  it('launches the selected workflow through the runner seam and returns Smithers run status plus inspection URL', async () => {
    const projectRoot = tempProject('custom-harness-workflow-run-');
    writeWorkflow(projectRoot, 'foo');
    const calls: Array<Record<string, unknown>> = [];
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
    expect(await response.json()).toEqual({
      ok: true,
      runId: 'run_test_123',
      status: 'detached',
      inspection: { url: '/api/smithers/runs/run_test_123' },
    });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!).sort()).toEqual(['input', 'projectRoot', 'workflowId', 'workflowPath']);
    expect(Object.hasOwn(calls[0]!, 'promptOverrides')).toBe(false);
    expect(calls[0]).toEqual({
      projectRoot: resolve(projectRoot),
      workflowId: 'foo',
      workflowPath: join(resolve(projectRoot), '.smithers', 'workflows', 'foo.tsx'),
      input: { prompt: 'Ship the alpha' },
    });
    expect(existsSync(join(projectRoot, 'runs'))).toBe(false);
    expect(existsSync(join(projectRoot, '.poolside'))).toBe(false);
  });

  it('rejects project-mode prompt overrides before invoking project or legacy runners', async () => {
    const projectRoot = tempProject('custom-harness-workflow-run-overrides-');
    writeWorkflow(projectRoot, 'foo');
    let projectRunCalls = 0;
    let legacyRunCalls = 0;
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      workflowId: 'foo',
      runProjectWorkflow: async () => {
        projectRunCalls += 1;
        return { runId: 'should-not-run', status: 'detached' };
      },
      runSmithersWorkflow: async () => {
        legacyRunCalls += 1;
        return { runId: 'legacy-should-not-run', status: 'running' } as never;
      },
    });

    const response = await handler(new Request('http://localhost/api/workflows/foo/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: { prompt: 'Ship the alpha' },
        promptOverrides: { 'do-safe-thing': 'Use a different prompt' },
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      code: 'PROJECT_MODE_PROMPT_OVERRIDES_UNSUPPORTED',
      error: 'Project-mode runs use saved Smithers workflow source and do not support promptOverrides.',
    });
    expect(projectRunCalls).toBe(0);
    expect(legacyRunCalls).toBe(0);
    expect(existsSync(join(projectRoot, 'runs'))).toBe(false);
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
