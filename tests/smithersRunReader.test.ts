import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

function tempProject(prefix = 'custom-harness-smithers-reader-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function smithersDbPath(projectRoot: string) {
  return join(projectRoot, 'smithers.db');
}

function createWritableFixtureDb(projectRoot: string) {
  const dbPath = smithersDbPath(projectRoot);
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO probe (value) VALUES ('before');
    `);
  } finally {
    db.close();
  }
  return dbPath;
}

function schemaSnapshot(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query(`
        SELECT type, name, tbl_name AS tableName, sql
        FROM sqlite_master
        WHERE type IN ('table', 'index', 'trigger', 'view')
        ORDER BY type, name
      `)
      .all();
  } finally {
    db.close();
  }
}

async function captureError(fn: () => unknown | Promise<unknown>) {
  try {
    await Promise.resolve(fn());
    return null;
  } catch (error) {
    return error;
  }
}

async function loadReadOnlyOpener() {
  return await import('../src/smithersProject/sqliteReadOnly.js');
}

async function loadRunReader() {
  return await import('../src/smithersProject/runReader.js');
}

async function maybeAsync<T>(value: T | Promise<T>): Promise<T> {
  return await Promise.resolve(value);
}

describe('Smithers read-only SQLite opener', () => {
  it('fails with a controlled missing-db error and does not create smithers.db', async () => {
    const projectRoot = tempProject('custom-harness-smithers-missing-db-');
    const dbPath = smithersDbPath(projectRoot);
    expect(existsSync(dbPath)).toBe(false);

    const { openSmithersDbReadOnly } = await loadReadOnlyOpener();
    const error = await captureError(() => openSmithersDbReadOnly({ projectRoot }));

    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(/smithers\.db|not found|missing/i);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('opens an existing project-root smithers.db read-only and can read through the seam', async () => {
    const projectRoot = tempProject();
    const dbPath = createWritableFixtureDb(projectRoot);

    const { openSmithersDbReadOnly } = await loadReadOnlyOpener();
    const handle = await maybeAsync(openSmithersDbReadOnly({ projectRoot }));
    try {
      expect(resolve(handle.dbPath)).toBe(resolve(dbPath));
      await expect(maybeAsync(handle.queryAll('SELECT value FROM probe ORDER BY id'))).resolves.toEqual([
        { value: 'before' },
      ]);
    } finally {
      handle.close();
    }
  });

  it('close() releases the read-only connection and prevents further probe use', async () => {
    const projectRoot = tempProject();
    createWritableFixtureDb(projectRoot);

    const { openSmithersDbReadOnly } = await loadReadOnlyOpener();
    const handle = await maybeAsync(openSmithersDbReadOnly({ projectRoot }));

    await expect(maybeAsync(handle.queryAll('SELECT value FROM probe'))).resolves.toHaveLength(1);
    handle.close();

    const error = await captureError(() => handle.queryAll('SELECT value FROM probe'));
    expect(error).toBeInstanceOf(Error);
  });

  it('rejects write probes and leaves the schema unchanged', async () => {
    const projectRoot = tempProject();
    const dbPath = createWritableFixtureDb(projectRoot);
    const before = schemaSnapshot(dbPath);

    const { openSmithersDbReadOnly } = await loadReadOnlyOpener();
    const handle = await maybeAsync(openSmithersDbReadOnly({ projectRoot }));
    try {
      for (const sql of [
        "INSERT INTO probe (value) VALUES ('after')",
        'CREATE TABLE should_not_exist (id INTEGER)',
        'DROP TABLE probe',
        'PRAGMA user_version = 123',
      ]) {
        const error = await captureError(() => handle.execForTest(sql));
        expect(error).toBeInstanceOf(Error);
        expect(String((error as Error).message)).toMatch(/readonly|read-only|query_only|not authorized|write/i);
      }

      await expect(maybeAsync(handle.queryAll('SELECT value FROM probe ORDER BY id'))).resolves.toEqual([
        { value: 'before' },
      ]);
    } finally {
      handle.close();
    }

    expect(schemaSnapshot(dbPath)).toEqual(before);
  });
});

describe('SmithersRunReader contract', () => {
  it('creates a reader over an existing DB with the stable first-slice methods', async () => {
    const projectRoot = tempProject();
    createWritableFixtureDb(projectRoot);

    const { createSmithersRunReader } = await loadRunReader();
    const reader = await maybeAsync(createSmithersRunReader({ projectRoot }));
    try {
      expect(reader).toEqual(expect.objectContaining({
        listRuns: expect.any(Function),
        getRunDetail: expect.any(Function),
        listEvents: expect.any(Function),
        close: expect.any(Function),
      }));
    } finally {
      reader.close();
    }
  });

  it('does not import Smithers schema mutators or legacy CustomHarness run artifacts', () => {
    const modulePaths = [
      'src/smithersProject/sqliteReadOnly.ts',
      'src/smithersProject/runReaderTypes.ts',
      'src/smithersProject/runReader.ts',
    ];

    for (const modulePath of modulePaths) {
      expect(existsSync(modulePath), `${modulePath} should exist`).toBe(true);
      const source = readFileSync(modulePath, 'utf8');
      expect(source, modulePath).not.toMatch(
        /from ['"]@smithers-orchestrator\/db\/ensure|ensureSmithersTables\(|ensureSqlMessageStorage\(|ensureSchema\(/,
      );
      expect(source, modulePath).not.toMatch(/createRunRecorder|runs\/index\.json|plan\.json|run\.json|events\.jsonl/);
    }
  });
});
