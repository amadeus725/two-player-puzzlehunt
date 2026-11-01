import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

if (!existsSync('.env')) {
  writeFileSync('.env', readFileSync('.env.example', 'utf8').replace('replace-with-at-least-32-random-characters', randomBytes(48).toString('hex')));
}
const children = [
  spawn(process.execPath, ['--watch', '--import', 'tsx', 'apps/server/main.ts'], { stdio: 'inherit', windowsHide: true }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', windowsHide: true }),
];
const stop = () => { for (const child of children) child.kill(); };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(0); });
for (const child of children) child.on('exit', code => { stop(); process.exit(code ?? 0); });
