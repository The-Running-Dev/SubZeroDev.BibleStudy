import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { NoteAnchor, NoteView, PushResult, SyncOp } from '../shared/api.ts';
import { formatReference } from '../shared/reference.ts';
import { api, messageFor } from './api.ts';
import { deviceId } from './device.ts';

// The reader's own notes on the chapter on screen. Only their author ever receives them (I-21). Offline saving and
// settling conflicts come later (S15): a save that meets a newer version from another device reloads it, closes the
// edit, and keeps the unsaved text in view to copy.

export const inChapter = (notes: NoteView[], at: { bookId: string; chapter: number }) =>
  notes.filter((n) => !n.deleted && n.anchor.bookId === at.bookId && n.anchor.chapter === at.chapter);

const byVerse = (a: NoteView, b: NoteView) => (a.anchor.startVerse ?? 0) - (b.anchor.startVerse ?? 0) || a.updatedAt.localeCompare(b.updatedAt);

type NoteUpsert = Extract<SyncOp, { op: 'upsert' }>;
type Saved = 'saved' | 'conflict' | 'failed';

const sameAnchor = (a: NoteAnchor, b: NoteAnchor) =>
  a.translationId === b.translationId && a.bookId === b.bookId && a.chapter === b.chapter && a.startVerse === b.startVerse && a.endVerse === b.endVerse;

async function pushOne(op: SyncOp): Promise<PushResult> {
  const { results } = await api.push([op]);
  return results[0];
}

export function Notes(props: { anchor: NoteAnchor; notes: NoteView[]; onSaved: (note: NoteView) => void; onReload: () => void }) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An edit that met a newer version, shown under the note until dismissed.
  const [unsaved, setUnsaved] = useState<{ id: string; body: string } | null>(null);
  // The new note being saved: a retry of the same text sends the same operation, so a lost response never doubles it.
  const pendingAdd = useRef<NoteUpsert | null>(null);
  const shown = inChapter(props.notes, props.anchor).sort(byVerse);

  async function save(op: SyncOp, saved: (revision: number) => NoteView, conflict: string): Promise<Saved> {
    setBusy(true);
    setError(null);
    try {
      const result = await pushOne(op);
      if (result.outcome === 'conflict') {
        setError(conflict);
        props.onReload();
        return 'conflict';
      }
      props.onSaved(saved(result.revision));
      return 'saved';
    } catch (failure) {
      setError(messageFor(failure));
      return 'failed';
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    const anchor = props.anchor;
    const prior = pendingAdd.current;
    const op: NoteUpsert =
      prior && prior.body === body && sameAnchor(prior.anchor, anchor)
        ? prior
        : { opId: crypto.randomUUID(), entity: 'note', entityId: crypto.randomUUID(), op: 'upsert', baseRevision: null, anchor, body, deviceId: deviceId() };
    pendingAdd.current = op;
    const saved = (revision: number): NoteView => ({ id: op.entityId, anchor, body, revision, updatedAt: new Date().toISOString(), deleted: false });
    if ((await save(op, saved, 'That note could not be saved. Try again.')) !== 'saved') return;
    pendingAdd.current = null;
    setDraft('');
  }

  async function update(event: FormEvent, note: NoteView) {
    event.preventDefault();
    if (!editing || busy) return;
    const body = editing.body.trim();
    if (!body) return;
    const op: SyncOp = { opId: crypto.randomUUID(), entity: 'note', entityId: note.id, op: 'upsert', baseRevision: note.revision, anchor: note.anchor, body, deviceId: deviceId() };
    const saved = (revision: number): NoteView => ({ ...note, body, revision, updatedAt: new Date().toISOString() });
    const conflict = 'This note changed on another device. Its newer text is shown, with your edit under it to copy.';
    const outcome = await save(op, saved, conflict);
    if (outcome === 'failed') return;
    // A second Save must not go out on the old revision, so the form closes either way.
    setEditing(null);
    setUnsaved(outcome === 'conflict' ? { id: note.id, body } : null);
  }

  async function remove(note: NoteView) {
    if (busy) return;
    const op: SyncOp = { opId: crypto.randomUUID(), entity: 'note', entityId: note.id, op: 'delete', baseRevision: note.revision, deviceId: deviceId() };
    const saved = (revision: number): NoteView => ({ ...note, body: '', revision, updatedAt: new Date().toISOString(), deleted: true });
    await save(op, saved, 'This note changed on another device, so it was kept. Its newer text is shown.');
  }

  return (
    <section className="notes" aria-label="My notes">
      <h2>My notes</h2>
      {shown.length > 0 && (
        <ul className="notes-list">
          {shown.map((note) => (
            <li key={note.id} data-note={note.id}>
              <p className="note-reference">{formatReference(note.anchor)}</p>
              {editing?.id === note.id ? (
                <form onSubmit={(e) => update(e, note)}>
                  <textarea value={editing.body} onChange={(e) => setEditing({ id: note.id, body: e.target.value })} aria-label={`Edit note on ${formatReference(note.anchor)}`} />
                  <button type="submit" disabled={busy || !editing.body.trim()}>
                    Save
                  </button>
                  <button type="button" className="secondary" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <p className="note-body">{note.body}</p>
                  <button type="button" className="secondary" onClick={() => setEditing({ id: note.id, body: note.body })}>
                    Edit
                  </button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => remove(note)}>
                    Delete
                  </button>
                  {unsaved?.id === note.id && (
                    <div className="note-unsaved" data-unsaved>
                      <p>Your edit, not saved:</p>
                      <p className="note-body">{unsaved.body}</p>
                      <button type="button" className="secondary" onClick={() => setUnsaved(null)}>
                        Dismiss
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="note-new" onSubmit={add}>
        <label>
          Note on {formatReference(props.anchor)}
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Only you can see this." />
        </label>
        <button type="submit" disabled={busy || !draft.trim()}>
          Save note
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
