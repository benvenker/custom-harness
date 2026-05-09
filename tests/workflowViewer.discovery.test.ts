import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHarnessServerHandler } from '../src/server.js';

function tempProject(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeFile(path: string, content = 'export default {}\n') {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

describe('project workflow discovery API', () => {
  it('discovers flat Smithers workflow files and ignores non-workflows without legacy run artifacts', async () => {
    const projectRoot = tempProject('custom-harness-workflow-discovery-');
    const workflowsDir = join(projectRoot, '.smithers', 'workflows');
    writeFile(join(workflowsDir, 'foo.tsx'));
    writeFile(join(workflowsDir, 'bar.tsx'));
    writeFile(join(workflowsDir, 'not-a-workflow.md'), '# nope\n');
    writeFile(join(workflowsDir, 'bad_name.tsx'));
    writeFile(join(workflowsDir, 'Nested.tsx'));
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      workflowId: 'foo',
    });

    const response = await handler(new Request('http://localhost/api/workflows'));

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; workflows: Array<{ id: string; path: string }> };
    expect(body.ok).toBe(true);
    expect(body.workflows.map((workflow) => workflow.id)).toEqual(['bar', 'foo']);
    expect(body.workflows.map((workflow) => workflow.path)).toEqual([
      join(resolve(projectRoot), '.smithers', 'workflows', 'bar.tsx'),
      join(resolve(projectRoot), '.smithers', 'workflows', 'foo.tsx'),
    ]);
    expect(existsSync(join(projectRoot, '.poolside'))).toBe(false);
    expect(existsSync(join(projectRoot, 'runs'))).toBe(false);
  });

  it('reports missing Smithers setup from /api/workflows without creating project files', async () => {
    const projectRoot = tempProject('custom-harness-discovery-missing-');
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      workflowId: 'foo',
    });

    const response = await handler(new Request('http://localhost/api/workflows'));

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.status).toBe('setup-needed');
    expect(body.smithersDir).toBe(join(resolve(projectRoot), '.smithers'));
    expect(existsSync(join(projectRoot, '.smithers'))).toBe(false);
    expect(existsSync(join(projectRoot, '.poolside'))).toBe(false);
  });
});
