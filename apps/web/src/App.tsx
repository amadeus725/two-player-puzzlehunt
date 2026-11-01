import { useEffect, useRef, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { isPortalOpen, type Direction, type RoomSnapshot, type SeatId } from '../../../packages/protocol/index.js';
import { api, errorText, storage, useRoom } from './useRoom.js';
import { newId } from './id.js';

type Session = { sessionId: string; rooms: { id: string; code: string }[] };
const roomFromUrl = () => location.pathname.match(/^\/rooms\/([\w-]+)$/)?.[1] ?? null;
const directionNames = { up: '上', down: '下', left: '左', right: '右' };
function SymbolGrid() { return <div className="symbol-grid" aria-hidden="true">{Array.from({ length: 49 }, (_, i) => <i key={i} className={[9, 16, 17, 18, 24, 31, 32, 33, 39].includes(i) ? 'ink' : [10, 23, 34].includes(i) ? 'ochre' : ''}>{i === 17 ? '1' : i === 31 ? '2' : i === 24 ? '✧' : ''}</i>)}</div>; }
export function App() {
  const [session, setSession] = useState<Session | null>(null), [roomId, setRoomId] = useState(roomFromUrl), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [code, setCode] = useState(location.pathname.match(/^\/join\/(\w+)$/)?.[1] ?? ''), [recovery, setRecovery] = useState(''), [recoverMode, setRecoverMode] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false), [showEnding, setShowEnding] = useState(true);
  useEffect(() => { setShowEnding(true); setShowRecovery(false); }, [roomId]);
  const room = useRoom(roomId, !!session), current = useRef(room); current.current = room;
  const navigate = (id: string | null) => { history.pushState({}, '', id ? `/rooms/${id}` : '/'); setRoomId(id); setError(''); };
  useEffect(() => {
    let alive = true;
    void api<Session>('/api/session').then(first => api<Session>('/api/session').then(async second => {
      if (first.sessionId !== second.sessionId) throw new Error('COOKIE_DISABLED');
      if (!alive) return; setSession(second);
      const key = `ph.entry.${second.sessionId}`;
      const pendingEntry = storage.get<{ operation: 'create' | 'join'; code: string; entryRequestId: string }>(key);
      if (pendingEntry && !roomFromUrl()) {
        setBusy(true); setCode(pendingEntry.code);
        try {
          const result = await api<{ roomId: string }>(pendingEntry.operation === 'create' ? '/api/rooms' : '/api/rooms/join', pendingEntry);
          storage.remove(key); if (alive) navigate(result.roomId);
        } catch (e) { if (alive) setError(errorText(e instanceof Error ? e.message : 'NETWORK_PENDING')); }
        finally { if (alive) setBusy(false); }
      }
    })).catch(e => alive && setError(errorText(e.message)));
    const pop = () => setRoomId(roomFromUrl()); window.addEventListener('popstate', pop);
    return () => { alive = false; window.removeEventListener('popstate', pop); };
  }, []);
  const enter = async (operation: 'create' | 'join') => {
    if (!session || busy) return; setBusy(true); setError('');
    const key = `ph.entry.${session.sessionId}`;
    const existing = storage.get<{ operation: string; code: string; entryRequestId: string }>(key);
    const request = existing?.operation === operation && (operation === 'create' || existing.code === code.trim().toUpperCase()) ? existing : { operation, code: code.trim().toUpperCase(), entryRequestId: newId() };
    storage.set(key, request);
    try { const result = await api<{ roomId: string }>(operation === 'create' ? '/api/rooms' : '/api/rooms/join', request); storage.remove(key); navigate(result.roomId); }
    catch (e) { setError(errorText(e instanceof Error ? e.message : 'NETWORK_PENDING')); }
    finally { setBusy(false); }
  };
  const recover = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await api<{ roomId: string }>('/api/rooms/recover', { code, recoveryCode: recovery }); navigate(result.roomId); }
    catch (e) { setError(errorText(e instanceof Error ? e.message : 'NETWORK_PENDING')); } finally { setBusy(false); }
  };
  useEffect(() => {
    const held = new Map<string, Direction>();
    const keys: Record<string, Direction> = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
    const clear = () => held.clear();
    const down = (event: KeyboardEvent) => {
      const r = current.current; if (!r.snapshot || !r.online || !r.snapshot.hasControl || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'Escape' && r.snapshot.view.kind) { event.preventDefault(); void r.close(); return; }
      const target = event.target as HTMLElement;
      if (target.matches('input,textarea,select') || target.isContentEditable) return;
      if (r.snapshot.view.kind) { if (event.code === 'KeyX' && r.snapshot.view.kind === 'npc' && !event.repeat) void r.close(); return; }
      if (keys[event.code]) { event.preventDefault(); if (!event.repeat) { held.set(event.code, keys[event.code]); r.move(keys[event.code]); } }
      else if (!event.repeat && event.code === 'KeyV') r.open('puzzle');
      else if (!event.repeat && event.code === 'KeyX') r.open('npc');
    };
    const up = (event: KeyboardEvent) => held.delete(event.code);
    const timer = window.setInterval(() => { const direction = [...held.values()].at(-1); if (direction) current.current.move(direction); }, 150);
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', clear); window.addEventListener('ph:clear-keys', clear); document.addEventListener('visibilitychange', clear);
    return () => { clearInterval(timer); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clear); window.removeEventListener('ph:clear-keys', clear); document.removeEventListener('visibilitychange', clear); };
  }, []);
  useEffect(() => { if (room.snapshot?.view.kind) window.dispatchEvent(new Event('ph:clear-keys')); }, [room.snapshot?.view.viewId]);
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); room.setNotice('已复制。'); } catch { room.setNotice(text); } };
  const snapshot = room.snapshot;
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/" onClick={e => { e.preventDefault(); navigate(null); }}><span className="brand-mark">◈</span><span>共行<small>PUZZLEHUNT FOR TWO</small></span></a><div className="top-meta"><span className="edition">{snapshot?.game.contentVersion === 'demo-v2' ? '占位试玩 · 01' : '区域布局 · 占位试玩'}</span>{roomId && <span className={`connection ${room.online ? 'connected' : ''}`}><i/>{room.online ? '已连接' : '连接中'}</span>}</div></header>
    {!roomId ? <main className="landing">
      <section className="intro"><p className="eyebrow">A SHARED WORLD. TWO PERSPECTIVES.</p><h1>一道谜题，<br/>两个人的旅程<span>。</span></h1><p className="intro-copy">在同一张地图上相遇，各自寻找线索。<br/>你解开的每一道题，都会改变两个人的世界。</p><div className="intro-art"><SymbolGrid/><span>东 · 南 · 西 · 北 · 中<br/><b>五张地图，一份共同存档</b></span></div><p className="test-note">当前为占位试玩：题目、角色与对话均为测试内容。</p></section>
      <section className="entry-card"><p className="eyebrow">从这里开始</p><h2>{recoverMode ? '找回这段旅程' : '与同伴会合'}</h2><p className="muted">两台电脑，一个房间。准备好了就出发。</p>
        {!recoverMode && <><button className="primary full" disabled={!session || busy} onClick={() => void enter('create')}>创建新房间 <span>↗</span></button><div className="divider"><span>或者加入同伴</span></div></>}
        <form onSubmit={recoverMode ? recover : e => { e.preventDefault(); void enter('join'); }}><label htmlFor="room-code">房间码</label><input id="room-code" className="code-input" placeholder="输入同伴分享的房间码" value={code} onChange={e => setCode(e.target.value.toUpperCase())} autoComplete="off" maxLength={20}/>{recoverMode && <><label htmlFor="recovery-code">你的席位恢复码</label><input id="recovery-code" value={recovery} onChange={e => setRecovery(e.target.value)} placeholder="首次加入时保存的恢复码" autoComplete="off"/></>}<button className={recoverMode ? 'primary full' : 'secondary full'} disabled={!session || busy || !code.trim()}>{busy ? '正在会合…' : recoverMode ? '恢复原来的角色' : '加入房间 →'}</button></form>
        {error && <p role="alert" className="error">{error}</p>}<button className="text-button" onClick={() => setRecoverMode(!recoverMode)}>{recoverMode ? '← 返回创建 / 加入' : '换了设备？使用恢复码继续'}</button>
        {!!session?.rooms.length && <div className="recent"><p className="eyebrow">继续上次的旅程</p>{session.rooms.map(r => <button key={r.id} onClick={() => navigate(r.id)}>房间 {r.code}<span>继续 →</span></button>)}</div>}
        <div className="entry-foot"><span>01 / 选择角色</span><span>02 / 共同探索</span><span>03 / 解开终题</span></div>
      </section>
    </main> : !snapshot ? <main className="loading"><span className="brand-mark">◈</span><h2>正在寻找你的同伴…</h2><p role="status">{room.notice || '正在恢复房间与席位。'}</p><button className="secondary" onClick={() => navigate(null)}>返回首页</button></main> : <main className="game-layout">
      <aside className="sidebar"><p className="eyebrow">共同存档</p><div className="room-code"><span>{snapshot.world.code}</span><button className="icon-button" title="复制邀请链接" aria-label="复制邀请链接" onClick={() => void copy(`${location.origin}/join/${snapshot.world.code}`)}>↗</button></div><p className="muted small">把房间码分享给另一位玩家</p><div className="section-line"/>
        <p className="eyebrow">旅途中的两个人</p>{(['1', '2'] as SeatId[]).map(s => { const p = snapshot.world.players[s]; const role = snapshot.game.roles.find(r => r.id === p.roleId); const visual = role ? snapshot.game.roles.indexOf(role) + 1 : Number(s); return <div key={s} className="player-row"><span className={`avatar avatar-${visual}`}>{visual}</span><div><strong>{role?.name ?? '等待选择角色'} {s === snapshot.seatId && <em>你</em>}</strong><small>{room.presence[s] ? '在线同行' : '暂时离线'}</small></div><i className={room.presence[s] ? 'dot online' : 'dot'}/></div>; })}
        <div className="section-line"/><p className="eyebrow">五方地图</p><nav className="map-list">{['center', 'north', 'east', 'south', 'west'].map((id, i) => <div key={id} className={snapshot.world.currentMapId === id ? 'active' : ''}><span>0{i + 1}</span><b>{snapshot.game.maps.find(m => m.id === id)?.name.split(' · ')[0]}</b>{snapshot.world.currentMapId === id && <small>所在地图</small>}</div>)}</nav>
        <PortalProgress snapshot={snapshot}/>
        <div className="progress-card"><span>已解谜题</span><strong>{Object.values(snapshot.world.puzzles).filter(p => p.solved).length}<small> / {snapshot.game.puzzles.length}</small></strong><div className="progress-track"><i style={{ width: `${Object.values(snapshot.world.puzzles).filter(p => p.solved).length / snapshot.game.puzzles.length * 100}%` }}/></div></div>
        <button className="text-button recovery-toggle" onClick={() => setShowRecovery(!showRecovery)}>{showRecovery ? '收起恢复码' : '保存我的恢复码'}</button>{showRecovery && <div className="recovery-box"><p>换设备时用它找回你的角色。请不要作为邀请链接分享。</p><code>{snapshot.recoveryCode}</code><button className="text-button" onClick={() => void copy(snapshot.recoveryCode ?? '')}>复制恢复码</button></div>}
      </aside>
      <section className="world-column"><div className="world-heading"><div><p className="eyebrow">CHAPTER 00 / PLACEHOLDER WORLD</p><h1>{snapshot.world.phase === 'waiting' ? '旅程尚未开始' : snapshot.game.maps.find(m => m.id === snapshot.world.currentMapId)?.name}</h1></div><span className="world-number">{({center:'中',east:'东',south:'南',west:'西',north:'北'} as Record<string,string>)[snapshot.world.currentMapId]}</span></div>
        {snapshot.world.phase !== 'waiting' && <p className="map-description">{snapshot.game.maps.find(m => m.id === snapshot.world.currentMapId)?.description}</p>}
        {!snapshot.hasControl && <div className="notice-bar">此角色已在另一处打开。<button onClick={() => void room.takeover()}>接管此角色</button></div>}
        {!room.online && <div className="notice-bar">正在重连，位置与草稿已保留。</div>}
        {snapshot.world.completedAt && showEnding && <div className="ending" role="status"><span>✧</span><div><strong>已通关</strong><p>可以继续探索与修改答案，寻找另一种解法。</p></div><button className="icon-button" aria-label="关闭通关提示" onClick={() => setShowEnding(false)}>×</button></div>}
        {snapshot.world.phase === 'waiting' ? <section className="role-selection"><p className="eyebrow">在故事开始以前</p><h2>我是谁？</h2><p className="muted">选一个角色，等待同伴一同进入地图。</p><div className="role-options">{snapshot.game.roles.map((role, index) => { const owner = (['1', '2'] as SeatId[]).find(s => snapshot.world.players[s].roleId === role.id); const selected = owner === snapshot.seatId; return <button key={role.id} className={`role-card ${selected ? 'selected' : ''}`} disabled={!snapshot.hasControl || !!owner || !!snapshot.world.players[snapshot.seatId].roleId || !room.online} onClick={() => void room.claim(role.id)}><div className={`role-portrait portrait-${index + 1}`}><span>{index + 1}</span></div><strong>{role.name}</strong><small>{selected ? '你已选择 · 等待同伴' : owner ? '同伴已选择' : '选择这个角色 →'}</small></button>; })}</div></section> : <Board snapshot={snapshot}/>}
        <div className="world-footer"><span><i className="legend puzzle-legend"/>谜题</span><span><i className="legend lock-legend"/>锁</span><span><i className="legend portal-legend"/>双人传送门</span><span><i className="legend npc-legend"/>旅人</span><small>不同地图之间，需要两个人一起出发。</small></div>
        <section className="controls-panel"><div><p className="eyebrow">行走与交互</p><p><kbd>W A S D</kbd> / <kbd>↑ ↓ ← →</kbd> 移动 <kbd>V</kbd> 查看脚下谜题 <kbd>X</kbd> 与面前的旅人交谈</p></div><div className="direction-pad">{(['up', 'left', 'down', 'right'] as Direction[]).map(dir => <button key={dir} className={`direction-${dir}`} aria-label={`向${directionNames[dir]}移动`} disabled={!room.online || !snapshot.hasControl || !!snapshot.view.kind || snapshot.world.phase === 'waiting'} onClick={() => room.move(dir)}>{({up:'↑',down:'↓',left:'←',right:'→'})[dir]}</button>)}</div></section>
        <div className="status-line" role="status">{room.closing ? '正在同步关闭状态…' : room.notice || (snapshot.world.phase === 'waiting' ? '两个人选好角色后，旅程会自动开始。' : '站上题号格按 V。你们的窗口独立，解题结果共享。')}{(room.pending || room.closing) && <button className="text-button" onClick={() => void room.retry()}>重新核对</button>}</div>
      </section>
      {snapshot.view.kind && !room.closing && <PuzzleDialog key={`${snapshot.seatId}:${snapshot.view.viewId}`} snapshot={snapshot} pending={room.pending} online={room.online} feedback={room.feedback} close={() => void room.close()} submit={room.submit} takeover={() => void room.takeover()} showEnding={showEnding}/>}
    </main>}
    <footer className="site-footer"><span>共行 · 两个人的 Puzzlehunt</span><span>寻找线索，也记得等一等同伴。</span></footer>
  </div>;
}
export function PortalProgress({ snapshot }: { snapshot: RoomSnapshot }) {
  const { game, world } = snapshot;
  return <>{game.portalGroups.filter(g => g.unlockAfter).map(group => {
    const open = isPortalOpen(world, group), required = group.unlockAfter!;
    const count = required.filter(id => world.puzzles[id].solved).length;
    const target = game.maps.find(m => m.id === group.sides.find(s => s.mapId !== game.startMapId)?.mapId)?.name.split(' · ')[0] ?? '区域';
    return <section key={group.id} className={`gate-progress ${open ? 'open' : ''}`} aria-label={`${target}入口`}><div><strong>{target}入口</strong><span>{open ? '已永久开放' : `${count} / ${required.length} Meta`}</span></div><ul>{required.map(id => <li key={id} className={world.puzzles[id].solved ? 'done' : ''}><span>{world.puzzles[id].solved ? '✓' : '○'}</span>{game.puzzles.find(p => p.id === id)?.title}</li>)}</ul><small>{open ? '之后修改答案也不会关闭。' : '大厅三个 Meta 首次全部解开后开放。'}</small></section>;
  })}</>;
}
function Board({ snapshot }: { snapshot: RoomSnapshot }) {
  const { world, game, seatId } = snapshot, map = game.maps.find(m => m.id === world.currentMapId)!;
  const roleNumber = (seat: SeatId) => game.roles.findIndex(r => r.id === world.players[seat].roleId) + 1;
  const paths = new Set(map.paths.map(p => p.join(',')));
  const water = new Set(map.water?.map(p => p.join(',')));
  return <div className={`board-stage ${map.description ? 'region-layout' : ''}`}><div className="board" data-testid="board" data-map={map.id} style={{ '--cols': map.width, '--rows': map.height } as React.CSSProperties}>
    {Array.from({ length: map.width * map.height }, (_, i) => { const x = i % map.width, y = Math.floor(i / map.width), valid = paths.has(`${x},${y}`);
      const puzzle = game.puzzles.find(p => p.placement.mapId === map.id && p.placement.x === x && p.placement.y === y);
      const lock = game.locks.find(l => l.mapId === map.id && l.x === x && l.y === y), isLocked = lock && !world.puzzles[lock.controllerPuzzleId].solved;
      const npc = game.npcs.find(n => n.mapId === map.id && n.x === x && n.y === y);
      const portal = game.portalGroups.flatMap(g => g.sides.filter(s => s.mapId === map.id).flatMap(s => s.doors.map((d, index) => ({ ...d, group: g, label: `${game.maps.find(m => m.id === g.sides.find(other => other.mapId !== map.id)?.mapId)?.name.split(' · ')[0]}${index + 1}` })))).find(d => d.x === x && d.y === y);
      const portalOpen = portal && isPortalOpen(world, portal.group);
      const players = (['1', '2'] as SeatId[]).filter(s => world.players[s].x === x && world.players[s].y === y);
      const solved = puzzle && world.puzzles[puzzle.id].solved;
      return <div key={i} data-cell={`${x},${y}`} title={water.has(`${x},${y}`) ? '水面 · 不可通行' : undefined} className={`cell ${valid ? 'path' : 'void'} ${water.has(`${x},${y}`) ? 'water' : ''} ${puzzle ? 'puzzle-cell' : ''} ${solved ? 'solved' : ''} ${isLocked ? 'locked' : ''}`}>
        {portal && <span data-portal={portal.group.id} data-open={!!portalOpen} className={`portal ${portalOpen ? '' : 'portal-closed'}`} title={`${portal.label} · ${portalOpen ? '两人站齐传送' : '区域 Meta 尚未全部解开'}`}><i/>{!portalOpen && <b>×</b>}<small>{portal.label}</small></span>}{npc && <span className="npc" title="旅人">◇<small>旅人</small></span>}
        {puzzle && <span className="puzzle-label">{puzzle.number}{solved && <small>✓</small>}</span>}
        {isLocked && <span className="lock-label" title={`由第 ${game.puzzles.find(p => p.id === lock.controllerPuzzleId)?.number} 题控制`}>▣ {game.puzzles.find(p => p.id === lock.controllerPuzzleId)?.number}</span>}
        {players.map(s => <span key={s} data-player={s} data-x={x} data-y={y} className={`actor actor-${roleNumber(s)} facing-${world.players[s].facing} ${s === seatId ? 'self' : ''}`} title={`${s === seatId ? '你' : '同伴'}${isLocked ? ' · 被锁在原地' : ''}`}><i/>{roleNumber(s)}</span>)}
      </div>;
    })}
    <svg className="wall-layer" viewBox={`0 0 ${map.width} ${map.height}`} preserveAspectRatio="none" aria-hidden="true">{map.walls.map((w, i) => { const [ax, ay] = w.from, [bx, by] = w.to; const vertical = ax !== bx; return <line key={i} x1={vertical ? Math.max(ax, bx) : ax} y1={vertical ? ay : Math.max(ay, by)} x2={vertical ? Math.max(ax, bx) : ax + 1} y2={vertical ? ay + 1 : Math.max(ay, by)} />; })}</svg>
  </div><p className="board-caption">{world.disabledPortal ? '离开传送门后重新站齐，即可返程。' : '两人站齐同组的两个传送门，即可共同跨图。'}</p></div>;
}
function PuzzleDialog({ snapshot, pending, online, feedback, close, submit, takeover, showEnding }: { snapshot: RoomSnapshot; pending: boolean; online: boolean; feedback: { puzzleId: string; solved: boolean } | null; close: () => void; submit: (answer: string) => Promise<void>; takeover: () => void; showEnding: boolean }) {
  const { view, world, seatId } = snapshot;
  const key = `ph.draft.${world.id}.${world.contentVersion}.${seatId}.${view.targetId}`;
  const [answer, setAnswer] = useState(storage.get<string>(key) ?? '');
  const [image, setImage] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null), imagePanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    (input.current ?? dialog.current?.querySelector<HTMLElement>('button'))?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (image) imagePanel.current?.querySelector('button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (image && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setImage(null); input.current?.focus(); return; }
      if (event.key !== 'Tab') return;
      const elements = (image ? imagePanel.current : dialog.current)?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]');
      if (!elements?.length) return;
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', trap, true); return () => window.removeEventListener('keydown', trap, true);
  }, [image]);
  const state = view.kind === 'puzzle' ? world.puzzles[view.targetId!] : null;
  return <div className="modal-backdrop"><section ref={dialog} className="puzzle-dialog" role="dialog" aria-modal="true" aria-labelledby="puzzle-title"><header className="dialog-header"><div><p className="eyebrow">{view.kind === 'puzzle' ? '属于你的题面窗口' : '一段交谈'}</p><h2 id="puzzle-title">{view.content?.title}</h2></div><button className="icon-button" aria-label="关闭窗口" disabled={!snapshot.hasControl} onClick={close}>×</button></header>
    {state && <div className="puzzle-status"><span className={state.solved ? 'solved-status' : ''}>{state.solved ? '● 已解开' : '○ 未解开'}</span><small>进度共享 · 草稿仅自己可见</small></div>}
    {!snapshot.hasControl && <div className="notice-bar">此角色已在另一处打开。<button onClick={takeover}>接管此角色</button></div>}
    {world.completedAt && showEnding && <div className="ending" role="status"><span>✧</span><div><strong>已通关</strong><p>共同的旅程已通关，可以继续阅读与修改答案。</p></div></div>}
    <div className="puzzle-body"><ReactMarkdown skipHtml components={{ img: ({ src, alt }) => <img src={src} alt={alt ?? ''} onClick={() => typeof src === 'string' && setImage(src)} />, a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{view.content?.text ?? ''}</ReactMarkdown></div>
    {state ? <form className="answer-area" onSubmit={e => { e.preventDefault(); void submit(answer); }}><label htmlFor="puzzle-answer">你的答案</label><div className="answer-row"><input ref={input} id="puzzle-answer" value={answer} autoComplete="off" onChange={e => { setAnswer(e.target.value); storage.set(key, e.target.value); }} onKeyDown={e => { if (e.nativeEvent.isComposing && e.key === 'Enter') e.preventDefault(); }} placeholder="输入答案，按 Enter 提交" disabled={!snapshot.hasControl}/><button className="primary" disabled={pending || !online || !snapshot.hasControl || !answer.trim()}>{pending ? '正在确认…' : '提交答案 →'}</button></div><div className="answer-feedback" role="status">{feedback?.puzzleId === view.targetId && <strong className={feedback.solved ? 'correct' : 'incorrect'}>{feedback.solved ? '答案正确，进度已同步。' : '答案不正确，当前结果已覆盖，可以立即重试。'}</strong>}<span>共享的当前答案：<b>{state.answer ?? '尚未提交'}</b></span></div></form> : <div className="dialog-bottom"><span>按 X 或 Esc 结束交谈</span><button className="secondary" onClick={close} disabled={!snapshot.hasControl}>继续探索</button></div>}
    </section>{image && <div ref={imagePanel} className="image-overlay" onClick={() => setImage(null)} role="dialog" aria-modal="true" aria-label="原尺寸图片"><button className="secondary" onClick={() => setImage(null)}>关闭图片</button><img src={image} alt="题面原图"/></div>}</div>;
}
