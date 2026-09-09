import { STAGE_LABELS, STAGE_ORDER, type Application, type Stage } from "../lib/types";

interface Props {
  applications: Application[];
  selectedId: number | null;
  onSelect: (app: Application) => void;
}

function relative(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function Card({ app, selected, onSelect }: { app: Application; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`card ${selected ? "card-selected" : ""}`} onClick={onSelect}>
      <div className="card-company">{app.company}</div>
      {app.role && <div className="card-role">{app.role}</div>}
      <div className="card-meta">
        <span>{relative(app.daysSinceLastEvent)}</span>
        {app.statusSource === "manual" && <span className="tag">manual</span>}
        {app.eventCount > 1 && <span className="tag">{app.eventCount} emails</span>}
      </div>
    </button>
  );
}

export function Board({ applications, selectedId, onSelect }: Props) {
  const byStage = new Map<Stage, Application[]>(STAGE_ORDER.map((s) => [s, []]));
  for (const app of applications) byStage.get(app.stage)?.push(app);

  return (
    <div className="board">
      {STAGE_ORDER.map((stage) => {
        const items = byStage.get(stage) ?? [];
        return (
          <section key={stage} className={`column column-${stage}`}>
            <h2 className="column-title">
              {STAGE_LABELS[stage]}
              <span className="count">{items.length}</span>
            </h2>
            <div className="column-body">
              {items.length === 0 ? (
                <p className="empty-column">Nothing here</p>
              ) : (
                items.map((app) => (
                  <Card key={app.id} app={app} selected={app.id === selectedId} onSelect={() => onSelect(app)} />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
