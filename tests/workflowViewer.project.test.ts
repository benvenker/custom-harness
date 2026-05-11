import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHarnessServerHandler } from "../src/server.js";

function tempProject(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeWorkflow(projectRoot: string, id: string) {
  const workflowsDir = join(projectRoot, ".smithers", "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, `${id}.tsx`), "export default {}\n");
}

describe("project workflow viewer API", () => {
  it("returns project context for the selected Smithers project and workflow without legacy run metadata", async () => {
    const projectRoot = tempProject("custom-harness-project-viewer-");
    writeWorkflow(projectRoot, "foo");
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      workflowId: "foo",
    });

    const response = await handler(new Request("http://localhost/api/project"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      projectRoot: resolve(projectRoot),
      smithersDir: join(resolve(projectRoot), ".smithers"),
      defaultWorkflowId: "foo",
    });
  });

  it("infers the selected Smithers project from rootDir when launched inside a workflow-pack repo", async () => {
    const projectRoot = tempProject("custom-harness-project-viewer-inferred-");
    writeWorkflow(projectRoot, "foo");
    const handler = createHarnessServerHandler({
      rootDir: projectRoot,
    });

    const response = await handler(new Request("http://localhost/api/project"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      projectRoot: resolve(projectRoot),
      smithersDir: join(resolve(projectRoot), ".smithers"),
      defaultWorkflowId: undefined,
    });
  });

  it("reports missing Smithers setup without creating .smithers or .poolside", async () => {
    const projectRoot = tempProject("custom-harness-missing-smithers-");
    writeFileSync(join(projectRoot, "README.md"), "# missing setup\n");
    const handler = createHarnessServerHandler({
      rootDir: process.cwd(),
      projectRoot,
      workflowId: "foo",
    });

    const response = await handler(new Request("http://localhost/api/project"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.status).toBe("setup-needed");
    expect(body.projectRoot).toBe(resolve(projectRoot));
    expect(body.smithersDir).toBe(join(resolve(projectRoot), ".smithers"));
    expect(body.error).toContain(".smithers");
    expect(existsSync(join(projectRoot, ".smithers"))).toBe(false);
    expect(existsSync(join(projectRoot, ".poolside"))).toBe(false);
  });
});
