import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

type Row = Record<string, any>;
type Where = Record<string, any>;

const dataDir = path.resolve(process.env.SQLITE_DATA_DIR ?? path.join(process.cwd(), 'data'));
const databasePath = path.resolve(process.env.SQLITE_PATH ?? path.join(dataDir, 'social-network.db'));
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const globalForDb = globalThis as typeof globalThis & { sqliteDb?: DatabaseSync };
export const sqlite = globalForDb.sqliteDb ?? new DatabaseSync(databasePath);
if (process.env.NODE_ENV !== 'production') globalForDb.sqliteDb = sqlite;

sqlite.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT, google_id TEXT, email_verified INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, bio TEXT NOT NULL DEFAULT '', link TEXT, location TEXT, game_status TEXT, avatar_url TEXT, banner_url TEXT, cover_url TEXT, pinned_post_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, author_id TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', media TEXT NOT NULL DEFAULT '[]', media_json TEXT NOT NULL DEFAULT '[]', parent_id TEXT, reply_to_id TEXT, repost_of_id TEXT, quoted_post_id TEXT, community_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, view_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS follows (follower_id TEXT NOT NULL, following_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (follower_id, following_id));
CREATE TABLE IF NOT EXISTS likes (user_id TEXT NOT NULL, post_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, post_id));
CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, author_id TEXT NOT NULL, content TEXT NOT NULL, parent_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS refresh_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, session_id TEXT, expires_at TEXT NOT NULL, revoked_at TEXT, user_agent TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS password_reset_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE IF NOT EXISTS blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (blocker_id, blocked_id));
CREATE TABLE IF NOT EXISTS mutes (muter_id TEXT NOT NULL, muted_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (muter_id, muted_id));
CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS posts_author_idx ON posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS likes_post_idx ON likes(post_id);
`);

const tableNames: Record<string, string> = {
  user: 'users', post: 'posts', follow: 'follows', like: 'likes', comment: 'comments',
  refreshToken: 'refresh_tokens', passwordResetToken: 'password_reset_tokens', block: 'blocks', mute: 'mutes',
};
const column = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const value = (input: any) => input instanceof Date ? input.toISOString() : typeof input === 'boolean' ? (input ? 1 : 0) : input;
const fromRow = (row: Row | undefined): Row | null => {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, val]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), val]));
};

function matches(row: Row, where: Where = {}) {
  if (where.OR) return where.OR.some((part: Where) => matches(row, part));
  if (where.AND) return where.AND.every((part: Where) => matches(row, part));
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'NOT') return !matches(row, expected);
    const actual = row[column(key)] ?? row[key];
    if (expected === null) return actual == null;
    if (typeof expected !== 'object' || expected instanceof Date) return String(actual) === String(value(expected));
    if ('in' in expected) return expected.in.map(value).map(String).includes(String(actual));
    if ('notIn' in expected) return !expected.notIn.map(value).map(String).includes(String(actual));
    if ('gt' in expected) return new Date(actual).getTime() > new Date(value(expected.gt)).getTime();
    if ('gte' in expected) return new Date(actual).getTime() >= new Date(value(expected.gte)).getTime();
    if ('lt' in expected) return new Date(actual).getTime() < new Date(value(expected.lt)).getTime();
    if ('lte' in expected) return new Date(actual).getTime() <= new Date(value(expected.lte)).getTime();
    if ('not' in expected) return String(actual) !== String(value(expected.not));
    return matches(row, expected);
  });
}

function model(name: string): any {
  const table = tableNames[name];
  if (!table) return new Proxy({}, { get: () => async () => [] });
  const all = () => sqlite.prepare(`SELECT * FROM ${table}`).all() as Row[];
  const find = (args: any = {}) => all().map(fromRow).filter((row) => matches(row!, args.where)).map((row) => row!);
  return {
    findFirst: async (args: any = {}) => find(args)[0] ?? null,
    findUnique: async (args: any = {}) => find(args)[0] ?? null,
    findMany: async (args: any = {}) => find(args).slice(0, args.take ?? 1000),
    create: async ({ data }: any) => { const row = { id: data.id ?? crypto.randomUUID(), ...data }; const keys = Object.keys(row); sqlite.prepare(`INSERT INTO ${table} (${keys.map(column).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((key) => value(row[key]))); return fromRow(sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.id) as Row); },
    update: async ({ where, data }: any) => { const current = find({ where })[0]; if (!current) throw new Error(`${name} not found`); const entries = Object.entries(data).filter(([, v]) => typeof v !== 'object' || v instanceof Date); sqlite.prepare(`UPDATE ${table} SET ${entries.map(([key]) => `${column(key)} = ?`).join(',')} WHERE id = ?`).run(...entries.map(([, v]) => value(v)), current.id); return find({ where: { id: current.id } })[0]; },
    updateMany: async ({ where, data }: any) => { const rows = find({ where }); for (const row of rows) await model(name).update({ where: { id: row.id }, data }); return { count: rows.length }; },
    deleteMany: async ({ where }: any = {}) => { const rows = find({ where }); for (const row of rows) sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id); return { count: rows.length }; },
    delete: async ({ where }: any) => { const row = find({ where })[0]; if (row) sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id); return row; },
    upsert: async ({ where, create, update }: any) => { const row = find({ where })[0]; return row ? model(name).update({ where: { id: row.id }, data: update }) : model(name).create({ data: create }); },
  };
}

export const db: any = new Proxy({ $transaction: async (ops: Promise<any>[]) => Promise.all(ops), $disconnect: async () => sqlite.close() }, { get: (target, name: string) => target[name] ?? model(name) });
