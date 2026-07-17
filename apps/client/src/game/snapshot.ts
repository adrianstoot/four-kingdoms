import type { NormalizedCastle, NormalizedSnapshot, NormalizedUnit } from "./types";

type UnknownRecord = Record<string, unknown>;
type Indexable = { readonly length: number; readonly [index: number]: unknown };

const DEFAULT_CASTLE_HEALTH = 4_000;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : null;
}

function numberFrom(source: UnknownRecord | null, keys: readonly string[], fallback = 0): number {
  if (!source) return fallback;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

function stringFrom(source: UnknownRecord | null, keys: readonly string[], fallback: string): string {
  if (!source) return fallback;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
  }
  return fallback;
}

function booleanFrom(source: UnknownRecord | null, keys: readonly string[], fallback: boolean): boolean {
  if (!source) return fallback;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
  }
  return fallback;
}

function indexable(value: unknown): Indexable | null {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return value as unknown as Indexable;
  return null;
}

function valueAt(source: UnknownRecord, keys: readonly string[], index: number): unknown {
  for (const key of keys) {
    const values = indexable(source[key]);
    if (values && index < values.length) return values[index];
  }
  return undefined;
}

function numericAt(source: UnknownRecord, keys: readonly string[], index: number, fallback = 0): number {
  const value = valueAt(source, keys, index);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function textAt(source: UnknownRecord, keys: readonly string[], index: number, fallback: string): string {
  const value = valueAt(source, keys, index);
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function normalizeOwner(value: number): number {
  return Math.max(0, Math.min(3, Math.trunc(value)));
}

function normalizeUnitObject(value: unknown, index: number): NormalizedUnit | null {
  const unit = record(value);
  if (!unit) return null;
  const position = record(unit.position) ?? record(unit.pos);
  const maxHealth = Math.max(1, numberFrom(unit, ["maxHealth", "maxHp", "hpMax"], 100));
  const health = Math.max(0, numberFrom(unit, ["health", "hp", "currentHealth"], maxHealth));
  if (!booleanFrom(unit, ["alive", "active", "enabled"], true) || health <= 0) return null;

  const z = numberFrom(unit, ["z", "positionZ", "pz"], numberFrom(position, ["z", "y"], 0));
  return {
    id: Math.trunc(numberFrom(unit, ["id", "entityId", "eid"], index + 1)),
    owner: normalizeOwner(numberFrom(unit, ["owner", "ownerId", "playerId", "team", "faction"], 0)),
    kind: stringFrom(unit, ["kind", "unitType", "archetype", "cardId", "type"], "guard"),
    x: numberFrom(unit, ["x", "positionX", "px"], numberFrom(position, ["x"], 0)),
    z,
    rotation: numberFrom(unit, ["rotation", "yaw", "heading", "angle"], 0),
    health,
    maxHealth,
    state: stringFrom(unit, ["state", "animation", "anim"], "walk"),
    stateTick: Math.max(0, Math.trunc(numberFrom(unit, ["stateTick", "stateTicks"], 0))),
    motionPhase: Math.max(0, Math.min(65_535, Math.trunc(numberFrom(unit, ["motionPhase", "phase"], 0)))),
  };
}

function normalizeUnitSoA(source: UnknownRecord): NormalizedUnit[] {
  const ids = indexable(source.ids) ?? indexable(source.id) ?? indexable(source.entityIds);
  const xs = indexable(source.x) ?? indexable(source.xs) ?? indexable(source.positionX);
  const count = Math.max(0, Math.trunc(numberFrom(source, ["count", "length"], ids?.length ?? xs?.length ?? 0)));
  const positionScale = Math.max(0.000_001, numberFrom(source, ["positionScale", "coordinateScale"], 100));
  const result: NormalizedUnit[] = [];
  for (let index = 0; index < count; index += 1) {
    const maxHealth = Math.max(1, numericAt(source, ["maxHealth", "maxHp", "hpMax"], index, 100));
    const health = Math.max(0, numericAt(source, ["health", "hp", "currentHealth"], index, maxHealth));
    const active = numericAt(source, ["alive", "active", "enabled"], index, 1) !== 0;
    if (!active || health <= 0) continue;
    result.push({
      id: Math.trunc(numericAt(source, ["ids", "id", "entityIds", "eid"], index, index + 1)),
      owner: normalizeOwner(numericAt(source, ["owners", "owner", "ownerId", "playerId", "team", "faction"], index, 0)),
      kind: textAt(source, ["kinds", "kind", "unitType", "archetype", "cardId", "type"], index, "guard"),
      x: numericAt(source, ["x", "xs", "positionX", "px"], index, 0) / positionScale,
      z: numericAt(source, ["z", "zs", "positionZ", "pz", "y"], index, 0) / positionScale,
      rotation: numericAt(source, ["rotation", "rotations", "yaw", "heading", "angle"], index, 0),
      health,
      maxHealth,
      state: textAt(source, ["states", "state", "animation", "anim"], index, "walk"),
      stateTick: Math.max(0, Math.trunc(numericAt(source, ["stateTick", "stateTicks"], index, 0))),
      motionPhase: Math.max(0, Math.min(65_535, Math.trunc(numericAt(source, ["motionPhase", "phase"], index, 0)))),
    });
  }
  return result;
}

function normalizeUnits(snapshot: UnknownRecord): NormalizedUnit[] {
  const raw = snapshot.units ?? snapshot.entities ?? record(snapshot.world)?.units;
  if (Array.isArray(raw)) {
    const result: NormalizedUnit[] = [];
    raw.forEach((entry, index) => {
      const unit = normalizeUnitObject(entry, index);
      if (unit) result.push(unit);
    });
    return result;
  }
  const soa = record(raw);
  return soa ? normalizeUnitSoA(soa) : [];
}

function normalizeCastles(snapshot: UnknownRecord): NormalizedCastle[] {
  const defaults = Array.from({ length: 4 }, (_, owner) => ({
    owner,
    health: DEFAULT_CASTLE_HEALTH,
    maxHealth: DEFAULT_CASTLE_HEALTH,
    alive: true,
  }));
  const raw = snapshot.castles ?? record(snapshot.world)?.castles;
  if (Array.isArray(raw)) {
    for (let index = 0; index < raw.length; index += 1) {
      const castle = record(raw[index]);
      if (!castle) continue;
      const owner = normalizeOwner(numberFrom(castle, ["owner", "ownerId", "playerId", "team", "faction", "id"], index));
      const maxHealth = Math.max(1, numberFrom(castle, ["maxHealth", "maxHp", "hpMax"], DEFAULT_CASTLE_HEALTH));
      const health = Math.max(0, numberFrom(castle, ["health", "hp", "currentHealth"], maxHealth));
      defaults[owner] = {
        owner,
        health,
        maxHealth,
        alive: booleanFrom(castle, ["alive", "active"], health > 0) && health > 0,
      };
    }
    return defaults;
  }
  const soa = record(raw);
  if (!soa) return defaults;
  const count = Math.min(4, Math.trunc(numberFrom(soa, ["count", "length"], 4)));
  for (let index = 0; index < count; index += 1) {
    const owner = normalizeOwner(numericAt(soa, ["owners", "owner", "ownerId", "playerId", "team"], index, index));
    const maxHealth = Math.max(1, numericAt(soa, ["maxHealth", "maxHp", "hpMax"], index, DEFAULT_CASTLE_HEALTH));
    const health = Math.max(0, numericAt(soa, ["health", "hp", "currentHealth"], index, maxHealth));
    defaults[owner] = {
      owner,
      health,
      maxHealth,
      alive: numericAt(soa, ["alive", "active"], index, health > 0 ? 1 : 0) !== 0 && health > 0,
    };
  }
  return defaults;
}

export function normalizeSnapshot(value: unknown): NormalizedSnapshot {
  const snapshot = record(value) ?? {};
  const units = normalizeUnits(snapshot);
  const unitById = new Map<number, NormalizedUnit>();
  for (const unit of units) unitById.set(unit.id, unit);
  const center = record(snapshot.center) ?? record(snapshot.objective) ?? record(snapshot.controlPoint);
  const centerOwner = Math.trunc(numberFrom(snapshot, ["centerOwner", "objectiveOwner"], numberFrom(center, ["owner", "ownerId", "team"], -1)));
  const centerProgress = Math.max(0, Math.min(1, numberFrom(snapshot, ["centerProgress", "captureProgress"], numberFrom(center, ["progress", "captureProgress"], 0))));
  return {
    tick: Math.trunc(numberFrom(snapshot, ["tick", "serverTick", "frame"], 0)),
    units,
    unitById,
    castles: normalizeCastles(snapshot),
    centerOwner,
    centerProgress,
  };
}
