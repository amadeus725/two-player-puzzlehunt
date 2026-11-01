import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

// A project-local PostgreSQL process for Windows development; production uses Compose.
if (process.platform !== 'win32') throw new Error('Use npm run db:up on this platform.');
const bin = path.resolve('node_modules/@embedded-postgres/windows-x64/native/bin');
const directory = path.resolve('.local/postgres');
mkdirSync(path.dirname(directory), { recursive: true });
const run = (name: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(path.join(bin, `${name}.exe`), args, { windowsHide: true, stdio: 'inherit' });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)));
});
if (process.argv.includes('--stop')) {
  await run('pg_ctl', ['-D', directory, '-w', '-m', 'fast', 'stop']);
} else {
  if (!existsSync(path.join(directory, 'PG_VERSION'))) {
    const password = path.resolve('.local/init-password');
    writeFileSync(password, 'puzzlehunt_local', { mode: 0o600 });
    try { await run('initdb', ['-D', directory, '-U', 'puzzlehunt', '--pwfile', password, '-A', 'scram-sha-256', '--encoding=UTF8', '--locale=C']); }
    finally { unlinkSync(password); }
  }
  let started = false;
  try { await run('pg_ctl', ['-D', directory, 'status']); }
  catch { await run('pg_ctl', ['-D', directory, '-l', path.resolve('.local/postgres.log'), '-o', '-h 127.0.0.1 -p 55432', '-w', 'start']); started = true; }
  const client = new Client({ host: '127.0.0.1', port: 55432, user: 'puzzlehunt', password: 'puzzlehunt_local', database: 'postgres' });
  await client.connect();
  try {
    if (!(await client.query("SELECT 1 FROM pg_database WHERE datname='puzzlehunt'")).rowCount) await client.query('CREATE DATABASE puzzlehunt');
    console.log((await client.query('SELECT version()')).rows[0].version);
    console.log('Local database ready at 127.0.0.1:55432. Stop with npm run db:local:stop.');
  } finally { await client.end(); }
  if (started) {
    console.log('Keep this terminal open while developing. Ctrl+C stops the database safely.');
    const timer = setInterval(() => {}, 1000);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (stopping) return; stopping = true;
      void run('pg_ctl', ['-D', directory, '-w', '-m', 'fast', 'stop']).finally(() => { clearInterval(timer); process.exit(); });
    });
  }
}
