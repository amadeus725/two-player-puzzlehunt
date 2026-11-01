import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { Content } from './content.js';
import { applyCommand, emptyView, newWorld, privateView, RuleError, type Aggregate } from './engine.js';
import { PROTOCOL_VERSION, SEATS, type Command, type Reply, type RoomSnapshot, type SeatId, type World } from '../../packages/protocol/index.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
const fingerprint = (value: unknown) => digest(JSON.stringify(stable(value)));
type SeatRow = { seat_id: SeatId; session_id: string; role_id: string | null; control_epoch: number; controller_tab: string | null; recovery_hash: string; view: Aggregate['views'][SeatId] };
type Loaded = { state: Aggregate; seats: SeatRow[]; seat: SeatRow; content: Content };
export class Store {
  readonly pool: Pool;
  private queues = new Map<string, Promise<unknown>>();
  constructor(url: string, readonly secret: string, readonly contents: Map<string, Content>, readonly defaultVersion = 'demo-v3') {
    this.pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000 });
    // A restarted database can close idle clients. pg replaces them on demand;
    // handle the pool event so this does not crash the game process.
    this.pool.on('error', error => console.error('Idle database connection lost:', error.message));
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS rooms (id uuid PRIMARY KEY, code text NOT NULL UNIQUE, state jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS seats (room_id uuid NOT NULL REFERENCES rooms(id), seat_id text NOT NULL CHECK(seat_id IN ('1','2')), session_id uuid NOT NULL REFERENCES sessions(id), role_id text, recovery_hash text NOT NULL, control_epoch integer NOT NULL DEFAULT 0, controller_tab text, view jsonb NOT NULL,
        PRIMARY KEY(room_id,seat_id), UNIQUE(room_id,role_id), UNIQUE(room_id,session_id));
      CREATE TABLE IF NOT EXISTS command_receipts (scope_key text NOT NULL, command_id text NOT NULL, payload_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope_key,command_id));
    `);
  }
  async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.queues.set(key, current);
    try { return await current; } finally { if (this.queues.get(key) === current) this.queues.delete(key); }
  }
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async session(token?: string) {
    if (token) { const result = await this.pool.query('SELECT id FROM sessions WHERE token_hash=$1', [digest(token)]); if (result.rowCount) return { id: result.rows[0].id as string }; }
    return null;
  }
  async createSession() {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await this.pool.query('INSERT INTO sessions(id,token_hash) VALUES($1,$2)', [id, digest(token)]);
    return { id, token };
  }
  recoveryCode(roomId: string, seat: SeatId) { return createHmac('sha256', this.secret).update(`recover:${roomId}:${seat}`).digest('base64url').slice(0, 32); }
  async recentRooms(sessionId: string) { const result = await this.pool.query('SELECT r.id, r.code FROM rooms r JOIN seats s ON s.room_id=r.id WHERE s.session_id=$1 ORDER BY r.created_at DESC LIMIT 8', [sessionId]); return result.rows as { id: string; code: string }[]; }
  async receipt(client: PoolClient, scope: string, id: string, hash?: string) {
    const result = await client.query('SELECT payload_hash,result FROM command_receipts WHERE scope_key=$1 AND command_id=$2', [scope, id]);
    if (!result.rowCount) return null;
    if (hash && hash !== result.rows[0].payload_hash) throw new RuleError('COMMAND_ID_CONFLICT');
    return result.rows[0].result;
  }
  async saveReceipt(client: PoolClient, scope: string, id: string, hash: string, result: unknown) {
    await client.query('INSERT INTO command_receipts(scope_key,command_id,payload_hash,result) VALUES($1,$2,$3,$4)', [scope, id, hash, JSON.stringify(result)]);
  }
  async entry(sessionId: string, requestId: string, operation: 'create' | 'join', code?: string) {
    return this.serial(`entry:${sessionId}`, () => this.transaction(async client => {
      await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
      const scope = `entry:${sessionId}`, hash = fingerprint({ operation, code: code ?? null });
      const old = await this.receipt(client, scope, requestId, hash); if (old) return old as { roomId: string; seatId: SeatId };
      let world: World;
      if (operation === 'create') {
        const content = this.contents.get(this.defaultVersion); if (!content) throw new RuleError('CONTENT_VERSION_UNAVAILABLE');
        let roomCode: string;
        do { roomCode = randomBytes(5).toString('hex').toUpperCase(); } while ((await client.query('SELECT 1 FROM rooms WHERE code=$1', [roomCode])).rowCount);
        world = newWorld(randomUUID(), roomCode, content);
        await client.query('INSERT INTO rooms(id,code,state) VALUES($1,$2,$3)', [world.id, roomCode, JSON.stringify(world)]);
      } else {
        const room = await client.query('SELECT state FROM rooms WHERE code=$1 FOR UPDATE', [code]);
        if (!room.rowCount) throw new RuleError('ROOM_NOT_FOUND'); world = room.rows[0].state;
      }
      const existing = await client.query('SELECT seat_id,session_id FROM seats WHERE room_id=$1', [world.id]);
      const own = existing.rows.find(s => s.session_id === sessionId);
      let seatId: SeatId;
      if (own) seatId = own.seat_id;
      else {
        if (existing.rowCount === 2 || world.phase !== 'waiting') throw new RuleError('ROOM_FULL');
        seatId = existing.rows.some(s => s.seat_id === '1') ? '2' : '1';
        await client.query('INSERT INTO seats(room_id,seat_id,session_id,recovery_hash,view) VALUES($1,$2,$3,$4,$5)', [world.id, seatId, sessionId, digest(this.recoveryCode(world.id, seatId)), JSON.stringify(emptyView())]);
      }
      const value = { roomId: world.id, seatId }; await this.saveReceipt(client, scope, requestId, hash, value); return value;
    }));
  }
  async recover(sessionId: string, code: string, recoveryCode: string) {
    const lookup = await this.pool.query('SELECT id FROM rooms WHERE code=$1', [code]);
    if (!lookup.rowCount) throw new RuleError('ROOM_NOT_FOUND'); const roomId: string = lookup.rows[0].id;
    return this.serial(roomId, () => this.transaction(async client => {
      await client.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [roomId]);
      const seats = await client.query('SELECT * FROM seats WHERE room_id=$1', [roomId]);
      const seat = seats.rows.find(s => s.recovery_hash === digest(recoveryCode));
      if (!seat) throw new RuleError('RECOVERY_INVALID');
      if (seats.rows.some(s => s.session_id === sessionId && s.seat_id !== seat.seat_id)) throw new RuleError('SESSION_ALREADY_BOUND');
      await client.query('UPDATE seats SET session_id=$1, control_epoch=control_epoch+1, controller_tab=NULL WHERE room_id=$2 AND seat_id=$3', [sessionId, roomId, seat.seat_id]);
      return { roomId, seatId: seat.seat_id as SeatId };
    }));
  }
  async load(client: PoolClient, roomId: string, sessionId: string): Promise<Loaded> {
    const result = await client.query('SELECT state FROM rooms WHERE id=$1 FOR UPDATE', [roomId]);
    if (!result.rowCount) throw new RuleError('ROOM_NOT_FOUND');
    const world: World = result.rows[0].state;
    if (world.saveSchemaVersion !== 1) throw new RuleError('CLIENT_UPDATE_REQUIRED');
    const content = this.contents.get(world.contentVersion); if (!content) throw new RuleError('CONTENT_VERSION_UNAVAILABLE');
    const rows = await client.query<SeatRow>('SELECT * FROM seats WHERE room_id=$1', [roomId]);
    const seat = rows.rows.find(s => s.session_id === sessionId); if (!seat) throw new RuleError('SESSION_INVALID');
    const views = { '1': emptyView(), '2': emptyView() }; for (const row of rows.rows) views[row.seat_id] = row.view;
    return { state: { world, views }, seats: rows.rows, seat, content };
  }
  snapshot(loaded: Loaded, hasControl: boolean): RoomSnapshot {
    return { world: loaded.state.world, game: loaded.content.publicGame, view: privateView(loaded.state, loaded.seat.seat_id, loaded.content), seatId: loaded.seat.seat_id,
      recoveryCode: this.recoveryCode(loaded.state.world.id, loaded.seat.seat_id), controlEpoch: loaded.seat.control_epoch, hasControl };
  }
  async read(roomId: string, sessionId: string) { return this.serial(roomId, () => this.transaction(async c => this.snapshot(await this.load(c, roomId, sessionId), false))); }
  async control(roomId: string, sessionId: string, tabId: string, epochHint: number | undefined, takeover: boolean) {
    return this.serial(roomId, () => this.transaction(async client => {
      const loaded = await this.load(client, roomId, sessionId), seat = loaded.seat;
      const allowed = !seat.controller_tab || takeover || (seat.controller_tab === tabId && seat.control_epoch === epochHint);
      if (allowed) {
        seat.control_epoch++; seat.controller_tab = tabId;
        await client.query('UPDATE seats SET control_epoch=$1, controller_tab=$2 WHERE room_id=$3 AND seat_id=$4', [seat.control_epoch, tabId, roomId, seat.seat_id]);
      }
      return this.snapshot(loaded, allowed);
    }));
  }
  async command(roomId: string, sessionId: string, tabId: string, command: Command) {
    return this.serial(roomId, () => this.transaction(async client => {
      const loaded = await this.load(client, roomId, sessionId), { seat, state, content } = loaded;
      if (command.protocolVersion !== PROTOCOL_VERSION) throw new RuleError('CLIENT_UPDATE_REQUIRED');
      if (seat.controller_tab !== tabId || seat.control_epoch !== command.controlEpoch) throw new RuleError('CONTROL_LOST');
      if (state.world.saveEpoch !== command.saveEpoch) throw new RuleError('STALE_SAVE');
      const scope = `room:${roomId}:${seat.seat_id}:${command.saveEpoch}`;
      const hash = fingerprint({ type: command.type, payload: command.payload, mapId: command.mapId, mapEpoch: command.mapEpoch, viewId: command.viewId });
      const old = await this.receipt(client, scope, command.commandId, hash);
      if (old) return { reply: old as Reply, snapshot: this.snapshot(loaded, true), duplicate: true };
      let applied: ReturnType<typeof applyCommand>;
      try { applied = applyCommand(state, seat.seat_id, command, content); }
      catch (error) {
        if (!(error instanceof RuleError)) throw error;
        const reply: Reply = { ok: false, code: error.code, commandId: command.commandId, saveEpoch: state.world.saveEpoch, revision: state.world.revision };
        await this.saveReceipt(client, scope, command.commandId, hash, reply);
        return { reply, snapshot: this.snapshot(loaded, true), duplicate: false };
      }
      await client.query('UPDATE rooms SET state=$1 WHERE id=$2', [JSON.stringify(applied.state.world), roomId]);
      for (const s of loaded.seats) await client.query('UPDATE seats SET role_id=$1, view=$2 WHERE room_id=$3 AND seat_id=$4', [applied.state.world.players[s.seat_id].roleId, JSON.stringify(applied.state.views[s.seat_id]), roomId, s.seat_id]);
      loaded.state = applied.state;
      const reply: Reply = { ok: true, commandId: command.commandId, saveEpoch: applied.state.world.saveEpoch, revision: applied.state.world.revision, viewRevision: applied.state.views[seat.seat_id].viewRevision, result: applied.result };
      await this.saveReceipt(client, scope, command.commandId, hash, reply);
      return { reply, snapshot: this.snapshot(loaded, true), duplicate: false };
    }));
  }
  async status(roomId: string, sessionId: string, saveEpoch: string, commandId: string) {
    return this.serial(roomId, () => this.transaction(async client => {
      const loaded = await this.load(client, roomId, sessionId);
      if (loaded.state.world.saveEpoch !== saveEpoch) throw new RuleError('STALE_SAVE');
      return this.receipt(client, `room:${roomId}:${loaded.seat.seat_id}:${saveEpoch}`, commandId) as Promise<Reply | null>;
    }));
  }
}
