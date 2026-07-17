/**
 * Canonical owner-to-faction mapping shared by the HUD and every 3D visual.
 * The numeric and CSS forms intentionally live together so they cannot drift.
 */
export const FACTION_STYLES = [
  { owner: 0, id: "north", name: "REINO AZUL", color: 0x3488c9, cssColor: "#3488c9", dark: 0x153c63, accent: 0x9adfff, x: 0, z: -60 },
  { owner: 1, id: "east", name: "DOMINIO CARMESÍ", color: 0xd94e41, cssColor: "#d94e41", dark: 0x67241f, accent: 0xffaaa1, x: 60, z: 0 },
  { owner: 2, id: "south", name: "PACTO ESMERALDA", color: 0x43a962, cssColor: "#43a962", dark: 0x214d2e, accent: 0xa7f2b5, x: 0, z: 60 },
  { owner: 3, id: "west", name: "CORTE VIOLETA", color: 0xa146c3, cssColor: "#a146c3", dark: 0x4d245e, accent: 0xe2a9f5, x: -60, z: 0 },
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
