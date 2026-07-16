import { z } from 'zod';

export const playerIdSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const vec2Schema = z.object({
  x: z.number().finite(),
  z: z.number().finite(),
});

export const cardIdSchema = z.enum([
  'guards',
  'archers',
  'knight',
  'giant',
  'commander',
  'cannon_tower',
  'fireball',
  'chain_lightning',
]);

export const archetypeIdSchema = z.enum([
  'guard',
  'archer',
  'knight',
  'giant',
  'commander',
  'cannon_tower',
]);

const combatStatsSchema = z.object({
  maxHp: z.number().int().positive(),
  damage: z.number().int().nonnegative(),
  attackRange: z.number().positive(),
  aggroRange: z.number().positive(),
  attackCooldownTicks: z.number().int().positive(),
  radius: z.number().positive(),
  captureWeight: z.number().nonnegative(),
  targetPriority: z.enum(['closest', 'buildings']),
});

export const unitDefinitionSchema = combatStatsSchema.extend({
  id: archetypeIdSchema.exclude(['cannon_tower']),
  kind: z.literal('unit'),
  moveSpeed: z.number().positive(),
  hero: z.boolean().default(false),
});

export const buildingDefinitionSchema = combatStatsSchema.extend({
  id: z.literal('cannon_tower'),
  kind: z.literal('building'),
  lifetimeTicks: z.number().int().positive(),
});

const troopCardSchema = z.object({
  id: cardIdSchema,
  kind: z.literal('troop'),
  cost: z.number().int().min(0).max(10),
  archetypeId: archetypeIdSchema.exclude(['cannon_tower']),
  count: z.number().int().positive(),
  cooldownTicks: z.number().int().nonnegative(),
});

const buildingCardSchema = z.object({
  id: z.literal('cannon_tower'),
  kind: z.literal('building'),
  cost: z.number().int().min(0).max(10),
  archetypeId: z.literal('cannon_tower'),
  count: z.literal(1),
  cooldownTicks: z.number().int().nonnegative(),
});

const areaSpellCardSchema = z.object({
  id: z.literal('fireball'),
  kind: z.literal('spell'),
  spell: z.literal('area'),
  cost: z.number().int().min(0).max(10),
  cooldownTicks: z.number().int().nonnegative(),
  radius: z.number().positive(),
  damage: z.number().int().positive(),
});

const chainSpellCardSchema = z.object({
  id: z.literal('chain_lightning'),
  kind: z.literal('spell'),
  spell: z.literal('chain'),
  cost: z.number().int().min(0).max(10),
  cooldownTicks: z.number().int().nonnegative(),
  radius: z.number().positive(),
  damage: z.number().int().positive(),
  maxTargets: z.number().int().positive(),
  chainRange: z.number().positive(),
  falloffBps: z.number().int().min(0).max(10_000),
});

export const cardDefinitionSchema = z.union([
  troopCardSchema,
  buildingCardSchema,
  areaSpellCardSchema,
  chainSpellCardSchema,
]);

export const balanceSchema = z.object({
  tickRate: z.literal(20),
  initialElixir: z.number().min(0).max(10),
  maxElixir: z.literal(100),
  elixirRegenTicks: z.number().int().positive(),
  centerCaptureTicks: z.number().int().positive(),
  centerBonusBps: z.number().int().min(0).max(10_000),
  doubleElixirTick: z.number().int().positive(),
  attritionTick: z.number().int().positive(),
  castleDamageBpsAfterDouble: z.number().int().min(10_000),
  castleAttritionBpsPerSecond: z.number().int().min(0).max(10_000),
  castleMaxHp: z.number().int().positive(),
});

export const contentCatalogSchema = z.object({
  version: z.string().min(1),
  balance: balanceSchema,
  units: z.array(unitDefinitionSchema).length(5),
  buildings: z.array(buildingDefinitionSchema).length(1),
  cards: z.array(cardDefinitionSchema).length(8),
}).superRefine((catalog, context) => {
  const cardIds = new Set(catalog.cards.map((card) => card.id));
  const archetypeIds = new Set([
    ...catalog.units.map((unit) => unit.id),
    ...catalog.buildings.map((building) => building.id),
  ]);

  for (const id of cardIdSchema.options) {
    if (!cardIds.has(id)) {
      context.addIssue({ code: 'custom', message: `Missing card ${id}` });
    }
  }
  for (const id of archetypeIdSchema.options) {
    if (!archetypeIds.has(id)) {
      context.addIssue({ code: 'custom', message: `Missing archetype ${id}` });
    }
  }
});

export const mapNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['kingdom', 'center']),
  playerId: playerIdSchema.optional(),
  position: vec2Schema,
});

export const laneSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(['outer', 'inner', 'radial']),
  width: z.number().positive(),
  points: z.array(vec2Schema).min(2),
});

export const routeStepSchema = z.object({
  laneId: z.string().min(1),
  reverse: z.boolean(),
});

export const routeSchema = z.object({
  id: z.string().min(1),
  playerId: playerIdSchema,
  kind: z.enum(['direct', 'center']),
  destinationPlayerId: playerIdSchema,
  steps: z.array(routeStepSchema).min(1),
});

export const rawMapGraphSchema = z.object({
  version: z.string().min(1),
  nodes: z.array(mapNodeSchema).length(5),
  lanes: z.array(laneSchema).length(12),
  routes: z.array(routeSchema).length(20),
}).superRefine((graph, context) => {
  const nodes = new Set(graph.nodes.map((node) => node.id));
  const lanes = new Set(graph.lanes.map((lane) => lane.id));
  for (const lane of graph.lanes) {
    if (!nodes.has(lane.from) || !nodes.has(lane.to)) {
      context.addIssue({ code: 'custom', message: `Lane ${lane.id} references an unknown node` });
    }
  }
  for (const route of graph.routes) {
    for (const step of route.steps) {
      if (!lanes.has(step.laneId)) {
        context.addIssue({ code: 'custom', message: `Route ${route.id} references an unknown lane` });
      }
    }
  }
});

export type PlayerId = z.infer<typeof playerIdSchema>;
export type Vec2 = z.infer<typeof vec2Schema>;
export type CardId = z.infer<typeof cardIdSchema>;
export type ArchetypeId = z.infer<typeof archetypeIdSchema>;
export type UnitDefinition = z.infer<typeof unitDefinitionSchema>;
export type BuildingDefinition = z.infer<typeof buildingDefinitionSchema>;
export type CardDefinition = z.infer<typeof cardDefinitionSchema>;
export type ContentCatalog = z.infer<typeof contentCatalogSchema>;
export type MapNode = z.infer<typeof mapNodeSchema>;
export type Lane = z.infer<typeof laneSchema>;
export type RouteStep = z.infer<typeof routeStepSchema>;
export type Route = z.infer<typeof routeSchema>;
export type RawMapGraph = z.infer<typeof rawMapGraphSchema>;
