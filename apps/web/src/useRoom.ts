import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { PROTOCOL_VERSION, type Command, type CommandType, type Direction, type PrivateView, type Reply, type RoomSnapshot, type World } from '../../../packages/protocol/index.js';
import { storage } from './storage.js';
import { newId } from './id.js';

export const messages: Record<string, string> = {
  ROOM_FULL: '房间已经有两位玩家了。', ROOM_NOT_FOUND: '没有找到这个房间，请检查房间码。', ROLE_TAKEN: '同伴刚刚选中了这个角色，请选择另一个。',
  SESSION_INVALID: '当前浏览器没有这个席位，请返回首页加入或使用恢复码。', CONTROL_LOST: '此角色已在另一处打开。', GAME_NOT_STARTED: '等两个人选好角色后再开始。',
  STALE_SAVE: '存档已恢复，请核对当前进度；旧操作不会自动补交。', STALE_MAP: '地图已经变化，请在当前位置重新操作。', TARGET_CHANGED: '角色已经离开刚才的目标，请重新操作。',
  VIEW_REQUIRED: '请先站到这道题上，按 V 打开题面。', VIEW_STALE: '这个窗口已经关闭或发生变化。', VIEW_BUSY: '先关闭当前窗口，再操作地图。',
  INVALID_INPUT: '请检查输入；答案不能为空或超过 256 个字。', COMMAND_ID_CONFLICT: '操作标识冲突，请刷新后重试。', STORAGE_UNAVAILABLE: '存档服务暂时不可用，操作尚未确认。',
  CONTENT_VERSION_UNAVAILABLE: '此存档的内容版本暂时不可用，请保留存档并联系维护者。', CLIENT_UPDATE_REQUIRED: '页面版本已更新，请刷新后继续。',
  NETWORK_PENDING: '连接中断或确认超时，正在保留操作与草稿。', RECOVERY_INVALID: '恢复码不正确，请检查后重试。', SESSION_ALREADY_BOUND: '当前浏览器已是这个房间的另一名玩家，请使用另一浏览器恢复。',
  ORIGIN_DENIED: '当前网址未加入服务端允许的入口。', COOKIE_DISABLED: '浏览器未保存登录信息，请允许本站使用 Cookie。',
};
export const errorText = (code?: string) => messages[code ?? ''] ?? '暂时无法完成操作，请稍后重试。';
export async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.code ?? 'NETWORK_PENDING');
  return result as T;
}
export { storage };
function tabIdentity() {
  try { let id = sessionStorage.getItem('ph.tab'); if (!id) { id = newId(); sessionStorage.setItem('ph.tab', id); } return id; } catch { return newId(); }
}
const createSocket = () => io({ transports: ['polling', 'websocket'], autoConnect: false, withCredentials: true });
export function useRoom(roomId: string | null, ready: boolean, socketFactory: () => Socket = createSocket) {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const current = useRef<RoomSnapshot | null>(null), socketRef = useRef<Socket | null>(null), tab = useRef(tabIdentity());
  const [online, setOnline] = useState(false), [notice, setNotice] = useState(''), [presence, setPresence] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState(false), [closing, setClosing] = useState(false), [feedback, setFeedback] = useState<{ puzzleId: string; solved: boolean } | null>(null);
  const generation = useRef(0), reconciling = useRef<number | null>(null), reconcileAgain = useRef(false);
  const setCurrent = (next: RoomSnapshot) => { current.current = next; setSnapshot(next); };
  const slot = (kind: string, state = current.current) => state ? `ph.${kind}.${state.world.id}.${state.seatId}` : '';
  const request = async (event: string, value: unknown): Promise<any> => {
    const socket = socketRef.current;
    const scope = generation.current;
    if (!socket?.connected) throw new Error('NETWORK_PENDING');
    return new Promise((resolve, reject) => socket.timeout(6000).emit(event, value, (error: Error | null, reply: any) => {
      if (scope !== generation.current || socketRef.current !== socket) reject(new Error('SESSION_CHANGED'));
      else if (error) reject(new Error('NETWORK_PENDING')); else resolve(reply);
    }));
  };
  const adopt = (next: RoomSnapshot) => {
    if (next.world.id !== roomId) return;
    const old = current.current;
    if (old && old.world.saveEpoch !== next.world.saveEpoch) {
      storage.remove(slot('submit', next)); storage.remove(slot('close', next)); setNotice(errorText('STALE_SAVE')); setFeedback(null);
    } else if (old) {
      if (old.world.revision > next.world.revision) next.world = old.world;
      if (old.view.viewRevision > next.view.viewRevision) next.view = old.view;
    }
    setCurrent(next);
    setPending(!!storage.get(slot('submit', next))); setClosing(!!storage.get(slot('close', next)));
  };
  const sync = async () => { const scope = generation.current; const reply = await request('room:sync', {}); if (scope !== generation.current) throw new Error('SESSION_CHANGED'); if (!reply.ok) throw new Error(reply.code); adopt(reply.snapshot); };
  const finishSubmission = (reply: Reply, original: Command) => {
    if (storage.get<Command>(slot('submit'))?.commandId === original.commandId) storage.remove(slot('submit'));
    setPending(!!storage.get(slot('submit')));
    if (reply.ok && typeof reply.result?.solved === 'boolean') setFeedback({ puzzleId: String(original.payload.puzzleId), solved: reply.result.solved });
    else if (!reply.ok) setNotice(errorText(reply.code));
  };
  const reconcile = async () => {
    if (!current.current?.hasControl || !socketRef.current?.connected) return;
    const scope = generation.current;
    if (reconciling.current === scope) { reconcileAgain.current = true; return; }
    reconciling.current = scope; reconcileAgain.current = false;
    try {
      let state = current.current;
      const submission = storage.get<Command>(slot('submit'));
      if (submission) {
        if (submission.saveEpoch !== state.world.saveEpoch) { storage.remove(slot('submit')); setPending(false); setNotice(errorText('STALE_SAVE')); }
        else {
          const status = await request('command:status', { saveEpoch: submission.saveEpoch, commandId: submission.commandId });
          if (!status.ok) throw new Error(status.code);
          const reply: Reply = status.receipt ?? await request('command', { ...submission, controlEpoch: current.current!.controlEpoch });
          if (['STORAGE_UNAVAILABLE', 'CONTROL_LOST'].includes(reply.code ?? '')) throw new Error(reply.code);
          finishSubmission(reply, submission);
        }
      }
      await sync(); state = current.current!;
      const close = storage.get<Command>(slot('close'));
      if (close) {
        if (close.saveEpoch !== state.world.saveEpoch || close.viewId !== state.view.viewId || !state.view.kind) storage.remove(slot('close'));
        else {
          const reply: Reply = await request('command', { ...close, controlEpoch: state.controlEpoch });
          if (!reply.ok && !['VIEW_STALE', 'STALE_SAVE'].includes(reply.code ?? '')) throw new Error(reply.code);
          storage.remove(slot('close')); await sync();
        }
        setClosing(false);
      }
    } catch (error) { if (scope === generation.current) setNotice(errorText(error instanceof Error ? error.message : 'NETWORK_PENDING')); }
    finally {
      if (scope === generation.current) {
        reconciling.current = null;
        if (reconcileAgain.current) { reconcileAgain.current = false; void reconcile(); }
      }
    }
  };
  const enter = async (takeover = false) => {
    if (!roomId) return;
    const scope = generation.current;
    try {
      let hint: number | undefined; try { const stored = sessionStorage.getItem(`ph.epoch.${roomId}`); if (stored !== null) hint = Number(stored); } catch {}
      const reply = await request('room:enter', { roomId, tabId: tab.current, epochHint: hint, takeover, protocolVersion: PROTOCOL_VERSION });
      if (!reply.ok) throw new Error(reply.code);
      setNotice(previous => previous === messages.NETWORK_PENDING ? '' : previous);
      adopt(reply.snapshot); setOnline(true);
      if (reply.snapshot.hasControl) { try { sessionStorage.setItem(`ph.epoch.${roomId}`, String(reply.snapshot.controlEpoch)); } catch {} await reconcile(); }
    } catch (error) { if (scope === generation.current) setNotice(errorText(error instanceof Error ? error.message : 'NETWORK_PENDING')); }
  };
  useEffect(() => {
    generation.current++; reconciling.current = null; reconcileAgain.current = false;
    setNotice(''); setFeedback(null); setPending(false); setClosing(false); setPresence({});
    if (!roomId || !ready) { current.current = null; setSnapshot(null); return; }
    const socket = socketFactory(); socketRef.current = socket;
    socket.on('connect', () => { void enter(); });
    socket.on('disconnect', () => { setOnline(false); window.dispatchEvent(new Event('ph:clear-keys')); });
    socket.on('connect_error', (error: Error) => { setOnline(false); setNotice(errorText(error.message === 'SESSION_INVALID' ? error.message : 'NETWORK_PENDING')); });
    socket.on('control:lost', () => { if (current.current) setCurrent({ ...current.current, hasControl: false }); window.dispatchEvent(new Event('ph:clear-keys')); });
    socket.on('room:presence', setPresence);
    socket.on('room:state', (world: World) => {
      const old = current.current; if (!old || world.id !== roomId) return;
      if (world.saveEpoch !== old.world.saveEpoch) { void sync().catch(() => {}); return; }
      if (world.revision >= old.world.revision) {
        if (world.currentMapId !== old.world.currentMapId) { setNotice('两人已一起抵达新的地图。'); window.dispatchEvent(new Event('ph:clear-keys')); }
        setCurrent({ ...old, world });
      }
    });
    socket.on('view:state', (view: PrivateView) => { const old = current.current; if (old && view.saveEpoch === old.world.saveEpoch && view.viewRevision >= old.view.viewRevision) setCurrent({ ...old, view }); });
    socket.connect();
    const visible = () => { if (document.visibilityState === 'visible' && socket.connected) void sync().then(reconcile).catch(() => {}); };
    document.addEventListener('visibilitychange', visible);
    return () => { generation.current++; socket.disconnect(); socketRef.current = null; current.current = null; setSnapshot(null); setOnline(false); document.removeEventListener('visibilitychange', visible); };
  }, [roomId, ready]);
  const commandFor = (type: CommandType, payload: Record<string, unknown>): Command => {
    const state = current.current!;
    return { protocolVersion: PROTOCOL_VERSION, saveEpoch: state.world.saveEpoch, commandId: newId(), controlEpoch: state.controlEpoch, type, payload,
      ...(['player:move', 'puzzle:open', 'npc:interact'].includes(type) ? { mapId: state.world.currentMapId, mapEpoch: state.world.mapEpoch } : {}),
      ...(['puzzle:submit', 'puzzle:close', 'npc:close'].includes(type) ? { viewId: state.view.viewId! } : {}) };
  };
  const send = async (type: CommandType, payload: Record<string, unknown>) => {
    if (!current.current?.hasControl) return;
    const scope = generation.current;
    try { const reply: Reply = await request('command', commandFor(type, payload)); if (!reply.ok) setNotice(errorText(reply.code)); }
    catch { if (scope === generation.current) { setNotice(errorText('NETWORK_PENDING')); void sync().catch(() => {}); } }
  };
  const move = (direction: Direction) => {
    const state = current.current;
    if (!socketRef.current?.connected || !state?.hasControl || state.world.phase === 'waiting' || state.view.kind || storage.get(slot('close'))) return;
    socketRef.current.volatile.emit('command', commandFor('player:move', { direction }), (reply: Reply) => { if (!reply.ok) setNotice(errorText(reply.code)); });
  };
  const open = (kind: 'puzzle' | 'npc') => {
    const state = current.current; if (!state?.hasControl || state.view.kind) return;
    const p = state.world.players[state.seatId], mapId = state.world.currentMapId;
    const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[p.facing];
    const target = kind === 'puzzle' ? state.game.puzzles.find(q => q.placement.mapId === mapId && q.placement.x === p.x && q.placement.y === p.y) : state.game.npcs.find(n => n.mapId === mapId && n.x === p.x! + delta[0] && n.y === p.y! + delta[1]);
    if (target) void send(kind === 'puzzle' ? 'puzzle:open' : 'npc:interact', { targetId: target.id });
    else setNotice(kind === 'puzzle' ? '站到标有题号的格子上，再按 V。' : '面向相邻的旅人，再按 X。');
  };
  const submit = async (answer: string) => {
    const state = current.current; if (!state?.hasControl || state.view.kind !== 'puzzle' || storage.get(slot('submit'))) return;
    const command = commandFor('puzzle:submit', { puzzleId: state.view.targetId, answer }); storage.set(slot('submit'), command); setPending(true); setFeedback(null); await reconcile();
  };
  const close = async () => {
    const state = current.current; if (!state?.view.kind || !state.hasControl || storage.get(slot('close'))) return;
    const command = commandFor(state.view.kind === 'puzzle' ? 'puzzle:close' : 'npc:close', {}); storage.set(slot('close'), command); setClosing(true); window.dispatchEvent(new Event('ph:clear-keys')); await reconcile();
  };
  return { snapshot, online, notice, setNotice, presence, pending, closing, feedback, move, open, submit, close, claim: (roleId: string) => send('role:claim', { roleId }), takeover: () => enter(true), retry: reconcile };
}
