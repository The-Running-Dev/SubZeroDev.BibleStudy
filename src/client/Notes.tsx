import { useState } from 'react';
import type { FormEvent } from 'react';
import type { NoteAnchor, NoteConflictView, NoteView } from '../shared/api.ts';
import { formatReference } from '../shared/reference.ts';
import { messageFor } from './api.ts';
import type { ConflictChoice, LocalNote } from './outbox.ts';
import { deleteNote, resolveConflict, saveNote } from './outbox.ts';

// The reader's own notes on the chapter on screen. Only their author ever receives them (I-21). A save lands on the
// device first and is sent when the server answers (S15); a note edited on two devices from the same version shows
// both versions until the reader chooses.

export const inChapter = <T extends NoteView>(notes: T[], at: { bookId: string; chapter: number }) =>
  notes.filter((n) => !n.deleted && n.anchor.bookId === at.bookId && n.anchor.chapter === at.chapter);

const byVerse = (a: NoteView, b: NoteView) => (a.anchor.startVerse ?? 0) - (b.anchor.startVerse ?? 0) || a.updatedAt.localeCompare(b.updatedAt);

const saveFailed = 'Save failed: this device has no room to store it. Your text is still in the box; the saved version is unchanged.';
// The server's limit on one note (contract: payload_too_large).
const maxNoteBytes = 64 * 1024;
const tooLarge = 'A note is at most 64 KB. Split it into smaller notes.';
const fits = (body: string) => new TextEncoder().encode(body).length <= maxNoteBytes;

export function Notes(props: {
  userId: string;
  anchor: NoteAnchor;
  notes: LocalNote[];
  conflicts: NoteConflictView[];
  // The device's copy changed; the reader reloads it and sends what is waiting.
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The new note's id, kept until it is stored, so saving the same text again never makes two.
  const [newId, setNewId] = useState(() => crypto.randomUUID());
  const shown = inChapter(props.notes, props.anchor).sort(byVerse);
  // A conflict whose note is gone from this device: the note was deleted on another device while this one edited it.
  const live = new Set(props.notes.filter((n) => !n.deleted).map((n) => n.id));
  const orphans = props.conflicts.filter((c) => !live.has(c.noteId));

  async function stored(save: () => Promise<string>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      if ((await save()) === 'save_failed') {
        setError(saveFailed);
        return false;
      }
      props.onChanged();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    if (!fits(body)) return setError(tooLarge);
    if (!(await stored(() => saveNote(props.userId, { id: newId, anchor: props.anchor, body })))) return;
    setNewId(crypto.randomUUID());
    setDraft('');
  }

  async function update(event: FormEvent, note: NoteView) {
    event.preventDefault();
    if (!editing || busy) return;
    const body = editing.body.trim();
    if (!body) return;
    if (!fits(body)) return setError(tooLarge);
    if (await stored(() => saveNote(props.userId, { id: note.id, anchor: note.anchor, body }))) setEditing(null);
  }

  async function remove(note: NoteView) {
    if (busy) return;
    await stored(() => deleteNote(props.userId, note.id));
  }

  async function choose(conflict: NoteConflictView, choice: ConflictChoice) {
    setBusy(true);
    setError(null);
    try {
      await resolveConflict(props.userId, conflict.id, choice);
      props.onChanged();
    } catch (failure) {
      setError(failure instanceof TypeError ? 'Choosing a version needs a connection.' : messageFor(failure));
      if (!(failure instanceof TypeError)) props.onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="notes" aria-label="My notes">
      <h2>My notes</h2>
      {orphans.map((conflict) => (
        <div key={conflict.id} className="note-conflict" role="group" aria-label="A note deleted on another device">
          <p>This note was deleted on another device while you changed it here. Keep your version?</p>
          <blockquote className="note-body" data-version="other">
            {conflict.incomingBody}
          </blockquote>
          <button type="button" disabled={busy} onClick={() => choose(conflict, 'kept_incoming')}>
            Keep my version
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => choose(conflict, 'kept_server')}>
            Let it go
          </button>
        </div>
      ))}
      {shown.length > 0 && (
        <ul className="notes-list">
          {shown.map((note) => {
            const conflict = props.conflicts.find((c) => c.noteId === note.id);
            return (
              <li key={note.id} data-note={note.id}>
                <p className="note-reference">{formatReference(note.anchor)}</p>
                {conflict ? (
                  <div className="note-conflict" role="group" aria-label="Two versions of this note">
                    <p>This note was changed on two devices. Choose what to keep.</p>
                    <blockquote className="note-body" data-version="saved">
                      {conflict.serverBody}
                    </blockquote>
                    <button type="button" className="secondary" disabled={busy} onClick={() => choose(conflict, 'kept_server')}>
                      Keep this version
                    </button>
                    <blockquote className="note-body" data-version="other">
                      {conflict.incomingBody}
                    </blockquote>
                    <button type="button" className="secondary" disabled={busy} onClick={() => choose(conflict, 'kept_incoming')}>
                      Keep the other version
                    </button>
                    <button type="button" disabled={busy} onClick={() => choose(conflict, 'kept_both')}>
                      Keep both
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="note-body">{note.body}</p>
                    {note.pending && (
                      <p className="note-state" data-save-state="saved_on_device">
                        Saved on this device
                      </p>
                    )}
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
                        <button type="button" className="secondary" onClick={() => setEditing({ id: note.id, body: note.body })}>
                          Edit
                        </button>
                        <button type="button" className="secondary" disabled={busy} onClick={() => remove(note)}>
                          Delete
                        </button>
                      </>
                    )}
                  </>
                )}
              </li>
            );
          })}
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
