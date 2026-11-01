import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Content } from './content.js';

const tables = {
  sessions: ['id', 'token_hash', 'created_at'],
  rooms: ['id', 'code', 'state', 'created_at'],
  seats: ['room_id', 'seat_id', 'session_id', 'role_id', 'recovery_hash', 'control_epoch', 'controller_tab', 'view'],
  command_receipts: ['scope_key', 'command_id', 'payload_hash', 'result', 'created_at'],
} as const;
type Table = keyof typeof tables;
type Backup = { formatVersion: 1; createdAt: string; secretHash: string; contentHashes: Record<string, string>; rows: Record<Table, Record<string, any>[]> };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const contentHash = (content: Content) => hash(JSON.stringify({ game: content.game, answers: content.answers }));
export async function createBackup(pool: Pool, secret: string, contents: Map<string, Content>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const rows = {} as Backup['rows'];
    for (const table of Object.keys(tables) as Table[]) rows[table] = (await client.query(`SELECT * FROM ${table}`)).rows;
    const versions = new Set<string>(rows.rooms.map(row => row.state.contentVersion));
    const contentHashes: Record<string, string> = {};
    for (const version of versions) { const content = contents.get(version); if (!content) throw new Error(`Missing content version ${version}`); contentHashes[version] = contentHash(content); }
    const payload: Backup = { formatVersion: 1, createdAt: new Date().toISOString(), secretHash: hash(secret), contentHashes, rows };
    await client.query('COMMIT');
    const serialized = JSON.stringify(payload);
    return JSON.stringify({ checksum: hash(serialized), payload }, null, 2);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export async function restoreBackup(pool: Pool, serialized: string, secret: string, contents: Map<string, Content>) {
  const envelope = JSON.parse(serialized), backup = envelope.payload as Backup;
  if (!backup || backup.formatVersion !== 1 || envelope.checksum !== hash(JSON.stringify(backup))) throw new Error('Invalid backup format or checksum.');
  if (backup.secretHash !== hash(secret)) throw new Error('APP_SECRET must match the original server so recovery codes remain valid.');
  for (const [version, expected] of Object.entries(backup.contentHashes)) {
    const content = contents.get(version); if (!content || contentHash(content) !== expected) throw new Error(`Content version ${version} is missing or has changed.`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE sessions,rooms,seats,command_receipts IN ACCESS EXCLUSIVE MODE');
    for (const table of Object.keys(tables) as Table[]) {
      if ((await client.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount) throw new Error('Restore target must be empty. Restore into a new database, then switch DATABASE_URL.');
      if (!Array.isArray(backup.rows[table])) throw new Error(`Missing table ${table}.`);
    }
    for (const row of backup.rows.rooms) {
      if (row.state.saveSchemaVersion !== 1 || !backup.contentHashes[row.state.contentVersion]) throw new Error('Unsupported room save or content version.');
      row.state.saveEpoch = randomUUID();
    }
    for (const row of backup.rows.seats) { row.control_epoch++; row.controller_tab = null; }
    for (const table of Object.keys(tables) as Table[]) {
      const columns = tables[table];
      for (const row of backup.rows[table]) {
        const values = columns.map(column => { const value = row[column]; return value !== null && typeof value === 'object' ? JSON.stringify(value) : value; });
        await client.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`, values);
      }
    }
    await client.query('COMMIT'); return { rooms: backup.rows.rooms.length, createdAt: backup.createdAt };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
