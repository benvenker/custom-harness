import { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { dirname, parse, resolve } from 'node:path';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { SmithersDb } from '@smthrs/db/adapter';

export type SqliteReadOnlyOpenOptions = {
  projectRoot: string;
  dbPath?: string;
  dbSearchStart?: string;
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

export function resolveExistingSmithersDbPath(options: SqliteReadOnlyOpenOptions) {
  if (options.dbPath) {
    const explicitDbPath = resolve(options.dbPath);
    if (!existsSync(explicitDbPath)) throw new SmithersDbNotFoundError(explicitDbPath);
    return explicitDbPath;
  }

  if (options.dbSearchStart) {
    const discovered = findNearestSmithersDb(options.dbSearchStart);
    if (discovered) return discovered;
    throw new SmithersDbNotFoundError(resolveSearchStartCandidate(options.dbSearchStart));
  }

  const discovered = findNearestSmithersDb(options.projectRoot);
  if (discovered) return discovered;
  throw new SmithersDbNotFoundError(resolveSmithersDbPath(options.projectRoot));
}

function findNearestSmithersDb(start: string) {
  let current = resolveSearchStartDirectory(start);
  while (true) {
    const candidate = resolveSmithersDbPath(current);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveSearchStartCandidate(start: string) {
  return resolveSmithersDbPath(resolveSearchStartDirectory(start));
}

function resolveSearchStartDirectory(start: string) {
  const resolved = resolve(start);
  try {
    if (statSync(resolved).isDirectory()) return resolved;
  } catch {
    // Fall through to file-like path detection below.
  }
  const parsed = parse(resolved);
  return parsed.ext || basenameLike(parsed.base) ? dirname(resolved) : resolved;
}

function basenameLike(base: string) {
  return base.includes('.');
}

export function openSmithersDbReadOnly(options: SqliteReadOnlyOpenOptions): SmithersDbReadOnlyHandle {
  const dbPath = resolveExistingSmithersDbPath(options);

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
