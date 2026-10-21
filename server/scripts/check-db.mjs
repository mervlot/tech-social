import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const dataDir = path.resolve(process.env.SQLITE_DATA_DIR ?? path.join(process.cwd(), 'data'));
const databasePath = path.resolve(process.env.SQLITE_PATH ?? path.join(dataDir, 'social-network.db'));
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
console.log(`SQLite database: ${databasePath}`);
console.log(`Tables: ${tables.map((table) => table.name).join(', ') || '(none)'}`);
db.close();
