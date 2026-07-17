import type { GameSnapshot } from '@kingdoms/sim';
import type { CameraPose } from '../game/types';
import { normalizeSnapshot } from '../game/snapshot';
import { FACTION_CSS_COLORS } from '../game/factions';

const colors = FACTION_CSS_COLORS;
const WORLD_TO_MAP = 0.64;
const lanes = [
  'M50 8 C70 8 92 29 92 50',
  'M92 50 C92 71 71 92 50 92',
  'M50 92 C29 92 8 71 8 50',
  'M8 50 C8 29 29 8 50 8',
  'M50 8 C50 15 64 30 92 50',
  'M92 50 C84 50 69 64 50 92',
  'M50 92 C50 84 35 69 8 50',
  'M8 50 C16 50 31 35 50 8',
  'M50 8 L50 50',
  'M92 50 L50 50',
  'M50 92 L50 50',
  'M8 50 L50 50',
];

const castlePoints = [
  { x: 50, y: 8 },
  { x: 92, y: 50 },
  { x: 50, y: 92 },
  { x: 8, y: 50 },
];

function mapCoordinate(value: number): number {
  return Math.max(4, Math.min(96, 50 + value * WORLD_TO_MAP));
}

export function GameMinimap({ snapshot, cameraPose }: { snapshot: GameSnapshot | null; cameraPose: CameraPose }) {
  const normalized = normalizeSnapshot(snapshot);
  const stride = normalized.units.length > 240 ? Math.ceil(normalized.units.length / 240) : 1;
  const targetX = mapCoordinate(cameraPose.target.x);
  const targetY = mapCoordinate(cameraPose.target.z);
  const cameraDegrees = -(cameraPose.yaw * 180) / Math.PI;

  return (
    <div className="minimap-frame" aria-label="Minimapa norte arriba">
      <div className="minimap-bezel">
        <svg className="minimap" viewBox="0 0 100 100" role="img" aria-label={"Posiciones, carriles y orientaci\u00f3n de c\u00e1mara"}>
          <defs>
            <radialGradient id="mapGround" cx="50%" cy="45%" r="66%"><stop offset="0" stopColor="#526b2f" /><stop offset="1" stopColor="#293b22" /></radialGradient>
            <filter id="mapShadow"><feDropShadow dx="0" dy="1" stdDeviation="1" floodColor="#080b08" floodOpacity=".9" /></filter>
            <clipPath id="mapClip"><rect x="2" y="2" width="96" height="96" rx="14" /></clipPath>
          </defs>
          <rect x="2" y="2" width="96" height="96" rx="14" fill="url(#mapGround)" stroke="#172018" strokeWidth="3" />
          <g clipPath="url(#mapClip)">
            <g className="minimap-roads">
              {lanes.map((path, index) => <path className="lane lane-edge" d={path} key={`e${index}`} />)}
              {lanes.map((path, index) => <path className="lane" d={path} key={index} />)}
              {lanes.slice(0, 4).map((path, index) => <path className="lane-highlight" d={path} key={`h${index}`} />)}
            </g>
            {normalized.units.filter((_, index) => index % stride === 0).map((unit) => (
              <circle
                className="unit-dot"
                key={unit.id}
                cx={mapCoordinate(unit.x)}
                cy={mapCoordinate(unit.z)}
                r={normalized.units.length > 350 ? 0.65 : 0.9}
                fill={colors[unit.owner]}
              />
            ))}
            <g
              className="camera-cone"
              transform={`translate(${targetX} ${targetY}) rotate(${cameraDegrees})`}
              filter="url(#mapShadow)"
            >
              <path d="M0 -1 L-10 -19 Q0 -23 10 -19 Z" />
              <circle cx="0" cy="0" r="2.4" />
            </g>
          </g>
          {castlePoints.map((point, index) => (
            <g key={index} filter="url(#mapShadow)">
              <circle cx={point.x} cy={point.y} r="5.4" fill="#1b2219" stroke="#c19857" strokeWidth="1.4" />
              <circle cx={point.x} cy={point.y} r="3.5" fill={colors[index]} stroke="#111711" strokeWidth=".8" />
            </g>
          ))}
          <circle cx="50" cy="50" r="5.6" fill="#24251d" stroke="#c19857" strokeWidth="1.2" />
          <circle cx="50" cy="50" r="3.1" fill={normalized.centerOwner >= 0 ? colors[normalized.centerOwner] : '#98714b'} stroke="#171b14" strokeWidth=".7" />
          <text className="minimap-north" x="50" y="6.2" textAnchor="middle">N</text>
        </svg>
      </div>
    </div>
  );
}
