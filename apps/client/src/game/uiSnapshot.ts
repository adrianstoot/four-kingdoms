import type { GameSnapshot } from '@kingdoms/sim';
import { normalizeSnapshot } from './snapshot';

export interface UiPlayer {
  id: number;
  elixir: number;
  maxElixir: number;
  cooldowns: Record<string, number>;
  active: boolean;
}

export interface UiCastle {
  owner: number;
  health: number;
  maxHealth: number;
  alive: boolean;
}

export interface UiSnapshot {
  tick: number;
  seconds: number;
  phase: string;
  winner: number | null;
  draw: boolean;
  players: UiPlayer[];
  castles: UiCastle[];
  centerOwner: number;
  centerProgress: number;
  unitCount: number;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null ? value as UnknownRecord : {};
}

function numberValue(source: UnknownRecord, keys: readonly string[], fallback: number): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return fallback;
}

function boolValue(source: UnknownRecord, keys: readonly string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') return value;
  }
  return fallback;
}

function cooldownRecord(value: unknown): Record<string, number> {
  const source = asRecord(value);
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(source)) if (typeof entry === 'number') result[key] = entry;
  return result;
}

export function toUiSnapshot(snapshot: GameSnapshot | null): UiSnapshot {
  const raw = asRecord(snapshot);
  const normalized = normalizeSnapshot(snapshot);
  const rawPlayers = Array.isArray(raw.players) ? raw.players : [];
  const players = Array.from({ length: 4 }, (_, id): UiPlayer => {
    const player = asRecord(rawPlayers[id]);
    const elixirMilli = numberValue(player, ['elixirMilli'], Number.NaN);
    return {
      id,
      elixir: Number.isFinite(elixirMilli) ? elixirMilli / 1000 : numberValue(player, ['elixir', 'resource'], id === 0 ? 5 : 0),
      maxElixir: numberValue(player, ['maxElixir', 'resourceMax'], 100),
      cooldowns: cooldownRecord(player.cooldowns),
      active: boolValue(player, ['active', 'alive'], normalized.castles[id]?.alive ?? true),
    };
  });
  const phase = typeof raw.phase === 'string' ? raw.phase : 'battle';
  const winnerRaw = numberValue(raw, ['winnerPlayerId', 'winner', 'winnerId'], -1);
  const timeMs = numberValue(raw, ['timeMs'], Number.NaN);
  const seconds = Number.isFinite(timeMs) ? timeMs / 1000 : numberValue(raw, ['timeSeconds', 'seconds', 'time'], normalized.tick / 20);
  const center = asRecord(raw.center);
  const centerOwner = numberValue(center, ['ownerPlayerId', 'owner', 'ownerId'], normalized.centerOwner);
  const requiredTicks = Math.max(1, numberValue(center, ['requiredTicks'], 120));
  const centerProgress = Math.max(0, Math.min(1, numberValue(center, ['progressTicks'], 0) / requiredTicks));
  return {
    tick: normalized.tick,
    seconds,
    phase,
    winner: winnerRaw >= 0 && winnerRaw < 4 ? winnerRaw : null,
    draw: boolValue(raw, ['draw', 'isDraw'], false),
    players,
    castles: normalized.castles.map((castle) => ({
      owner: castle.owner,
      health: castle.health,
      maxHealth: castle.maxHealth,
      alive: castle.alive,
    })),
    centerOwner,
    centerProgress,
    unitCount: normalized.units.length,
  };
}
