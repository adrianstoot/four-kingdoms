/// <reference lib="webworker" />

import { createGame, type GameCommand, type GameSimulation } from '@kingdoms/sim';

type IncomingMessage =
  | { type: 'start'; sessionId: number; seed?: number; maxEntities?: number }
  | { type: 'command'; sessionId: number; command: GameCommand }
  | { type: 'pause'; sessionId: number; paused: boolean }
  | { type: 'reset'; sessionId: number; seed?: number };

let game: GameSimulation = createGame({ seed: 0x4f55524b, botPlayers: [1, 2, 3], maxEntities: 768 });
let running = false;
let activeSessionId = 0;
let lastTime = performance.now();
let accumulator = 0;
const stepMs = 50;

function publish(): void {
  self.postMessage({ type: 'snapshot', sessionId: activeSessionId, snapshot: game.getSnapshot() });
}

function recreate(seed = 0x4f55524b, maxEntities = 768): void {
  game = createGame({ seed, botPlayers: [1, 2, 3], maxEntities });
  lastTime = performance.now();
  accumulator = 0;
  publish();
}

self.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'start':
      activeSessionId = message.sessionId;
      recreate(message.seed, message.maxEntities);
      // The renderer can need a long first shader compilation on an uncached
      // device. Publish tick zero immediately, but do not let bots fight
      // behind the loading screen; React releases the simulation after the
      // first complete frame has been presented.
      running = false;
      game.setPaused(true);
      break;
    case 'command': {
      if (message.sessionId !== activeSessionId) break;
      const result = game.queueCommand(message.command);
      if (!result.accepted) self.postMessage({ type: 'commandRejected', sessionId: activeSessionId, reason: result.reason });
      break;
    }
    case 'pause':
      if (message.sessionId !== activeSessionId) break;
      running = !message.paused;
      game.setPaused(message.paused);
      lastTime = performance.now();
      break;
    case 'reset':
      if (message.sessionId < activeSessionId) break;
      activeSessionId = message.sessionId;
      recreate(message.seed);
      running = true;
      break;
  }
};

setInterval(() => {
  const now = performance.now();
  const delta = Math.min(250, now - lastTime);
  lastTime = now;
  if (!running) return;
  accumulator += delta;
  let catchUp = 0;
  while (accumulator >= stepMs && catchUp < 5) {
    const snapshot = game.step();
    accumulator -= stepMs;
    catchUp += 1;
    self.postMessage({ type: 'snapshot', sessionId: activeSessionId, snapshot });
  }
}, 10);

publish();

export {};
