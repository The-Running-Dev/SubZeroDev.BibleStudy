import { useState } from 'react';
import type { FormEvent } from 'react';
import type { NoteAnchor, NoteView, PushResult, SyncOp } from '../shared/api.ts';
import { formatReference } from '../shared/reference.ts';
import { api, messageFor } from './api.ts';
import { deviceId } from './device.ts';

// The reader's own notes on the chapter on screen. Only their author ever receives them (I-21). Offline saving and
// settling conflicts come later (S15): a save that meets a newer version from another device reloads it and says so.

export const inChapter = (notes: NoteView[], at: { bookId: string; chapter: number }) =>
  notes.filter((n) => !n.deleted && n.anchor.bookId === at.bookId && n.anchor.chapter === at.chapter);

const byVerse = (a: NoteView, b: NoteView) => (a.anchor.startVerse ?? 0) - (b.anchor.startVerse ?? 0) || a.updatedAt.localeCompare(b.updatedAt);

async function pushOne(op: SyncOp): Promise<PushResult> {
  const { results } = await api.push([op]);
  return results[0];
}

export function Notes(props: { anchor: NoteAnchor; notes: NoteView[]; onSaved: (note: NoteView) => void; onReload: () => void }) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = inChapter(props.notes, props.anchor).sort(byVerse);

  async function save(op: SyncOp, saved: (revision: number) => NoteView, conflict: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await pushOne(op);
      if (result.outcome === 'conflict') {
        setError(conflict);
        props.onReload();
        return false;
      }
      props.onSaved(saved(result.revision));
      return true;
    } catch (failure) {
      setError(messageFor(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    const id = crypto.randomUUID();
    const anchor = props.anchor;
    const op: SyncOp = { opId: crypto.randomUUID(), entity: 'note', entityId: id, op: 'upsert', baseRevision: null, anchor, body, deviceId: deviceId() };
    const saved = (revision: number): NoteView => ({ id, anchor, body, revision, updatedAt: new Date().toISOString(), deleted: false });
    if (await save(op, saved, 'That note could not be saved. Try again.')) setDraft('');
  }

  async function update(event: FormEvent, note: NoteView) {
    event.preventDefault();
    if (!editing || busy) return;
    const body = editing.body.trim();
    if (!body) return;
    const op: SyncOp = { opId: crypto.randomUUID(), entity: 'note', entityId: note.id, op: 'upsert', baseRevision: note.revision, anchor: note.anchor, body, deviceId: deviceId() };
    const saved = (revision: number): NoteView => ({ ...note, body, revision, updatedAt: new Date().toISOString() });
    const conflict = 'This note changed on another device. Its newer text is shown; copy your edit before trying again.';
    if (await save(op, saved, conflict)) setEditing(null);
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
