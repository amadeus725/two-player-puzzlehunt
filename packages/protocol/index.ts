export const PROTOCOL_VERSION = 1;
export type SeatId = '1' | '2';
export const SEATS: SeatId[] = ['1', '2'];
export type Direction = 'up' | 'down' | 'left' | 'right';
export type Position = { mapId: string; x: number; y: number };
export type MapDefinition = { id: string; name: string; description?: string; width: number; height: number; paths: [number, number][]; water?: [number, number][]; walls: { from: [number, number]; to: [number, number] }[] };
export type PortalGroup = { id: string; unlockAfter?: string[]; sides: { mapId: string; doors: { id: string; x: number; y: number }[] }[]; pairs: [string, string][] };
export type PuzzleMeta = { id: string; number: string; title: string; placement: Position };
export type PublicGame = {
  schemaVersion: number; contentVersion: string; mode: string; title: string; startMapId: string; finalPuzzleId: string;
  roles: { id: string; name: string; visualKey: string; spawn: Position & { facing: Direction } }[];
  maps: MapDefinition[]; puzzles: PuzzleMeta[];
  locks: (Position & { id: string; controllerPuzzleId: string })[];
  npcs: (Position & { id: string; visualKey: string })[];
  portalGroups: PortalGroup[];
};
export type Player = { roleId: string | null; x: number | null; y: number | null; facing: Direction };
export type PuzzleState = { answer: string | null; solved: boolean; answerVariantId: string | null; lastSubmittedBy: SeatId | null; updatedAt: string | null };
export type ViewState = { viewRevision: number; viewId: string | null; kind: 'puzzle' | 'npc' | null; targetId: string | null };
export type World = {
  id: string; code: string; contentVersion: string; saveSchemaVersion: number; saveEpoch: string; revision: number;
  phase: 'waiting' | 'active' | 'completed'; currentMapId: string; mapEpoch: number;
  players: Record<SeatId, Player>; puzzles: Record<string, PuzzleState>;
  disabledPortal: string | null; completedAt: string | null; completedBy: SeatId | null;
  unlockedPortals?: Record<string, string>;
};
export const isPortalOpen = (world: World, group: PortalGroup) => !group.unlockAfter || !!world.unlockedPortals?.[group.id];
export type PrivateView = ViewState & { saveEpoch: string; content?: { title: string; text: string; puzzleId?: string } };
export type RoomSnapshot = { world: World; game: PublicGame; view: PrivateView; seatId: SeatId; recoveryCode?: string; controlEpoch: number; hasControl: boolean };
export type CommandType = 'role:claim' | 'player:move' | 'puzzle:open' | 'puzzle:close' | 'puzzle:submit' | 'npc:interact' | 'npc:close';
export type Command = {
  protocolVersion: number; saveEpoch: string; commandId: string; controlEpoch: number;
  type: CommandType; payload: Record<string, unknown>; mapId?: string; mapEpoch?: number; viewId?: string;
};
export type Reply = { ok: boolean; commandId?: string; code?: string; message?: string; saveEpoch?: string; revision?: number; viewRevision?: number; result?: Record<string, unknown> };
