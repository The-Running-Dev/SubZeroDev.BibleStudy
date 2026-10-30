// Shared playback arithmetic: the server derives positions with it, and every client follows the same rule.
import type { PassageRef, PlaybackState, RecordingTiming } from './api.ts';

export interface RangeBounds {
  start: number;
  end: number;
}

// The seconds a passage covers in a recording. Without verified timing a range cannot be cut, so it is the whole chapter.
export function rangeBounds(timing: RecordingTiming, durationSeconds: number, passage: PassageRef): RangeBounds {
  if (timing.status !== 'verified') return { start: 0, end: durationSeconds };
  const starts = timing.verseStarts;
  const first = passage.startVerse ?? 1;
  const last = passage.endVerse ?? starts.length;
  const start = Math.min(starts[first - 1] ?? 0, durationSeconds);
  const end = last < starts.length ? starts[last] : durationSeconds;
  return { start, end: Math.max(Math.min(end, durationSeconds), start) };
}

// The position at server time `serverNowMs`; a playing session stops at `end`.
export function derivePosition(state: Pick<PlaybackState, 'status' | 'positionSeconds' | 'anchorServerTimeMs' | 'rate'>, serverNowMs: number, end: number): number {
  if (state.status !== 'playing') return state.positionSeconds;
  const position = state.positionSeconds + ((serverNowMs - state.anchorServerTimeMs) / 1000) * state.rate;
  return Math.min(Math.max(position, 0), end);
}

// The verse (1-based) playing at `seconds`, or null when timing is not verified.
export function verseAtSeconds(timing: RecordingTiming, seconds: number): number | null {
  if (timing.status !== 'verified') return null;
  const starts = timing.verseStarts;
  let verse = 1;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= seconds + 1e-6) verse = i + 1;
  return verse;
}

// Drift correction: under 40 ms nothing, up to 1 s a ±5 % rate nudge, beyond that a seek.
export const driftDeadbandMs = 40;
export const driftSeekMs = 1000;
export const driftNudge = 0.05;

export type Correction = { kind: 'none' } | { kind: 'nudge'; playbackRate: number } | { kind: 'seek'; positionSeconds: number };

// `driftMs` is local minus target: positive means this client is ahead.
export function correctionFor(driftMs: number, rate: number, targetSeconds: number): Correction {
  const magnitude = Math.abs(driftMs);
  if (magnitude < driftDeadbandMs) return { kind: 'none' };
  if (magnitude <= driftSeekMs) return { kind: 'nudge', playbackRate: rate * (driftMs > 0 ? 1 - driftNudge : 1 + driftNudge) };
  return { kind: 'seek', positionSeconds: targetSeconds };
}
