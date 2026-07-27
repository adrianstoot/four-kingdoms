export interface CardDisplay {
  id: string;
  name: string;
  cost: number;
  icon: string;
  accent: string;
  description: string;
  atlasIndex: number;
}

interface CardHandProps {
  cards: readonly CardDisplay[];
  selectedId: string | null;
  elixir: number;
  cooldowns: Readonly<Record<string, number>>;
  onSelect: (cardId: string) => void;
}

export function CardHand({ cards, selectedId, elixir, cooldowns, onSelect }: CardHandProps) {
  return (
    <div className="hand-wrap" aria-label="Criaturas, nidos y fenómenos disponibles">
      {cards.map((card) => {
        const cooldown = cooldowns[card.id] ?? 0;
        const lacksElixir = elixir + 0.001 < card.cost;
        const unavailable = lacksElixir || cooldown > 0;
        const selected = selectedId === card.id;
        const availability = cooldown > 0
          ? `Disponible en ${Math.ceil(cooldown / 20)} segundos`
          : lacksElixir
            ? `Faltan ${Math.ceil(card.cost - elixir)} de néctar`
            : 'Disponible';

        return (
          <button
            type="button"
            className={`card${selected ? ' selected' : ''}${unavailable ? ' unavailable' : ''}`}
            style={{
              '--accent': card.accent,
              '--atlas-x': `${(card.atlasIndex % 4) * (100 / 3)}%`,
              '--atlas-y': `${Math.floor(card.atlasIndex / 4) * 100}%`,
            } as React.CSSProperties}
            key={card.id}
            title={`${card.description} · ${availability}`}
            aria-label={`${card.name}, coste ${card.cost} de néctar. ${availability}`}
            aria-pressed={selected}
            data-unavailable={unavailable ? 'true' : undefined}
            onClick={() => onSelect(card.id)}
          >
            <span className="card-cost">{card.cost}</span>
            <span className="card-art" aria-hidden="true" />
            <span className="card-name">{card.name}</span>
            {cooldown > 0 && <span className="card-cooldown">{Math.ceil(cooldown / 20)}s</span>}
            {cooldown <= 0 && lacksElixir && <span className="card-cooldown card-shortage">NÉCTAR</span>}
          </button>
        );
      })}
    </div>
  );
}
