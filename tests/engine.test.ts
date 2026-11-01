import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadContents } from '../apps/server/content.js';
import { applyCommand, emptyView, newWorld, privateView, RuleError, type Aggregate } from '../apps/server/engine.js';
import type { Command, CommandType, Direction, SeatId } from '../packages/protocol/index.js';

const content = loadContents().get('demo-v2')!;
function fixture(active = true) {
  let state: Aggregate = { world: newWorld(randomUUID(), 'TEST', content), views: { '1': emptyView(), '2': emptyView() } };
  const command = (seat: SeatId, type: CommandType, payload: Record<string, unknown> = {}): Command => ({ protocolVersion: 1, commandId: randomUUID(), controlEpoch: 1, saveEpoch: state.world.saveEpoch, mapId: state.world.currentMapId, mapEpoch: state.world.mapEpoch, viewId: state.views[seat].viewId ?? undefined, type, payload });
  const send = (seat: SeatId, type: CommandType, payload: Record<string, unknown> = {}) => { const outcome = applyCommand(state, seat, command(seat, type, payload), content); state = outcome.state; return outcome.result; };
  const move = (seat: SeatId, direction: Direction) => send(seat, 'player:move', { direction });
  const at = (seat: SeatId, x: number, y: number) => Object.assign(state.world.players[seat], { x, y });
  const open = (seat: SeatId, id: string) => send(seat, 'puzzle:open', { targetId: id });
  const answer = (seat: SeatId, text: string) => send(seat, 'puzzle:submit', { puzzleId: state.views[seat].targetId, answer: text });
  if (active) { send('1', 'role:claim', { roleId: 'role-1' }); send('2', 'role:claim', { roleId: 'role-2' }); }
  return { get state() { return state; }, send, move, at, open, answer, command };
}
const fails = (work: () => unknown, code: string) => assert.throws(work, (error: unknown) => error instanceof RuleError && error.code === code);
test('a close command for the wrong kind of window cannot revoke the open puzzle', () => {
  const f = fixture(); f.at('1', 1, 1); f.open('1', 'p1');
  const view = structuredClone(f.state.views['1']);
  fails(() => f.send('1', 'npc:close'), 'VIEW_STALE');
  assert.deepEqual(f.state.views['1'], view);
});
test('waiting: unique roles, no movement until both roles, no repeated initialization', () => {
  const f = fixture(false); fails(() => f.move('1', 'down'), 'GAME_NOT_STARTED');
  f.send('1', 'role:claim', { roleId: 'role-1' }); fails(() => f.send('2', 'role:claim', { roleId: 'role-1' }), 'ROLE_TAKEN');
  f.send('2', 'role:claim', { roleId: 'role-2' }); assert.equal(f.state.world.phase, 'active');
  f.move('1', 'down'); fails(() => f.send('1', 'role:claim', { roleId: 'role-1' }), 'INVALID_INPUT'); assert.equal(f.state.world.players['1'].y, 1);
});
test('push is atomic; blocked moves face the requested direction without rotating the other actor', () => {
  const f = fixture(); f.move('1', 'right'); assert.equal(f.state.world.players['1'].x, 1); assert.equal(f.state.world.players['2'].x, 2);
  assert.equal(f.state.world.players['2'].facing, 'down');
  assert.equal(f.move('1', 'right').moved, false); assert.equal(f.state.world.players['1'].x, 1); assert.equal(f.state.world.players['2'].x, 2);
  f.at('1', 8, 6); f.at('2', 7, 6); assert.equal(f.move('2', 'right').moved, false);
  f.at('1', 7, 0); assert.equal(f.move('1', 'right').moved, false); assert.equal(f.state.world.players['1'].facing, 'right');
});
test('wrong answers overwrite, trap a player on the lock, and cannot be bypassed by pushing', () => {
  const f = fixture(); f.at('1', 1, 1); f.at('2', 2, 0); f.open('1', 'p1');
  assert.equal(f.move('2', 'down').moved, false); f.answer('1', ' open '); assert.equal(f.move('2', 'down').moved, true);
  f.answer('1', 'WRONG'); assert.equal(f.move('2', 'down').moved, false);
  f.send('1', 'puzzle:close'); assert.equal(f.move('1', 'right').moved, false);
  f.open('2', 'p2'); f.answer('2', '2'); assert.equal(f.state.world.puzzles.p2.answerVariantId, 'two'); f.send('2', 'puzzle:close'); assert.equal(f.move('2', 'down').moved, false);
  f.open('1', 'p1'); f.answer('1', 'OPEN'); assert.equal(f.move('2', 'down').moved, true);
});
test('empty and oversized answers do not revoke a correct answer; normal wrong answers do', () => {
  const f = fixture(); f.at('1', 1, 1); f.open('1', 'p1'); f.answer('1', 'OPEN');
  for (const bad of ['  ', 'a'.repeat(257)]) fails(() => f.answer('1', bad), 'INVALID_INPUT');
  assert.equal(f.state.world.puzzles.p1.solved, true); f.answer('1', 'O PEN'); assert.equal(f.state.world.puzzles.p1.solved, false); f.answer('1', 'OPEN'); assert.equal(f.state.world.puzzles.p1.solved, true);
});
test('private windows survive a push; each player has their own view and the shared latest result', () => {
  const f = fixture(); f.at('1', 1, 1); f.at('2', 1, 2); f.open('1', 'p1');
  const firstId = f.state.views['1'].viewId; f.move('2', 'up'); assert.equal(f.state.world.players['1'].y, 0);
  f.open('2', 'p1'); f.answer('1', 'OPEN'); f.answer('2', 'WRONG'); assert.equal(f.state.world.puzzles.p1.solved, false);
  f.send('2', 'puzzle:close'); assert.equal(f.state.views['1'].viewId, firstId); assert.equal(f.state.views['2'].kind, null);
  fails(() => f.move('1', 'right'), 'VIEW_BUSY'); assert.ok(privateView(f.state, '1', content).content?.text); assert.equal(privateView(f.state, '2', content).content, undefined);
  f.send('1', 'puzzle:close'); fails(() => f.open('1', 'p1'), 'TARGET_CHANGED');
});
for (const group of content.game.portalGroups) for (const swapped of [false, true]) {
  test(`portal ${group.id}: fixed door pairing, reversed players=${swapped}, no immediate bounce`, () => {
    const f = fixture(); const [a, b] = group.sides[0].doors;
    const first: SeatId = swapped ? '2' : '1', second: SeatId = swapped ? '1' : '2';
    f.at(first, a.x, a.y); const dy = b.y === 0 ? 1 : -1; f.at(second, b.x, b.y + dy);
    // North's adjacent door may coincide with the first actor only along x; all approaches here are vertical.
    const result = f.move(second, dy === 1 ? 'up' : 'down'); assert.equal(result.teleported, true);
    assert.equal(f.state.world.currentMapId, group.sides[1].mapId); assert.equal(f.state.world.players[first].x, 0); assert.equal(f.state.world.players[second].x, 1);
    assert.equal(f.state.world.mapEpoch, 1); assert.equal(f.move(first, 'up').teleported, false); assert.equal(f.state.world.mapEpoch, 1);
    f.move(second, 'down'); assert.equal(f.state.world.disabledPortal, null); f.move(second, 'up'); assert.equal(f.state.world.currentMapId, 'center'); assert.equal(f.state.world.mapEpoch, 2);
  });
}
test('portal push teleports both, preserves an open puzzle, and rejects late map commands', () => {
  const f = fixture(); f.at('1', 1, 1); f.open('1', 'p1'); const view = structuredClone(f.state.views['1']);
  f.at('1', 8, 2); f.at('2', 8, 1); const stale = f.command('2', 'player:move', { direction: 'down' });
  assert.equal(f.move('2', 'down').teleported, true); assert.deepEqual(f.state.views['1'], view); f.answer('1', 'OPEN');
  fails(() => applyCommand(f.state, '2', stale, content), 'STALE_MAP');
});
test('NPC requires facing, adjacency, clear edge and an unlocked source cell', () => {
  const f = fixture(); f.at('1', 7, 0); fails(() => f.send('1', 'npc:interact', { targetId: 'npc-guide' }), 'TARGET_CHANGED');
  f.move('1', 'right'); f.send('1', 'npc:interact', { targetId: 'npc-guide' }); assert.equal(f.state.views['2'].kind, null); f.send('1', 'npc:close');
  const custom = structuredClone(content);
  custom.game.maps.find(m => m.id === 'center')!.walls.push({ from: [7, 0], to: [8, 0] });
  fails(() => applyCommand(f.state, '1', f.command('1', 'npc:interact', { targetId: 'npc-guide' }), custom), 'TARGET_CHANGED');
});
test('the placeholder rescue route reaches Q1 from every free center cell while the other player is locked', () => {
  const map = content.game.maps.find(m => m.id === 'center')!;
  const candidates = map.paths.filter(([x, y]) => !(x === 2 && y === 1) && !(x === 8 && y === 0));
  for (const [x, y] of candidates) {
    const f = fixture(); f.at('1', x, y); f.at('2', 2, 1);
    const queue = [f.state], seen = new Set<string>(); let rescued = false;
    for (let i = 0; i < queue.length; i++) {
      const state = queue[i], player = state.world.players['1'];
      if (player.x === 1 && player.y === 1) { rescued = true; break; }
      for (const direction of ['up', 'down', 'left', 'right']) {
        const result = applyCommand(state, '1', f.command('1', 'player:move', { direction }), content);
        const p = result.state.world.players['1'], key = `${p.x},${p.y}`;
        if (!result.result.moved || seen.has(key)) continue; seen.add(key); queue.push(result.state);
      }
    }
    assert.equal(rescued, true, `rescue from ${x},${y}`);
  }
  assert.equal(candidates.length, 61);
});
test('final supports alternate solutions, permanent completion, and continued play', () => {
  const f = fixture(); f.state.world.currentMapId = 'east'; f.at('1', 2, 2); f.at('2', 4, 3); f.open('1', 'p-final');
  f.answer('1', 'DONE'); const completed = f.state.world.completedAt; assert.equal(f.state.world.phase, 'completed');
  f.answer('1', 'AGAIN'); assert.equal(f.state.world.puzzles['p-final'].answerVariantId, 'ending-b');
  f.answer('1', 'WRONG'); assert.equal(f.state.world.puzzles['p-final'].solved, false); assert.equal(f.state.world.phase, 'completed'); assert.equal(f.state.world.completedAt, completed);
  f.answer('1', 'DONE'); assert.equal(f.state.world.completedAt, completed); f.send('1', 'puzzle:close'); assert.equal(f.move('1', 'down').moved, true);
});
