// Keeps an audio element on the shared PlaybackState: plays, pauses and corrects drift against the server clock.
import type { PlaybackState } from '../shared/api.ts';
import { correctionFor, derivePosition, rangeBounds } from '../shared/playback.ts';

export function rangeOf(state: PlaybackState): { start: number; end: number } | null {
  return state.recording ? rangeBounds(state.recording.timing, state.recording.durationSeconds, state.passage) : null;
}

export function targetSeconds(state: PlaybackState, serverNowMs: number): number {
  const range = rangeOf(state);
  return derivePosition(state, serverNowMs, range?.end ?? Number.POSITIVE_INFINITY);
}

// One correction step; call it on every state change and a few times a second.
// Returns the measured drift (local minus target, ms; positive when ahead), or null when not playing steadily.
export function syncStep(audio: HTMLAudioElement, state: PlaybackState, serverNowMs: number, onBlocked: () => void): number | null {
  const range = rangeOf(state);
  if (!range || state.mode !== 'narration' || audio.readyState < HTMLMediaElement.HAVE_METADATA) return null;
  const target = targetSeconds(state, serverNowMs);
  const atEnd = target >= range.end - 0.05;
  if (state.status !== 'playing' || atEnd) {
    if (!audio.paused) audio.pause();
    const rest = state.status === 'playing' ? range.end : state.positionSeconds;
    if (Math.abs(audio.currentTime - rest) > 0.05) audio.currentTime = rest;
    audio.playbackRate = state.rate;
    return null;
  }
  if (audio.paused) {
    audio.playbackRate = state.rate;
    audio.currentTime = target;
    audio.play().catch((error: Error) => {
      if (error.name === 'NotAllowedError') onBlocked();
    });
    return null;
  }
  const driftMs = (audio.currentTime - target) * 1000;
  const correction = correctionFor(driftMs, state.rate, target);
  if (correction.kind === 'seek') audio.currentTime = correction.positionSeconds;
  else audio.playbackRate = correction.kind === 'nudge' ? correction.playbackRate : state.rate;
  return driftMs;
}
