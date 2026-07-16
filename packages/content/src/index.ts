import catalogData from '../data/catalog.json';
import { ContentCatalogSchema } from './model';
import type { ArchetypeId, BuildingDefinition, CardDefinition, CardId, UnitDefinition } from './model';

export * from './model';
export * from './path';
export * from './map';

export const CONTENT = ContentCatalogSchema.parse(catalogData);
export const CARDS_BY_ID = Object.fromEntries(
  CONTENT.cards.map((card) => [card.id, card]),
) as Record<CardId, CardDefinition>;
export const ARCHETYPES_BY_ID = Object.fromEntries(
  [...CONTENT.units, ...CONTENT.buildings].map((entry) => [entry.id, entry]),
) as Record<ArchetypeId, UnitDefinition | BuildingDefinition>;
