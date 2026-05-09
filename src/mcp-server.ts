/**
 * Smithers workflow designer MCP server.
 *
 * Exposes design_workflow, list_workflow_drafts, get_workflow_draft, and
 * update_workflow_draft as MCP tools so any MCP-compatible agent (Claude
 * Desktop, Claude Code, etc.) can design workflows without running the CLI.
 *
 * Run as stdio server:
 *   bun src/mcp-server.ts
 *
 * Or mount via the CLI serve subcommand:
 *   bun src/index.ts serve
 *
 * Cloudflare Code Mode note:
 *   For deployment on Cloudflare Workers with Code Mode (81% token reduction),
 *   replace the stdio transport with a Workers Durable Object transport and
 *   expose a single `execute` tool that runs agent-generated TypeScript in a
 *   V8 isolate. See https://blog.cloudflare.com/code-mode/ for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  designWorkflow,
  WORKFLOW_DESIGNER_SYSTEM_PROMPT,
} from "./app/designWorkflow.js";
import { createDefaultAgent } from "./workflows/outcomeWorkflow.js";
import { listDrafts, getDraft, updateDraft, saveDraft } from "./drafts.js";
import { workflowSchema } from "./planning/schema.js";

const RUNS_DIR = process.env.CUSTOM_HARNESS_RUNS_DIR ?? "runs";
const SERVER_URL =
  process.env.CUSTOM_HARNESS_SERVER_URL ?? "http://localhost:3000";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "custom-harness-workflow-designer",
    version: "0.1.0",
  });

  server.tool(
    "design_workflow",
    `Design a Smithers workflow from a natural-language description.

Returns a workflow draft with an ID and a URL to inspect it in the UI.
The workflow is saved locally and can be modified via update_workflow_draft.

${WORKFLOW_DESIGNER_SYSTEM_PROMPT}`,
    {
      goal: z
        .string()
        .min(1)
        .describe(
          "Natural-language description of what the workflow should accomplish"
        ),
      context: z
        .string()
        .optional()
        .describe("Additional constraints or context (optional)"),
      name: z
        .string()
        .optional()
        .describe("Override the generated workflow name (kebab-case)"),
    },
    async ({ goal, context, name }) => {
      const agent = createDefaultAgent();
      const draft = await designWorkflow({ goal, context, planner: agent });

      const finalDraft = {
        ...draft,
        id: name ? slugify(name) || draft.id : draft.id,
        name: name || draft.name,
        goal,
        context,
      };

      saveDraft(RUNS_DIR, finalDraft);

      const taskCount = countTasks(finalDraft.root);
      const uiUrl = `${SERVER_URL}/drafts/${finalDraft.id}`;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                draftId: finalDraft.id,
                name: finalDraft.name,
                description: finalDraft.description,
                taskCount,
                url: uiUrl,
                workflow: {
                  name: finalDraft.name,
                  description: finalDraft.description,
                  root: finalDraft.root,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "list_workflow_drafts",
    "List all saved workflow drafts. Returns summaries including id, name, description, goal, and createdAt.",
    {},
    async () => {
      const drafts = listDrafts(RUNS_DIR);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, drafts }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_workflow_draft",
    "Get the full details of a workflow draft including its complete node tree.",
    {
      draftId: z
        .string()
        .min(1)
        .describe(
          "The draft ID (from design_workflow or list_workflow_drafts)"
        ),
    },
    async ({ draftId }) => {
      const draft = getDraft(RUNS_DIR, draftId);
      if (!draft) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                error: {
                  kind: "draft-not-found",
                  message: `Draft not found: ${draftId}`,
                  hint: "Call list_workflow_drafts to see available IDs",
                },
              }),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, draft }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "update_workflow_draft",
    `Update an existing workflow draft. You can change name, description, goal, context, or the full workflow root node tree.

The root must be a valid WorkflowNode tree:
  task:     { type, name, prompt }
  sequence: { type, name?, children: WorkflowNode[] }
  parallel: { type, name?, children: WorkflowNode[] }`,
    {
      draftId: z.string().min(1).describe("The draft ID to update"),
      name: z.string().optional().describe("New workflow name"),
      description: z.string().optional().describe("New description"),
      goal: z.string().optional().describe("Updated goal text"),
      context: z.string().optional().describe("Updated context"),
      root: workflowSchema.shape.root
        .optional()
        .describe("New workflow node tree (replaces existing)"),
    },
    async ({ draftId, name, description, goal, context, root }) => {
      const updates = Object.fromEntries(
        Object.entries({ name, description, goal, context, root }).filter(
          ([, v]) => v !== undefined
        )
      );
      const updated = updateDraft(RUNS_DIR, draftId, updates);
      if (!updated) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                error: {
                  kind: "draft-not-found",
                  message: `Draft not found: ${draftId}`,
                  hint: "Call list_workflow_drafts to see available IDs",
                },
              }),
            },
          ],
          isError: true,
        };
      }
      const uiUrl = `${SERVER_URL}/drafts/${updated.id}`;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                draftId: updated.id,
                name: updated.name,
                description: updated.description,
                taskCount: countTasks(updated.root),
                url: uiUrl,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "robot_docs",
    "Return machine-readable documentation for this MCP server: available tools, their schemas, and usage examples. ~200 tokens.",
    {},
    async () => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                server: "custom-harness-workflow-designer",
                purpose:
                  "Design Smithers workflows from natural language; inspect and edit drafts in the UI.",
                tools: [
                  {
                    name: "design_workflow",
                    inputs: ["goal (required)", "context?", "name?"],
                    returns:
                      "draftId, name, description, taskCount, url, workflow",
                  },
                  {
                    name: "list_workflow_drafts",
                    inputs: [],
                    returns:
                      "drafts[]: {id, name, description, goal, createdAt}",
                  },
                  {
                    name: "get_workflow_draft",
                    inputs: ["draftId"],
                    returns: "full draft with root WorkflowNode tree",
                  },
                  {
                    name: "update_workflow_draft",
                    inputs: [
                      "draftId",
                      "name?",
                      "description?",
                      "goal?",
                      "context?",
                      "root?",
                    ],
                    returns: "updated draft summary",
                  },
                ],
                workflow_node_types: [
                  "task: { type: 'task', name: string, prompt: string }",
                  "sequence: { type: 'sequence', name?: string, children: WorkflowNode[] }",
                  "parallel: { type: 'parallel', name?: string, children: WorkflowNode[] }",
                ],
                ui_url: SERVER_URL,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

function countTasks(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const n = node as Record<string, unknown>;
  if (n.type === "task") return 1;
  if (Array.isArray(n.children))
    return (n.children as unknown[]).reduce(
      (s: number, c) => s + countTasks(c),
      0
    );
  return 0;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Run as standalone stdio server when invoked directly
if (import.meta.main) {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdin closes
}
