import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

function writeBin(path: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/usr/bin/env bun\n');
  chmodSync(path, 0o755);
}

type SmithersCliCommand = {
  cmd: string[];
  cwd: string;
  source: 'root-local' | 'workflow-pack-local' | 'bunx';
};

type SmithersCliModule = {
  buildSmithersWorkflowRunCommand: (options: {
    projectRoot: string;
    workflowId: string;
    input: Record<string, unknown>;
  }) => SmithersCliCommand;
};

async function loadSmithersCliModule() {
  return await import('../src/smithersProject/cli.js') as SmithersCliModule;
}

function expectWorkflowRunCommand(command: SmithersCliCommand, projectRoot: string, input: Record<string, unknown>) {
  expect(command.cwd).toBe(resolve(projectRoot));
  expect(command.cmd).toContain('workflow');
  expect(command.cmd).toContain('run');
  expect(command.cmd).toContain('foo');
  expect(command.cmd).toContain('--detach');
  expect(command.cmd).toContain('--format');
  expect(command.cmd).toContain('json');
  expect(command.cmd).toContain('--root');
  expect(command.cmd).toContain('.');
  expect(command.cmd).not.toContain('--log-dir');
  expect(command.cmd.slice(-10)).toEqual([
    'workflow',
    'run',
    'foo',
    '--input',
    JSON.stringify(input),
    '--detach',
    '--format',
    'json',
    '--root',
    '.',
  ]);
}

describe('Smithers CLI command resolution for project runs', () => {
  it('prefers the project-root local smithers bin and runs from projectRoot', async () => {
    const projectRoot = tempProject('custom-harness-cli-root-bin-');
    const rootBin = join(projectRoot, 'node_modules', '.bin', 'smithers');
    const workflowPackBin = join(projectRoot, '.smithers', 'node_modules', '.bin', 'smithers');
    writeBin(rootBin);
    writeBin(workflowPackBin);
    const input = { prompt: 'Ship the alpha' };

    const { buildSmithersWorkflowRunCommand } = await loadSmithersCliModule();
    const command = buildSmithersWorkflowRunCommand({ projectRoot, workflowId: 'foo', input });

    expect(command.source).toBe('root-local');
    expect(command.cmd[0]).toBe('bun');
    expect([rootBin, 'node_modules/.bin/smithers', './node_modules/.bin/smithers']).toContain(command.cmd[1]);
    expectWorkflowRunCommand(command, projectRoot, input);
  });

  it('uses the workflow-pack local smithers bin when root node_modules is absent', async () => {
    const projectRoot = tempProject('custom-harness-cli-smithers-bin-');
    const workflowPackBin = join(projectRoot, '.smithers', 'node_modules', '.bin', 'smithers');
    writeBin(workflowPackBin);
    const input = { prompt: 'Use saved source' };

    const { buildSmithersWorkflowRunCommand } = await loadSmithersCliModule();
    const command = buildSmithersWorkflowRunCommand({ projectRoot, workflowId: 'foo', input });

    expect(command.source).toBe('workflow-pack-local');
    expect(command.cwd).toBe(resolve(projectRoot));
    expect(command.cmd[0]).toBe('bun');
    expect([workflowPackBin, '.smithers/node_modules/.bin/smithers', './.smithers/node_modules/.bin/smithers']).toContain(command.cmd[1]);
    expect(existsSync(join(projectRoot, 'node_modules'))).toBe(false);
    expectWorkflowRunCommand(command, projectRoot, input);
  });

  it('falls back to bunx smithers-orchestrator when no local smithers bin exists', async () => {
    const projectRoot = tempProject('custom-harness-cli-bunx-');
    const input = { prompt: 'Fallback please' };

    const { buildSmithersWorkflowRunCommand } = await loadSmithersCliModule();
    const command = buildSmithersWorkflowRunCommand({ projectRoot, workflowId: 'foo', input });

    expect(command.source).toBe('bunx');
    expect(command.cmd.slice(0, 2)).toEqual(['bunx', 'smithers-orchestrator']);
    expectWorkflowRunCommand(command, projectRoot, input);
  });
});

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
