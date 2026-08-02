import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type SmithersWorkflowLike = {
  zodToKeyName?: Map<unknown, string>;
};

export type SmithersRuntime = {
  renderFrame: (
    workflow: never,
    ctx: unknown,
    options: { baseRootDir: string; workflowPath: string | null }
  ) => unknown;
  runWorkflow: (workflow: never, options: Record<string, unknown>) => unknown;
  SmithersCtx: new (options: {
    runId: string;
    iteration: number;
    input: Record<string, unknown>;
    outputs: Record<string, unknown>;
    zodToKeyName?: Map<unknown, string>;
  }) => unknown;
  runPromise: (effect: unknown) => Promise<unknown>;
};

export async function loadWorkflow(
  workflowPath: string
): Promise<SmithersWorkflowLike> {
  const moduleExports = await importFreshWorkflow(workflowPath);
  const workflow = moduleExports.default ?? moduleExports.workflow;
  if (!workflow) {
    throw new Error(
      `Workflow module must export a default workflow or named export "workflow": ${workflowPath}`
    );
  }
  if (!hasZodToKeyName(workflow)) {
    throw new Error(
      `Exported workflow is not a Smithers workflow: ${workflowPath}`
    );
  }
  return workflow;
}

async function importFreshWorkflow(
  workflowPath: string
): Promise<Record<string, unknown>> {
  const projectRoot = findSmithersProjectRoot(dirname(workflowPath));
  const tempRoot = mkdtempSync(
    join(tmpdir(), "custom-harness-workflow-import-")
  );
  mirrorProjectForWorkflowImport({ projectRoot, workflowPath, tempRoot });
  const tempWorkflowPath = join(
    tempRoot,
    ".smithers",
    "workflows",
    `${Date.now()}-${crypto.randomUUID()}-${basename(workflowPath)}`
  );
  copyFileSync(workflowPath, tempWorkflowPath);
  // Do not delete this temp module immediately. Bun --watch watches imported
  // modules even outside the project root; removing an imported cache-bust file
  // restarts the dev server mid-request, which appears in the browser as
  // `Failed to fetch` while loading the graph.
  return await import(pathToFileURL(tempWorkflowPath).href);
}

function findSmithersProjectRoot(startDir: string) {
  let current = resolve(startDir);
  while (true) {
    if (basename(current) === ".smithers") return dirname(current);
    if (existsSync(join(current, ".smithers"))) return current;
    const parent = dirname(current);
    if (parent === current) return dirname(startDir);
    current = parent;
  }
}

function mirrorProjectForWorkflowImport(args: {
  projectRoot: string;
  workflowPath: string;
  tempRoot: string;
}) {
  for (const entry of safeReadDir(args.projectRoot)) {
    if (entry === ".smithers") continue;
    symlinkEntry(join(args.projectRoot, entry), join(args.tempRoot, entry));
  }

  const smithersDir = join(args.projectRoot, ".smithers");
  const tempSmithersDir = join(args.tempRoot, ".smithers");
  mkdirSync(join(tempSmithersDir, "workflows"), { recursive: true });
  for (const entry of safeReadDir(smithersDir)) {
    if (entry === "workflows") continue;
    symlinkEntry(join(smithersDir, entry), join(tempSmithersDir, entry));
  }
}

function safeReadDir(path: string) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function symlinkEntry(source: string, target: string) {
  try {
    const type = lstatSync(source).isDirectory() ? "dir" : "file";
    symlinkSync(source, target, type);
  } catch {
    // Best-effort mirror for workflow imports; missing optional paths are fine.
  }
}

export async function loadSmithersRuntime(
  workflowPath: string
): Promise<SmithersRuntime> {
  const nodeModulesDir = findNearestNodeModulesWithPackage(
    dirname(workflowPath),
    ["@smthrs", "engine"]
  );
  if (!nodeModulesDir) {
    throw new Error(
      `Could not find @smthrs/engine for workflow: ${workflowPath}`
    );
  }
  const [engine, driver, effect] = await Promise.all([
    import(
      pathToFileURL(
        join(
          nodeModulesDir,
          "@smthrs",
          "engine",
          "src",
          "index.js"
        )
      ).href
    ),
    import(
      pathToFileURL(
        join(
          nodeModulesDir,
          "@smthrs",
          "driver",
          "src",
          "SmithersCtx.js"
        )
      ).href
    ),
    import(
      pathToFileURL(join(nodeModulesDir, "effect", "dist", "esm", "index.js"))
        .href
    ),
  ]);
  return {
    renderFrame: engine.renderFrame,
    runWorkflow: engine.runWorkflow,
    SmithersCtx: driver.SmithersCtx,
    runPromise: effect.Effect.runPromise,
  };
}

function findNearestNodeModulesWithPackage(
  startDir: string,
  packageSegments: string[]
) {
  let current = startDir;
  while (true) {
    const nodeModulesDir = join(current, "node_modules");
    if (existsSync(join(nodeModulesDir, ...packageSegments)))
      return nodeModulesDir;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function hasZodToKeyName(value: unknown): value is SmithersWorkflowLike {
  return Boolean(value && typeof value === "object" && "zodToKeyName" in value);
}
