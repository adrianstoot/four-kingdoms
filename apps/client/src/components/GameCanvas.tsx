import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { GameSnapshot } from '@kingdoms/sim';
import { WorldRenderer } from '../game/WorldRenderer';
import type {
  CameraPose,
  PlacementPreview,
  QualityPreset,
  RendererResourceProgress,
  WorldRendererMetrics,
} from '../game/types';

export interface GameCanvasHandle {
  rotate: (direction: -1 | 1) => void;
  recalculatePlacement: () => void;
}

interface GameCanvasProps {
  snapshot: GameSnapshot | null;
  snapshotSessionId: number;
  selectedCard: string | null;
  quality: QualityPreset;
  interactive: boolean;
  onPlacement: (placement: PlacementPreview) => void;
  onHover: (placement: PlacementPreview | null) => void;
  onMetrics: (metrics: WorldRendererMetrics) => void;
  onRendererReady: (backend: 'webgpu' | 'webgl2') => void;
  onResourcesReady: () => void;
  onResourceProgress: (progress: RendererResourceProgress) => void;
  onFirstFrame: (sessionId: number) => void;
  onCameraPoseChange: (pose: CameraPose) => void;
  onCancelSelection: () => void;
  onError: (error: Error) => void;
}

type ExtendedRenderer = WorldRenderer & {
  recalculatePlacement?: () => void;
};

type ExtendedRendererCallbacks = NonNullable<ConstructorParameters<typeof WorldRenderer>[1]> & {
  onResourcesReady?: () => void;
  onResourceProgress?: (progress: RendererResourceProgress) => void;
  onFirstFrame?: (sessionId: number) => void;
  onCameraPoseChange?: (pose: CameraPose) => void;
  onCancelSelection?: () => void;
  onError?: (error: Error) => void;
};

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export const GameCanvas = forwardRef<GameCanvasHandle, GameCanvasProps>(function GameCanvas(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ExtendedRenderer | null>(null);
  const latestSnapshotRef = useRef<GameSnapshot | null>(props.snapshot);
  const latestSessionRef = useRef(props.snapshotSessionId);
  const reportedFrameSessionRef = useRef(0);
  const callbacksRef = useRef({
    onPlacement: props.onPlacement,
    onHover: props.onHover,
    onMetrics: props.onMetrics,
    onRendererReady: props.onRendererReady,
    onResourcesReady: props.onResourcesReady,
    onResourceProgress: props.onResourceProgress,
    onFirstFrame: props.onFirstFrame,
    onCameraPoseChange: props.onCameraPoseChange,
    onCancelSelection: props.onCancelSelection,
    onError: props.onError,
  });

  callbacksRef.current = {
    onPlacement: props.onPlacement,
    onHover: props.onHover,
    onMetrics: props.onMetrics,
    onRendererReady: props.onRendererReady,
    onResourcesReady: props.onResourcesReady,
    onResourceProgress: props.onResourceProgress,
    onFirstFrame: props.onFirstFrame,
    onCameraPoseChange: props.onCameraPoseChange,
    onCancelSelection: props.onCancelSelection,
    onError: props.onError,
  };
  latestSnapshotRef.current = props.snapshot;
  latestSessionRef.current = props.snapshotSessionId;

  const reportSessionFrame = (sessionId: number) => {
    if (
      !latestSnapshotRef.current
      || sessionId <= 0
      || latestSessionRef.current !== sessionId
      || reportedFrameSessionRef.current === sessionId
    ) return;
    reportedFrameSessionRef.current = sessionId;
    callbacksRef.current.onFirstFrame(sessionId);
  };

  useImperativeHandle(ref, () => ({
    rotate(direction) {
      rendererRef.current?.rotate(direction);
    },
    recalculatePlacement() {
      rendererRef.current?.recalculatePlacement?.();
    },
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rendererCallbacks: ExtendedRendererCallbacks = {
      onDeploy: (placement) => callbacksRef.current.onPlacement(placement),
      onPlacementChange: (placement) => callbacksRef.current.onHover(placement),
      onMetrics: (metrics) => callbacksRef.current.onMetrics(metrics),
      onReady: (backend) => callbacksRef.current.onRendererReady(backend),
      onResourcesReady: () => callbacksRef.current.onResourcesReady(),
      onResourceProgress: (progress) => callbacksRef.current.onResourceProgress(progress),
      onFirstFrame: reportSessionFrame,
      onCameraPoseChange: (pose) => callbacksRef.current.onCameraPoseChange(pose),
      onCancelSelection: () => callbacksRef.current.onCancelSelection(),
      onError: (error) => callbacksRef.current.onError(error),
    };

    const renderer = new WorldRenderer(canvas, rendererCallbacks) as ExtendedRenderer;
    rendererRef.current = renderer;
    let disposed = false;

    void renderer.init().catch((error: unknown) => {
      if (!disposed) callbacksRef.current.onError(toError(error));
    });

    return () => {
      disposed = true;
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setSnapshot(props.snapshot, props.snapshotSessionId);
  }, [props.snapshot, props.snapshotSessionId]);

  useEffect(() => { rendererRef.current?.setSelectedCard(props.selectedCard); }, [props.selectedCard]);
  useEffect(() => { rendererRef.current?.setQuality(props.quality); }, [props.quality]);

  return (
    <canvas
      ref={canvasRef}
      className={`game-canvas${props.interactive ? '' : ' is-passive'}`}
      aria-label="Campo de batalla 3D"
      aria-hidden={!props.interactive}
      tabIndex={props.interactive ? 0 : -1}
    />
  );
});
