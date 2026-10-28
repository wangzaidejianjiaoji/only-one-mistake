import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Small JSON records keep transactions in SQLite and artifacts outside the DB. */
export class Store {
  db: DatabaseSync;
  closed = false;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS records (bucket TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(bucket,id));
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  get<T>(bucket: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE bucket=? AND id=?').get(bucket, id);
    return row ? JSON.parse(String(row.data)) as T : undefined;
  }
  list<T>(bucket: string): T[] {
    return this.db.prepare('SELECT data FROM records WHERE bucket=? ORDER BY rowid').all(bucket).map(r => JSON.parse(String(r.data)) as T);
  }
  put(bucket: string, id: string, data: unknown) {
    this.db.prepare('INSERT INTO records(bucket,id,data) VALUES(?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET data=excluded.data').run(bucket, id, JSON.stringify(data));
  }
  meta(key: string): string | undefined {
    return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value as string | undefined;
  }
  setMeta(key: string, value: string) {
    this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
