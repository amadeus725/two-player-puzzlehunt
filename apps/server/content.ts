import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PublicGame } from '../../packages/protocol/index.js';

const point = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
const position = z.object({ mapId: z.string(), x: z.number().int().nonnegative(), y: z.number().int().nonnegative() });
const gameSchema = z.object({
  schemaVersion: z.literal(1), contentVersion: z.string().regex(/^[\w.-]+$/), mode: z.string(), title: z.string(), startMapId: z.string(), finalPuzzleId: z.string(),
  roles: z.array(z.object({ id: z.string(), name: z.string(), visualKey: z.string(), spawn: position.extend({ facing: z.enum(['up', 'down', 'left', 'right']) }) })).length(2),
  maps: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional(), width: z.number().int().positive().max(100), height: z.number().int().positive().max(100), paths: z.array(point), water: z.array(point).optional(), walls: z.array(z.object({ from: point, to: point })) })).length(5),
  puzzles: z.array(z.object({ id: z.string(), number: z.string(), title: z.string(), placement: position, body: z.object({ format: z.literal('markdown'), text: z.string().min(1) }) })).min(1),
  locks: z.array(position.extend({ id: z.string(), controllerPuzzleId: z.string() })),
  npcs: z.array(position.extend({ id: z.string(), visualKey: z.string(), text: z.string() })),
  portalGroups: z.array(z.object({ id: z.string(), unlockAfter: z.array(z.string()).min(1).optional(), sides: z.array(z.object({ mapId: z.string(), doors: z.array(z.object({ id: z.string(), x: z.number().int(), y: z.number().int() })).length(2) })).length(2), pairs: z.array(z.tuple([z.string(), z.string()])).length(2) })),
});
const answerSchema = z.object({ schemaVersion: z.literal(1), contentVersion: z.string(), puzzles: z.array(z.object({
  puzzleId: z.string(), normalization: z.object({ trim: z.boolean(), caseFold: z.enum(['none', 'upper']), removeInternalWhitespace: z.boolean() }),
  answerVariants: z.array(z.object({ id: z.string(), acceptedAnswers: z.array(z.string().min(1)).min(1) })).min(1),
})) });
export type FullGame = z.infer<typeof gameSchema>;
export type Answers = z.infer<typeof answerSchema>;
export type Content = { game: FullGame; answers: Answers; publicGame: PublicGame };
export function normalize(answer: string, options: Answers['puzzles'][number]['normalization']) {
  let value = options.trim ? answer.trim() : answer;
  if (options.caseFold === 'upper') value = value.toUpperCase();
  if (options.removeInternalWhitespace) value = value.replace(/\s/gu, '');
  return value;
}
export const cellKey = (x: number, y: number) => `${x},${y}`;
export function validateContent(rawGame: unknown, rawAnswers: unknown): Content {
  const game = gameSchema.parse(rawGame), answers = answerSchema.parse(rawAnswers);
  const check = (condition: unknown, reason: string) => { if (!condition) throw new Error(`Content: ${reason}`); };
  check(game.contentVersion === answers.contentVersion, 'content versions differ');
  check(game.maps.map(m => m.id).sort().join(',') === 'center,east,north,south,west', 'five map identifiers');
  const ids = new Set<string>();
  const unique = (id: string) => { check(/^[\w-]+$/.test(id) && !ids.has(id), `invalid/duplicate ID ${id}`); ids.add(id); };
  const paths = new Map<string, Set<string>>();
  for (const map of game.maps) {
    unique(map.id);
    const cells = new Set(map.paths.map(([x, y]) => cellKey(x, y))); paths.set(map.id, cells);
    check(cells.size === map.paths.length, 'duplicate paths');
    for (const [x, y] of map.paths) check(x < map.width && y < map.height, 'path bounds');
    const water = map.water ?? [];
    check(new Set(water.map(p => p.join(','))).size === water.length, 'duplicate water');
    for (const [x, y] of water) check(x < map.width && y < map.height && !cells.has(cellKey(x, y)), 'water must be off path and in bounds');
    const edges = new Set<string>();
    for (const wall of map.walls) {
      check(cells.has(wall.from.join(',')) && cells.has(wall.to.join(',')), 'wall endpoints');
      check(Math.abs(wall.from[0] - wall.to[0]) + Math.abs(wall.from[1] - wall.to[1]) === 1, 'orthogonal wall');
      const key = [wall.from.join(','), wall.to.join(',')].sort().join('|');
      check(!edges.has(key), 'duplicate wall'); edges.add(key);
    }
  }
  const occupied = new Map<string, string>();
  const at = (p: { mapId: string; x: number; y: number }) => `${p.mapId}:${p.x},${p.y}`;
  const place = (p: { mapId: string; x: number; y: number }, type: string) => {
    check(paths.get(p.mapId)?.has(cellKey(p.x, p.y)), `object off path ${at(p)}`);
    check(!occupied.has(at(p)) || (type === 'lock' && occupied.get(at(p)) === 'puzzle'), `overlap ${at(p)}`);
    occupied.set(at(p), type);
  };
  const puzzles = new Set(game.puzzles.map(p => p.id));
  for (const p of game.puzzles) { unique(p.id); place(p.placement, 'puzzle'); }
  check(new Set(game.puzzles.map(p => p.number)).size === game.puzzles.length, 'duplicate puzzle numbers');
  check(puzzles.has(game.finalPuzzleId), 'missing final');
  for (const lock of game.locks) { unique(lock.id); place(lock, 'lock'); check(puzzles.has(lock.controllerPuzzleId), 'unknown lock controller'); }
  for (const npc of game.npcs) { unique(npc.id); place(npc, 'npc'); }
  for (const group of game.portalGroups) {
    unique(group.id); check(group.sides[0].mapId !== group.sides[1].mapId, 'portal maps');
    if (group.unlockAfter) check(new Set(group.unlockAfter).size === group.unlockAfter.length && group.unlockAfter.every(id => puzzles.has(id)), 'invalid portal prerequisites');
    const doors = new Map<string, string>();
    for (const side of group.sides) for (const door of side.doors) { unique(door.id); place({ ...door, mapId: side.mapId }, 'portal'); doors.set(door.id, side.mapId); }
    const paired = new Set<string>();
    for (const [a, b] of group.pairs) {
      check(doors.has(a) && doors.has(b) && doors.get(a) !== doors.get(b) && !paired.has(a) && !paired.has(b), 'portal mapping');
      paired.add(a); paired.add(b);
    }
    check(paired.size === 4, 'unpaired portal');
  }
  for (const role of game.roles) { unique(role.id); check(role.spawn.mapId === game.startMapId, 'spawn map'); place(role.spawn, 'spawn'); }
  const answered = new Set<string>();
  for (const item of answers.puzzles) {
    check(puzzles.has(item.puzzleId) && !answered.has(item.puzzleId), 'answer references'); answered.add(item.puzzleId);
    const variants = new Set<string>(), accepted = new Map<string, string>();
    for (const variant of item.answerVariants) {
      check(!variants.has(variant.id), 'duplicate answer variant'); variants.add(variant.id);
      for (const raw of variant.acceptedAnswers) {
        const value = normalize(raw, item.normalization);
        check(value.length && Array.from(raw).length <= 256, 'empty/oversized answer');
        check(!accepted.has(value) || accepted.get(value) === variant.id, 'ambiguous answer variant'); accepted.set(value, variant.id);
      }
    }
  }
  check(answered.size === puzzles.size, 'missing answer rules');
  const publicGame: PublicGame = { ...game, puzzles: game.puzzles.map(({ body: _body, ...meta }) => meta), npcs: game.npcs.map(({ text: _text, ...meta }) => meta) };
  return { game, answers, publicGame };
}
export function loadContents(root = process.cwd()) {
  const contents = new Map<string, Content>();
  for (const version of readdirSync(path.join(root, 'content/public'))) {
    if (!/^[\w.-]+$/.test(version)) continue;
    const content = validateContent(JSON.parse(readFileSync(path.join(root, 'content/public', version, 'game.json'), 'utf8')), JSON.parse(readFileSync(path.join(root, 'content/private', version, 'answers.json'), 'utf8')));
    if (content.game.contentVersion !== version) throw new Error('Content folder/version mismatch');
    contents.set(version, content);
  }
  return contents;
}
