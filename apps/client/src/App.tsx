import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { GameCommand, GameSnapshot } from '@kingdoms/sim';
import { GameCanvas, type GameCanvasHandle } from './components/GameCanvas';
import { CardHand, type CardDisplay } from './components/CardHand';
import { GameMinimap } from './components/GameMinimap';
import { SettingsPanel, type QualityLevel } from './components/SettingsPanel';
import { playSound, setAudioEnabled, setAudioVolume } from './audio';
import type { PlacementPreview, WorldRendererMetrics } from './game/types';
import { toUiSnapshot } from './game/uiSnapshot';

const factions = [
  { name: 'REINO AZUL', color: '#3488c9', heart: '#3f8fc8' },
  { name: 'DOMINIO CARMESÍ', color: '#d94e41', heart: '#dd5147' },
  { name: 'PACTO ESMERALDA', color: '#43a962', heart: '#45af69' },
  { name: 'CORTE VIOLETA', color: '#a146c3', heart: '#a94cc8' },
] as const;

const cards: readonly CardDisplay[] = [
  { id: 'guards', name: 'GUARDIANES', cost: 3, icon: '', atlasIndex: 0, accent: '#477fbd', description: 'Cuatro soldados cuerpo a cuerpo.' },
  { id: 'archers', name: 'ARQUEROS', cost: 3, icon: '', atlasIndex: 1, accent: '#6ea668', description: 'Tres atacantes a distancia.' },
  { id: 'knight', name: 'CABALLERO', cost: 4, icon: '', atlasIndex: 2, accent: '#6d82a9', description: 'Combatiente resistente de primera línea.' },
  { id: 'giant', name: 'GIGANTE', cost: 7, icon: '', atlasIndex: 3, accent: '#b8804e', description: 'Unidad de asedio que prioriza edificios.' },
  { id: 'cannon_tower', name: 'TORRE', cost: 4, icon: '', atlasIndex: 4, accent: '#8a8068', description: 'Defensa fija para los pads de carril.' },
  { id: 'commander', name: 'COMANDANTE', cost: 5, icon: '', atlasIndex: 5, accent: '#b65243', description: 'Héroe único con aura de mando.' },
  { id: 'fireball', name: 'BOLA DE FUEGO', cost: 4, icon: '', atlasIndex: 6, accent: '#d66135', description: 'Daño explosivo en un área.' },
  { id: 'chain_lightning', name: 'RELÁMPAGO', cost: 5, icon: '', atlasIndex: 7, accent: '#6b9fe5', description: 'Salta entre cuatro objetivos hostiles.' },
];

const spellCards = new Set(['fireball', 'chain_lightning']);
type ScreenMode = 'title' | 'playing' | 'finished';

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function Icon({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <svg className={`hud-icon ${className}`} viewBox="0 0 32 32" aria-hidden="true">{children}</svg>;
}

function HeartIcon() {
  return <Icon className="heart-icon"><path d="M16 27S4 19.7 4 10.8C4 4.8 11.8 2.3 16 8c4.2-5.7 12-3.2 12 2.8C28 19.7 16 27 16 27Z" /></Icon>;
}

function HourglassIcon() {
  return <Icon><path d="M9 4h14M9 28h14M11 5c0 6 1.6 8 5 11-3.4 3-5 5-5 11m10-22c0 6-1.6 8-5 11 3.4 3 5 5 5 11M12 10h8M12 23h8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></Icon>;
}

function DropIcon() {
  return <Icon className="drop-icon"><path d="M16 2C12 10 6.5 15.4 6.5 21A9.5 9.5 0 0 0 25.5 21C25.5 15.4 20 10 16 2Z" /></Icon>;
}

export function App() {
  const workerRef = useRef<Worker | null>(null);
  const canvasRef = useRef<GameCanvasHandle>(null);
  const sequenceRef = useRef(1);
  const previousCenterRef = useRef(-1);
  const finishedRef = useRef(false);
  const [mode, setMode] = useState<ScreenMode>('title');
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [placement, setPlacement] = useState<PlacementPreview | null>(null);
  const [paused, setPaused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quality, setQuality] = useState<QualityLevel>('medium');
  const [audioEnabled, setAudio] = useState(true);
  const [volume, setVolume] = useState(0.72);
  const [showPerf, setShowPerf] = useState(false);
  const [cameraQuarter, setCameraQuarter] = useState(0);
  const [backend, setBackend] = useState<'loading' | 'webgpu' | 'webgl2'>('loading');
  const [metrics, setMetrics] = useState<WorldRendererMetrics | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const ui = useMemo(() => toUiSnapshot(snapshot), [snapshot]);
  const player = ui.players[0]!;

  useEffect(() => {
    const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; snapshot?: GameSnapshot; reason?: string };
      if (message.type === 'snapshot' && message.snapshot) {
        const nextUi = toUiSnapshot(message.snapshot);
        if (previousCenterRef.current !== nextUi.centerOwner && nextUi.centerOwner >= 0) playSound('capture');
        previousCenterRef.current = nextUi.centerOwner;
        setSnapshot(message.snapshot);
        if ((nextUi.winner !== null || nextUi.draw || nextUi.phase === 'finished') && !finishedRef.current) {
          finishedRef.current = true;
          setMode('finished');
          playSound('victory');
        }
      } else if (message.type === 'commandRejected') {
        setNotice(message.reason ?? 'Despliegue rechazado');
        window.setTimeout(() => setNotice(null), 1400);
      }
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const startMatch = useCallback(() => {
    finishedRef.current = false;
    previousCenterRef.current = -1;
    setSelectedCard(null);
    setPaused(false);
    setMode('playing');
    sequenceRef.current = 1;
    const seed = Math.floor(Date.now() % 0x7fffffff);
    workerRef.current?.postMessage({ type: 'start', seed, maxEntities: 768 });
    playSound('deploy');
  }, []);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('play')) return;
    const timer = window.setTimeout(startMatch, 120);
    return () => window.clearTimeout(timer);
  }, [startMatch]);

  const selectCard = useCallback((cardId: string) => {
    setSelectedCard((current) => current === cardId ? null : cardId);
    playSound('click');
  }, []);

  const handlePlacement = useCallback((preview: PlacementPreview) => {
    if (!selectedCard || mode !== 'playing' || paused) return;
    if (!preview.valid) {
      setNotice('Elige un tramo válido del carril');
      playSound('click');
      return;
    }
    const isSpell = spellCards.has(selectedCard);
    const command = {
      type: isSpell ? 'spell' : 'deploy',
      playerId: 0,
      cardId: selectedCard,
      sequence: sequenceRef.current++,
      tick: ui.tick,
      position: { x: preview.x, z: preview.z },
      routeId: isSpell ? undefined : preview.routeId,
    } as GameCommand;
    workerRef.current?.postMessage({ type: 'command', command });
    playSound(isSpell ? 'spell' : 'deploy');
    setSelectedCard(null);
  }, [mode, paused, selectedCard, ui.tick]);

  const togglePause = useCallback(() => {
    setPaused((current) => {
      const next = !current;
      workerRef.current?.postMessage({ type: 'pause', paused: next });
      return next;
    });
    playSound('click');
  }, []);

  const rotate = useCallback((direction: -1 | 1) => {
    canvasRef.current?.rotate(direction);
    setCameraQuarter((quarter) => (quarter + direction + 4) % 4);
    playSound('click');
  }, []);

  const handleAudio = useCallback((enabled: boolean) => {
    setAudio(enabled);
    setAudioEnabled(enabled);
  }, []);

  const handleVolume = useCallback((next: number) => {
    setVolume(next);
    setAudioVolume(next);
  }, []);

  const centerFaction = ui.centerOwner >= 0 ? (factions[ui.centerOwner] ?? null) : null;
  const centerLabel = centerFaction
    ? `CONTROL ${centerFaction.name.replace('REINO ', '').replace('DOMINIO ', '').replace('PACTO ', '').replace('CORTE ', '')}`
    : ui.centerProgress > 0 ? `CAPTURA ${Math.round(ui.centerProgress * 100)}%` : 'NEUTRAL';
  const resultTitle = ui.draw ? 'EMPATE DE CENIZA' : ui.winner === 0 || ui.winner === 2 ? 'VICTORIA DEL EQUIPO AZUL' : 'VICTORIA DEL EQUIPO RIVAL';
  const resultText = ui.draw
    ? 'Los dos equipos perdieron sus últimos castillos al mismo tiempo.'
    : ui.winner === 0 || ui.winner === 2
      ? 'Tú y la IA Esmeralda habéis derrotado a los dos reinos rivales.'
      : 'Las IA Carmesí y Violeta han destruido los castillos de tu equipo.';
  const nextElixir = player.elixir >= player.maxElixir ? 0 : Math.max(0, 2.5 - (ui.seconds % 2.5));
  // Keep the reference's ten large gems while each gem now represents ten
  // elixir. Rendering one hundred DOM cells makes the meter unreadable.
  const elixirSegments = 10;
  const filledElixir = player.elixir <= 0 ? 0 : Math.ceil((player.elixir / Math.max(1, player.maxElixir)) * elixirSegments);

  return (
    <main className="game-shell">
      <GameCanvas
        ref={canvasRef}
        snapshot={snapshot}
        selectedCard={selectedCard}
        quality={quality}
        onPlacement={handlePlacement}
        onHover={setPlacement}
        onMetrics={setMetrics}
        onReady={setBackend}
      />

      {mode !== 'title' && (
        <div className="hud">
          <div className="objective-stack">
            <section className="objective-panel" style={{ '--objective-color': centerFaction?.color ?? '#c7a361' } as CSSProperties}>
              <button className="menu-button" type="button" onClick={() => setSettingsOpen((open) => !open)} aria-label="Abrir menú"><span /><span /><span /></button>
              <div className="objective-copy"><span>CÍRCULO CENTRAL</span><strong>{centerLabel}</strong></div>
            </section>
            <div className="match-clock"><HourglassIcon /><strong>{formatTime(ui.seconds)}</strong></div>
          </div>

          <div className="top-bar">
            {ui.castles.map((castle, index) => {
              const faction = factions[index] ?? factions[0];
              return (
                <div className={`kingdom-status${index === 0 ? ' player' : ''}${!castle.alive ? ' dead' : ''}`} key={index} style={{ '--faction-color': faction.color } as CSSProperties}>
                  <div className="kingdom-name">{faction.name}</div>
                  <div className="kingdom-health"><HeartIcon /><strong>{Math.max(0, Math.ceil(castle.health))}</strong></div>
                  <div className="health-track"><div className="health-fill" style={{ '--health': `${Math.max(0, castle.health / castle.maxHealth) * 100}%` } as CSSProperties} /></div>
                </div>
              );
            })}
          </div>

          <div className="top-controls">
            <button className="utility-button pause-button" type="button" onClick={togglePause} aria-label={paused ? 'Continuar' : 'Pausar'}><span>{paused ? '▶' : 'Ⅱ'}</span></button>
            <button className="utility-button settings-button" type="button" onClick={() => setSettingsOpen((open) => !open)} aria-label="Ajustes"><span>⚙</span></button>
          </div>

          <div className="camera-cluster">
            <button className="camera-button" type="button" onClick={() => rotate(-1)} title="Girar izquierda (Q)" aria-label="Girar izquierda">↶</button>
            <button className="camera-button" type="button" onClick={() => rotate(1)} title="Girar derecha (E)" aria-label="Girar derecha">↷</button>
          </div>

          <GameMinimap snapshot={snapshot} cameraQuarter={cameraQuarter} />
          <CardHand cards={cards} selectedId={selectedCard} elixir={player.elixir} cooldowns={player.cooldowns} onSelect={selectCard} />

          <section className="elixir-panel" aria-label="Elixir disponible">
            <div className="elixir-heading">
              <DropIcon />
              <strong>{Math.floor(player.elixir)}</strong>
              <span>MÁX. {player.maxElixir}</span>
            </div>
            <div className="elixir-segments" aria-hidden="true">
              {Array.from({ length: elixirSegments }, (_, index) => <i className={index < filledElixir ? 'filled' : ''} key={index} />)}
            </div>
            <div className="elixir-next">SIGUIENTE: {formatTime(nextElixir)}</div>
          </section>

          {selectedCard && <div className="placement-tip">{placement?.valid ? 'CLIC PARA DESPLEGAR' : spellCards.has(selectedCard) ? 'APUNTA A CUALQUIER CARRIL' : 'COLOCA LA CARTA EN TU ZONA'} · ESC PARA CANCELAR</div>}
          {notice && <div className="placement-tip">{notice.toUpperCase()}</div>}

          {showPerf && metrics && (
            <div className="perf-panel">
              <div><span>{backend.toUpperCase()}</span><strong>{metrics.fps.toFixed(0)} FPS</strong></div>
              <div><span>P95</span><strong>{metrics.p95FrameTimeMs.toFixed(1)} ms</strong></div>
              <div><span>TROPAS</span><strong>{ui.unitCount}</strong></div>
              <div><span>TRIÁNGULOS</span><strong>{Math.round(metrics.triangles / 1000)}k</strong></div>
            </div>
          )}

          {settingsOpen && (
            <SettingsPanel
              quality={quality}
              audio={audioEnabled}
              volume={volume}
              showPerf={showPerf}
              onQuality={setQuality}
              onAudio={handleAudio}
              onVolume={handleVolume}
              onPerf={setShowPerf}
            />
          )}
        </div>
      )}

      {paused && mode === 'playing' && <div className="paused-banner">PAUSA</div>}

      {mode === 'title' && (
        <section className="title-screen">
          <div className="title-card">
            <p className="eyebrow">BATALLA LOCAL · 2 CONTRA 2 · IA MEDIA</p>
            <div className="crest-mark"><span>IV</span></div>
            <h1 className="game-title">CUATRO<br />REINOS</h1>
            <p className="game-subtitle">Dirige el Reino Azul junto al Pacto Esmeralda. Despliega tus ocho cartas, conquista el círculo central y destruye los castillos Carmesí y Violeta.</p>
            <button type="button" className="primary-button" onClick={startMatch}>COMENZAR BATALLA</button>
            <div className="feature-row"><span>UN JUGADOR</span><span>3 IA MEDIAS</span><span>SIN MULTIJUGADOR</span></div>
          </div>
        </section>
      )}

      {mode === 'finished' && (
        <section className="result-screen">
          <div className="result-card">
            <p className="eyebrow">PARTIDA FINALIZADA · {formatTime(ui.seconds)}</p>
            <h2 className="game-title result-title">{resultTitle}</h2>
            <p className="game-subtitle">{resultText}</p>
            <button type="button" className="primary-button" onClick={startMatch}>JUGAR OTRA VEZ</button>
          </div>
        </section>
      )}
    </main>
  );
}
