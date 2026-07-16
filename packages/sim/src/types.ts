import type { CardId, PlayerId, Vec2 } from '@kingdoms/content';

export type { ArchetypeId, CardId, PlayerId, Vec2 } from '@kingdoms/content';

export const POSITION_SCALE = 100;
export const YAW_SCALE = 65_535;
export const TICK_RATE = 20;
export type TeamId = 0 | 1;
export const TEAM_BY_PLAYER: readonly [TeamId, TeamId, TeamId, TeamId] = [0, 1, 0, 1];

export function teamForPlayer(playerId: PlayerId): TeamId {
  return TEAM_BY_PLAYER[playerId];
}

export enum EntityKindCode { Unit = 1, Building = 2 }
export enum ArchetypeCode { Guard = 1, Archer = 2, Knight = 3, Giant = 4, Commander = 5, CannonTower = 6 }
export enum EntityStateCode { Idle = 0, Walk = 1, Attack = 2, Hit = 3, Death = 4, Spawn = 5 }

export type DeployCardId = Exclude<CardId, 'fireball' | 'chain_lightning'>;
export type SpellCardId = Extract<CardId, 'fireball' | 'chain_lightning'>;

interface CommandBase {
  playerId: PlayerId;
  sequence: number;
  tick: number;
  position: Vec2;
}
export interface DeployGameCommand extends CommandBase {
  type: 'deploy';
  cardId: DeployCardId;
  routeId: string;
}
export interface SpellGameCommand extends CommandBase {
  type: 'spell';
  cardId: SpellCardId;
}
export type GameCommand = DeployGameCommand | SpellGameCommand;

export type CommandRejectionReason =
  | 'game-finished' | 'paused' | 'invalid-player' | 'eliminated' | 'invalid-sequence'
  | 'stale-tick' | 'future-tick' | 'unknown-card' | 'card-kind' | 'invalid-route'
  | 'invalid-position' | 'insufficient-elixir' | 'cooldown' | 'hero-active' | 'entity-capacity';
export interface CommandResult {
  accepted: boolean;
  reason?: CommandRejectionReason;
  executeTick?: number;
  snappedPosition?: Vec2;
}

export interface GameOptions {
  seed?: number;
  botPlayers?: readonly PlayerId[] | readonly number[];
  maxEntities?: number;
}

export interface PlayerSnapshot {
  id: PlayerId;
  teamId: TeamId;
  elixir: number;
  elixirMilli: number;
  maxElixir: number;
  alive: boolean;
  castleHp: number;
  castleMaxHp: number;
  cooldowns: Record<CardId, number>;
  lastSequence: number;
}
export interface CastleSnapshot {
  playerId: PlayerId;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  alive: boolean;
}
export interface CenterSnapshot {
  ownerPlayerId: PlayerId | null;
  capturingPlayerId: PlayerId | null;
  progressTicks: number;
  requiredTicks: number;
}
export interface EntitySnapshotTable {
  count: number;
  id: Uint32Array;
  kind: Uint8Array;
  archetype: Uint8Array;
  owner: Int8Array;
  x: Int16Array;
  z: Int16Array;
  yaw: Uint16Array;
  hp: Uint16Array;
  maxHp: Uint16Array;
  state: Uint8Array;
  stateTick: Uint16Array;
  targetId: Int32Array;
}

export type SimEvent =
  | { type: 'spawn'; tick: number; entityId: number; playerId: PlayerId; archetype: ArchetypeCode }
  | { type: 'damage'; tick: number; sourceId: number; targetType: 'entity' | 'castle'; targetId: number; amount: number }
  | { type: 'death'; tick: number; entityId: number; playerId: PlayerId }
  | { type: 'capture'; tick: number; playerId: PlayerId | null }
  | { type: 'spell'; tick: number; playerId: PlayerId; cardId: SpellCardId; position: Vec2; targetIds: number[] }
  | { type: 'elimination'; tick: number; playerId: PlayerId }
  | { type: 'game-over'; tick: number; winnerPlayerId: PlayerId | null; draw: boolean }
  | { type: 'command-rejected'; tick: number; playerId: PlayerId; sequence: number; reason: CommandRejectionReason };

export interface GameSnapshot {
  version: 1;
  tick: number;
  timeMs: number;
  phase: 'playing' | 'finished';
  winnerPlayerId: PlayerId | null;
  draw: boolean;
  stateHash: number;
  players: PlayerSnapshot[];
  castles: CastleSnapshot[];
  center: CenterSnapshot;
  entities: EntitySnapshotTable;
  events: SimEvent[];
}

export interface PlacementResult {
  valid: boolean;
  position: Vec2;
  yaw: number;
  pathDistance: number;
  laneId?: string;
  padId?: string;
  reason?: 'invalid-player' | 'invalid-route' | 'wrong-owner' | 'outside-deployment-zone' | 'too-far-from-lane' | 'no-tower-pad';
}
