import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DesignWorkflowResult } from "./app/designWorkflow.js";

export type WorkflowDraft = DesignWorkflowResult & {
  goal: string;
  context?: string;
};

export type DraftSummary = {
  id: string;
  name: string;
  description: string;
  goal: string;
  createdAt: string;
};

function draftsDir(runsDir: string): string {
  return join(runsDir, "drafts");
}

function draftPath(runsDir: string, id: string): string {
  return join(draftsDir(runsDir), `${safeId(id)}.json`);
}

export function saveDraft(runsDir: string, draft: WorkflowDraft): void {
  const dir = draftsDir(runsDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    draftPath(runsDir, draft.id),
    JSON.stringify(draft, null, 2),
    "utf8"
  );
}

export function listDrafts(runsDir: string): DraftSummary[] {
  const dir = draftsDir(runsDir);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const raw = JSON.parse(
          readFileSync(join(dir, f), "utf8")
        ) as WorkflowDraft;
        return {
          id: raw.id,
          name: raw.name,
          description: raw.description,
          goal: raw.goal,
          createdAt: raw.createdAt,
        };
      } catch {
        return null;
      }
    })
    .filter((d): d is DraftSummary => d !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getDraft(runsDir: string, id: string): WorkflowDraft | null {
  const path = draftPath(runsDir, id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WorkflowDraft;
  } catch {
    return null;
  }
}

export function updateDraft(
  runsDir: string,
  id: string,
  updates: Partial<WorkflowDraft>
): WorkflowDraft | null {
  const existing = getDraft(runsDir, id);
  if (!existing) return null;
  const updated: WorkflowDraft = { ...existing, ...updates, id };
  saveDraft(runsDir, updated);
  return updated;
}

function safeId(id: string): string {
  return id
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
