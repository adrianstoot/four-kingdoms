import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { GameSnapshot } from '@kingdoms/sim';
import { WorldRenderer } from '../game/WorldRenderer';
import type { PlacementPreview, QualityPreset, WorldRendererMetrics } from '../game/types';

export interface GameCanvasHandle {
  rotate: (direction: -1 | 1) => void;
}

interface GameCanvasProps {
  snapshot: GameSnapshot | null;
  selectedCard: string | null;
  quality: QualityPreset;
  onPlacement: (placement: PlacementPreview) => void;
  onHover: (placement: PlacementPreview | null) => void;
  onMetrics: (metrics: WorldRendererMetrics) => void;
  onReady: (backend: 'webgpu' | 'webgl2') => void;
}

export const GameCanvas = forwardRef<GameCanvasHandle, GameCanvasProps>(function GameCanvas(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WorldRenderer | null>(null);
  const callbacksRef = useRef({
    onPlacement: props.onPlacement,
    onHover: props.onHover,
    onMetrics: props.onMetrics,
    onReady: props.onReady,
  });
  callbacksRef.current = {
    onPlacement: props.onPlacement,
    onHover: props.onHover,
    onMetrics: props.onMetrics,
    onReady: props.onReady,
  };

  useImperativeHandle(ref, () => ({
    rotate(direction) {
      rendererRef.current?.rotate(direction);
    },
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new WorldRenderer(canvas, {
      onDeploy: (placement) => callbacksRef.current.onPlacement(placement),
      onPlacementChange: (placement) => callbacksRef.current.onHover(placement),
      onMetrics: (metrics) => callbacksRef.current.onMetrics(metrics),
      onReady: (backend) => callbacksRef.current.onReady(backend),
    });
    rendererRef.current = renderer;
    let disposed = false;
    void renderer.init().catch((error: unknown) => {
      if (!disposed) console.error('Renderer initialization failed', error);
    });
    return () => {
      disposed = true;
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => { rendererRef.current?.setSnapshot(props.snapshot); }, [props.snapshot]);
  useEffect(() => { rendererRef.current?.setSelectedCard(props.selectedCard); }, [props.selectedCard]);
  useEffect(() => { rendererRef.current?.setQuality(props.quality); }, [props.quality]);

  return <canvas ref={canvasRef} className="game-canvas" aria-label="Campo de batalla 3D" tabIndex={0} />;
});
