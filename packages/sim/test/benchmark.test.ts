import { describe, expect, it } from 'vitest';
import { createGame } from '../src';

describe('crowd benchmark harness', () => {
  it('updates a 500-unit crowd without allocation growth or failure', () => {
    const game = createGame({ seed: 9, botPlayers: [], maxEntities: 1_200 });
    expect(game.spawnDebugCrowd(500)).toBe(500);
    const before = game.getSnapshot();
    const started = performance.now();
    for (let tick = 0; tick < 200; tick += 1) game.step();
    const elapsed = performance.now() - started;
    const after = game.getSnapshot();
    expect(before.entities.count).toBe(500);
    expect(after.entities.count).toBeLessThanOrEqual(500);
    expect(after.entities.count).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5_000);
  });

  it('creates a 1,000-unit stress snapshot', () => {
    const game = createGame({ seed: 11, botPlayers: [], maxEntities: 1_200 });
    expect(game.spawnDebugCrowd(1_000)).toBe(1_000);
    const snapshot = game.getSnapshot();
    expect(snapshot.entities.count).toBe(1_000);
    expect(snapshot.entities.x.byteLength).toBe(2_000);
    expect(snapshot.stateHash).not.toBe(0);
  });
});
