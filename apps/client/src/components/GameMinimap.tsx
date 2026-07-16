import type { GameSnapshot } from '@kingdoms/sim';
import { normalizeSnapshot } from '../game/snapshot';

const colors = ['#3488c9', '#d94e41', '#43a962', '#a146c3'];
const lanes = [
  'M50 9 Q88 10 91 50', 'M91 50 Q89 89 50 91', 'M50 91 Q11 89 9 50', 'M9 50 Q11 11 50 9',
  'M50 9 L91 50', 'M91 50 L50 91', 'M50 91 L9 50', 'M9 50 L50 9',
  'M50 9 L50 50', 'M91 50 L50 50', 'M50 91 L50 50', 'M9 50 L50 50',
];

export function GameMinimap({ snapshot, cameraQuarter }: { snapshot: GameSnapshot | null; cameraQuarter: number }) {
  const normalized = normalizeSnapshot(snapshot);
  const stride = normalized.units.length > 240 ? Math.ceil(normalized.units.length / 240) : 1;
  return (
    <div className="minimap-frame" aria-label="Minimapa norte arriba">
      <div className="minimap-bezel">
        <svg className="minimap" viewBox="0 0 100 100" role="img">
          <defs>
            <radialGradient id="mapGround" cx="50%" cy="45%" r="66%"><stop offset="0" stopColor="#526b2f" /><stop offset="1" stopColor="#293b22" /></radialGradient>
            <filter id="mapShadow"><feDropShadow dx="0" dy="1" stdDeviation="1" floodColor="#080b08" floodOpacity=".9" /></filter>
          </defs>
          <rect x="2" y="2" width="96" height="96" rx="14" fill="url(#mapGround)" stroke="#172018" strokeWidth="3" />
          <g className="minimap-roads">
            {lanes.map((path, index) => <path className="lane lane-edge" d={path} key={`e${index}`} />)}
            {lanes.map((path, index) => <path className="lane" d={path} key={index} />)}
            {lanes.slice(0, 4).map((path, index) => <path className="lane-highlight" d={path} key={`h${index}`} />)}
          </g>
          {[{x:50,y:9},{x:91,y:50},{x:50,y:91},{x:9,y:50}].map((point, index) => (
            <g key={index} filter="url(#mapShadow)">
              <circle cx={point.x} cy={point.y} r="5.4" fill="#1b2219" stroke="#c19857" strokeWidth="1.4" />
              <circle cx={point.x} cy={point.y} r="3.5" fill={colors[index]} stroke="#111711" strokeWidth=".8" />
            </g>
          ))}
          <circle cx="50" cy="50" r="6.2" fill="#24251d" stroke="#c19857" strokeWidth="1.4" />
          <circle cx="50" cy="50" r="3.5" fill={normalized.centerOwner >= 0 ? colors[normalized.centerOwner] : '#98714b'} stroke="#171b14" strokeWidth=".7" />
          {normalized.units.filter((_, index) => index % stride === 0).map((unit) => (
            <circle className="unit-dot" key={unit.id} cx={50 + unit.x * 0.57} cy={50 + unit.z * 0.57} r={normalized.units.length > 350 ? 0.65 : 0.9} fill={colors[unit.owner]} />
          ))}
          <g transform={`rotate(${cameraQuarter * -90} 50 50)`} filter="url(#mapShadow)">
            <path d="M50 1.5 46.5 8.5 53.5 8.5Z" fill="#f2d9a9" stroke="#171b14" strokeWidth="1" />
          </g>
        </svg>
      </div>
    </div>
  );
}
