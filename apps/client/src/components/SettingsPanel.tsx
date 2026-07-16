export type QualityLevel = 'low' | 'medium' | 'high';

interface SettingsPanelProps {
  quality: QualityLevel;
  audio: boolean;
  volume: number;
  showPerf: boolean;
  onQuality: (quality: QualityLevel) => void;
  onAudio: (enabled: boolean) => void;
  onVolume: (volume: number) => void;
  onPerf: (show: boolean) => void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  return (
    <section className="settings-panel" aria-label="Ajustes">
      <h3>Ajustes de batalla</h3>
      <label className="setting-row">
        <span>Calidad</span>
        <select value={props.quality} onChange={(event) => props.onQuality(event.target.value as QualityLevel)}>
          <option value="low">Muy seguro</option>
          <option value="medium">Seguro (recomendado)</option>
          <option value="high">Calidad alta</option>
        </select>
      </label>
      <label className="setting-row">
        <span>Audio</span>
        <input type="checkbox" checked={props.audio} onChange={(event) => props.onAudio(event.target.checked)} />
      </label>
      <label className="setting-row">
        <span>Volumen</span>
        <input type="range" min="0" max="1" step="0.05" value={props.volume} onChange={(event) => props.onVolume(Number(event.target.value))} />
      </label>
      <label className="setting-row">
        <span>Métricas</span>
        <input type="checkbox" checked={props.showPerf} onChange={(event) => props.onPerf(event.target.checked)} />
      </label>
      <div className="setting-row"><span>Rotar cámara</span><strong>Q / E</strong></div>
      <div className="setting-row"><span>Mover cámara</span><strong>WASD</strong></div>
    </section>
  );
}
