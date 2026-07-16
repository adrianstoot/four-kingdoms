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
    <div className="hand-wrap" aria-label="Mazo de cartas">
      {cards.map((card) => {
        const cooldown = cooldowns[card.id] ?? 0;
        const disabled = elixir + 0.001 < card.cost || cooldown > 0;
        return (
          <button
            type="button"
            className={`card${selectedId === card.id ? ' selected' : ''}${disabled ? ' disabled' : ''}`}
            style={{
              '--accent': card.accent,
              '--atlas-x': `${(card.atlasIndex % 4) * (100 / 3)}%`,
              '--atlas-y': `${Math.floor(card.atlasIndex / 4) * 80 + 10}%`,
            } as React.CSSProperties}
            key={card.id}
            title={`${card.description}${cooldown > 0 ? ` · ${Math.ceil(cooldown / 20)}s` : ''}`}
            disabled={disabled}
            onClick={() => onSelect(card.id)}
          >
            <span className="card-cost">{card.cost}</span>
            <span className="card-art" aria-hidden="true" />
            <span className="card-name">{card.name}</span>
            {cooldown > 0 && <span className="card-cooldown">{Math.ceil(cooldown / 20)}s</span>}
          </button>
        );
      })}
    </div>
  );
}
