import { env } from 'cloudflare:workers';
import type { Store } from './types';

export const defaultAccountId = 'local';
export function database() {
  if (!env.DB) throw new Error('Database is not configured');
  return env.DB.withSession('first-primary');
}
export function storage(): R2Bucket {
  if (!env.BUCKET) throw new Error('Photo storage is not configured');
  return env.BUCKET;
}
const initial = (): Store => ({ accounts: [{ id: defaultAccountId, name: 'My workspace', createdAt: new Date().toISOString() }], trips: [], photos: [], recaps: [], jobs: [] });
export async function readStore(): Promise<Store> {
  const row = await database().prepare('SELECT json FROM workspace WHERE id=1').first<{ json: string }>();
  return row ? JSON.parse(row.json) as Store : initial();
}
// Conditional revisions prevent separate Worker instances from overwriting each other.
// Callbacks can rerun; perform external I/O outside them.
export async function mutateStore<T>(fn: (store: Store) => T): Promise<T> {
  const db = database();
  await db.prepare('INSERT OR IGNORE INTO workspace (id,json,version) VALUES (1,?,0)').bind(JSON.stringify(initial())).run();
  for (let attempt = 0; attempt < 12; attempt++) {
    const row = await db.prepare('SELECT json,version FROM workspace WHERE id=1').first<{ json: string; version: number }>();
    if (!row) throw new Error('Workspace could not be loaded');
    const store = JSON.parse(row.json) as Store;
    const result = fn(store);
    if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Store callbacks must be synchronous');
    const updated = await db.prepare('UPDATE workspace SET json=?, version=version+1 WHERE id=1 AND version=?').bind(JSON.stringify(store), row.version).run();
    if (updated.meta.changes === 1) return result;
  }
  throw new Error('The workspace is busy. Please retry.');
}
export async function bindOwner(userId: string) {
  if (!userId) throw new Error('Sign in to continue');
  const db = database();
  await db.prepare('INSERT OR IGNORE INTO owner_identity (id,user_id) VALUES (1,?)').bind(userId).run();
  const owner = await db.prepare('SELECT user_id FROM owner_identity WHERE id=1').first<{user_id:string}>();
  if (owner?.user_id !== userId) throw new Error('This workspace belongs to another user');
}
