import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadContents, validateContent } from '../apps/server/content.js';
import { applyCommand, emptyView, newWorld, type Aggregate } from '../apps/server/engine.js';
import { isPortalOpen, type CommandType, type SeatId } from '../packages/protocol/index.js';

const content = loadContents().get('demo-v3')!, gate = content.game.portalGroups.find(g => g.unlockAfter)!;
function fixture() {
  let state: Aggregate = { world: newWorld(randomUUID(), 'REGIONS', content), views: { '1': emptyView(), '2': emptyView() } };
  const send = (seat: SeatId, type: CommandType, payload: Record<string, unknown> = {}) => {
    const r = applyCommand(state, seat, { protocolVersion: 1, commandId: randomUUID(), controlEpoch: 1, saveEpoch: state.world.saveEpoch, mapId: state.world.currentMapId, mapEpoch: state.world.mapEpoch, viewId: state.views[seat].viewId ?? undefined, type, payload }, content);
    state = r.state; return r.result;
  };
  send('1', 'role:claim', { roleId: 'role-1' }); send('2', 'role:claim', { roleId: 'role-2' });
  const open = (seat: SeatId, id: string) => {
    if (state.views[seat].kind) send(seat, 'puzzle:close');
    const p = content.game.puzzles.find(p => p.id === id)!.placement;
    state.world.currentMapId = p.mapId; Object.assign(state.world.players[seat], { x: p.x, y: p.y });
    send(seat, 'puzzle:open', { targetId: id });
  };
  const answer = (seat: SeatId, answer: string) => send(seat, 'puzzle:submit', { puzzleId: state.views[seat].targetId, answer });
  const solve = (id: string, value: string) => { open('1', id); answer('1', value); send('1', 'puzzle:close'); };
  return { get state() { return state; }, send, open, answer, solve, reload: () => { state = JSON.parse(JSON.stringify(state)); } };
}
test('west gate requires all three current meta solves, then stays open through edits and reload', () => {
  const f = fixture();
  Object.assign(f.state.world.players['1'], { x: 0, y: 3 }); Object.assign(f.state.world.players['2'], { x: 1, y: 5 });
  assert.equal(f.send('2', 'player:move', { direction: 'left' }).teleported, false);
  assert.equal(f.state.world.currentMapId, 'center');
  f.solve('meta-north', 'NORTH'); f.solve('meta-north', 'WRONG');
  f.solve('meta-east', 'EAST'); f.solve('meta-south', 'SOUTH');
  assert.equal(isPortalOpen(f.state.world, gate), false);
  f.solve('meta-north', 'NORTH');
  const opened = f.state.world.unlockedPortals![gate.id]; assert.ok(opened);
  f.solve('meta-north', 'WRONG'); f.reload();
  assert.equal(isPortalOpen(f.state.world, gate), true);
  assert.equal(f.state.world.unlockedPortals![gate.id], opened);
  Object.assign(f.state.world.players['1'], { x: 0, y: 3 }); Object.assign(f.state.world.players['2'], { x: 1, y: 5 });
  assert.equal(f.send('2', 'player:move', { direction: 'left' }).teleported, true);
  assert.equal(f.state.world.currentMapId, 'west');
  assert.deepEqual([f.state.world.players['1'].x, f.state.world.players['1'].y], [10, 3]);
  assert.deepEqual([f.state.world.players['2'].x, f.state.world.players['2'].y], [10, 5]);
  f.send('2', 'player:move', { direction: 'left' }); f.send('2', 'player:move', { direction: 'right' });
  assert.equal(f.state.world.currentMapId, 'center');
  f.solve('final', 'DONE'); assert.equal(f.state.world.phase, 'completed');
  f.solve('final', 'WRONG'); assert.equal(f.state.world.phase, 'completed');
});
test('north A and B use ordinary independent puzzles and never aggregate answers', () => {
  const f = fixture(); f.open('1', 'north-a'); f.open('2', 'north-b');
  f.answer('1', 'LEAF'); assert.equal(f.state.world.puzzles['north-a'].solved, true); assert.equal(f.state.world.puzzles['north-b'].solved, false);
  f.answer('2', 'WRONG'); assert.equal(f.state.world.puzzles['north-a'].solved, true);
  f.answer('2', 'STONE'); f.answer('1', 'WRONG');
  assert.equal(f.state.world.puzzles['north-a'].solved, false); assert.equal(f.state.world.puzzles['north-b'].solved, true);
  assert.equal(f.state.views['1'].targetId, 'north-a'); assert.equal(f.state.views['2'].targetId, 'north-b');
  assert.equal(f.state.world.puzzles['meta-north'].solved, false);
});
test('region content keeps metas in the hall, final in west, and every path reachable with walls respected', () => {
  assert.deepEqual(gate.unlockAfter!.map(id => content.game.puzzles.find(p => p.id === id)!.placement.mapId), ['center', 'center', 'center']);
  assert.equal(content.game.puzzles.find(p => p.id === content.game.finalPuzzleId)!.placement.mapId, 'west');
  for (const map of content.game.maps) {
    const paths = new Set(map.paths.map(p => p.join(','))), blocked = new Set(content.game.npcs.filter(n => n.mapId === map.id).map(n => `${n.x},${n.y}`));
    const seen = new Set<string>(), queue = [map.paths.find(p => !blocked.has(p.join(',')))!];
    while (queue.length) {
      const [x, y] = queue.shift()!, key = `${x},${y}`; if (seen.has(key)) continue; seen.add(key);
      for (const [dx,dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nx=x+dx, ny=y+dy, next=`${nx},${ny}`;
        const wall=map.walls.some(w => (w.from[0]===x&&w.from[1]===y&&w.to[0]===nx&&w.to[1]===ny)||(w.to[0]===x&&w.to[1]===y&&w.from[0]===nx&&w.from[1]===ny));
        if (paths.has(next)&&!seen.has(next)&&!blocked.has(next)&&!wall) queue.push([nx,ny]);
      }
    }
    assert.equal(seen.size, paths.size-blocked.size, `${map.id}: inaccessible path or puzzle`);
    for (const water of map.water ?? []) assert.equal(paths.has(water.join(',')), false);
  }
});
test('invalid gate references and water on paths are rejected before serving content', () => {
  const badGate = structuredClone(content.game); badGate.portalGroups.find(g => g.unlockAfter)!.unlockAfter = ['missing'];
  assert.throws(() => validateContent(badGate, content.answers), /portal prerequisites/);
  const badWater = structuredClone(content.game); badWater.maps[0].water = [badWater.maps[0].paths[0]];
  assert.throws(() => validateContent(badWater, content.answers), /water must/);
});
