/**
 * Canonical owner-to-faction mapping shared by the HUD and every 3D visual.
 * The numeric and CSS forms intentionally live together so they cannot drift.
 */
export const FACTION_STYLES = [
  { owner: 0, id: "north", name: "COLONIA ZAFIRO", color: 0x2d8fd5, cssColor: "#2d8fd5", dark: 0x123d64, accent: 0x8fe9ff, x: 0, z: -60 },
  { owner: 1, id: "east", name: "ENJAMBRE RUBÍ", color: 0xd94a3f, cssColor: "#d94a3f", dark: 0x681d1b, accent: 0xffaa86, x: 60, z: 0 },
  { owner: 2, id: "south", name: "NIDO ESMERALDA", color: 0x38a95b, cssColor: "#38a95b", dark: 0x174b2a, accent: 0x9af0a7, x: 0, z: 60 },
  { owner: 3, id: "west", name: "COLMENA AMATISTA", color: 0x9d4bc5, cssColor: "#9d4bc5", dark: 0x47235c, accent: 0xe7adff, x: -60, z: 0 },
] as const;

export const FACTION_COLORS = [
  FACTION_STYLES[0].color,
  FACTION_STYLES[1].color,
  FACTION_STYLES[2].color,
  FACTION_STYLES[3].color,
] as const;
export const FACTION_CSS_COLORS = [
  FACTION_STYLES[0].cssColor,
  FACTION_STYLES[1].cssColor,
  FACTION_STYLES[2].cssColor,
  FACTION_STYLES[3].cssColor,
] as const;
