import 'dotenv/config';
import { loadContents } from './content.js';
import { Store } from './store.js';
import { createApp } from './app.js';

const secret = process.env.APP_SECRET;
if (!secret || secret.length < 32 || secret.startsWith('replace-')) throw new Error('Set a private APP_SECRET in .env (npm run dev generates a local one).');
const store = new Store(process.env.DATABASE_URL ?? 'postgres://puzzlehunt:puzzlehunt_local@127.0.0.1:55432/puzzlehunt', secret, loadContents());
await store.init();
const port = Number(process.env.PORT ?? 3000);
const origins = (process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000').split(',').map(x => x.trim());
if (!origins.some(x => x === 'http://127.0.0.1:5173') && origins.includes('http://localhost:5173')) origins.push('http://127.0.0.1:5173');
const server = createApp(store, { origins, secureCookie: process.env.COOKIE_SECURE === 'true' });
const host = process.env.HOST ?? '127.0.0.1';
server.http.listen(port, host, () => console.log(`Puzzlehunt API listening on ${host}:${port}; browser origins: ${origins.join(', ')}`));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, async () => { await server.close(); process.exit(0); });
