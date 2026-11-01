import { networkInterfaces } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parse } from 'dotenv';

const privateIp = ip => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
const interfaces = Object.entries(networkInterfaces()).flatMap(([name, addresses]) => (addresses ?? []).filter(a => a.family === 'IPv4' && !a.internal && privateIp(a.address)).map(a => ({ name, address: a.address })));
const candidates = interfaces.filter(a => !/vmware|vethernet|virtual|tailscale|docker|wsl|loopback/i.test(a.name));
const address = process.argv[2] ?? (candidates.length === 1 ? candidates[0].address : undefined);
if (!address || !interfaces.some(a => a.address === address)) {
  console.error('Choose a private IPv4 address assigned to this computer: npm run lan:configure -- <IPv4>');
  console.error(candidates); process.exit(1);
}
let source = existsSync('.env') ? readFileSync('.env', 'utf8') : readFileSync('.env.example', 'utf8').replace('replace-with-at-least-32-random-characters', randomBytes(48).toString('hex'));
const port = Number(parse(source).PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT in .env');
const origin = `http://${address}:${port}`;
const config = { HOST: '0.0.0.0', PUBLIC_ORIGIN: [...new Set(['http://localhost:5173', 'http://127.0.0.1:5173', `http://localhost:${port}`, `http://127.0.0.1:${port}`, origin])].join(','), COOKIE_SECURE: 'false' };
for (const [key, value] of Object.entries(config)) {
  const pattern = new RegExp(`^${key}=[^\\r\\n]*`, 'm');
  source = pattern.test(source) ? source.replace(pattern, `${key}=${value}`) : `${source.trimEnd()}\n${key}=${value}\n`;
}
writeFileSync('.env', source);
console.log(`LAN website: ${origin}\nConfiguration saved. Restart the game server to apply it; keep the database running.`);
