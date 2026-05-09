import { createRunRecorder } from '../runs/recorder.js';
import { FunctionPlannerAgent } from '../agents/recordingAgent.js';
import {
  buildOutcomeWorkflow,
  createDefaultAgent,
  defaultOutcomeWorkflowRunner,
  emitSmithersEvent,
  type AgentLike,
  type OutcomeWorkflowRunner,
  type PlannerOutput,
} from '../workflows/outcomeWorkflow.js';

const MODEL = 'smithers-cli-agent';

export type RunOutcomeOptions = {
  goal: string;
  context?: string;
  planner?: AgentLike | (() => PlannerOutput | Promise<PlannerOutput>);
  executorAgent?: AgentLike;
  workflowRunner?: OutcomeWorkflowRunner;
  runId?: string;
  runsDir?: string;
};

export type RunOutcomeResult = {
  runId: string;
  status: 'succeeded' | 'failed';
  path?: 'harness' | 'workflow';
  runDir: string;
};

export async function runOutcome(options: RunOutcomeOptions): Promise<RunOutcomeResult> {
  const runId = options.runId ?? crypto.randomUUID();
  const recorder = createRunRecorder(runId, { goal: options.goal, model: MODEL }, { runsDir: options.runsDir });
  const runStartedAt = Date.now();
  let plannerOutput: PlannerOutput | null = null;
  let planRecorded = false;

  recorder.event('run.started', { goal: options.goal });

  try {
    const workflowHandle = buildOutcomeWorkflow({
      goal: options.goal,
      context: options.context,
      runId,
      runDir: recorder.runDir,
      planner: resolvePlannerAgent(options),
      executorAgent: options.executorAgent ?? createDefaultAgent(),
      recorder,
      onPlan: (plan) => {
        if (planRecorded) return;
        planRecorded = true;
        plannerOutput = plan;
        recorder.writePlan(plan, { planningLatencyMs: Date.now() - runStartedAt, usage: null });
        recorder.event('plan.decision', {
          path: plan.path,
          reason: plan.reason,
          rawPlan: plan,
        });
      },
    });

    try {
      const runner = options.workflowRunner ?? defaultOutcomeWorkflowRunner();
      const result = await runner({
        workflow: workflowHandle.workflow,
        input: { goal: options.goal, context: options.context ?? null },
        runId,
        rootDir: process.cwd(),
        logDir: workflowHandle.logDir,
        onProgress: (event) => emitSmithersEvent({
          event,
          recorder,
          plan: workflowHandle.getPlan(),
        }),
      });
      if (result.status !== 'finished') throw new Error(`Smithers workflow ended with status ${result.status}`);
      plannerOutput = plannerOutput ?? workflowHandle.getPlan();
      if (!plannerOutput) throw new Error('Smithers workflow finished without a planner output');
      const frame = await workflowHandle.renderGraphSnapshot({ goal: options.goal, context: options.context ?? null });
      recorder.writeSmithersGraphSnapshot(frame);
    } finally {
      workflowHandle.close();
    }

    recorder.event('run.done', { status: 'succeeded' });
    recorder.finish('succeeded', { latencyMs: Date.now() - runStartedAt });
    return { runId, status: 'succeeded', path: plannerOutput.path, runDir: recorder.runDir };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recorder.event('run.error', { message, source: plannerOutput?.path ?? 'runOutcome' });
    recorder.finish('failed', { latencyMs: Date.now() - runStartedAt });
    return { runId, status: 'failed', path: plannerOutput?.path, runDir: recorder.runDir };
  }
}

function resolvePlannerAgent(options: RunOutcomeOptions): AgentLike {
  if (typeof options.planner === 'function') return new FunctionPlannerAgent(options.planner);
  return options.planner ?? createDefaultAgent();
}

export type { AgentLike, OutcomeWorkflowRunner, PlannerOutput };
