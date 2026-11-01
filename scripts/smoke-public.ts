import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { io, type Socket } from 'socket.io-client';
import type { CommandType, RoomSnapshot } from '../packages/protocol/index.js';

// Uses a new test room and independent sessions; never touches an existing save.
const address = new URL(process.argv[2] ?? '').origin;
const endpoint = new URL(address);
const isLan = endpoint.protocol === 'http:' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(endpoint.hostname);
assert.ok(endpoint.protocol === 'https:' || isLan, 'Pass the public HTTPS URL or a private LAN HTTP address.');
type Client = { cookie: string; tabId: string; socket?: Socket; snapshot?: RoomSnapshot; latest?: RoomSnapshot['world'] };
const clients: Client[] = [];
let roomId: string;
async function request(client: Client | null, route: string, body?: unknown) {
  const response = await fetch(address + route, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(30000),
    headers: { Origin: address, ...(client ? { Cookie: client.cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.match(response.headers.get('content-type') ?? '', /application\/json/, `${route}: HTTP ${response.status} returned a non-JSON response`);
  return { response, body: await response.json() };
}
async function client() {
  const r = await request(null, '/api/session');
  assert.equal(r.body.ok, true);
  const cookie = r.response.headers.get('set-cookie')!;
  assert.equal(/; Secure(?:;|$)/i.test(cookie), !isLan); assert.match(cookie, /; HttpOnly/i);
  const c: Client = { cookie: cookie.split(';')[0], tabId: randomUUID() };
  clients.push(c); return c;
}
const ask = (c: Client, event: string, payload: unknown): Promise<any> => c.socket!.timeout(15000).emitWithAck(event, payload);
async function connect(c: Client, polling = false) {
  c.socket = io(address, { transports: polling ? ['polling', 'websocket'] : ['websocket'], autoConnect: false, reconnection: false, timeout: 20000, extraHeaders: { Cookie: c.cookie, Origin: address } });
  c.socket.on('room:state', world => { c.latest = world; });
  await new Promise<void>((resolve, reject) => { c.socket!.once('connect', resolve); c.socket!.once('connect_error', reject); c.socket!.connect(); });
  const r = await ask(c, 'room:enter', { roomId, tabId: c.tabId, epochHint: c.snapshot?.controlEpoch, protocolVersion: 1 });
  assert.equal(r.ok, true); assert.equal(r.snapshot.hasControl, true); c.snapshot = r.snapshot;
}
async function sync(c: Client) {
  const r = await ask(c, 'room:sync', {}); assert.equal(r.ok, true); c.snapshot = r.snapshot as RoomSnapshot; return c.snapshot;
}
async function send(c: Client, type: CommandType, payload: Record<string, unknown> = {}) {
  const s = await sync(c);
  if (type === 'player:move') await delay(120);
  const r = await ask(c, 'command', { protocolVersion: 1, commandId: randomUUID(), controlEpoch: s.controlEpoch, saveEpoch: s.world.saveEpoch, type, payload, mapId: s.world.currentMapId, mapEpoch: s.world.mapEpoch, viewId: s.view.viewId ?? undefined });
  assert.equal(r.ok, true, JSON.stringify(r)); return sync(c);
}
async function broadcast(c: Client, revision: number) {
  const deadline = Date.now() + 10000;
  while ((c.latest?.revision ?? -1) < revision && Date.now() < deadline) await delay(100);
  assert.equal(c.latest?.revision, revision, 'The other player must receive the state broadcast.');
}
async function regions(a: Client, b: Client) {
  const directions = [{ direction:'up',dx:0,dy:-1 },{ direction:'down',dx:0,dy:1 },{ direction:'left',dx:-1,dy:0 },{ direction:'right',dx:1,dy:0 }];
  async function walk(c: Client, x: number, y: number) {
    const s = await sync(c), map = s.game.maps.find(m=>m.id===s.world.currentMapId)!;
    const player = s.world.players[s.seatId], other = s.world.players[s.seatId==='1'?'2':'1'];
    const paths = new Set(map.paths.map(p=>p.join(','))), blocked = new Set(s.game.npcs.filter(n=>n.mapId===map.id).map(n=>`${n.x},${n.y}`));
    blocked.add(`${other.x},${other.y}`);
    for (const g of s.game.portalGroups) for (const side of g.sides.filter(t=>t.mapId===map.id)) for (const d of side.doors) if (d.x!==x||d.y!==y) blocked.add(`${d.x},${d.y}`);
    const queue = [{x:player.x!,y:player.y!,steps:[] as string[]}], seen = new Set<string>(); let steps: string[] | undefined;
    while(queue.length) {
      const at=queue.shift()!, key=`${at.x},${at.y}`; if(seen.has(key)) continue; seen.add(key);
      if(at.x===x&&at.y===y) { steps=at.steps; break; }
      for(const d of directions) {
        const nx=at.x+d.dx,ny=at.y+d.dy,k=`${nx},${ny}`;
        const wall=map.walls.some(w=>(w.from[0]===at.x&&w.from[1]===at.y&&w.to[0]===nx&&w.to[1]===ny)||(w.to[0]===at.x&&w.to[1]===at.y&&w.from[0]===nx&&w.from[1]===ny));
        if(paths.has(k)&&!blocked.has(k)&&!wall&&!seen.has(k)) queue.push({x:nx,y:ny,steps:[...at.steps,d.direction]});
      }
    }
    assert.ok(steps, `No route for seat ${s.seatId} to ${map.id}:${x},${y}`);
    for(const direction of steps) await send(c,'player:move',{direction});
    const after = await sync(c);
    if(after.world.currentMapId===map.id) assert.deepEqual([after.world.players[s.seatId].x,after.world.players[s.seatId].y],[x,y]);
  }
  async function open(c: Client, id: string) {
    const p=c.snapshot!.game.puzzles.find(p=>p.id===id)!; assert.equal(c.snapshot!.world.currentMapId,p.placement.mapId);
    await walk(c,p.placement.x,p.placement.y); await send(c,'puzzle:open',{targetId:id});
  }
  const answer = (c: Client, id: string, value: string) => send(c,'puzzle:submit',{puzzleId:id,answer:value});
  async function travel(target: string, permitted = true) {
    const s=await sync(a), group=s.game.portalGroups.find(g=>g.sides.some(t=>t.mapId===s.world.currentMapId)&&g.sides.some(t=>t.mapId===target))!;
    const side=group.sides.find(t=>t.mapId===s.world.currentMapId)!;
    if(s.world.disabledPortal===group.id) {
      const p=s.world.players['1'], map=s.game.maps.find(m=>m.id===s.world.currentMapId)!;
      const next=map.paths.find(([x,y])=>Math.abs(x-p.x!)+Math.abs(y-p.y!)===1&&!side.doors.some(d=>d.x===x&&d.y===y));
      assert.ok(next); await walk(a,next[0],next[1]);
    }
    await walk(a,side.doors[0].x,side.doors[0].y);
    // If B was already on its door, A's arrival completes the pair immediately.
    if ((await sync(a)).world.currentMapId !== s.world.currentMapId) { assert.ok(permitted); assert.equal(a.snapshot!.world.currentMapId,target); return; }
    await walk(b,side.doors[1].x,side.doors[1].y);
    assert.equal((await sync(a)).world.currentMapId,permitted?target:s.world.currentMapId);
  }
  const gate = a.snapshot!.game.portalGroups.find(g=>g.unlockAfter)!;
  await travel('west',false);
  await travel('north');
  await open(a,'north-a'); await open(b,'north-b');
  await answer(a,'north-a','LEAF'); await answer(b,'north-b','WRONG');
  assert.equal((await sync(b)).world.puzzles['north-a'].solved,true);
  await answer(b,'north-b','STONE'); await answer(a,'north-a','WRONG');
  assert.equal((await sync(a)).world.puzzles['north-b'].solved,true);
  assert.equal(a.snapshot!.view.targetId,'north-a'); assert.equal(b.snapshot!.view.targetId,'north-b');
  await send(a,'puzzle:close'); await send(b,'puzzle:close'); await travel('center');
  for(const [id,value] of [['meta-north','NORTH'],['meta-east','EAST'],['meta-south','SOUTH']]) {
    await open(a,id); const solved=await answer(a,id,value); await broadcast(b,solved.world.revision); await send(a,'puzzle:close');
  }
  const opened=a.snapshot!.world.unlockedPortals![gate.id]; assert.ok(opened);
  await open(a,'meta-north'); await answer(a,'meta-north','WRONG'); await send(a,'puzzle:close');
  b.socket!.disconnect(); await delay(500); await connect(b,true);
  assert.equal(b.snapshot!.world.unlockedPortals![gate.id],opened);
  await travel('west'); await open(a,'final'); await answer(a,'final','DONE');
  assert.equal((await sync(b)).world.phase,'completed');
  await answer(a,'final','AGAIN'); await answer(a,'final','WRONG');
  assert.equal(a.snapshot!.world.phase,'completed'); await send(a,'puzzle:close'); await travel('center');
  for(const target of ['east','south']) { await travel(target); await travel('center'); }
  assert.equal(a.snapshot!.world.unlockedPortals![gate.id],opened);
  assert.equal(a.socket!.io.engine.transport.name,'websocket'); assert.equal(b.socket!.io.engine.transport.name,'websocket');
  console.log('PASS five region routes, closed west entry, independent north parts, three metas, permanent gate, reconnect and west final');
}
async function run() {
  assert.equal((await request(null, '/api/health')).body.ok, true);
  const home = await fetch(address, { signal: AbortSignal.timeout(30000) });
  assert.equal(home.status, 200); assert.match(await home.text(), /<div id="root">/);
  const polling = await fetch(address + '/socket.io/?EIO=4&transport=polling', { headers: isLan ? { Referer: address + '/' } : { 'Sec-Fetch-Site': 'same-origin' }, signal: AbortSignal.timeout(30000) });
  assert.equal(polling.status, 200, 'Same-origin browser polling handshake');
  console.log(`PASS ${endpoint.protocol} frontend, database health, same-origin polling handshake`);
  const a = await client(), b = await client(), outsider = await client();
  const created = await request(a, '/api/rooms', { entryRequestId: randomUUID() });
  assert.equal(created.body.ok, true); roomId = created.body.roomId;
  const initial = await request(a, `/api/rooms/${roomId}`), code = initial.body.world.code;
  const joined = await request(b, '/api/rooms/join', { entryRequestId: randomUUID(), code });
  assert.equal(joined.body.seatId, '2');
  assert.equal((await request(outsider, '/api/rooms/join', { entryRequestId: randomUUID(), code })).body.code, 'ROOM_FULL');
  const denied = await fetch(address + '/api/rooms', { method: 'POST', headers: { Origin: 'https://untrusted.invalid', Cookie: a.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ entryRequestId: randomUUID() }), signal: AbortSignal.timeout(30000) });
  assert.equal(denied.status, 403);
  await connect(a); await connect(b, true);
  await send(a, 'role:claim', { roleId: 'role-1' });
  await send(b, 'role:claim', { roleId: 'role-2' });
  assert.equal((await sync(a)).world.phase, 'active');
  console.log('PASS two independent cookie sessions with correct transport flags, room capacity, Origin guard, role selection');
  if (a.snapshot!.world.contentVersion === 'demo-v3') {
    await regions(a,b);
    console.log(`Test room: ${roomId} (${code}); existing rooms unchanged.`); return;
  }
  await send(a, 'player:move', { direction: 'down' });
  await send(a, 'player:move', { direction: 'right' });
  await send(a, 'puzzle:open', { targetId: 'p1' });
  assert.equal((await sync(b)).view.kind, null);
  let solved = await send(a, 'puzzle:submit', { puzzleId: 'p1', answer: 'OPEN' });
  await broadcast(b, solved.world.revision);
  await send(b, 'player:move', { direction: 'right' });
  await send(b, 'player:move', { direction: 'down' });
  await send(b, 'puzzle:open', { targetId: 'p2' });
  assert.equal((await sync(a)).view.targetId, 'p1'); assert.equal(b.snapshot!.view.targetId, 'p2');
  const beforeReconnect = b.snapshot!;
  b.socket!.disconnect(); await delay(500); await connect(b, true);
  assert.equal(b.snapshot!.view.viewId, beforeReconnect.view.viewId);
  assert.deepEqual(b.snapshot!.world.players, beforeReconnect.world.players);
  await send(b, 'puzzle:close');
  solved = await send(a, 'puzzle:submit', { puzzleId: 'p1', answer: 'WRONG' });
  await broadcast(b, solved.world.revision);
  const at = (c: Client) => ({ x: c.snapshot!.world.players['2'].x, y: c.snapshot!.world.players['2'].y });
  await sync(b); const trapped = at(b);
  assert.deepEqual(trapped, { x: 2, y: 1 });
  await send(b, 'player:move', { direction: 'down' });
  assert.deepEqual(at(b), trapped);
  solved = await send(a, 'puzzle:submit', { puzzleId: 'p1', answer: 'OPEN' });
  await broadcast(b, solved.world.revision);
  await send(b, 'player:move', { direction: 'down' });
  assert.deepEqual(at(b), { x: 2, y: 2 });
  assert.equal(a.socket!.io.engine.transport.name, 'websocket');
  assert.equal(b.socket!.io.engine.transport.name, 'websocket');
  console.log('PASS WebSocket/upgrade, movement broadcasts, independent puzzles, relock/rescue, reconnect');
  console.log(`Test room: ${roomId} (${code}); existing rooms unchanged.`);
}
try { await run(); } finally { for (const c of clients) c.socket?.disconnect(); }
