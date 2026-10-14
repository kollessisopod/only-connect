import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PackSummary } from '@only-connect/shared';
import type { PacksApi } from './types';
import { Button, Chip, InlineConfirm, Input, Notice, Panel, Toast } from './ui';

/** Hands the browser a JSON file to save. */
function downloadJson(name: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const DEFAULT_PACK_NAME = 'New pack';
const DEMO_PACK_NAME = 'demo pack';

/** "New pack", or "New pack 2", "New pack 3", … — the first name not already in `existing` (case-insensitive). */
export function nextPackName(existing: ReadonlyArray<{ name: string }>, base = DEFAULT_PACK_NAME): string {
  const taken = new Set(existing.map((p) => p.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}

const isDemo = (p: PackSummary) => p.name.trim().toLowerCase() === DEMO_PACK_NAME;

export interface PacksListProps {
  packs: PacksApi;
  /** Where "Open" goes (default: /admin/packs/:id). */
  editorPath?: (id: string) => string;
}

export function PacksList({ packs, editorPath = (id) => `/admin/packs/${encodeURIComponent(id)}` }: PacksListProps) {
  const navigate = useNavigate();
  const [list, setList] = useState<PackSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    return packs
      .list()
      .then(setList)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'failed to load packs'));
  }, [packs]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (id: string | null, fn: () => Promise<unknown>) => {
    setBusyId(id ?? '__new');
    try {
      await fn();
    } catch (err: unknown) {
      setToast(err instanceof Error ? err.message : 'request failed');
    } finally {
      setBusyId(null);
    }
  };

  /** Creates a pack (named from the input, or "New pack …" when it is empty) and opens it in the editor. */
  const createPack = () => {
    const typed = newName.trim();
    const name = typed || nextPackName(list ?? []);
    void run(null, async () => {
      const pack = await packs.create(name);
      setNewName('');
      navigate(editorPath(pack.id));
    });
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    createPack();
  };

  const importRef = useRef<HTMLInputElement>(null);
  const exportPack = (p: PackSummary) =>
    run(p.id, async () => {
      const json = await packs.exportJson(p.id);
      downloadJson(`${p.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'pack'}.only-connect.json`, json);
    });
  const onImportFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void run(null, async () => {
      const pack = await packs.importJson(await file.text());
      setToast(`Imported "${pack.name}"`);
      await reload();
    });
  };

  const duplicate = (id: string) =>
    run(id, async () => {
      await packs.duplicate(id);
      await reload();
    });

  const remove = (id: string) =>
    run(id, async () => {
      await packs.remove(id);
      setConfirmDelete(null);
      await reload();
    });

  const creating = busyId === '__new';
  const onlyDemo = list !== null && list.every(isDemo);

  return (
    <div className="adm-page">
      <Toast message={toast} onClose={() => setToast(null)} />
      <div className="adm-page__head">
        <div>
          <h1>Question packs</h1>
          <p className="adm-page__help">Create a pack, then add questions in the editor.</p>
        </div>
        <form className="adm-newpack" onSubmit={create}>
          <label className="adm-newpack__field">
            <span className="adm-newpack__label">Name (optional)</span>
            <Input placeholder="e.g. Quiz night, series 2…" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} aria-label="new pack name (optional)" />
          </label>
          <Button type="submit" tone="primary" busy={creating} title="Create a pack and open it in the editor (named “New pack” if you leave the name empty)">
            + New pack
          </Button>
          <Button type="button" tone="ghost" busy={creating} title="Create a pack from an exported .only-connect.json file" onClick={() => importRef.current?.click()}>
            Import…
          </Button>
          <input ref={importRef} type="file" accept="application/json,.json" aria-label="import pack file" style={{ display: 'none' }} onChange={onImportFile} tabIndex={-1} />
        </form>
      </div>

      {error && <Notice tone="bad">{error}</Notice>}

      <Panel title="Packs" tools={<span className="adm-small adm-muted">{list ? `${list.length} pack${list.length === 1 ? '' : 's'}` : 'loading…'}</span>}>
        {onlyDemo && (
          <div className="adm-empty adm-empty--cta" data-testid="packs-empty-state">
            <div className="adm-empty__title">{list.length === 0 ? 'No packs yet' : 'Only the demo pack so far'}</div>
            <div className="adm-empty__text">
              {list.length === 0 ? 'Create a pack to start writing your own questions.' : 'The demo pack is for trying the show out. Create your own pack to write your own questions, walls and missing vowels.'}
            </div>
            <Button type="button" tone="primary" size="lg" busy={creating} onClick={createPack}>
              + New pack
            </Button>
          </div>
        )}
        {list && list.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="adm-table__name">{p.name}</div>
                      <div className="adm-small adm-faint">
                        <code>{p.id.slice(0, 8)}</code>
                      </div>
                    </td>
                    <td>
                      {p.playable ? (
                        <Chip tone="good">playable</Chip>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="adm-chip adm-chip--bad"
                            style={{ cursor: 'pointer', background: 'transparent' }}
                            title={p.problems.join('\n')}
                            aria-expanded={showProblems === p.id}
                            onClick={() => setShowProblems((s) => (s === p.id ? null : p.id))}
                          >
                            {p.problems.length} problem{p.problems.length === 1 ? '' : 's'} {showProblems === p.id ? '▾' : '▸'}
                          </button>
                          {showProblems === p.id && (
                            <ul className="adm-problems">
                              {p.problems.map((pr, i) => (
                                <li key={i}>{pr}</li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </td>
                    <td className="adm-small adm-muted">{new Date(p.updatedAt).toLocaleString()}</td>
                    <td>
                      {confirmDelete === p.id ? (
                        <InlineConfirm
                          text={`Delete "${p.name}"? This cannot be undone.`}
                          confirmLabel="Delete"
                          busy={busyId === p.id}
                          onConfirm={() => void remove(p.id)}
                          onCancel={() => setConfirmDelete(null)}
                        />
                      ) : (
                        <div className="adm-table__actions">
                          <Button size="sm" tone="primary" onClick={() => navigate(editorPath(p.id))}>
                            Open
                          </Button>
                          <Button size="sm" busy={busyId === p.id} onClick={() => void duplicate(p.id)}>
                            Duplicate
                          </Button>
                          <Button size="sm" tone="ghost" busy={busyId === p.id} title="Download this pack as a JSON file (media stays in the bucket, see README › Backup)" onClick={() => void exportPack(p)}>
                            Export
                          </Button>
                          <Button size="sm" tone="ghost" disabled={busyId === p.id} onClick={() => setConfirmDelete(p.id)}>
                            Delete
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

export default PacksList;
