import type { Vec2 } from './model';

const ARC_LENGTH_DIVISIONS = 200;
export const ROAD_CURVE_SEGMENTS = 96;

export interface SmoothPath {
  points: Vec2[];
  tangents: Vec2[];
  cumulative: number[];
  length: number;
}

export interface SmoothPathSample {
  position: Vec2;
  tangent: Vec2;
  yaw: number;
  distance: number;
}

export interface SmoothPathNearest extends SmoothPathSample {
  t: number;
  lateralDistance: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function extrapolate(from: Vec2, awayFrom: Vec2): Vec2 {
  return { x: from.x * 2 - awayFrom.x, z: from.z * 2 - awayFrom.z };
}

function hermite(start: number, end: number, startTangent: number, endTangent: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return start
    + startTangent * t
    + (-3 * start + 3 * end - 2 * startTangent - endTangent) * t2
    + (2 * start - 2 * end + startTangent + endTangent) * t3;
}

function nonUniformAxis(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  dt0: number,
  dt1: number,
  dt2: number,
  t: number,
): number {
  let tangent1 = (p1 - p0) / dt0 - (p2 - p0) / (dt0 + dt1) + (p2 - p1) / dt1;
  let tangent2 = (p2 - p1) / dt1 - (p3 - p1) / (dt1 + dt2) + (p3 - p2) / dt2;
  tangent1 *= dt1;
  tangent2 *= dt1;
  return hermite(p1, p2, tangent1, tangent2, t);
}

/** Matches the open, centripetal Catmull-Rom curve used to render roads. */
export function pointOnRoadCurve(controlPoints: readonly Vec2[], normalizedT: number): Vec2 {
  const count = controlPoints.length;
  if (count === 0) return { x: 0, z: 0 };
  if (count === 1) return { ...controlPoints[0]! };

  const scaled = clamp(normalizedT, 0, 1) * (count - 1);
  let segment = Math.floor(scaled);
  let local = scaled - segment;
  if (local === 0 && segment === count - 1) {
    segment = count - 2;
    local = 1;
  }

  const p1 = controlPoints[segment]!;
  const p2 = controlPoints[segment + 1]!;
  const p0 = segment > 0 ? controlPoints[segment - 1]! : extrapolate(p1, p2);
  const p3 = segment + 2 < count ? controlPoints[segment + 2]! : extrapolate(p2, p1);
  let dt0 = ((p1.x - p0.x) ** 2 + (p1.z - p0.z) ** 2) ** 0.25;
  let dt1 = ((p2.x - p1.x) ** 2 + (p2.z - p1.z) ** 2) ** 0.25;
  let dt2 = ((p3.x - p2.x) ** 2 + (p3.z - p2.z) ** 2) ** 0.25;
  if (dt1 < 1e-4) dt1 = 1;
  if (dt0 < 1e-4) dt0 = dt1;
  if (dt2 < 1e-4) dt2 = dt1;
  return {
    x: nonUniformAxis(p0.x, p1.x, p2.x, p3.x, dt0, dt1, dt2, local),
    z: nonUniformAxis(p0.z, p1.z, p2.z, p3.z, dt0, dt1, dt2, local),
  };
}

function arcParameterAt(arcLengths: readonly number[], targetDistance: number): number {
  const maximumIndex = arcLengths.length - 1;
  if (maximumIndex <= 0) return 0;
  const total = arcLengths[maximumIndex] ?? 0;
  const target = clamp(targetDistance, 0, total);
  let low = 0;
  let high = maximumIndex;
  while (low <= high) {
    const middle = Math.floor(low + (high - low) / 2);
    const value = arcLengths[middle] ?? 0;
    if (value < target) low = middle + 1;
    else if (value > target) high = middle - 1;
    else return middle / maximumIndex;
  }
  const beforeIndex = Math.max(0, high);
  const afterIndex = Math.min(maximumIndex, beforeIndex + 1);
  const before = arcLengths[beforeIndex] ?? 0;
  const after = arcLengths[afterIndex] ?? before;
  const fraction = after === before ? 0 : (target - before) / (after - before);
  return (beforeIndex + fraction) / maximumIndex;
}

function tangentOnRoadCurve(controlPoints: readonly Vec2[], t: number): Vec2 {
  const delta = 0.0001;
  const from = pointOnRoadCurve(controlPoints, Math.max(0, t - delta));
  const to = pointOnRoadCurve(controlPoints, Math.min(1, t + delta));
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz) || 1;
  return { x: dx / length, z: dz / length };
}

export function buildSmoothPath(
  controlPoints: readonly Vec2[],
  segments: number = ROAD_CURVE_SEGMENTS,
): SmoothPath {
  const safeSegments = Math.max(1, Math.floor(segments));
  const arcLengths = [0];
  let previous = pointOnRoadCurve(controlPoints, 0);
  for (let index = 1; index <= ARC_LENGTH_DIVISIONS; index += 1) {
    const current = pointOnRoadCurve(controlPoints, index / ARC_LENGTH_DIVISIONS);
    arcLengths.push((arcLengths.at(-1) ?? 0) + Math.hypot(current.x - previous.x, current.z - previous.z));
    previous = current;
  }
  const arcLength = arcLengths.at(-1) ?? 0;
  const points: Vec2[] = [];
  const tangents: Vec2[] = [];
  const cumulative = [0];
  for (let index = 0; index <= safeSegments; index += 1) {
    const curveT = arcParameterAt(arcLengths, arcLength * index / safeSegments);
    const point = pointOnRoadCurve(controlPoints, curveT);
    points.push(point);
    tangents.push(tangentOnRoadCurve(controlPoints, curveT));
    if (index > 0) {
      const prior = points[index - 1]!;
      cumulative.push((cumulative.at(-1) ?? 0) + Math.hypot(point.x - prior.x, point.z - prior.z));
    }
  }
  return { points, tangents, cumulative, length: cumulative.at(-1) ?? 0 };
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

export function sampleSmoothPath(path: SmoothPath, normalizedT: number): SmoothPathSample {
  const distance = clamp(normalizedT, 0, 1) * path.length;
  const index = segmentForDistance(path.cumulative, distance);
  const from = path.points[Math.max(0, index - 1)] ?? { x: 0, z: 0 };
  const to = path.points[index] ?? from;
  const start = path.cumulative[Math.max(0, index - 1)] ?? 0;
  const end = path.cumulative[index] ?? start;
  const local = end === start ? 0 : (distance - start) / (end - start);
  const fromTangent = path.tangents[Math.max(0, index - 1)] ?? { x: 0, z: 1 };
  const toTangent = path.tangents[index] ?? fromTangent;
  const tangentX = fromTangent.x + (toTangent.x - fromTangent.x) * local;
  const tangentZ = fromTangent.z + (toTangent.z - fromTangent.z) * local;
  const tangentLength = Math.hypot(tangentX, tangentZ) || 1;
  const tangent = { x: tangentX / tangentLength, z: tangentZ / tangentLength };
  return {
    position: { x: from.x + (to.x - from.x) * local, z: from.z + (to.z - from.z) * local },
    tangent,
    yaw: Math.atan2(tangent.x, tangent.z),
    distance,
  };
}

export function nearestOnSmoothPath(path: SmoothPath, desired: Vec2): SmoothPathNearest {
  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  let bestPathDistance = 0;
  let bestPosition = { ...(path.points[0] ?? { x: 0, z: 0 }) };
  for (let index = 1; index < path.points.length; index += 1) {
    const from = path.points[index - 1]!;
    const to = path.points[index]!;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const squaredLength = dx * dx + dz * dz;
    const local = squaredLength === 0 ? 0 : clamp(
      ((desired.x - from.x) * dx + (desired.z - from.z) * dz) / squaredLength,
      0,
      1,
    );
    const position = { x: from.x + dx * local, z: from.z + dz * local };
    const distanceSquared = (desired.x - position.x) ** 2 + (desired.z - position.z) ** 2;
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      const start = path.cumulative[index - 1] ?? 0;
      const end = path.cumulative[index] ?? start;
      bestPathDistance = start + (end - start) * local;
      bestPosition = position;
    }
  }
  const sample = sampleSmoothPath(path, path.length === 0 ? 0 : bestPathDistance / path.length);
  return {
    ...sample,
    position: bestPosition,
    distance: bestPathDistance,
    t: path.length === 0 ? 0 : bestPathDistance / path.length,
    lateralDistance: Math.sqrt(bestDistanceSquared),
  };
}
