import { randomUUID } from 'node:crypto';
import { normalize, type Content } from './content.js';
import { isPortalOpen, SEATS, type Command, type Direction, type PrivateView, type SeatId, type ViewState, type World } from '../../packages/protocol/index.js';

export class RuleError extends Error { constructor(public code: string) { super(code); } }
const demand = (ok: unknown, code: string) => { if (!ok) throw new RuleError(code); };
export const emptyView = (): ViewState => ({ viewRevision: 0, viewId: null, kind: null, targetId: null });
export type Aggregate = { world: World; views: Record<SeatId, ViewState> };
export function newWorld(id: string, code: string, content: Content): World {
  return { id, code, contentVersion: content.game.contentVersion, saveSchemaVersion: 1, saveEpoch: randomUUID(), revision: 0, phase: 'waiting', currentMapId: content.game.startMapId, mapEpoch: 0,
    players: { '1': { roleId: null, x: null, y: null, facing: 'down' }, '2': { roleId: null, x: null, y: null, facing: 'down' } },
    puzzles: Object.fromEntries(content.game.puzzles.map(p => [p.id, { answer: null, solved: false, answerVariantId: null, lastSubmittedBy: null, updatedAt: null }])),
    disabledPortal: null, completedAt: null, completedBy: null,
    ...(content.game.portalGroups.some(g => g.unlockAfter) ? { unlockedPortals: {} } : {}) };
}
const offsets: Record<Direction, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
function wallBetween(content: Content, mapId: string, ax: number, ay: number, bx: number, by: number) {
  return content.game.maps.find(m => m.id === mapId)!.walls.some(w => (w.from[0] === ax && w.from[1] === ay && w.to[0] === bx && w.to[1] === by) || (w.from[0] === bx && w.from[1] === by && w.to[0] === ax && w.to[1] === ay));
}
export function locked(world: World, content: Content, x: number, y: number) {
  return content.game.locks.some(lock => lock.mapId === world.currentMapId && lock.x === x && lock.y === y && !world.puzzles[lock.controllerPuzzleId].solved);
}
function passable(world: World, content: Content, ax: number, ay: number, bx: number, by: number) {
  const map = content.game.maps.find(m => m.id === world.currentMapId)!;
  return map.paths.some(([x, y]) => x === bx && y === by) && !wallBetween(content, map.id, ax, ay, bx, by) && !locked(world, content, ax, ay) && !locked(world, content, bx, by) && !content.game.npcs.some(n => n.mapId === map.id && n.x === bx && n.y === by);
}
function teleport(world: World, content: Content) {
  const occupied = (doors: { x: number; y: number }[]) => SEATS.every(s => doors.some(d => d.x === world.players[s].x && d.y === world.players[s].y));
  if (world.disabledPortal) {
    const side = content.game.portalGroups.find(g => g.id === world.disabledPortal)?.sides.find(s => s.mapId === world.currentMapId);
    if (!side || !occupied(side.doors)) world.disabledPortal = null;
  }
  for (const group of content.game.portalGroups) {
    const side = group.sides.find(s => s.mapId === world.currentMapId);
    if (!side || !isPortalOpen(world, group) || group.id === world.disabledPortal || !occupied(side.doors)) continue;
    const other = group.sides.find(s => s !== side)!;
    for (const seat of SEATS) {
      const player = world.players[seat], door = side.doors.find(d => d.x === player.x && d.y === player.y)!;
      const pair = group.pairs.find(p => p.includes(door.id))!;
      const target = other.doors.find(d => d.id === pair.find(id => id !== door.id))!;
      player.x = target.x; player.y = target.y;
    }
    world.currentMapId = other.mapId; world.mapEpoch++; world.disabledPortal = group.id;
    return true;
  }
  return false;
}
export function privateView(state: Aggregate, seat: SeatId, content: Content): PrivateView {
  const view = state.views[seat];
  let body: PrivateView['content'];
  if (view.kind === 'puzzle') { const puzzle = content.game.puzzles.find(p => p.id === view.targetId)!; body = { title: `${puzzle.number} · ${puzzle.title}`, text: puzzle.body.text, puzzleId: puzzle.id }; }
  if (view.kind === 'npc') { const npc = content.game.npcs.find(n => n.id === view.targetId)!; body = { title: '路边的旅人', text: npc.text }; }
  return { ...view, saveEpoch: state.world.saveEpoch, content: body };
}
export function applyCommand(original: Aggregate, seat: SeatId, command: Command, content: Content, now = new Date().toISOString()) {
  const state = structuredClone(original), { world, views } = state;
  demand(command.saveEpoch === world.saveEpoch, 'STALE_SAVE');
  const player = world.players[seat], view = views[seat];
  let result: Record<string, unknown> = {};
  if (command.type === 'role:claim') {
    demand(world.phase === 'waiting', 'INVALID_INPUT');
    const role = content.game.roles.find(r => r.id === command.payload.roleId);
    demand(role, 'INVALID_INPUT');
    demand(!SEATS.some(s => s !== seat && world.players[s].roleId === role!.id), 'ROLE_TAKEN');
    demand(player.roleId === null || player.roleId === role!.id, 'INVALID_INPUT');
    player.roleId = role!.id;
    if (SEATS.every(s => world.players[s].roleId)) {
      for (const s of SEATS) { const spawn = content.game.roles.find(r => r.id === world.players[s].roleId)!.spawn; Object.assign(world.players[s], { x: spawn.x, y: spawn.y, facing: spawn.facing }); }
      world.phase = 'active';
    }
    result = { phase: world.phase };
  } else {
    demand(world.phase !== 'waiting', 'GAME_NOT_STARTED');
    if (['player:move', 'puzzle:open', 'npc:interact'].includes(command.type)) demand(command.mapId === world.currentMapId && command.mapEpoch === world.mapEpoch, 'STALE_MAP');
    if (command.type === 'player:move') {
      demand(!view.kind, 'VIEW_BUSY');
      const direction = command.payload.direction as Direction; demand(Object.hasOwn(offsets, direction), 'INVALID_INPUT');
      player.facing = direction;
      const [dx, dy] = offsets[direction], x = player.x!, y = player.y!, nx = x + dx, ny = y + dy;
      let moved = false;
      if (passable(world, content, x, y, nx, ny)) {
        const other = world.players[seat === '1' ? '2' : '1'];
        if (other.x !== nx || other.y !== ny || passable(world, content, nx, ny, nx + dx, ny + dy)) {
          if (other.x === nx && other.y === ny) { other.x += dx; other.y += dy; }
          player.x = nx; player.y = ny; moved = true;
        }
      }
      result = { moved, blocked: !moved, teleported: moved ? teleport(world, content) : false };
    } else if (command.type === 'puzzle:open' || command.type === 'npc:interact') {
      const kind = command.type === 'puzzle:open' ? 'puzzle' : 'npc';
      if (view.kind) {
        demand(view.kind === kind && view.targetId === command.payload.targetId, 'VIEW_BUSY');
      } else {
        if (kind === 'puzzle') {
          const target = content.game.puzzles.find(p => p.id === command.payload.targetId);
          demand(target && target.placement.mapId === world.currentMapId && target.placement.x === player.x && target.placement.y === player.y, 'TARGET_CHANGED');
        } else {
          const [dx, dy] = offsets[player.facing];
          const target = content.game.npcs.find(n => n.id === command.payload.targetId);
          demand(target && target.mapId === world.currentMapId && target.x === player.x! + dx && target.y === player.y! + dy && !locked(world, content, player.x!, player.y!) && !wallBetween(content, world.currentMapId, player.x!, player.y!, target.x, target.y), 'TARGET_CHANGED');
        }
        Object.assign(view, { kind, targetId: command.payload.targetId as string, viewId: randomUUID(), viewRevision: view.viewRevision + 1 });
      }
    } else if (command.type === 'puzzle:close' || command.type === 'npc:close') {
      demand(view.viewId && view.viewId === command.viewId, 'VIEW_STALE');
      demand(view.kind === (command.type === 'puzzle:close' ? 'puzzle' : 'npc'), 'VIEW_STALE');
      Object.assign(view, { kind: null, targetId: null, viewId: null, viewRevision: view.viewRevision + 1 });
    } else if (command.type === 'puzzle:submit') {
      demand(view.kind === 'puzzle' && view.viewId === command.viewId && view.targetId === command.payload.puzzleId, 'VIEW_REQUIRED');
      const answer = command.payload.answer;
      demand(typeof answer === 'string' && Array.from(answer as string).length <= 256, 'INVALID_INPUT');
      const rule = content.answers.puzzles.find(p => p.puzzleId === view.targetId)!;
      const normalized = normalize(answer as string, rule.normalization); demand(normalized.length, 'INVALID_INPUT');
      const variant = rule.answerVariants.find(v => v.acceptedAnswers.some(a => normalize(a, rule.normalization) === normalized));
      world.puzzles[view.targetId!] = { answer: answer as string, solved: !!variant, answerVariantId: variant?.id ?? null, lastSubmittedBy: seat, updatedAt: now };
      // The gate latches in the same transaction as the final required answer.
      // Old saves without this field and ungated portal groups remain valid.
      for (const group of content.game.portalGroups) {
        if (group.unlockAfter && !isPortalOpen(world, group) && group.unlockAfter.every(id => world.puzzles[id].solved)) {
          (world.unlockedPortals ??= {})[group.id] = now;
        }
      }
      if (variant && view.targetId === content.game.finalPuzzleId && !world.completedAt) { world.completedAt = now; world.completedBy = seat; world.phase = 'completed'; }
      result = { solved: !!variant, answerVariantId: variant?.id ?? null, puzzleId: view.targetId };
    } else throw new RuleError('INVALID_INPUT');
  }
  if (JSON.stringify(world) !== JSON.stringify(original.world)) world.revision++;
  return { state, result };
}
