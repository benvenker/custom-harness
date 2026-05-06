import { z } from 'zod';
import type { WorkflowNode } from '../types.js';

export const taskNodeSchema: z.ZodType<{
  type: 'task';
  name: string;
  prompt: string;
}> = z.object({
  type: z.literal('task'),
  name: z.string().min(1),
  prompt: z.string().min(1),
});

export const workflowNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z.union([
    taskNodeSchema,
    z.object({
      type: z.enum(['sequence', 'parallel']),
      name: z.string().optional(),
      children: z.array(workflowNodeSchema).min(1),
    }),
  ]),
);

export const workflowSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  root: workflowNodeSchema,
});

export const planSchema = z.discriminatedUnion('path', [
  z.object({
    path: z.literal('harness'),
    reason: z.string(),
  }),
  z.object({
    path: z.literal('workflow'),
    reason: z.string(),
    workflow: workflowSchema,
  }),
]);

export const planTaskOutputSchema = z.object({
  path: z.enum(['harness', 'workflow']),
  reason: z.string(),
  workflow: workflowSchema.optional(),
});

export const taskOutputSchema = z.object({
  result: z.string(),
});

export type PlannerOutput = z.infer<typeof planSchema>;
