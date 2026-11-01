import { loadContents } from '../apps/server/content.js';
for (const [version, content] of loadContents()) console.log(`${version}: ${content.game.maps.length} maps, ${content.game.puzzles.length} puzzles, ${content.game.portalGroups.length} portal groups — valid`);
