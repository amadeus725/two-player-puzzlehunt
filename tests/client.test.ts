import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { newId } from '../apps/web/src/id.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PortalProgress } from '../apps/web/src/App.js';
import { resilientStorage, storage } from '../apps/web/src/storage.js';
import { loadContents } from '../apps/server/content.js';
import { emptyView, newWorld } from '../apps/server/engine.js';
import type { RoomSnapshot } from '../packages/protocol/index.js';
import type { Socket } from 'socket.io-client';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:5173' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { renderHook, act, waitFor, cleanup } = await import('@testing-library/react');
const { useRoom } = await import('../apps/web/src/useRoom.js');
const content = loadContents().get('demo-v2')!;
function fixture(id: string): RoomSnapshot {
  const world = newWorld(id, 'CLIENTTEST', content); world.phase = 'active';
  world.players['1'] = { roleId: 'role-1', x: 1, y: 1, facing: 'down' };
  return { world, game: content.publicGame, seatId: '1', hasControl: true, controlEpoch: 1, view: { ...emptyView(), kind: 'puzzle', targetId: 'p1', viewId: randomUUID(), saveEpoch: world.saveEpoch } };
}
class FakeSocket {
  connected = false;
  listeners = new Map<string, ((...args: any[]) => void)[]>();
  requests: { event: string; payload: any; ack: (error: unknown, reply?: any) => void }[] = [];
  on(event: string, handler: (...args: any[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]); return this; }
  fire(event: string, payload?: unknown) { for (const handler of this.listeners.get(event) ?? []) handler(payload); }
  connect() { this.connected = true; this.fire('connect'); }
  disconnect() { this.connected = false; this.fire('disconnect'); }
  timeout() { return this; }
  emit(event: string, payload: unknown, ack: (error: unknown, reply?: any) => void) { this.requests.push({ event, payload, ack }); }
  volatile = { emit: (event: string, payload: unknown, ack: any) => this.emit(event, payload, (_error, reply) => ack(reply)) };
  take(event: string) { const index = this.requests.findIndex(r => r.event === event); assert.notEqual(index, -1, `Expected ${event}`); return this.requests.splice(index, 1)[0]; }
}
const respond = async (s: FakeSocket, event: string, reply: any) => { await act(async () => { s.take(event).ack(null, reply); }); };
test.afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

test('gate status remains permanently open while a meta is currently wrong', () => {
  const region = loadContents().get('demo-v3')!;
  const world = newWorld(randomUUID(), 'GATE', region), gate = region.game.portalGroups.find(g => g.unlockAfter)!;
  const snapshot: RoomSnapshot = { ...fixture(world.id), world, game: region.publicGame };
  const html = () => renderToStaticMarkup(createElement(PortalProgress, { snapshot }));
  assert.match(html(), /0 \/ 3 Meta/);
  world.unlockedPortals = { [gate.id]: new Date().toISOString() };
  assert.match(html(), /已永久开放/); assert.match(html(), /之后修改答案也不会关闭/);
});

test('failed storage writes and removals do not resurrect old pending commands', () => {
  const values = new Map([['draft', '"old"']]);
  const backend = { getItem: (key: string) => values.get(key) ?? null, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('disabled'); } } as unknown as Storage;
  const cached = resilientStorage(() => backend); cached.set('draft', 'new'); assert.equal(cached.get('draft'), 'new'); cached.remove('draft'); assert.equal(cached.get('draft'), null);
});

test('LAN HTTP without crypto.randomUUID can create entry, tab, and answer command IDs', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  const cryptoProvider = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: cryptoProvider.getRandomValues.bind(cryptoProvider) } });
  const socket = new FakeSocket(), snapshot = fixture(randomUUID());
  try {
    z.uuid().parse(newId());
    const hook = renderHook(() => useRoom(snapshot.world.id, true, () => socket as unknown as Socket));
    const enter = socket.take('room:enter'); z.uuid().parse((enter.payload as { tabId: string }).tabId);
    await act(async () => enter.ack(null, { ok: true, snapshot }));
    await respond(socket, 'room:sync', { ok: true, snapshot });
    act(() => { void hook.result.current.submit('OPEN'); });
    await respond(socket, 'command:status', { ok: true, receipt: null });
    const sent = socket.take('command'); z.uuid().parse(sent.payload.commandId);
    assert.notEqual(sent.payload.commandId, (enter.payload as { tabId: string }).tabId);
    await act(async () => sent.ack(null, { ok: true, result: { solved: true } }));
    await respond(socket, 'room:sync', { ok: true, snapshot });
    assert.equal(hook.result.current.feedback?.solved, true);
  } finally {
    cleanup(); Object.defineProperty(globalThis, 'crypto', original);
  }
});
test('a late enter response from a previous room cannot overwrite the new room or its notice', async () => {
  const first = new FakeSocket(), second = new FakeSocket(), sockets = [first, second];
  const a = randomUUID(), b = randomUUID();
  const secondSnapshot = fixture(b);
  const hook = renderHook(({ id }) => useRoom(id, true, () => sockets.shift()! as unknown as Socket), { initialProps: { id: a } });
  const stale = first.take('room:enter'); hook.rerender({ id: b });
  await respond(second, 'room:enter', { ok: true, snapshot: secondSnapshot });
  await respond(second, 'room:sync', { ok: true, snapshot: secondSnapshot });
  await act(async () => { stale.ack(null, { ok: true, snapshot: fixture(a) }); });
  assert.equal(hook.result.current.snapshot?.world.id, b); assert.equal(hook.result.current.notice, '');
});

test('successful reconnect clears the obsolete connection error', async () => {
  const socket = new FakeSocket(), snapshot = fixture(randomUUID());
  const hook = renderHook(() => useRoom(snapshot.world.id, true, () => socket as unknown as Socket));
  await respond(socket, 'room:enter', { ok: true, snapshot }); await respond(socket, 'room:sync', { ok: true, snapshot });
  act(() => { socket.disconnect(); socket.fire('connect_error', new Error('xhr poll error')); });
  assert.match(hook.result.current.notice, /连接中断/);
  act(() => socket.connect());
  await respond(socket, 'room:enter', { ok: true, snapshot }); await respond(socket, 'room:sync', { ok: true, snapshot });
  assert.equal(hook.result.current.online, true); assert.equal(hook.result.current.notice, '');
});
test('submission arriving during initial synchronization drains automatically, without a manual retry', async () => {
  const socket = new FakeSocket(), snapshot = fixture(randomUUID());
  const hook = renderHook(() => useRoom(snapshot.world.id, true, () => socket as unknown as Socket));
  await respond(socket, 'room:enter', { ok: true, snapshot });
  const initialSync = socket.take('room:sync');
  await act(async () => { await hook.result.current.submit('OPEN'); });
  assert.equal(hook.result.current.pending, true);
  await act(async () => { initialSync.ack(null, { ok: true, snapshot }); });
  await waitFor(() => assert.ok(socket.requests.some(r => r.event === 'command:status')));
  await respond(socket, 'command:status', { ok: true, receipt: null });
  const sent = socket.take('command'); assert.equal(sent.payload.type, 'puzzle:submit');
  await act(async () => { sent.ack(null, { ok: true, result: { solved: true } }); });
  await respond(socket, 'room:sync', { ok: true, snapshot });
  assert.equal(hook.result.current.pending, false); assert.equal(hook.result.current.feedback?.solved, true);
});
test('close queued behind a submission waits for its receipt and closes the authorized view', async () => {
  const socket = new FakeSocket(), snapshot = fixture(randomUUID());
  const hook = renderHook(() => useRoom(snapshot.world.id, true, () => socket as unknown as Socket));
  await respond(socket, 'room:enter', { ok: true, snapshot }); await respond(socket, 'room:sync', { ok: true, snapshot });
  act(() => { void hook.result.current.submit('OPEN'); });
  await act(async () => { await hook.result.current.close(); }); assert.equal(hook.result.current.closing, true);
  await respond(socket, 'command:status', { ok: true, receipt: { ok: true, result: { solved: true } } });
  await respond(socket, 'room:sync', { ok: true, snapshot });
  const close = socket.take('command'); assert.equal(close.payload.type, 'puzzle:close'); assert.equal(close.payload.viewId, snapshot.view.viewId);
  await act(async () => close.ack(null, { ok: true }));
  const closed = { ...snapshot, view: { ...emptyView(), saveEpoch: snapshot.world.saveEpoch, viewRevision: 2 } };
  await respond(socket, 'room:sync', { ok: true, snapshot: closed });
  if (socket.requests.some(r => r.event === 'room:sync')) await respond(socket, 'room:sync', { ok: true, snapshot: closed });
  assert.equal(hook.result.current.closing, false); assert.equal(hook.result.current.snapshot!.view.kind, null);
});
test('restored save epochs discard pending old operations while preserving drafts', async () => {
  const socket = new FakeSocket(), snapshot = fixture(randomUUID());
  const hook = renderHook(() => useRoom(snapshot.world.id, true, () => socket as unknown as Socket));
  await respond(socket, 'room:enter', { ok: true, snapshot }); await respond(socket, 'room:sync', { ok: true, snapshot });
  storage.set(`ph.submit.${snapshot.world.id}.1`, { saveEpoch: snapshot.world.saveEpoch, commandId: randomUUID() });
  storage.set(`ph.draft.${snapshot.world.id}.demo-v2.1.p1`, 'MY DRAFT');
  const restored = structuredClone(snapshot); restored.world.saveEpoch = randomUUID(); restored.view.saveEpoch = restored.world.saveEpoch;
  await act(async () => socket.fire('room:state', restored.world)); await respond(socket, 'room:sync', { ok: true, snapshot: restored });
  assert.equal(hook.result.current.pending, false); assert.equal(storage.get(`ph.submit.${snapshot.world.id}.1`), null);
  assert.equal(storage.get(`ph.draft.${snapshot.world.id}.demo-v2.1.p1`), 'MY DRAFT');
});
