import { z } from 'zod';

export const PlayerIdSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export const Vec2Schema = z.object({ x: z.number().finite(), z: z.number().finite() });
export const CardIdSchema = z.enum([
  'guards', 'archers', 'knight', 'giant', 'commander', 'cannon_tower', 'fireball', 'chain_lightning',
]);
export const ArchetypeIdSchema = z.enum([
  'guard', 'archer', 'knight', 'giant', 'commander', 'cannon_tower',
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

export const UnitDefinitionSchema = combatStatsSchema.extend({
  id: z.enum(['guard', 'archer', 'knight', 'giant', 'commander']),
  kind: z.literal('unit'),
  moveSpeed: z.number().positive(),
  hero: z.boolean(),
});

export const BuildingDefinitionSchema = combatStatsSchema.extend({
  id: z.literal('cannon_tower'),
  kind: z.literal('building'),
  lifetimeTicks: z.number().int().positive(),
});

const troopCardSchema = z.object({
  id: z.enum(['guards', 'archers', 'knight', 'giant', 'commander']),
  kind: z.literal('troop'),
  cost: z.number().int().min(0).max(10),
  archetypeId: z.enum(['guard', 'archer', 'knight', 'giant', 'commander']),
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
export const CardDefinitionSchema = z.union([
  troopCardSchema, buildingCardSchema, areaSpellCardSchema, chainSpellCardSchema,
]);

export const ContentCatalogSchema = z.object({
  version: z.string().min(1),
  balance: z.object({
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
  }),
  units: z.array(UnitDefinitionSchema).length(5),
  buildings: z.array(BuildingDefinitionSchema).length(1),
  cards: z.array(CardDefinitionSchema).length(8),
}).superRefine((catalog, context) => {
  const cards = new Set(catalog.cards.map((card) => card.id));
  const archetypes = new Set([...catalog.units, ...catalog.buildings].map((entry) => entry.id));
  for (const id of CardIdSchema.options) {
    if (!cards.has(id)) context.addIssue({ code: 'custom', message: `Missing card ${id}` });
  }
  for (const id of ArchetypeIdSchema.options) {
    if (!archetypes.has(id)) context.addIssue({ code: 'custom', message: `Missing archetype ${id}` });
  }
});

export const MapNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['kingdom', 'center']),
  playerId: PlayerIdSchema.optional(),
  position: Vec2Schema,
});
export const LaneSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(['outer', 'inner', 'radial']),
  width: z.number().positive(),
  points: z.array(Vec2Schema).min(2),
});
export const RouteStepSchema = z.object({ laneId: z.string().min(1), reverse: z.boolean() });
export const RouteSchema = z.object({
  id: z.string().min(1),
  playerId: PlayerIdSchema,
  kind: z.enum(['direct', 'center']),
  destinationPlayerId: PlayerIdSchema,
  steps: z.array(RouteStepSchema).min(1),
});
export const RawMapGraphSchema = z.object({
  version: z.string().min(1),
  nodes: z.array(MapNodeSchema).length(5),
  lanes: z.array(LaneSchema).length(12),
  routes: z.array(RouteSchema).length(20),
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

export type PlayerId = z.infer<typeof PlayerIdSchema>;
export type Vec2 = z.infer<typeof Vec2Schema>;
export type CardId = z.infer<typeof CardIdSchema>;
export type ArchetypeId = z.infer<typeof ArchetypeIdSchema>;
export type UnitDefinition = z.infer<typeof UnitDefinitionSchema>;
export type BuildingDefinition = z.infer<typeof BuildingDefinitionSchema>;
export type CardDefinition = z.infer<typeof CardDefinitionSchema>;
export type ContentCatalog = z.infer<typeof ContentCatalogSchema>;
export type MapNode = z.infer<typeof MapNodeSchema>;
export type Lane = z.infer<typeof LaneSchema>;
export type RouteStep = z.infer<typeof RouteStepSchema>;
export type Route = z.infer<typeof RouteSchema>;
export type RawMapGraph = z.infer<typeof RawMapGraphSchema>;
