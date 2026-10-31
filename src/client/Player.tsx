import { useEffect, useRef, useState } from 'react';
import type { PassageRef, RecordingsResponse, RecordingView, TranslationView } from '../shared/api.ts';
import { formatReference } from '../shared/reference.ts';
import { api, messageFor } from './api.ts';
import { verseAt } from './timing.ts';

const pollMs = 5000;

type Listing = { kind: 'loading' } | { kind: 'ready'; listing: RecordingsResponse } | { kind: 'error'; message: string };

// What a download kept on this device for the chapter (S14): the recording and a local URL for its audio, if any.
export interface DevicePlayback {
  recording: RecordingView | null;
  audioUrl: string | null;
}

// Solo playback of the displayed chapter (S3). `onVerse` gets the verse being read, or null when none is.
// With `device`, the chapter is being read from a download and nothing is fetched.
export function Player(props: { translation: TranslationView | undefined; at: PassageRef; verseCount: number | null; onVerse: (verse: number | null) => void; device?: DevicePlayback }) {
  const { translation, at, verseCount, onVerse, device } = props;
  const audio = useRef<HTMLAudioElement>(null);
  // A range play stops when the next verse starts; the last verse of the range stays highlighted until the next seek or play.
  const stopAt = useRef<{ from: number; seconds: number; verse: number } | null>(null);
  const held = useRef<number | null>(null);
  const [state, setState] = useState<Listing>({ kind: 'loading' });
  const [narratorId, setNarratorId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const narrated = translation?.narration.state === 'available';

  useEffect(() => {
    if (!translation || !narrated || device) return;
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
        .catch((error) => {
          if (!current) return;
          // A failed poll keeps the listing on screen and asks again; a failed first load is shown.
          setState((previous) => (previous.kind === 'ready' ? previous : { kind: 'error', message: messageFor(error) }));
          timer = setTimeout(load, pollMs);
        });
    void load();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [translation, narrated, device, at.bookId, at.chapter]);

  const recordings = device ? (device.recording ? [device.recording] : []) : state.kind === 'ready' ? state.listing.recordings : [];
  const recording: RecordingView | undefined = recordings.find((r) => r.narratorId === narratorId) ?? recordings[0];
  const starts = recording?.timing.status === 'verified' ? recording.timing.verseStarts : null;
  // Each poll brings a new `starts` array; the follower below keys on the recording, not the array.
  const startsRef = useRef(starts);
  startsRef.current = starts;
  const timedUrl = starts ? recording!.mediaUrl : null;

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
    if (!element || !timedUrl) return;
    let frame = 0;
    const update = () => {
      const starts = startsRef.current;
      if (!starts) return;
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
    // Already playing when the follower (re)attaches: follow from this frame.
    if (!element.paused) frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      for (const name of events) element.removeEventListener(name, update);
      element.removeEventListener('seeked', release);
      element.removeEventListener('play', onPlay);
    };
  }, [timedUrl, onVerse]);

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

  // S14.4: a download without narration plays nothing offline, and says why.
  if (device && !recording) {
    return (
      <section className="player" aria-label="Narration">
        <p className="player-note" role="status">
          Narration needs a connection.
        </p>
      </section>
    );
  }

  const listing = device ? null : state.kind === 'ready' ? state.listing : null;
  const preparing = listing !== null && recordings.length === 0 && listing.preparing.length > 0;
  const failed = listing?.failed ?? [];

  return (
    <section className="player" aria-label="Narration">
      {!device && state.kind === 'loading' && <p className="player-note">Loading narration…</p>}
      {!device && state.kind === 'error' && <p className="player-note" role="status">{state.message}</p>}
      {preparing && <p className="player-note" role="status">Preparing narration…</p>}
      {failed.length > 0 && (
        <p className="player-note" role="status">
          {recordings.length ? 'Some narrators are unavailable' : 'Preparing narration failed — try later.'} ({failed.map((f) => f.reason).join('; ')})
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
            src={device?.audioUrl ?? recording.mediaUrl}
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
