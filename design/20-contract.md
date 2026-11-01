# Contract — SubZeroDev.BibleStudy

Derived from [10-design.md](10-design.md). This is written once. Where the code departs from it, the pull request says so.

## Invariants

Each invariant names the module that maintains it.

### identity
- **I-01** A LoginCode is accepted at most once, only while `now < expiresAt`, and only while `failedAttempts < 5`. Its raw code is never stored or logged.
- **I-02** Every authenticated request resolves to exactly one non-revoked, unexpired AuthSession. Raw session tokens exist only in the cookie.
- **I-03** `User.timeZone` is always a valid IANA zone name.

### groups
- **I-04** Every group-scoped read or write is preceded by a membership check for that `groupId`. An owner-only operation additionally requires `role = 'owner'`. Removed members (`removedAt` set) fail both checks.
- **I-05** An Invitation creates at most one Membership. A revoked, expired or accepted invitation creates none.

### schedule
- **I-06** `Occurrence.startsAt` equals the instant of `localDate` + `localTime` in `timeZone`, computed with the runtime's zone data. No offset is accepted as input.

### reminders
- **I-07** For any `(occurrenceId, occurrenceRevision, userId, offsetMinutes)` at most one reminder EmailJob exists.
  - No reminder is enqueued for a cancelled occurrence, a superseded revision, a removed member, or a user whose preference excludes that offset or is disabled.
- **I-08** Reminder preferences never affect `login_code` jobs.

### mail
- **I-09** An EmailJob `idempotencyKey` maps to exactly one job. Re-enqueueing with the same key returns the existing job.

### content
- **I-10** A Chapter's `contentSha256` is the SHA-256 of its stored `content`, and the API serves that content unchanged.
- **I-11** A CSB Chapter cached from API.Bible is never served when `now ≥ expiresAt`. Imported CSB is readable only by the verified `OWNER_EMAIL` account under `CSB_IMPORTED_ACCESS=owner`; unset owner or `disabled` denies everyone. Group membership grants nothing. The account boundary applies to catalogs, chapter retrieval, download manifests, offline copies and assistant loading. CSB text comes only from the owner's imported CSB files (`expiresAt` null, never overwritten by an API fetch) or the configured licensed API.
- **I-12** A Recording is only served for the translation in its `translationId`. The media bytes served hash to `mediaSha256`.
- **I-13** Recording `timing` is used for verse following only when `timingStatus = 'verified'`.
  - `verified` means exactly `verseCount` strictly increasing values, all `< durationSeconds`.
- **I-14** A Narrator with `enabled = false` (no recorded license) is never offered or imported.

### study
- **I-15** At most one StudySession per group has `status = 'active'`.
- **I-16** PlaybackState `revision` increases by exactly 1 per applied command.
  - `play`, `seek` and every setting change apply only when `expectedRevision = revision`.
  - `pause` always applies.
  - A `commandId` is applied at most once, and its stored outcome is returned for every retry.
- **I-17** After process start, no StudySession is `playing` until a member issues `play`.
- **I-18** Clients never queue group commands while disconnected, so a command is never replayed after reconnect.

### progress
- **I-19** GroupProgress changes only through `confirmStoppingPoint`, called by a member with the id of the latest row they saw. Playback, browsing, solo activity and questions never write it.

### questions
- **I-20** A Question or Reply body is edited only by its author. `editedAt` is set on every edit.
  - A post with replies is never hard-deleted; only its body is removed.
  - A `clientOpId` creates at most one post.

### personal
- **I-21** Notes, NoteConflicts, SoloPosition and AssistantConversations are readable and writable only by their `userId`. No group endpoint returns them.
- **I-22** A SyncOperation `opId` is applied at most once. A stale base revision with a different body never overwrites; it creates a NoteConflict.

### assistant
- **I-23** Only the user named by `ASSISTANT_OWNER_EMAIL` can create assistant turns.
  - At most one turn per conversation is `streaming` or `uncertain`.
  - A `clientTurnId` creates at most one turn.
  - A turn is never re-dispatched to the runtime.
- **I-24** TranscriptEntry `(conversationId, runtimeSeq)` is unique.
- **I-25** The browser never receives connector tokens, runtime session ids, principals, `cwd` paths or provider details; it receives transcript text and status only.

### connector
- **I-26** Every runtime permission request is answered `deny`. A turn that shows a tool execution is interrupted and reported `failed: tool_attempt`.
  - The connector never calls `admin.*` or `host.*` methods.

### client offline
- **I-27** A download manifest is `ready` only when every listed asset is stored and its hash verified.
  - A save reports `saved_on_device` only after its IndexedDB transaction completes.
  - A failed save leaves the previous version intact.
- **I-28** Local records are keyed by `userId`, and the UI only ever reads the signed-in user's records.

## Public surface

Signatures are TypeScript declarations, without bodies. HTTP endpoints are JSON over the app's own origin. Every endpoint except the sign-in pair, `/__build-id`, `/__health` and static assets requires the session cookie.

### Shared types

```ts
type Uuid = string;
type IsoInstant = string;            // UTC, e.g. 2026-11-02T12:15:00Z
type IanaZone = string;              // e.g. 'Europe/Sofia'
type TranslationId = 'BSB' | 'CSB';
type BookId = string;                // USFM code, e.g. 'ROM'

interface PassageRef { bookId: BookId; chapter: number; startVerse: number | null; endVerse: number | null; }

type Availability =
  | { state: 'available' }
  | { state: 'not_configured'; reason: string }
  | { state: 'unavailable'; reason: string };

type ApiError = { error: ErrorCode; message: string; retryable: boolean; details?: Record<string, unknown> };
```

### identity

```ts
// POST /api/auth/code
function requestLoginCode(body: { email: string; invitationToken?: string }): Promise<{ sent: 'queued'; codeExpiresAt: IsoInstant }>;
// POST /api/auth/verify — sets the session cookie
function verifyLoginCode(body: { email: string; code: string; invitationToken?: string }): Promise<{ user: Profile; joinedGroupId: Uuid | null; invitation: 'accepted' | 'invalid' | 'none' }>;
// GET /api/auth/code-status?email=
function loginCodeStatus(email: string): Promise<{ delivery: 'queued' | 'sending' | 'sent' | 'failed' | 'none' }>;
// POST /api/auth/logout
function logout(): Promise<void>;

interface Profile { id: Uuid; email: string; displayName: string; timeZone: IanaZone; displayTranslationId: TranslationId | null; }
// GET /api/me, PATCH /api/me
function getProfile(): Promise<Profile>;
function updateProfile(patch: Partial<Pick<Profile, 'displayName' | 'timeZone' | 'displayTranslationId'>>): Promise<Profile>;

// in-process, used by web
function authenticate(cookieToken: string | undefined): Promise<{ userId: Uuid; sessionId: Uuid } | null>;
```

### groups

```ts
interface GroupView { id: Uuid; name: string; role: 'owner' | 'member'; members: { userId: Uuid; displayName: string; role: 'owner' | 'member' }[];
  sharedTranslationId: TranslationId; narratorId: string | null; rate: number;
  schedule: { weekday: number; localTime: string; timeZone: IanaZone }; }

// GET /api/groups/:groupId
function getGroup(groupId: Uuid): Promise<GroupView>;
// owner only: POST /api/groups/:groupId/invitations, DELETE /api/groups/:groupId/invitations/:id, GET .../invitations
function createInvitation(groupId: Uuid): Promise<{ id: Uuid; link: string; expiresAt: IsoInstant }>;
function revokeInvitation(groupId: Uuid, invitationId: Uuid): Promise<void>;
function listInvitations(groupId: Uuid): Promise<{ id: Uuid; createdAt: IsoInstant; expiresAt: IsoInstant; state: 'open' | 'accepted' | 'revoked' | 'expired' }[]>;
// owner only: DELETE /api/groups/:groupId/members/:userId; PATCH /api/groups/:groupId/schedule
function removeMember(groupId: Uuid, userId: Uuid): Promise<void>;
function updateSchedule(groupId: Uuid, schedule: { weekday: number; localTime: string; timeZone: IanaZone }): Promise<GroupView>;

// in-process
function requireMember(userId: Uuid, groupId: Uuid): Promise<{ role: 'owner' | 'member' }>;  // throws NotMember
function requireOwner(userId: Uuid, groupId: Uuid): Promise<void>;                           // throws NotOwner
function acceptInvitation(tx: Tx, userId: Uuid, token: string): Promise<{ groupId: Uuid } | { invalid: InvitationState }>;
```

### schedule

```ts
interface OccurrenceView { id: Uuid; startsAt: IsoInstant; status: 'scheduled' | 'cancelled'; revision: number;
  plannedPassage: PassageRef | null;
  anchor: { localDate: string; localTime: string; timeZone: IanaZone };
  viewer: { localDate: string; localTime: string; timeZone: IanaZone; abbreviation: string }; }

// GET /api/groups/:groupId/occurrences?from&to
function listOccurrences(groupId: Uuid, range: { from: IsoInstant; to: IsoInstant }): Promise<OccurrenceView[]>;
// member: PATCH /api/groups/:groupId/occurrences/:id  (move, cancel, plan passage). The range defaults to the next eight
// weeks and may span at most 366 days; listing materializes the window from the schedule first. localDate and localTime
// are in the anchor zone; the client converts a move entered in the viewer's zone with instantFor.
function updateOccurrence(groupId: Uuid, occurrenceId: Uuid, change: { expectedRevision: number;
  localDate?: string; localTime?: string; status?: 'scheduled' | 'cancelled'; plannedPassage?: PassageRef | null }): Promise<OccurrenceView>;

// pure, in-process
function localizeOccurrence(startsAt: IsoInstant, zone: IanaZone): { localDate: string; localTime: string; abbreviation: string };
function instantFor(localDate: string, localTime: string, zone: IanaZone): IsoInstant;
```

### reminders

```ts
type ReminderPreference = { enabled: boolean; offsetsMinutes: number[] };
// GET /api/groups/:groupId/reminders: the caller's own preference; the default ([1440, 60], enabled) until they save one.
function getReminderPreference(groupId: Uuid): Promise<ReminderPreference>;
// PUT /api/groups/:groupId/reminders: replaces the caller's preference. Offsets come back sorted, longest first;
// at most 5, each a whole number of minutes from 5 to 10080. The next tick suppresses pending reminders it no longer
// covers, and owes again any it covers that were suppressed.
function setReminderPreference(groupId: Uuid, pref: ReminderPreference): Promise<ReminderPreference>;
// in-process, run once a minute under an advisory lock; deps carry the db, clock, outbox and public URL
function reminderTick(deps: ReminderDeps): Promise<{ materialized: number; enqueued: number; suppressed: number }>;
// A schedule change that deletes a meeting suppresses its pending reminders first, in the same transaction.
function suppressDeliveries(tx: Tx, deliveries: { id: Uuid; email_job_id: Uuid | null }[], now: Date): Promise<number>;
// The tick withdraws a reminder's job while it is still queued; a job already claimed is left to finish.
function withdrawQueued(tx: Tx, jobIds: Uuid[], reason: string): Promise<Uuid[]>;
```

### mail

```ts
function enqueueEmail(tx: Tx, job: { kind: 'login_code' | 'reminder'; idempotencyKey: string; to: string; subject: string; text: string; html: string }): Promise<{ jobId: Uuid; created: boolean }>;
function runMailWorker(signal: AbortSignal): Promise<void>;
```

### content

```ts
interface TranslationView { id: TranslationId; name: string; copyrightNotice: string; availability: Availability; narration: Availability; }
interface ChapterView { translationId: TranslationId; bookId: BookId; chapter: number; verseCount: number; contentSha256: string;
  verses: { number: number; text: string }[]; headings: { beforeVerse: number; text: string }[]; footnotes: { verse: number; text: string }[];
  expiresAt: IsoInstant | null; restrictedToUserId?: Uuid; fums?: { token: string } }
interface RecordingView { id: Uuid; narratorId: string; narratorName: string; license: string; mediaUrl: string; mediaSha256: string; bytes: number;
  durationSeconds: number; timing: { status: 'verified'; verseStarts: number[] } | { status: 'absent' | 'rejected'; reason: string }; }

// GET /api/content/translations
function listTranslations(): Promise<TranslationView[]>;
// GET /api/content/books?translation=
function listBooks(translationId: TranslationId): Promise<{ bookId: BookId; name: string; chapters: number }[]>;
// GET /api/content/:translation/:book/:chapter — 409 with Availability when not obtainable
function getChapter(translationId: TranslationId, bookId: BookId, chapter: number): Promise<ChapterView>;
// GET /api/content/:translation/:book/:chapter/recordings — may trigger on-demand import.
// 202 while any enabled narrator's recording is still being fetched (its id in `preparing`); the client polls again after 5 s.
function listRecordings(translationId: TranslationId, bookId: BookId, chapter: number): Promise<{ recordings: RecordingView[]; preparing: string[]; failed: { narratorId: string; reason: string }[] }>;
// GET /media/:sha256 — byte ranges, immutable cache headers
// GET /api/content/:translation/:book/:chapter/download-manifest[?narration=true] — no-store; asset urls are the chapter route and /media/:sha256
function downloadManifest(translationId: TranslationId, bookId: BookId, chapter: number, withNarration: boolean): Promise<{ assets: { url: string; sha256: string; bytes: number; kind: 'chapter' | 'audio' }[]; totalBytes: number; expiresAt: IsoInstant | null; restrictedToUserId?: Uuid }>;

// pure
function parseReference(input: string): PassageRef | null;   // 'Romans 3:12', 'rom 3', 'Romans 3:12-15'

// in-process
function resolveRecording(translationId: TranslationId, ref: PassageRef, narratorId: string): Promise<RecordingView | null>;
// CLI inside the container: import-content --translation BSB [--books ROM] [--audio ROM:1-16] [--narrators souer,hays,david]
function runImport(scope: ImportScope): Promise<ImportManifestSummary>;
```

### study (HTTP plus WebSocket `/ws`)

```ts
interface PlaybackState { sessionId: Uuid; revision: number; passage: PassageRef; translationId: TranslationId;
  narratorId: string | null; recordingId: Uuid | null; mode: 'narration' | 'manual'; status: 'paused' | 'playing' | 'ended';
  positionSeconds: number; anchorServerTimeMs: number; rate: number; manualVerse: number | null;
  changedBy: { userId: Uuid; displayName: string } | null; pausedReason?: 'member' | 'room_empty' | 'server_restart' | 'range_end'; }

// POST /api/groups/:groupId/session  (start or join the active one)
function startOrJoinSession(groupId: Uuid, occurrenceId?: Uuid): Promise<{ sessionId: Uuid; state: PlaybackState }>;

type Command =
  | { kind: 'play' } | { kind: 'pause' } | { kind: 'seek'; positionSeconds: number }
  | { kind: 'set_passage'; passage: PassageRef } | { kind: 'set_translation'; translationId: TranslationId }
  | { kind: 'set_narrator'; narratorId: string } | { kind: 'set_rate'; rate: number }
  | { kind: 'set_manual_verse'; verse: number } | { kind: 'end_session' };

type ClientMessage =
  | { t: 'hello'; clientId: Uuid }
  | { t: 'ping'; clientSentMs: number }
  | { t: 'join'; sessionId: Uuid }
  | { t: 'command'; sessionId: Uuid; commandId: Uuid; expectedRevision: number; command: Command }
  | { t: 'drift'; sessionId: Uuid; driftMs: number; ready: boolean };

type ServerMessage =
  | { t: 'pong'; clientSentMs: number; serverMs: number }
  | { t: 'snapshot'; state: PlaybackState; presence: Presence[]; questions: QuestionView[] }
  | { t: 'state'; state: PlaybackState }
  | { t: 'result'; commandId: Uuid; outcome: 'applied' | 'rejected_stale' | 'rejected_invalid'; state: PlaybackState; reason?: string }
  | { t: 'presence'; presence: Presence[] }
  | { t: 'question'; question: QuestionView }
  | { t: 'assistant'; event: AssistantEvent }
  | { t: 'error'; error: ErrorCode; retryable: boolean };

interface Presence { userId: Uuid; displayName: string; connections: number; ready: boolean; }
// Close codes (src/shared/api.ts). The client reconnects with backoff after 4503 only; after the others it stops and says why.
//   4401 closeSignedOut: the session cookie ended.   4403 closeNotMember: no longer a member of the group.
//   4429 closeTooMany: more than 8 open for the member.   4503 closeUnavailable: the database is down.
// GET /api/groups/:groupId/session/:sessionId/drift-report
function driftReport(groupId: Uuid, sessionId: Uuid): Promise<{ samples: number; p50Ms: number; p95Ms: number; maxMs: number; perClient: { clientId: Uuid; p95Ms: number }[] }>;
```

### progress

```ts
// GET /api/groups/:groupId/progress
function currentStoppingPoint(groupId: Uuid): Promise<{ progress: { id: Uuid; ref: { bookId: BookId; chapter: number; verse: number }; confirmedBy: string; confirmedAt: IsoInstant } | null }>;
// POST /api/groups/:groupId/progress
// 201; stale_progress (409) with details.current when basedOnId is not the current stopping point's id.
function confirmStoppingPoint(groupId: Uuid, body: { basedOnId: Uuid | null; ref: { bookId: BookId; chapter: number; verse: number }; sessionId?: Uuid }): Promise<{ id: Uuid }>;
// GET /api/groups/:groupId/session/:sessionId/wrap-up (also after the session ended). openQuestions: the open and carried
// questions on the session's chapter, every carried one, and any posted since the session started.
function wrapUpSuggestion(groupId: Uuid, sessionId: Uuid): Promise<{ suggested: { bookId: BookId; chapter: number; verse: number }; openQuestions: QuestionView[] }>;
```

### questions

```ts
interface QuestionView { id: Uuid; anchor: PassageRef & { translationId: TranslationId }; kind: 'verse' | 'range' | 'chapter';
  author: { userId: Uuid; displayName: string }; body: string | null; removed: boolean; editedAt: IsoInstant | null; createdAt: IsoInstant;
  status: 'open' | 'closed' | 'carried' | 'resolved' | 'no_longer_relevant'; replies: ReplyView[]; revision: number; version: number; }
interface ReplyView { id: Uuid; author: { userId: Uuid; displayName: string }; body: string | null; removed: boolean; editedAt: IsoInstant | null; createdAt: IsoInstant; revision: number; }

// GET /api/groups/:groupId/questions?book&chapter&status
function listQuestions(groupId: Uuid, filter: { bookId?: BookId; chapter?: number; status?: QuestionView['status'][] }): Promise<QuestionView[]>;
// POST /api/groups/:groupId/questions; POST .../questions/:id/replies
function postQuestion(groupId: Uuid, body: { clientOpId: Uuid; anchor: PassageRef & { translationId: TranslationId }; body: string }): Promise<QuestionView>;
function postReply(groupId: Uuid, questionId: Uuid, body: { clientOpId: Uuid; body: string }): Promise<ReplyView>;
// PATCH / DELETE on questions/:id and replies/:id (author only)
function editPost(groupId: Uuid, target: { questionId: Uuid } | { replyId: Uuid }, body: { expectedRevision: number; body: string }): Promise<QuestionView | ReplyView>;
function deletePost(groupId: Uuid, target: { questionId: Uuid } | { replyId: Uuid }): Promise<{ outcome: 'deleted' | 'body_removed' }>;
// POST .../questions/:id/disposition (any member, during or after a session). `version` is the question's version the member decided on;
// stale_revision (409) with details.current when it has changed since.
function setDisposition(groupId: Uuid, questionId: Uuid, body: { status: 'closed' | 'carried' | 'resolved' | 'no_longer_relevant'; version: number; sessionId?: Uuid }): Promise<QuestionView>;
```

### personal

```ts
interface NoteView { id: Uuid; anchor: PassageRef & { translationId: TranslationId }; body: string; revision: number; updatedAt: IsoInstant; deleted: boolean; }
type SyncOp =
  | { opId: Uuid; entity: 'note'; entityId: Uuid; baseRevision: number | null; op: 'upsert'; anchor: NoteView['anchor']; body: string; deviceId: string }
  | { opId: Uuid; entity: 'note'; entityId: Uuid; baseRevision: number; op: 'delete'; deviceId: string }
  | { opId: Uuid; entity: 'solo_position'; baseRevision: number | null; op: 'set'; position: { translationId: TranslationId; bookId: BookId; chapter: number; verse: number } };

// POST /api/sync/push
function pushOps(ops: SyncOp[]): Promise<{ results: { opId: Uuid; outcome: 'applied' | 'already_applied' | 'conflict'; revision: number; conflictId?: Uuid }[] }>;
// GET /api/sync/pull?cursor=
function pull(cursor: string | null): Promise<{ notes: NoteView[]; soloPosition: { translationId: TranslationId; bookId: BookId; chapter: number; verse: number; revision: number } | null; conflicts: { id: Uuid; noteId: Uuid; serverBody: string; incomingBody: string }[]; cursor: string }>;
// POST /api/sync/conflicts/:id — the live notes the choice left, the conflicted note first. kept_incoming on a note
// changed again since the conflict keeps both instead, so no saved text is lost.
function resolveConflict(conflictId: Uuid, choice: 'kept_server' | 'kept_incoming' | 'kept_both'): Promise<NoteView[]>;
// GET /api/export — the user's own profile, notes, solo position, questions and replies they authored, conversations
// (prompts and transcript text), as a JSON attachment read in one snapshot. No other member's posts, no runtime ids.
function exportPersonal(): Promise<Blob>;
```

### assistant

```ts
type AssistantStatus = { state: 'online'; runtimeVersion: string } | { state: 'offline'; since: IsoInstant | null } | { state: 'not_permitted' };
type AssistantEvent =
  | { kind: 'delta'; turnId: Uuid; seq: number; text: string }
  | { kind: 'message'; turnId: Uuid; seq: number; text: string }
  | { kind: 'turn_status'; turnId: Uuid; status: AssistantTurnStatus; failure?: string };
type AssistantTurnStatus = 'queued' | 'dispatched' | 'streaming' | 'completed' | 'interrupted' | 'failed' | 'uncertain';

// GET /api/assistant/status
function assistantStatus(): Promise<AssistantStatus>;
// POST /api/assistant/conversations; GET /api/assistant/conversations/:id?afterSeq=
function createConversation(): Promise<{ id: Uuid }>;
function getTranscript(conversationId: Uuid, afterSeq?: number): Promise<{ turns: { id: Uuid; prompt: string; status: AssistantTurnStatus }[]; entries: AssistantEvent[] }>;
// POST /api/assistant/conversations/:id/turns
function sendTurn(conversationId: Uuid, body: { clientTurnId: Uuid; prompt: string;
  context: { translationId: TranslationId; ref: PassageRef; noteIds: Uuid[] } }): Promise<{ turnId: Uuid; status: AssistantTurnStatus; existing: boolean }>;
// POST /api/assistant/turns/:turnId/interrupt
function interruptTurn(turnId: Uuid): Promise<{ status: AssistantTurnStatus }>;
```

### Connector link (WebSocket `/connector`, bearer `CONNECTOR_TOKEN`)

```ts
type ServerToConnector =
  | { t: 'dispatch'; turnId: Uuid; conversationId: Uuid; runtimeSessionId: string | null; text: string }
  | { t: 'interrupt'; turnId: Uuid; runtimeSessionId: string; runtimeTurnId: string }
  | { t: 'resume'; conversationId: Uuid; runtimeSessionId: string; fromSeq: number }
  | { t: 'ping' };
type ConnectorToServer =
  | { t: 'hello'; runtimeVersion: string; provider: string; sandbox: string | null }
  | { t: 'session'; conversationId: Uuid; runtimeSessionId: string }
  | { t: 'accepted'; turnId: Uuid; runtimeTurnId: string }
  | { t: 'event'; conversationId: Uuid; seq: number; turnId: Uuid | null; kind: 'delta' | 'message' | 'status' | 'tool_attempt'; text?: string; status?: AssistantTurnStatus }
  | { t: 'failed'; turnId: Uuid; reason: string; retryable: false }
  | { t: 'pong' };
```

### Client offline module (in-browser)

```ts
type SaveState = 'saving' | 'saved_on_device' | 'pending_sync' | 'synced' | 'save_failed';
type DownloadState = { state: 'absent' } | { state: 'downloading'; doneBytes: number; totalBytes: number } | { state: 'ready'; expiresAt: IsoInstant | null; withNarration: boolean }
  | { state: 'failed'; reason: string } | { state: 'expired' };

function downloadChapter(userId: Uuid, ref: { translationId: TranslationId; bookId: BookId; chapter: number }, withNarration: boolean, signal: AbortSignal, onProgress?: (state: DownloadState) => void): Promise<DownloadState>;   // verifies length and sha256 before ready
function removeDownload(userId: Uuid, ref: { translationId: TranslationId; bookId: BookId; chapter: number }): Promise<void>;   // never touches notes
// outbox.ts: the note and its waiting op in one IndexedDB transaction; 'saved_on_device' only once it completes.
function saveNote(userId: Uuid, note: { id: Uuid; anchor: NoteView['anchor']; body: string }): Promise<SaveState>;
function deleteNote(userId: Uuid, noteId: Uuid): Promise<SaveState>;
function savePosition(userId: Uuid, position: SoloPosition): Promise<SaveState>;
function sync(userId: Uuid): Promise<{ notes: (NoteView & { pending: boolean })[]; soloPosition: SoloPosition | null; conflicts: NoteConflictView[] }>;   // push then pull, one at a time per member across tabs
// drafts.ts: a question draft per member, group and chapter, with the clientOpId its post will use (a new one with every
// edit). Resolves once stored. Never sent on its own.
function saveDraft(draft: { userId: Uuid; id: string; groupId: Uuid; verses: string; body: string; clientOpId: Uuid }): Promise<void>;
// shell.ts: a new build waits as a service worker. live_session and signing_in are held by the page; the waiting worker
// counts the app's windows and calls skipWaiting only when there is one, and the page reloads once it takes over.
function switchAccount(nextUserId: Uuid | null): Promise<void>;   // broadcasts to every window
function requestUpdate(): Promise<{ applied: true } | { applied: false; reason: 'live_session' | 'signing_in' | 'multiple_windows' }>;
```

## Persisted schemas

PostgreSQL 17. Migrations are forward-only, numbered SQL files applied in a transaction at startup and recorded in `schema_migrations`. Version 1 has no existing data to migrate.

| Table | Key | Constraints and indexes |
|---|---|---|
| `users` | `id` | unique `lower(email)`; `time_zone` not null |
| `login_codes` | `id` | index `(lower(email)) where consumed_at is null`; `failed_attempts` ≤ 5 |
| `auth_sessions` | `id` | unique `token_hash`; index `user_id` |
| `groups` | `id` | fk `owner_id → users` |
| `memberships` | `(group_id, user_id)` | `role in ('owner','member')`; partial unique: one owner per group |
| `invitations` | `id` | unique `token_hash`; `accepted_by` fk |
| `occurrences` | `id` | unique `(group_id, slot_date)`; unique `(group_id, local_date)` among `scheduled`; index `starts_at` |
| `reminder_preferences` | `(user_id, group_id)` | `offsets_minutes` int[], at most 5, each between 5 and 10080 |
| `reminder_deliveries` | `id` | unique `(occurrence_id, occurrence_revision, user_id, offset_minutes)`; index `(status, send_after)`; `email_job_id` fk, set when queued |
| `email_jobs` | `id` | unique `idempotency_key`; index `(status, next_attempt_at)` |
| `translations` | `id` | seeded |
| `chapters` | `(translation_id, book_id, chapter)` | `content_sha256` not null |
| `narrators` | `id` | fk `translation_id` |
| `recordings` | `id` | unique `(translation_id, book_id, chapter, narrator_id)`; `timing_status in ('verified','absent','rejected')` |
| `import_manifests` | `id` | append-only |
| `study_sessions` | `id` | partial unique `(group_id) where status = 'active'` |
| `session_commands` | `command_id` | index `session_id` |
| `group_progress` | `id` | index `(group_id, confirmed_at desc)` |
| `questions` | `id` | unique `(author_id, client_op_id)`; index `(group_id, book_id, chapter)` |
| `replies` | `id` | unique `(author_id, client_op_id)`; fk `question_id` |
| `question_dispositions` | `id` | append-only |
| `notes` | `id` | index `(user_id, updated_at)` |
| `note_conflicts` | `id` | index `(user_id) where resolved_at is null` |
| `solo_positions` | `user_id` | — |
| `sync_operations` | `op_id` | index `user_id` |
| `assistant_conversations` | `id` | index `user_id` |
| `assistant_turns` | `id` | unique `(conversation_id, client_turn_id)`; partial unique `(conversation_id) where status in ('streaming','uncertain','dispatched','queued')` |
| `transcript_entries` | `(conversation_id, runtime_session_id, runtime_seq)`; `position` identity is the `afterSeq` cursor | fk `turn_id` |

Other persisted stores:

- **Media volume:** files named `<sha256>.<ext>`, written to a temporary name and renamed after the hash checks. Files are never modified in place.
- **IndexedDB** `biblestudy` (versioned):
  - stores `downloads`, `notes`, `pendingOps`, `drafts`, `soloPosition` and `meta`, each keyed by `[userId, id]`;
  - an upgrade adds stores and indexes and never drops user records;
  - Cache Storage `media-v1` holds audio keyed by hash URL.

## Error semantics

Every API error is an `ApiError` with one of these codes. HTTP status is in parentheses. "Retry" means the client may resend the same request unchanged.

**identity**
- `invalid_email` (400): malformed address. Retry: no. The user corrects it.
- `code_invalid` (401): wrong code; attempts remain. Retry: no. The user retypes.
- `code_expired` (401): expired, consumed, superseded or out of attempts. Retry: no. Request a new code.
- `rate_limited` (429): more than 5 code requests per email per hour, or 20 per IP. Retry: after `retryAfterSeconds`.
  - Also: more than 8 open WebSockets for one member (the upgrade is refused, or the socket closes with 4429), and too many WebSocket messages in a second (an `error` message). Retry: yes, after a pause.
- `unauthenticated` (401): no valid session. Retry: no. Go to sign-in.

**groups**
- `not_member` (403): not a current member. Retry: no.
- `not_owner` (403): owner-only operation. Retry: no.
- `invitation_invalid` (200, inside `verifyLoginCode` as `invitation: 'invalid'`): the invitation was revoked, expired or accepted. Retry: no. Ask the owner.

**reminders**
- `invalid_request` (400): an offset that is not a whole number of minutes from 5 to 10080, the same offset twice, more than 5 offsets, or a missing `enabled`. Retry: no.
- `not_member` (403): the caller is not a current member of the group. Retry: no.

**schedule**
- `stale_revision` (409): the occurrence changed. Retry: no. Reload and reapply.
- `invalid_zone` (400): the zone is not a known IANA name. Retry: no.
- `invalid_request` (409): another scheduled meeting already falls on that date (a move, or a restore). Retry: no. Pick another day.
- `invalid_request` (400): a malformed change, an empty one, a passage that is not a chapter of the book or uses a verse number above 176 (the chapter's own verse count is checked once its text is imported, S13), a move to a time already past or more than ten years ahead, or a `from`/`to` that is not an ISO instant between 2000 and 2200. Retry: no.

**content**
- `narration_unavailable` (409): a download with narration asked for a chapter with no recording ready. Retry: yes while the narration is preparing, otherwise no. Offer text only.
- `content_not_permitted` (403): imported CSB is outside the caller's permitted account scope. No text, hashes or manifest assets are returned. Retry: no.
- `translation_unavailable` (409): `not_configured` or `unavailable`, with the reason. This includes a CSB chapter API.Bible could not supply (S13.4). Retry: no. Show the reason.
- `chapter_not_found` (404): no such book or chapter. Retry: no.
- `not_found` (404): a `/media/` request for a recording that is missing or not ready. Retry: no.
- `preparing` is not an error: `listRecordings` answers 202 while a recording is fetched, and a fetch that fails is listed in `failed`.

**study**
- `rejected_stale`: a WebSocket `result`, not an error. Retry: no. Adopt the returned state.
- `rejected_invalid`: a bad passage, range, rate or narrator for the translation. Retry: no.
- `no_active_session` (404): ended or never started. Retry: no.

**progress**
- `stale_progress` (409): someone confirmed first. Retry: no. Show their choice; the member may confirm again on it.

**questions**
- `not_author` (403): editing or deleting someone else's post. Retry: no.
- `stale_revision` (409): edited or decided since loaded. Retry: no. Show `details.current`; the member may decide again on it.
- `empty_body` (400): blank body. Retry: no.

**personal**
- Conflicts are a result, not an error: `outcome: 'conflict'`.
- `payload_too_large` (413): more than 200 ops, a note over 64 KB, or a request body over 16 MB. Retry: split.
- `invalid_request` (400): a malformed push (the whole push is refused, nothing applied), or a `cursor` that is not one a pull returned. Retry: no.
- `conflict_resolved` (409): the conflict was already resolved, from another device or tab. Retry: no. Reload the notes.
- `not_found` (404): no such conflict for this member.

**assistant**
- `assistant_not_permitted` (403): the caller is not the assistant owner. Retry: no.
- `assistant_offline` (503): no connector link. Retry: yes, once the PC reconnects. The turn is not created.
- `invalid_request` (400): a `noteIds` entry that is not one of the caller's own live notes, the same id twice, or more than 20. Retry: no. The turn is not created.
- `turn_in_progress` (409): another turn is streaming or uncertain. Retry: yes, once that turn ends or is stopped.
- `not_found` (404): no such conversation for the owner. Retry: no.

**any module**
- `unavailable` (503): the database is down. Retry: yes, with backoff. A WebSocket closes with 4503 instead.
- `not_found` (404): no route matches. Retry: no.
- `invalid_request` (403): a WebSocket upgrade whose `Origin` is not the app's own. Retry: no.
- `internal` (500): unexpected; logged with a request id. Retry: no automatic retry.

**mail** (internal only)
- Transient SMTP failures (4xx or connection errors) are retried with backoff.
- A permanent failure (5xx) fails the job.
- Neither is surfaced except through `loginCodeStatus` and the owner's status page.

**connector**
- Runtime errors arrive as `failed` with a reason, and the turn becomes `failed`. Runtime retries are never issued for a turn.

## Unresolved

- **API.Bible Bible ID for CSB.** This is configuration (`APIBIBLE_CSB_BIBLE_ID`), not a signature, and is known only once the owner's access is granted.
- **Reusing a cached Fair Use token.** S13 reports the token stored with the chapter on every display, including displays of a cached copy. The API.Bible fair-use guide does not say whether a token may be reported again; this is confirmed or changed once the owner's account is live.
- **AgentConsole provider for the connector.**
  - `codex-cli` supports a `read-only` sandbox.
  - `claude-cli` supports none and relies on the deny-all permission policy.
  - Which provider holds DOD-22 is decided by the connector slice's live test of a tool attempt. The `hello` message reports what was used.
- **Narrator `david`.** Whether it is the Gilbert recording the publisher licenses as CC0. It stays disabled (I-14) until its license source is recorded at import.
- **The owner's status page.** Its layout and fields beyond email job failures, connector status and import manifests.
