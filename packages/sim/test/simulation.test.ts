import { describe, expect, it } from 'vitest';
import { MAP_GRAPH, createGame, findPlacement } from '../src';

describe('four kingdoms simulation', () => {
  it('contains the five nodes, twelve lanes and twenty directed routes', () => {
    expect(MAP_GRAPH.nodes).toHaveLength(5);
    expect(MAP_GRAPH.lanes).toHaveLength(12);
    expect(MAP_GRAPH.routes).toHaveLength(20);
    expect(MAP_GRAPH.routes.filter((route) => route.playerId === 0)).toHaveLength(5);
  });

  it('accepts a legal deployment and spawns exactly one entity', () => {
    const game = createGame({ seed: 1, botPlayers: [] });
    const route = MAP_GRAPH.routes.find((candidate) => candidate.id === 'p0_center')!;
    const zone = MAP_GRAPH.deploymentZones.find((candidate) => candidate.routeIds.includes(route.id))!;
    const lane = MAP_GRAPH.lanes.find((candidate) => candidate.id === zone.laneId)!;
    const desired = lane.points[0]!;
    const placement = findPlacement(0, 'guards', route.id, desired);
    expect(placement.valid).toBe(true);

    const result = game.queueCommand({
      type: 'deploy', playerId: 0, cardId: 'guards', routeId: route.id,
      sequence: 1, tick: 0, position: desired,
    });
    expect(result.accepted).toBe(true);
    const snapshot = game.step();
    expect(snapshot.entities.count).toBe(1);
    expect(snapshot.players[0]?.elixir).toBeCloseTo(2.02, 2);
    expect([...snapshot.entities.owner]).toEqual([0]);
  });

  it('rejects enemy routes without mutating elixir', () => {
    const game = createGame({ seed: 2, botPlayers: [] });
    const result = game.queueCommand({
      type: 'deploy', playerId: 0, cardId: 'guards', routeId: 'p1_center',
      sequence: 1, tick: 0, position: { x: 50, z: 0 },
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid-route');
    expect(game.getSnapshot().players[0]?.elixir).toBe(5);
  });

  it('replays deterministically for 10,000 ticks', () => {
    const left = createGame({ seed: 0x12345678, botPlayers: [0, 1, 2, 3] });
    const right = createGame({ seed: 0x12345678, botPlayers: [0, 1, 2, 3] });
    for (let tick = 0; tick < 10_000; tick += 1) {
      const a = left.step();
      const b = right.step();
      if (tick % 97 === 0 || tick === 9_999) expect(a.stateHash).toBe(b.stateHash);
    }
    expect(left.getSnapshot().phase).toBe(right.getSnapshot().phase);
  });

  it('runs seeded bot matches without exceeding capacity', () => {
    const game = createGame({ seed: 77, botPlayers: [0, 1, 2, 3], maxEntities: 256 });
    for (let tick = 0; tick < 3_000 && game.getSnapshot().phase === 'playing'; tick += 1) game.step();
    const snapshot = game.getSnapshot();
    expect(snapshot.entities.count).toBeLessThanOrEqual(256);
    expect(snapshot.castles).toHaveLength(4);
    expect(snapshot.players.every((player) => player.elixir >= 0 && player.elixir <= 100)).toBe(true);
  });

  it('regenerates elixir up to the new 100-point cap', () => {
    const game = createGame({ seed: 91, botPlayers: [] });
    for (let tick = 0; tick < 4_750; tick += 1) game.step();
    const snapshot = game.getSnapshot();
    expect(snapshot.players.every((player) => player.elixir === 100 && player.maxElixir === 100)).toBe(true);
  });

  it('locks targets and briefly pursues enemies instead of walking through combat', () => {
    const game = createGame({ seed: 92, botPlayers: [] });
    const routeStart = (routeId: string) => {
      const route = MAP_GRAPH.routes.find((candidate) => candidate.id === routeId)!;
      const zone = MAP_GRAPH.deploymentZones.find((candidate) => candidate.routeIds.includes(routeId))!;
      const lane = MAP_GRAPH.lanes.find((candidate) => candidate.id === zone.laneId)!;
      return route.steps[0]?.reverse ? lane.points.at(-1)! : lane.points[0]!;
    };
    expect(game.queueCommand({
      type: 'deploy', playerId: 0, cardId: 'guards', routeId: 'p0_inner_e',
      sequence: 1, tick: 0, position: routeStart('p0_inner_e'),
    }).accepted).toBe(true);
    expect(game.queueCommand({
      type: 'deploy', playerId: 1, cardId: 'guards', routeId: 'p1_inner_n',
      sequence: 1, tick: 0, position: routeStart('p1_inner_n'),
    }).accepted).toBe(true);
    let sawPursuit = false;
    let sawEnemyLock = false;
    for (let tick = 0; tick < 650; tick += 1) {
      const snapshot = game.step();
      const indexById = new Map([...snapshot.entities.id].map((id, index) => [id, index]));
      for (let index = 0; index < snapshot.entities.count; index += 1) {
        const targetIndex = indexById.get(snapshot.entities.targetId[index]!);
        if (targetIndex === undefined) continue;
        const owner = snapshot.entities.owner[index]!;
        const targetOwner = snapshot.entities.owner[targetIndex]!;
        if ((owner === 0 || owner === 2) === (targetOwner === 0 || targetOwner === 2)) continue;
        sawEnemyLock = true;
        if (snapshot.entities.state[index] === 1) sawPursuit = true;
      }
      if (sawPursuit && sawEnemyLock) break;
    }
    expect(sawEnemyLock).toBe(true);
    expect(sawPursuit).toBe(true);
  });

  it('rejects a second commander while the first deployment is still queued', () => {
    const game = createGame({ seed: 930, botPlayers: [] });
    for (let tick = 0; tick < 250; tick += 1) game.step();
    const route = MAP_GRAPH.routes.find((candidate) => candidate.id === 'p0_center')!;
    const lane = MAP_GRAPH.lanes.find((candidate) => candidate.id === route.steps[0]?.laneId)!;
    const command = {
      type: 'deploy' as const,
      playerId: 0 as const,
      cardId: 'commander' as const,
      routeId: route.id,
      tick: game.getSnapshot().tick,
      position: lane.points[0]!,
    };

    expect(game.queueCommand({ ...command, sequence: 1 }).accepted).toBe(true);
    const duplicate = game.queueCommand({ ...command, sequence: 2 });
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.reason).toBe('hero-active');

    const snapshot = game.step();
    const commanders = [...snapshot.entities.owner].filter((owner, index) => (
      owner === 0 && snapshot.entities.archetype[index] === 5
    ));
    expect(commanders).toHaveLength(1);
  });

  it('starts the commander respawn cooldown on death and allows a later respawn', () => {
    const game = createGame({ seed: 93, botPlayers: [] });
    for (let tick = 0; tick < 4_750; tick += 1) game.step();
    const route = MAP_GRAPH.routes.find((candidate) => candidate.id === 'p0_center')!;
    const lane = MAP_GRAPH.lanes.find((candidate) => candidate.id === route.steps[0]?.laneId)!;
    const desired = lane.points[0]!;
    expect(game.queueCommand({
      type: 'deploy', playerId: 0, cardId: 'commander', routeId: route.id,
      sequence: 1, tick: game.getSnapshot().tick, position: desired,
    }).accepted).toBe(true);
    const spawned = game.step();
    const commanderIndex = [...spawned.entities.owner].findIndex((owner, index) => owner === 0 && spawned.entities.archetype[index] === 5);
    expect(commanderIndex).toBeGreaterThanOrEqual(0);
    const target = { x: spawned.entities.x[commanderIndex]! / 100, z: spawned.entities.z[commanderIndex]! / 100 };
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      expect(game.queueCommand({
        type: 'spell', playerId: 1, cardId: 'fireball', sequence,
        tick: game.getSnapshot().tick, position: target,
      }).accepted).toBe(true);
      game.step();
    }
    for (let tick = 0; tick < 30; tick += 1) {
      game.step();
    }

    const blocked = game.queueCommand({
      type: 'deploy', playerId: 0, cardId: 'commander', routeId: route.id,
      sequence: 2, tick: game.getSnapshot().tick, position: desired,
    });
    expect(blocked.accepted).toBe(false);
    expect(blocked.reason).toBe('cooldown');
    expect(game.getSnapshot().players[0]?.cooldowns.commander).toBeGreaterThan(560);
    expect(game.getSnapshot().players[0]?.cooldowns.commander).toBeLessThanOrEqual(600);
    for (let tick = 0; tick < 600; tick += 1) game.step();
    expect(game.queueCommand({
      type: 'deploy', playerId: 0, cardId: 'commander', routeId: route.id,
      sequence: 2, tick: game.getSnapshot().tick, position: desired,
    }).accepted).toBe(true);
  });

  it('uses the complete tactical deck with useful targets for every medium bot', () => {
    const game = createGame({ seed: 94, botPlayers: [1, 2, 3], maxEntities: 512 });
    const usedCards = new Map<number, Set<string>>([
      [1, new Set<string>()],
      [2, new Set<string>()],
      [3, new Set<string>()],
    ]);
    const spellHits = new Map<string, number>();
    const towerOwners = new Map<number, number>();
    let towerDamage = 0;
    let strategicDamage = 0;
    let captures = 0;

    for (let tick = 0; tick < 4_000 && game.getSnapshot().phase === 'playing'; tick += 1) {
      const snapshot = game.step();
      for (const event of snapshot.events) {
        if (event.type === 'spawn' && event.playerId !== 0) {
          const cards = usedCards.get(event.playerId)!;
          if (event.archetype === 5) cards.add('commander');
          if (event.archetype === 6) {
            const entityIndex = [...snapshot.entities.id].indexOf(event.entityId);
            const x = snapshot.entities.x[entityIndex]! / 100;
            const z = snapshot.entities.z[entityIndex]! / 100;
            const legalPad = MAP_GRAPH.towerPads.some((pad) => (
              pad.playerId === event.playerId && Math.hypot(pad.position.x - x, pad.position.z - z) < 0.2
            ));
            if (legalPad) cards.add('cannon_tower');
            towerOwners.set(event.entityId, event.playerId);
          }
        }
        if (event.type === 'spell-impact' && event.playerId !== 0) {
          usedCards.get(event.playerId)!.add(event.cardId);
          spellHits.set(`${event.playerId}:${event.cardId}`, event.targetIds.length);
        }
        if (event.type === 'capture') captures += 1;
        if (event.type === 'damage') {
          if (event.targetType === 'castle') strategicDamage += event.amount;
          if (towerOwners.has(event.sourceId)) towerDamage += event.amount;
        }
      }
    }

    for (const playerId of [1, 2, 3]) {
      expect([...usedCards.get(playerId)!].sort()).toEqual([
        'cannon_tower', 'chain_lightning', 'commander', 'fireball',
      ]);
      expect(spellHits.get(`${playerId}:fireball`)).toBeGreaterThanOrEqual(1);
      expect(spellHits.get(`${playerId}:chain_lightning`)).toBeGreaterThanOrEqual(1);
    }
    expect(towerDamage).toBeGreaterThan(0);
    expect(strategicDamage).toBeGreaterThan(0);
    expect(captures).toBeGreaterThan(0);
  });

  it('makes giants acquire defensive buildings as priority targets', () => {
    const game = createGame({ seed: 95, botPlayers: [] });
    for (let tick = 0; tick < 100; tick += 1) game.step();
    const routePoint = (routeId: string) => {
      const route = MAP_GRAPH.routes.find((candidate) => candidate.id === routeId)!;
      const zone = MAP_GRAPH.deploymentZones.find((candidate) => candidate.routeIds.includes(routeId))!;
      const lane = MAP_GRAPH.lanes.find((candidate) => candidate.id === zone.laneId)!;
      return route.steps[0]?.reverse ? lane.points.at(-1)! : lane.points[0]!;
    };
    expect(game.queueCommand({
      type: 'deploy', playerId: 1, cardId: 'cannon_tower', routeId: 'p1_inner_n',
      sequence: 1, tick: game.getSnapshot().tick, position: MAP_GRAPH.towerPads.find((pad) => pad.routeIds.includes('p1_inner_n'))!.position,
    }).accepted).toBe(true);
    expect(game.queueCommand({
      type: 'deploy', playerId: 0, cardId: 'giant', routeId: 'p0_inner_e',
      sequence: 1, tick: game.getSnapshot().tick, position: routePoint('p0_inner_e'),
    }).accepted).toBe(true);
    const deployed = game.step();
    const towerIndex = [...deployed.entities.owner].findIndex((owner, index) => owner === 1 && deployed.entities.archetype[index] === 6);
    const towerId = deployed.entities.id[towerIndex]!;
    let giantTargetedTower = false;
    for (let tick = 0; tick < 1_500; tick += 1) {
      const snapshot = game.step();
      const giantIndex = [...snapshot.entities.owner].findIndex((owner, index) => owner === 0 && snapshot.entities.archetype[index] === 4);
      if (giantIndex >= 0 && snapshot.entities.targetId[giantIndex] === towerId) {
        giantTargetedTower = true;
        break;
      }
    }
    expect(giantTargetedTower).toBe(true);
  });
});
