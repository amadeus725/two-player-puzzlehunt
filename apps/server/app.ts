import express from 'express';
import { createServer } from 'node:http';
import { parse, serialize } from 'cookie';
import { Server } from 'socket.io';
import { z } from 'zod';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { RuleError } from './engine.js';
import { Store } from './store.js';
import { PROTOCOL_VERSION, type Reply, type RoomSnapshot } from '../../packages/protocol/index.js';

const uuid = z.string().uuid();
const commandSchema = z.object({ protocolVersion: z.number().int(), saveEpoch: uuid, commandId: uuid, controlEpoch: z.number().int(),
  type: z.enum(['role:claim', 'player:move', 'puzzle:open', 'puzzle:close', 'puzzle:submit', 'npc:interact', 'npc:close']), payload: z.record(z.string(), z.unknown()), mapId: z.string().optional(), mapEpoch: z.number().int().optional(), viewId: uuid.optional() });
const failure = (error: unknown): Reply => ({ ok: false, code: error instanceof RuleError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : 'STORAGE_UNAVAILABLE' });
export function createApp(store: Store, options: { origins: string[]; secureCookie: boolean; staticDirectory?: string }) {
  const app = express(), http = createServer(app);
  const allowed = (origin?: string) => !!origin && options.origins.includes(origin);
  const sameHost = (origin: string, host?: string) => new URL(origin).host === host;
  app.disable('x-powered-by'); app.use(express.json({ limit: '16kb' }));
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); if (!['GET', 'HEAD'].includes(req.method) && !allowed(req.get('origin'))) { res.status(403).json({ ok: false, code: 'ORIGIN_DENIED' }); return; } next(); });
  const io = new Server(http, { transports: ['polling', 'websocket'], pingInterval: 25000, pingTimeout: 20000, maxHttpBufferSize: 16384,
    // Same-origin polling GETs omit Origin. LAN HTTP also omits Sec-Fetch-Site;
    // in that case require an exact configured Referer origin and matching Host.
    allowRequest: (req, callback) => {
      if (req.headers.origin) { callback(null, allowed(req.headers.origin)); return; }
      const site = req.headers['sec-fetch-site'];
      if (site) { callback(null, site === 'same-origin' && options.origins.some(origin => sameHost(origin, req.headers.host))); return; }
      try {
        const referer = new URL(req.headers.referer ?? '').origin;
        callback(null, allowed(referer) && sameHost(referer, req.headers.host));
      } catch { callback(null, false); }
    }, cors: { origin: options.origins, credentials: true } });
  const owners = new Map<string, string>();
  const lastMoves = new Map<string, number>();
  const sessionOf = async (cookies?: string) => { const value = await store.session(parse(cookies ?? '').ph_session); if (!value) throw new RuleError('SESSION_INVALID'); return value.id; };
  const route = (handler: express.RequestHandler): express.RequestHandler => (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(error => { if (!(error instanceof RuleError) && !(error instanceof z.ZodError)) console.error('Request failed:', error instanceof Error ? error.message : 'unknown'); res.status(error instanceof RuleError ? 400 : error instanceof z.ZodError ? 400 : 503).json(failure(error)); }); };
  app.get('/api/health', route(async (_req, res) => { await store.pool.query('SELECT 1'); res.json({ ok: true, protocolVersion: PROTOCOL_VERSION }); }));
  app.get('/api/session', route(async (req, res) => {
    let session = await store.session(parse(req.headers.cookie ?? '').ph_session);
    if (!session) {
      const created = await store.createSession(); session = created;
      res.setHeader('Set-Cookie', serialize('ph_session', created.token, { httpOnly: true, secure: options.secureCookie, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 365 }));
    }
    res.json({ ok: true, sessionId: session.id, rooms: await store.recentRooms(session.id) });
  }));
  app.post('/api/rooms', route(async (req, res) => { const session = await sessionOf(req.headers.cookie); const body = z.object({ entryRequestId: uuid }).parse(req.body); res.json({ ok: true, ...await store.entry(session, body.entryRequestId, 'create') }); }));
  app.post('/api/rooms/join', route(async (req, res) => { const session = await sessionOf(req.headers.cookie); const body = z.object({ entryRequestId: uuid, code: z.string().trim().min(1).max(20) }).parse(req.body); res.json({ ok: true, ...await store.entry(session, body.entryRequestId, 'join', body.code.toUpperCase()) }); }));
  app.post('/api/rooms/recover', route(async (req, res) => {
    const session = await sessionOf(req.headers.cookie); const body = z.object({ code: z.string().trim().max(20), recoveryCode: z.string().trim().min(20).max(100) }).parse(req.body);
    const recovered = await store.recover(session, body.code.toUpperCase(), body.recoveryCode);
    io.in(`seat:${recovered.roomId}:${recovered.seatId}`).emit('control:lost');
    io.in(`seat:${recovered.roomId}:${recovered.seatId}`).disconnectSockets(true);
    owners.delete(`${recovered.roomId}:${recovered.seatId}`); res.json({ ok: true, ...recovered });
  }));
  app.get('/api/rooms/:id', route(async (req, res) => { res.json(await store.read(uuid.parse(req.params.id), await sessionOf(req.headers.cookie))); }));
  app.get('/api/rooms/:id/puzzles/:puzzleId', route(async (req, res) => {
    const snapshot = await store.read(uuid.parse(req.params.id), await sessionOf(req.headers.cookie));
    if (snapshot.view.kind !== 'puzzle' || snapshot.view.targetId !== req.params.puzzleId) throw new RuleError('VIEW_REQUIRED'); res.json(snapshot.view.content);
  }));
  const presence = (roomId: string) => io.to(roomId).emit('room:presence', Object.fromEntries(['1', '2'].map(s => [s, owners.has(`${roomId}:${s}`)])));
  io.use(async (socket, next) => { try { socket.data.sessionId = await sessionOf(socket.request.headers.cookie); next(); } catch { next(new Error('SESSION_INVALID')); } });
  io.on('connection', socket => {
    const guarded = (event: string, handler: (payload: any) => Promise<unknown>) => socket.on(event, async (payload, ack) => {
      if (typeof ack !== 'function') return;
      try { ack(await handler(payload)); } catch (error) { if (!(error instanceof RuleError) && !(error instanceof z.ZodError)) console.error(`${event}:`, error instanceof Error ? error.message : 'unknown'); ack(failure(error)); }
    });
    guarded('room:enter', async payload => {
      const p = z.object({ roomId: uuid, tabId: uuid, epochHint: z.number().int().optional(), takeover: z.boolean().default(false), protocolVersion: z.literal(PROTOCOL_VERSION) }).parse(payload);
      const existing = await store.read(p.roomId, socket.data.sessionId);
      const currentOwner = owners.get(`${p.roomId}:${existing.seatId}`);
      const liveOwner = currentOwner && io.sockets.sockets.get(currentOwner)?.connected;
      const ownConnection = currentOwner === socket.id && socket.data.tabId === p.tabId;
      // Duplicated browser tabs can inherit sessionStorage, including tabId and
      // epochHint. A live connection still requires an explicit takeover.
      const snapshot = ownConnection ? { ...existing, hasControl: true }
        : liveOwner && !p.takeover ? existing
        : await store.control(p.roomId, socket.data.sessionId, p.tabId, p.epochHint, p.takeover);
      if (!socket.connected) throw new RuleError('SESSION_INVALID');
      const previousRoom = socket.data.roomId as string | undefined;
      if (previousRoom && previousRoom !== p.roomId) {
        const oldKey = `${previousRoom}:${socket.data.seatId}`;
        if (owners.get(oldKey) === socket.id) owners.delete(oldKey);
        await socket.leave(previousRoom); await socket.leave(`seat:${oldKey}`); presence(previousRoom);
      }
      socket.data.roomId = p.roomId; socket.data.seatId = snapshot.seatId; socket.data.tabId = p.tabId;
      await socket.join(p.roomId); await socket.join(`seat:${p.roomId}:${snapshot.seatId}`);
      if (snapshot.hasControl) {
        const key = `${p.roomId}:${snapshot.seatId}`, old = owners.get(key);
        if (old && old !== socket.id) io.to(old).emit('control:lost'); owners.set(key, socket.id);
      }
      presence(p.roomId); return { ok: true, snapshot };
    });
    guarded('room:sync', async () => {
      if (!socket.data.roomId) throw new RuleError('SESSION_INVALID');
      const snapshot = await store.read(socket.data.roomId, socket.data.sessionId);
      snapshot.hasControl = owners.get(`${snapshot.world.id}:${snapshot.seatId}`) === socket.id;
      return { ok: true, snapshot };
    });
    guarded('command:status', async payload => {
      if (!socket.data.roomId) throw new RuleError('SESSION_INVALID');
      const p = z.object({ saveEpoch: uuid, commandId: uuid }).parse(payload);
      return { ok: true, receipt: await store.status(socket.data.roomId, socket.data.sessionId, p.saveEpoch, p.commandId) };
    });
    guarded('command', async payload => {
      const command = commandSchema.parse(payload);
      const roomId = socket.data.roomId as string, key = `${roomId}:${socket.data.seatId}`;
      if (!roomId || owners.get(key) !== socket.id) throw new RuleError('CONTROL_LOST');
      if (command.type === 'player:move') {
        const now = performance.now(), last = lastMoves.get(key) ?? 0;
        if (now - last < 100) return { ok: true, result: { moved: false, throttled: true } }; lastMoves.set(key, now);
      }
      const outcome = await store.command(roomId, socket.data.sessionId, socket.data.tabId, command);
      // Snapshots are published only after the database transaction has committed.
      io.to(roomId).emit('room:state', outcome.snapshot.world);
      io.to(`seat:${roomId}:${outcome.snapshot.seatId}`).emit('view:state', outcome.snapshot.view);
      return outcome.reply;
    });
    socket.on('disconnect', () => { const roomId = socket.data.roomId as string; const key = `${roomId}:${socket.data.seatId}`; if (owners.get(key) === socket.id) { owners.delete(key); lastMoves.delete(key); } if (roomId) presence(roomId); });
  });
  const staticDirectory = options.staticDirectory ?? path.resolve('dist/web');
  if (existsSync(path.join(staticDirectory, 'index.html'))) {
    app.use(express.static(staticDirectory, { index: false }));
    app.get('/{*splat}', (req, res) => { if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) { res.sendStatus(404); return; } res.sendFile(path.join(staticDirectory, 'index.html')); });
  }
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(400).json({ ok: false, code: 'INVALID_INPUT' }); });
  return { app, http, io, close: async () => { await new Promise<void>(resolve => io.close(() => resolve())); await store.pool.end(); } };
}
