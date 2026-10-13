import type { ActionLogEntry } from './types';
import { Panel, formatClock } from './ui';

export function ActionLog({ log }: { log: ActionLogEntry[] }) {
  return (
    <Panel title="Action log" tools={<span className="adm-small adm-muted">last {log.length}</span>}>
      {log.length === 0 ? (
        <div className="adm-small adm-muted">No actions sent yet.</div>
      ) : (
        <div className="adm-log">
          {log.map((e) => (
            <div key={e.id} className={`adm-log__row${e.ok ? '' : ' is-error'}`}>
              <span className="adm-log__time">{formatClock(e.at)}</span>
              <span>
                {e.ok ? '✓' : '✗'} {e.label}
                <span className="adm-faint"> · {e.tookMs} ms</span>
                {e.error && <div className="adm-log__error">{e.error}</div>}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export default ActionLog;
