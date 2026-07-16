/// <reference lib="webworker" />

import { createGame, type GameCommand, type GameSimulation } from '@kingdoms/sim';

type IncomingMessage =
  | { type: 'start'; seed?: number; maxEntities?: number }
  | { type: 'command'; command: GameCommand }
  | { type: 'pause'; paused: boolean }
  | { type: 'reset'; seed?: number };

let game: GameSimulation = createGame({ seed: 0x4f55524b, botPlayers: [1, 2, 3], maxEntities: 768 });
let running = false;
let lastTime = performance.now();
let accumulator = 0;
const stepMs = 50;

function publish(): void {
  self.postMessage({ type: 'snapshot', snapshot: game.getSnapshot() });
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
      recreate(message.seed, message.maxEntities);
      running = true;
      game.setPaused(false);
      break;
    case 'command': {
      const result = game.queueCommand(message.command);
      if (!result.accepted) self.postMessage({ type: 'commandRejected', reason: result.reason });
      break;
    }
    case 'pause':
      running = !message.paused;
      game.setPaused(message.paused);
      lastTime = performance.now();
      break;
    case 'reset':
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
    self.postMessage({ type: 'snapshot', snapshot });
  }
}, 10);

publish();

export {};
