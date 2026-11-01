import 'dotenv/config';
import { mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../apps/server/store.js';
import { loadContents } from '../apps/server/content.js';
import { createBackup } from '../apps/server/backup.js';

if (!process.env.DATABASE_URL || !process.env.APP_SECRET) throw new Error('DATABASE_URL and APP_SECRET are required.');
const store = new Store(process.env.DATABASE_URL, process.env.APP_SECRET, loadContents());
const directory = path.resolve(process.env.BACKUP_DIR ?? '.local-backups');
await mkdir(directory, { recursive: true });
const backup = async () => {
  const file = path.join(directory, `puzzlehunt-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await writeFile(file, await createBackup(store.pool, store.secret, store.contents), { flag: 'wx', mode: 0o600 });
  console.log(`Saved ${file}`);
  // Retention only applies to this script's own generated files in its backup directory.
  for (const name of await readdir(directory)) {
    if (!/^puzzlehunt-\d{4}-\d{2}-\d{2}T[\d.-]+Z\.json$/.test(name)) continue;
    const candidate = path.join(directory, name);
    if ((await stat(candidate)).mtimeMs < Date.now() - 7 * 86400000) await unlink(candidate);
  }
};
try {
  await backup();
  if (process.argv.includes('--watch')) {
    const timer = setInterval(() => { void backup().catch(error => console.error('Backup failed:', error.message)); }, 3600000);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clearInterval(timer); void store.pool.end().then(() => process.exit()); });
  } else await store.pool.end();
} catch (error) { await store.pool.end(); throw error; }
