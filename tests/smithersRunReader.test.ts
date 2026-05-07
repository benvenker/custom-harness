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

function createSmithersMappingFixtureDb(projectRoot: string) {
  const dbPath = smithersDbPath(projectRoot);
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE _smithers_runs (
        run_id TEXT PRIMARY KEY,
        parent_run_id TEXT,
        workflow_name TEXT NOT NULL,
        workflow_path TEXT,
        workflow_hash TEXT,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        started_at_ms INTEGER,
        finished_at_ms INTEGER,
        heartbeat_at_ms INTEGER,
        runtime_owner_id TEXT,
        cancel_requested_at_ms INTEGER,
        hijack_requested_at_ms INTEGER,
        hijack_target TEXT,
        vcs_type TEXT,
        vcs_root TEXT,
        vcs_revision TEXT,
        error_json TEXT,
        config_json TEXT
      );
      CREATE TABLE _smithers_nodes (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        last_attempt INTEGER,
        updated_at_ms INTEGER NOT NULL,
        output_table TEXT NOT NULL,
        label TEXT,
        PRIMARY KEY (run_id, node_id, iteration)
      );
      CREATE TABLE _smithers_attempts (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL,
        state TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER,
        heartbeat_at_ms INTEGER,
        heartbeat_data_json TEXT,
        error_json TEXT,
        jj_pointer TEXT,
        response_text TEXT,
        jj_cwd TEXT,
        cached INTEGER DEFAULT 0,
        meta_json TEXT,
        PRIMARY KEY (run_id, node_id, iteration, attempt)
      );
      CREATE TABLE _smithers_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE _smithers_frames (
        run_id TEXT NOT NULL,
        frame_no INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        xml_json TEXT NOT NULL,
        xml_hash TEXT NOT NULL,
        encoding TEXT NOT NULL DEFAULT 'full',
        mounted_task_ids_json TEXT,
        task_index_json TEXT,
        note TEXT,
        PRIMARY KEY (run_id, frame_no)
      );
      CREATE TABLE result_output (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        markdown TEXT,
        score INTEGER,
        PRIMARY KEY (run_id, node_id, iteration)
      );
    `);

    const insertRun = db.query(`
      INSERT INTO _smithers_runs (
        run_id, parent_run_id, workflow_name, workflow_path, workflow_hash, status,
        created_at_ms, started_at_ms, finished_at_ms, heartbeat_at_ms, runtime_owner_id,
        cancel_requested_at_ms, hijack_requested_at_ms, hijack_target, vcs_type, vcs_root,
        vcs_revision, error_json, config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertRun.run(
      'run-main',
      null,
      'foo',
      join(projectRoot, '.smithers/workflows/foo.tsx'),
      'hash-main',
      'finished',
      1000,
      1100,
      5000,
      4500,
      'runtime-a',
      null,
      null,
      null,
      'git',
      projectRoot,
      'abc123',
      '{"message":"ok"}',
      '{"temperature":0}',
    );
    insertRun.run(
      'run-name-only',
      null,
      'foo',
      null,
      'hash-name',
      'running',
      900,
      950,
      null,
      980,
      'runtime-b',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    insertRun.run(
      'run-bar',
      null,
      'bar',
      join(projectRoot, '.smithers/workflows/bar.tsx'),
      'hash-bar',
      'finished',
      800,
      850,
      1200,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    insertRun.run(
      'run-bad-json',
      null,
      'bad-json',
      join(projectRoot, '.smithers/workflows/bad-json.tsx'),
      'hash-bad',
      'failed',
      700,
      710,
      720,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      '{not-json',
      '{also-not-json',
    );

    const insertNode = db.query(`
      INSERT INTO _smithers_nodes (run_id, node_id, iteration, state, last_attempt, updated_at_ms, output_table, label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertNode.run('run-main', 'draft', 0, 'finished', 2, 3200, 'result_output', 'Draft answer');
    insertNode.run('run-main', 'review', 1, 'failed', 2, 3300, 'missing_output_table', 'Review answer');
    insertNode.run('run-main', 'zeta', 0, 'queued', 1, 1800, 'result_output', 'Zeta later in sort');
    insertNode.run('run-bad-json', 'bad-node', 0, 'failed', 1, 730, 'missing_output_table', 'Bad JSON node');

    const insertAttempt = db.query(`
      INSERT INTO _smithers_attempts (
        run_id, node_id, iteration, attempt, state, started_at_ms, finished_at_ms,
        heartbeat_at_ms, heartbeat_data_json, error_json, jj_pointer, response_text,
        jj_cwd, cached, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertAttempt.run('run-main', 'zeta', 0, 1, 'queued', 1000, null, null, null, null, null, null, null, 0, null);
    insertAttempt.run('run-main', 'draft', 0, 2, 'finished', 3000, 3100, 3050, '{"progress":"done"}', null, 'jj://draft/2', 'draft response 2', '/tmp/draft', 1, '{"agent":"writer"}');
    insertAttempt.run('run-main', 'review', 1, 2, 'failed', 2000, 2200, null, null, '{"message":"review failed"}', 'jj://review/2', 'review response', '/tmp/review', 0, '{"agent":"reviewer"}');
    insertAttempt.run('run-main', 'draft', 0, 1, 'failed', 4000, 4100, null, null, '{"message":"draft failed"}', 'jj://draft/1', 'draft response 1', '/tmp/draft', 0, '{"agent":"writer"}');
    insertAttempt.run('run-bad-json', 'bad-node', 0, 1, 'failed', 715, 718, 716, '{heartbeat-bad', '{error-bad', null, 'bad response', null, 0, '{meta-bad');

    const insertEvent = db.query(`
      INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertEvent.run('run-main', 1, 1110, 'run_started', '{"nodeId":"draft","iteration":0}');
    insertEvent.run('run-main', 2, 2210, 'attempt_finished', '{"nodeId":"review","iteration":1,"attempt":2,"ok":false}');
    insertEvent.run('run-main', 3, 5010, 'run_finished', '{"ok":true}');
    insertEvent.run('run-bad-json', 1, 719, 'attempt_failed', '{payload-bad');

    const insertFrame = db.query(`
      INSERT INTO _smithers_frames (
        run_id, frame_no, created_at_ms, xml_json, xml_hash, encoding,
        mounted_task_ids_json, task_index_json, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertFrame.run(
      'run-main',
      1,
      1500,
      '{"xml":"<Task id=\\"draft\\" />"}',
      'xml-hash-1',
      'full',
      '["draft","review"]',
      '{"draft":{"nodeId":"draft","label":"Draft answer"},"review":{"nodeId":"review","label":"Review answer"}}',
      'initial render',
    );
    insertFrame.run('run-bad-json', 1, 717, '{"xml":"<Task />"}', 'xml-hash-bad', 'full', '[mounted-bad', '{task-index-bad', 'bad render');

    db.query('INSERT INTO result_output (run_id, node_id, iteration, markdown, score) VALUES (?, ?, ?, ?, ?)')
      .run('run-main', 'draft', 0, 'final draft output', 42);
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

describe('SmithersRunReader data mapping', () => {
  it('listRuns() returns Smithers run rows and filters by workflow id path/name', async () => {
    const projectRoot = tempProject('custom-harness-smithers-mapping-list-');
    createSmithersMappingFixtureDb(projectRoot);

    const { createSmithersRunReader } = await loadRunReader();
    const reader = await maybeAsync(createSmithersRunReader({ projectRoot }));
    try {
      await expect(reader.listRuns()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-main',
          workflowName: 'foo',
          workflowPath: join(projectRoot, '.smithers/workflows/foo.tsx'),
          status: 'finished',
          createdAtMs: 1000,
        }),
        expect.objectContaining({
          runId: 'run-bar',
          workflowName: 'bar',
          workflowPath: join(projectRoot, '.smithers/workflows/bar.tsx'),
        }),
      ]));

      const fooRuns = await (reader.listRuns as any)({ workflowId: 'foo' });
      expect(fooRuns.map((run: { runId: string }) => run.runId)).toEqual(['run-main', 'run-name-only']);
      expect(fooRuns).toEqual([
        expect.objectContaining({ runId: 'run-main', workflowName: 'foo' }),
        expect.objectContaining({ runId: 'run-name-only', workflowName: 'foo', workflowPath: null }),
      ]);
    } finally {
      reader.close();
    }
  });

  it('getRunDetail() returns null for a missing run', async () => {
    const projectRoot = tempProject('custom-harness-smithers-mapping-missing-');
    createSmithersMappingFixtureDb(projectRoot);

    const { createSmithersRunReader } = await loadRunReader();
    const reader = await maybeAsync(createSmithersRunReader({ projectRoot }));
    try {
      await expect(reader.getRunDetail('does-not-exist')).resolves.toBeNull();
    } finally {
      reader.close();
    }
  });

  it('getRunDetail() maps run, nodes, attempts, events, frames, cursor, and raw output rows', async () => {
    const projectRoot = tempProject('custom-harness-smithers-mapping-detail-');
    createSmithersMappingFixtureDb(projectRoot);

    const { createSmithersRunReader } = await loadRunReader();
    const reader = await maybeAsync(createSmithersRunReader({ projectRoot }));
    try {
      const detail = await (reader.getRunDetail as any)('run-main', { includeOutputs: true, eventLimit: 2, frameLimit: 5 });

      expect(detail).toEqual(expect.objectContaining({
        run: expect.objectContaining({
          runId: 'run-main',
          workflowName: 'foo',
          workflowPath: join(projectRoot, '.smithers/workflows/foo.tsx'),
          status: 'finished',
          createdAtMs: 1000,
          startedAtMs: 1100,
          finishedAtMs: 5000,
        }),
        cursors: expect.objectContaining({ nextEventSeq: 3 }),
      }));

      expect(detail.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-main',
          nodeId: 'draft',
          iteration: 0,
          state: 'finished',
          status: 'finished',
          lastAttempt: 2,
          updatedAtMs: 3200,
          outputTable: 'result_output',
          label: 'Draft answer',
        }),
        expect.objectContaining({
          nodeId: 'review',
          iteration: 1,
          state: 'failed',
          outputTable: 'missing_output_table',
          label: 'Review answer',
        }),
      ]));

      expect(detail.attempts.map((attempt: { nodeId: string; iteration: number; attempt: number; startedAtMs: number }) => [
        attempt.nodeId,
        attempt.iteration,
        attempt.attempt,
        attempt.startedAtMs,
      ])).toEqual([
        ['zeta', 0, 1, 1000],
        ['review', 1, 2, 2000],
        ['draft', 0, 2, 3000],
        ['draft', 0, 1, 4000],
      ]);
      expect(detail.attempts).toContainEqual(expect.objectContaining({
        nodeId: 'draft',
        attempt: 2,
        cached: true,
        heartbeatData: { progress: 'done' },
        meta: { agent: 'writer' },
      }));

      expect(detail.events).toEqual([
        expect.objectContaining({
          seq: 1,
          type: 'run_started',
          payload: { nodeId: 'draft', iteration: 0 },
          nodeId: 'draft',
          iteration: 0,
        }),
        expect.objectContaining({
          seq: 2,
          type: 'attempt_finished',
          payload: { nodeId: 'review', iteration: 1, attempt: 2, ok: false },
          nodeId: 'review',
          iteration: 1,
          attempt: 2,
        }),
      ]);

      expect(detail.frames).toEqual([
        expect.objectContaining({
          runId: 'run-main',
          frameNo: 1,
          createdAtMs: 1500,
          xmlHash: 'xml-hash-1',
          encoding: 'full',
          mountedTaskIds: ['draft', 'review'],
          taskIndex: expect.objectContaining({
            draft: expect.objectContaining({ nodeId: 'draft', label: 'Draft answer' }),
          }),
          note: 'initial render',
        }),
      ]);
      expect(detail.frames[0]).not.toHaveProperty('renderGraph');
      expect(detail.frames[0]).not.toHaveProperty('graph');
      expect(detail.frames[0]).not.toHaveProperty('nodes');
      expect(detail.frames[0]).not.toHaveProperty('edges');

      expect(detail.outputs).toEqual([
        expect.objectContaining({
          runId: 'run-main',
          nodeId: 'draft',
          iteration: 0,
          outputTable: 'result_output',
          row: expect.objectContaining({
            run_id: 'run-main',
            node_id: 'draft',
            iteration: 0,
            markdown: 'final draft output',
            score: 42,
          }),
        }),
      ]);
      expect(detail.parseWarnings ?? []).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it('listEvents(afterSeq) returns newer DB events plus a monotonic cursor', async () => {
    const projectRoot = tempProject('custom-harness-smithers-mapping-events-');
    createSmithersMappingFixtureDb(projectRoot);

    const { createSmithersRunReader } = await loadRunReader();
    const reader = await maybeAsync(createSmithersRunReader({ projectRoot }));
    try {
      const result = await (reader.listEvents as any)('run-main', { afterSeq: 1, limit: 10 });

      expect(result).toEqual({
        events: [
          expect.objectContaining({ seq: 2, type: 'attempt_finished', nodeId: 'review', iteration: 1, attempt: 2 }),
          expect.objectContaining({ seq: 3, type: 'run_finished', nodeId: null, iteration: null, attempt: null }),
        ],
        cursors: { nextEventSeq: 3 },
      });
    } finally {
      reader.close();
    }
  });

  it('malformed JSON fields produce field-level parse warnings and missing outputs are tolerated', async () => {
    const projectRoot = tempProject('custom-harness-smithers-mapping-bad-json-');
    createSmithersMappingFixtureDb(projectRoot);

    const { createSmithersRunReader } = await loadRunReader();
    const reader = await maybeAsync(createSmithersRunReader({ projectRoot }));
    try {
      const detail = await (reader.getRunDetail as any)('run-bad-json', { includeOutputs: true });

      expect(detail).toEqual(expect.objectContaining({
        run: expect.objectContaining({ runId: 'run-bad-json', status: 'failed' }),
        nodes: [expect.objectContaining({ nodeId: 'bad-node', outputTable: 'missing_output_table' })],
        outputs: [],
      }));
      expect(detail.parseWarnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'run.errorJson', runId: 'run-bad-json' }),
        expect.objectContaining({ field: 'run.configJson', runId: 'run-bad-json' }),
        expect.objectContaining({ field: 'attempt.heartbeatDataJson', runId: 'run-bad-json', nodeId: 'bad-node' }),
        expect.objectContaining({ field: 'attempt.errorJson', runId: 'run-bad-json', nodeId: 'bad-node' }),
        expect.objectContaining({ field: 'attempt.metaJson', runId: 'run-bad-json', nodeId: 'bad-node' }),
        expect.objectContaining({ field: 'event.payloadJson', runId: 'run-bad-json', seq: 1 }),
        expect.objectContaining({ field: 'frame.mountedTaskIdsJson', runId: 'run-bad-json', frameNo: 1 }),
        expect.objectContaining({ field: 'frame.taskIndexJson', runId: 'run-bad-json', frameNo: 1 }),
      ]));
      expect(detail.events[0]).toEqual(expect.objectContaining({
        seq: 1,
        type: 'attempt_failed',
        payload: null,
        nodeId: null,
        iteration: null,
        attempt: null,
      }));
      expect(detail.frames[0]).toEqual(expect.objectContaining({
        frameNo: 1,
        mountedTaskIds: [],
        taskIndex: null,
      }));
    } finally {
      reader.close();
    }
  });
});
