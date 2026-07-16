import { describe, expect, it } from 'vitest';
import { buildSmoothPath, nearestOnSmoothPath } from '@kingdoms/content';
import {
  CARDS_BY_ID,
  CONTENT,
  MAP_GRAPH,
  createGame,
  findBestPlacement,
} from '../src';

const troopCards = ['guards', 'archers', 'knight', 'giant', 'commander'] as const;

describe('integral gameplay update', () => {
  it('uses the audited radius-60 map and five-meter roads', () => {
    const kingdomPositions = MAP_GRAPH.nodes
      .filter((node) => node.kind === 'kingdom')
      .map((node) => node.position);
    expect(kingdomPositions).toEqual([
      { x: 0, z: -60 },
      { x: 60, z: 0 },
      { x: 0, z: 60 },
      { x: -60, z: 0 },
    ]);
    expect(MAP_GRAPH.lanes.every((lane) => lane.width === 5)).toBe(true);
    expect(MAP_GRAPH.lanes.find((lane) => lane.id === 'outer_ne')?.points).toEqual([
      { x: 0, z: -60 }, { x: 32, z: -56 }, { x: 56, z: -32 }, { x: 60, z: 0 },
    ]);
    expect(MAP_GRAPH.lanes.find((lane) => lane.id === 'inner_ne')?.points).toEqual([
      { x: 0, z: -60 }, { x: 0, z: -53 }, { x: 24, z: -30 },
      { x: 30, z: -24 }, { x: 53, z: 0 }, { x: 60, z: 0 },
    ]);
    for (const lane of MAP_GRAPH.lanes.filter((candidate) => candidate.kind === 'radial')) {
      expect(lane.points).toHaveLength(2);
    }
  });

  it('stores metric height, physical radius and attack anticipation for every archetype', () => {
    const expectedHeights = { guard: 1.7, archer: 1.7, knight: 2.2, giant: 2.5, commander: 1.9 };
    for (const unit of CONTENT.units) {
      expect(unit.height).toBe(expectedHeights[unit.id]);
      expect(unit.physicalRadius).toBe(unit.radius);
      expect(unit.attackAnticipationTicks).toBeGreaterThan(0);
      expect(unit.attackAnticipationTicks).toBeLessThan(unit.attackCooldownTicks);
    }
  });

  it.each(troopCards)('deploys one entity for %s', (cardId) => {
    const game = createGame({ seed: 400 + troopCards.indexOf(cardId), botPlayers: [] });
    const card = CARDS_BY_ID[cardId];
    while (game.getSnapshot().players[0]!.elixir < card.cost) game.step();
    const desired = MAP_GRAPH.nodes.find((node) => node.playerId === 0)!.position;
    const placement = findBestPlacement(0, cardId, desired);
    expect(placement.valid).toBe(true);
    expect(placement.routeId).toBeTruthy();
    expect(game.queueCommand({
      type: 'deploy',
      playerId: 0,
      cardId,
      routeId: placement.routeId!,
      position: desired,
      sequence: 1,
      tick: game.getSnapshot().tick,
    }).accepted).toBe(true);
    expect(game.step().entities.count).toBe(1);
  });

  it('selects among five zones with hysteresis and supports ten rapid clicks', () => {
    const desired = MAP_GRAPH.nodes.find((node) => node.playerId === 0)!.position;
    const preferred = findBestPlacement(0, 'guards', desired, { preferredRouteId: 'p0_outer_e' });
    expect(preferred.valid).toBe(true);
    expect(preferred.routeId).toBe('p0_outer_e');

    const game = createGame({ seed: 712, botPlayers: [], maxEntities: 64 });
    while (game.getSnapshot().players[0]!.elixir < 100) game.step();
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      expect(game.queueCommand({
        type: 'deploy', playerId: 0, cardId: 'guards', routeId: preferred.routeId!,
        position: preferred.position, sequence, tick: game.getSnapshot().tick,
      }).accepted).toBe(true);
    }
    expect(game.getSnapshot().players[0]!.elixir).toBe(70);
    expect(game.step().entities.count).toBe(10);
  });

  it('places tower pads on the lateral road edge', () => {
    for (const pad of MAP_GRAPH.towerPads) {
      const lane = MAP_GRAPH.lanes.find((candidate) => candidate.id === pad.laneId)!;
      const nearest = nearestOnSmoothPath(buildSmoothPath(lane.points), pad.position);
      expect(nearest.lateralDistance).toBeCloseTo(lane.width * 0.5, 1);
    }
  });

  it('delays fireball damage until its impact event and emits its castle origin', () => {
    const game = createGame({ seed: 811, botPlayers: [] });
    expect(game.spawnDebugRouteGroup('p1_center', 1)).toBe(1);
    const before = game.getSnapshot();
    const destination = { x: before.entities.x[0]! / 100, z: before.entities.z[0]! / 100 };
    const hpBefore = before.entities.hp[0]!;
    expect(game.queueCommand({
      type: 'spell', playerId: 0, cardId: 'fireball', position: destination,
      sequence: 1, tick: before.tick,
    }).accepted).toBe(true);

    let snapshot = game.step();
    const cast = snapshot.events.find((event) => event.type === 'spell-cast');
    expect(cast?.type).toBe('spell-cast');
    if (!cast || cast.type !== 'spell-cast') throw new Error('missing spell-cast');
    expect(cast.origin).toEqual({ x: 0, z: -60 });
    expect(cast.impactTick - cast.tick).toBeGreaterThanOrEqual(9);
    expect(cast.impactTick - cast.tick).toBeLessThanOrEqual(24);
    expect(snapshot.entities.hp[0]).toBe(hpBefore);

    while (snapshot.tick < cast.impactTick) snapshot = game.step();
    const impact = snapshot.events.find((event) => event.type === 'spell-impact');
    expect(impact?.type).toBe('spell-impact');
    if (!impact || impact.type !== 'spell-impact') throw new Error('missing spell-impact');
    expect(impact.castId).toBe(cast.castId);
    expect(impact.targetIds).toHaveLength(1);
    expect(snapshot.entities.hp[0]).toBe(0);
  });

  it('keeps lightning visible for at least 0.6 seconds even without targets', () => {
    const game = createGame({ seed: 812, botPlayers: [] });
    expect(game.queueCommand({
      type: 'spell', playerId: 0, cardId: 'chain_lightning', position: { x: 0, z: -30 },
      sequence: 1, tick: 0,
    }).accepted).toBe(true);
    let snapshot = game.step();
    const cast = snapshot.events.find((event) => event.type === 'spell-cast');
    if (!cast || cast.type !== 'spell-cast') throw new Error('missing spell-cast');
    expect(cast.impactTick - cast.tick).toBeGreaterThanOrEqual(12);
    while (snapshot.tick < cast.impactTick) snapshot = game.step();
    const impact = snapshot.events.find((event) => event.type === 'spell-impact');
    if (!impact || impact.type !== 'spell-impact') throw new Error('missing spell-impact');
    expect(impact.targetIds).toHaveLength(0);
  });

  it('exports state ticks and distance-synchronised motion phases', () => {
    const game = createGame({ seed: 913, botPlayers: [] });
    game.spawnDebugRouteGroup('p0_outer_e', 1);
    let snapshot = game.getSnapshot();
    expect(snapshot.entities.stateTick).toHaveLength(1);
    expect(snapshot.entities.motionPhase).toHaveLength(1);
    const initial = snapshot.entities.motionPhase[0]!;
    for (let tick = 0; tick < 20; tick += 1) snapshot = game.step();
    expect(snapshot.entities.motionPhase[0]).not.toBe(initial);
  });
});
