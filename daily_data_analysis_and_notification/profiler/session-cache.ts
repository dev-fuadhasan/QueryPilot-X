import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import type { Session } from "../../src/lib/session";
import type { DatabaseProfile, TableProfile } from "./types";

const PROFILE_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
const ROWS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const MAX_POOLS = 12;
const MAX_DB_PROFILE_ENTRIES = 32;
const MAX_TABLE_PROFILE_ENTRIES = 128;
const MAX_ROWS_CACHE_ENTRIES = 24;
const MAX_PREV_DATE_ENTRIES = 128;

let cachedCaCert: string | null | undefined;

function loadSupabaseCaCert(): string | null {
  if (cachedCaCert !== undefined) return cachedCaCert;
  try {
    cachedCaCert = fs.readFileSync(path.join(process.cwd(), "prod-ca-2021.crt"), "utf8");
  } catch {
    cachedCaCert = null;
  }
  return cachedCaCert;
}

const poolMap = new Map<string, Pool>();

function getReadOnlyPool(connectionString: string): Pool {
  const existing = poolMap.get(connectionString);
  if (existing) return existing;

  // Evict oldest pool if cache is full
  if (poolMap.size >= MAX_POOLS) {
    const oldestKey = poolMap.keys().next().value;
    if (oldestKey) {
      const oldPool = poolMap.get(oldestKey);
      poolMap.delete(oldestKey);
      void oldPool?.end().catch(() => undefined);
    }
  }

  const ca = loadSupabaseCaCert();
  const pool = new Pool({
    connectionString,
    ssl: ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: false },
    max: 6,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 6_500,
    allowExitOnIdle: true
  });
  pool.on("error", () => {
    // Prevent unhandled idle client errors from crashing Node process
  });
  poolMap.set(connectionString, pool);
  return pool;
}

/**
 * Executes a strictly read-only SQL query on a warm pooled PostgreSQL connection.
 * Reuses TLS/TCP connections across parallel profiling, intelligence, and PDF queries
 * instead of paying a fresh handshake on every single query.
 */
export async function queryPostgresPooled(
  connectionString: string,
  sql: string
): Promise<Array<Record<string, unknown>>> {
  const pool = getReadOnlyPool(connectionString);
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '12000ms'");
    const result = await client.query(sql);
    await client.query("ROLLBACK");
    return result.rows as Array<Record<string, unknown>>;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Derives a stable, opaque, user/session-isolated cache namespace so cached profiles
 * and scoped rows can never leak across different connected databases or sessions.
 */
export function deriveSessionCacheKey(session: Session): string {
  const raw = session.mode === "oauth"
    ? `oauth|${session.projectRef || ""}|${session.accessToken ? createHash("sha256").update(session.accessToken).digest("hex").slice(0, 16) : ""}`
    : `pg|${session.dbUrl || ""}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

type CacheEntry<T> = { value: T; expiresAt: number };

const dbProfileCache = new Map<string, CacheEntry<DatabaseProfile>>();
const tableProfileCache = new Map<string, CacheEntry<TableProfile>>();
const prevDateCache = new Map<string, CacheEntry<string | null>>();

type CachedTableRows = {
  columns: Set<string>;
  windowStart: string | null;
  windowEnd: string | null;
  isFullTable: boolean;
  rows: Array<Record<string, unknown>>;
  expiresAt: number;
};

const tableRowsCache = new Map<string, CachedTableRows>();

function setBounded<K, V>(map: Map<K, V>, key: K, val: V, maxSize: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

export function getCachedDatabaseProfile(cacheKey: string): DatabaseProfile | null {
  const hit = dbProfileCache.get(cacheKey);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    dbProfileCache.delete(cacheKey);
    return null;
  }
  return hit.value;
}

export function setCachedDatabaseProfile(
  sessionKey: string,
  cacheKey: string,
  profile: DatabaseProfile
): void {
  const expiresAt = Date.now() + PROFILE_CACHE_TTL_MS;
  setBounded(dbProfileCache, cacheKey, { value: profile, expiresAt }, MAX_DB_PROFILE_ENTRIES);
  // Also populate per-table profile cache so intelligence/PDF routes get 0ms hits immediately!
  for (const table of profile.tables) {
    setBounded(
      tableProfileCache,
      `${sessionKey}::${table.name}`,
      { value: table, expiresAt },
      MAX_TABLE_PROFILE_ENTRIES
    );
  }
}

export function getCachedTableProfile(sessionKey: string, tableName: string): TableProfile | null {
  const key = `${sessionKey}::${tableName}`;
  const hit = tableProfileCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    tableProfileCache.delete(key);
    return null;
  }
  return hit.value;
}

export function setCachedTableProfile(sessionKey: string, table: TableProfile): void {
  setBounded(
    tableProfileCache,
    `${sessionKey}::${table.name}`,
    { value: table, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS },
    MAX_TABLE_PROFILE_ENTRIES
  );
}

export function getCachedTableRows(input: {
  sessionKey: string;
  tableName: string;
  requiredColumns: string[];
  windowStart: string | null;
  windowEnd: string | null;
}): Array<Record<string, unknown>> | null {
  const key = `${input.sessionKey}::${input.tableName}`;
  const hit = tableRowsCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    tableRowsCache.delete(key);
    return null;
  }
  for (const col of input.requiredColumns) {
    if (!hit.columns.has(col)) return null;
  }
  if (hit.isFullTable) {
    return hit.rows;
  }
  if (
    input.windowStart
    && input.windowEnd
    && hit.windowStart
    && hit.windowEnd
    && hit.windowStart <= input.windowStart
    && hit.windowEnd >= input.windowEnd
  ) {
    return hit.rows;
  }
  return null;
}

export function setCachedTableRows(input: {
  sessionKey: string;
  tableName: string;
  columns: string[];
  windowStart: string | null;
  windowEnd: string | null;
  isFullTable: boolean;
  rows: Array<Record<string, unknown>>;
}): void {
  const key = `${input.sessionKey}::${input.tableName}`;
  const existing = tableRowsCache.get(key);
  // Don't overwrite a full-table cache with a narrower subset window unless expired
  if (existing && Date.now() <= existing.expiresAt && existing.isFullTable && !input.isFullTable) {
    const allCovered = input.columns.every(c => existing.columns.has(c));
    if (allCovered) return;
  }
  setBounded(
    tableRowsCache,
    key,
    {
      columns: new Set(input.columns),
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      isFullTable: input.isFullTable,
      rows: input.rows,
      expiresAt: Date.now() + ROWS_CACHE_TTL_MS
    },
    MAX_ROWS_CACHE_ENTRIES
  );
}

export function getCachedPreviousActiveDate(
  sessionKey: string,
  tableName: string,
  dateColumn: string,
  beforeDate: string
): { hit: true; value: string | null } | { hit: false } {
  const key = `${sessionKey}::${tableName}::${dateColumn}::${beforeDate}`;
  const entry = prevDateCache.get(key);
  if (!entry) return { hit: false };
  if (Date.now() > entry.expiresAt) {
    prevDateCache.delete(key);
    return { hit: false };
  }
  return { hit: true, value: entry.value };
}

export function setCachedPreviousActiveDate(
  sessionKey: string,
  tableName: string,
  dateColumn: string,
  beforeDate: string,
  value: string | null
): void {
  const key = `${sessionKey}::${tableName}::${dateColumn}::${beforeDate}`;
  setBounded(prevDateCache, key, { value, expiresAt: Date.now() + ROWS_CACHE_TTL_MS }, MAX_PREV_DATE_ENTRIES);
}

export function clearSessionPerformanceCaches(sessionKey?: string): void {
  if (!sessionKey) {
    dbProfileCache.clear();
    tableProfileCache.clear();
    tableRowsCache.clear();
    prevDateCache.clear();
    return;
  }
  const prefix = `${sessionKey}::`;
  for (const key of [...dbProfileCache.keys()]) {
    if (key.startsWith(prefix)) dbProfileCache.delete(key);
  }
  for (const key of [...tableProfileCache.keys()]) {
    if (key.startsWith(prefix)) tableProfileCache.delete(key);
  }
  for (const key of [...tableRowsCache.keys()]) {
    if (key.startsWith(prefix)) tableRowsCache.delete(key);
  }
  for (const key of [...prevDateCache.keys()]) {
    if (key.startsWith(prefix)) prevDateCache.delete(key);
  }
}

/**
 * Runs async tasks with bounded concurrency so parallel DB queries stay fast
 * without exhausting Supabase connection pools.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) break;
        results[idx] = await worker(items[idx], idx);
      }
    })
  );
  return results;
}
