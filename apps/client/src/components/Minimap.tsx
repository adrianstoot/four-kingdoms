import type { GameSnapshot } from '@kingdoms/sim';
import type { ReactElement } from 'react';
import { FACTION_CSS_COLORS } from '../game/factions';

const factionColors = FACTION_CSS_COLORS;

interface MinimapProps {
  snapshot: GameSnapshot | null;
  cameraQuarter: number;
}

const lanePaths = [
  'M50 9 Q91 9 91 50', 'M91 50 Q91 91 50 91',
  'M50 91 Q9 91 9 50', 'M9 50 Q9 9 50 9',
  'M50 9 L91 50', 'M91 50 L50 91', 'M50 91 L9 50', 'M9 50 L50 9',
  'M50 9 L50 50', 'M91 50 L50 50', 'M50 91 L50 50', 'M9 50 L50 50',
];

export function Minimap({ snapshot, cameraQuarter }: MinimapProps) {
  const count = snapshot?.entities.count ?? 0;
  const dots: ReactElement[] = [];
  if (snapshot) {
    const stride = count > 240 ? Math.ceil(count / 240) : 1;
    for (let index = 0; index < count; index += stride) {
      const x = (snapshot.entities.x[index] ?? 0) / 100;
      const z = (snapshot.entities.z[index] ?? 0) / 100;
      const owner = snapshot.entities.owner[index] ?? 0;
      dots.push(
        <circle
          className="unit-dot"
          key={snapshot.entities.id[index] ?? index}
          cx={50 + x * 0.57}
          cy={50 + z * 0.57}
          r={count > 350 ? 0.7 : 1}
          fill={factionColors[owner] ?? '#fff'}
        />,
      );
    }
  }

  return (
    <div className="minimap-frame" aria-label="Minimapa norte arriba">
      <svg className="minimap" viewBox="0 0 100 100" role="img">
        {lanePaths.map((path, index) => <path className="lane" d={path} key={index} />)}
        {[{x:50,y:9},{x:91,y:50},{x:50,y:91},{x:9,y:50}].map((point, index) => (
          <circle key={index} cx={point.x} cy={point.y} r="4.5" fill={factionColors[index]} stroke="#e8d18b" strokeWidth="1" />
        ))}
        <circle cx="50" cy="50" r="5.8" fill="#c29a48" stroke="#f1d987" strokeWidth="1.2" />
        {dots}
        <g transform={`rotate(${cameraQuarter * -90} 50 50)`}>
          <path d="M50 2 L46 10 L54 10 Z" fill="#fff3bf" stroke="#141b17" strokeWidth="1" />
        </g>
      </svg>
    </div>
  );
}
