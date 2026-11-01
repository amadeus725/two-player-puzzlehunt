import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Store } from '../apps/server/store.js';
import { loadContents } from '../apps/server/content.js';
import { restoreBackup } from '../apps/server/backup.js';

const file = process.argv[2];
if (!file || !process.env.DATABASE_URL || !process.env.APP_SECRET) throw new Error('Usage: npm run restore -- <backup.json>; DATABASE_URL must point to an empty target database and APP_SECRET must match the backup.');
const store = new Store(process.env.DATABASE_URL, process.env.APP_SECRET, loadContents());
try { await store.init(); console.log('Restored:', await restoreBackup(store.pool, await readFile(file, 'utf8'), store.secret, store.contents)); }
finally { await store.pool.end(); }
