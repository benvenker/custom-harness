import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import type { TaskResult } from './types.js';

const DB_DIR = '.harness';
const DB_PATH = `${DB_DIR}/workflow.db`;

let _db: Database | null = null;

function db(): Database {
  if (!_db) {
    mkdirSync(DB_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        goal        TEXT NOT NULL,
        status      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_results (
        run_id       TEXT NOT NULL,
        task_name    TEXT NOT NULL,
        status       TEXT NOT NULL,
        output       TEXT,
        error        TEXT,
        started_at   TEXT,
        completed_at TEXT,
        PRIMARY KEY (run_id, task_name),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
      );
    `);
  }
  return _db;
}

export function createRun(id: string, name: string, goal: string): void {
  const now = new Date().toISOString();
  db().run(
    'INSERT INTO workflow_runs (id, name, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, goal, 'running', now, now],
  );
}

export function updateRunStatus(id: string, status: string): void {
  db().run(
    'UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?',
    [status, new Date().toISOString(), id],
  );
}

export function saveTaskResult(runId: string, result: TaskResult): void {
  db().run(
    `INSERT INTO task_results
       (run_id, task_name, status, output, error, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, task_name) DO UPDATE SET
       status       = excluded.status,
       output       = excluded.output,
       error        = excluded.error,
       started_at   = excluded.started_at,
       completed_at = excluded.completed_at`,
    [
      runId,
      result.taskName,
      result.status,
      result.output !== undefined ? JSON.stringify(result.output) : null,
      result.error ?? null,
      result.startedAt?.toISOString() ?? null,
      result.completedAt?.toISOString() ?? null,
    ],
  );
}

export function getCompletedTasks(runId: string): Record<string, TaskResult> {
  const rows = db()
    .query(
      "SELECT * FROM task_results WHERE run_id = ? AND status = 'completed'",
    )
    .all(runId) as Array<Record<string, string | null>>;

  const results: Record<string, TaskResult> = {};
  for (const row of rows) {
    results[row.task_name as string] = {
      taskName: row.task_name as string,
      status: 'completed',
      output: row.output ? JSON.parse(row.output) : undefined,
      error: row.error ?? undefined,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    };
  }
  return results;
}

export function findResumableRun(name: string, goal: string): string | null {
  const row = db()
    .query(
      "SELECT id FROM workflow_runs WHERE name = ? AND goal = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1",
    )
    .get(name, goal) as { id: string } | null;
  return row?.id ?? null;
}
