import test from 'node:test';
import assert from 'node:assert/strict';
import { loadContents, validateContent } from '../apps/server/content.js';
const fixture = loadContents().get('demo-v2')!;
test('public configuration contains neither puzzle bodies nor private answers', () => {
  assert.ok(fixture.publicGame.puzzles.every(p => !('body' in p)));
  assert.ok(fixture.publicGame.npcs.every(n => !('text' in n)));
  assert.equal(JSON.stringify(fixture.publicGame).includes('acceptedAnswers'), false);
});
test('invalid content fails before a game starts', () => {
  const mutate = (change: (content: typeof fixture) => void) => { const copy = structuredClone(fixture); change(copy); return () => validateContent(copy.game, copy.answers); };
  assert.throws(mutate(c => { c.game.puzzles[0].placement.x = 99; }), /off path/);
  assert.throws(mutate(c => { c.game.portalGroups[0].pairs[0][1] = c.game.portalGroups[0].pairs[0][0]; }), /portal mapping/);
  assert.throws(mutate(c => { c.game.locks[0].controllerPuzzleId = 'missing'; }), /unknown lock controller/);
  assert.throws(mutate(c => { c.answers.puzzles[0].answerVariants.push({ id: 'other', acceptedAnswers: ['open'] }); }), /ambiguous/);
});
