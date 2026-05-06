import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runOutcome, type AgentLike, type OutcomeWorkflowRunner } from '../src/app/runOutcome.js';
import { defaultOutcomeWorkflowRunner } from '../src/workflows/outcomeWorkflow.js';

class FakeAgent implements AgentLike {
  calls: Array<{ prompt?: unknown; messages?: unknown }> = [];

  constructor(private readonly outputs: unknown[]) {}

  async generate(options: { prompt?: unknown; messages?: unknown; onStdout?: (text: string) => void }) {
    this.calls.push({ prompt: options.prompt, messages: options.messages });
    const output = this.outputs.shift();
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    options.onStdout?.(text);
    return { text };
  }
}

function tempRunsDir() {
  return mkdtempSync(join(tmpdir(), 'custom-harness-runs-'));
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readEvents(runDir: string) {
  return readFileSync(join(runDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

const smithersRunner: () => { runner: OutcomeWorkflowRunner; calls: Array<{ workflow: unknown; taskIds: string[] }> } =
  () => {
    const calls: Array<{ workflow: unknown; taskIds: string[] }> = [];
    const realRunner = defaultOutcomeWorkflowRunner();
    const runner: OutcomeWorkflowRunner = async (args) => {
      const { workflow } = args;
      calls.push({ workflow, taskIds: [] });
      return realRunner(args);
    };
    return { runner, calls };
  };

describe('runOutcome', () => {
  it('executes through an injected Smithers workflow runtime boundary', async () => {
    const runsDir = tempRunsDir();
    const { runner, calls } = smithersRunner();
    const planner = new FakeAgent([{ path: 'harness', reason: 'simple' }]);
    const executor = new FakeAgent([{ result: 'done from fake executor' }]);

    const result = await runOutcome({
      goal: 'prove Smithers boundary',
      planner,
      executorAgent: executor,
      workflowRunner: runner,
      runId: 'smithers-boundary-test',
      runsDir,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.workflow).toBeTruthy();
    expect(result.status).toBe('succeeded');
    expect(readJson(join(runsDir, 'smithers-boundary-test', 'plan.json')).raw.path).toBe('harness');
  });

  it('fails the run when a non-planner Smithers task output violates its schema', async () => {
    const runsDir = tempRunsDir();
    const planner = new FakeAgent([{ path: 'harness', reason: 'simple' }]);
    const executor = new FakeAgent([{ wrong: 'shape' }]);

    const result = await runOutcome({
      goal: 'validate executor output',
      planner,
      executorAgent: executor,
      runId: 'invalid-output-test',
      runsDir,
    });

    const runDir = join(runsDir, 'invalid-output-test');
    const events = readEvents(runDir);

    expect(result.status).toBe('failed');
    expect(events.find((event: { type: string }) => event.type === 'run.error')?.message).toContain('validation');
  });

  it('accepts plain Codex-style task text as the task result while keeping structured validation', async () => {
    const runsDir = tempRunsDir();
    const planner = new FakeAgent([{ path: 'harness', reason: 'simple' }]);
    const executor = new FakeAgent(['**Audit**\nMention the schema example `{ result: string }` without returning JSON.']);

    const result = await runOutcome({
      goal: 'audit in prose',
      planner,
      executorAgent: executor,
      runId: 'plain-text-task-test',
      runsDir,
    });

    const runDir = join(runsDir, 'plain-text-task-test');
    expect(result.status).toBe('succeeded');
    expect(readFileSync(join(runDir, 'artifacts', 'worker.txt'), 'utf8')).toContain('Mention the schema example');
  });

  it('runs the harness path as one Smithers CLI-agent task and writes compatible artifacts', async () => {
    const runsDir = tempRunsDir();
    const planner = new FakeAgent([{ path: 'harness', reason: 'simple' }]);
    const executor = new FakeAgent([{ result: 'done from fake executor' }]);

    const result = await runOutcome({
      goal: 'summarize the repo',
      context: 'prefer short output',
      planner,
      executorAgent: executor,
      runId: 'harness-test',
      runsDir,
    });

    const runDir = join(runsDir, 'harness-test');
    expect(result.status).toBe('succeeded');
    expect(existsSync(join(runDir, 'run.json'))).toBe(true);
    expect(existsSync(join(runDir, 'plan.json'))).toBe(true);
    expect(existsSync(join(runDir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(runDir, 'artifacts', 'cli.log'))).toBe(true);

    const runJson = readJson(join(runDir, 'run.json'));
    const planJson = readJson(join(runDir, 'plan.json'));
    const events = readEvents(runDir);

    expect(runJson.path).toBe('harness');
    expect(runJson.status).toBe('succeeded');
    expect(planJson.raw.path).toBe('harness');
    expect(planJson.graph.nodes.map((node: { id: string }) => node.id)).toContain('goal');
    expect(planJson.graph.nodes.map((node: { id: string }) => node.id)).toContain('plan');
    expect(planJson.graph.nodes.map((node: { id: string }) => node.id)).toContain('worker');
    expect(planJson.graph.nodes.find((node: { id: string }) => node.id === 'worker')?.outputArtifact).toBe(
      'artifacts/worker.txt',
    );
    expect(planJson.graph.nodes.find((node: { id: string }) => node.id === 'worker')?.outputPreview).toContain(
      'done from fake executor',
    );
    expect(events.map((event: { type: string }) => event.type)).toContain('task.started');
    expect(events.map((event: { type: string }) => event.type)).toContain('task.done');
    expect(events.map((event: { type: string }) => event.type)).toContain('agent.output');
    expect(readFileSync(join(runDir, 'artifacts', 'worker.txt'), 'utf8')).toContain('done from fake executor');
    expect(String(executor.calls[0]?.prompt)).toContain('summarize the repo');
    expect(String(executor.calls[0]?.prompt)).toContain('prefer short output');
  });

  it('runs workflow sequence tasks in order with stable task artifacts', async () => {
    const runsDir = tempRunsDir();
    const planner = new FakeAgent([{
      path: 'workflow',
      reason: 'needs ordered steps',
      workflow: {
        name: 'ordered-work',
        description: 'Two dependent steps',
        root: {
          type: 'sequence',
          children: [
            { type: 'task', name: 'First Step', prompt: 'Do first' },
            { type: 'task', name: 'Second Step', prompt: 'Do second' },
          ],
        },
      },
    }]);
    const executor = new FakeAgent([{ result: 'first output' }, { result: 'second output' }]);

    const result = await runOutcome({
      goal: 'ship in order',
      planner,
      executorAgent: executor,
      runId: 'sequence-test',
      runsDir,
    });

    const runDir = join(runsDir, 'sequence-test');
    const planJson = readJson(join(runDir, 'plan.json'));

    expect(result.status).toBe('succeeded');
    expect(planJson.raw.path).toBe('workflow');
    expect(planJson.graph.source).toEqual({ kind: 'smithers', frameNo: 0 });
    expect(planJson.graph.nodes.map((node: { id: string }) => node.id)).toEqual([
      'goal',
      'plan',
      'first-step',
      'second-step',
    ]);
    expect(String(executor.calls[0]?.prompt)).toContain('First Step');
    expect(String(executor.calls[1]?.prompt)).toContain('Second Step');
    expect(String(executor.calls[1]?.prompt)).toContain('first output');
    expect(readFileSync(join(runDir, 'artifacts', 'first-step.txt'), 'utf8')).toContain('first output');
    expect(readFileSync(join(runDir, 'artifacts', 'second-step.inputs.json'), 'utf8')).toContain('first-step.txt');
    const firstNode = planJson.graph.nodes.find((node: { id: string }) => node.id === 'first-step');
    expect(firstNode?.outputArtifact).toBe('artifacts/first-step.txt');
    expect(firstNode?.timeline.some((event: { what?: string }) => event.what === 'task done')).toBe(true);

    const dbPath = join(runDir, 'smithers', 'smithers.db');
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query('select node_id, result from task order by rowid').all()).toEqual([
        { node_id: 'first-step', result: 'first output' },
        { node_id: 'second-step', result: 'second output' },
      ]);
    } finally {
      db.close();
    }
  });

  it('renders workflow parallel tasks as independent stable task nodes', async () => {
    const runsDir = tempRunsDir();
    const planner = new FakeAgent([{
      path: 'workflow',
      reason: 'parallel work',
      workflow: {
        name: 'parallel-work',
        description: 'Two independent branches',
        root: {
          type: 'parallel',
          children: [
            { type: 'task', name: 'Left Branch', prompt: 'Do left' },
            { type: 'task', name: 'Right Branch', prompt: 'Do right' },
          ],
        },
      },
    }]);
    const executor = new FakeAgent([{ result: 'left output' }, { result: 'right output' }]);

    const result = await runOutcome({
      goal: 'fan out',
      planner,
      executorAgent: executor,
      runId: 'parallel-test',
      runsDir,
    });

    const planJson = readJson(join(runsDir, 'parallel-test', 'plan.json'));
    const edges = planJson.graph.edges as Array<{ from: string; to: string; label?: string }>;

    expect(result.status).toBe('succeeded');
    expect(planJson.graph.source).toEqual({ kind: 'smithers', frameNo: 0 });
    expect(planJson.graph.nodes.map((node: { id: string }) => node.id)).toContain('left-branch');
    expect(planJson.graph.nodes.map((node: { id: string }) => node.id)).toContain('right-branch');
    expect(edges).toContainEqual({ from: 'plan', to: 'left-branch', label: 'parallel' });
    expect(edges).toContainEqual({ from: 'plan', to: 'right-branch', label: '' });
  });

  it('fails clearly and records run.error for duplicate workflow task names', async () => {
    const runsDir = tempRunsDir();
    const planner = new FakeAgent([{
      path: 'workflow',
      reason: 'bad plan',
      workflow: {
        name: 'duplicates',
        description: 'Duplicate names',
        root: {
          type: 'sequence',
          children: [
            { type: 'task', name: 'Repeat', prompt: 'A' },
            { type: 'task', name: 'Repeat', prompt: 'B' },
          ],
        },
      },
    }]);
    const executor = new FakeAgent([]);

    const result = await runOutcome({
      goal: 'reject duplicates',
      planner,
      executorAgent: executor,
      runId: 'duplicate-test',
      runsDir,
    });

    const runDir = join(runsDir, 'duplicate-test');
    const runJson = readJson(join(runDir, 'run.json'));
    const events = readEvents(runDir);

    expect(result.status).toBe('failed');
    expect(runJson.status).toBe('failed');
    expect(events.find((event: { type: string }) => event.type === 'run.error')?.message).toContain(
      'Duplicate workflow task names',
    );
    expect(executor.calls).toHaveLength(0);
  });
});
