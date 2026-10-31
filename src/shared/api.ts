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
  | 'narration_unavailable'
  | 'upstream_failed'
  | 'not_member'
  | 'not_owner'
  | 'no_active_session'
  | 'assistant_not_permitted'
  | 'assistant_offline'
  | 'turn_in_progress'
  | 'not_author'
  | 'stale_revision'
  | 'empty_body'
  | 'stale_progress'
  | 'payload_too_large'
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

// Everything a device stores to read a chapter offline, with the hash of each asset's exact bytes (I-27).
export interface DownloadManifest {
  assets: { url: string; sha256: string; bytes: number; kind: 'chapter' | 'audio' }[];
  totalBytes: number;
  expiresAt: IsoInstant | null;
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

export type OccurrenceStatus = 'scheduled' | 'cancelled';

// One meeting. `anchor` is the wall-clock time it was set in; `viewer` is the same instant in the viewer's profile zone.
export interface OccurrenceView {
  id: Uuid;
  startsAt: IsoInstant;
  status: OccurrenceStatus;
  revision: number;
  plannedPassage: PassageRef | null;
  anchor: { localDate: string; localTime: string; timeZone: IanaZone };
  viewer: { localDate: string; localTime: string; timeZone: IanaZone; abbreviation: string };
}

// PATCH /api/groups/:groupId/occurrences/:id. `localDate` and `localTime` are in the anchor's zone.
export interface UpdateOccurrenceRequest {
  expectedRevision: number;
  localDate?: string;
  localTime?: string;
  status?: OccurrenceStatus;
  plannedPassage?: PassageRef | null;
}

// PATCH /api/groups/:groupId/schedule (owner).
export interface ScheduleRequest {
  weekday: number;
  localTime: string;
  timeZone: IanaZone;
}

// GET/PUT /api/groups/:groupId/reminders: the viewer's own reminder emails for the group's meetings. Offsets are
// minutes before the meeting, 5 to 10080 (a week), at most five.
export interface ReminderPreference {
  enabled: boolean;
  offsetsMinutes: number[];
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

// ---- questions ----

export type QuestionStatus = 'open' | 'closed' | 'carried' | 'resolved' | 'no_longer_relevant';
export const questionStatuses: readonly QuestionStatus[] = ['open', 'closed', 'carried', 'resolved', 'no_longer_relevant'];

export interface Author {
  userId: Uuid;
  displayName: string;
}

// A removed post keeps its place (and its replies) with `body` null.
export interface ReplyView {
  id: Uuid;
  author: Author;
  body: string | null;
  removed: boolean;
  editedAt: IsoInstant | null;
  createdAt: IsoInstant;
  revision: number;
}

export interface QuestionView {
  id: Uuid;
  anchor: PassageRef & { translationId: TranslationId };
  kind: 'verse' | 'range' | 'chapter';
  author: Author;
  body: string | null;
  removed: boolean;
  editedAt: IsoInstant | null;
  createdAt: IsoInstant;
  status: QuestionStatus;
  replies: ReplyView[];
  // Edits name this; a reply does not raise it, so it never makes the author's edit stale.
  revision: number;
  // Raised by every change to the question or its replies: of two copies, the higher is newer.
  version: number;
}

// What a wrap-up decides for a question; `open` is only where a question starts.
export type Disposition = Exclude<QuestionStatus, 'open'>;
export const dispositions: readonly Disposition[] = ['closed', 'carried', 'resolved', 'no_longer_relevant'];

export interface DispositionRequest {
  status: Disposition;
  // The question's version the member decided on; stale_revision (409) with details.current when it changed since.
  version: number;
  sessionId?: Uuid;
}

// ---- progress ----

export interface StoppingPoint {
  bookId: BookId;
  chapter: number;
  verse: number;
}

export interface GroupProgressView {
  id: Uuid;
  ref: StoppingPoint;
  confirmedBy: string;
  confirmedAt: IsoInstant;
}

// `basedOnId` is the stopping point the member last saw (null when the group has none yet). A confirmation based on an
// older one is rejected with `stale_progress`, whose details carry the current one as `current`.
export interface ConfirmProgressRequest {
  basedOnId: Uuid | null;
  ref: StoppingPoint;
  sessionId?: Uuid;
}

// The furthest verse the session reached on its chapter, and the questions still to settle: the unsettled ones on its
// chapter, those posted during it, and every carried one.
export interface WrapUpView {
  suggested: StoppingPoint;
  openQuestions: QuestionView[];
}

export interface PostQuestionRequest {
  clientOpId: Uuid;
  anchor: PassageRef & { translationId: TranslationId };
  body: string;
}

export interface PostReplyRequest {
  clientOpId: Uuid;
  body: string;
}

export interface EditPostRequest {
  expectedRevision: number;
  body: string;
}

export interface DeletePostResponse {
  outcome: 'deleted' | 'body_removed';
}

// ---- personal ----

// A member's own notes and solo reading position, synced between their devices. No group endpoint returns them (I-21).
export type NoteAnchor = PassageRef & { translationId: TranslationId };

export interface NoteView {
  id: Uuid;
  anchor: NoteAnchor;
  body: string;
  revision: number;
  updatedAt: IsoInstant;
  deleted: boolean;
}

export interface SoloPosition {
  translationId: TranslationId;
  bookId: BookId;
  chapter: number;
  verse: number;
}

export interface SoloPositionView extends SoloPosition {
  revision: number;
}

// `baseRevision` is the revision the device last saw: null for a note it created.
export type SyncOp =
  | { opId: Uuid; entity: 'note'; entityId: Uuid; baseRevision: number | null; op: 'upsert'; anchor: NoteAnchor; body: string; deviceId: string }
  | { opId: Uuid; entity: 'note'; entityId: Uuid; baseRevision: number; op: 'delete'; deviceId: string }
  | { opId: Uuid; entity: 'solo_position'; baseRevision: number | null; op: 'set'; position: SoloPosition };

export interface PushResult {
  opId: Uuid;
  outcome: 'applied' | 'already_applied' | 'conflict';
  revision: number;
  conflictId?: Uuid;
}

export interface NoteConflictView {
  id: Uuid;
  noteId: Uuid;
  serverBody: string;
  incomingBody: string;
}

export interface PullResponse {
  notes: NoteView[];
  soloPosition: SoloPositionView | null;
  conflicts: NoteConflictView[];
  cursor: string;
}

// The realtime channel (/ws). The snapshot carries the questions the study keeps in view (as WrapUpView.openQuestions); S6
// adds the assistant events.
export type ClientMessage =
  | { t: 'hello'; clientId: Uuid }
  | { t: 'ping'; clientSentMs: number }
  | { t: 'join'; sessionId: Uuid }
  | { t: 'command'; sessionId: Uuid; commandId: Uuid; expectedRevision: number; command: Command }
  | { t: 'drift'; sessionId: Uuid; driftMs: number; ready: boolean };

export type ServerMessage =
  | { t: 'pong'; clientSentMs: number; serverMs: number }
  | { t: 'snapshot'; state: PlaybackState; presence: Presence[]; questions: QuestionView[] }
  | { t: 'state'; state: PlaybackState }
  | { t: 'result'; commandId: Uuid; outcome: CommandOutcome; state: PlaybackState; reason?: string }
  | { t: 'presence'; presence: Presence[] }
  // A question on the group's passage was posted, replied to, edited or removed. A removed one with no replies is gone.
  | { t: 'question'; question: QuestionView }
  | { t: 'assistant'; event: AssistantEvent }
  | { t: 'error'; error: ErrorCode; retryable: boolean };

// Close codes the server ends a connection with. The client reconnects after none of them.
export const closeNotMember = 4403;
export const closeSignedOut = 4401;
export const closeTooMany = 4429;

// ---- assistant ----

export type AssistantStatus = { state: 'online'; runtimeVersion: string } | { state: 'offline'; since: IsoInstant | null } | { state: 'not_permitted' };
export type AssistantTurnStatus = 'queued' | 'dispatched' | 'streaming' | 'completed' | 'interrupted' | 'failed' | 'uncertain';
export type AssistantEvent =
  | { kind: 'delta'; turnId: Uuid; seq: number; text: string }
  | { kind: 'message'; turnId: Uuid; seq: number; text: string }
  | { kind: 'turn_status'; turnId: Uuid; status: AssistantTurnStatus; failure?: string };

export interface AssistantTurnView {
  id: Uuid;
  prompt: string;
  status: AssistantTurnStatus;
  failure?: string;
}

export interface AssistantTranscript {
  turns: AssistantTurnView[];
  entries: AssistantEvent[];
}

export interface SendTurnRequest {
  clientTurnId: Uuid;
  prompt: string;
  context: { translationId: TranslationId; ref: PassageRef; noteIds: Uuid[] };
}

export interface SendTurnResponse {
  turnId: Uuid;
  status: AssistantTurnStatus;
  existing: boolean;
}

export const terminalTurnStatuses: readonly AssistantTurnStatus[] = ['completed', 'interrupted', 'failed'];

// The connector link (/connector). None of it reaches a browser (I-25).
export type ServerToConnector =
  | { t: 'dispatch'; turnId: Uuid; conversationId: Uuid; runtimeSessionId: string | null; text: string }
  | { t: 'interrupt'; turnId: Uuid; runtimeSessionId: string; runtimeTurnId: string }
  | { t: 'resume'; conversationId: Uuid; runtimeSessionId: string; fromSeq: number }
  | { t: 'ping' };

// An event's `runtimeTurnId` names the runtime turn, for events that arrive before `accepted`; runtime turn ids
// and seqs are unique only within `runtimeSessionId`.
// `resumed` answers a resume once every missed event was resent: whether the session still exists and
// which runtime turn is still open in it.
export type ConnectorToServer =
  | { t: 'hello'; runtimeVersion: string; provider: string; sandbox: string | null }
  | { t: 'session'; conversationId: Uuid; runtimeSessionId: string }
  | { t: 'accepted'; turnId: Uuid; runtimeSessionId: string; runtimeTurnId: string }
  | {
      t: 'event';
      conversationId: Uuid;
      runtimeSessionId: string;
      seq: number;
      turnId: Uuid | null;
      runtimeTurnId?: string;
      kind: 'delta' | 'message' | 'status' | 'tool_attempt';
      text?: string;
      status?: AssistantTurnStatus;
    }
  | { t: 'resumed'; conversationId: Uuid; sessionFound: boolean; activeRuntimeTurnId: string | null }
  | { t: 'failed'; turnId: Uuid; reason: string; retryable: false }
  | { t: 'pong' };
