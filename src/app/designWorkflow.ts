import type {
  AgentLike,
  AgentGenerateOptions,
} from "../workflows/outcomeWorkflow.js";
import { workflowSchema } from "../planning/schema.js";
import type { Workflow } from "../types.js";

export const WORKFLOW_DESIGNER_SYSTEM_PROMPT = `You are a Smithers workflow designer. Given a description of what someone wants to accomplish, design a multi-step Smithers workflow.

Always output a workflow (never a single task). Break the work into focused, parallel-where-possible tasks.

Rules:
- Use "parallel" nodes for independent work that can run simultaneously
- Use "sequence" nodes for work that depends on prior results
- Write task prompts as clear, specific instructions for a coding agent
- Task names must be unique, lowercase, hyphenated (e.g. "scan-security", "write-summary")
- 2–8 tasks is the ideal range

Node types available:
  task       { type: "task", name: string, prompt: string }
  sequence   { type: "sequence", name?: string, children: WorkflowNode[] }
  parallel   { type: "parallel", name?: string, children: WorkflowNode[] }

Return ONLY this JSON shape:
{
  "name": "kebab-case-workflow-name",
  "description": "One sentence describing what this workflow does.",
  "root": <WorkflowNode>
}`;

export type DesignWorkflowOptions = {
  goal: string;
  context?: string;
  planner: AgentLike;
};

export type DesignWorkflowResult = {
  id: string;
  name: string;
  description: string;
  root: Workflow["root"];
  createdAt: string;
};

export async function designWorkflow(
  options: DesignWorkflowOptions
): Promise<DesignWorkflowResult> {
  const prompt = buildDesignerPrompt(options.goal, options.context);

  let rawText: string | null | undefined;

  const generateOptions: AgentGenerateOptions = {
    prompt: `${WORKFLOW_DESIGNER_SYSTEM_PROMPT}\n\n${prompt}`,
    messages: [{ role: "user", content: prompt }],
    outputSchema: workflowSchema,
  };

  const result = await options.planner.generate(generateOptions);

  rawText = result.text;

  if (!rawText) {
    const output = result.output ?? result._output;
    if (output && typeof output === "object") {
      rawText = JSON.stringify(output);
    }
  }

  if (!rawText) {
    throw new Error("Workflow designer returned no output.");
  }

  const json = extractJson(rawText);
  const parsed = workflowSchema.safeParse(json);

  if (!parsed.success) {
    throw new Error(
      `Workflow designer returned invalid schema: ${parsed.error.message}\n\nRaw output:\n${rawText}`
    );
  }

  const workflow = parsed.data;
  const id = slugify(workflow.name) || `draft-${Date.now()}`;

  return {
    id,
    name: workflow.name,
    description: workflow.description,
    root: workflow.root,
    createdAt: new Date().toISOString(),
  };
}

function buildDesignerPrompt(goal: string, context?: string): string {
  const parts = [`Design a Smithers workflow for:\n${goal}`];
  if (context) parts.push(`Additional context:\n${context}`);
  return parts.join("\n\n");
}

function extractJson(text: string): unknown {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {}

  // Extract first JSON object from text
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  throw new Error("Could not extract valid JSON from designer output.");
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
