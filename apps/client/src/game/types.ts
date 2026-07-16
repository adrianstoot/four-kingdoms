export type QualityPreset = "low" | "medium" | "high" | "ultra";

export type CardPlacementKind = "unit" | "building" | "spell";

export interface SelectedCard {
  id: string;
  kind?: CardPlacementKind;
  ownerId?: number;
}

export type SelectedCardInput = string | SelectedCard | null;

export interface PlacementPreview {
  cardId: string;
  kind: CardPlacementKind;
  playerId: number;
  x: number;
  z: number;
  laneId: string;
  routeId: string;
  routeT: number;
  direction: 1 | -1;
  valid: boolean;
  reason?: "outside-map" | "outside-lane" | "enemy-zone" | "invalid-pad";
}

export interface WorldRendererMetrics {
  fps: number;
  frameTimeMs: number;
  p95FrameTimeMs: number;
  drawCalls: number;
  triangles: number;
  units: number;
  backend: "webgpu" | "webgl2";
  quality: QualityPreset;
  pixelRatio: number;
}

export interface WorldRendererCallbacks {
  onDeploy?: (placement: PlacementPreview) => void;
  onPlacementChange?: (placement: PlacementPreview | null) => void;
  onMetrics?: (metrics: WorldRendererMetrics) => void;
  onReady?: (backend: "webgpu" | "webgl2") => void;
}

export interface NormalizedUnit {
  id: number;
  owner: number;
  kind: string;
  x: number;
  z: number;
  rotation: number;
  health: number;
  maxHealth: number;
  state: string;
}

export interface NormalizedCastle {
  owner: number;
  health: number;
  maxHealth: number;
  alive: boolean;
}

export interface NormalizedSnapshot {
  tick: number;
  units: NormalizedUnit[];
  unitById: Map<number, NormalizedUnit>;
  castles: NormalizedCastle[];
  centerOwner: number;
  centerProgress: number;
}
