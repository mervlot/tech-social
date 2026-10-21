import { Database } from 'node-sqlite3-wasm';
import path from 'node:path';
import fs from 'node:fs';

const dataDir = process.env.SQLITE_DATA_DIR ?? path.resolve(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });

const globalForDb = globalThis as unknown as { db?: Database };

// The application exposes a model-shaped database facade; keep its legacy contract while the SQLite driver changes underneath.
export const db: any = globalForDb.db ?? new Database(
  process.env.SQLITE_PATH ?? path.join(dataDir, 'social-network.db'),
);

db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

if (process.env.NODE_ENV !== 'production') globalForDb.db = db;
