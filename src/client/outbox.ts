import type { NoteAnchor, NoteConflictView, NoteView, PushResult, SoloPosition, SyncOp, Uuid } from '../shared/api.ts';
import { api } from './api.ts';
import { deviceId } from './device.ts';
import { openDb, request } from './offline.ts';

// A member's notes and solo position kept on the device, and the operations still to send (S15). A save writes the
// note and its operation in one IndexedDB transaction, so "Saved on this device" is said only once both are stored.
// Sending happens later, whenever the server answers, one push at a time per member. Each note has at most one
// operation waiting: a newer save replaces it under a new op id, so a push never holds two edits of one note, and an
// operation is removed only once the server reported what became of it, so a lost answer sends the same op again.

export type SaveState = 'saving' | 'saved_on_device' | 'pending_sync' | 'synced' | 'save_failed';
export type ConflictChoice = 'kept_server' | 'kept_incoming' | 'kept_both';

// A note as this device holds it; `pending` until the server has the latest save.
export interface LocalNote extends NoteView {
  pending: boolean;
}

export interface Personal {
  notes: LocalNote[];
  soloPosition: SoloPosition | null;
  conflicts: NoteConflictView[];
}

interface NoteRecord {
  userId: Uuid;
  id: Uuid;
  note: NoteView;
  // The revision the server last told this device about, or null for a note it has never had.
  serverRevision: number | null;
}

// A delete of a note the server may not have yet carries the save it replaced, sent first under that save's op id.
type WaitingNote = { id: Uuid; anchor: NoteAnchor; body: string } | { id: Uuid; deleted: true; create?: { opId: Uuid; anchor: NoteAnchor; body: string } };

interface OpRecord {
  userId: Uuid;
  // `note:<id>` or `solo`: one waiting operation per note, and one for the position.
  id: string;
  opId: Uuid;
  seq: number;
  note?: WaitingNote;
  position?: SoloPosition;
}

const maxBatch = 200;
let lastSeq = 0;
const nextSeq = () => (lastSeq = Math.max(Date.now(), lastSeq + 1));

const range = (userId: Uuid) => IDBKeyRange.bound([userId, ''], [userId, '￿']);

// The transaction's own outcome: complete means every write is stored; an error or abort (a full disk among them)
// means none is.
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function readAll<T>(name: string, userId: Uuid): Promise<T[]> {
  return request((await openDb()).transaction(name, 'readonly').objectStore(name).getAll(range(userId)) as IDBRequest<T[]>);
}

async function readOne<T>(name: string, userId: Uuid, id: string): Promise<T | undefined> {
  return request((await openDb()).transaction(name, 'readonly').objectStore(name).get([userId, id]) as IDBRequest<T | undefined>);
}

export async function localPersonal(userId: Uuid): Promise<Personal> {
  const [notes, ops, solo, conflicts] = await Promise.all([
    readAll<NoteRecord>('notes', userId),
    readAll<OpRecord>('pendingOps', userId),
    readOne<{ position: SoloPosition }>('soloPosition', userId, 'me'),
    readOne<{ value: NoteConflictView[] }>('meta', userId, 'conflicts'),
  ]);
  const waiting = new Set(ops.map((o) => o.id));
  return {
    notes: notes.map((r) => ({ ...r.note, pending: waiting.has(`note:${r.id}`) })),
    soloPosition: solo?.position ?? null,
    conflicts: conflicts?.value ?? [],
  };
}

type Stores = Record<string, IDBObjectStore>;

// One readwrite transaction over `names`. Every request inside `work` must be issued without awaiting anything but
// requests of the same transaction, or IndexedDB commits it early.
async function write(names: string[], work: (stores: Stores) => Promise<void>): Promise<void> {
  const tx = (await openDb()).transaction(names, 'readwrite');
  const finished = done(tx);
  try {
    await work(Object.fromEntries(names.map((n) => [n, tx.objectStore(n)])));
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Already finished.
    }
    await finished.catch(() => undefined);
    throw error;
  }
  await finished;
}

const getNote = (notes: IDBObjectStore, userId: Uuid, id: Uuid) => request(notes.get([userId, id]) as IDBRequest<NoteRecord | undefined>);

// Saves a note on the device with its operation; 'save_failed' leaves the previous version as it was.
export async function saveNote(userId: Uuid, note: { id: Uuid; anchor: NoteAnchor; body: string }): Promise<SaveState> {
  try {
    await write(['notes', 'pendingOps'], async ({ notes, pendingOps }) => {
      const prior = await getNote(notes, userId, note.id);
      const view: NoteView = { id: note.id, anchor: note.anchor, body: note.body, revision: prior?.note.revision ?? 0, updatedAt: new Date().toISOString(), deleted: false };
      await request(notes.put({ userId, id: note.id, note: view, serverRevision: prior?.serverRevision ?? null } satisfies NoteRecord));
      await request(pendingOps.put({ userId, id: `note:${note.id}`, opId: crypto.randomUUID(), seq: nextSeq(), note } satisfies OpRecord));
    });
    return 'saved_on_device';
  } catch {
    return 'save_failed';
  }
}

export async function deleteNote(userId: Uuid, noteId: Uuid): Promise<SaveState> {
  try {
    await write(['notes', 'pendingOps'], async ({ notes, pendingOps }) => {
      const prior = await getNote(notes, userId, noteId);
      if (!prior) return;
      // Never acknowledged, but its save may have reached the server with the answer lost or still on its way: the
      // save is sent again (the server knows its op id) and the delete follows.
      const sent = prior.serverRevision === null ? await request(pendingOps.get([userId, `note:${noteId}`]) as IDBRequest<OpRecord | undefined>) : undefined;
      const create = sent?.note && !('deleted' in sent.note) ? { opId: sent.opId, anchor: sent.note.anchor, body: sent.note.body } : undefined;
      if (prior.serverRevision === null && !create) {
        await request(notes.delete([userId, noteId]));
        await request(pendingOps.delete([userId, `note:${noteId}`]));
        return;
      }
      const view: NoteView = { ...prior.note, body: '', deleted: true, updatedAt: new Date().toISOString() };
      await request(notes.put({ ...prior, note: view } satisfies NoteRecord));
      const waiting: WaitingNote = { id: noteId, deleted: true, ...(create ? { create } : {}) };
      await request(pendingOps.put({ userId, id: `note:${noteId}`, opId: crypto.randomUUID(), seq: nextSeq(), note: waiting } satisfies OpRecord));
    });
    return 'saved_on_device';
  } catch {
    return 'save_failed';
  }
}

export async function savePosition(userId: Uuid, position: SoloPosition): Promise<SaveState> {
  try {
    await write(['soloPosition', 'pendingOps'], async ({ soloPosition, pendingOps }) => {
      await request(soloPosition.put({ userId, id: 'me', position }));
      await request(pendingOps.put({ userId, id: 'solo', opId: crypto.randomUUID(), seq: nextSeq(), position } satisfies OpRecord));
    });
    return 'saved_on_device';
  } catch {
    return 'save_failed';
  }
}

function toOp(record: OpRecord, notes: Map<string, NoteRecord>): SyncOp | null {
  if (record.position) return { opId: record.opId, entity: 'solo_position', op: 'set', baseRevision: null, position: record.position };
  const n = record.note;
  if (!n) return null;
  const base = notes.get(n.id)?.serverRevision ?? null;
  if ('deleted' in n) {
    if (base !== null) return { opId: record.opId, entity: 'note', entityId: n.id, op: 'delete', baseRevision: base, deviceId: deviceId() };
    const c = n.create;
    return c ? { opId: c.opId, entity: 'note', entityId: n.id, op: 'upsert', baseRevision: null, anchor: c.anchor, body: c.body, deviceId: deviceId() } : null;
  }
  return { opId: record.opId, entity: 'note', entityId: n.id, op: 'upsert', baseRevision: base, anchor: n.anchor, body: n.body, deviceId: deviceId() };
}

// What the server said about one operation. The op is dropped only if no newer save replaced it meanwhile. True when
// it left a delete still to send: the save a delete carried was stored first.
async function settle(userId: Uuid, record: OpRecord, result: PushResult): Promise<boolean> {
  let followUp = false;
  await write(['notes', 'pendingOps'], async ({ notes, pendingOps }) => {
    const waiting = await request(pendingOps.get([userId, record.id]) as IDBRequest<OpRecord | undefined>);
    const replaced = waiting !== undefined && waiting.opId !== record.opId;
    const n = record.note;
    const local = n ? await getNote(notes, userId, n.id) : undefined;
    if (n && 'deleted' in n && n.create && local && local.serverRevision === null && result.outcome !== 'conflict') {
      await request(notes.put({ ...local, serverRevision: result.revision } satisfies NoteRecord));
      if (replaced) return;
      const next: OpRecord = { userId, id: record.id, opId: crypto.randomUUID(), seq: nextSeq(), note: { id: n.id, deleted: true } };
      await request(pendingOps.put(next));
      followUp = true;
      return;
    }
    if (!replaced) await request(pendingOps.delete([userId, record.id]));
    // A conflict leaves the server's version; the pull that follows brings it and the conflict.
    if (!n || !local || result.outcome === 'conflict') return;
    if ('deleted' in n && !replaced) {
      await request(notes.delete([userId, n.id]));
      return;
    }
    const note = replaced ? local.note : { ...local.note, revision: result.revision };
    await request(notes.put({ ...local, serverRevision: result.revision, note } satisfies NoteRecord));
  });
  return followUp;
}

// True when what the server answered left more to send.
async function push(userId: Uuid): Promise<boolean> {
  const [ops, notes] = await Promise.all([readAll<OpRecord>('pendingOps', userId), readAll<NoteRecord>('notes', userId)]);
  const byId = new Map(notes.map((r) => [r.id, r]));
  const queue = ops.sort((a, b) => a.seq - b.seq);
  let more = false;
  for (let i = 0; i < queue.length; i += maxBatch) {
    const batch = queue.slice(i, i + maxBatch).flatMap((record) => {
      const op = toOp(record, byId);
      return op ? [{ record, op }] : [];
    });
    if (!batch.length) continue;
    const { results } = await api.push(batch.map((b) => b.op));
    for (const [k, result] of results.entries()) if (await settle(userId, batch[k].record, result)) more = true;
  }
  return more;
}

// Takes what the server holds, except for notes and the position this device still has to send. A note skipped
// keeps the cursor where it was, so a later pull brings the server's version once nothing waits on it.
async function pull(userId: Uuid): Promise<void> {
  const cursor = (await readOne<{ value: string }>('meta', userId, 'cursor'))?.value ?? null;
  const personal = await api.pull(cursor);
  await write(['notes', 'pendingOps', 'soloPosition', 'meta'], async ({ notes, pendingOps, soloPosition, meta }) => {
    const waiting = new Set((await request(pendingOps.getAll(range(userId)) as IDBRequest<OpRecord[]>)).map((o) => o.id));
    if (cursor === null) {
      // A first pull lists every live note: any other the device holds and is not sending was deleted elsewhere.
      const live = new Set(personal.notes.map((n) => n.id));
      for (const r of await request(notes.getAll(range(userId)) as IDBRequest<NoteRecord[]>)) {
        if (!live.has(r.id) && !waiting.has(`note:${r.id}`)) await request(notes.delete([userId, r.id]));
      }
    }
    let skipped = false;
    for (const note of personal.notes) {
      if (waiting.has(`note:${note.id}`)) {
        skipped = true;
        continue;
      }
      if (note.deleted) await request(notes.delete([userId, note.id]));
      else await request(notes.put({ userId, id: note.id, note, serverRevision: note.revision } satisfies NoteRecord));
    }
    const p = personal.soloPosition;
    if (p && !waiting.has('solo')) {
      const position: SoloPosition = { translationId: p.translationId, bookId: p.bookId, chapter: p.chapter, verse: p.verse };
      await request(soloPosition.put({ userId, id: 'me', position }));
    }
    if (!skipped) await request(meta.put({ userId, id: 'cursor', value: personal.cursor }));
    await request(meta.put({ userId, id: 'conflicts', value: personal.conflicts }));
  });
}

// One sync per member across this device's windows, so two never send the same operation side by side.
function exclusive<T>(userId: Uuid, work: () => Promise<T>): Promise<T> {
  return 'locks' in navigator ? navigator.locks.request(`outbox:${userId}`, work) : work();
}

const running = new Map<Uuid, { run: Promise<Personal>; again?: Promise<Personal> }>();

// Sends what is waiting, then takes what changed. Rejects when the server cannot be reached; the device keeps
// everything and `localPersonal` still answers. A call during a run gets one more run after it, so a save made
// meanwhile is sent too.
export function sync(userId: Uuid): Promise<Personal> {
  const current = running.get(userId);
  if (current) {
    current.again ??= current.run.catch(() => undefined).then(() => sync(userId));
    return current.again;
  }
  const run = exclusive(userId, async () => {
    if (await push(userId)) await push(userId);
    await pull(userId);
    return localPersonal(userId);
  }).finally(() => running.delete(userId));
  running.set(userId, { run });
  return run;
}

// The member's choice for a conflict; the notes it left replace the device's copy.
export async function resolveConflict(userId: Uuid, conflictId: Uuid, choice: ConflictChoice): Promise<Personal> {
  const kept = await api.resolveConflict(conflictId, choice);
  await write(['notes', 'pendingOps', 'meta'], async ({ notes, pendingOps, meta }) => {
    // A note saved again meanwhile keeps the device's text; that save meets the chosen version and asks again.
    const waiting = new Set((await request(pendingOps.getAll(range(userId)) as IDBRequest<OpRecord[]>)).map((o) => o.id));
    for (const note of kept) {
      if (!waiting.has(`note:${note.id}`)) await request(notes.put({ userId, id: note.id, note, serverRevision: note.revision } satisfies NoteRecord));
    }
    const open = (await request(meta.get([userId, 'conflicts']) as IDBRequest<{ value: NoteConflictView[] } | undefined>))?.value ?? [];
    await request(meta.put({ userId, id: 'conflicts', value: open.filter((c) => c.id !== conflictId) }));
  });
  return localPersonal(userId);
}
