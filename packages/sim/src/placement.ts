import {
  MAP_GRAPH,
  buildSmoothPath,
  getLane,
  getRoute,
  getRoutesForPlayer,
  nearestOnSmoothPath,
  sampleSmoothPath,
  type SmoothPath,
} from '@kingdoms/content';
import type { CardId, MapGraph, PlayerId, Vec2 } from '@kingdoms/content';
import type { PlacementResult } from './types';

export interface RoutePathSection {
  laneId: string;
  width: number;
  startDistance: number;
  endDistance: number;
}

export interface RoutePath {
  routeId: string;
  playerId: PlayerId;
  destinationPlayerId: PlayerId;
  kind: 'direct' | 'center';
  points: Vec2[];
  tangents: Vec2[];
  cumulative: number[];
  sections: RoutePathSection[];
  length: number;
  centerDistance: number;
}

export interface RoutePathSample {
  position: Vec2;
  tangent: Vec2;
  yaw: number;
  routeDistance: number;
  laneId: string;
  laneWidth: number;
}

export interface RoutePathNearest extends RoutePathSample {
  lateralDistance: number;
}

const smoothPathCache = new WeakMap<readonly Vec2[], SmoothPath>();

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothPathFor(points: readonly Vec2[]): SmoothPath {
  const cached = smoothPathCache.get(points);
  if (cached) return cached;
  const path = buildSmoothPath(points);
  smoothPathCache.set(points, path);
  return path;
}

/** Retained for callers that need the literal control-polygon length. */
export function polylineLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (from && to) total += Math.hypot(to.x - from.x, to.z - from.z);
  }
  return total;
}

/** Samples the same smooth road centerline used by the renderer. */
export function pointOnPolyline(points: readonly Vec2[], normalizedT: number): { position: Vec2; yaw: number; distance: number } {
  const sample = sampleSmoothPath(smoothPathFor(points), normalizedT);
  return { position: sample.position, yaw: sample.yaw, distance: sample.distance };
}

function nearestOnPolyline(points: readonly Vec2[], desired: Vec2): { position: Vec2; yaw: number; t: number; distance: number } {
  const nearest = nearestOnSmoothPath(smoothPathFor(points), desired);
  return {
    position: nearest.position,
    yaw: nearest.yaw,
    t: nearest.t,
    distance: nearest.lateralDistance,
  };
}

export function findPlacement(
  playerId: PlayerId,
  cardId: CardId,
  routeId: string,
  desired: Vec2,
  graph: MapGraph = MAP_GRAPH,
): PlacementResult {
  if (playerId < 0 || playerId > 3) {
    return { valid: false, position: desired, yaw: 0, pathDistance: 0, routeDistance: 0, reason: 'invalid-player' };
  }
  const route = getRoute(routeId, graph);
  if (!route) return { valid: false, position: desired, yaw: 0, pathDistance: 0, routeDistance: 0, routeId, reason: 'invalid-route' };
  if (route.playerId !== playerId) {
    return { valid: false, position: desired, yaw: 0, pathDistance: 0, routeDistance: 0, routeId, reason: 'wrong-owner' };
  }
  const first = route.steps[0];
  const lane = first ? getLane(first.laneId, graph) : undefined;
  if (!first || !lane) return { valid: false, position: desired, yaw: 0, pathDistance: 0, routeDistance: 0, routeId, reason: 'invalid-route' };
  const lanePath = smoothPathFor(lane.points);

  if (cardId === 'cannon_tower') {
    const pads = graph.towerPads.filter((pad) => pad.playerId === playerId && pad.routeIds.includes(routeId));
    let closest = pads[0];
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const pad of pads) {
      const distance = Math.hypot(desired.x - pad.position.x, desired.z - pad.position.z);
      if (distance < closestDistance) { closest = pad; closestDistance = distance; }
    }
    if (!closest || closestDistance > 5) {
      return {
        valid: false,
        position: closest?.position ?? desired,
        yaw: closest?.yaw ?? 0,
        pathDistance: 0,
        routeDistance: 0,
        routeId,
        laneId: lane.id,
        padId: closest?.id,
        reason: 'no-tower-pad',
      };
    }
    const nearest = nearestOnSmoothPath(lanePath, closest.position);
    const pathDistance = first.reverse ? lanePath.length - nearest.distance : nearest.distance;
    return { valid: true, position: closest.position, yaw: closest.yaw, pathDistance, routeDistance: pathDistance, routeId, laneId: lane.id, padId: closest.id };
  }

  const zone = graph.deploymentZones.find((candidate) => candidate.playerId === playerId && candidate.routeIds.includes(routeId));
  if (!zone) return { valid: false, position: desired, yaw: 0, pathDistance: 0, routeDistance: 0, routeId, reason: 'invalid-route' };
  const nearest = nearestOnSmoothPath(lanePath, desired);
  const minimum = Math.min(zone.startT, zone.endT);
  const maximum = Math.max(zone.startT, zone.endT);
  const clampedT = clamp(nearest.t, minimum, maximum);
  const snapped = sampleSmoothPath(lanePath, clampedT);
  const distanceToZone = Math.hypot(desired.x - snapped.position.x, desired.z - snapped.position.z);
  const withinT = nearest.t >= minimum - 0.001 && nearest.t <= maximum + 0.001;
  const closeEnough = distanceToZone <= lane.width * 0.8;
  return {
    valid: withinT && closeEnough,
    position: snapped.position,
    yaw: first.reverse ? snapped.yaw + Math.PI : snapped.yaw,
    pathDistance: first.reverse ? lanePath.length - snapped.distance : snapped.distance,
    routeDistance: first.reverse ? lanePath.length - snapped.distance : snapped.distance,
    routeId,
    laneId: lane.id,
    reason: withinT ? (closeEnough ? undefined : 'too-far-from-lane') : 'outside-deployment-zone',
  };
}

export interface BestPlacementOptions {
  /** Keeps the current lane selected until another lane is meaningfully closer. */
  preferredRouteId?: string;
  hysteresisMeters?: number;
  graph?: MapGraph;
}

/**
 * Finds the most natural click placement without requiring the caller to pick a
 * route first. Troops inspect the player's five deployment zones; towers inspect
 * the five lateral pads. The optional preferred route prevents cursor flicker at
 * castle junctions where several centerlines overlap.
 */
export function findBestPlacement(
  playerId: PlayerId,
  cardId: CardId,
  desired: Vec2,
  options: BestPlacementOptions = {},
): PlacementResult {
  const graph = options.graph ?? MAP_GRAPH;
  const hysteresis = Math.max(0, options.hysteresisMeters ?? 0.75);
  if (playerId < 0 || playerId > 3) {
    return { valid: false, position: desired, yaw: 0, pathDistance: 0, routeDistance: 0, reason: 'invalid-player' };
  }

  if (cardId === 'fireball' || cardId === 'chain_lightning') {
    const spell = findSpellPlacement(desired, graph);
    const candidates = buildRoutePaths(graph).map((path) => ({
      path,
      nearest: nearestOnRoutePath(path, desired),
    })).sort((left, right) => (
      left.nearest.lateralDistance - right.nearest.lateralDistance
      || left.path.routeId.localeCompare(right.path.routeId)
    ));
    let selected = candidates[0];
    const preferred = candidates.find((candidate) => candidate.path.routeId === options.preferredRouteId);
    if (selected && preferred && preferred.nearest.lateralDistance <= selected.nearest.lateralDistance + hysteresis) {
      selected = preferred;
    }
    if (!selected) {
      return { valid: false, position: desired, yaw: 0, pathDistance: 0, routeDistance: 0, reason: 'no-placement-zone' };
    }
    return {
      valid: spell.valid,
      position: spell.position,
      yaw: selected.nearest.yaw,
      pathDistance: selected.nearest.routeDistance,
      routeDistance: selected.nearest.routeDistance,
      routeId: selected.path.routeId,
      laneId: selected.nearest.laneId,
      reason: spell.valid ? undefined : 'too-far-from-lane',
    };
  }

  const candidates = getRoutesForPlayer(playerId, graph).map((route) => {
    const placement = findPlacement(playerId, cardId, route.id, desired, graph);
    return {
      placement,
      distance: Math.hypot(desired.x - placement.position.x, desired.z - placement.position.z),
    };
  });
  const valid = candidates.filter((candidate) => candidate.placement.valid);
  const pool = valid.length > 0 ? valid : candidates;
  pool.sort((left, right) => (
    left.distance - right.distance
    || (left.placement.routeId ?? '').localeCompare(right.placement.routeId ?? '')
  ));
  let selected = pool[0];
  const preferred = pool.find((candidate) => candidate.placement.routeId === options.preferredRouteId);
  if (selected && preferred && preferred.distance <= selected.distance + hysteresis) selected = preferred;
  return selected?.placement ?? {
    valid: false,
    position: desired,
    yaw: 0,
    pathDistance: 0,
    routeDistance: 0,
    reason: 'no-placement-zone',
  };
}

export function findSpellPlacement(desired: Vec2, graph: MapGraph = MAP_GRAPH): { valid: boolean; position: Vec2 } {
  let closestDistance = Number.POSITIVE_INFINITY;
  let closest = desired;
  for (const lane of graph.lanes) {
    const result = nearestOnSmoothPath(smoothPathFor(lane.points), desired);
    if (result.lateralDistance < closestDistance) {
      closestDistance = result.lateralDistance;
      closest = result.position;
    }
  }
  return { valid: closestDistance <= 9, position: closest };
}

export function buildRoutePaths(graph: MapGraph = MAP_GRAPH): RoutePath[] {
  const lanes = new Map(graph.lanes.map((lane) => [lane.id, { lane, path: smoothPathFor(lane.points) }]));
  return graph.routes.map((route) => {
    const points: Vec2[] = [];
    const tangents: Vec2[] = [];
    const cumulative: number[] = [];
    const sections: RoutePathSection[] = [];
    let centerDistance = 0;
    for (let stepIndex = 0; stepIndex < route.steps.length; stepIndex += 1) {
      const step = route.steps[stepIndex];
      const laneEntry = step ? lanes.get(step.laneId) : undefined;
      if (!step || !laneEntry) continue;
      const stepPoints = step.reverse ? [...laneEntry.path.points].reverse() : [...laneEntry.path.points];
      const stepTangents = step.reverse
        ? [...laneEntry.path.tangents].reverse().map((tangent) => ({ x: -tangent.x, z: -tangent.z }))
        : [...laneEntry.path.tangents];
      const sectionStart = cumulative.at(-1) ?? 0;
      if (points.length > 0) {
        stepPoints.shift();
        stepTangents.shift();
      }
      for (let index = 0; index < stepPoints.length; index += 1) {
        const point = stepPoints[index]!;
        const prior = points.at(-1);
        points.push(point);
        tangents.push(stepTangents[index] ?? stepTangents.at(-1) ?? { x: 0, z: 1 });
        cumulative.push((cumulative.at(-1) ?? 0) + (prior ? Math.hypot(point.x - prior.x, point.z - prior.z) : 0));
      }
      const sectionEnd = cumulative.at(-1) ?? sectionStart;
      sections.push({ laneId: laneEntry.lane.id, width: laneEntry.lane.width, startDistance: sectionStart, endDistance: sectionEnd });
      if (route.kind === 'center' && stepIndex === 0) centerDistance = sectionEnd;
    }
    return {
      routeId: route.id,
      playerId: route.playerId,
      destinationPlayerId: route.destinationPlayerId,
      kind: route.kind,
      points,
      tangents,
      cumulative,
      sections,
      length: cumulative.at(-1) ?? 0,
      centerDistance,
    };
  });
}

function segmentForDistance(cumulative: readonly number[], distance: number): number {
  if (cumulative.length <= 1) return 0;
  let low = 1;
  let high = cumulative.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((cumulative[middle] ?? 0) < distance) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function routeSectionAt(path: RoutePath, distance: number): RoutePathSection {
  const clamped = clamp(distance, 0, path.length);
  return path.sections.find((section) => clamped <= section.endDistance + 1e-6)
    ?? path.sections.at(-1)
    ?? { laneId: '', width: 0, startDistance: 0, endDistance: path.length };
}

export function sampleRoutePath(path: RoutePath, distance: number): RoutePathSample {
  const clamped = clamp(distance, 0, path.length);
  const index = segmentForDistance(path.cumulative, clamped);
  const priorIndex = Math.max(0, index - 1);
  const from = path.points[priorIndex] ?? { x: 0, z: 0 };
  const to = path.points[index] ?? from;
  const start = path.cumulative[priorIndex] ?? 0;
  const end = path.cumulative[index] ?? start;
  const local = end === start ? 0 : (clamped - start) / (end - start);
  const fromTangent = path.tangents[priorIndex] ?? { x: 0, z: 1 };
  const toTangent = path.tangents[index] ?? fromTangent;
  const tangentX = fromTangent.x + (toTangent.x - fromTangent.x) * local;
  const tangentZ = fromTangent.z + (toTangent.z - fromTangent.z) * local;
  const tangentLength = Math.hypot(tangentX, tangentZ) || 1;
  const tangent = { x: tangentX / tangentLength, z: tangentZ / tangentLength };
  const section = routeSectionAt(path, clamped);
  return {
    position: { x: from.x + (to.x - from.x) * local, z: from.z + (to.z - from.z) * local },
    tangent,
    yaw: Math.atan2(tangent.x, tangent.z),
    routeDistance: clamped,
    laneId: section.laneId,
    laneWidth: section.width,
  };
}

export function nearestOnRoutePath(
  path: RoutePath,
  desired: Vec2,
  minimumDistance = 0,
  maximumDistance = path.length,
): RoutePathNearest {
  const minimum = clamp(Math.min(minimumDistance, maximumDistance), 0, path.length);
  const maximum = clamp(Math.max(minimumDistance, maximumDistance), 0, path.length);
  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  let bestRouteDistance = minimum;
  let bestPosition = sampleRoutePath(path, minimum).position;
  for (let index = 1; index < path.points.length; index += 1) {
    const segmentStart = path.cumulative[index - 1] ?? 0;
    const segmentEnd = path.cumulative[index] ?? segmentStart;
    if (segmentEnd < minimum || segmentStart > maximum) continue;
    const from = path.points[index - 1]!;
    const to = path.points[index]!;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const squaredLength = dx * dx + dz * dz;
    const segmentLength = segmentEnd - segmentStart;
    const localMinimum = segmentLength === 0 ? 0 : clamp((minimum - segmentStart) / segmentLength, 0, 1);
    const localMaximum = segmentLength === 0 ? 1 : clamp((maximum - segmentStart) / segmentLength, 0, 1);
    const projected = squaredLength === 0 ? 0 : ((desired.x - from.x) * dx + (desired.z - from.z) * dz) / squaredLength;
    const local = clamp(projected, localMinimum, localMaximum);
    const position = { x: from.x + dx * local, z: from.z + dz * local };
    const distanceSquared = (desired.x - position.x) ** 2 + (desired.z - position.z) ** 2;
    const routeDistance = segmentStart + segmentLength * local;
    if (distanceSquared < bestDistanceSquared || (distanceSquared === bestDistanceSquared && routeDistance < bestRouteDistance)) {
      bestDistanceSquared = distanceSquared;
      bestRouteDistance = routeDistance;
      bestPosition = position;
    }
  }
  const sample = sampleRoutePath(path, bestRouteDistance);
  return { ...sample, position: bestPosition, lateralDistance: Math.sqrt(bestDistanceSquared) };
}

/** Maximum centerline offset that keeps the complete unit inside the painted road. */
export function laneCenterClearance(laneWidth: number, unitRadius: number): number {
  return Math.max(0, laneWidth * 0.5 - unitRadius - 0.22);
}
