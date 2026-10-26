import { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient } from 'pg';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

type Result<T> = { rows: T[]; rowCount: number };
export type Db = { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Result<T>> };
let pglite: PGlite | undefined;
let pool: Pool | undefined;
let initPromise: Promise<void> | undefined;
let localTxQueue: Promise<unknown> = Promise.resolve();
const hasPg = Boolean(process.env.DATABASE_URL);
function local(): PGlite {
  if (!pglite) {
    const dir = process.env.MEDTRACE_DB_DIR || path.join(process.cwd(), 'data', 'medtrace');
    mkdirSync(path.dirname(dir), { recursive: true });
    pglite = new PGlite(dir);
  }
  return pglite;
}
function remote(): Pool { return pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 10 }); }
export async function migrate() {
  if (!initPromise) initPromise = (async () => {
    for (const file of ['001_initial.sql','002_security.sql',...(hasPg?['003_supabase_api_lockdown.sql']:[])]) {
      const sql = readFileSync(path.join(process.cwd(), 'migrations', file), 'utf8');
      if (hasPg) await remote().query(sql); else await local().exec(sql);
    }
  })().catch(error=>{initPromise=undefined;throw error;});
  return initPromise;
}
export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Result<T>> {
  await migrate();
  const r = hasPg ? await remote().query(sql, params) : await local().query(sql, params);
  return { rows: r.rows as T[], rowCount: ('rowCount' in r ? r.rowCount : undefined) ?? r.rows.length };
}
export async function transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  await migrate();
  if (hasPg) {
    const client: PoolClient = await remote().connect();
    try {
      await client.query('BEGIN');
      // A single transaction lock serializes all stock-changing actions and makes hold/shipment races deterministic.
      await client.query('SELECT pg_advisory_xact_lock(74182901)');
      const result = await fn({ query: async <R>(sql: string, params: unknown[] = []) => {
        const r = await client.query(sql, params); return { rows: r.rows as R[], rowCount: ('rowCount' in r ? r.rowCount : undefined) ?? r.rows.length };
      }});
      await client.query('COMMIT');
      return result;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  const work = localTxQueue.then(() => local().transaction(async tx => fn({ query: async <R>(sql: string, params: unknown[] = []) => {
    const r = await tx.query(sql, params); return { rows: r.rows as R[], rowCount: r.rows.length };
  }})));
  localTxQueue = work.catch(() => undefined);
  return work;
}
export function uid() { return crypto.randomUUID(); }
export async function one<T>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params); if (!r.rows[0]) throw new Error('Запись не найдена'); return r.rows[0];
}
export async function code(db: Db, table: string, prefix: string): Promise<string> {
  const allowed = new Set(['receipts','lots','production_orders','production_runs','shipments','nonconformities','recall_campaigns','customer_returns']);
  if (!allowed.has(table)) throw new Error('Invalid code table');
  const r = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return `${prefix}-${new Date().getFullYear()}-${String(Number(r.rows[0].n)+1).padStart(6,'0')}`;
}
