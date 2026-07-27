import { describe, expect, it } from 'vitest';
import {
  ARCHETYPES_BY_ID,
  MAP_GRAPH,
  buildRoutePaths,
  createGame,
  nearestOnRoutePath,
  sampleRoutePath,
  type ArchetypeId,
  type GameSnapshot,
} from '../src';

const paths = new Map(buildRoutePaths().map((path) => [path.routeId, path]));

function entityIndex(snapshot: GameSnapshot, entityId: number): number {
  return [...snapshot.entities.id].indexOf(entityId);
}

function worldPosition(snapshot: GameSnapshot, entityId: number) {
  const index = entityIndex(snapshot, entityId);
  expect(index).toBeGreaterThanOrEqual(0);
  return {
    x: snapshot.entities.x[index]! / 100,
    z: snapshot.entities.z[index]! / 100,
  };
}

function entityHealth(snapshot: GameSnapshot, entityId: number): number {
  const index = entityIndex(snapshot, entityId);
  expect(index).toBeGreaterThanOrEqual(0);
  return snapshot.entities.hp[index]!;
}

function spawnOpposed(
  routeA: string,
  archetypeA: ArchetypeId,
  routeB: string,
  archetypeB: ArchetypeId,
  separation = 10,
) {
  const pathA = paths.get(routeA)!;
  const pathB = paths.get(routeB)!;
  const game = createGame({ seed: 0xc04ba7, botPlayers: [], maxEntities: 64 });
  const idA = game.spawnDebugCombatant(routeA, archetypeA, pathA.length * 0.5 - separation * 0.5);
  const idB = game.spawnDebugCombatant(routeB, archetypeB, pathB.length * 0.5 - separation * 0.5);
  expect(idA).toBeGreaterThan(0);
  expect(idB).toBeGreaterThan(0);
  return { game, idA, idB, pathA, pathB };
}

describe('deterministic lane-bound combat', () => {
  it('lands every repeated strike on the same anticipation phase without resetting the animation clock', () => {
    const route = paths.get('p0_inner_e')!;
    const guard = ARCHETYPES_BY_ID.guard;
    const game = createGame({ seed: 0xa77ac, botPlayers: [], maxEntities: 16 });
    const guardId = game.spawnDebugCombatant(
      route.routeId,
      'guard',
      route.length - guard.attackRange - 2.4 + 0.05,
    );
    const hitTicks: number[] = [];
    const contactStateTicks: number[] = [];
    const contactMotionPhases: number[] = [];

    for (let tick = 0; tick < 100 && hitTicks.length < 3; tick += 1) {
      const snapshot = game.step();
      const hit = snapshot.events.find((event) => (
        event.type === 'damage'
        && event.sourceId === guardId
        && event.targetType === 'castle'
        && event.targetId === route.destinationPlayerId
      ));
      if (!hit) continue;
      const guardIndex = entityIndex(snapshot, guardId);
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      hitTicks.push(snapshot.tick);
      contactStateTicks.push(snapshot.entities.stateTick[guardIndex]!);
      contactMotionPhases.push(snapshot.entities.motionPhase[guardIndex]!);
    }

    expect(hitTicks).toHaveLength(3);
    expect(hitTicks.slice(1).map((tick, index) => tick - hitTicks[index]!)).toEqual([
      guard.attackCooldownTicks,
      guard.attackCooldownTicks,
    ]);
    expect(contactStateTicks.map((tick) => tick % guard.attackCooldownTicks)).toEqual([
      guard.attackAnticipationTicks,
      guard.attackAnticipationTicks,
      guard.attackAnticipationTicks,
    ]);
    const expectedPhase = Math.round(
      guard.attackAnticipationTicks / guard.attackCooldownTicks * 65_535,
    );
    expect(contactMotionPhases).toEqual([expectedPhase, expectedPhase, expectedPhase]);
  });

  it('engages on every outer and inner lane without leaving or passing through the centerline', () => {
    const opposedRoutes: [string, string][] = [
      ['p0_outer_e', 'p1_outer_n'],
      ['p1_outer_s', 'p2_outer_e'],
      ['p2_outer_w', 'p3_outer_s'],
      ['p3_outer_n', 'p0_outer_w'],
      ['p0_inner_e', 'p1_inner_n'],
      ['p1_inner_s', 'p2_inner_e'],
      ['p2_inner_w', 'p3_inner_s'],
      ['p3_inner_n', 'p0_inner_w'],
    ];

    for (const [routeA, routeB] of opposedRoutes) {
      const { game, idA, idB, pathA, pathB } = spawnOpposed(routeA, 'guard', routeB, 'guard');
      let sawDamage = false;
      let sawDeath = false;
      for (let tick = 0; tick < 260 && !sawDamage; tick += 1) {
        const snapshot = game.step();
        const indexA = entityIndex(snapshot, idA);
        const indexB = entityIndex(snapshot, idB);
        if (indexA >= 0) {
          const nearest = nearestOnRoutePath(pathA, worldPosition(snapshot, idA));
          expect(nearest.lateralDistance, `${routeA} left its lane`).toBeLessThanOrEqual(0.03);
        }
        if (indexB >= 0) {
          const nearest = nearestOnRoutePath(pathB, worldPosition(snapshot, idB));
          expect(nearest.lateralDistance, `${routeB} left its lane`).toBeLessThanOrEqual(0.03);
        }

        if (indexA >= 0 && indexB >= 0 && !sawDeath) {
          const progressA = nearestOnRoutePath(pathA, worldPosition(snapshot, idA)).routeDistance;
          const bOnA = nearestOnRoutePath(pathA, worldPosition(snapshot, idB)).routeDistance;
          expect(progressA, `${routeA} passed through ${routeB}`).toBeLessThanOrEqual(bOnA + 0.03);
        }
        sawDeath ||= snapshot.events.some((event) => event.type === 'death');
        sawDamage ||= snapshot.events.some((event) => (
          event.type === 'damage'
          && event.targetType === 'entity'
          && ((event.sourceId === idA && event.targetId === idB) || (event.sourceId === idB && event.targetId === idA))
        ));
      }
      expect(sawDamage, `${routeA} and ${routeB} ignored each other`).toBe(true);
    }
  });

  it('intercepts and fights perpendicular enemies at the neutral center', () => {
    const pathNorth = paths.get('p0_center')!;
    const pathEast = paths.get('p1_center')!;
    const game = createGame({ seed: 0xce47e2, botPlayers: [], maxEntities: 64 });
    const northId = game.spawnDebugCombatant('p0_center', 'guard', pathNorth.centerDistance - 5);
    const eastId = game.spawnDebugCombatant('p1_center', 'guard', pathEast.centerDistance - 5);
    const attackers = new Set<number>();
    let firstContactRadius = Number.POSITIVE_INFINITY;
    const previousYaw = new Map<number, number>();
    const shortestAngle = (from: number, to: number) => {
      const fullTurn = Math.PI * 2;
      const wrapped = (to - from + Math.PI) % fullTurn;
      return Math.abs((wrapped < 0 ? wrapped + fullTurn : wrapped) - Math.PI);
    };

    for (let tick = 0; tick < 240 && attackers.size < 2; tick += 1) {
      const snapshot = game.step();
      for (const entityId of [northId, eastId]) {
        const index = entityIndex(snapshot, entityId);
        if (index < 0) continue;
        const yaw = snapshot.entities.yaw[index]! / 65_535 * Math.PI * 2;
        const prior = previousYaw.get(entityId);
        if (prior !== undefined && snapshot.entities.targetId[index]! >= 0) {
          expect(shortestAngle(prior, yaw)).toBeLessThanOrEqual(Math.PI / 8 + 0.002);
        }
        previousYaw.set(entityId, yaw);
      }
      for (const event of snapshot.events) {
        if (
          event.type !== 'damage'
          || event.targetType !== 'entity'
          || ![northId, eastId].includes(event.sourceId)
          || ![northId, eastId].includes(event.targetId)
        ) continue;
        attackers.add(event.sourceId);
        const source = worldPosition(snapshot, event.sourceId);
        const target = worldPosition(snapshot, event.targetId);
        const sourceIndex = entityIndex(snapshot, event.sourceId);
        const sourceYaw = snapshot.entities.yaw[sourceIndex]! / 65_535 * Math.PI * 2;
        const targetYaw = Math.atan2(target.x - source.x, target.z - source.z);
        expect(shortestAngle(sourceYaw, targetYaw)).toBeLessThanOrEqual(Math.PI / 9 + 0.025);
        firstContactRadius = Math.min(firstContactRadius, Math.hypot(source.x, source.z));
      }
    }

    expect(attackers).toEqual(new Set([northId, eastId]));
    expect(firstContactRadius).toBeLessThan(2);
  });

  it('commits mirrored lethal melee exchanges simultaneously, independent of spawn order', () => {
    const runMirror = (reverse: boolean) => {
      const north = paths.get('p0_center')!;
      const east = paths.get('p1_center')!;
      const game = createGame({ seed: 0x51aa17, botPlayers: [], maxEntities: 64 });
      const spawned = reverse
        ? [
            game.spawnDebugCombatant('p1_center', 'guard', east.centerDistance - 1),
            game.spawnDebugCombatant('p0_center', 'guard', north.centerDistance - 1),
          ]
        : [
            game.spawnDebugCombatant('p0_center', 'guard', north.centerDistance - 1),
            game.spawnDebugCombatant('p1_center', 'guard', east.centerDistance - 1),
          ];
      const idByOwner = reverse
        ? new Map([[0, spawned[1]!], [1, spawned[0]!]])
        : new Map([[0, spawned[0]!], [1, spawned[1]!]]);
      for (let tick = 0; tick < 320; tick += 1) {
        const snapshot = game.step();
        const deaths = snapshot.events.filter((event) => event.type === 'death');
        if (deaths.length === 0) continue;
        const finalAttackers = new Set<number>();
        for (const event of snapshot.events) {
          if (event.type === 'damage' && event.targetType === 'entity') finalAttackers.add(event.sourceId);
        }
        return {
          tick: snapshot.tick,
          bothDead: [...idByOwner.values()].every((id) => entityIndex(snapshot, id) >= 0
            && entityHealth(snapshot, id) === 0),
          bothStruck: [...idByOwner.values()].every((id) => finalAttackers.has(id)),
        };
      }
      throw new Error('mirrored guards never completed their exchange');
    };

    const forward = runMirror(false);
    const reverse = runMirror(true);
    expect(forward).toEqual({ tick: forward.tick, bothDead: true, bothStruck: true });
    expect(reverse).toEqual(forward);
  });

  it('breaks an existing target lock for the first actual longitudinal blocker', () => {
    const attackPath = paths.get('p0_inner_e')!;
    const reversePath = paths.get('p1_inner_n')!;
    const game = createGame({ seed: 0xb10c4e, botPlayers: [], maxEntities: 64 });
    const attackerId = game.spawnDebugCombatant('p0_inner_e', 'guard', attackPath.length * 0.5 - 8);
    const rearPoint = sampleRoutePath(attackPath, attackPath.length * 0.5 - 2).position;
    const rearDistance = nearestOnRoutePath(reversePath, rearPoint).routeDistance;
    const rearId = game.spawnDebugCombatant('p1_inner_n', 'guard', rearDistance);

    let lockedSnapshot: GameSnapshot | null = null;
    for (let tick = 0; tick < 40; tick += 1) {
      const snapshot = game.step();
      const attacker = entityIndex(snapshot, attackerId);
      if (attacker >= 0 && snapshot.entities.targetId[attacker] === rearId) {
        lockedSnapshot = snapshot;
        break;
      }
    }
    expect(lockedSnapshot).not.toBeNull();
    if (!lockedSnapshot) return;
    const attackerProgress = nearestOnRoutePath(attackPath, worldPosition(lockedSnapshot, attackerId)).routeDistance;
    const rearProgress = nearestOnRoutePath(attackPath, worldPosition(lockedSnapshot, rearId)).routeDistance;
    const blockerPoint = sampleRoutePath(attackPath, (attackerProgress + rearProgress) * 0.5).position;
    const blockerDistance = nearestOnRoutePath(reversePath, blockerPoint).routeDistance;
    const blockerId = game.spawnDebugCombatant('p1_inner_n', 'guard', blockerDistance);

    const snapshot = game.step();
    const attacker = entityIndex(snapshot, attackerId);
    expect(attacker).toBeGreaterThanOrEqual(0);
    expect(snapshot.entities.targetId[attacker]).toBe(blockerId);
  });

  it('preserves a mounted charge through center tactics and lands it across a perpendicular lane', () => {
    const north = paths.get('p0_center')!;
    const east = paths.get('p1_center')!;
    const game = createGame({ seed: 0xc4a46e, botPlayers: [], maxEntities: 64 });
    const knightId = game.spawnDebugCombatant('p0_center', 'knight', north.centerDistance - 8);
    const guardId = game.spawnDebugCombatant('p1_center', 'guard', east.centerDistance - 8);
    let firstKnightHit = -1;
    for (let tick = 0; tick < 300 && firstKnightHit < 0; tick += 1) {
      const snapshot = game.step();
      const hit = snapshot.events.find((event) => (
        event.type === 'damage'
        && event.sourceId === knightId
        && event.targetType === 'entity'
        && event.targetId === guardId
      ));
      if (hit?.type === 'damage') firstKnightHit = hit.amount;
    }
    expect(firstKnightHit).toBe(Math.round(ARCHETYPES_BY_ID.knight.damage * 1.6));
  });
  it('lets archers hold a ranged standoff while guards must close to melee range', () => {
    const { game, idA: archerId, idB: guardId } = spawnOpposed(
      'p0_inner_e',
      'archer',
      'p1_inner_n',
      'guard',
      14,
    );
    let arrowDistance = -1;
    let arrowDamage = 0;
    for (let tick = 0; tick < 260 && arrowDistance < 0; tick += 1) {
      const snapshot = game.step();
      const hit = snapshot.events.find((event) => (
        event.type === 'damage'
        && event.targetType === 'entity'
        && event.sourceId === archerId
        && event.targetId === guardId
      ));
      if (!hit || hit.type !== 'damage') continue;
      const archer = worldPosition(snapshot, archerId);
      const guard = worldPosition(snapshot, guardId);
      arrowDistance = Math.hypot(archer.x - guard.x, archer.z - guard.z);
      arrowDamage = hit.amount;
    }

    expect(arrowDamage).toBe(ARCHETYPES_BY_ID.archer.damage);
    expect(arrowDistance).toBeGreaterThan(4.5);
    expect(arrowDistance).toBeLessThanOrEqual(7.25);
  });

  it('delays arrow damage until the exact deterministic impact tick', () => {
    const { game, idA: archerId, idB: guardId } = spawnOpposed(
      'p0_inner_e',
      'archer',
      'p1_inner_n',
      'guard',
      14,
    );
    let castSnapshot: GameSnapshot | null = null;
    let projectile: Extract<GameSnapshot['events'][number], { type: 'projectile-cast' }> | null = null;
    for (let tick = 0; tick < 260 && !projectile; tick += 1) {
      const snapshot = game.step();
      const cast = snapshot.events.find((event) => (
        event.type === 'projectile-cast'
        && event.sourceId === archerId
        && event.targetType === 'entity'
        && event.targetId === guardId
      ));
      if (cast?.type !== 'projectile-cast') continue;
      castSnapshot = snapshot;
      projectile = cast;
    }

    expect(projectile).not.toBeNull();
    expect(castSnapshot).not.toBeNull();
    if (!projectile || !castSnapshot) throw new Error('archer never released an arrow');
    expect(projectile.impactTick - projectile.tick).toBeGreaterThanOrEqual(3);
    const hpBeforeFlight = entityHealth(castSnapshot, guardId);
    let snapshot = castSnapshot;
    while (snapshot.tick < projectile.impactTick - 1) {
      snapshot = game.step();
      expect(entityHealth(snapshot, guardId)).toBe(hpBeforeFlight);
      expect(snapshot.events.some((event) => (
        event.type === 'damage'
        && event.sourceId === archerId
        && event.targetType === 'entity'
        && event.targetId === guardId
      ))).toBe(false);
    }

    snapshot = game.step();
    expect(snapshot.tick).toBe(projectile.impactTick);
    expect(entityHealth(snapshot, guardId)).toBe(hpBeforeFlight - ARCHETYPES_BY_ID.archer.damage);
    const impact = snapshot.events.find((event) => (
      event.type === 'projectile-impact' && event.projectileId === projectile.projectileId
    ));
    expect(impact).toEqual(expect.objectContaining({
      type: 'projectile-impact',
      tick: projectile.impactTick,
      projectileId: projectile.projectileId,
      hit: true,
    }));
    if (impact?.type === 'projectile-impact') {
      const movingTarget = worldPosition(snapshot, guardId);
      expect(impact.destination.x).toBeCloseTo(movingTarget.x, 2);
      expect(impact.destination.z).toBeCloseTo(movingTarget.z, 2);
      expect(Math.hypot(
        impact.destination.x - projectile.destination.x,
        impact.destination.z - projectile.destination.z,
      )).toBeGreaterThan(0.05);
    }
    expect(snapshot.events).toContainEqual(expect.objectContaining({
      type: 'damage',
      tick: projectile.impactTick,
      sourceId: archerId,
      targetType: 'entity',
      targetId: guardId,
      amount: ARCHETYPES_BY_ID.archer.damage,
    }));
  });

  it('gives mounted knights one deterministic charge impact followed by normal attacks', () => {
    const { game, idA: knightId, idB: guardId } = spawnOpposed(
      'p0_outer_e',
      'knight',
      'p1_outer_n',
      'guard',
      14,
    );
    const knightHits: number[] = [];
    for (let tick = 0; tick < 400 && knightHits.length < 2; tick += 1) {
      const snapshot = game.step();
      for (const event of snapshot.events) {
        if (
          event.type === 'damage'
          && event.targetType === 'entity'
          && event.sourceId === knightId
          && event.targetId === guardId
        ) knightHits.push(event.amount);
      }
    }

    expect(knightHits.slice(0, 2)).toEqual([
      Math.round(ARCHETYPES_BY_ID.knight.damage * 1.6),
      ARCHETYPES_BY_ID.knight.damage,
    ]);
  });

  it('requires real travelled distance before granting the mounted charge bonus', () => {
    const { game, idA: knightId, idB: guardId } = spawnOpposed(
      'p0_outer_e',
      'knight',
      'p1_outer_n',
      'guard',
      3,
    );
    let firstImpact = -1;
    for (let tick = 0; tick < 120 && firstImpact < 0; tick += 1) {
      const snapshot = game.step();
      const hit = snapshot.events.find((event) => (
        event.type === 'damage'
        && event.sourceId === knightId
        && event.targetType === 'entity'
        && event.targetId === guardId
      ));
      if (hit?.type === 'damage') firstImpact = hit.amount;
    }
    expect(firstImpact).toBe(ARCHETYPES_BY_ID.knight.damage);
  });

  it('keeps giants focused on a reachable tower even while infantry attacks them', () => {
    const game = createGame({ seed: 0x61a47, botPlayers: [], maxEntities: 64 });
    const towerRoute = 'p1_inner_n';
    const towerPad = MAP_GRAPH.towerPads.find((pad) => pad.routeIds.includes(towerRoute))!;
    expect(game.queueCommand({
      type: 'deploy',
      playerId: 1,
      cardId: 'cannon_tower',
      routeId: towerRoute,
      sequence: 1,
      tick: 0,
      position: towerPad.position,
    }).accepted).toBe(true);
    const towerSnapshot = game.step();
    const towerIndex = [...towerSnapshot.entities.owner].findIndex((owner, index) => (
      owner === 1 && towerSnapshot.entities.archetype[index] === 6
    ));
    const towerId = towerSnapshot.entities.id[towerIndex]!;

    const attackPath = paths.get('p0_inner_e')!;
    const defensePath = paths.get(towerRoute)!;
    const towerProjection = nearestOnRoutePath(attackPath, towerPad.position).routeDistance;
    const giantDistance = towerProjection - 3;
    const guardWorldDistance = towerProjection - 1.2;
    const giantId = game.spawnDebugCombatant('p0_inner_e', 'giant', giantDistance);
    game.spawnDebugCombatant(towerRoute, 'guard', defensePath.length - guardWorldDistance);
    let targetedTower = false;
    let damagedTower = false;

    for (let tick = 0; tick < 320 && !damagedTower; tick += 1) {
      const snapshot = game.step();
      const giantIndex = entityIndex(snapshot, giantId);
      if (giantIndex >= 0 && snapshot.entities.targetId[giantIndex] === towerId) targetedTower = true;
      damagedTower ||= snapshot.events.some((event) => (
        event.type === 'damage'
        && event.sourceId === giantId
        && event.targetType === 'entity'
        && event.targetId === towerId
      ));
    }

    expect(targetedTower).toBe(true);
    expect(damagedTower).toBe(true);
  });
});
