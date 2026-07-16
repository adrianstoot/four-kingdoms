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
    const position = pointAt(lane.points, laneT);
    const aheadT = first.reverse ? laneT - 0.01 : laneT + 0.01;
    const ahead = pointAt(lane.points, aheadT);
    towerPads.push({
      id: `pad:${route.playerId}:${lane.id}`,
      playerId: route.playerId,
      laneId: lane.id,
      routeIds: [route.id],
      position,
      yaw: Math.atan2(ahead.x - position.x, ahead.z - position.z),
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
