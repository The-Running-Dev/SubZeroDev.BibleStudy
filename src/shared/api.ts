// Types shared by the server and the installable client. Signatures follow design/20-contract.md.

export type Uuid = string;
export type IsoInstant = string;
export type IanaZone = string;
export type TranslationId = 'BSB' | 'CSB';
export type BookId = string; // USFM code, e.g. 'ROM'

export interface PassageRef {
  bookId: BookId;
  chapter: number;
  startVerse: number | null;
  endVerse: number | null;
}

export type Availability =
  | { state: 'available' }
  | { state: 'not_configured'; reason: string }
  | { state: 'unavailable'; reason: string };

export type ErrorCode =
  | 'invalid_email'
  | 'code_invalid'
  | 'code_expired'
  | 'rate_limited'
  | 'unauthenticated'
  | 'invalid_zone'
  | 'invalid_request'
  | 'not_found'
  | 'unavailable'
  | 'translation_unavailable'
  | 'chapter_not_found'
  | 'upstream_failed'
  | 'not_member'
  | 'not_owner'
  | 'no_active_session'
  | 'internal';

export interface ApiError {
  error: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface Profile {
  id: Uuid;
  email: string;
  displayName: string;
  timeZone: IanaZone;
  displayTranslationId: TranslationId | null;
}

export interface RequestCodeResponse {
  sent: 'queued';
  codeExpiresAt: IsoInstant;
}

export interface VerifyCodeResponse {
  user: Profile;
  joinedGroupId: Uuid | null;
  invitation: 'accepted' | 'invalid' | 'none';
}

export type CodeDelivery = 'queued' | 'sending' | 'sent' | 'failed' | 'none';

export type ProfilePatch = Partial<Pick<Profile, 'displayName' | 'timeZone' | 'displayTranslationId'>>;

export interface TranslationView {
  id: TranslationId;
  name: string;
  copyrightNotice: string;
  availability: Availability;
  narration: Availability;
}

export interface BookView {
  bookId: BookId;
  name: string;
  chapters: number;
}

export interface ChapterContent {
  verses: { number: number; text: string }[];
  headings: { beforeVerse: number; text: string }[];
  footnotes: { verse: number; text: string }[];
}

export interface ChapterView extends ChapterContent {
  translationId: TranslationId;
  bookId: BookId;
  chapter: number;
  verseCount: number;
  contentSha256: string;
  expiresAt: IsoInstant | null;
  fums?: { token: string };
}

export type RecordingTiming = { status: 'verified'; verseStarts: number[] } | { status: 'absent' | 'rejected'; reason: string };

export interface RecordingView {
  id: Uuid;
  narratorId: string;
  narratorName: string;
  license: string;
  mediaUrl: string;
  mediaSha256: string;
  bytes: number;
  durationSeconds: number;
  timing: RecordingTiming;
}

// `preparing` lists narrators whose recording is being fetched on first request; poll again after 5 s.
export interface RecordingsResponse {
  recordings: RecordingView[];
  preparing: string[];
  failed: { narratorId: string; reason: string }[];
}

export type MemberRole = 'owner' | 'member';

export interface GroupSummary {
  id: Uuid;
  name: string;
  role: MemberRole;
}

export interface GroupView {
  id: Uuid;
  name: string;
  role: MemberRole;
  members: { userId: Uuid; displayName: string; role: MemberRole }[];
  sharedTranslationId: TranslationId;
  narratorId: string | null;
  rate: number;
  // ISO weekday (1 = Monday), HH:MM in `timeZone`.
  schedule: { weekday: number; localTime: string; timeZone: IanaZone };
}

export interface CreatedInvitation {
  id: Uuid;
  link: string;
  expiresAt: IsoInstant;
}

export interface InvitationView {
  id: Uuid;
  createdAt: IsoInstant;
  expiresAt: IsoInstant;
  state: 'open' | 'accepted' | 'revoked' | 'expired';
}

// POST /api/invitations/accept, for a member who is already signed in when they open a link.
export interface AcceptInvitationResponse {
  joinedGroupId: Uuid | null;
  invitation: 'accepted' | 'invalid';
}

// ---- study ----

export type PausedReason = 'member' | 'room_empty' | 'server_restart' | 'range_end';

// While `playing`, the position at server time T is positionSeconds + (T - anchorServerTimeMs) / 1000 * rate.
export interface PlaybackState {
  sessionId: Uuid;
  revision: number;
  passage: PassageRef;
  translationId: TranslationId;
  narratorId: string | null;
  recordingId: Uuid | null;
  // The recording being played, so every client loads the same file and range.
  recording: RecordingView | null;
  mode: 'narration' | 'manual';
  status: 'paused' | 'playing' | 'ended';
  positionSeconds: number;
  anchorServerTimeMs: number;
  rate: number;
  manualVerse: number | null;
  changedBy: { userId: Uuid; displayName: string } | null;
  pausedReason?: PausedReason;
}

export interface StudySessionResponse {
  sessionId: Uuid;
  state: PlaybackState;
}

export type Command =
  | { kind: 'play' }
  | { kind: 'pause' }
  | { kind: 'seek'; positionSeconds: number }
  | { kind: 'set_passage'; passage: PassageRef }
  | { kind: 'set_translation'; translationId: TranslationId }
  | { kind: 'set_narrator'; narratorId: string }
  | { kind: 'set_rate'; rate: number }
  | { kind: 'set_manual_verse'; verse: number }
  | { kind: 'end_session' };

export type CommandOutcome = 'applied' | 'rejected_stale' | 'rejected_invalid';

export interface Presence {
  userId: Uuid;
  displayName: string;
  connections: number;
  ready: boolean;
}

export interface DriftReport {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  perClient: { clientId: Uuid; p95Ms: number }[];
}

// The realtime channel (/ws). S8 adds questions to the snapshot, S6 the assistant events.
export type ClientMessage =
  | { t: 'hello'; clientId: Uuid }
  | { t: 'ping'; clientSentMs: number }
  | { t: 'join'; sessionId: Uuid }
  | { t: 'command'; sessionId: Uuid; commandId: Uuid; expectedRevision: number; command: Command }
  | { t: 'drift'; sessionId: Uuid; driftMs: number; ready: boolean };

export type ServerMessage =
  | { t: 'pong'; clientSentMs: number; serverMs: number }
  | { t: 'snapshot'; state: PlaybackState; presence: Presence[] }
  | { t: 'state'; state: PlaybackState }
  | { t: 'result'; commandId: Uuid; outcome: CommandOutcome; state: PlaybackState; reason?: string }
  | { t: 'presence'; presence: Presence[] }
  | { t: 'error'; error: ErrorCode; retryable: boolean };

// Close codes the server ends a connection with. The client reconnects after none of them.
export const closeNotMember = 4403;
export const closeSignedOut = 4401;
export const closeTooMany = 4429;
