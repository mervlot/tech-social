import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const dataDir = process.env.SQLITE_DATA_DIR ?? path.resolve(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });

const globalForDb = globalThis as unknown as { db?: Database.Database };

export const db: any = globalForDb.db ?? new Database(
  process.env.SQLITE_PATH ?? path.join(dataDir, 'social-network.db'),
);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

if (process.env.NODE_ENV !== 'production') globalForDb.db = db;
