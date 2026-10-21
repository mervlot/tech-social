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
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT, google_id TEXT, email_verified INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, bio TEXT NOT NULL DEFAULT '', link TEXT, location TEXT, game_status TEXT, avatar_url TEXT, banner_url TEXT, cover_url TEXT, pinned_post_id TEXT, last_seen_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, author_id TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', media TEXT NOT NULL DEFAULT '[]', media_json TEXT NOT NULL DEFAULT '[]', parent_id TEXT, reply_to_id TEXT, repost_of_id TEXT, quoted_post_id TEXT, community_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, view_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS follows (follower_id TEXT NOT NULL, following_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (follower_id, following_id));
CREATE TABLE IF NOT EXISTS likes (user_id TEXT NOT NULL, post_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, post_id));
CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, author_id TEXT NOT NULL, content TEXT NOT NULL, parent_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS refresh_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, session_id TEXT, expires_at TEXT NOT NULL, revoked_at TEXT, user_agent TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS password_reset_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE IF NOT EXISTS blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (blocker_id, blocked_id));
CREATE TABLE IF NOT EXISTS mutes (muter_id TEXT NOT NULL, muted_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (muter_id, muted_id));
CREATE TABLE IF NOT EXISTS bookmarks (user_id TEXT NOT NULL, post_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, post_id));
CREATE TABLE IF NOT EXISTS stories (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', media_url TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS story_views (story_id TEXT NOT NULL, user_id TEXT NOT NULL, viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (story_id, user_id));
CREATE TABLE IF NOT EXISTS hashtags (id TEXT PRIMARY KEY, tag TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS post_hashtags (post_id TEXT NOT NULL, hashtag_id TEXT NOT NULL, PRIMARY KEY (post_id, hashtag_id));
CREATE TABLE IF NOT EXISTS mentions (post_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (post_id, user_id));
CREATE TABLE IF NOT EXISTS polls (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, question TEXT NOT NULL DEFAULT '', options TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS poll_votes (poll_id TEXT NOT NULL, user_id TEXT NOT NULL, option_index INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (poll_id, user_id));
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, recipient_id TEXT, actor_id TEXT, type TEXT NOT NULL DEFAULT '', post_id TEXT, read INTEGER NOT NULL DEFAULT 0, read_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS communities (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, avatar_url TEXT, banner_url TEXT, is_private INTEGER NOT NULL DEFAULT 0, owner_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS community_members (community_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'MEMBER', joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (community_id, user_id));
CREATE TABLE IF NOT EXISTS community_messages (id TEXT PRIMARY KEY, community_id TEXT NOT NULL, sender_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, user_a_id TEXT NOT NULL, user_b_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_a_id, user_b_id));
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, content TEXT, image_url TEXT, audio_url TEXT, video_note_url TEXT, media_duration_ms INTEGER, reply_to_id TEXT, edited_at TEXT, deleted_at TEXT, read_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS message_reactions (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(message_id, user_id, emoji));
CREATE TABLE IF NOT EXISTS community_message_reactions (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS posts_author_idx ON posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS likes_post_idx ON likes(post_id);
`);

// Existing Termux databases must be upgraded in place. CREATE TABLE IF NOT EXISTS
// does not add columns, so keep this migration additive and restart-safe.
const migrations: Record<string, Record<string, string>> = {
  users: { email_verified: 'INTEGER NOT NULL DEFAULT 0', verified: 'INTEGER NOT NULL DEFAULT 0', last_seen_at: 'TEXT', updated_at: "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP" },
  posts: { media_json: "TEXT NOT NULL DEFAULT '[]'", parent_id: 'TEXT', reply_to_id: 'TEXT', repost_of_id: 'TEXT', quoted_post_id: 'TEXT', community_id: 'TEXT', view_count: 'INTEGER NOT NULL DEFAULT 0', updated_at: "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP" },
  notifications: { recipient_id: 'TEXT', read: 'INTEGER NOT NULL DEFAULT 0' },
  refresh_tokens: { session_id: 'TEXT', revoked_at: 'TEXT', user_agent: 'TEXT', ip: 'TEXT', last_used_at: "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP" },
};
for (const [table, columns] of Object.entries(migrations)) {
  const existing = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((item) => item.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

const tableNames: Record<string, string> = {
  user: 'users', post: 'posts', follow: 'follows', like: 'likes', comment: 'comments', bookmark: 'bookmarks',
  refreshToken: 'refresh_tokens', passwordResetToken: 'password_reset_tokens', block: 'blocks', mute: 'mutes',
  story: 'stories', storyView: 'story_views', hashtag: 'hashtags', postHashtag: 'post_hashtags', mention: 'mentions',
  poll: 'polls', pollVote: 'poll_votes', notification: 'notifications', community: 'communities',
  communityMember: 'community_members', communityMessage: 'community_messages', conversation: 'conversations',
  message: 'messages', messageReaction: 'message_reactions', communityMessageReaction: 'community_message_reactions',
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
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && key.includes('_')) {
      return Object.entries(expected).every(([compoundKey, compoundValue]) => String(row[column(compoundKey)] ?? row[compoundKey]) === String(value(compoundValue)));
    }
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
    count: async (args: any = {}) => find(args).length,
    groupBy: async (args: any = {}) => {
      const groups = new Map<string, Row>();
      for (const row of find(args)) {
        const key = (args.by ?? []).map((field: string) => String(row[column(field)] ?? row[field])).join('|');
        const current = groups.get(key) ?? Object.fromEntries((args.by ?? []).map((field: string) => [field, row[column(field)] ?? row[field]]));
        current._count = { ...(current._count ?? {}), _all: (current._count?._all ?? 0) + 1 };
        groups.set(key, current);
      }
      return [...groups.values()];
    },
    create: async ({ data }: any) => { const row = { id: data.id ?? crypto.randomUUID(), ...data }; const keys = Object.keys(row).filter((key) => row[key] === null || typeof row[key] !== 'object' || row[key] instanceof Date); const columns = keys.map(column); sqlite.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((key) => value(row[key]))); return fromRow(sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.id) as Row); },
    update: async ({ where, data }: any) => { const current = find({ where })[0]; if (!current) throw new Error(`${name} not found`); const entries = Object.entries(data).filter(([, v]) => typeof v !== 'object' || v instanceof Date); sqlite.prepare(`UPDATE ${table} SET ${entries.map(([key]) => `${column(key)} = ?`).join(',')} WHERE id = ?`).run(...entries.map(([, v]) => value(v)), current.id); return find({ where: { id: current.id } })[0]; },
    updateMany: async ({ where, data }: any) => { const rows = find({ where }); for (const row of rows) await model(name).update({ where: { id: row.id }, data }); return { count: rows.length }; },
    deleteMany: async ({ where }: any = {}) => { const rows = find({ where }); for (const row of rows) sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id); return { count: rows.length }; },
    delete: async ({ where }: any) => { const row = find({ where })[0]; if (row) sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id); return row; },
    upsert: async ({ where, create, update }: any) => { const row = find({ where })[0]; return row ? model(name).update({ where: { id: row.id }, data: update }) : model(name).create({ data: create }); },
  };
}

export const db: any = new Proxy({ $transaction: async (ops: Promise<any>[]) => Promise.all(ops), $disconnect: async () => sqlite.close() }, { get: (target, name: string) => target[name] ?? model(name) });
