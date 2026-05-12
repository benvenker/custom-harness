import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { GraphSnapshot } from "@smithers-orchestrator/graph";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { loadSmithersRuntime, loadWorkflow } from "./app/smithersRuntime.js";
import { smithersSnapshotToRenderGraph } from "./runs/smithersGraph.js";
import { buildSmithersWorkflowRunCommand } from "./smithersProject/cli.js";
import { addHistoricalRunView } from "./smithersProject/historicalGraph.js";
import { createSmithersRunReader as defaultCreateSmithersRunReader } from "./smithersProject/runReader.js";
import type {
  GetRunDetailOptions,
  ListEventsOptions,
  ListRunsOptions,
  SmithersRunReader,
} from "./smithersProject/runReaderTypes.js";

type RenderProjectWorkflowGraphFn = (options: {
  projectRoot: string;
  workflowId: string;
  workflowPath: string;
  input?: Record<string, unknown>;
  outputs?: Record<string, unknown[]>;
}) => Promise<GraphSnapshot>;
type RunProjectWorkflowFn = (options: {
  projectRoot: string;
  workflowId: string;
  workflowPath: string;
  input: Record<string, unknown>;
}) => Promise<{ runId: string; status: string }>;

type AuthorWorkflowSourceFn = (options: {
  prompt: string;
  workflowId: string;
  displayName: string;
  model?: string;
  previousSource?: string;
  repairError?: string;
}) => Promise<{ source: string; model: string }>;

type CreateSmithersRunReaderFn = (options: {
  projectRoot: string;
}) => SmithersRunReader | Promise<SmithersRunReader>;

export type HarnessServerOptions = {
  rootDir?: string;
  projectRoot?: string;
  workflowId?: string;
  renderProjectWorkflowGraph?: RenderProjectWorkflowGraphFn;
  runProjectWorkflow?: RunProjectWorkflowFn;
  authorWorkflowSource?: AuthorWorkflowSourceFn;
  createSmithersRunReader?: CreateSmithersRunReaderFn;
};

export function createHarnessServerHandler(options: HarnessServerOptions = {}) {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const projectRoot = resolveProjectRootOption(rootDir, options.projectRoot);
  const defaultWorkflowId = options.workflowId;
  const renderProjectWorkflowGraphFn =
    options.renderProjectWorkflowGraph ?? renderProjectWorkflowGraph;
  const runProjectWorkflowFn = options.runProjectWorkflow ?? runProjectWorkflow;
  const authorWorkflowSourceFn =
    options.authorWorkflowSource ?? authorWorkflowSource;
  const createSmithersRunReaderFn =
    options.createSmithersRunReader ?? defaultCreateSmithersRunReader;

  return async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") return withCors(json({ ok: true }));

      if (url.pathname === "/mcp") {
        return await mcpResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          renderProjectWorkflowGraph: renderProjectWorkflowGraphFn,
          runProjectWorkflow: runProjectWorkflowFn,
          authorWorkflowSource: authorWorkflowSourceFn,
          createSmithersRunReader: createSmithersRunReaderFn,
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/workflows/create-from-prompt"
      ) {
        return await workflowCreateFromPromptResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          renderProjectWorkflowGraph: renderProjectWorkflowGraphFn,
          authorWorkflowSource: authorWorkflowSourceFn,
        });
      }

      const workflowRunCancelMatch = url.pathname.match(
        /^\/api\/workflows\/([^/]+)\/runs\/([^/]+)\/cancel$/
      );
      if (request.method === "POST" && workflowRunCancelMatch) {
        return await workflowRunCancelResponse({
          projectRoot,
          workflowId: decodeURIComponent(workflowRunCancelMatch[1]),
          runId: decodeURIComponent(workflowRunCancelMatch[2]),
        });
      }

      const workflowRunMatch = url.pathname.match(
        /^\/api\/workflows\/([^/]+)\/run$/
      );
      if (request.method === "POST" && workflowRunMatch) {
        return await workflowRunResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          workflowId: decodeURIComponent(workflowRunMatch[1]),
          runProjectWorkflow: runProjectWorkflowFn,
        });
      }

      const workflowSourceFieldMatch = url.pathname.match(
        /^\/api\/workflows\/([^/]+)\/source-field$/
      );
      if (request.method === "PUT" && workflowSourceFieldMatch) {
        return await workflowSourceFieldResponse({
          request,
          projectRoot,
          workflowId: decodeURIComponent(workflowSourceFieldMatch[1]),
        });
      }

      const workflowSourceMatch = url.pathname.match(
        /^\/api\/workflows\/([^/]+)\/source$/
      );
      if (request.method === "PUT" && workflowSourceMatch) {
        return await workflowSourceResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          workflowId: decodeURIComponent(workflowSourceMatch[1]),
          write: true,
        });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }

      if (url.pathname === "/api/project") {
        return json(projectResponse({ projectRoot, defaultWorkflowId }));
      }

      if (url.pathname === "/api/workflows") {
        return json(workflowsResponse({ projectRoot, defaultWorkflowId }));
      }

      if (url.pathname === "/api/openrouter/models") {
        return await openRouterModelsResponse();
      }

      if (url.pathname === "/api/smithers/runs") {
        return await smithersRunsListResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          createSmithersRunReader: createSmithersRunReaderFn,
        });
      }

      const smithersRunEventsMatch = url.pathname.match(
        /^\/api\/smithers\/runs\/([^/]+)\/events$/
      );
      if (smithersRunEventsMatch) {
        return await smithersRunEventsResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          runId: decodeURIComponent(smithersRunEventsMatch[1]),
          createSmithersRunReader: createSmithersRunReaderFn,
        });
      }

      const smithersRunDetailMatch = url.pathname.match(
        /^\/api\/smithers\/runs\/([^/]+)$/
      );
      if (smithersRunDetailMatch) {
        return await smithersRunDetailResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          runId: decodeURIComponent(smithersRunDetailMatch[1]),
          createSmithersRunReader: createSmithersRunReaderFn,
        });
      }

      const graphMatch = url.pathname.match(
        /^\/api\/workflows\/([^/]+)\/graph$/
      );
      if (graphMatch) {
        return await workflowGraphResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          workflowId: decodeURIComponent(graphMatch[1]),
          renderProjectWorkflowGraph: renderProjectWorkflowGraphFn,
        });
      }

      const sourceMatch = url.pathname.match(
        /^\/api\/workflows\/([^/]+)\/source$/
      );
      if (sourceMatch) {
        return await workflowSourceResponse({
          request,
          projectRoot,
          defaultWorkflowId,
          workflowId: decodeURIComponent(sourceMatch[1]),
          write: false,
        });
      }

      if (url.pathname === "/favicon.ico")
        return new Response(null, { status: 204 });
      return staticFileResponse(rootDir, url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof RequestValidationError ? 400 : 500;
      return json({ ok: false, error: message }, status);
    }
  };
}

async function mcpResponse(args: {
  request: Request;
  projectRoot?: string;
  defaultWorkflowId?: string;
  renderProjectWorkflowGraph: RenderProjectWorkflowGraphFn;
  runProjectWorkflow: RunProjectWorkflowFn;
  authorWorkflowSource: AuthorWorkflowSourceFn;
  createSmithersRunReader: CreateSmithersRunReaderFn;
}) {
  await logMcpRequest(args.request);
  const server = createCustomHarnessMcpServer({
    projectRoot: args.projectRoot,
    defaultWorkflowId: args.defaultWorkflowId,
    renderProjectWorkflowGraph: args.renderProjectWorkflowGraph,
    runProjectWorkflow: args.runProjectWorkflow,
    authorWorkflowSource: args.authorWorkflowSource,
    createSmithersRunReader: args.createSmithersRunReader,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(args.request);
    return withCors(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return withCors(
      json(
        {
          jsonrpc: "2.0",
          error: { code: -32603, message },
          id: null,
        },
        500
      )
    );
  }
}

async function logMcpRequest(request: Request) {
  if (request.method !== "POST") {
    console.log("[mcp-request]", request.method, new URL(request.url).pathname);
    return;
  }
  try {
    const body = await request.clone().json();
    const method = isRecord(body) ? body.method : undefined;
    const params =
      isRecord(body) && isRecord(body.params) ? body.params : undefined;
    const name =
      params && typeof params.name === "string" ? params.name : undefined;
    const uri =
      params && typeof params.uri === "string" ? params.uri : undefined;
    console.log(
      "[mcp-request]",
      request.method,
      method ?? "unknown",
      name ? { name } : uri ? { uri } : ""
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("[mcp-request]", request.method, "unparseable", message);
  }
}

function createCustomHarnessMcpServer(args: {
  projectRoot?: string;
  defaultWorkflowId?: string;
  renderProjectWorkflowGraph: RenderProjectWorkflowGraphFn;
  runProjectWorkflow: RunProjectWorkflowFn;
  authorWorkflowSource: AuthorWorkflowSourceFn;
  createSmithersRunReader: CreateSmithersRunReaderFn;
}) {
  const server = new McpServer({
    name: "custom-harness-smithers-workbench",
    version: "0.1.0",
  });
  const resourceUri = MCP_WORKBENCH_RESOURCE_URI;

  registerAppTool(
    server,
    "open_workflow_workbench",
    {
      title: "Open Smithers Workflow Workbench",
      description:
        "Open an interactive MCP App that renders a CustomHarness/Smithers workflow graph.",
      inputSchema: {
        workflowId: z.string().optional(),
        input: z.record(z.string(), z.unknown()).optional(),
      },
      _meta: { ui: { resourceUri } },
    },
    async ({ workflowId, input }): Promise<CallToolResult> => {
      console.log("[mcp-tool] open_workflow_workbench", { workflowId });
      const bootstrap = await mcpWorkbenchBootstrap({
        projectRoot: args.projectRoot,
        defaultWorkflowId: args.defaultWorkflowId,
        workflowId,
        input,
        renderProjectWorkflowGraph: args.renderProjectWorkflowGraph,
      });
      return {
        content: [
          {
            type: "text",
            text: bootstrap.ok
              ? `Opened Smithers workflow workbench for ${bootstrap.workflow?.id ?? "project"}.`
              : `Unable to open Smithers workflow workbench: ${bootstrap.error?.message ?? "unknown error"}`,
          },
        ],
        structuredContent: bootstrap,
        isError: bootstrap.ok ? undefined : true,
      };
    }
  );

  registerAppTool(
    server,
    "create_workflow_from_prompt",
    {
      title: "Create Smithers Workflow From Prompt",
      description:
        "Generate ordinary Smithers TSX Workflow Source from a natural-language workflow description, save it under .smithers/workflows, and render-verify it.",
      inputSchema: {
        prompt: z.string(),
        workflowId: z.string().optional(),
        displayName: z.string().optional(),
        model: z.string().optional(),
        overwrite: z.boolean().optional(),
      },
      _meta: { ui: { resourceUri } },
    },
    async ({
      prompt,
      workflowId,
      displayName,
      model,
      overwrite,
    }): Promise<CallToolResult> => {
      console.log("[mcp-tool] create_workflow_from_prompt", { workflowId });
      const data = await createWorkflowFromPrompt({
        projectRoot: args.projectRoot,
        defaultWorkflowId: args.defaultWorkflowId,
        prompt,
        requestedWorkflowId: workflowId,
        displayName,
        model,
        overwrite,
        renderProjectWorkflowGraph: args.renderProjectWorkflowGraph,
        authorWorkflowSource: args.authorWorkflowSource,
      });
      return {
        content: [
          {
            type: "text",
            text: data.ok
              ? `Created Smithers workflow ${data.workflowId} and ${data.verified ? "render-verified it" : "saved it, but render verification failed"}.`
              : `Unable to create Smithers workflow: ${data.error}`,
          },
        ],
        structuredContent: data,
        isError: data.ok ? undefined : true,
      };
    }
  );

  registerAppTool(
    server,
    "ch_workflow_create_from_prompt",
    {
      title: "Create Workflow From Prompt",
      description:
        "Generate a Smithers workflow from a prompt for the MCP App.",
      inputSchema: {
        prompt: z.string(),
        workflowId: z.string().optional(),
        displayName: z.string().optional(),
        model: z.string().optional(),
        overwrite: z.boolean().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({
      prompt,
      workflowId,
      displayName,
      model,
      overwrite,
    }): Promise<CallToolResult> => {
      console.log("[mcp-tool] ch_workflow_create_from_prompt", { workflowId });
      const data = await createWorkflowFromPrompt({
        projectRoot: args.projectRoot,
        defaultWorkflowId: args.defaultWorkflowId,
        prompt,
        requestedWorkflowId: workflowId,
        displayName,
        model,
        overwrite,
        renderProjectWorkflowGraph: args.renderProjectWorkflowGraph,
        authorWorkflowSource: args.authorWorkflowSource,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        isError: data.ok ? undefined : true,
      };
    }
  );

  registerAppTool(
    server,
    "ch_workflows_list",
    {
      title: "List Workflows",
      description: "List Smithers workflows for the MCP App.",
      inputSchema: {},
      _meta: { ui: { visibility: ["app"] } },
    },
    async (): Promise<CallToolResult> => {
      console.log("[mcp-tool] ch_workflows_list");
      const data = workflowsResponse({
        projectRoot: args.projectRoot,
        defaultWorkflowId: args.defaultWorkflowId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        isError: data.ok ? undefined : true,
      };
    }
  );

  registerAppTool(
    server,
    "ch_workflow_graph_render",
    {
      title: "Render Workflow Graph",
      description: "Render a Smithers workflow graph without executing tasks.",
      inputSchema: {
        workflowId: z.string(),
        input: z.record(z.string(), z.unknown()).optional(),
        outputs: z.record(z.string(), z.array(z.unknown())).optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ workflowId, input, outputs }): Promise<CallToolResult> => {
      console.log("[mcp-tool] ch_workflow_graph_render", { workflowId });
      const data = await mcpRenderWorkflowGraph({
        projectRoot: args.projectRoot,
        defaultWorkflowId: args.defaultWorkflowId,
        workflowId,
        input,
        outputs,
        renderProjectWorkflowGraph: args.renderProjectWorkflowGraph,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        isError: data.ok ? undefined : true,
      };
    }
  );

  registerAppTool(
    server,
    "ch_project_get",
    {
      title: "Get Project",
      description:
        "Get the current CustomHarness Smithers project for the MCP App.",
      inputSchema: {},
      _meta: { ui: { visibility: ["app"] } },
    },
    async (): Promise<CallToolResult> => {
      console.log("[mcp-tool] ch_project_get");
      const data = projectResponse({
        projectRoot: args.projectRoot,
        defaultWorkflowId: args.defaultWorkflowId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        isError: data.ok ? undefined : true,
      };
    }
  );

  registerAppTool(
    server,
    "ch_workflow_source_get",
    {
      title: "Get Workflow Source",
      description: "Read Smithers Workflow Source for the MCP App editor.",
      inputSchema: { workflowId: z.string() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ workflowId }): Promise<CallToolResult> => {
      console.log("[mcp-tool] ch_workflow_source_get", { workflowId });
      const response = await workflowSourceResponse({
        request: new Request(
          `http://custom-harness.local/api/workflows/${encodeURIComponent(workflowId)}/source`
        ),
        projectRoot: args.projectRoot,
        defaultWorkflowId: args.defaultWorkflowId,
        workflowId,
        write: false,
      });
      const data = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        isError: data.ok ? undefined : true,
      };
    }
  );

  registerAppTool(
    server,
    "ch_workflow_source_save",
    {
      title: "Save Workflow Source",
      description:
        "Save the complete Smithers Workflow Source for the MCP App editor.",
      inputSchema: { workflowId: z.string(), source: z.string() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ workflowId, source }): Promise<CallToolResult> => {
      console.log("[mcp-tool] ch_workflow_source_save", { workflowId });
      const response = await workflowSourceResponse({
        request: new Request(
          `http://custom-harness.local/api/workflows/${encodeURIComponent(workflowId)}/source`,
          {
            method: "PUT",
            body: JSON.stringify({ source }),
          }
        ),
        projectRoot: args.projectRoot,
        defaultWorkflowId: args.defaultWorkflowId,
        workflowId,
        write: true,
      });
      const data = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        isError: data.ok ? undefined : true,
      };
    }
  );

  registerAppTool(
    server,
    "ch_workflow_source_field_save",
    {
      title: "Save Workflow Source Field",
      description:
        "Save one editable string field in Smithers Workflow Source for the MCP App editor.",
      inputSchema: {
        workflowId: z.string(),
        sourcePath: z.array(z.string()),
        value: z.string(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ workflowId, sourcePath, value }): Promise<CallToolResult> => {
      console.log("[mcp-tool] ch_workflow_source_field_save", {
        workflowId,
        sourcePath,
      });
      const response = await workflowSourceFieldResponse({
        request: new Request(
          `http://custom-harness.local/api/workflows/${encodeURIComponent(workflowId)}/source-field`,
          {
            method: "PUT",
            body: JSON.stringify({ sourcePath, value }),
          }
        ),
        projectRoot: args.projectRoot,
        workflowId,
      });
      const data = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        isError: data.ok ? undefined : true,
      };
    }
  );

  registerAppTool(
    server,
    "ch_workflow_run_start",
    {
      title: "Start Workflow Run",
      description: "Start a Smithers workflow run from the MCP App.",
      inputSchema: {
        workflowId: z.string(),
        input: z.record(z.string(), z.unknown()).optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ workflowId, input }): Promise<CallToolResult> => {
      console.log("[mcp-tool] ch_workflow_run_start", { workflowId });
      const response = await workflowRunResponse({
        request: new Request(
          `http://custom-harness.local/api/workflows/${encodeURIComponent(workflowId)}/run`,
          {
            method: "POST",
            body: JSON.stringify({ input: input ?? {} }),
          }
        ),
        projectRoot: args.projectRoot,
        defaultWorkflowId: args.defaultWorkflowId,
        workflowId,
        runProjectWorkflow: args.runProjectWorkflow,
      });
      const data = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        isError: data.ok ? undefined : true,
      };
    }
  );

  registerAppTool(
    server,
    "ch_workflow_run_cancel",
    {
      title: "Cancel Workflow Run",
      description: "Cancel an active Smithers workflow run from the MCP App.",
      inputSchema: { workflowId: z.string(), runId: z.string() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ workflowId, runId }): Promise<CallToolResult> => {
      console.log("[mcp-tool] ch_workflow_run_cancel", { workflowId, runId });
      const response = await workflowRunCancelResponse({
        projectRoot: args.projectRoot,
        workflowId,
        runId,
      });
      const data = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        isError: data.ok ? undefined : true,
      };
    }
  );

  registerAppTool(
    server,
    "ch_smithers_runs_list",
    {
      title: "List Smithers Runs",
      description: "List Smithers runs for the MCP App run inspector.",
      inputSchema: {
        limit: z.number().optional(),
        status: z.string().optional(),
        workflowId: z.string().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ limit, status, workflowId }): Promise<CallToolResult> => {
      console.log("[mcp-tool] ch_smithers_runs_list", { workflowId, status });
      const params = new URLSearchParams();
      if (typeof limit === "number") params.set("limit", String(limit));
      if (typeof status === "string") params.set("status", status);
      if (typeof workflowId === "string") params.set("workflowId", workflowId);
      const response = await smithersRunsListResponse({
        request: new Request(
          `http://custom-harness.local/api/smithers/runs?${params}`
        ),
        projectRoot: args.projectRoot,
        defaultWorkflowId: args.defaultWorkflowId,
        createSmithersRunReader: args.createSmithersRunReader,
      });
      const data = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        isError: data.ok ? undefined : true,
      };
    }
  );

  registerAppTool(
    server,
    "ch_smithers_run_detail_get",
    {
      title: "Get Smithers Run Detail",
      description: "Get Smithers run detail for the MCP App run inspector.",
      inputSchema: {
        runId: z.string(),
        eventsAfterSeq: z.number().optional(),
        eventLimit: z.number().optional(),
        frameLimit: z.number().optional(),
        includeOutputs: z.boolean().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({
      runId,
      eventsAfterSeq,
      eventLimit,
      frameLimit,
      includeOutputs,
    }): Promise<CallToolResult> => {
      console.log("[mcp-tool] ch_smithers_run_detail_get", { runId });
      const params = new URLSearchParams();
      if (typeof eventsAfterSeq === "number")
        params.set("eventsAfterSeq", String(eventsAfterSeq));
      if (typeof eventLimit === "number")
        params.set("eventLimit", String(eventLimit));
      if (typeof frameLimit === "number")
        params.set("frameLimit", String(frameLimit));
      if (typeof includeOutputs === "boolean")
        params.set("includeOutputs", String(includeOutputs));
      const response = await smithersRunDetailResponse({
        request: new Request(
          `http://custom-harness.local/api/smithers/runs/${encodeURIComponent(runId)}?${params}`
        ),
        projectRoot: args.projectRoot,
        defaultWorkflowId: args.defaultWorkflowId,
        runId,
        createSmithersRunReader: args.createSmithersRunReader,
      });
      const data = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        isError: data.ok ? undefined : true,
      };
    }
  );

  registerAppTool(
    server,
    "ch_smithers_run_events_list",
    {
      title: "List Smithers Run Events",
      description: "List Smithers run events for the MCP App run inspector.",
      inputSchema: {
        runId: z.string(),
        afterSeq: z.number().optional(),
        limit: z.number().optional(),
        nodeId: z.string().optional(),
        types: z.array(z.string()).optional(),
        sinceTimestampMs: z.number().optional(),
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({
      runId,
      afterSeq,
      limit,
      nodeId,
      types,
      sinceTimestampMs,
    }): Promise<CallToolResult> => {
      console.log("[mcp-tool] ch_smithers_run_events_list", { runId, nodeId });
      const params = new URLSearchParams();
      if (typeof afterSeq === "number")
        params.set("afterSeq", String(afterSeq));
      if (typeof limit === "number") params.set("limit", String(limit));
      if (typeof nodeId === "string") params.set("nodeId", nodeId);
      if (Array.isArray(types)) params.set("types", types.join(","));
      if (typeof sinceTimestampMs === "number")
        params.set("sinceTimestampMs", String(sinceTimestampMs));
      const response = await smithersRunEventsResponse({
        request: new Request(
          `http://custom-harness.local/api/smithers/runs/${encodeURIComponent(runId)}/events?${params}`
        ),
        projectRoot: args.projectRoot,
        defaultWorkflowId: args.defaultWorkflowId,
        runId,
        createSmithersRunReader: args.createSmithersRunReader,
      });
      const data = await response.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        isError: data.ok ? undefined : true,
      };
    }
  );

  registerAppResource(
    server,
    resourceUri,
    resourceUri,
    {
      mimeType: RESOURCE_MIME_TYPE,
      description: "CustomHarness Smithers workflow workbench MCP App",
      _meta: {
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [],
            baseUriDomains: [],
          },
        },
      },
    },
    async (): Promise<ReadResourceResult> => {
      console.log("[mcp-resource] read", resourceUri);
      return {
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: await mcpWorkbenchHtml(),
            _meta: {
              ui: {
                csp: {
                  connectDomains: [],
                  resourceDomains: [],
                  frameDomains: [],
                  baseUriDomains: [],
                },
              },
            },
          },
        ],
      };
    }
  );

  return server;
}

const MCP_WORKBENCH_RESOURCE_URI = "ui://custom-harness/workbench.html";
const MCP_GRAPH_HYDRATION_MAX_BYTES = 250 * 1024;

type NormalizedToolError = {
  code: string;
  message: string;
  retryable?: boolean;
  actionLabel?: string;
  details?: Record<string, unknown>;
};

async function mcpWorkbenchBootstrap(args: {
  projectRoot?: string;
  defaultWorkflowId?: string;
  workflowId?: string;
  input?: Record<string, unknown>;
  renderProjectWorkflowGraph: RenderProjectWorkflowGraphFn;
}): Promise<
  Record<string, unknown> & {
    ok: boolean;
    workflow?: { id?: string; title?: string; path?: string };
    error?: NormalizedToolError;
  }
> {
  const project = projectResponse(args);
  if (!project.ok) {
    return mcpWorkbenchError(
      "PROJECT_SETUP_REQUIRED",
      "error" in project ? project.error : "Project setup failed",
      { project }
    );
  }
  const workflows = workflowsResponse(args);
  if (!workflows.ok) {
    return mcpWorkbenchError(
      "WORKFLOWS_UNAVAILABLE",
      "error" in workflows ? workflows.error : "Workflows unavailable",
      { workflows }
    );
  }
  const selectedWorkflowId =
    args.workflowId ?? args.defaultWorkflowId ?? workflows.workflows[0]?.id;
  const selectedWorkflow = workflows.workflows.find(
    (workflow) => workflow.id === selectedWorkflowId
  );
  const base = {
    contractVersion: 1,
    project: {
      projectRoot: project.projectRoot,
      label:
        project.projectRoot?.split(sep).filter(Boolean).at(-1) ?? "Project",
      defaultWorkflowId: args.defaultWorkflowId,
    },
    workflows: workflows.workflows,
    selectedWorkflowId,
    capabilities: mcpWorkbenchCapabilities(),
  };
  if (!selectedWorkflowId || !selectedWorkflow) {
    return {
      ok: true,
      ...base,
      launch: {
        title: "Smithers workflow workbench",
        subtitle: "No Smithers workflows found yet.",
        status: "empty",
        viewId: mcpWorkbenchViewId(args.projectRoot, undefined),
        resourceUri: MCP_WORKBENCH_RESOURCE_URI,
      },
      workflow: selectedWorkflowId ? { id: selectedWorkflowId } : undefined,
      graphSummary: { nodeCount: 0, edgeCount: 0, hasErrors: false },
      graph: null,
      graphHydration: {
        included: false,
        truncated: false,
        reason: "empty",
        nodeCount: 0,
        edgeCount: 0,
      },
    };
  }
  const rendered = await mcpRenderWorkflowGraph({
    projectRoot: args.projectRoot,
    defaultWorkflowId: args.defaultWorkflowId,
    workflowId: selectedWorkflowId,
    input: args.input,
    renderProjectWorkflowGraph: args.renderProjectWorkflowGraph,
  });
  if (!rendered.ok) {
    const error = normalizeToolError(
      "RENDER_FAILED",
      rendered.error ?? "Workflow graph render failed",
      { workflowId: selectedWorkflowId }
    );
    return {
      ok: false,
      ...base,
      launch: {
        title: "Smithers workflow workbench",
        subtitle: selectedWorkflowId,
        status: "error",
        viewId: mcpWorkbenchViewId(args.projectRoot, selectedWorkflowId),
        resourceUri: MCP_WORKBENCH_RESOURCE_URI,
      },
      workflow: {
        id: selectedWorkflow.id,
        title: selectedWorkflow.id,
        path: selectedWorkflow.path,
      },
      graphSummary: { nodeCount: 0, edgeCount: 0, hasErrors: true },
      graph: null,
      graphHydration: {
        included: false,
        truncated: false,
        reason: "error",
        nodeCount: 0,
        edgeCount: 0,
      },
      error,
    };
  }
  const graphSummary = summarizeRenderGraph(rendered.graph);
  const graphBytes = byteLengthJson(rendered.graph);
  const includeGraph = graphBytes <= MCP_GRAPH_HYDRATION_MAX_BYTES;
  return {
    ok: true,
    ...base,
    launch: {
      title: "Smithers workflow workbench",
      subtitle: `${selectedWorkflowId} · ${graphSummary.nodeCount} nodes`,
      status: graphSummary.hasErrors ? "verification_failed" : "ready",
      viewId: mcpWorkbenchViewId(args.projectRoot, selectedWorkflowId),
      resourceUri: MCP_WORKBENCH_RESOURCE_URI,
    },
    workflow: {
      id: selectedWorkflow.id,
      title: rendered.graph?.title ?? selectedWorkflow.id,
      path: selectedWorkflow.path,
    },
    graphSummary,
    graph: includeGraph ? rendered.graph : null,
    graphHydration: {
      included: includeGraph,
      truncated: !includeGraph,
      reason: includeGraph ? "ok" : "too_large",
      bytes: graphBytes,
      nodeCount: graphSummary.nodeCount,
      edgeCount: graphSummary.edgeCount,
    },
  };
}

function mcpWorkbenchError(
  code: string,
  message: string,
  details?: Record<string, unknown>
) {
  return {
    ok: false as const,
    contractVersion: 1,
    launch: {
      title: "Smithers workflow workbench",
      status: "error",
      viewId: mcpWorkbenchViewId(undefined, undefined),
      resourceUri: MCP_WORKBENCH_RESOURCE_URI,
    },
    graphSummary: { nodeCount: 0, edgeCount: 0, hasErrors: true },
    capabilities: mcpWorkbenchCapabilities(),
    error: normalizeToolError(code, message, details),
  };
}

function mcpWorkbenchCapabilities() {
  return {
    canRenderGraph: true,
    canCreateWorkflow: true,
    canEditSource: true,
    canStartRun: true,
    canInspectRuns: true,
  };
}

function summarizeRenderGraph(graph: unknown) {
  const record = isRecord(graph) ? graph : {};
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  const edges = Array.isArray(record.edges) ? record.edges : [];
  return {
    title: typeof record.title === "string" ? record.title : undefined,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    defaultSelectedNodeId:
      typeof record.defaultSelected === "string"
        ? record.defaultSelected
        : undefined,
    hasErrors: nodes.some(
      (node) =>
        isRecord(node) &&
        typeof node.status === "string" &&
        /error|failed/i.test(node.status)
    ),
  };
}

function byteLengthJson(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function mcpWorkbenchViewId(
  projectRoot?: string,
  workflowId?: string,
  runId = "preview"
) {
  return `custom-harness:${stableHash(projectRoot ?? "no-project")}:${workflowId ?? "none"}:${runId}`;
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeToolError(
  code: string,
  message: string,
  details?: Record<string, unknown>
): NormalizedToolError {
  return { code, message, retryable: true, details };
}

async function mcpRenderWorkflowGraph(args: {
  projectRoot?: string;
  defaultWorkflowId?: string;
  workflowId: string;
  input?: Record<string, unknown>;
  outputs?: Record<string, unknown[]>;
  renderProjectWorkflowGraph: RenderProjectWorkflowGraphFn;
}) {
  const request = new Request(
    `http://custom-harness.local/api/workflows/${encodeURIComponent(args.workflowId)}/graph?input=${encodeURIComponent(JSON.stringify(args.input ?? {}))}&outputs=${encodeURIComponent(JSON.stringify(args.outputs ?? {}))}`
  );
  const response = await workflowGraphResponse({
    request,
    projectRoot: args.projectRoot,
    defaultWorkflowId: args.defaultWorkflowId,
    workflowId: args.workflowId,
    renderProjectWorkflowGraph: args.renderProjectWorkflowGraph,
  });
  return await response.json();
}

let cachedMcpWorkbenchHtml: string | null = null;
async function mcpWorkbenchHtml() {
  if (process.env.NODE_ENV === "production" && cachedMcpWorkbenchHtml) {
    return cachedMcpWorkbenchHtml;
  }
  const entrypoint = join(import.meta.dirname, "mcp", "workbenchApp.ts");
  const output = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!output.success) {
    const message = output.logs.map((log) => log.message).join("\n");
    throw new Error(`MCP workbench app build failed: ${message}`);
  }
  const script = await output.outputs[0].text();
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CustomHarness Smithers Workbench</title>
<style>
  :root { color-scheme: light dark; --bg: var(--color-background-primary, #101010); --panel: var(--color-background-secondary, #181818); --text: var(--color-text-primary, #f4f4f4); --muted: var(--color-text-secondary, #a2a2a2); --border: var(--color-border-primary, #333); --accent: var(--color-accent-primary, #8ab4ff); --danger: #ff6b6b; --ok: #63d297; font-family: var(--font-sans, Inter, system-ui, sans-serif); }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); }
  button, select, textarea { font: inherit; }
  .loading { padding: 20px; color: var(--muted); }
  .loading.error, .status.error { color: var(--danger); }
  .shell { min-height: 100vh; display: flex; flex-direction: column; gap: 12px; padding: 16px; }
  header { display: flex; justify-content: space-between; gap: 16px; align-items: start; border-bottom: 1px solid var(--border); padding-bottom: 12px; }
  h1 { margin: 2px 0 4px; font-size: 20px; line-height: 1.1; }
  h2 { margin: 4px 0 8px; font-size: 18px; }
  p { margin: 0; color: var(--muted); font-size: 12px; }
  .eyebrow { color: var(--muted); text-transform: uppercase; letter-spacing: .08em; font-size: 11px; }
  .toolbar { display: grid; grid-template-columns: minmax(160px, 220px) minmax(260px, 1fr) auto minmax(120px, auto); gap: 10px; align-items: end; }
  .creator { grid-template-columns: minmax(260px, 1fr) auto minmax(120px, auto); }
  label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
  select, textarea, button { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); color: var(--text); padding: 8px 10px; }
  textarea { resize: vertical; min-height: 54px; font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace); font-size: 12px; }
  button { cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.ghost { background: transparent; }
  .status { align-self: center; font-size: 12px; color: var(--muted); }
  .status.ok { color: var(--ok); }
  .workspace { min-height: 620px; display: grid; grid-template-columns: minmax(520px, 1fr) minmax(300px, 380px); gap: 12px; }
  .canvas, .inspector { border: 1px solid var(--border); border-radius: 14px; background: color-mix(in srgb, var(--panel) 92%, transparent); overflow: hidden; }
  .canvas-title { padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
  .graph { position: relative; min-height: 560px; overflow: auto; }
  .node { position: absolute; width: 250px; min-height: 118px; display: grid; gap: 5px; text-align: left; border-radius: 12px; }
  .node.selected { outline: 2px solid var(--accent); }
  .node-kicker, small { color: var(--muted); font-size: 11px; }
  .node strong { font-size: 16px; }
  .inspector { padding: 14px; overflow: auto; }
  .inspector pre { max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-word; padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace); font-size: 12px; }
  .subtle, .empty { color: var(--muted); }
  body[data-display-mode="fullscreen"] .workspace { min-height: calc(100vh - 180px); }
  @media (max-width: 860px) { .toolbar, .workspace { grid-template-columns: 1fr; } .graph { min-height: 520px; } }
</style>
</head>
<body><div id="root"></div><script type="module">${script}</script></body>
</html>`;
  if (process.env.NODE_ENV === "production") cachedMcpWorkbenchHtml = html;
  return html;
}

function withCors(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "content-type, mcp-session-id, mcp-protocol-version, last-event-id"
  );
  headers.set("access-control-expose-headers", "mcp-session-id");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function projectResponse(args: {
  projectRoot?: string;
  defaultWorkflowId?: string;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return setup;
  return {
    ok: true,
    projectRoot: setup.projectRoot,
    smithersDir: setup.smithersDir,
    defaultWorkflowId: args.defaultWorkflowId,
  };
}

function workflowsResponse(args: {
  projectRoot?: string;
  defaultWorkflowId?: string;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return setup;
  return {
    ok: true,
    projectRoot: setup.projectRoot,
    smithersDir: setup.smithersDir,
    defaultWorkflowId: args.defaultWorkflowId,
    workflows: discoverProjectWorkflows(setup.projectRoot),
  };
}

async function workflowCreateFromPromptResponse(args: {
  request: Request;
  projectRoot?: string;
  defaultWorkflowId?: string;
  renderProjectWorkflowGraph: RenderProjectWorkflowGraphFn;
  authorWorkflowSource: AuthorWorkflowSourceFn;
}) {
  const body = await readJsonBody(args.request);
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return json({ ok: false, error: "prompt must be a non-empty string" }, 400);
  }
  const data = await createWorkflowFromPrompt({
    projectRoot: args.projectRoot,
    defaultWorkflowId: args.defaultWorkflowId,
    prompt: body.prompt,
    requestedWorkflowId:
      typeof body.workflowId === "string" ? body.workflowId : undefined,
    displayName:
      typeof body.displayName === "string" ? body.displayName : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    overwrite: body.overwrite === true,
    renderProjectWorkflowGraph: args.renderProjectWorkflowGraph,
    authorWorkflowSource: args.authorWorkflowSource,
  });
  return json(data, data.ok ? (data.verified ? 201 : 202) : 400);
}

async function createWorkflowFromPrompt(args: {
  projectRoot?: string;
  defaultWorkflowId?: string;
  prompt: string;
  requestedWorkflowId?: string;
  displayName?: string;
  model?: string;
  overwrite?: boolean;
  renderProjectWorkflowGraph: RenderProjectWorkflowGraphFn;
  authorWorkflowSource: AuthorWorkflowSourceFn;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return setup;
  const prompt = args.prompt.trim();
  if (!prompt) return { ok: false, error: "prompt must be a non-empty string" };
  let workflowId: string;
  try {
    workflowId = resolveWorkflowId({
      projectRoot: setup.projectRoot,
      requestedWorkflowId: args.requestedWorkflowId,
      prompt,
      overwrite: Boolean(args.overwrite),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
  const displayName =
    normalizeDisplayName(args.displayName) ?? titleFromWorkflowId(workflowId);
  const workflowPath = join(
    setup.projectRoot,
    ".smithers",
    "workflows",
    `${workflowId}.tsx`
  );
  const attempts: Array<{
    kind: "generate" | "validate" | "repair" | "verify";
    ok: boolean;
    model?: string;
    error?: string;
  }> = [];

  const authorModel = normalizeOpenRouterModelId(args.model);
  let authored: { source: string; model: string };
  try {
    authored = await args.authorWorkflowSource({
      prompt,
      workflowId,
      displayName,
      model: authorModel,
    });
    authored.source = extractWorkflowSource(
      authored.source,
      workflowId,
      displayName
    );
    attempts.push({ kind: "generate", ok: true, model: authored.model });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    attempts.push({ kind: "generate", ok: false, error: message });
    return {
      ok: false,
      error: message,
      workflowId,
      displayName,
      workflowPath,
      attempts,
    };
  }

  let currentSource = authored.source;
  let validationError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const issues = generatedWorkflowSourceValidationIssues(
      currentSource,
      prompt
    );
    if (!issues.length) {
      attempts.push({ kind: "validate", ok: true });
      validationError = undefined;
      break;
    }
    validationError = workflowSourceValidationFeedback(issues);
    attempts.push({ kind: "validate", ok: false, error: validationError });
    try {
      const repaired = await args.authorWorkflowSource({
        prompt,
        workflowId,
        displayName,
        model: authorModel,
        previousSource: currentSource,
        repairError: validationError,
      });
      currentSource = extractWorkflowSource(
        repaired.source,
        workflowId,
        displayName
      );
      attempts.push({ kind: "repair", ok: true, model: repaired.model });
    } catch (repairError) {
      const message =
        repairError instanceof Error
          ? repairError.message
          : String(repairError);
      attempts.push({ kind: "repair", ok: false, error: message });
      break;
    }
  }
  if (validationError) {
    return {
      ok: false,
      error: validationError,
      workflowId,
      displayName,
      workflowPath,
      attempts,
    };
  }

  mkdirSync(join(setup.projectRoot, ".smithers", "workflows"), {
    recursive: true,
  });
  atomicWriteFile(workflowPath, currentSource);
  let graph: unknown = null;
  let verified = false;
  let verificationError: string | undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const snapshot = await args.renderProjectWorkflowGraph({
        projectRoot: setup.projectRoot,
        workflowId,
        workflowPath,
        input: { prompt },
        outputs: {},
      });
      graph = smithersSnapshotToRenderGraph({
        snapshot,
        goal: prompt,
        path: "workflow",
        reason:
          "Generated Smithers Workflow Source render-verified without executing tasks.",
        runId: snapshot.runId,
        planningLatencyMs: null,
        tokens: null,
        submittedAt: new Date(),
      });
      applyProjectWorkflowInputNode(
        graph as ReturnType<typeof smithersSnapshotToRenderGraph>,
        workflowId,
        { prompt }
      );
      verified = true;
      verificationError = undefined;
      attempts.push({ kind: "verify", ok: true });
      break;
    } catch (error) {
      verificationError =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      attempts.push({ kind: "verify", ok: false, error: verificationError });
      if (attempt >= 2) break;
      try {
        const repaired = await args.authorWorkflowSource({
          prompt,
          workflowId,
          displayName,
          model: authorModel,
          previousSource: currentSource,
          repairError: verificationError,
        });
        currentSource = extractWorkflowSource(
          repaired.source,
          workflowId,
          displayName
        );
        atomicWriteFile(workflowPath, currentSource);
        attempts.push({ kind: "repair", ok: true, model: repaired.model });
      } catch (repairError) {
        const message =
          repairError instanceof Error
            ? repairError.message
            : String(repairError);
        attempts.push({ kind: "repair", ok: false, error: message });
        break;
      }
    }
  }

  const tracePath = writeWorkflowCreationTrace({
    projectRoot: setup.projectRoot,
    workflowId,
    displayName,
    prompt,
    model: authored.model,
    workflowPath,
    attempts,
    verified,
    verificationError,
  });

  return {
    ok: true,
    workflowId,
    displayName,
    workflowPath,
    tracePath,
    verified,
    verificationError,
    attempts,
    graph,
    source: currentSource,
  };
}

function resolveWorkflowId(args: {
  projectRoot: string;
  requestedWorkflowId?: string;
  prompt: string;
  overwrite: boolean;
}) {
  const base = args.requestedWorkflowId
    ? normalizeWorkflowId(args.requestedWorkflowId)
    : normalizeWorkflowId(args.prompt) || "generated-workflow";
  if (!base) throw new RequestValidationError("workflowId is invalid");
  const workflowsDir = join(args.projectRoot, ".smithers", "workflows");
  const pathFor = (id: string) => join(workflowsDir, `${id}.tsx`);
  if (args.requestedWorkflowId) {
    if (!args.overwrite && existsSync(pathFor(base))) {
      throw new RequestValidationError(
        `Workflow already exists: ${base}. Pass overwrite=true or choose a new workflowId.`
      );
    }
    return base;
  }
  if (args.overwrite || !existsSync(pathFor(base))) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existsSync(pathFor(candidate))) return candidate;
  }
  throw new RequestValidationError(
    `Could not allocate a workflow id for ${base}`
  );
}

function normalizeWorkflowId(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
}

function normalizeDisplayName(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 80) : undefined;
}

function normalizeOpenRouterModelId(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const withoutProviderPrefix = trimmed.replace(/^openrouter\//i, "");
  const lower = withoutProviderPrefix.toLowerCase();
  if (/\bopus\b/.test(lower) && /4[\s.-]*6/.test(lower)) {
    return lower.includes("fast")
      ? "anthropic/claude-opus-4.6-fast"
      : "anthropic/claude-opus-4.6";
  }
  if (/\bsonnet\b/.test(lower) && /4[\s.-]*6/.test(lower)) {
    return "anthropic/claude-sonnet-4.6";
  }
  if (/\bgpt\b/.test(lower) && /5[\s.-]*5/.test(lower)) {
    return lower.includes("pro") ? "openai/gpt-5.5-pro" : "openai/gpt-5.5";
  }
  if (/\bgemini\b/.test(lower) && /3[\s.-]*1/.test(lower)) {
    return "google/gemini-3.1-pro-preview";
  }
  const aliases: Record<string, string> = {
    "anthropic/opus-4.6": "anthropic/claude-opus-4.6",
    "anthropic/opus-4.6-fast": "anthropic/claude-opus-4.6-fast",
    "anthropic/sonnet-4.6": "anthropic/claude-sonnet-4.6",
  };
  return aliases[withoutProviderPrefix] ?? withoutProviderPrefix;
}

function requestedThinking(value: string) {
  const lower = value.toLowerCase();
  if (/\bx[-\s]?high\b|\bextra[-\s]?high\b/.test(lower)) return "xhigh";
  if (/\bhigh\b/.test(lower)) return "high";
  if (/\bmedium\b/.test(lower)) return "medium";
  if (/\blow\b/.test(lower)) return "low";
  if (/\bminimal\b/.test(lower)) return "minimal";
  return undefined;
}

function titleFromWorkflowId(workflowId: string) {
  return workflowId
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function atomicWriteFile(path: string, source: string) {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  writeFileSync(tempPath, source);
  renameSync(tempPath, path);
}

function extractWorkflowSource(
  source: string,
  workflowId: string,
  displayName: string
) {
  const fence = /```(?:tsx|typescript|ts|jsx)?\s*([\s\S]*?)```/i.exec(source);
  const extracted = (fence ? fence[1] : source).trim();
  if (
    !extracted.includes("createSmithers") ||
    !extracted.includes("export default")
  ) {
    throw new RequestValidationError(
      "Generated content did not look like Smithers TSX Workflow Source"
    );
  }
  const header = `// smithers-source: generated\n// smithers-display-name: ${displayName}\n`;
  const withoutDuplicateHeader = extracted.replace(
    /^(?:\/\/ smithers-source:.*\n)?(?:\/\/ smithers-display-name:.*\n)?/,
    ""
  );
  const withHeader = `${header}${withoutDuplicateHeader}`;
  return withHeader.includes("/** @jsxImportSource smithers-orchestrator */")
    ? withHeader.endsWith("\n")
      ? withHeader
      : `${withHeader}\n`
    : `${header}/** @jsxImportSource smithers-orchestrator */\n${withoutDuplicateHeader}\n`;
}

function generatedWorkflowSourceValidationIssues(
  source: string,
  request: string
) {
  const issues: string[] = [];
  const lowerRequest = request.toLowerCase();
  const requestedOpenRouter = lowerRequest.includes("openrouter");
  if (requestedOpenRouter && !hasSourceString(source, "openrouter")) {
    issues.push(
      'The user requested OpenRouter. Every PiAgent for those requested models must use provider: "openrouter".'
    );
  }
  if (source.includes('"openrouter/') || source.includes("'openrouter/")) {
    issues.push(
      'Do not put the "openrouter/" prefix in PiAgent model values. Keep provider: "openrouter" and use model ids like "openai/gpt-5.5".'
    );
  }
  if (
    mentionsModel(lowerRequest, "opus", "4.6") &&
    !source.includes("anthropic/claude-opus-4.6")
  ) {
    issues.push(
      'The request mentions Opus 4.6 on OpenRouter. Use provider: "openrouter" and model: "anthropic/claude-opus-4.6".'
    );
  }
  if (
    mentionsModel(lowerRequest, "sonnet", "4.6") &&
    !source.includes("anthropic/claude-sonnet-4.6")
  ) {
    issues.push(
      'The request mentions Sonnet 4.6 on OpenRouter. Use provider: "openrouter" and model: "anthropic/claude-sonnet-4.6".'
    );
  }
  if (
    mentionsModel(lowerRequest, "gpt", "5.5") &&
    !source.includes("openai/gpt-5.5")
  ) {
    issues.push(
      'The request mentions GPT-5.5 on OpenRouter. Use provider: "openrouter" and model: "openai/gpt-5.5".'
    );
  }
  const thinking = requestedThinking(request);
  if (thinking && !hasSourceString(source, thinking)) {
    issues.push(
      `The request asks for thinking ${thinking}. Add thinking: "${thinking}" to the relevant PiAgent options.`
    );
  }
  if (/ctx\.latest\(\s*["'][^"']+["']\s*\)/.test(source)) {
    issues.push(
      'ctx.latest requires both a schema key and node id: ctx.latest("schemaKey", "node-id").'
    );
  }
  if (/ctx\.iterationCount\(\s*["'][^"']+["']\s*\)/.test(source)) {
    issues.push(
      'ctx.iterationCount requires both a schema key and node id: ctx.iterationCount("schemaKey", "node-id").'
    );
  }
  if (/<Loop[\s\S]*?until=\{\s*\(/.test(source)) {
    issues.push(
      'Loop until must be a boolean expression from ctx state, for example until={ctx.outputMaybe("review", { nodeId: "review" })?.approved === true}; do not pass a callback function.'
    );
  }
  return issues;
}

function workflowSourceValidationFeedback(issues: string[]) {
  return `Generated workflow source failed CustomHarness validation. Repair the TSX source using these exact hints:\n\n${issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}\n\nReturn only the complete repaired TSX source file.`;
}

function hasSourceString(source: string, value: string) {
  return source.includes(`"${value}"`) || source.includes(`'${value}'`);
}

function mentionsModel(text: string, family: string, version: string) {
  return text.includes(family) && text.includes(version);
}

function writeWorkflowCreationTrace(args: {
  projectRoot: string;
  workflowId: string;
  displayName: string;
  prompt: string;
  model: string;
  workflowPath: string;
  attempts: Array<{
    kind: string;
    ok: boolean;
    model?: string;
    error?: string;
  }>;
  verified: boolean;
  verificationError?: string;
}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const traceDir = join(
    args.projectRoot,
    ".smithers",
    "workbench",
    "creation-traces",
    args.workflowId
  );
  mkdirSync(traceDir, { recursive: true });
  const tracePath = join(traceDir, `${timestamp}.md`);
  const attempts = args.attempts
    .map(
      (attempt, index) =>
        `| ${index + 1} | ${attempt.kind} | ${attempt.ok ? "ok" : "failed"} | ${attempt.model ?? ""} | ${escapeMarkdownTable(attempt.error ?? "")} |`
    )
    .join("\n");
  writeFileSync(
    tracePath,
    `# Workflow creation trace: ${args.workflowId}\n\n` +
      `- Display name: ${args.displayName}\n` +
      `- Workflow path: ${args.workflowPath}\n` +
      `- Model: ${args.model}\n` +
      `- Verified: ${args.verified}\n\n` +
      `## Original request\n\n${args.prompt}\n\n` +
      `## Attempts\n\n| # | Kind | Status | Model | Error |\n|---:|---|---|---|---|\n${attempts}\n\n` +
      (args.verificationError
        ? `## Final verification error\n\n\`\`\`\n${args.verificationError}\n\`\`\`\n`
        : "")
  );
  return tracePath;
}

function escapeMarkdownTable(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").slice(0, 2000);
}

async function smithersRunsListResponse(args: {
  request: Request;
  projectRoot?: string;
  defaultWorkflowId?: string;
  createSmithersRunReader: CreateSmithersRunReaderFn;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  return await withSmithersRunReader(
    setup.projectRoot,
    args.createSmithersRunReader,
    async (reader) => {
      const url = new URL(args.request.url);
      const options: ListRunsOptions = compactOptions({
        limit: parseIntegerParam(url.searchParams, "limit", {
          min: 1,
          max: 500,
        }),
        status: stringParam(url.searchParams, "status"),
        workflowId: stringParam(url.searchParams, "workflowId"),
      });
      const runs = await reader.listRuns(options);
      return json({ ok: true, runs });
    }
  );
}

async function smithersRunDetailResponse(args: {
  request: Request;
  projectRoot?: string;
  defaultWorkflowId?: string;
  runId: string;
  createSmithersRunReader: CreateSmithersRunReaderFn;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  return await withSmithersRunReader(
    setup.projectRoot,
    args.createSmithersRunReader,
    async (reader) => {
      const url = new URL(args.request.url);
      const eventsAfterSeq =
        parseIntegerParam(url.searchParams, "eventsAfterSeq", {
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        }) ??
        parseIntegerParam(url.searchParams, "afterSeq", {
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        });
      const options: GetRunDetailOptions = compactOptions({
        eventsAfterSeq,
        eventLimit: parseIntegerParam(url.searchParams, "eventLimit", {
          min: 1,
          max: 1000,
        }),
        frameLimit: parseIntegerParam(url.searchParams, "frameLimit", {
          min: 1,
          max: 100,
        }),
        includeOutputs: booleanParam(url.searchParams, "includeOutputs"),
      });
      const detail = await reader.getRunDetail(args.runId, options);
      if (!detail) {
        return json(
          {
            ok: false,
            error: `Smithers run not found: ${args.runId}`,
            code: "SMITHERS_RUN_NOT_FOUND",
          },
          404
        );
      }
      return json({ ok: true, detail: addHistoricalRunView(detail) });
    }
  );
}

async function smithersRunEventsResponse(args: {
  request: Request;
  projectRoot?: string;
  defaultWorkflowId?: string;
  runId: string;
  createSmithersRunReader: CreateSmithersRunReaderFn;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  return await withSmithersRunReader(
    setup.projectRoot,
    args.createSmithersRunReader,
    async (reader) => {
      const url = new URL(args.request.url);
      const options: ListEventsOptions = compactOptions({
        afterSeq: parseIntegerParam(url.searchParams, "afterSeq", {
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        }),
        limit: parseIntegerParam(url.searchParams, "limit", {
          min: 1,
          max: 1000,
        }),
        nodeId: stringParam(url.searchParams, "nodeId"),
        types: csvParam(url.searchParams, "types"),
        sinceTimestampMs: parseIntegerParam(
          url.searchParams,
          "sinceTimestampMs",
          { min: 0, max: Number.MAX_SAFE_INTEGER }
        ),
      });
      const result = await reader.listEvents(args.runId, options);
      return json({ ok: true, ...result });
    }
  );
}

async function withSmithersRunReader(
  projectRoot: string,
  createSmithersRunReader: CreateSmithersRunReaderFn,
  callback: (reader: SmithersRunReader) => Promise<Response>
) {
  const reader = await createSmithersRunReader({ projectRoot });
  try {
    return await callback(reader);
  } finally {
    reader.close();
  }
}

function projectSetup(args: {
  projectRoot?: string;
  defaultWorkflowId?: string;
}) {
  if (!args.projectRoot) {
    return {
      ok: false as const,
      status: "setup-needed",
      error: "Missing --project for project workflow viewer",
    };
  }
  const smithersDir = join(args.projectRoot, ".smithers");
  if (!existsSync(smithersDir)) {
    return {
      ok: false as const,
      status: "setup-needed",
      projectRoot: args.projectRoot,
      smithersDir,
      defaultWorkflowId: args.defaultWorkflowId,
      error: `Smithers setup needed: ${smithersDir} does not exist`,
    };
  }
  return { ok: true as const, projectRoot: args.projectRoot, smithersDir };
}

function discoverProjectWorkflows(projectRoot: string) {
  const workflowsDir = join(projectRoot, ".smithers", "workflows");
  if (!existsSync(workflowsDir)) return [];
  return readdirSync(workflowsDir)
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => file.slice(0, -".tsx".length))
    .filter((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id, path: join(workflowsDir, `${id}.tsx`) }));
}

async function workflowGraphResponse(args: {
  request: Request;
  projectRoot?: string;
  defaultWorkflowId?: string;
  workflowId: string;
  renderProjectWorkflowGraph: RenderProjectWorkflowGraphFn;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  const workflow = discoverProjectWorkflows(setup.projectRoot).find(
    (candidate) => candidate.id === args.workflowId
  );
  if (!workflow)
    return json(
      { ok: false, error: `Workflow not found: ${args.workflowId}` },
      404
    );

  const url = new URL(args.request.url);
  const inputParam = url.searchParams.get("input");
  const outputsParam = url.searchParams.get("outputs");
  const input = inputParam ? parseJsonObject(inputParam, "input") : {};
  const outputs = outputsParam ? parseJsonOutputs(outputsParam) : {};
  console.log("[project-graph]", workflow.id, input, outputs);
  const snapshot = await args.renderProjectWorkflowGraph({
    projectRoot: setup.projectRoot,
    workflowId: workflow.id,
    workflowPath: workflow.path,
    input,
    outputs,
  });
  const graph = smithersSnapshotToRenderGraph({
    snapshot,
    goal: projectInputPrompt(input) || `No initial workflow prompt yet.`,
    path: "workflow",
    reason: "Rendered Smithers workflow graph without executing tasks.",
    runId: snapshot.runId,
    planningLatencyMs: null,
    tokens: null,
    submittedAt: new Date(),
  });
  applyProjectWorkflowInputNode(graph, workflow.id, input);
  return json({
    ok: true,
    workflowId: workflow.id,
    workflowPath: workflow.path,
    graph,
  });
}

function projectInputPrompt(input: Record<string, unknown>) {
  const prompt = input.prompt ?? input.request;
  return typeof prompt === "string" ? prompt.trim() : "";
}

function applyProjectWorkflowInputNode(
  graph: ReturnType<typeof smithersSnapshotToRenderGraph>,
  workflowId: string,
  input: Record<string, unknown>
) {
  const prompt = projectInputPrompt(input);
  const inputNode = graph.nodes.find((node) => node.id === "goal");
  if (!inputNode) return;
  inputNode.title = "Initial workflow prompt";
  inputNode.agent = "ctx.input.prompt";
  inputNode.prompt =
    prompt ||
    "No initial workflow prompt yet. Select this node to add runtime input.";
  inputNode.smithers = {
    kind: "input",
    tag: "custom-harness:workflow-input",
    props: { workflowId },
  };
  graph.goal = inputNode.prompt;
  graph.defaultSelected = "goal";
}

async function workflowSourceFieldResponse(args: {
  request: Request;
  projectRoot?: string;
  workflowId: string;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  const workflow = discoverProjectWorkflows(setup.projectRoot).find(
    (candidate) => candidate.id === args.workflowId
  );
  if (!workflow)
    return json(
      { ok: false, error: `Workflow not found: ${args.workflowId}` },
      404
    );
  const body = await readJsonBody(args.request);
  const sourcePath = body.sourcePath;
  const value = body.value;
  if (
    !Array.isArray(sourcePath) ||
    sourcePath.length < 2 ||
    !sourcePath.every(
      (part) => typeof part === "string" && /^[a-zA-Z0-9_-]+$/.test(part)
    )
  ) {
    return json(
      {
        ok: false,
        error: "sourcePath must be an array of safe string segments",
      },
      400
    );
  }
  if (typeof value !== "string")
    return json({ ok: false, error: "value must be a string" }, 400);

  const source = readFileSync(workflow.path, "utf8");
  const nextSource = replaceEditableStringValue(
    source,
    sourcePath as string[],
    value
  );
  if (readEditableStringValue(nextSource, sourcePath as string[]) !== value) {
    throw new RequestValidationError(
      `Structured save did not update ${sourcePath.join(".")}`
    );
  }
  writeFileSync(workflow.path, nextSource);
  return json({
    ok: true,
    workflowId: workflow.id,
    workflowPath: workflow.path,
    sourcePath,
    value,
  });
}

function readEditableStringValue(source: string, sourcePath: string[]) {
  const target = findEditableStringTarget(source, sourcePath);
  return unescapeQuotedString(source.slice(target.valueStart, target.valueEnd));
}

function replaceEditableStringValue(
  source: string,
  sourcePath: string[],
  value: string
) {
  const target = findEditableStringTarget(source, sourcePath);
  return `${source.slice(0, target.valueStart)}${escapeForQuotedString(value, target.quote)}${source.slice(target.valueEnd)}`;
}

function findEditableStringTarget(source: string, sourcePath: string[]) {
  if (sourcePath.length < 2) {
    throw new RequestValidationError(
      "sourcePath must point at a string under the editable object"
    );
  }
  let block = findEditableObjectBlock(source, sourcePath[0]);
  for (const segment of sourcePath.slice(1, -1)) {
    block = findObjectProperty(block, segment);
  }
  return findStringProperty(block, sourcePath[sourcePath.length - 1]);
}

function findStringProperty(
  block: { source: string; start: number; end: number; body: string },
  propertyName: string
) {
  const propertyMatch = new RegExp(
    escapeRegExp(propertyName) + "\\s*:\\s*([\\\"'`])",
    "m"
  ).exec(block.body);
  if (!propertyMatch || propertyMatch.index === undefined) {
    throw new RequestValidationError(
      `Could not find string property ${propertyName} in editable workflow source`
    );
  }
  const quote = propertyMatch[1];
  const quoteStart =
    block.start + 1 + propertyMatch.index + propertyMatch[0].lastIndexOf(quote);
  const valueStart = quoteStart + 1;
  const valueEnd = findClosingQuote(block.source, quoteStart, quote);
  return { quote, valueStart, valueEnd };
}

function findClosingQuote(source: string, quoteStart: number, quote: string) {
  let escaped = false;
  for (let index = quoteStart + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === quote) {
      return index;
    }
  }
  throw new RequestValidationError(
    "Could not parse editable string in workflow source"
  );
}

function findEditableObjectBlock(source: string, propertyName: string) {
  const editableIndex = source.indexOf("const editable");
  if (editableIndex < 0)
    throw new RequestValidationError(
      "Could not find editable object in workflow source"
    );
  const propertyMatch = new RegExp(
    `${escapeRegExp(propertyName)}\\s*:\\s*\\{`,
    "m"
  ).exec(source.slice(editableIndex));
  if (!propertyMatch || propertyMatch.index === undefined)
    throw new RequestValidationError(
      `Could not find editable.${propertyName} in workflow source`
    );
  const openBrace =
    editableIndex + propertyMatch.index + propertyMatch[0].lastIndexOf("{");
  const closeBrace = findMatchingBrace(source, openBrace);
  return {
    source,
    start: openBrace,
    end: closeBrace,
    body: source.slice(openBrace + 1, closeBrace),
  };
}

function findObjectProperty(
  block: { source: string; start: number; end: number; body: string },
  propertyName: string
) {
  const propertyMatch = new RegExp(
    `${escapeRegExp(propertyName)}\\s*:\\s*\\{`,
    "m"
  ).exec(block.body);
  if (!propertyMatch || propertyMatch.index === undefined)
    throw new RequestValidationError(
      `Could not find ${propertyName} in workflow source`
    );
  const openBrace =
    block.start + 1 + propertyMatch.index + propertyMatch[0].lastIndexOf("{");
  const closeBrace = findMatchingBrace(block.source, openBrace);
  return {
    source: block.source,
    start: openBrace,
    end: closeBrace,
    body: block.source.slice(openBrace + 1, closeBrace),
    valueStart: openBrace,
    valueEnd: closeBrace + 1,
    value: block.source.slice(openBrace, closeBrace + 1),
  };
}

function findMatchingBrace(source: string, openBrace: number) {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new RequestValidationError(
    "Could not parse editable object braces in workflow source"
  );
}

function unescapeQuotedString(value: string) {
  return value
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\([\\"'`])/g, "$1");
}

function escapeForQuotedString(value: string, quote: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(new RegExp(escapeRegExp(quote), "g"), `\\${quote}`)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function openRouterModelsResponse() {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return json(
        {
          ok: false,
          error: `OpenRouter /models returned ${response.status} ${response.statusText}`,
        },
        502
      );
    }
    const data = await response.json();
    const rows = Array.isArray((data as { data?: unknown }).data)
      ? (data as { data: unknown[] }).data
      : [];
    const models = rows
      .filter(isRecord)
      .map((model) => ({
        id: typeof model.id === "string" ? model.id : "",
        name: typeof model.name === "string" ? model.name : undefined,
        contextLength:
          typeof model.context_length === "number"
            ? model.context_length
            : undefined,
      }))
      .filter((model) => model.id.length > 0)
      .sort((a, b) => a.id.localeCompare(b.id));
    return json({ ok: true, models });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 502);
  }
}

async function workflowSourceResponse(args: {
  request: Request;
  projectRoot?: string;
  defaultWorkflowId?: string;
  workflowId: string;
  write: boolean;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  const workflow = discoverProjectWorkflows(setup.projectRoot).find(
    (candidate) => candidate.id === args.workflowId
  );
  if (!workflow)
    return json(
      { ok: false, error: `Workflow not found: ${args.workflowId}` },
      404
    );

  if (!args.write) {
    return json({
      ok: true,
      workflowId: workflow.id,
      workflowPath: workflow.path,
      source: readFileSync(workflow.path, "utf8"),
    });
  }

  const body = await readJsonBody(args.request);
  if (typeof body.source !== "string")
    return json({ ok: false, error: "source must be a string" }, 400);
  writeFileSync(workflow.path, body.source);
  return json({
    ok: true,
    workflowId: workflow.id,
    workflowPath: workflow.path,
  });
}

async function workflowRunCancelResponse(args: {
  projectRoot?: string;
  workflowId: string;
  runId: string;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  const workflow = discoverProjectWorkflows(setup.projectRoot).find(
    (candidate) => candidate.id === args.workflowId
  );
  if (!workflow)
    return json(
      { ok: false, error: `Workflow not found: ${args.workflowId}` },
      404
    );
  const proc = Bun.spawn(
    [
      "bun",
      "node_modules/.bin/smithers",
      "cancel",
      args.runId,
      "--format",
      "json",
    ],
    {
      cwd: setup.projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = stdout.trim()
    ? parseJsonObject(stdout, "smithers cancel response")
    : {};
  if (exitCode !== 0 && output.code !== "RUN_NOT_ACTIVE") {
    return json(
      {
        ok: false,
        error:
          output.message ??
          (stderr || stdout || `Smithers cancel failed with exit ${exitCode}`),
        ...output,
      },
      500
    );
  }
  return json({
    ok: true,
    runId: args.runId,
    status: output.status ?? "cancelled",
    ...output,
  });
}

async function workflowRunResponse(args: {
  request: Request;
  projectRoot?: string;
  defaultWorkflowId?: string;
  workflowId: string;
  runProjectWorkflow: RunProjectWorkflowFn;
}) {
  const setup = projectSetup(args);
  if (!setup.ok) return json(setup);
  const workflow = discoverProjectWorkflows(setup.projectRoot).find(
    (candidate) => candidate.id === args.workflowId
  );
  if (!workflow)
    return json(
      { ok: false, error: `Workflow not found: ${args.workflowId}` },
      404
    );
  const body = await readJsonBody(args.request);
  const input = body.input === undefined ? {} : body.input;
  if (!isRecord(input))
    return json({ ok: false, error: "input must be a JSON object" }, 400);
  if (body.promptOverrides !== undefined) {
    return json(
      {
        ok: false,
        code: "PROJECT_MODE_PROMPT_OVERRIDES_UNSUPPORTED",
        error:
          "Project-mode runs use saved Smithers workflow source and do not support promptOverrides.",
      },
      400
    );
  }

  const result = await args.runProjectWorkflow({
    projectRoot: setup.projectRoot,
    workflowId: workflow.id,
    workflowPath: workflow.path,
    input,
  });
  return json(
    {
      ok: true,
      runId: result.runId,
      status: result.status,
      inspection: { url: `/api/smithers/runs/${result.runId}` },
    },
    202
  );
}

async function renderProjectWorkflowGraph(options: {
  projectRoot: string;
  workflowId: string;
  workflowPath: string;
  input?: Record<string, unknown>;
  outputs?: Record<string, unknown[]>;
}): Promise<GraphSnapshot> {
  return await withCwd(options.projectRoot, async () => {
    const workflow = await loadWorkflow(options.workflowPath);
    const runtime = await loadSmithersRuntime(options.workflowPath);
    const runId = `custom-harness-graph-${crypto.randomUUID()}`;
    const ctx = new runtime.SmithersCtx({
      runId,
      iteration: 0,
      input: options.input ?? {},
      outputs: options.outputs ?? {},
      zodToKeyName: workflow.zodToKeyName,
    });
    return (await runtime.runPromise(
      runtime.renderFrame(workflow as never, ctx, {
        baseRootDir: options.projectRoot,
        workflowPath: options.workflowPath,
      })
    )) as GraphSnapshot;
  });
}

async function runProjectWorkflow(options: {
  projectRoot: string;
  workflowId: string;
  workflowPath: string;
  input: Record<string, unknown>;
}): Promise<{ runId: string; status: string }> {
  const command = buildSmithersWorkflowRunCommand(options);
  const proc = Bun.spawn(command.cmd, {
    cwd: command.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Smithers workflow run failed with exit ${exitCode} via ${command.source}: ${stderr || stdout}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Smithers workflow run returned invalid JSON via ${command.source}: ${message}; stdout=${stdout}; stderr=${stderr}`
    );
  }
  if (!isRecord(parsed) || typeof parsed.runId !== "string") {
    throw new Error(
      `Smithers workflow run response missing runId via ${command.source}: ${stdout}`
    );
  }
  return {
    runId: parsed.runId,
    status: typeof parsed.status === "string" ? parsed.status : "running",
  };
}

async function authorWorkflowSource(options: {
  prompt: string;
  workflowId: string;
  displayName: string;
  model?: string;
  previousSource?: string;
  repairError?: string;
}): Promise<{ source: string; model: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is required to generate Smithers Workflow Source from natural language"
    );
  }
  const model = normalizeOpenRouterModelId(
    options.model ??
      process.env.CUSTOM_HARNESS_AUTHOR_MODEL ??
      "anthropic/claude-sonnet-4.6"
  )!;
  const messages = options.previousSource
    ? workflowRepairMessages(options)
    : workflowAuthorMessages(options);
  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "http-referer": "http://localhost/custom-harness",
        "x-title": "CustomHarness Smithers Workflow Authoring",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
      }),
    }
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenRouter generation failed: ${response.status} ${response.statusText}: ${text.slice(0, 2000)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OpenRouter returned invalid JSON: ${message}; ${text.slice(0, 1000)}`
    );
  }
  const content = openRouterMessageContent(parsed);
  if (!content.trim())
    throw new Error("OpenRouter returned an empty workflow source response");
  return { source: content, model };
}

function workflowAuthorMessages(options: {
  prompt: string;
  workflowId: string;
  displayName: string;
}) {
  return [
    {
      role: "system",
      content: smithersAuthorSystemPrompt(),
    },
    {
      role: "user",
      content:
        `Create an ordinary Smithers Workflow Source file.\n\n` +
        `Workflow ID: ${options.workflowId}\n` +
        `Display name: ${options.displayName}\n\n` +
        `Natural-language workflow request:\n${options.prompt}\n\n` +
        `Return only one complete TSX source file, no prose.`,
    },
  ];
}

function workflowRepairMessages(options: {
  prompt: string;
  workflowId: string;
  displayName: string;
  previousSource?: string;
  repairError?: string;
}) {
  return [
    {
      role: "system",
      content: smithersAuthorSystemPrompt(),
    },
    {
      role: "user",
      content:
        `Repair this generated Smithers Workflow Source. Keep the same workflow ID and intent.\n\n` +
        `Workflow ID: ${options.workflowId}\n` +
        `Display name: ${options.displayName}\n\n` +
        `Original request:\n${options.prompt}\n\n` +
        `Render/type/import error:\n\`\`\`\n${options.repairError ?? "unknown error"}\n\`\`\`\n\n` +
        `Previous source:\n\`\`\`tsx\n${options.previousSource ?? ""}\n\`\`\`\n\n` +
        `Return only the complete repaired TSX source file, no prose.`,
    },
  ];
}

function smithersAuthorSystemPrompt() {
  return `You write ordinary Smithers workflow-pack TSX files. Smithers Workflow Source is TSX/JSX DSL for workflows, not React DOM UI.

Hard requirements:
- Return only a complete .tsx source file. No markdown explanation.
- Use /** @jsxImportSource smithers-orchestrator */ near the top.
- Import only from "smithers-orchestrator" and "zod" unless a normal Smithers component import is truly necessary.
- Prefer: import { createSmithers, PiAgent } from "smithers-orchestrator"; import { z } from "zod";
- Create an input schema with prompt: z.string().default(...). The CustomHarness v0 browser UI always sends the primary textarea as ctx.input.prompt and ctx.input.request; domain-specific names like plan or idea must be optional aliases, not the only required input.
- If the user asks for a domain input such as plan, define plan: z.string().optional() and use const userPlan = ctx.input.plan || ctx.input.prompt; never render user-facing prompts from ctx.input.plan alone.
- Use createSmithers({ input: inputSchema, ...outputSchemas }).
- Export default smithers((ctx) => { ... return (<Workflow name="..."><Sequence>...</Sequence></Workflow>); });
- Use real Smithers control-flow primitives when requested: Sequence for ordered steps, Parallel for fanout, Branch for conditional paths, and Loop for iterative "until/max rounds" flows.
- If the user asks for a loop, retry cycle, repeated review, or "until approved", use <Loop until={ctx.outputMaybe("schemaKey", { nodeId: "loop-task-id" })?.approved === true} maxIterations={...} onMaxReached="return-last">. Do not pass a callback function to until. Do not unroll it into duplicate serial tasks unless the user explicitly asks for a fixed number of separate steps.
- Always call ctx.latest and ctx.iterationCount with both arguments: ctx.latest("schemaKey", "node-id") and ctx.iterationCount("schemaKey", "node-id"). Never call ctx.latest("schemaKey") or ctx.iterationCount("schemaKey") with the node id omitted.
- Treat requests for "same agent", "same chat", "same thread", "original planner", "go back to the first agent", or similar as a request for continuity of role and context, not automatic conversational/session memory. Prefer reusing the same PiAgent variable/config/model and explicitly paste/read prior task outputs in the later Task prompt with ctx.outputMaybe/ctx.latest. Say in comments/prompts that the later task receives the prior plan/output as context.
- Do not imply real same-chat/thread continuity, hidden memory, or access to a previous task's transcript. The installed Smithers/PiAgent surface exposes session/resume flags, but workflow generation must not use them for task-to-task continuity unless the user explicitly asks for low-level Pi session flags and accepts that session identity/lifecycle is an advanced runtime concern. The safe default is same role/config + explicit prior outputs/context.
- Every Task must have a stable kebab-case id, a label, an output schema, and an agent.
- Use OpenRouter as the runtime provider whenever the user mentions OpenRouter. In Smithers source this means PiAgent must use provider: "openrouter" while model receives the OpenRouter model id without an "openrouter/" prefix.
- Examples: user text "openrouter/openai/gpt-5.5" becomes new PiAgent({ provider: "openrouter", model: "openai/gpt-5.5" }); user text "openrouter/anthropic/opus-4.6" becomes new PiAgent({ provider: "openrouter", model: "anthropic/claude-opus-4.6" }).
- Default to "anthropic/claude-sonnet-4.6" for all tasks unless the user asks for multi-model review.
- For multi-model review, use only these known-valid IDs: "anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.6", "openai/gpt-5.5", "google/gemini-3.1-pro-preview". Do not use deprecated IDs such as "anthropic/claude-3.5-sonnet".
- Render verification does not execute agents, so invalid model IDs may only fail at run time. Be conservative and use the known-valid IDs above.
- Render-time must not execute shell commands, read arbitrary files, or perform network calls.
- Use ctx.outputMaybe("schemaKey", { nodeId: "task-id" }) for upstream outputs when composing downstream prompts; never call outputMaybe without the nodeId options object.
- If several Tasks share the same output shape, register one schema key (for example review: reviewSchema) and read per-task rows with ctx.outputMaybe("review", { nodeId: "market-review" }); do not register the same raw Zod schema object under multiple keys.
- Include a small const editable object and Task meta.editor fields for prompt/model/label controls on every generated Task.
- The editor metadata shape must be exactly: meta={{ editor: { editable: true, fields: { prompt: { label: "Prompt template", kind: "multiline-text", sourcePath: ["tasks", "taskKey", "prompt"], value: editable.tasks.taskKey.prompt }, model: { label: "Model", kind: "model-select", sourcePath: ["agents", "main", "model"], value: editable.agents.main.model }, label: { label: "Display label", kind: "multiline-text", sourcePath: ["tasks", "taskKey", "label"], value: editable.tasks.taskKey.label } } } }}.
- Do not use meta={{ editor: { prompt: ... } }}; that is not editable by CustomHarness.
- Do not invent a CustomHarness IR, draft DB, or non-Smithers runtime.
- Keep source concise: 2-6 tasks unless the request clearly needs more.

Known-good shape:
const { Workflow, Task, Sequence, Parallel, smithers } = createSmithers({ input: inputSchema, summary: summarySchema });
const agent = new PiAgent({ provider: "openrouter", model: editable.agents.main.model });
export default smithers((ctx) => {
  const userPrompt = ctx.input.prompt;
  return (<Workflow name="workflow-id"><Sequence><Task id="summarize" label={editable.tasks.summarize.label} output={summarySchema} agent={agent}>Prompt text {userPrompt}</Task></Sequence></Workflow>);
});`;
}

function openRouterMessageContent(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.choices)) return "";
  const first = value.choices.find(isRecord);
  const message = first && isRecord(first.message) ? first.message : undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && typeof part.text === "string" ? part.text : ""
      )
      .join("\n");
  }
  return "";
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RequestValidationError(`Invalid JSON ${label}: ${message}`);
  }
  if (!isRecord(parsed))
    throw new RequestValidationError(`${label} must be a JSON object`);
  return parsed;
}

function parseJsonOutputs(text: string): Record<string, unknown[]> {
  const parsed = parseJsonObject(text, "outputs");
  const out: Record<string, unknown[]> = {};
  for (const [table, rows] of Object.entries(parsed)) {
    if (!Array.isArray(rows))
      throw new RequestValidationError(`outputs.${table} must be an array`);
    out[table] = rows;
  }
  return out;
}

function parseIntegerParam(
  params: URLSearchParams,
  name: string,
  bounds: { min: number; max: number }
) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new RequestValidationError(`${name} must be a number`);
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)));
}

function booleanParam(params: URLSearchParams, name: string) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new RequestValidationError(`${name} must be true or false`);
}

function stringParam(params: URLSearchParams, name: string) {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const value = raw.trim();
  return value ? value : undefined;
}

function csvParam(params: URLSearchParams, name: string) {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function compactOptions<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, option]) => option !== undefined)
  ) as T;
}

async function readJsonBody(
  request: Request
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  return parseJsonObject(text, "request body");
}

class RequestValidationError extends Error {}

async function staticFileResponse(rootDir: string, pathname: string) {
  const requested = pathname === "/" ? "/web/index.html" : pathname;
  const localPath = safeStaticPath(rootDir, requested);
  if (!existsSync(localPath)) {
    if (localPath.endsWith(".js")) {
      const tsPath = `${localPath.slice(0, -".js".length)}.ts`;
      if (existsSync(tsPath)) {
        const output = await Bun.build({
          entrypoints: [tsPath],
          target: "browser",
          format: "esm",
          minify: false,
          sourcemap: "none",
        });
        if (!output.success) {
          return new Response(
            output.logs.map((log) => log.message).join("\n") ||
              "Build failed\n",
            { status: 500 }
          );
        }
        return new Response(output.outputs[0], {
          headers: staticHeaders("text/javascript; charset=utf-8"),
        });
      }
    }
    return new Response("Not found\n", { status: 404 });
  }
  const file = Bun.file(localPath);
  return new Response(file, {
    headers: staticHeaders(contentType(localPath)),
  });
}

function staticHeaders(contentTypeValue: string) {
  return {
    "content-type": contentTypeValue,
    "cache-control": "no-store, no-cache, must-revalidate",
    pragma: "no-cache",
    expires: "0",
  };
}

function safeStaticPath(rootDir: string, pathname: string) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded.replace(/^\/+/, "");
  const fullPath = resolve(rootDir, relative);
  if (fullPath !== rootDir && !fullPath.startsWith(`${rootDir}${sep}`)) {
    throw new Error("Invalid path");
  }
  return fullPath;
}

function contentType(path: string) {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".jsonl":
    case ".ndjson":
      return "application/x-ndjson; charset=utf-8";
    case ".txt":
    case ".log":
      return "text/plain; charset=utf-8";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 4321);
  const cliOptions = parseServerArgs(process.argv.slice(2));
  const server = Bun.serve({
    port,
    fetch: createHarnessServerHandler(cliOptions),
  });
  process.on("SIGINT", () => {
    server.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.stop();
    process.exit(0);
  });
  console.log(
    `custom-harness web server listening on http://localhost:${port}`
  );
  const launchRootDir = resolve(cliOptions.rootDir ?? process.cwd());
  const launchProjectRoot = resolveProjectRootOption(
    launchRootDir,
    cliOptions.projectRoot
  );
  if (launchProjectRoot) {
    console.log(
      `project workflow viewer: ${launchProjectRoot}${cliOptions.workflowId ? `#${cliOptions.workflowId}` : ""}`
    );
  }
  await new Promise(() => undefined);
}

function resolveProjectRootOption(rootDir: string, projectRoot?: string) {
  if (projectRoot) return resolve(projectRoot);
  return existsSync(join(rootDir, ".smithers")) ? rootDir : undefined;
}

function parseServerArgs(args: string[]): HarnessServerOptions {
  const out: HarnessServerOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project") {
      const value = args[i + 1];
      if (!value) throw new Error("Missing value for --project");
      out.projectRoot = value;
      i += 1;
    } else if (arg === "--workflow") {
      const value = args[i + 1];
      if (!value) throw new Error("Missing value for --workflow");
      out.workflowId = value;
      i += 1;
    }
  }
  return out;
}
