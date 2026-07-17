import type { GameSnapshot } from "@kingdoms/sim";
import type { NormalizedCastle, NormalizedSnapshot, NormalizedUnit } from "./types";

type RecordValue = Record<string, unknown>;
type Indexable = { readonly length: number; readonly [index: number]: unknown };

const POSITION_SCALE = 100;
const NETWORK_POSITION_SCALE = 32;
const YAW_SCALE = 65_535;
const ARCHETYPE_NAMES = ["unknown", "guard", "archer", "knight", "giant", "commander", "cannon_tower"] as const;
const STATE_NAMES = ["idle", "walk", "attack", "hit", "death", "spawn"] as const;

function object(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null ? (value as RecordValue) : null;
}

function arrayLike(value: unknown): Indexable | null {
  return Array.isArray(value) || ArrayBuffer.isView(value) ? (value as unknown as Indexable) : null;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function at(source: RecordValue, keys: readonly string[], index: number): unknown {
  for (const key of keys) {
    const column = arrayLike(source[key]);
    if (column && index < column.length) return column[index];
  }
  return undefined;
}

function numberAt(source: RecordValue, keys: readonly string[], index: number, fallback = 0): number {
  return number(at(source, keys, index), fallback);
}

function stringAt(source: RecordValue, keys: readonly string[], index: number, fallback: string): string {
  const value = at(source, keys, index);
  return typeof value === "string" ? value : fallback;
}

function owner(value: number): number {
  return Math.max(0, Math.min(3, Math.trunc(value)));
}

function archetypeName(value: unknown): string {
  if (typeof value === "string") return value;
  const code = number(value, 0);
  return ARCHETYPE_NAMES[code] ?? "guard";
}

function stateName(value: unknown): string {
  if (typeof value === "string") return value;
  const code = number(value, 1);
  return STATE_NAMES[code] ?? "walk";
}

function normalizeSoA(source: RecordValue): NormalizedUnit[] {
  const count = Math.max(0, Math.trunc(number(source.count, arrayLike(source.id)?.length ?? 0)));
  const units: NormalizedUnit[] = [];
  for (let index = 0; index < count; index += 1) {
    const hp = Math.max(0, numberAt(source, ["hp", "health"], index, 1));
    const maxHp = Math.max(1, numberAt(source, ["maxHp", "maxHealth"], index, hp));
    const rawKind = at(source, ["archetype", "archetypes", "archetypeId", "kind"], index);
    const rawState = at(source, ["state", "animation"], index);
    if (hp <= 0 && stateName(rawState) !== "death") continue;
    units.push({
      id: Math.trunc(numberAt(source, ["id", "ids", "entityId"], index, index + 1)),
      owner: owner(numberAt(source, ["owner", "playerId", "team", "faction"], index, 0)),
      kind: archetypeName(rawKind),
      x: numberAt(source, ["x", "positionX"], index, 0) / POSITION_SCALE,
      z: numberAt(source, ["z", "positionZ"], index, 0) / POSITION_SCALE,
      rotation: numberAt(source, ["yaw", "heading"], index, 0) / YAW_SCALE * Math.PI * 2,
      health: hp,
      maxHealth: maxHp,
      state: stateName(rawState),
      stateTick: Math.max(0, Math.trunc(numberAt(source, ["stateTick", "stateTicks"], index, 0))),
      motionPhase: Math.max(0, Math.min(65_535, Math.trunc(numberAt(source, ["motionPhase", "phase"], index, 0)))),
    });
  }
  return units;
}

function normalizeObjectEntity(value: unknown, index: number): NormalizedUnit | null {
  const entity = object(value);
  if (!entity) return null;
  const hp = Math.max(0, number(entity.hp, number(entity.health, 1)));
  const maxHp = Math.max(1, number(entity.maxHp, number(entity.maxHealth, hp)));
  const state = typeof entity.state === "string" ? entity.state : stateName(entity.animation);
  if (hp <= 0 && state !== "death") return null;
  const hasNetworkQuantization = typeof entity.xQ === "number";
  const x = hasNetworkQuantization ? number(entity.xQ) / NETWORK_POSITION_SCALE : number(entity.x);
  const z = hasNetworkQuantization ? number(entity.zQ) / NETWORK_POSITION_SCALE : number(entity.z);
  const rawKind = entity.archetypeId ?? entity.archetype ?? entity.kind;
  return {
    id: Math.trunc(number(entity.id, index + 1)),
    owner: owner(number(entity.ownerPlayerId, number(entity.playerId, number(entity.owner, 0)))),
    kind: archetypeName(rawKind),
    x,
    z,
    rotation: hasNetworkQuantization ? number(entity.headingQ) / YAW_SCALE * Math.PI * 2 : number(entity.yaw, number(entity.rotation)),
    health: hp,
    maxHealth: maxHp,
    state,
    stateTick: Math.max(0, Math.trunc(number(entity.stateTick, number(entity.stateTicks, 0)))),
    motionPhase: Math.max(0, Math.min(65_535, Math.trunc(number(entity.motionPhase, number(entity.phase, 0))))),
  };
}

function normalizeUnits(snapshot: RecordValue): NormalizedUnit[] {
  const raw = snapshot.entities ?? snapshot.units;
  if (Array.isArray(raw)) {
    const units: NormalizedUnit[] = [];
    raw.forEach((value, index) => {
      const unit = normalizeObjectEntity(value, index);
      if (unit) units.push(unit);
    });
    return units;
  }
  const soa = object(raw);
  return soa ? normalizeSoA(soa) : [];
}

function normalizeCastles(snapshot: RecordValue): NormalizedCastle[] {
  const raw = snapshot.castles;
  const players = Array.isArray(snapshot.players) ? snapshot.players : [];
  const result: NormalizedCastle[] = Array.from({ length: 4 }, (_, playerId) => {
    const player = object(players[playerId]);
    const health = Math.max(0, number(player?.castleHp, number(player?.health, 10_000)));
    const maxHealth = Math.max(1, number(player?.castleMaxHp, number(player?.maxHealth, 10_000)));
    return { owner: playerId, health, maxHealth, alive: player?.alive !== false && health > 0 };
  });
  if (!Array.isArray(raw)) return result;
  raw.forEach((value, index) => {
    const castle = object(value);
    if (!castle) return;
    const playerId = owner(number(castle.playerId, number(castle.ownerPlayerId, number(castle.owner, index))));
    const health = Math.max(0, number(castle.hp, number(castle.health, 0)));
    const maxHealth = Math.max(1, number(castle.maxHp, number(castle.maxHealth, 10_000)));
    const flags = number(castle.flags, 1);
    result[playerId] = {
      owner: playerId,
      health,
      maxHealth,
      alive: castle.alive !== false && (flags & 1) !== 0 && health > 0,
    };
  });
  return result;
}

export function normalizeGameSnapshot(value: GameSnapshot | null): NormalizedSnapshot {
  const snapshot = object(value) ?? {};
  const units = normalizeUnits(snapshot);
  const unitById = new Map<number, NormalizedUnit>();
  for (const unit of units) unitById.set(unit.id, unit);
  const center = object(snapshot.center) ?? {};
  const rawOwner = number(center.ownerPlayerId, number(center.ownerId, number(snapshot.centerOwner, -1)));
  const centerOwner = rawOwner > 3 ? -1 : Math.trunc(rawOwner);
  const progress = typeof center.progressQ === "number"
    ? number(center.progressQ) / 65_535
    : number(center.progressTicks, number(center.progress, 0)) / Math.max(1, number(center.requiredTicks, 120));
  return {
    tick: Math.trunc(number(snapshot.tick, 0)),
    units,
    unitById,
    castles: normalizeCastles(snapshot),
    centerOwner,
    centerProgress: Math.max(0, Math.min(1, progress)),
  };
}
