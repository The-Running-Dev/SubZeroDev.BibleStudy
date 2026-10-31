import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ChapterView, PassageRef, SoloPosition, SyncOp, TranslationId, TranslationView } from '../shared/api.ts';
import { adjacentChapter, bookById, books } from '../shared/books.ts';
import { formatReference, parseReference } from '../shared/reference.ts';
import { ApiFailure, api, messageFor } from './api.ts';
import { AssistantPanel } from './Assistant.tsx';
import { Download } from './Download.tsx';
import { reportFums } from './fums.ts';
import { Notes, inChapter } from './Notes.tsx';
import { offlineChapter } from './offline.ts';
import type { OfflineChapter } from './offline.ts';
import { localPersonal, savePosition as storePosition, sync } from './outbox.ts';
import type { Personal } from './outbox.ts';
import { Passage } from './Passage.tsx';
import { Player } from './Player.tsx';
import { ReaderQuestions } from './Questions.tsx';

// `device` is set when the chapter came from a download because the server could not be reached (S14.2).
type Text = { kind: 'loading' } | { kind: 'ready'; chapter: ChapterView; device: OfflineChapter | null } | { kind: 'unavailable'; message: string };

// No answer at all, or a server that is down: the device's own copy is used if there is one.
const unreachable = (error: unknown) => error instanceof TypeError || (error instanceof ApiFailure && error.status >= 500);

const start: PassageRef = { bookId: 'ROM', chapter: 1, startVerse: null, endVerse: null };
// The solo position is saved once the reader has stayed put this long.
const positionDelayMs = 2_000;
// A failed sync is tried again this often; the reader can move meanwhile.
const pullRetryMs = 5_000;

const positionKey = (p: SoloPosition) => `${p.translationId} ${p.bookId} ${p.chapter}:${p.verse}`;

// Reading on one's own: the reader's own place (solo position), separate from any group's stopping point (S12.2),
// and their private notes. Works with no group and with the study assistant offline (S12.1).

export function Reader(props: { groupId: string | null; userId: string }) {
  const [translations, setTranslations] = useState<TranslationView[]>([]);
  const [translationId, setTranslationId] = useState<TranslationId>('BSB');
  const [at, setAt] = useState<PassageRef>(start);
  const [text, setText] = useState<Text>({ kind: 'loading' });
  const [entry, setEntry] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const [personal, setPersonal] = useState<Personal>({ notes: [], soloPosition: null, conflicts: [] });
  const notes = personal.notes;
  // Whether the saved position has come back; until then nothing is saved, so ROM 1 never overwrites it.
  const [restored, setRestored] = useState(false);
  const moved = useRef(false);
  const savedPosition = useRef<string | null>(null);
  // The place still waiting out the delay, saved at once if the reader leaves first.
  const pendingPosition = useRef<SoloPosition | null>(null);
  // The next try at sending what the device holds, while the server cannot be reached.
  const sendLater = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  function restoreFrom(p: SoloPosition | null) {
    // A reader who already moved keeps their place.
    if (!p || moved.current) return;
    savedPosition.current = positionKey(p);
    setTranslationId(p.translationId);
    setAt({ bookId: p.bookId, chapter: p.chapter, startVerse: p.verse > 1 ? p.verse : null, endVerse: null });
  }

  // Sends what the device is waiting to send and takes what changed (S15). With no server, the device's own copy is
  // shown and the call rejects; `restored` then means the device had a saved place.
  function load(restore: boolean): Promise<void> {
    return sync(props.userId).then(
      (synced) => {
        setPersonal(synced);
        if (restore) restoreFrom(synced.soloPosition);
      },
      async (failure: unknown) => {
        const local = await localPersonal(props.userId).catch(() => null);
        if (local) {
          setPersonal(local);
          if (restore && local.soloPosition) {
            restoreFrom(local.soloPosition);
            setRestored(true);
          }
        }
        throw failure;
      },
    );
  }

  // Sends what was saved on the device, and tries again every so often until the server answers.
  function send() {
    clearTimeout(sendLater.current);
    void load(false).catch(() => {
      if (mounted.current) sendLater.current = setTimeout(send, pullRetryMs);
    });
  }

  // A save on the device shows at once; sending it follows.
  function changed() {
    void localPersonal(props.userId)
      .then((local) => mounted.current && setPersonal(local))
      .catch(() => undefined);
    send();
  }

  function savePosition(position: SoloPosition, keepalive = false) {
    pendingPosition.current = null;
    if (keepalive) {
      // The page is closing: IndexedDB may not finish in time, so the position also goes straight out.
      const op: SyncOp = { opId: crypto.randomUUID(), entity: 'solo_position', op: 'set', baseRevision: null, position };
      void api.push([op], true).catch(() => undefined);
    }
    return storePosition(props.userId, position).then((state) => {
      if (state === 'save_failed') return;
      savedPosition.current = positionKey(position);
      if (!keepalive) send();
    });
  }

  useEffect(() => {
    mounted.current = true;
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const attempt = () =>
      load(true).then(
        () => current && setRestored(true),
        () => {
          if (current) retry = setTimeout(attempt, pullRetryMs);
        },
      );
    void attempt();
    // Back online: send what was saved meanwhile.
    const online = () => send();
    window.addEventListener('online', online);
    return () => {
      current = false;
      mounted.current = false;
      clearTimeout(retry);
      clearTimeout(sendLater.current);
      window.removeEventListener('online', online);
    };
    // Once per page; `load` reads refs and setters only.
  }, []);

  const verse = playing ?? at.startVerse ?? 1;
  useEffect(() => {
    // Before the saved place is back, only a place the reader chose is saved.
    if (!restored && !moved.current) return;
    const position: SoloPosition = { translationId, bookId: at.bookId, chapter: at.chapter, verse };
    if (positionKey(position) === savedPosition.current) {
      pendingPosition.current = null;
      return;
    }
    pendingPosition.current = position;
    const timer = setTimeout(() => void savePosition(position), positionDelayMs);
    return () => clearTimeout(timer);
  }, [restored, translationId, at.bookId, at.chapter, verse]);

  useEffect(() => {
    const flush = () => {
      if (pendingPosition.current) void savePosition(pendingPosition.current, true);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  useEffect(() => {
    api
      .translations()
      .then(setTranslations)
      .catch(() => setTranslations([]));
  }, []);

  useEffect(() => {
    let current = true;
    let audioUrl: string | null = null;
    setText({ kind: 'loading' });
    const ref = { translationId, bookId: at.bookId, chapter: at.chapter };
    api
      .chapter(translationId, at.bookId, at.chapter)
      .then((chapter) => current && setText({ kind: 'ready', chapter, device: null }))
      .catch(async (error) => {
        if (!unreachable(error)) return current && setText({ kind: 'unavailable', message: messageFor(error) });
        const device = await offlineChapter(props.userId, ref).catch(() => null);
        if (device && typeof device === 'object') audioUrl = device.audioUrl;
        if (!current) {
          if (audioUrl) URL.revokeObjectURL(audioUrl);
          return;
        }
        if (device === 'expired') setText({ kind: 'unavailable', message: 'The download of this chapter has expired — connect to download it again.' });
        else if (device) setText({ kind: 'ready', chapter: device.chapter, device });
        // A server that answered with an error is named as such; only no answer at all is "needs a connection".
        else setText({ kind: 'unavailable', message: error instanceof ApiFailure ? messageFor(error) : 'Not downloaded — needs a connection.' });
      });
    return () => {
      current = false;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [translationId, at.bookId, at.chapter, props.userId]);

  const shown = text.kind === 'ready' && text.chapter.bookId === at.bookId && text.chapter.chapter === at.chapter ? text.chapter : null;

  // S13.6: each display of CSB text is reported to API.Bible.
  const fumsToken = shown?.fums?.token;
  useEffect(() => {
    if (fumsToken) reportFums(fumsToken, props.userId);
  }, [fumsToken, shown?.bookId, shown?.chapter, props.userId]);

  // A jump to a verse scrolls it into view once its chapter is on screen; a plain chapter starts at the top.
  // `at` is a new object on every jump, so entering the same reference again scrolls back to it.
  useEffect(() => {
    if (!shown) return;
    const target = at.startVerse === null ? null : document.getElementById(`v-${at.startVerse}`);
    if (target) target.scrollIntoView({ block: 'center' });
    else window.scrollTo({ top: 0 });
    if (at.startVerse !== null && !target) setEntryError(`${formatReference({ ...at, startVerse: null, endVerse: null })} has ${shown.verseCount} verses.`);
  }, [shown, at]);

  const book = bookById(at.bookId)!;
  const device = text.kind === 'ready' ? text.device : null;
  const translation = translations.find((t) => t.id === translationId) ?? device?.translation ?? undefined;
  const notice = translation?.copyrightNotice;
  const previous = adjacentChapter(at, -1);
  const next = adjacentChapter(at, 1);
  const go = (bookId: string, chapter: number) => {
    moved.current = true;
    setAt({ bookId, chapter, startVerse: null, endVerse: null });
  };
  const marked = (verse: number) => shown !== null && at.startVerse !== null && verse >= at.startVerse && verse <= (at.endVerse ?? at.startVerse);

  function jump(event: FormEvent) {
    event.preventDefault();
    const ref = parseReference(entry);
    if (!ref) {
      setEntryError(`"${entry}" is not a reference. Try "Romans 3:12".`);
      return;
    }
    setEntryError(null);
    setEntry('');
    moved.current = true;
    setAt(ref);
  }

  return (
    <>
      <header className="reader-bar">
        <h1 aria-live="polite" data-testid="reference">
          {formatReference(at)}
        </h1>
        <div className="reader-controls">
          <select
            value={translationId}
            onChange={(e) => {
              moved.current = true;
              setTranslationId(e.target.value as TranslationId);
            }}
            aria-label="Translation"
          >
            {(translations.length ? translations.map((t) => t.id) : [...new Set<TranslationId>(['BSB', translationId])]).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <select value={at.bookId} onChange={(e) => go(e.target.value, 1)} aria-label="Book">
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select value={at.chapter} onChange={(e) => go(at.bookId, Number(e.target.value))} aria-label="Chapter">
            {Array.from({ length: book.chapters }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
        </div>
        <form className="reader-jump" onSubmit={jump}>
          <input value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="Go to, e.g. Romans 3:12" aria-label="Reference" enterKeyHint="go" />
          <button type="submit">Go</button>
        </form>
        {entryError && <p role="alert">{entryError}</p>}
      </header>

      {shown && <Player translation={translation} at={at} verseCount={shown.verseCount} onVerse={setPlaying} device={device ?? undefined} />}
      {shown && (
        <Download userId={props.userId} at={{ translationId, bookId: at.bookId, chapter: at.chapter }} narrated={translation?.narration.state === 'available'} fromDevice={device !== null} />
      )}

      <article className="passage" aria-busy={text.kind === 'loading'}>
        {text.kind === 'unavailable' && <p role="status">{text.message}</p>}
        {text.kind === 'ready' && <Passage chapter={text.chapter} marked={marked} playing={shown ? playing : null} />}
        {text.kind === 'ready' && notice && <p className="copyright">{notice}</p>}
      </article>

      <nav className="chapter-nav" aria-label="Chapters">
        <button type="button" className="secondary" disabled={!previous} onClick={() => previous && go(previous.bookId, previous.chapter)}>
          ‹ {previous ? `${bookById(previous.bookId)!.name} ${previous.chapter}` : 'Previous'}
        </button>
        <button type="button" className="secondary" disabled={!next} onClick={() => next && go(next.bookId, next.chapter)}>
          {next ? `${bookById(next.bookId)!.name} ${next.chapter}` : 'Next'} ›
        </button>
      </nav>

      {props.groupId && shown && (
        <ReaderQuestions groupId={props.groupId} userId={props.userId} at={{ translationId, bookId: at.bookId, chapter: at.chapter }} verseCount={shown.verseCount} verse={playing ?? at.startVerse} />
      )}

      <Notes
        anchor={{ translationId, bookId: at.bookId, chapter: at.chapter, startVerse: at.startVerse, endVerse: at.startVerse === null ? null : (at.endVerse ?? at.startVerse) }}
        userId={props.userId}
        notes={notes}
        conflicts={personal.conflicts}
        onChanged={changed}
      />

      {/* Only notes the server has can go with a question. */}
      <AssistantPanel translationId={translationId} at={at} notes={inChapter(notes, at).filter((n) => n.revision > 0)} />
    </>
  );
}
