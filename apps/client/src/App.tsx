import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { GameCommand, GameSnapshot } from '@kingdoms/sim';
import { GameCanvas, type GameCanvasHandle } from './components/GameCanvas';
import { CardHand, type CardDisplay } from './components/CardHand';
import { GameMinimap } from './components/GameMinimap';
import { SettingsPanel, type QualityLevel } from './components/SettingsPanel';
import { playSound, setAudioEnabled, setAudioVolume } from './audio';
import type { CameraPose, PlacementPreview, RendererResourceProgress, WorldRendererMetrics } from './game/types';
import { toUiSnapshot } from './game/uiSnapshot';
import titleBackground from './assets/insect-title-background.svg';
import loadingBackground from './assets/insect-loading-background.svg';
import { FACTION_STYLES } from './game/factions';

const factions = FACTION_STYLES;

const cards: readonly CardDisplay[] = [
  { id: 'guards', name: 'HORMIGA SOLDADO', cost: 3, icon: '', atlasIndex: 0, accent: '#b74432', description: 'Soldado acorazado con mandíbulas de choque.' },
  { id: 'archers', name: 'ABEJA AGUIJÓN', cost: 3, icon: '', atlasIndex: 1, accent: '#d8a92c', description: 'Hostiga desde el aire con aguijones de néctar endurecido.' },
  { id: 'knight', name: 'MANTIS CAZADORA', cost: 4, icon: '', atlasIndex: 2, accent: '#6ca24b', description: 'Depredadora veloz con cuchillas raptoras.' },
  { id: 'giant', name: 'ESCARABAJO TITÁN', cost: 7, icon: '', atlasIndex: 3, accent: '#76513f', description: 'Ariete viviente que prioriza hormigueros y torres.' },
  { id: 'cannon_tower', name: 'TORRE TERMITA', cost: 4, icon: '', atlasIndex: 4, accent: '#b68b52', description: 'Nido defensivo que dispara resina a presión.' },
  { id: 'commander', name: 'MONARCA', cost: 5, icon: '', atlasIndex: 5, accent: '#e27a2e', description: 'Mariposa heroica que coordina el enjambre.' },
  { id: 'fireball', name: 'BOMBA ÁCIDA', cost: 4, icon: '', atlasIndex: 6, accent: '#80c43d', description: 'Glóbulo corrosivo lanzado desde tu hormiguero.' },
  { id: 'chain_lightning', name: 'ENJAMBRE ELÉCTRICO', cost: 5, icon: '', atlasIndex: 7, accent: '#55c8e9', description: 'Luciérnagas ionizadas encadenan hasta cuatro objetivos.' },
];

const spellCards = new Set(['fireball', 'chain_lightning']);
const INITIAL_CAMERA_POSE: CameraPose = {
  yaw: Math.PI * 1.25,
  pitch: Math.PI * 0.25,
  distance: 112,
  target: { x: 0, y: 0, z: 0 },
};

type ScreenMode = 'title' | 'loading' | 'playing' | 'finished' | 'error';

type WorkerMessage =
  | { type: 'snapshot'; snapshot: GameSnapshot; sessionId?: number; firstSnapshot?: boolean }
  | { type: 'commandRejected'; reason?: string; sessionId?: number }
  | { type: 'error'; reason?: string; sessionId?: number }
  | { type?: string; snapshot?: GameSnapshot; reason?: string; sessionId?: number };

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function rejectionMessage(reason?: string): string {
  switch (reason) {
    case 'insufficient-elixir': return 'No tienes suficiente néctar';
    case 'card-on-cooldown': return 'La criatura todavía se está preparando';
    case 'outside-deployment-zone': return 'Despliega dentro de tu zona del carril';
    case 'too-far-from-lane': return 'Acerca el cursor al centro del camino';
    case 'no-tower-pad': return 'La torre solo puede colocarse en un pad lateral';
    default: return reason ? `Despliegue rechazado: ${reason}` : 'No se pudo completar el despliegue';
  }
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
  const sessionCounterRef = useRef(0);
  const expectedSessionRef = useRef(0);
  const modeRef = useRef<ScreenMode>('title');
  const previousCenterRef = useRef(-1);
  const finishedRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);
  const rotateTimerRef = useRef<number | null>(null);

  const [mode, setMode] = useState<ScreenMode>('title');
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [snapshotSessionId, setSnapshotSessionId] = useState(0);
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [placement, setPlacement] = useState<PlacementPreview | null>(null);
  const [paused, setPaused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quality, setQuality] = useState<QualityLevel>('medium');
  const [audioEnabled, setAudio] = useState(true);
  const [volume, setVolume] = useState(0.72);
  const [showPerf, setShowPerf] = useState(false);
  const [backend, setBackend] = useState<'loading' | 'webgpu' | 'webgl2'>('loading');
  const [metrics, setMetrics] = useState<WorldRendererMetrics | null>(null);
  const [cameraPose, setCameraPose] = useState<CameraPose>(INITIAL_CAMERA_POSE);
  const [notice, setNotice] = useState<string | null>(null);
  const [rendererGeneration, setRendererGeneration] = useState(0);
  const [rendererReady, setRendererReady] = useState(false);
  const [resourcesReady, setResourcesReady] = useState(false);
  const [resourceProgress, setResourceProgress] = useState(0);
  const [resourceLabel, setResourceLabel] = useState('Preparando escenario');
  const [firstSnapshot, setFirstSnapshot] = useState(false);
  const [firstFrame, setFirstFrame] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const ui = useMemo(() => toUiSnapshot(snapshot), [snapshot]);
  const player = ui.players[0]!;
  const titleStyle = useMemo(() => ({ '--screen-image': `url("${titleBackground}")` }) as CSSProperties, []);
  const loadingStyle = useMemo(() => ({ '--screen-image': `url("${loadingBackground}")` }) as CSSProperties, []);

  const showNotice = useCallback((message: string, duration = 1700) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, duration);
  }, []);

  const cancelSelection = useCallback(() => {
    setSelectedCard(null);
    setPlacement(null);
  }, []);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'snapshot' && message.snapshot) {
        const expectedSession = expectedSessionRef.current;
        const belongsToActiveSession = expectedSession > 0
          && (message.sessionId === expectedSession || message.sessionId === undefined);

        if (message.sessionId !== undefined && expectedSession > 0 && message.sessionId !== expectedSession) return;

        if (belongsToActiveSession) {
          setSnapshot(message.snapshot);
          setSnapshotSessionId(expectedSession);
          setFirstSnapshot(true);
        } else if (modeRef.current === 'title') {
          // Warm the renderer with the worker's idle snapshot without counting
          // it as the first frame of a match.
          setSnapshot(message.snapshot);
          setSnapshotSessionId(0);
        } else {
          return;
        }

        const nextUi = toUiSnapshot(message.snapshot);
        if (previousCenterRef.current !== nextUi.centerOwner && nextUi.centerOwner >= 0) playSound('capture');
        previousCenterRef.current = nextUi.centerOwner;

        if (
          belongsToActiveSession
          && modeRef.current === 'playing'
          && (nextUi.winner !== null || nextUi.draw || nextUi.phase === 'finished')
          && !finishedRef.current
        ) {
          finishedRef.current = true;
          modeRef.current = 'finished';
          setMode('finished');
          cancelSelection();
          playSound('victory');
        }
      } else if (message.type === 'commandRejected') {
        showNotice(rejectionMessage(message.reason));
        playSound('click');
      } else if (message.type === 'error') {
        setLoadError(message.reason ?? 'La simulación no pudo iniciar la partida.');
        modeRef.current = 'error';
        setMode('error');
      }
    };

    worker.onerror = () => {
      setLoadError('El proceso de simulación dejó de responder.');
      modeRef.current = 'error';
      setMode('error');
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [cancelSelection, showNotice]);

  useEffect(() => () => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    if (rotateTimerRef.current !== null) window.clearInterval(rotateTimerRef.current);
  }, []);

  const startMatch = useCallback((restartRenderer = false) => {
    const worker = workerRef.current;
    if (!worker) {
      setLoadError('La simulación todavía no está disponible.');
      modeRef.current = 'error';
      setMode('error');
      return;
    }

    const sessionId = ++sessionCounterRef.current;
    expectedSessionRef.current = sessionId;
    finishedRef.current = false;
    previousCenterRef.current = -1;
    sequenceRef.current = 1;
    modeRef.current = 'loading';

    setLoadError(null);
    setSelectedCard(null);
    setPlacement(null);
    setPaused(false);
    setSettingsOpen(false);
    setSnapshot(null);
    setSnapshotSessionId(0);
    setFirstSnapshot(false);
    setFirstFrame(false);
    setMode('loading');

    if (restartRenderer) {
      setRendererGeneration((generation) => generation + 1);
      setRendererReady(false);
      setResourcesReady(false);
      setResourceProgress(0);
      setResourceLabel('Preparando escenario');
      setBackend('loading');
    }

    const seed = Math.floor(Date.now() % 0x7fffffff);
    worker.postMessage({ type: 'start', sessionId, seed, maxEntities: 768 });
    playSound('click');
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autoplay') !== '1') return;
    const timer = window.setTimeout(() => startMatch(), 120);
    return () => window.clearTimeout(timer);
  }, [startMatch]);

  useEffect(() => {
    if (mode !== 'loading') return;
    if (rendererReady && resourcesReady && firstSnapshot && firstFrame) {
      modeRef.current = 'playing';
      setMode('playing');
      playSound('deploy');
    }
  }, [firstFrame, firstSnapshot, mode, rendererReady, resourcesReady]);

  useEffect(() => {
    if (mode !== 'loading') return;
    const timeout = window.setTimeout(() => {
      setLoadError('La carga superó el tiempo esperado. Comprueba la aceleración 3D y vuelve a intentarlo.');
      modeRef.current = 'error';
      setMode('error');
    }, 18000);
    return () => window.clearTimeout(timeout);
  }, [mode, rendererReady, resourcesReady, firstSnapshot, firstFrame]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Escape') return;
      if (selectedCard) {
        event.preventDefault();
        cancelSelection();
        playSound('click');
      } else if (settingsOpen) {
        setSettingsOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancelSelection, selectedCard, settingsOpen]);

  useEffect(() => {
    if (selectedCard) canvasRef.current?.recalculatePlacement();
  }, [cameraPose, selectedCard]);

  const selectCard = useCallback((cardId: string) => {
    setSelectedCard(cardId);
    setPlacement(null);
    const card = cards.find((candidate) => candidate.id === cardId);
    const cooldown = player.cooldowns[cardId] ?? 0;
    if (card && player.elixir + 0.001 < card.cost) {
      showNotice(`Necesitas ${Math.ceil(card.cost - player.elixir)} más de néctar; la selección seguirá activa.`, 2200);
    } else if (cooldown > 0) {
      showNotice('La selección seguirá activa hasta que termine la preparación.', 2200);
    }
    playSound('click');
  }, [player.cooldowns, player.elixir, showNotice]);

  const handlePlacement = useCallback((preview: PlacementPreview) => {
    if (!selectedCard || mode !== 'playing' || paused) return;
    if (!preview.valid) {
      const message = preview.reason === 'invalid-pad'
        ? 'La torre solo puede colocarse en un pad lateral'
        : preview.reason === 'enemy-zone'
          ? 'Selecciona uno de tus cinco tramos de despliegue'
          : 'Acerca el cursor al centro del camino';
      showNotice(message);
      playSound('click');
      return;
    }

    const card = cards.find((candidate) => candidate.id === selectedCard);
    if (!card) return;
    if (player.elixir + 0.001 < card.cost) {
      showNotice(`Necesitas ${Math.ceil(card.cost - player.elixir)} más de néctar; la criatura sigue seleccionada.`, 2100);
      playSound('click');
      return;
    }
    if ((player.cooldowns[selectedCard] ?? 0) > 0) {
      showNotice('Esta criatura aún se está preparando; la selección sigue activa.', 1900);
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

    workerRef.current?.postMessage({
      type: 'command',
      sessionId: expectedSessionRef.current,
      command,
    });
    setNotice(null);
    playSound(isSpell ? 'spell' : 'deploy');
    // Selection is intentionally persistent for rapid repeated deployment.
  }, [mode, paused, player.cooldowns, player.elixir, selectedCard, showNotice, ui.tick]);

  const togglePause = useCallback(() => {
    setPaused((current) => {
      const next = !current;
      workerRef.current?.postMessage({ type: 'pause', sessionId: expectedSessionRef.current, paused: next });
      return next;
    });
    playSound('click');
  }, []);

  const rotate = useCallback((direction: -1 | 1) => {
    canvasRef.current?.rotate(direction);
  }, []);

  const stopRotate = useCallback(() => {
    if (rotateTimerRef.current !== null) {
      window.clearInterval(rotateTimerRef.current);
      rotateTimerRef.current = null;
    }
  }, []);

  const startRotate = useCallback((direction: -1 | 1) => {
    stopRotate();
    rotate(direction);
    rotateTimerRef.current = window.setInterval(() => rotate(direction), 90);
    playSound('click');
  }, [rotate, stopRotate]);

  const handleRendererReady = useCallback((nextBackend: 'webgpu' | 'webgl2') => {
    setBackend(nextBackend);
    setRendererReady(true);
  }, []);

  const handleResourceProgress = useCallback((progress: RendererResourceProgress) => {
    setResourceProgress(Math.max(0, Math.min(1, progress.progress)));
    if (progress.label) setResourceLabel(progress.label);
  }, []);

  const handleFirstFrame = useCallback((sessionId: number) => {
    if (sessionId === expectedSessionRef.current) setFirstFrame(true);
  }, []);

  const handleRendererError = useCallback((error: Error) => {
    setLoadError(`No se pudo iniciar el renderizador 3D: ${error.message}`);
    modeRef.current = 'error';
    setMode('error');
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
    ? `CONTROL ${centerFaction.name}`
    : ui.centerProgress > 0 ? `CAPTURA ${Math.round(ui.centerProgress * 100)}%` : 'NEUTRAL';
  const resultTitle = ui.draw ? 'EQUILIBRIO DEL ENJAMBRE' : ui.winner === 0 || ui.winner === 2 ? 'VICTORIA DE LA ALIANZA ZAFIRO' : 'VICTORIA DEL ENJAMBRE RIVAL';
  const resultText = ui.draw
    ? 'Los dos equipos perdieron sus últimos hormigueros al mismo tiempo.'
    : ui.winner === 0 || ui.winner === 2
      ? 'Tu colonia y el Nido Esmeralda han conquistado los dos hormigueros rivales.'
      : 'El Enjambre Rubí y la Colmena Amatista han invadido vuestra red de túneles.';
  const nextElixir = player.elixir >= player.maxElixir ? 0 : Math.max(0, 2.5 - (ui.seconds % 2.5));
  const elixirSegments = 10;
  const filledElixir = player.elixir <= 0 ? 0 : Math.ceil((player.elixir / Math.max(1, player.maxElixir)) * elixirSegments);
  const loadingProgress = Math.min(
    rendererReady && resourcesReady && firstSnapshot && firstFrame ? 1 : 0.99,
    (rendererReady ? 0.2 : 0) + resourceProgress * 0.4 + (firstSnapshot ? 0.2 : 0) + (firstFrame ? 0.2 : 0),
  );
  const loadingLabel = !rendererReady
    ? 'INICIANDO MOTOR 3D'
    : !resourcesReady
      ? resourceLabel.toUpperCase()
      : !firstSnapshot
        ? 'SINCRONIZANDO LA PARTIDA'
        : !firstFrame
          ? 'COMPONIENDO EL CAMPO DE BATALLA'
          : 'LAS COLONIAS ESTÁN LISTAS';

  return (
    <main className={`game-shell mode-${mode}`}>
      <GameCanvas
        key={rendererGeneration}
        ref={canvasRef}
        snapshot={snapshot}
        snapshotSessionId={snapshotSessionId}
        selectedCard={selectedCard}
        quality={quality}
        interactive={mode === 'playing' && !paused}
        onPlacement={handlePlacement}
        onHover={setPlacement}
        onMetrics={setMetrics}
        onRendererReady={handleRendererReady}
        onResourcesReady={() => {
          setResourceProgress(1);
          setResourcesReady(true);
        }}
        onResourceProgress={handleResourceProgress}
        onFirstFrame={handleFirstFrame}
        onCameraPoseChange={setCameraPose}
        onCancelSelection={cancelSelection}
        onError={handleRendererError}
      />

      {(mode === 'playing' || mode === 'finished') && (
        <div className="hud">
          <div className="objective-stack">
            <section className="objective-panel" style={{ '--objective-color': centerFaction?.color ?? '#c7a361' } as CSSProperties}>
              <button className="menu-button" type="button" onClick={() => setSettingsOpen((open) => !open)} aria-label="Abrir menú"><span /><span /><span /></button>
              <div className="objective-copy"><span>CORAZÓN DEL BOSQUE</span><strong>{centerLabel}</strong></div>
            </section>
            <div className="match-clock"><HourglassIcon /><strong>{formatTime(ui.seconds)}</strong></div>
          </div>

          <div className="top-bar">
            {ui.castles.map((castle, index) => {
              const faction = factions[index] ?? factions[0];
              return (
                <div className={`kingdom-status${index === 0 ? ' player' : ''}${!castle.alive ? ' dead' : ''}`} key={index} style={{ '--faction-color': faction.cssColor } as CSSProperties}>
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
            <button
              className="camera-button"
              type="button"
              onPointerDown={() => startRotate(-1)}
              onPointerUp={stopRotate}
              onPointerCancel={stopRotate}
              onPointerLeave={stopRotate}
              onClick={(event) => { if (event.detail === 0) rotate(-1); }}
              title="Mantén pulsado para girar a la izquierda (Q)"
              aria-label="Girar cámara a la izquierda"
            >↶</button>
            <button
              className="camera-button"
              type="button"
              onPointerDown={() => startRotate(1)}
              onPointerUp={stopRotate}
              onPointerCancel={stopRotate}
              onPointerLeave={stopRotate}
              onClick={(event) => { if (event.detail === 0) rotate(1); }}
              title="Mantén pulsado para girar a la derecha (E)"
              aria-label="Girar cámara a la derecha"
            >↷</button>
          </div>

          <GameMinimap snapshot={snapshot} cameraPose={cameraPose} />
          <CardHand cards={cards} selectedId={selectedCard} elixir={player.elixir} cooldowns={player.cooldowns} onSelect={selectCard} />

          <section className="elixir-panel" aria-label="Néctar disponible">
            <div className="elixir-heading">
              <DropIcon />
              <strong>{Math.floor(player.elixir)}</strong>
              <span>MÁX. {player.maxElixir} NÉCTAR</span>
            </div>
            <div className="elixir-segments" aria-hidden="true">
              {Array.from({ length: elixirSegments }, (_, index) => <i className={index < filledElixir ? 'filled' : ''} key={index} />)}
            </div>
            <div className="elixir-next">SIGUIENTE: {formatTime(nextElixir)}</div>
          </section>

          {selectedCard && !notice && (
            <div className={`placement-tip${placement?.valid ? ' valid' : ''}`}>
              {placement?.valid
                ? 'CLIC PARA DESPLEGAR DE NUEVO'
                : spellCards.has(selectedCard)
                  ? 'APUNTA AL CENTRO DE CUALQUIER CARRIL'
                  : 'ELIGE UNO DE TUS TRAMOS DE CAMINO'} · ESC O CLIC DERECHO PARA CANCELAR
            </div>
          )}
          {notice && <div className="placement-tip notice-tip" role="status">{notice.toUpperCase()}</div>}

          {showPerf && metrics && (
            <div className="perf-panel">
              <div><span>{backend.toUpperCase()}</span><strong>{metrics.fps.toFixed(0)} FPS</strong></div>
              <div><span>P95</span><strong>{metrics.p95FrameTimeMs.toFixed(1)} ms</strong></div>
              <div><span>CRIATURAS</span><strong>{ui.unitCount}</strong></div>
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
        <section className="cinematic-screen title-screen" style={titleStyle}>
          <div className="cinematic-shade" />
          <div className="title-hero">
            <p className="eyebrow">GUERRA ESTRATÉGICA DEL MICROMUNDO · 2 CONTRA 2</p>
            <div className="crest-mark insect-crest"><span>✦</span></div>
            <h1 className="game-title">IMPERIOS<br />DEL ENJAMBRE</h1>
            <p className="game-subtitle">Guía a la Colonia Zafiro, conquista las raíces y domina el corazón vivo del bosque.</p>
            <button type="button" className="primary-button play-button" onClick={() => startMatch()}>JUGAR</button>
            <div className="title-controls"><span>WASD MOVER</span><span>RUEDA ZOOM</span><span>BOTÓN DERECHO ROTAR</span></div>
          </div>
        </section>
      )}

      {mode === 'loading' && (
        <section className="cinematic-screen loading-screen" style={loadingStyle} aria-live="polite">
          <div className="cinematic-shade" />
          <div className="loading-panel">
            <div className="loading-sigil" aria-hidden="true"><i /><i /><i /><span>IV</span></div>
            <p className="eyebrow">PREPARANDO LAS COLONIAS…</p>
            <h2>{loadingLabel}</h2>
            <div className="loading-track" role="progressbar" aria-label="Carga de la partida" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(loadingProgress * 100)}>
              <div style={{ width: `${loadingProgress * 100}%` }} />
            </div>
            <div className="loading-checkpoints" aria-hidden="true">
              <span className={rendererReady ? 'ready' : ''}>MOTOR 3D</span>
              <span className={resourceProgress >= 0.5 ? 'ready' : ''}>TEXTURAS</span>
              <span className={resourcesReady ? 'ready' : ''}>CRIATURAS</span>
              <span className={firstSnapshot ? 'ready' : ''}>PARTIDA</span>
              <span className={firstFrame ? 'ready' : ''}>PRIMER FRAME</span>
            </div>
          </div>
        </section>
      )}

      {mode === 'error' && (
        <section className="cinematic-screen error-screen" style={loadingStyle}>
          <div className="cinematic-shade" />
          <div className="result-card error-card" role="alert">
            <p className="eyebrow">NO SE PUDO DESPERTAR EL MICROMUNDO</p>
            <h2 className="game-title result-title">EL ENJAMBRE ESPERA</h2>
            <p className="game-subtitle">{loadError ?? 'Ha ocurrido un error inesperado durante la carga.'}</p>
            <button type="button" className="primary-button" onClick={() => startMatch(true)}>REINTENTAR</button>
            <button type="button" className="secondary-button" onClick={() => {
              if (expectedSessionRef.current > 0) {
                workerRef.current?.postMessage({ type: 'pause', sessionId: expectedSessionRef.current, paused: true });
              }
              expectedSessionRef.current = 0;
              setRendererGeneration((generation) => generation + 1);
              setRendererReady(false);
              setResourcesReady(false);
              setResourceProgress(0);
              setResourceLabel('Preparando escenario');
              setBackend('loading');
              setSnapshot(null);
              setSnapshotSessionId(0);
              setFirstSnapshot(false);
              setFirstFrame(false);
              cancelSelection();
              modeRef.current = 'title';
              setMode('title');
              setLoadError(null);
            }}>VOLVER A PORTADA</button>
          </div>
        </section>
      )}

      {mode === 'finished' && (
        <section className="result-screen">
          <div className="result-card">
            <p className="eyebrow">PARTIDA FINALIZADA · {formatTime(ui.seconds)}</p>
            <h2 className="game-title result-title">{resultTitle}</h2>
            <p className="game-subtitle">{resultText}</p>
            <button type="button" className="primary-button" onClick={() => startMatch()}>JUGAR OTRA VEZ</button>
          </div>
        </section>
      )}
    </main>
  );
}
