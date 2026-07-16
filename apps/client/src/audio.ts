import { Howl, Howler } from 'howler';

type SoundName = 'click' | 'deploy' | 'impact' | 'spell' | 'capture' | 'victory';

const sampleRate = 11_025;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function wavDataUri(
  frequencies: readonly number[],
  duration: number,
  decay = 4,
  noise = 0,
): string {
  const length = Math.max(1, Math.floor(sampleRate * duration));
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  writeAscii(view, 8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, length * 2, true);

  let seed = 0x6d2b79f5;
  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate;
    const envelope = Math.exp(-decay * time) * Math.min(1, time * 90);
    let value = 0;
    for (const frequency of frequencies) {
      value += Math.sin(time * Math.PI * 2 * frequency) / frequencies.length;
    }
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const random = ((seed >>> 0) / 0xffffffff) * 2 - 1;
    value = (value * (1 - noise) + random * noise) * envelope;
    view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, value)) * 0x6fff, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]!);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

const sounds: Record<SoundName, Howl> = {
  click: new Howl({ src: [wavDataUri([420, 660], 0.08, 18)], volume: 0.22 }),
  deploy: new Howl({ src: [wavDataUri([180, 280, 410], 0.28, 7)], volume: 0.34 }),
  impact: new Howl({ src: [wavDataUri([80, 115], 0.18, 11, 0.56)], volume: 0.24 }),
  spell: new Howl({ src: [wavDataUri([220, 440, 880], 0.48, 4, 0.1)], volume: 0.3 }),
  capture: new Howl({ src: [wavDataUri([330, 494, 659], 0.72, 2.8)], volume: 0.35 }),
  victory: new Howl({ src: [wavDataUri([262, 330, 392, 523], 1.3, 1.5)], volume: 0.4 }),
};

let enabled = true;

export function playSound(name: SoundName): void {
  if (enabled) sounds[name].play();
}

export function setAudioEnabled(next: boolean): void {
  enabled = next;
  Howler.mute(!next);
}

export function setAudioVolume(volume: number): void {
  Howler.volume(Math.max(0, Math.min(1, volume)));
}
