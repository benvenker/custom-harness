import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderWorkflowGraph } from '../src/app/renderWorkflowGraph.js';

function tempRunsDir() {
  return mkdtempSync(join(tmpdir(), 'custom-harness-graph-workflow-'));
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('renderWorkflowGraph', () => {
  it('renders a real Smithers workflow file into compatible run artifacts without executing tasks', async () => {
    const runsDir = tempRunsDir();
    const workflowPath = resolve('tests/fixtures/nativeSmithersWorkflow.tsx');

    const result = await renderWorkflowGraph({
      workflowPath,
      input: { prompt: 'Review current diff' },
      runId: 'fixture-graph',
      runsDir,
      goal: 'Review current diff',
      context: 'render-only test',
    });

    const runDir = join(runsDir, 'fixture-graph');
    const planJson = readJson(join(runDir, 'plan.json'));
    const runJson = readJson(join(runDir, 'run.json'));
    const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8');
    const nodeIds = planJson.graph.nodes.map((node: { id: string }) => node.id);

    expect(result.status).toBe('succeeded');
    expect(result.planPath).toBe(join(runDir, 'plan.json'));
    expect(existsSync(join(runDir, 'run.json'))).toBe(true);
    expect(existsSync(join(runDir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(runDir, 'artifacts', 'cli.log'))).toBe(true);
    expect(runJson.status).toBe('succeeded');
    expect(runJson.path).toBe('workflow');
    expect(planJson.graph.source).toEqual({ kind: 'smithers', frameNo: 0 });
    expect(planJson.raw.source.kind).toBe('smithers');
    expect(planJson.raw.source.workflowPath).toBe(workflowPath);
    expect(nodeIds).toContain('inspect-diff');
    expect(nodeIds).toContain('check-tests');
    expect(nodeIds).toContain('check-types');
    expect(nodeIds).toContain('write-findings');
    expect(nodeIds).not.toContain('worker');
    expect(nodeIds).not.toContain('legacy-only');
    expect(planJson.graph.edges).toContainEqual({ from: 'inspect-diff', to: 'check-tests', label: 'parallel' });
    expect(events).toContain('"type":"run.started"');
    expect(events).toContain('"type":"run.done"');
  });
});
