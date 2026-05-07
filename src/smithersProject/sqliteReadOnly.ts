import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { SmithersDb } from '@smithers-orchestrator/db/adapter';

export type SqliteReadOnlyOpenOptions = {
  projectRoot: string;
};

export type SqliteValue = string | number | bigint | boolean | Uint8Array | null;

export class SmithersDbNotFoundError extends Error {
  readonly code = 'SMITHERS_DB_NOT_FOUND';
  readonly dbPath: string;

  constructor(dbPath: string) {
    super(`Smithers database not found: ${dbPath}`);
    this.name = 'SmithersDbNotFoundError';
    this.dbPath = dbPath;
  }
}

export type SmithersDbReadOnlyHandle = {
  dbPath: string;
  sqlite: Database;
  drizzle: BunSQLiteDatabase<Record<string, unknown>>;
  adapter: SmithersDb;
  queryAll<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly SqliteValue[],
  ): T[];
  execForTest(sql: string): void;
  close(): void;
};

export function resolveSmithersDbPath(projectRoot: string) {
  return resolve(projectRoot, 'smithers.db');
}

export function openSmithersDbReadOnly(options: SqliteReadOnlyOpenOptions): SmithersDbReadOnlyHandle {
  const dbPath = resolveSmithersDbPath(options.projectRoot);
  if (!existsSync(dbPath)) {
    throw new SmithersDbNotFoundError(dbPath);
  }

  const sqlite = new Database(dbPath, { readonly: true });
  let closed = false;

  try {
    sqlite.exec('PRAGMA query_only = ON');
    const drizzleDb = drizzle(sqlite) as BunSQLiteDatabase<Record<string, unknown>>;
    const adapter = new SmithersDb(drizzleDb);

    function assertOpen() {
      if (closed) throw new Error(`Smithers database handle is closed: ${dbPath}`);
    }

    return {
      dbPath,
      sqlite,
      drizzle: drizzleDb,
      adapter,
      queryAll<T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: readonly SqliteValue[] = [],
      ) {
        assertOpen();
        return sqlite.query(sql).all(...params) as T[];
      },
      execForTest(sql: string) {
        assertOpen();
        sqlite.exec(sql);
      },
      close() {
        if (closed) return;
        closed = true;
        sqlite.close();
      },
    };
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // Ignore close failures after an open/setup failure.
    }
    throw error;
  }
}
