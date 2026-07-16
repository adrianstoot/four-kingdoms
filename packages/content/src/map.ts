import rawMapData from '../data/map.json';
import { RawMapGraphSchema } from './model';
import type { Lane, PlayerId, RawMapGraph, Route, Vec2 } from './model';
import { buildSmoothPath, sampleSmoothPath } from './path';

export interface DeploymentZone {
  id: string;
  playerId: PlayerId;
  laneId: string;
  routeIds: string[];
  startT: number;
  endT: number;
}
export interface TowerPad {
  id: string;
  playerId: PlayerId;
  laneId: string;
  routeIds: string[];
  position: Vec2;
  yaw: number;
}
export interface MapGraph extends RawMapGraph {
  deploymentZones: DeploymentZone[];
  towerPads: TowerPad[];
}

const TOWER_PAD_EDGE_CLEARANCE = 0;

function pointAt(points: readonly Vec2[], t: number): Vec2 {
  return sampleSmoothPath(buildSmoothPath(points), t).position;
}

function buildGraph(raw: RawMapGraph): MapGraph {
  const deploymentZones: DeploymentZone[] = [];
  const towerPads: TowerPad[] = [];
  for (const route of raw.routes) {
    const first = route.steps[0];
    const lane = raw.lanes.find((candidate) => candidate.id === first?.laneId);
    if (!first || !lane) continue;
    const startT = first.reverse ? 0.8 : 0;
    const endT = first.reverse ? 1 : 0.2;
    deploymentZones.push({
      id: `${route.playerId}:${lane.id}`,
      playerId: route.playerId,
      laneId: lane.id,
      routeIds: [route.id],
      startT,
      endT,
    });
    const laneT = first.reverse ? 0.88 : 0.12;
    const centerline = pointAt(lane.points, laneT);
    const ahead = pointAt(lane.points, first.reverse ? laneT - 0.01 : laneT + 0.01);
    const yaw = Math.atan2(ahead.x - centerline.x, ahead.z - centerline.z);
    const normal = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const offset = lane.width * 0.5 + TOWER_PAD_EDGE_CLEARANCE;
    const candidates = [1, -1].map((direction) => ({
      x: centerline.x + normal.x * offset * direction,
      z: centerline.z + normal.z * offset * direction,
    }));
    // Towers sit beyond the outside road edge; on radial ties use a stable side.
    const firstRadius = Math.hypot(candidates[0]!.x, candidates[0]!.z);
    const secondRadius = Math.hypot(candidates[1]!.x, candidates[1]!.z);
    const position = Math.abs(firstRadius - secondRadius) < 1e-6
      ? candidates[route.playerId % 2]!
      : firstRadius > secondRadius ? candidates[0]! : candidates[1]!;
    towerPads.push({
      id: `pad:${route.playerId}:${lane.id}`,
      playerId: route.playerId,
      laneId: lane.id,
      routeIds: [route.id],
      position,
      yaw,
    });
  }
  return { ...raw, deploymentZones, towerPads };
}

export const MAP_GRAPH: MapGraph = buildGraph(RawMapGraphSchema.parse(rawMapData));
export function getLane(laneId: string, graph: MapGraph = MAP_GRAPH): Lane | undefined {
  return graph.lanes.find((lane) => lane.id === laneId);
}
export function getRoute(routeId: string, graph: MapGraph = MAP_GRAPH): Route | undefined {
  return graph.routes.find((route) => route.id === routeId);
}
export function getRoutesForPlayer(playerId: PlayerId, graph: MapGraph = MAP_GRAPH): Route[] {
  return graph.routes.filter((route) => route.playerId === playerId);
}
