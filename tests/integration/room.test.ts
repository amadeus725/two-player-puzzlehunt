import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { Store } from '../../apps/server/store.js';
import { createApp } from '../../apps/server/app.js';
import { createBackup, restoreBackup } from '../../apps/server/backup.js';
import { loadContents, validateContent } from '../../apps/server/content.js';
import { applyCommand, emptyView, type Aggregate } from '../../apps/server/engine.js';
import type { Command, CommandType, Direction, Reply, RoomSnapshot } from '../../packages/protocol/index.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('two independent sessions over real HTTP / Socket.IO / PostgreSQL', { timeout: 90000 }, async t => {
  const base = process.env.TEST_DATABASE_URL ?? 'postgresql://puzzlehunt:puzzlehunt_local@127.0.0.1:55432/puzzlehunt';
  const admin = new Pool({ connectionString: base });
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(base); url.searchParams.set('options', `-c search_path=${schema}`);
  const contents = loadContents(), content = contents.get('demo-v2')!;
  const secret = 'integration-only-secret-at-least-thirty-two-characters';
  let store = new Store(url.toString(), secret, contents, 'demo-v2'); await store.init();
  const origins = ['http://localhost:4173'];
  let server = createApp(store, { origins, secureCookie: false });
  const start = async () => { await new Promise<void>(resolve => server.http.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(server.http.address() as { port: number }).port}`; origins.push(origin); return origin; };
  let address = await start();
  const sockets: Socket[] = [];
  type Browser = { cookie: string; sessionId: string; socket?: Socket; snapshot?: RoomSnapshot; tabId: string; seenWorld: number; seenView: number };
  const http = async (browser: Browser | null, route: string, body?: unknown) => {
    const response = await fetch(address + route, { method: body ? 'POST' : 'GET', headers: { Origin: 'http://localhost:4173', ...(browser ? { Cookie: browser.cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { response, body: await response.json() };
  };
  const browser = async (): Promise<Browser> => { const r = await http(null, '/api/session'); return { cookie: r.response.headers.get('set-cookie')!.split(';')[0], sessionId: r.body.sessionId, tabId: randomUUID(), seenWorld: 0, seenView: 0 }; };
  const ask = (b: Browser, event: string, payload: unknown): Promise<any> => b.socket!.timeout(5000).emitWithAck(event, payload);
  let roomId: string;
  const connect = async (b: Browser, takeover = false) => {
    const socket = io(address, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: { Cookie: b.cookie, Origin: 'http://localhost:4173' } });
    sockets.push(socket); b.socket = socket;
    socket.on('room:state', () => b.seenWorld++); socket.on('view:state', () => b.seenView++);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
    const r = await ask(b, 'room:enter', { roomId, tabId: b.tabId, epochHint: b.snapshot?.controlEpoch, protocolVersion: 1, takeover });
    assert.equal(r.ok, true); b.snapshot = r.snapshot; return r.snapshot as RoomSnapshot;
  };
  const sync = async (b: Browser): Promise<RoomSnapshot> => { const r = await ask(b, 'room:sync', {}); assert.equal(r.ok, true); b.snapshot = r.snapshot; return r.snapshot; };
  const command = (b: Browser, type: CommandType, payload: Record<string, unknown> = {}): Command => ({ protocolVersion: 1, controlEpoch: b.snapshot!.controlEpoch, saveEpoch: b.snapshot!.world.saveEpoch, commandId: randomUUID(), type, payload, mapId: b.snapshot!.world.currentMapId, mapEpoch: b.snapshot!.world.mapEpoch, viewId: b.snapshot!.view.viewId ?? undefined });
  const send = async (b: Browser, type: CommandType, payload: Record<string, unknown> = {}) => { await sync(b); if (type === 'player:move') await delay(110); const r: Reply = await ask(b, 'command', command(b, type, payload)); assert.equal(r.ok, true, JSON.stringify(r)); await sync(b); return r; };
  const move = (b: Browser, direction: Direction) => send(b, 'player:move', { direction });
  const a = await browser(), b = await browser(), outsider = await browser();
  try {
    await t.test('entry retries reuse the room; two seats only; private content and room permissions', async () => {
      const entryRequestId = randomUUID(); const created = await http(a, '/api/rooms', { entryRequestId }); roomId = created.body.roomId;
      assert.equal((await http(a, '/api/rooms', { entryRequestId })).body.roomId, roomId);
      const own = await http(a, `/api/rooms/${roomId}`); const code = own.body.world.code;
      assert.equal((await http(b, '/api/rooms/join', { entryRequestId: randomUUID(), code })).body.seatId, '2');
      assert.equal((await http(outsider, '/api/rooms/join', { entryRequestId: randomUUID(), code })).body.code, 'ROOM_FULL');
      assert.equal((await http(outsider, `/api/rooms/${roomId}`)).body.code, 'SESSION_INVALID');
      assert.equal((await http(a, `/api/rooms/${roomId}/puzzles/p1`)).body.code, 'VIEW_REQUIRED');
      assert.equal(own.body.game.puzzles[0].body, undefined); assert.equal(own.body.game.npcs[0].text, undefined);
      const polling = await fetch(address + '/socket.io/?EIO=4&transport=polling', { headers: { 'Sec-Fetch-Site': 'same-origin' } }); assert.equal(polling.status, 200);
      const crossSite = await fetch(address + '/socket.io/?EIO=4&transport=polling', { headers: { 'Sec-Fetch-Site': 'cross-site' } }); assert.equal(crossSite.status, 403);
      // A real browser on LAN HTTP sends neither Origin nor Fetch Metadata.
      const handshake = (headers: Record<string, string>) => fetch(address + '/socket.io/?EIO=4&transport=polling', { headers });
      assert.equal((await handshake({ Referer: address + '/rooms/' + roomId })).status, 200);
      assert.equal((await handshake({ Referer: 'https://untrusted.invalid/' })).status, 403);
      assert.equal((await handshake({ Referer: address + '.untrusted.invalid/' })).status, 403);
      assert.equal((await handshake({ Referer: 'http://localhost:4173/' })).status, 403); // allowed origin, wrong Host
      assert.equal((await handshake({ Referer: 'malformed' })).status, 403);
      assert.equal((await handshake({})).status, 403);
      assert.equal((await handshake({ Origin: 'https://untrusted.invalid', Referer: address + '/' })).status, 403);
      assert.equal((await handshake({ 'Sec-Fetch-Site': 'cross-site', Referer: address + '/' })).status, 403);
      const denied = await fetch(address + '/api/rooms', { method: 'POST', headers: { Origin: 'https://wrong.invalid', Cookie: a.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ entryRequestId: randomUUID() }) }); assert.equal(denied.status, 403);
      await connect(a); await connect(b);
    });
    await t.test('role race chooses one winner; begin only once and broadcast identical state', async () => {
      const pre = await ask(a, 'command', command(a, 'player:move', { direction: 'down' })); assert.equal(pre.code, 'GAME_NOT_STARTED');
      const responses = await Promise.all([ask(a, 'command', command(a, 'role:claim', { roleId: 'role-1' })), ask(b, 'command', command(b, 'role:claim', { roleId: 'role-1' }))]);
      assert.equal(responses.filter(r => r.ok).length, 1); assert.equal(responses.find(r => !r.ok).code, 'ROLE_TAKEN');
      const loser = responses[0].ok ? b : a; await send(loser, 'role:claim', { roleId: 'role-2' });
      assert.deepEqual((await sync(a)).world, (await sync(b)).world); assert.equal(a.snapshot!.world.phase, 'active');
      assert.ok(a.seenWorld > 0 && b.seenWorld > 0);
    });
    // Resolve paths through actual rules, then execute each step over Socket.IO.
    const walkTo = async (goal: (s: Aggregate) => boolean) => {
      await sync(a); await sync(b);
      const initial: Aggregate = { world: a.snapshot!.world, views: { '1': a.snapshot!.view, '2': b.snapshot!.view } };
      const key = (s: Aggregate) => JSON.stringify([s.world.currentMapId, s.world.disabledPortal, ...Object.values(s.world.players).flatMap(p => [p.x, p.y])]);
      const queue = [{ state: initial, moves: [] as [Browser, Direction][] }], seen = new Set([key(initial)]);
      let route: [Browser, Direction][] | undefined;
      for (let i = 0; i < queue.length; i++) {
        const node = queue[i]; if (goal(node.state)) { route = node.moves; break; }
        for (const actor of [a, b]) for (const direction of ['up', 'down', 'left', 'right'] as Direction[]) {
          if (node.state.views[actor.snapshot!.seatId].kind) continue;
          const cmd = { ...command(actor, 'player:move', { direction }), mapId: node.state.world.currentMapId, mapEpoch: node.state.world.mapEpoch };
          const result = applyCommand(node.state, actor.snapshot!.seatId, cmd, content);
          if (!result.result.moved) continue;
          const k = key(result.state); if (seen.has(k)) continue; seen.add(k); queue.push({ state: result.state, moves: [...node.moves, [actor, direction]] });
        }
      }
      assert.ok(route, 'reachable fixture goal'); for (const [actor, direction] of route) await move(actor, direction);
    };
    await t.test('windows are private; simultaneous submissions serialize; retries do not overwrite newer answers', async () => {
      await walkTo(s => s.world.currentMapId === 'center' && s.world.players['1'].x === 1 && s.world.players['1'].y === 1);
      const otherViewCount = b.seenView; await send(a, 'puzzle:open', { targetId: 'p1' }); assert.equal(b.seenView, otherViewCount);
      await walkTo(s => s.world.players['2'].x === 1 && s.world.players['2'].y === 1); await send(b, 'puzzle:open', { targetId: 'p1' });
      await sync(a); await sync(b);
      const concurrent = await Promise.all([ask(a, 'command', command(a, 'puzzle:submit', { puzzleId: 'p1', answer: 'OPEN' })), ask(b, 'command', command(b, 'puzzle:submit', { puzzleId: 'p1', answer: 'WRONG' }))]);
      assert.ok(concurrent.every(r => r.ok)); assert.notEqual(concurrent[0].revision, concurrent[1].revision);
      assert.equal((await sync(a)).world.puzzles.p1.answer, concurrent[0].revision > concurrent[1].revision ? 'OPEN' : 'WRONG');
      await sync(a); const old = command(a, 'puzzle:submit', { puzzleId: 'p1', answer: 'OPEN' });
      assert.equal((await ask(a, 'command', old)).ok, true); await send(b, 'puzzle:submit', { puzzleId: 'p1', answer: 'WRONG' });
      await send(a, 'puzzle:close'); const revision = (await sync(a)).world.revision;
      assert.equal((await ask(a, 'command', old)).result.solved, true);
      assert.equal((await sync(a)).world.puzzles.p1.answer, 'WRONG'); assert.equal(a.snapshot!.world.revision, revision);
      assert.equal((await ask(a, 'command', { ...old, payload: { puzzleId: 'p1', answer: 'NEW' } })).code, 'COMMAND_ID_CONFLICT');
      assert.equal((await ask(a, 'command:status', { saveEpoch: old.saveEpoch, commandId: old.commandId })).receipt.ok, true);
      await send(b, 'puzzle:submit', { puzzleId: 'p1', answer: 'OPEN' });
    });
    await t.test('database failure rolls back progress and receipts, then same request can succeed', async () => {
      await sync(b); const before = b.snapshot!.world; const cmd = command(b, 'puzzle:submit', { puzzleId: 'p1', answer: 'WRONG' });
      await store.pool.query("CREATE FUNCTION reject_test_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected test failure'; END $$; CREATE TRIGGER reject_test_write BEFORE UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION reject_test_write()");
      try {
        assert.equal((await ask(b, 'command', cmd)).code, 'STORAGE_UNAVAILABLE'); assert.deepEqual((await sync(b)).world, before);
        assert.equal((await ask(b, 'command:status', { saveEpoch: cmd.saveEpoch, commandId: cmd.commandId })).receipt, null);
      } finally { await store.pool.query('DROP TRIGGER reject_test_write ON rooms; DROP FUNCTION reject_test_write()'); }
      assert.equal((await ask(b, 'command', cmd)).ok, true); await send(b, 'puzzle:close');
    });
    await t.test('all five maps and final completion work over the network', async () => {
      for (const mapId of ['south', 'center', 'west', 'center', 'north', 'center', 'east']) await walkTo(s => s.world.currentMapId === mapId);
      await walkTo(s => s.world.currentMapId === 'east' && s.world.players['1'].x === 2 && s.world.players['1'].y === 2);
      await send(a, 'puzzle:open', { targetId: 'p-final' }); await send(a, 'puzzle:submit', { puzzleId: 'p-final', answer: 'DONE' }); const first = a.snapshot!.world.completedAt;
      await send(a, 'puzzle:submit', { puzzleId: 'p-final', answer: 'AGAIN' }); assert.equal(a.snapshot!.world.puzzles['p-final'].answerVariantId, 'ending-b');
      await send(a, 'puzzle:submit', { puzzleId: 'p-final', answer: 'WRONG' }); assert.equal(a.snapshot!.world.completedAt, first); assert.equal(a.snapshot!.world.phase, 'completed');
      assert.deepEqual(a.snapshot!.world, (await sync(b)).world);
    });
    await t.test('explicit takeover rejects old connection; reconnect and server restart restore private view', async () => {
      const duplicated: Browser = { ...a, socket: undefined };
      assert.equal((await connect(duplicated)).hasControl, false, 'Duplicated tab inherits identity but must not steal live control');
      assert.equal((await sync(a)).hasControl, true);
      const currentEpoch = a.snapshot!.controlEpoch;
      const repeated = await ask(a, 'room:enter', { roomId, tabId: a.tabId, protocolVersion: 1, epochHint: currentEpoch - 1 });
      assert.equal(repeated.snapshot.hasControl, true); assert.equal(repeated.snapshot.controlEpoch, currentEpoch, 'Retry on the same socket is idempotent');
      const another: Browser = { ...a, tabId: randomUUID(), socket: undefined };
      assert.equal((await connect(another)).hasControl, false);
      assert.equal((await ask(another, 'room:enter', { roomId, tabId: another.tabId, protocolVersion: 1, takeover: true })).snapshot.hasControl, true);
      assert.equal((await ask(a, 'command', command(a, 'puzzle:submit', { puzzleId: 'p-final', answer: 'DONE' }))).code, 'CONTROL_LOST');
      await sync(another); const saved = another.snapshot!; another.socket!.disconnect(); await connect(another); assert.equal(another.snapshot!.hasControl, true); assert.deepEqual(another.snapshot!.view, saved.view);
      sockets.forEach(s => s.disconnect()); await server.close();
      store = new Store(url.toString(), secret, contents, 'demo-v2'); await store.init(); server = createApp(store, { origins, secureCookie: false }); address = await start();
      await connect(another); assert.deepEqual(another.snapshot!.world, saved.world); assert.deepEqual(another.snapshot!.view, saved.view);
      assert.equal(another.snapshot!.recoveryCode, saved.recoveryCode);
      const recovered = await http(outsider, '/api/rooms/recover', { code: saved.world.code, recoveryCode: saved.recoveryCode }); assert.equal(recovered.body.seatId, '1');
      assert.equal((await http(a, `/api/rooms/${roomId}`)).body.code, 'SESSION_INVALID');
      await connect(outsider); assert.equal(outsider.snapshot!.hasControl, true); assert.deepEqual(outsider.snapshot!.view, saved.view);
    });
    await t.test('consistent backup restores to an empty target with a fresh save epoch and rejects old commands', async () => {
      const serialized = await createBackup(store.pool, secret, contents);
      const saved = (await sync(outsider)).world; const oldCommand = command(outsider, 'puzzle:submit', { puzzleId: 'p-final', answer: 'DONE' });
      await send(outsider, 'puzzle:submit', { puzzleId: 'p-final', answer: 'DONE' });
      const restoreSchema = `test_${randomUUID().replaceAll('-', '')}`; await admin.query(`CREATE SCHEMA "${restoreSchema}"`);
      const targetUrl = new URL(base); targetUrl.searchParams.set('options', `-c search_path=${restoreSchema}`);
      const restored = new Store(targetUrl.toString(), secret, contents, 'demo-v2'); await restored.init();
      try {
        await assert.rejects(() => restoreBackup(restored.pool, serialized.replace('"formatVersion": 1', '"formatVersion": 2'), secret, contents), /Invalid backup/);
        await restoreBackup(restored.pool, serialized, secret, contents);
        const snapshot = await restored.read(roomId, outsider.sessionId); assert.notEqual(snapshot.world.saveEpoch, saved.saveEpoch);
        assert.deepEqual({ ...snapshot.world, saveEpoch: saved.saveEpoch }, saved); assert.ok(snapshot.world.revision < outsider.snapshot!.world.revision);
        assert.equal(snapshot.view.kind, 'puzzle'); assert.equal(snapshot.recoveryCode, outsider.snapshot!.recoveryCode);
        const active = await restored.control(roomId, outsider.sessionId, outsider.tabId, undefined, false);
        await assert.rejects(() => restored.command(roomId, outsider.sessionId, outsider.tabId, { ...oldCommand, controlEpoch: active.controlEpoch }), (error: any) => error.code === 'STALE_SAVE');
        await assert.rejects(() => restoreBackup(restored.pool, serialized, secret, contents), /target must be empty/);
      } finally { await restored.pool.end(); assert.match(restoreSchema, /^test_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${restoreSchema}" CASCADE`); }
    });
    await t.test('new content affects new rooms only; missing or incompatible old saves fail explicitly', async () => {
      const next = structuredClone(content); next.game.contentVersion = 'demo-v3'; next.answers.contentVersion = 'demo-v3';
      const versions = new Map(contents); versions.set('demo-v3', validateContent(next.game, next.answers));
      const upgraded = new Store(url.toString(), secret, versions, 'demo-v3');
      try {
        const session = await upgraded.createSession(); const fresh = await upgraded.entry(session.id, randomUUID(), 'create');
        assert.equal((await upgraded.read(fresh.roomId, session.id)).world.contentVersion, 'demo-v3');
        assert.equal((await upgraded.read(roomId, outsider.sessionId)).world.contentVersion, 'demo-v2');
        versions.delete('demo-v2'); await assert.rejects(() => upgraded.read(roomId, outsider.sessionId), (error: any) => error.code === 'CONTENT_VERSION_UNAVAILABLE'); versions.set('demo-v2', content);
        await upgraded.pool.query("UPDATE rooms SET state=jsonb_set(state,'{saveSchemaVersion}','99'::jsonb) WHERE id=$1", [fresh.roomId]);
        await assert.rejects(() => upgraded.read(fresh.roomId, session.id), (error: any) => error.code === 'CLIENT_UPDATE_REQUIRED');
      } finally { await upgraded.pool.end(); }
    });
    await t.test('a dropped idle database connection is replaced without crashing the game', async () => {
      const pid = (await store.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await delay(80);
      assert.equal((await http(outsider, '/api/health')).body.ok, true);
      assert.equal((await sync(outsider)).world.id, roomId);
    });
  } finally {
    sockets.forEach(s => s.disconnect()); await server.close();
    // Only this run's freshly generated schema is removed. Development saves are untouched.
    assert.match(schema, /^test_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  }
});
