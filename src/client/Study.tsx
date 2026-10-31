import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { ChapterView, Command, GroupProgressView, PassageRef, PlaybackState, Presence, QuestionView, RecordingView, ServerMessage, TranslationId, TranslationView } from '../shared/api.ts';
import { adjacentChapter, bookById } from '../shared/books.ts';
import { verseAtSeconds } from '../shared/playback.ts';
import { formatReference, parseReference } from '../shared/reference.ts';
import { ApiFailure, api, messageFor } from './api.ts';
import { connectLive } from './live.ts';
import type { Live, LiveStatus } from './live.ts';
import { Passage } from './Passage.tsx';
import { formatStop } from './progress.ts';
import { applyQuestion, mergeQuestions, pacedBy, reveal } from './questions.ts';
import { AskForm, QuestionList } from './Questions.tsx';
import { rangeOf, syncStep, targetSeconds } from './sync.ts';
import { ConfirmStop, WrapUp } from './WrapUp.tsx';

const rates = [0.75, 1, 1.25, 1.5];
const syncEveryMs = 250;
const driftEveryMs = 5_000;
// While the recording is being fetched, ask for a fresh snapshot this often.
const preparingPollMs = 5_000;

type Entry = { kind: 'checking' } | { kind: 'idle'; active: boolean; progress: GroupProgressView | null; error: string | null } | { kind: 'joined'; sessionId: string; state: PlaybackState };

// The group's shared study: start or join, then everyone follows one PlaybackState.
export function Study(props: { groupId: string; userId: string }) {
  const [entry, setEntry] = useState<Entry>({ kind: 'checking' });
  // The study that just ended here, which can still be wrapped up (S9.4).
  const [lastSession, setLastSession] = useState<string | null>(null);
  const [wrappingLast, setWrappingLast] = useState(false);

  const check = useCallback(() => {
    const progress = api
      .progress(props.groupId)
      .then((p) => p.progress)
      .catch(() => null);
    api
      .activeSession(props.groupId)
      .then(async () => setEntry({ kind: 'idle', active: true, progress: await progress, error: null }))
      .catch(async (error) => {
        const missing = error instanceof ApiFailure && error.body.error === 'no_active_session';
        setEntry({ kind: 'idle', active: false, progress: await progress, error: missing ? null : messageFor(error) });
      });
  }, [props.groupId]);
  useEffect(check, [check]);
  const ended = useCallback(
    (sessionId: string) => {
      setLastSession(sessionId);
      check();
    },
    [check],
  );

  async function enter() {
    try {
      const { sessionId, state } = await api.startSession(props.groupId);
      setEntry({ kind: 'joined', sessionId, state });
    } catch (error) {
      const progress = entry.kind === 'idle' ? entry.progress : null;
      setEntry({ kind: 'idle', active: false, progress, error: messageFor(error) });
    }
  }

  if (entry.kind === 'checking') return <section className="study" aria-label="Study" aria-busy="true" />;
  if (entry.kind === 'idle') {
    return (
      <section className="study" aria-label="Study">
        {entry.error && <p role="alert">{entry.error}</p>}
        <p>{entry.active ? 'Your group is studying now.' : 'No study is running. Start one and the group can join.'}</p>
        <button type="button" onClick={() => void enter()}>
          {entry.active ? 'Join study' : entry.progress ? `Resume study at ${formatStop(entry.progress.ref)}` : 'Start study'}
        </button>
        {!entry.active && (
          <details className="starting-point">
            <summary>{entry.progress ? 'Change where the next study starts' : 'Set the starting point'}</summary>
            <ConfirmStop groupId={props.groupId} initial="" label="Confirm starting point" onConfirmed={check} />
          </details>
        )}
        {!entry.active &&
          lastSession &&
          (wrappingLast ? (
            <WrapUp
              groupId={props.groupId}
              sessionId={lastSession}
              onClose={() => {
                setWrappingLast(false);
                setLastSession(null);
                check();
              }}
            />
          ) : (
            <button type="button" className="secondary" onClick={() => setWrappingLast(true)}>
              Wrap up the last study
            </button>
          ))}
      </section>
    );
  }
  return <LiveStudy key={entry.sessionId} groupId={props.groupId} userId={props.userId} sessionId={entry.sessionId} initial={entry.state} onEnded={ended} />;
}

function statusLine(state: PlaybackState): string {
  if (state.status === 'playing') return 'Playing';
  switch (state.pausedReason) {
    case 'member':
      return state.changedBy ? `Paused by ${state.changedBy.displayName}` : 'Paused';
    case 'server_restart':
      return 'Paused — server restarted';
    case 'room_empty':
      return 'Paused — everyone had left';
    case 'range_end':
      return 'End of passage';
    default:
      return 'Paused';
  }
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function connectionNote(status: LiveStatus): string | null {
  if (status === 'open') return null;
  if (status === 'connecting') return 'Connecting…';
  if (status === 'reconnecting') return 'Reconnecting…';
  if (status.closed === 'not_member') return 'You are no longer a member of this group.';
  if (status.closed === 'signed_out') return 'You were signed out. Reload to sign in again.';
  return 'Too many open tabs. Close another tab and reload.';
}

function LiveStudy(props: { groupId: string; userId: string; sessionId: string; initial: PlaybackState; onEnded: (sessionId: string) => void }) {
  const { groupId, sessionId, onEnded } = props;
  const [state, setState] = useState<PlaybackState>(props.initial);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [verse, setVerse] = useState<number | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [questions, setQuestions] = useState<QuestionView[]>([]);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [wrapping, setWrapping] = useState(false);
  // The server no longer knows the session: it ended while this client was away.
  const [gone, setGone] = useState(false);
  // Re-renders the position label and slider while playing.
  const [, setNow] = useState(0);
  const live = useRef<Live | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastDrift = useRef<number | null>(null);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

  // A state is taken only when it is at least as new as the one shown, whether it came as a snapshot, a broadcast
  // or a command's result; revisions only grow within a session.
  const accept = useCallback((next: PlaybackState) => {
    setState((previous) => (next.sessionId !== previous.sessionId || next.revision >= previous.revision ? next : previous));
  }, []);

  useEffect(() => {
    const onMessage = (message: ServerMessage) => {
      switch (message.t) {
        case 'snapshot':
          accept(message.state);
          setPresence(message.presence);
          setQuestions(message.questions);
          return;
        case 'question':
          setQuestions((list) => applyQuestion(list, message.question, stateRef.current.passage));
          return;
        case 'state':
          accept(message.state);
          return;
        case 'result':
          accept(message.state);
          if (message.outcome === 'rejected_stale') setNotice('Someone else changed it first — showing the latest.');
          else if (message.outcome === 'rejected_invalid') setNotice(message.reason ?? 'That change was not allowed.');
          return;
        case 'presence':
          setPresence(message.presence);
          return;
        case 'error':
          if (message.error === 'no_active_session') setGone(true);
          else if (message.error !== 'not_member' && message.error !== 'unauthenticated') setNotice(`Something went wrong (${message.error}).`);
          return;
        case 'pong':
          return;
      }
    };
    const channel = connectLive({ onMessage, onStatus: setStatus });
    channel.join(sessionId);
    live.current = channel;
    return () => {
      channel.close();
      live.current = null;
    };
  }, [sessionId, accept]);

  // Follows the shared state: plays, pauses, corrects drift, and tracks the verse being read.
  useEffect(() => {
    const tick = () => {
      const element = audio.current;
      const current = stateRef.current;
      const channel = live.current;
      if (current.mode === 'manual') {
        setVerse(current.manualVerse);
        return;
      }
      // Until the first pong the server clock is unknown; following it would start at the wrong second and jump.
      if (!element || !channel || !channel.clockReady()) return;
      if (current.status === 'playing') setNow(channel.serverNow());
      lastDrift.current = blockedRef.current ? null : syncStep(element, current, channel.serverNow(), () => setBlocked(true));
      const timing = current.recording?.timing;
      setVerse(timing && (current.status === 'playing' || element.currentTime > 0) ? verseAtSeconds(timing, element.currentTime) : null);
    };
    tick();
    const timer = setInterval(tick, syncEveryMs);
    return () => clearInterval(timer);
  }, [state]);

  // Every 5 s: the measured drift for the room's report, and whether this client is ready to play.
  useEffect(() => {
    const timer = setInterval(() => {
      const current = stateRef.current;
      const element = audio.current;
      const ready = current.mode === 'manual' || (!blockedRef.current && !!element && element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA);
      // A client seeking or starting has no steady reading yet.
      if (current.mode === 'narration' && current.status === 'playing' && lastDrift.current === null && ready) return;
      live.current?.drift(sessionId, lastDrift.current ?? 0, ready);
    }, driftEveryMs);
    return () => clearInterval(timer);
  }, [sessionId]);

  // A recording still being fetched shows up in a later snapshot.
  const waiting = state.mode === 'narration' && !state.recording && state.status !== 'ended';
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => live.current?.join(sessionId), preparingPollMs);
    return () => clearInterval(timer);
  }, [waiting, sessionId]);

  // An open wrap-up stays open when the study ends, so a member finishing it loses nothing; it leaves when they close it.
  useEffect(() => {
    if ((state.status === 'ended' || gone) && !wrapping) onEnded(sessionId);
  }, [state.status, gone, wrapping, sessionId, onEnded]);

  // The questions the study keeps in view (S9.4), again whenever the chapter changes or a post here changed one.
  const { bookId, chapter } = state.passage;
  const [questionsLoad, setQuestionsLoad] = useState(0);
  useEffect(() => {
    let current = true;
    api
      .wrapUp(groupId, sessionId)
      .then((view) => current && setQuestions((local) => mergeQuestions(local, view.openQuestions, { bookId, chapter })))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [groupId, sessionId, bookId, chapter, questionsLoad]);

  // Without verse timing there is nothing to pace the questions by, so they are all shown. A new chapter starts over;
  // questions from other chapters are shown at once.
  const paced = pacedBy(state);
  const chapterKey = `${bookId} ${chapter}`;
  const revealedFor = useRef(chapterKey);
  useEffect(() => {
    const fresh = revealedFor.current !== chapterKey;
    revealedFor.current = chapterKey;
    setShown((previous) => reveal(questions, paced ? verse : Number.MAX_SAFE_INTEGER, fresh ? new Set() : previous, { bookId, chapter }));
  }, [questions, verse, chapterKey, paced, bookId, chapter]);
  const visible = questions.filter((q) => shown.has(q.id));

  function send(command: Command) {
    const id = live.current?.command(sessionId, stateRef.current.revision, command) ?? null;
    setNotice(id ? null : 'Not connected — your change was not sent.');
  }

  // The shared position now, for seeks relative to what is being heard.
  function positionNow(): number {
    return live.current ? targetSeconds(stateRef.current, live.current.serverNow()) : stateRef.current.positionSeconds;
  }

  // The tap that lets the browser start audio; it also starts this client at the shared position.
  function joinAudio() {
    const element = audio.current;
    if (!element || !live.current) return;
    if (stateRef.current.status !== 'playing') {
      // The tap itself unlocks audio; a paused room starts nothing.
      setBlocked(false);
      return;
    }
    element.currentTime = targetSeconds(stateRef.current, live.current.serverNow());
    element
      .play()
      .then(() => setBlocked(false))
      .catch(() => setBlocked(true));
  }

  const range = rangeOf(state);
  const position = live.current ? targetSeconds(state, live.current.serverNow()) : state.positionSeconds;

  return (
    <section className="study" aria-label="Study">
      {connectionNote(status) && (
        <p className="study-connection" role="status">
          {connectionNote(status)}
        </p>
      )}
      <StudyPassage state={state} verse={verse} onSetPassage={(passage) => send({ kind: 'set_passage', passage })} onTapVerse={(v) => send({ kind: 'set_manual_verse', verse: v })}>
        <div className="study-controls">
          <p className="study-status" data-testid="study-status" aria-live="polite">
            {statusLine(state)}
          </p>
          {notice && <p role="alert">{notice}</p>}
          {state.mode === 'narration' && state.recording && (
            <>
              <div className="player-row">
                <button type="button" onClick={() => send({ kind: state.status === 'playing' ? 'pause' : 'play' })}>
                  {state.status === 'playing' ? 'Pause' : 'Play'}
                </button>
                <button type="button" className="secondary" aria-label="Back 10 seconds" onClick={() => send({ kind: 'seek', positionSeconds: positionNow() - 10 })}>
                  −10 s
                </button>
                <button type="button" className="secondary" aria-label="Forward 10 seconds" onClick={() => send({ kind: 'seek', positionSeconds: positionNow() + 10 })}>
                  +10 s
                </button>
                <span className="player-label" data-testid="study-position">
                  {clock(position - (range?.start ?? 0))} / {clock((range?.end ?? 0) - (range?.start ?? 0))}
                </span>
              </div>
              {range && (
                <input
                  type="range"
                  aria-label="Position"
                  min={range.start}
                  max={range.end}
                  step={0.5}
                  value={scrub ?? position}
                  onChange={(e) => setScrub(Number(e.target.value))}
                  onPointerUp={() => scrub !== null && (send({ kind: 'seek', positionSeconds: scrub }), setScrub(null))}
                  onKeyUp={() => scrub !== null && (send({ kind: 'seek', positionSeconds: scrub }), setScrub(null))}
                />
              )}
              {blocked && (
                <button type="button" onClick={joinAudio}>
                  Tap to join audio
                </button>
              )}
              <audio ref={audio} key={state.recording.mediaUrl} src={state.recording.mediaUrl} preload="auto" aria-label={`${formatReference(state.passage)} read by ${state.recording.narratorName}`} />
            </>
          )}
          {waiting && <p className="player-note" role="status">Preparing narration…</p>}
          {state.mode === 'manual' && <p className="player-note">Reading together — tap a verse to mark it for everyone.</p>}
          <StudySettings state={state} send={send} />
          <ul className="presence" aria-label="Here now">
            {presence.map((p) => (
              <li key={p.userId}>
                {p.displayName}
                {p.connections > 1 && ` (${p.connections} devices)`}
                {state.mode === 'narration' && !p.ready && ' · joining audio'}
              </li>
            ))}
          </ul>
          <section className="questions" aria-label="Questions">
            <h2>Questions</h2>
            <div aria-live="polite">
              <QuestionList groupId={groupId} userId={props.userId} questions={visible} onChanged={() => setQuestionsLoad((n) => n + 1)} empty="No open questions yet." />
            </div>
            <AskForm
              groupId={groupId}
              at={{ translationId: state.translationId, bookId, chapter }}
              verse={verse}
              onPosted={(question) => {
                // One's own question shows at once, wherever the reading is.
                setQuestions((list) => applyQuestion(list, question, state.passage));
                setShown((previous) => new Set([...previous, question.id]));
              }}
            />
          </section>
          {wrapping ? (
            <WrapUp groupId={groupId} sessionId={sessionId} onClose={() => setWrapping(false)} />
          ) : (
            <button type="button" onClick={() => setWrapping(true)}>
              Wrap up
            </button>
          )}
          {state.status === 'ended' ? (
            <p className="player-note" role="status">
              This study has ended. Choose Done when the wrap-up is finished.
            </p>
          ) : (
            <button type="button" className="secondary" onClick={() => send({ kind: 'end_session' })}>
              End study
            </button>
          )}
        </div>
      </StudyPassage>
    </section>
  );
}

function StudySettings(props: { state: PlaybackState; send: (command: Command) => void }) {
  const { state, send } = props;
  const [translations, setTranslations] = useState<TranslationView[]>([]);
  const [narrators, setNarrators] = useState<RecordingView[]>([]);

  useEffect(() => {
    api
      .translations()
      .then(setTranslations)
      .catch(() => setTranslations([]));
  }, []);

  // Narrators come from the BSB recordings of the shared chapter; asking also starts fetching any not yet stored.
  useEffect(() => {
    if (state.mode !== 'narration') return;
    let current = true;
    api
      .recordings('BSB', state.passage.bookId, state.passage.chapter)
      .then((listing) => current && setNarrators(listing.recordings))
      .catch(() => current && setNarrators([]));
    return () => {
      current = false;
    };
  }, [state.mode, state.passage.bookId, state.passage.chapter, state.recordingId]);

  const narratorOptions = narrators.length ? narrators : state.recording ? [state.recording] : [];
  return (
    <div className="player-row">
      <select value={state.translationId} onChange={(e) => send({ kind: 'set_translation', translationId: e.target.value as TranslationId })} aria-label="Shared translation">
        {(translations.length ? translations.map((t) => t.id) : [state.translationId]).map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      {state.mode === 'narration' && narratorOptions.length > 0 && (
        <select value={state.narratorId ?? ''} onChange={(e) => send({ kind: 'set_narrator', narratorId: e.target.value })} aria-label="Shared narrator">
          {narratorOptions.map((r) => (
            <option key={r.narratorId} value={r.narratorId}>
              {r.narratorName}
            </option>
          ))}
        </select>
      )}
      {state.mode === 'narration' && (
        <select value={state.rate} onChange={(e) => send({ kind: 'set_rate', rate: Number(e.target.value) })} aria-label="Speed">
          {(rates.includes(state.rate) ? rates : [...rates, state.rate].sort()).map((rate) => (
            <option key={rate} value={rate}>
              {rate}×
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

type Text = { kind: 'loading' } | { kind: 'ready'; chapter: ChapterView; fallback: string | null } | { kind: 'unavailable'; message: string };

// The shared passage: its text in the member's own display translation if they chose one (S12.4), else the shared
// translation; BSB when that text cannot be shown. Then the passage controls.
function StudyPassage(props: {
  state: PlaybackState;
  verse: number | null;
  onSetPassage: (passage: PassageRef) => void;
  onTapVerse: (verse: number) => void;
  children: ReactNode;
}) {
  const { state } = props;
  const { bookId, chapter } = state.passage;
  const [text, setText] = useState<Text>({ kind: 'loading' });
  const [entry, setEntry] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);
  // The member's own translation for the text; the group keeps the shared one, and the recording follows it.
  const [display, setDisplay] = useState<TranslationId | null>(null);
  const [displayError, setDisplayError] = useState<string | null>(null);
  const [translations, setTranslations] = useState<TranslationView[]>([]);
  const translationId = display ?? state.translationId;

  useEffect(() => {
    api
      .me()
      .then((me) => setDisplay(me.displayTranslationId))
      .catch(() => undefined);
    api
      .translations()
      .then(setTranslations)
      .catch(() => setTranslations([]));
  }, []);

  async function chooseDisplay(next: TranslationId | null) {
    const before = display;
    setDisplay(next);
    setDisplayError(null);
    try {
      setDisplay((await api.updateMe({ displayTranslationId: next })).displayTranslationId);
    } catch (failure) {
      setDisplay(before);
      setDisplayError(messageFor(failure));
    }
  }

  useEffect(() => {
    let current = true;
    setText({ kind: 'loading' });
    api
      .chapter(translationId, bookId, chapter)
      .then((c) => current && setText({ kind: 'ready', chapter: c, fallback: null }))
      .catch(async (error) => {
        if (!current) return;
        if (translationId === 'BSB') return setText({ kind: 'unavailable', message: messageFor(error) });
        try {
          const c = await api.chapter('BSB', bookId, chapter);
          if (current) setText({ kind: 'ready', chapter: c, fallback: `${translationId} text is not available here (${messageFor(error)}) — showing BSB.` });
        } catch (second) {
          if (current) setText({ kind: 'unavailable', message: messageFor(second) });
        }
      });
    return () => {
      current = false;
    };
  }, [translationId, bookId, chapter]);

  function jump(event: FormEvent) {
    event.preventDefault();
    const ref = parseReference(entry);
    if (!ref) {
      setEntryError(`"${entry}" is not a reference. Try "Romans 3:12".`);
      return;
    }
    setEntryError(null);
    setEntry('');
    props.onSetPassage(ref);
  }

  const previous = adjacentChapter(state.passage, -1);
  const next = adjacentChapter(state.passage, 1);
  const go = (to: { bookId: string; chapter: number }) => props.onSetPassage({ bookId: to.bookId, chapter: to.chapter, startVerse: null, endVerse: null });
  const { startVerse, endVerse } = state.passage;
  const marked = (v: number) => startVerse !== null && v >= startVerse && v <= (endVerse ?? startVerse);

  return (
    <>
      <header className="reader-bar">
        <h1 aria-live="polite" data-testid="study-reference">
          {formatReference(state.passage)}
        </h1>
        <form className="reader-jump" onSubmit={jump}>
          <input value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="Study passage, e.g. Romans 3:12-18" aria-label="Study passage" enterKeyHint="go" />
          <button type="submit">Set</button>
        </form>
        {entryError && <p role="alert">{entryError}</p>}
        <label className="display-translation">
          Your display translation
          <select value={display ?? ''} onChange={(e) => chooseDisplay(e.target.value === '' ? null : (e.target.value as TranslationId))}>
            <option value="">Same as the group ({state.translationId})</option>
            {(translations.length ? translations.map((t) => t.id) : (['BSB'] as TranslationId[])).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        {display !== null && display !== state.translationId && (
          <p className="player-note" data-testid="display-translation">
            Your display translation is {display}. The group reads {state.translationId}.
          </p>
        )}
        {displayError && <p role="alert">{displayError}</p>}
      </header>
      {props.children}
      <article className="passage" aria-busy={text.kind === 'loading'}>
        {text.kind === 'unavailable' && <p role="status">{text.message}</p>}
        {text.kind === 'ready' && text.fallback && <p className="player-note">{text.fallback}</p>}
        {text.kind === 'ready' && <Passage chapter={text.chapter} marked={marked} playing={props.verse} onTap={state.mode === 'manual' ? props.onTapVerse : undefined} />}
      </article>
      <nav className="chapter-nav" aria-label="Chapters">
        <button type="button" className="secondary" disabled={!previous} onClick={() => previous && go(previous)}>
          ‹ {previous ? `${bookById(previous.bookId)!.name} ${previous.chapter}` : 'Previous'}
        </button>
        <button type="button" className="secondary" disabled={!next} onClick={() => next && go(next)}>
          {next ? `${bookById(next.bookId)!.name} ${next.chapter}` : 'Next'} ›
        </button>
      </nav>
    </>
  );
}
