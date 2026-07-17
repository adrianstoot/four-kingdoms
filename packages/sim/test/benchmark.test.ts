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

  it('simulates a 1,000-unit stress crowd with bounded tick latency and no entity growth', () => {
    const game = createGame({ seed: 11, botPlayers: [], maxEntities: 1_200 });
    expect(game.spawnDebugCrowd(1_000)).toBe(1_000);
    for (let tick = 0; tick < 20; tick += 1) game.step();

    const tickTimes: number[] = [];
    let maximumCount = 0;
    let finalSnapshot = game.getSnapshot();
    for (let tick = 0; tick < 120; tick += 1) {
      const started = performance.now();
      finalSnapshot = game.step();
      tickTimes.push(performance.now() - started);
      maximumCount = Math.max(maximumCount, finalSnapshot.entities.count);
    }

    const ordered = [...tickTimes].sort((left, right) => left - right);
    const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    expect(maximumCount).toBeLessThanOrEqual(1_000);
    expect(finalSnapshot.entities.count).toBeGreaterThan(0);
    expect(finalSnapshot.entities.x.byteLength).toBe(finalSnapshot.entities.count * Int16Array.BYTES_PER_ELEMENT);
    expect(finalSnapshot.stateHash).not.toBe(0);
    // Broad CI health gate; the hardware-specific render target is 33.3 ms.
    expect(p95).toBeLessThan(100);
  });
});
