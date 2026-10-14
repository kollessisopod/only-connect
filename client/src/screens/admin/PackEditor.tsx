import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  HIEROGLYPHS,
  HIEROGLYPH_LABELS,
  MAX_QUESTIONS_PER_ROUND,
  MAX_WALLS,
  MIN_QUESTIONS_PER_ROUND,
  MIN_WALLS,
  WALL_GROUP_COLOURS,
  validatePack,
  type Clue,
  type ClueKind,
  type Hieroglyph as HieroglyphId,
  type Pack,
  type Question,
  type QuestionRound,
  type VowelGroup,
  type Wall,
} from '@only-connect/shared';
import { Hieroglyph } from '../../components/Hieroglyph';
import { Tile } from '../../components/Tile';
import { useDirtyGuard } from './guard';
import {
  addQuestion,
  addVowelClue,
  addVowelGroup,
  addWall,
  attachMedia,
  duplicateHieroglyphs,
  duplicateWallHieroglyphs,
  moveQuestion,
  moveVowelGroup,
  problemsByTab,
  questionsFor,
  regenerateVowelDisplay,
  removeQuestion,
  removeVowelClue,
  removeVowelGroup,
  removeWall,
  setClueKind,
  setVowelAnswer,
  setVowelDisplay,
  updateClue,
  updateQuestion,
  updateVowelGroup,
  updateWall,
  updateWallClue,
  updateWallGroup,
} from './packEdit';
import type { PacksApi } from './types';
import { Button, Chip, Field, InlineConfirm, Input, Notice, Select, Toast } from './ui';

export type EditorTab = 'connections' | 'sequences' | 'walls' | 'vowels';

export interface PackEditorProps {
  packs: PacksApi;
  packId: string;
  /** Where "Back to packs" goes (default /admin/packs). */
  backPath?: string;
  /** Pre-loaded pack (fixtures); otherwise fetched with `packs.get`. */
  initialPack?: Pack;
  initialTab?: EditorTab;
}

/** Clue text beyond this is shrunk on the monitor tile (see Tile.tsx); the editor warns. */
const CLUE_SOFT_LIMIT = 60;
/** A single wall word longer than this is shrunk to fit its tile; the editor warns. */
const WALL_WORD_SOFT_LIMIT = 13;

function longestWord(text: string): number {
  return text.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0);
}

const TAB_LABELS: Record<EditorTab, string> = {
  connections: 'Connections',
  sequences: 'Sequences',
  walls: 'Walls',
  vowels: 'Missing Vowels',
};

export function PackEditor({ packs, packId, backPath = '/admin/packs', initialPack, initialTab = 'connections' }: PackEditorProps) {
  const navigate = useNavigate();
  const [pack, setPack] = useState<Pack | null>(initialPack ?? null);
  const [savedJson, setSavedJson] = useState<string | null>(initialPack ? JSON.stringify(initialPack) : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<EditorTab>(initialTab);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: 'bad' | 'good' } | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  useEffect(() => {
    if (initialPack) return;
    let alive = true;
    setLoadError(null);
    packs
      .get(packId)
      .then((p) => {
        if (!alive) return;
        setPack(p);
        setSavedJson(JSON.stringify(p));
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(err instanceof Error ? err.message : 'failed to load pack');
      });
    return () => {
      alive = false;
    };
  }, [packs, packId, initialPack]);

  const dirty = pack !== null && savedJson !== null && JSON.stringify(pack) !== savedJson;
  useDirtyGuard(dirty);

  const problems = useMemo(() => (pack ? validatePack(pack) : []), [pack]);
  const byTab = useMemo(() => problemsByTab(problems), [problems]);

  const update = useCallback((fn: (p: Pack) => Pack) => setPack((p) => (p ? fn(p) : p)), []);

  const save = async () => {
    if (!pack || saving) return;
    setSaving(true);
    try {
      const result = await packs.save(pack);
      setPack(result);
      setSavedJson(JSON.stringify(result));
      setToast({ message: 'Pack saved.', tone: 'good' });
    } catch (err: unknown) {
      setToast({ message: err instanceof Error ? err.message : 'save failed', tone: 'bad' });
    } finally {
      setSaving(false);
    }
  };

  const back = () => {
    if (dirty) setConfirmLeave(true);
    else navigate(backPath);
  };

  if (loadError) {
    return (
      <div className="adm-page">
        <Notice tone="bad">{loadError}</Notice>
        <p>
          <Link to={backPath}>Back to packs</Link>
        </p>
      </div>
    );
  }
  if (!pack) {
    return (
      <div className="adm-page">
        <Notice>Loading pack…</Notice>
      </div>
    );
  }

  const tabProblems: Record<EditorTab, number> = {
    connections: byTab.connections.length,
    sequences: byTab.sequences.length,
    walls: byTab.walls.length,
    vowels: byTab.vowels.length,
  };

  return (
    <div className="adm-page">
      <Toast message={toast?.message ?? null} tone={toast?.tone ?? 'bad'} onClose={() => setToast(null)} ttlMs={toast?.tone === 'good' ? 2500 : 6000} />

      <div className="adm-editor__bar">
        <Button tone="ghost" size="sm" onClick={back}>
          ← Packs
        </Button>
        <Input aria-label="pack name" value={pack.name} invalid={!pack.name.trim()} onChange={(e) => update((p) => ({ ...p, name: e.target.value }))} maxLength={80} />
        {problems.length === 0 ? <Chip tone="good">playable</Chip> : <Chip tone="bad">{problems.length} problem{problems.length === 1 ? '' : 's'}</Chip>}
        {dirty ? <Chip tone="warn">unsaved changes</Chip> : <Chip tone="muted">saved</Chip>}
        <span className="adm-editor__spacer" />
        <Button tone="primary" disabled={!dirty} busy={saving} onClick={() => void save()}>
          Save
        </Button>
      </div>

      {confirmLeave && (
        <div style={{ marginBottom: 12 }}>
          <InlineConfirm
            text="You have unsaved changes. Leave the editor and discard them?"
            confirmLabel="Discard changes"
            onConfirm={() => {
              setPack(savedJson ? (JSON.parse(savedJson) as Pack) : pack);
              setConfirmLeave(false);
              navigate(backPath);
            }}
            onCancel={() => setConfirmLeave(false)}
          />
        </div>
      )}

      {byTab.other.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Notice tone="bad">
            <ul style={{ margin: 0 }}>
              {byTab.other.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      <div className="adm-tabs" role="tablist">
        {(Object.keys(TAB_LABELS) as EditorTab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`adm-tab${tab === t ? ' is-active' : ''}`} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
            {tabProblems[t] > 0 ? <Chip tone="bad">{tabProblems[t]}</Chip> : <Chip tone="good">✓</Chip>}
          </button>
        ))}
      </div>

      {(tab === 'connections' || tab === 'sequences') && <QuestionsTab pack={pack} round={tab} update={update} packs={packs} problems={byTab[tab]} />}
      {tab === 'walls' && <WallsTab pack={pack} update={update} problems={byTab.walls} />}
      {tab === 'vowels' && <VowelsTab pack={pack} update={update} problems={byTab.vowels} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Problems list shown at the top of each tab
// ---------------------------------------------------------------------------

function ProblemList({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <Notice tone="warn">
        <strong>
          {problems.length} problem{problems.length === 1 ? '' : 's'} on this tab
        </strong>
        <ul>
          {problems.slice(0, 8).map((p, i) => (
            <li key={i}>{p}</li>
          ))}
          {problems.length > 8 && <li>… and {problems.length - 8} more</li>}
        </ul>
      </Notice>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connections / Sequences
// ---------------------------------------------------------------------------

function QuestionsTab({
  pack,
  round,
  update,
  packs,
  problems,
}: {
  pack: Pack;
  round: QuestionRound;
  update: (fn: (p: Pack) => Pack) => void;
  packs: PacksApi;
  problems: string[];
}) {
  const questions = questionsFor(pack, round);
  const dupes = duplicateHieroglyphs(pack, round);
  const full = questions.length >= MAX_QUESTIONS_PER_ROUND;
  const count = `${questions.length} of up to ${MAX_QUESTIONS_PER_ROUND} questions`;
  return (
    <div>
      <ProblemList problems={problems} />
      <div className="adm-row adm-row--between" style={{ marginBottom: 12 }}>
        <span className="adm-muted" data-testid={`${round}-count`}>
          {count}
          {questions.length < MIN_QUESTIONS_PER_ROUND ? ` · the round needs at least ${MIN_QUESTIONS_PER_ROUND}` : ''}
          {' · one hieroglyph each; the grid shows 3 columns up to 6 questions, 4 columns beyond'}
          {round === 'sequences' ? ' · the 4th item is hidden until the answer is revealed' : ''}
        </span>
        <Button
          size="sm"
          tone="primary"
          disabled={full}
          title={full ? `A round holds at most ${MAX_QUESTIONS_PER_ROUND} questions (one per hieroglyph)` : 'Add a question with the next unused hieroglyph'}
          onClick={() => update((p) => addQuestion(p, round))}
        >
          + Add question
        </Button>
      </div>
      {questions.length === 0 && <div className="adm-empty">No {round} questions yet.</div>}
      <div className="adm-cards">
        {questions.map((q, i) => (
          <QuestionCard key={q.id} q={q} index={i} count={questions.length} round={round} taken={questions} duplicate={dupes.has(q.hieroglyph)} update={update} packs={packs} />
        ))}
      </div>
    </div>
  );
}

/** "Lion · used by question 3" labels for a hieroglyph select, so a clash is visible before it is picked. */
function glyphOptionLabel(h: HieroglyphId, owner: { index: number } | undefined, self: boolean, noun: string): string {
  if (!owner || self) return HIEROGLYPH_LABELS[h];
  return `${HIEROGLYPH_LABELS[h]} · used by ${noun} ${owner.index + 1}`;
}

function QuestionCard({
  q,
  index,
  count,
  round,
  taken,
  duplicate,
  update,
  packs,
}: {
  q: Question;
  index: number;
  count: number;
  round: QuestionRound;
  /** The round's questions in order (to label glyphs already taken). */
  taken: Question[];
  duplicate: boolean;
  update: (fn: (p: Pack) => Pack) => void;
  packs: PacksApi;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const clues = [...q.clues];
  while (clues.length < 4) clues.push({ kind: 'text', text: '' });
  const ownerOf = (h: HieroglyphId) => {
    const i = taken.findIndex((x) => x.hieroglyph === h && x.id !== q.id);
    return i >= 0 ? { index: i } : undefined;
  };
  return (
    <div className={`adm-card${duplicate ? ' is-invalid' : ''}`} data-testid={`${round}-question-${index + 1}`}>
      <div className="adm-card__head">
        <h3>Question {index + 1}</h3>
        <div className="adm-row">
          <Button size="sm" tone="ghost" disabled={index === 0} aria-label={`move question ${index + 1} up`} title="Move up" onClick={() => update((p) => moveQuestion(p, q.id, -1))}>
            ↑
          </Button>
          <Button size="sm" tone="ghost" disabled={index >= count - 1} aria-label={`move question ${index + 1} down`} title="Move down" onClick={() => update((p) => moveQuestion(p, q.id, 1))}>
            ↓
          </Button>
          {confirmRemove ? (
            <InlineConfirm text="Remove this question?" confirmLabel="Remove" onConfirm={() => update((p) => removeQuestion(p, q.id))} onCancel={() => setConfirmRemove(false)} />
          ) : (
            <Button size="sm" tone="ghost" onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <div className="adm-card__glyph">
        <Tile size="glyph" raw>
          <Hieroglyph hieroglyph={q.hieroglyph} />
        </Tile>
        <Field label="Hieroglyph" error={duplicate ? `${HIEROGLYPH_LABELS[q.hieroglyph]} is used by another ${round} question` : undefined} className="adm-field--grow">
          <Select aria-label={`question ${index + 1} hieroglyph`} value={q.hieroglyph} invalid={duplicate} onChange={(e) => update((p) => updateQuestion(p, q.id, { hieroglyph: e.target.value as HieroglyphId }))}>
            {HIEROGLYPHS.map((h) => (
              <option key={h} value={h}>
                {glyphOptionLabel(h, ownerOf(h), h === q.hieroglyph, 'question')}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="adm-stack" style={{ gap: 6 }}>
        {clues.map((c, i) => (
          <ClueEditor key={i} clue={c} index={i} hiddenFourth={round === 'sequences' && i === 3} questionId={q.id} update={update} packs={packs} />
        ))}
      </div>
      <Field label={round === 'sequences' ? 'Answer (4th item + sequence)' : 'Answer (the connection)'}>
        <Input value={q.answer} invalid={!q.answer.trim()} onChange={(e) => update((p) => updateQuestion(p, q.id, { answer: e.target.value }))} />
      </Field>
      <Field label="Host note (optional)">
        <Input value={q.note ?? ''} placeholder="Explanation, alternatives to accept…" onChange={(e) => update((p) => updateQuestion(p, q.id, { note: e.target.value }))} />
      </Field>
    </div>
  );
}

function ClueEditor({
  clue,
  index,
  hiddenFourth,
  questionId,
  update,
  packs,
}: {
  clue: Clue;
  index: number;
  hiddenFourth: boolean;
  questionId: string;
  update: (fn: (p: Pack) => Pack) => void;
  packs: PacksApi;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const needsMedia = clue.kind !== 'text';
  const textInvalid = !clue.text.trim();

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const ref = await packs.upload(file);
      update((p) => attachMedia(p, questionId, index, ref));
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  };

  const label = hiddenFourth ? '4th item (hidden)' : `Clue ${index + 1}`;
  // The monitor tile fits about three short lines; longer clues shrink and past ~90 characters get clipped.
  const tooLong = clue.text.trim().length > CLUE_SOFT_LIMIT;

  return (
    <div className="adm-cluerow">
      <span className="adm-cluerow__n" title={label}>
        {hiddenFourth ? '4?' : index + 1}
      </span>
      <Select small aria-label={`${label} kind`} value={clue.kind} onChange={(e) => update((p) => setClueKind(p, questionId, index, e.target.value as ClueKind))}>
        <option value="text">Text</option>
        <option value="image">Image</option>
        <option value="audio">Audio</option>
      </Select>
      <Input
        small
        aria-label={needsMedia ? `${label} caption` : label}
        placeholder={needsMedia ? 'Caption (shown on the answer reveal)' : hiddenFourth ? 'Hidden 4th item' : 'Clue text'}
        value={clue.text}
        invalid={textInvalid}
        maxLength={200}
        title={tooLong ? `${clue.text.trim().length} characters: long clues are shrunk on the monitor tile; keep clues under ${CLUE_SOFT_LIMIT}` : undefined}
        onChange={(e) => update((p) => updateClue(p, questionId, index, { text: e.target.value }))}
      />
      {tooLong && (
        <span className="adm-small adm-cluerow__warn" role="note">
          {clue.text.trim().length} chars — long for a tile
        </span>
      )}
      <span className="adm-upload">
        <Button size="sm" tone={needsMedia && !clue.media ? 'warn' : 'ghost'} busy={uploading} title="Upload image or audio" onClick={() => fileRef.current?.click()}>
          {clue.media ? 'Replace' : 'Upload'}
        </Button>
        <input ref={fileRef} type="file" accept="image/*,audio/*" aria-label={`upload media for ${label}`} onChange={(e) => void onFile(e)} tabIndex={-1} />
      </span>
      {(clue.media || uploadError || (needsMedia && !clue.media)) && (
        <div className="adm-cluerow__media">
          {clue.media && clue.media.mime.startsWith('image/') && <img src={clue.media.url} alt={clue.text || clue.media.name} />}
          {clue.media && clue.media.mime.startsWith('audio/') && <audio controls preload="none" src={clue.media.url} />}
          {clue.media && (
            <span className="adm-small adm-muted" title={clue.media.key}>
              {clue.media.name} · {clue.media.mime}
            </span>
          )}
          {clue.media && (
            <Button size="sm" tone="ghost" onClick={() => update((p) => updateClue(p, questionId, index, { media: undefined }))}>
              Remove media
            </Button>
          )}
          {!clue.media && needsMedia && !uploadError && <span className="adm-small adm-faint">No {clue.kind} uploaded yet.</span>}
          {uploadError && <span className="adm-field__error">{uploadError}</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

function WallsTab({ pack, update, problems }: { pack: Pack; update: (fn: (p: Pack) => Pack) => void; problems: string[] }) {
  const walls = [...pack.walls].sort((a, b) => a.position - b.position);
  const dupes = duplicateWallHieroglyphs(pack);
  const full = walls.length >= MAX_WALLS;
  const evenOk = walls.length === MIN_WALLS || walls.length === MAX_WALLS;
  return (
    <div>
      <ProblemList problems={problems} />
      <div className="adm-row adm-row--between" style={{ marginBottom: 12 }}>
        <span className="adm-muted" data-testid="walls-count">
          {walls.length} wall{walls.length === 1 ? '' : 's'} · a pack needs exactly {MIN_WALLS} or {MAX_WALLS} (teams alternate choosing them by hieroglyph)
          {!evenOk ? ` · ${walls.length < MIN_WALLS ? `add ${MIN_WALLS - walls.length} more` : walls.length < MAX_WALLS ? 'add one more or remove one' : 'remove one'}` : ''}
          {' · each wall has 4 groups of 4 clues; a clue must not appear twice on the same wall'}
        </span>
        <Button size="sm" tone="primary" disabled={full} title={full ? `A pack holds at most ${MAX_WALLS} walls` : 'Add a wall with the next unused hieroglyph'} onClick={() => update(addWall)}>
          + Add wall
        </Button>
      </div>
      {walls.length === 0 && <div className="adm-empty">No walls yet. The round needs {MIN_WALLS} or {MAX_WALLS}.</div>}
      <div className="adm-walls">
        {walls.map((w, i) => (
          <WallCard key={w.id} wall={w} index={i} walls={walls} duplicate={dupes.has(w.hieroglyph)} update={update} />
        ))}
      </div>
    </div>
  );
}

function WallCard({ wall, index, walls, duplicate, update }: { wall: Wall; index: number; walls: Wall[]; duplicate: boolean; update: (fn: (p: Pack) => Pack) => void }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const groups = [...wall.groups];
  while (groups.length < 4) groups.push({ connection: '', clues: ['', '', '', ''] });
  const seen = new Map<string, number>();
  for (const g of groups) for (const c of g.clues) {
    const k = c.trim().toLowerCase();
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const ownerOf = (h: HieroglyphId) => {
    const i = walls.findIndex((x) => x.hieroglyph === h && x.id !== wall.id);
    return i >= 0 ? { index: i } : undefined;
  };
  const known = HIEROGLYPHS.includes(wall.hieroglyph);
  const glyphError = duplicate ? `${HIEROGLYPH_LABELS[wall.hieroglyph]} is used by another wall` : !known ? 'Choose the hieroglyph teams pick this wall by' : undefined;
  return (
    <div className={`adm-card${duplicate || !known ? ' is-invalid' : ''}`} data-testid={`wall-${index + 1}`}>
      <div className="adm-card__head">
        <h3>Wall {index + 1}</h3>
        {confirmRemove ? (
          <InlineConfirm text="Remove this wall?" confirmLabel="Remove" onConfirm={() => update((p) => removeWall(p, wall.id))} onCancel={() => setConfirmRemove(false)} />
        ) : (
          <Button size="sm" tone="ghost" onClick={() => setConfirmRemove(true)}>
            Remove
          </Button>
        )}
      </div>
      <div className="adm-card__glyph">
        <Tile size="glyph" raw>
          {known ? <Hieroglyph hieroglyph={wall.hieroglyph} /> : <span className="adm-muted">?</span>}
        </Tile>
        <Field label="Hieroglyph (the team picks this wall by it)" error={glyphError} className="adm-field--grow">
          <Select aria-label={`wall ${index + 1} hieroglyph`} value={known ? wall.hieroglyph : ''} invalid={Boolean(glyphError)} onChange={(e) => update((p) => updateWall(p, wall.id, { hieroglyph: e.target.value as HieroglyphId }))}>
            {!known && <option value="">— choose —</option>}
            {HIEROGLYPHS.map((h) => (
              <option key={h} value={h}>
                {glyphOptionLabel(h, ownerOf(h), h === wall.hieroglyph, 'wall')}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {groups.slice(0, 4).map((g, gi) => {
        const clues = [...g.clues];
        while (clues.length < 4) clues.push('');
        return (
          <div key={gi} className="adm-wallgroup-edit">
            <span className="adm-wallgroup-edit__swatch" style={{ background: WALL_GROUP_COLOURS[gi] }} />
            <div className="adm-wallgroup-edit__fields">
              <Input
                small
                className="adm-input--conn"
                aria-label={`wall ${index + 1} group ${gi + 1} connection`}
                placeholder={`Group ${gi + 1} connection`}
                value={g.connection}
                invalid={!g.connection.trim()}
                onChange={(e) => update((p) => updateWallGroup(p, wall.id, gi, { connection: e.target.value }))}
              />
              {clues.slice(0, 4).map((c, ci) => {
                const duplicateClue = (seen.get(c.trim().toLowerCase()) ?? 0) > 1;
                const longWord = longestWord(c) > WALL_WORD_SOFT_LIMIT;
                return (
                  <Input
                    key={ci}
                    small
                    aria-label={`wall ${index + 1} group ${gi + 1} clue ${ci + 1}`}
                    placeholder={`Clue ${ci + 1}`}
                    value={c}
                    maxLength={60}
                    invalid={!c.trim() || duplicateClue}
                    className={longWord ? 'is-warn' : undefined}
                    title={duplicateClue ? 'appears more than once on this wall' : longWord ? `a word over ${WALL_WORD_SOFT_LIMIT} letters is shrunk to fit the tile` : undefined}
                    onChange={(e) => update((p) => updateWallClue(p, wall.id, gi, ci, e.target.value))}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Missing vowels
// ---------------------------------------------------------------------------

function VowelsTab({ pack, update, problems }: { pack: Pack; update: (fn: (p: Pack) => Pack) => void; problems: string[] }) {
  const groups = [...pack.vowelGroups].sort((a, b) => a.position - b.position);
  return (
    <div>
      <ProblemList problems={problems} />
      <div className="adm-row adm-row--between" style={{ marginBottom: 12 }}>
        <span className="adm-muted">
          {groups.length} categor{groups.length === 1 ? 'y' : 'ies'} · the display is generated from the answer (vowels removed, re-spaced) and can be edited
        </span>
        <Button size="sm" tone="primary" onClick={() => update(addVowelGroup)}>
          + Add category
        </Button>
      </div>
      {groups.length === 0 && <div className="adm-empty">No categories yet. The round needs at least one.</div>}
      <div className="adm-cards">
        {groups.map((g, i) => (
          <VowelGroupCard key={g.id} group={g} index={i} count={groups.length} update={update} />
        ))}
      </div>
    </div>
  );
}

function VowelGroupCard({ group, index, count, update }: { group: VowelGroup; index: number; count: number; update: (fn: (p: Pack) => Pack) => void }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  return (
    <div className="adm-card">
      <div className="adm-card__head">
        <h3>Category {index + 1}</h3>
        <div className="adm-row">
          <Button size="sm" tone="ghost" disabled={index === 0} aria-label="move up" onClick={() => update((p) => moveVowelGroup(p, group.id, -1))}>
            ↑
          </Button>
          <Button size="sm" tone="ghost" disabled={index >= count - 1} aria-label="move down" onClick={() => update((p) => moveVowelGroup(p, group.id, 1))}>
            ↓
          </Button>
          {confirmRemove ? (
            <InlineConfirm text="Remove this category?" confirmLabel="Remove" onConfirm={() => update((p) => removeVowelGroup(p, group.id))} onCancel={() => setConfirmRemove(false)} />
          ) : (
            <Button size="sm" tone="ghost" onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <Field label="Category">
        <Input value={group.category} invalid={!group.category.trim()} placeholder="e.g. Capital cities" onChange={(e) => update((p) => updateVowelGroup(p, group.id, { category: e.target.value }))} />
      </Field>
      <div className="adm-stack" style={{ gap: 6 }}>
        <div className="adm-vowelrow adm-small adm-muted">
          <span />
          <span>Answer</span>
          <span>Display (on screen)</span>
          <span />
          <span />
        </div>
        {group.clues.map((c, i) => (
          <div key={i} className="adm-vowelrow">
            <span className="adm-cluerow__n">{i + 1}</span>
            <Input small aria-label={`category ${index + 1} clue ${i + 1} answer`} value={c.answer} invalid={!c.answer.trim()} placeholder="Full answer" onChange={(e) => update((p) => setVowelAnswer(p, group.id, i, e.target.value))} />
            <Input
              small
              className="adm-vowelrow__display"
              aria-label={`category ${index + 1} clue ${i + 1} display`}
              value={c.display}
              invalid={!c.display.trim()}
              placeholder="Auto"
              onChange={(e) => update((p) => setVowelDisplay(p, group.id, i, e.target.value))}
            />
            <Button size="sm" tone="ghost" title="Regenerate the display from the answer" onClick={() => update((p) => regenerateVowelDisplay(p, group.id, i))}>
              ↻
            </Button>
            <Button size="sm" tone="ghost" aria-label={`remove clue ${i + 1}`} disabled={group.clues.length <= 1} onClick={() => update((p) => removeVowelClue(p, group.id, i))}>
              ×
            </Button>
          </div>
        ))}
      </div>
      <div>
        <Button size="sm" onClick={() => update((p) => addVowelClue(p, group.id))}>
          + Add clue
        </Button>
      </div>
    </div>
  );
}

export default PackEditor;
