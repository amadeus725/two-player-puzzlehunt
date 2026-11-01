import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Store } from '../../apps/server/store.js';
import { loadContents } from '../../apps/server/content.js';
import { createBackup, restoreBackup } from '../../apps/server/backup.js';
import type { CommandType } from '../../packages/protocol/index.js';

test('new region saves persist the permanent gate through a fresh store and backup restore', { timeout:30000 }, async () => {
  const base=process.env.TEST_DATABASE_URL??'postgresql://puzzlehunt:puzzlehunt_local@127.0.0.1:55432/puzzlehunt', admin=new Pool({connectionString:base});
  const schemas=[`test_${randomUUID().replaceAll('-','')}`,`test_${randomUUID().replaceAll('-','')}`];
  const contents=loadContents(), secret='regions-test-secret-at-least-thirty-two-characters';
  const stores: Store[]=[];
  try {
    for(const schema of schemas) await admin.query(`CREATE SCHEMA "${schema}"`);
    const urls=schemas.map(schema=>{const url=new URL(base);url.searchParams.set('options',`-c search_path=${schema}`);return url.toString();});
    let store=new Store(urls[0],secret,contents);stores.push(store);await store.init();
    const a=await store.createSession(),b=await store.createSession(), entry=await store.entry(a.id,randomUUID(),'create');
    assert.equal((await store.read(entry.roomId,a.id)).world.contentVersion,'demo-v3');
    const code=(await store.read(entry.roomId,a.id)).world.code;await store.entry(b.id,randomUUID(),'join',code);
    const tabs={[a.id]:randomUUID(),[b.id]:randomUUID()};
    await store.control(entry.roomId,a.id,tabs[a.id],undefined,false);await store.control(entry.roomId,b.id,tabs[b.id],undefined,false);
    const send=async(session:string,type:CommandType,payload:Record<string,unknown>={})=>{
      const s=await store.read(entry.roomId,session);
      return store.command(entry.roomId,session,tabs[session],{protocolVersion:1,commandId:randomUUID(),controlEpoch:s.controlEpoch,saveEpoch:s.world.saveEpoch,mapId:s.world.currentMapId,mapEpoch:s.world.mapEpoch,viewId:s.view.viewId??undefined,type,payload});
    };
    await send(a.id,'role:claim',{roleId:'role-1'});await send(b.id,'role:claim',{roleId:'role-2'});
    for(const [id,answer] of [['meta-north','NORTH'],['meta-east','EAST'],['meta-south','SOUTH'],['meta-north','WRONG']]) {
      // Arrange only this isolated test room at the answer tile; gameplay movement is covered by the LAN smoke test.
      const s=await store.read(entry.roomId,a.id), p=contents.get('demo-v3')!.game.puzzles.find(p=>p.id===id)!.placement;
      s.world.players['1'].x=p.x;s.world.players['1'].y=p.y;
      await store.pool.query('UPDATE rooms SET state=$1 WHERE id=$2',[JSON.stringify(s.world),entry.roomId]);
      await send(a.id,'puzzle:open',{targetId:id});await send(a.id,'puzzle:submit',{puzzleId:id,answer});await send(a.id,'puzzle:close');
    }
    const before=(await store.read(entry.roomId,a.id)).world;
    assert.ok(before.unlockedPortals?.['portal-center-west']); assert.equal(before.puzzles['meta-north'].solved,false);
    await store.pool.end();stores.pop();store=new Store(urls[0],secret,contents);stores.push(store);await store.init();
    assert.deepEqual((await store.read(entry.roomId,a.id)).world.unlockedPortals,before.unlockedPortals);
    const backup=await createBackup(store.pool,secret,contents), restored=new Store(urls[1],secret,contents);stores.push(restored);await restored.init();
    await restoreBackup(restored.pool,backup,secret,contents);
    const after=(await restored.read(entry.roomId,a.id)).world;
    assert.deepEqual(after.unlockedPortals,before.unlockedPortals);assert.notEqual(after.saveEpoch,before.saveEpoch);
    assert.equal(after.puzzles['meta-north'].solved,false);
  } finally {
    await Promise.all(stores.map(s=>s.pool.end()));
    for(const schema of schemas) { assert.match(schema,/^test_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    await admin.end();
  }
});
