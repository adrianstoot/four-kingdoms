import { describe, expect, it } from 'vitest';
import { MAP_GRAPH } from '@kingdoms/content';
import { buildRoutePaths, createGame, nearestOnRoutePath, sampleRoutePath } from '../src';

describe('smooth deterministic route traversal', () => {
  it('builds continuous directed paths over all twelve painted lanes', () => {
    const paths = buildRoutePaths();
    const laneIds = new Set<string>();
    expect(paths).toHaveLength(20);

    for (const path of paths) {
      const route = MAP_GRAPH.routes.find((candidate) => candidate.id === path.routeId)!;
      expect(path.sections).toHaveLength(route.steps.length);
      expect(path.length).toBeGreaterThan(45);
      for (const section of path.sections) laneIds.add(section.laneId);

      for (let sectionIndex = 1; sectionIndex < path.sections.length; sectionIndex += 1) {
        const transition = path.sections[sectionIndex]!.startDistance;
        const before = sampleRoutePath(path, Math.max(0, transition - 0.01));
        const after = sampleRoutePath(path, Math.min(path.length, transition + 0.01));
        expect(Math.hypot(after.position.x - before.position.x, after.position.z - before.position.z)).toBeLessThan(0.025);
        expect(before.tangent.x * after.tangent.x + before.tangent.z * after.tangent.z).toBeGreaterThan(0.995);
      }
    }

    expect([...laneIds].sort()).toEqual(MAP_GRAPH.lanes.map((lane) => lane.id).sort());
  });

  it('keeps units on the exact centerline of every directed route', () => {
    const paths = buildRoutePaths();
    const visitedLanes = new Set<string>();
    let maximumLateralDistance = 0;

    for (let routeIndex = 0; routeIndex < paths.length; routeIndex += 1) {
      const path = paths[routeIndex]!;
      const game = createGame({ seed: 0x51a7e000 + routeIndex, botPlayers: [], maxEntities: 64 });
      expect(game.spawnDebugRouteGroup(path.routeId, 1)).toBe(1);
      const priorProgress = new Map<number, number>();
      let reachedDestination = false;
      let crossedCenterTransition = path.sections.length === 1;

      for (let tick = 0; tick < 1_600; tick += 1) {
        const snapshot = game.step();
        let minimumProgress = path.length;
        for (let entityIndex = 0; entityIndex < snapshot.entities.count; entityIndex += 1) {
          const position = {
            x: snapshot.entities.x[entityIndex]! / 100,
            z: snapshot.entities.z[entityIndex]! / 100,
          };
          const nearest = nearestOnRoutePath(path, position);
          const entityId = snapshot.entities.id[entityIndex]!;
          visitedLanes.add(nearest.laneId);
          maximumLateralDistance = Math.max(maximumLateralDistance, nearest.lateralDistance);
          minimumProgress = Math.min(minimumProgress, nearest.routeDistance);

          expect(nearest.lateralDistance).toBeLessThanOrEqual(0.03);
          const previous = priorProgress.get(entityId);
          if (previous !== undefined) {
            expect(nearest.routeDistance).toBeGreaterThanOrEqual(previous - 0.2);
            expect(nearest.routeDistance).toBeLessThanOrEqual(previous + 0.35);
          }
          priorProgress.set(entityId, nearest.routeDistance);
          if (path.sections[1] && nearest.routeDistance > path.sections[1].startDistance + 0.5) crossedCenterTransition = true;
        }
        if (minimumProgress >= path.length - 4) {
          reachedDestination = true;
          break;
        }
      }

      expect(reachedDestination, `${path.routeId} did not reach its destination`).toBe(true);
      expect(crossedCenterTransition, `${path.routeId} did not cross its lane transition`).toBe(true);
    }

    expect([...visitedLanes].sort()).toEqual(MAP_GRAPH.lanes.map((lane) => lane.id).sort());
    expect(maximumLateralDistance).toBeLessThanOrEqual(0.03);
  });
});
