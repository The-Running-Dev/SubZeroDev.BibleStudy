import { useEffect, useRef, useState } from 'react';
import type { PassageRef, RecordingsResponse, RecordingView, TranslationView } from '../shared/api.ts';
import { formatReference } from '../shared/reference.ts';
import { api, messageFor } from './api.ts';
import { verseAt } from './timing.ts';

const pollMs = 5000;

type Listing = { kind: 'loading' } | { kind: 'ready'; listing: RecordingsResponse } | { kind: 'error'; message: string };

// Solo playback of the displayed chapter (S3). `onVerse` gets the verse being read, or null when none is.
export function Player(props: { translation: TranslationView | undefined; at: PassageRef; verseCount: number | null; onVerse: (verse: number | null) => void }) {
  const { translation, at, verseCount, onVerse } = props;
  const audio = useRef<HTMLAudioElement>(null);
  // A range play stops when the next verse starts; the last verse of the range stays highlighted until the next seek or play.
  const stopAt = useRef<{ from: number; seconds: number; verse: number } | null>(null);
  const held = useRef<number | null>(null);
  const [state, setState] = useState<Listing>({ kind: 'loading' });
  const [narratorId, setNarratorId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const narrated = translation?.narration.state === 'available';

  useEffect(() => {
    if (!translation || !narrated) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ kind: 'loading' });
    const load = () =>
      api
        .recordings(translation.id, at.bookId, at.chapter)
        .then((listing) => {
          if (!current) return;
          setState({ kind: 'ready', listing });
          // A recording still being fetched is asked for again until it is stored or has failed.
          if (listing.preparing.length) timer = setTimeout(load, pollMs);
        })
        .catch((error) => current && setState({ kind: 'error', message: messageFor(error) }));
    void load();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [translation, narrated, at.bookId, at.chapter]);

  const recordings = state.kind === 'ready' ? state.listing.recordings : [];
  const recording: RecordingView | undefined = recordings.find((r) => r.narratorId === narratorId) ?? recordings[0];
  const starts = recording?.timing.status === 'verified' ? recording.timing.verseStarts : null;

  // A new chapter or narrator starts with nothing highlighted.
  useEffect(() => {
    setLoadError(null);
    stopAt.current = null;
    held.current = null;
    onVerse(null);
  }, [recording?.mediaUrl, onVerse]);

  // Follows the position: every frame while playing, and on each seek or time update while paused.
  useEffect(() => {
    const element = audio.current;
    if (!element || !starts) return;
    let frame = 0;
    const update = () => {
      const t = element.currentTime;
      const stop = stopAt.current;
      if (stop && t >= stop.seconds) {
        stopAt.current = null;
        held.current = stop.verse;
        element.pause();
      }
      onVerse(held.current ?? (element.paused && t === 0 ? null : verseAt(starts, t)));
    };
    // Seeking out of the range ends the range play.
    const release = () => {
      const stop = stopAt.current;
      if (stop && (element.currentTime < stop.from - 0.05 || element.currentTime >= stop.seconds)) stopAt.current = null;
      held.current = null;
      update();
    };
    const tick = () => {
      update();
      if (!element.paused) frame = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      held.current = null;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const events = ['timeupdate', 'pause'] as const;
    for (const name of events) element.addEventListener(name, update);
    element.addEventListener('seeked', release);
    element.addEventListener('play', onPlay);
    return () => {
      cancelAnimationFrame(frame);
      for (const name of events) element.removeEventListener(name, update);
      element.removeEventListener('seeked', release);
      element.removeEventListener('play', onPlay);
    };
  }, [starts, onVerse]);

  if (!translation) return null;
  if (translation.narration.state !== 'available') {
    return (
      <section className="player" aria-label="Narration">
        <p className="player-note">{translation.narration.reason}</p>
      </section>
    );
  }

  const range = at.startVerse !== null ? { first: at.startVerse, last: Math.min(at.endVerse ?? at.startVerse, verseCount ?? Infinity) } : null;
  const canPlayRange = starts !== null && range !== null && range.first <= starts.length;

  async function playRange() {
    const element = audio.current;
    if (!element || !starts || !range) return;
    if (element.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise((resolve) => element.addEventListener('loadedmetadata', resolve, { once: true }));
    }
    element.currentTime = starts[range.first - 1];
    stopAt.current = range.last < starts.length ? { from: starts[range.first - 1], seconds: starts[range.last], verse: range.last } : null;
    await element.play().catch(() => undefined);
  }

  const listing = state.kind === 'ready' ? state.listing : null;
  const preparing = listing !== null && recordings.length === 0 && listing.preparing.length > 0;
  const failed = listing !== null && recordings.length === 0 && listing.preparing.length === 0 ? listing.failed : [];

  return (
    <section className="player" aria-label="Narration">
      {state.kind === 'loading' && <p className="player-note">Loading narration…</p>}
      {state.kind === 'error' && <p className="player-note" role="status">{state.message}</p>}
      {preparing && <p className="player-note" role="status">Preparing narration…</p>}
      {failed.length > 0 && (
        <p className="player-note" role="status">
          Preparing narration failed — try later. ({failed.map((f) => f.reason).join('; ')})
        </p>
      )}
      {recording && (
        <>
          <div className="player-row">
            <select value={recording.narratorId} onChange={(e) => setNarratorId(e.target.value)} aria-label="Narrator">
              {recordings.map((r) => (
                <option key={r.narratorId} value={r.narratorId}>
                  {r.narratorName}
                </option>
              ))}
            </select>
            <span className="player-label" data-testid="narration-label">
              {recording.narratorName} · {translation.name}
            </span>
            {range && (
              <button type="button" className="secondary" disabled={!canPlayRange} onClick={() => void playRange()}>
                Play {formatReference(at)}
              </button>
            )}
          </div>
          <audio
            ref={audio}
            src={recording.mediaUrl}
            controls
            preload="metadata"
            aria-label={`${formatReference({ ...at, startVerse: null, endVerse: null })} read by ${recording.narratorName}`}
            onError={() => setLoadError('Narration unavailable for this chapter: the recording could not be loaded.')}
          />
          {recording.timing.status !== 'verified' && (
            <p className="player-note" role="status">
              Verse following unavailable for this recording
            </p>
          )}
          {loadError && (
            <p className="player-note" role="alert">
              {loadError}
            </p>
          )}
        </>
      )}
    </section>
  );
}
