export type QualityPreset = "low" | "medium" | "high" | "ultra";

export interface CameraTarget {
  x: number;
  y: number;
  z: number;
}

/**
 * Public, renderer-agnostic camera state consumed by React and the minimap.
 * Angles are expressed in radians and distance in world metres.
 */
export interface CameraPose {
  yaw: number;
  pitch: number;
  distance: number;
  target: CameraTarget;
}

export interface RendererResourceProgress {
  /** Normalized [0, 1] progress for textures, procedural rigs and GPU uploads. */
  progress: number;
  label?: string;
}

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
  onResourcesReady?: () => void;
  onResourceProgress?: (progress: RendererResourceProgress) => void;
  onFirstFrame?: () => void;
  onCameraPoseChange?: (pose: CameraPose) => void;
  onCancelSelection?: () => void;
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
