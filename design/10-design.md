# Design — SubZeroDev.BibleStudy

Built from [00-brief.md](00-brief.md). Premises and the approach were approved on 2026-10-30, and every choice below that is not a confirmed requirement is recorded in [90-decisions.md](90-decisions.md).

**Approved approach (minimal).** Everything is hosted on the owner's VPS:

- a single Node/TypeScript service that serves the installable web app, its HTTP API and one WebSocket channel, all on one origin;
- PostgreSQL;
- a media volume.

The only thing that runs on the owner's PC is a small **Skynet connector**. It opens an outbound connection to the server, so the app keeps working with the PC switched off; only the study assistant becomes unavailable.

**Voice is out of v1.** The owner chose to "drop the audio for now" because they have a different voice solution for later. That moves out of v1:

- DOD-08;
- the voice parts of DOD-07, DOD-11 and DOD-29;
- voice-room access.

See D-2026-10-30-02. Synchronized narration stays. The group talks over whatever call it already uses while the app keeps everyone on the same verse.

## Data model

All server entities are persisted in PostgreSQL unless marked *in-memory*. Identifiers are UUIDv7 unless stated otherwise, and timestamps are UTC `timestamptz`. Every group-scoped row carries `groupId`, so a second group needs no migration.

### Identity

**User**
- Fields: `id`, `email` (case-insensitive, unique), `displayName`, `timeZone` (IANA name, validated against the runtime's zone list), `displayTranslationId` (nullable: personal display translation), `createdAt`.
- Created on first successful sign-in. Never hard-deleted in v1.

**LoginCode**
- Fields: `id`, `email`, `codeHash` (SHA-256 of a 6-digit code plus a server pepper), `createdAt`, `expiresAt` (createdAt + 10 min), `consumedAt`, `failedAttempts`, `invitationId` (nullable).
- At most one unconsumed code per email: requesting a new code supersedes the old one by setting its `consumedAt`.
- A code dies on use, on expiry, or after 5 failed attempts.

**AuthSession**
- Fields: `id`, `userId`, `tokenHash`, `createdAt`, `lastSeenAt`, `expiresAt` (sliding 90 days), `revokedAt`, `userAgent`.
- The raw token lives only in an `HttpOnly; Secure; SameSite=Lax` cookie.
- Signing in on another device creates another AuthSession for the same User, so identity and history carry over (DOD-01).

### Groups

**Group**
- Fields: `id`, `name`, `ownerId`, `createdAt`, plus shared defaults:
  - `sharedTranslationId` (default `BSB`)
  - `narratorId`
  - `rate` (0.75–1.5)
  - `scheduleWeekday` (ISO 1–7)
  - `scheduleLocalTime` (`HH:MM`)
  - `scheduleTimeZone` (IANA name)
  - `startPassage` (Romans 1)
- One group in v1. The owner creates it on first run.

**Membership**
- Fields: `groupId`, `userId`, `role` (`owner` | `member`), `joinedAt`, `removedAt`.
- Primary key is `(groupId, userId)`. Removal sets `removedAt`; rejoining needs a new invitation.

**Invitation**
- Fields: `id`, `groupId`, `tokenHash`, `createdBy`, `createdAt`, `expiresAt` (14 days), `revokedAt`, `acceptedBy`, `acceptedAt`.
- Single use: accepting consumes it (D-2026-10-30-09). The raw token appears only in the link the owner copies; the app never emails invitations.

### Schedule and reminders

**Occurrence**
- Fields: `id`, `groupId`, `localDate`, `localTime`, `timeZone`, `startsAt` (derived from those three when written, and re-derived whenever the zone database changes), `status` (`scheduled` | `cancelled`), `plannedPassage` (nullable reference), `revision`.
- Materialized on a rolling eight-week window from the Group schedule.
- Moving an occurrence edits its local date or time and bumps `revision`.
- Each also keeps the schedule date it was made for (`slotDate`) and whether a member moved it (`moved`). A schedule change re-times the ones ahead nobody moved; at most one scheduled occurrence falls on a group's local date.
- No UTC offset is stored as an input; `startsAt` is derived and recomputed (DOD-03).

**ReminderPreference**
- Fields: `userId`, `groupId`, `enabled` (default true), `offsetsMinutes` (default `[1440, 60]`, each 5–10080).
- Login codes are not governed by it (DOD-04).

**ReminderDelivery**
- Fields: `id`, `occurrenceId`, `occurrenceRevision`, `userId`, `offsetMinutes`, `sendAfter` (derived: `startsAt − offset`), `status` (`pending` | `sent` | `suppressed` | `failed`), `emailJobId`.
- Unique on `(occurrenceId, occurrenceRevision, userId, offsetMinutes)`.

**EmailJob** (the outbox)
- Fields: `id`, `kind` (`login_code` | `reminder`), `idempotencyKey` (unique), `toAddress`, `subject`, `textBody`, `htmlBody`, `status` (`queued` | `sending` | `sent` | `failed`), `attempts`, `nextAttemptAt`, `lastError`, `providerMessageId`, `sentAt`.

### Content

**Translation**
- Fields: `id` (`BSB`, `CSB`), `name`, `sourceKind` (`aolab` | `apibible`), `edition` (source's version identifier and checksum), `licenseSummary`, `copyrightNotice`, `availability` (`available` | `not_configured` | `unavailable`), `availabilityReason`.
- Rows are seeded by migration. `availability` is derived at startup from configuration (CSB is `not_configured` until an API.Bible key and Bible ID are set).

**Chapter**
- Fields: `translationId`, `bookId` (USFM code, e.g. `ROM`), `chapter`, `verseCount`, `content` (JSON: ordered verse texts plus headings and footnotes as the source provides them), `contentSha256`, `sourceRef`, `fetchedAt`, `expiresAt` (null for BSB; fetchedAt + 14 days for CSB).
- Primary key is `(translationId, bookId, chapter)`.

**Narrator**
- Fields: `id` (source key, e.g. `souer`), `displayName`, `translationId`, `license`, `licenseSource`, `enabled`.
- Seeded. A narrator stays disabled until its license is recorded (D-2026-10-30-06).

**Recording**
- Fields:
  - `id`, `translationId`, `bookId`, `chapter`, `narratorId`
  - `mediaSha256`: names the file in the media volume
  - `bytes`, `durationSeconds`, `mimeType`, `sourceUrl`, `importedAt`
  - `timing`: nullable ordered verse start times in seconds
  - `timingStatus`: `verified` | `absent` | `rejected`, plus `timingReason`
- Unique on `(translationId, bookId, chapter, narratorId)`.
- `timingStatus` is derived at import: `verified` only when the timing has exactly `verseCount` entries, strictly increases and ends before `durationSeconds`. Otherwise the timing is stored as `rejected` with a reason and never used (DOD-10).

**ImportManifest**
- Fields: `id`, `startedAt`, `finishedAt`, `scope`, `sourceVersions`, and per-item results with checksums.
- An append-only record for DOD-14 and DOD-30.

### Live study

**StudySession**
- Fields: `id`, `groupId`, `occurrenceId` (nullable), `status` (`active` | `ended`), `startedBy`, `startedAt`, `endedBy`, `endedAt`, plus the persisted **PlaybackState**.
- At most one `active` session per group (partial unique index).

**PlaybackState** (columns of StudySession)
- Fields:
  - `revision`
  - `passage` (`bookId`, `chapter`, `startVerse`, `endVerse`)
  - `translationId`, `narratorId`, `recordingId` (nullable)
  - `mode` (`narration` | `manual`)
  - `status` (`paused` | `playing` | `ended`)
  - `positionSeconds`, `anchorServerTimeMs`, `rate`
  - `manualVerse` (used when `mode = manual`)
  - `changedBy`, `changedAt`
- The current position is derived, never stored while playing: `positionSeconds + (now − anchorServerTimeMs) / 1000 × rate`, clamped to the range end.

**SessionCommand**
- Fields: `commandId` (client-generated, unique), `sessionId`, `userId`, `kind`, `expectedRevision`, `outcome` (`applied` | `rejected_stale` | `rejected_invalid`), `resultingRevision`, `receivedAt`.
- Lets a retried command return its original outcome instead of applying twice.

**Presence** (*in-memory*)
- The set of open WebSocket connections per session, with user and readiness.
- Rebuilt from reconnects after a restart, never persisted.

### Questions and progress

**Question**
- Fields:
  - `id`, `groupId`, `authorId`
  - `anchor`: `translationId` at time of posting, `bookId`, `chapter`, `startVerse` (nullable for chapter questions), `endVerse` (nullable)
  - `kind`: derived from the anchor — `verse`, `range` or `chapter`
  - `body`, `editedAt`, `bodyRemovedAt`, `createdAt`
  - `status`: `open` | `closed` | `carried` | `resolved` | `no_longer_relevant`
  - `clientOpId`: unique per author, so a retried publish creates one question
- Owned by the group and passage, not a session (brief assumption).

**Reply**
- Fields: `id`, `questionId`, `authorId`, `body`, `editedAt`, `bodyRemovedAt`, `createdAt`, `clientOpId`.

**QuestionDisposition**
- Fields: `questionId`, `sessionId`, `status`, `decidedBy`, `decidedAt`.
- Append-only history behind `Question.status`.

**GroupProgress**
- Fields: `id`, `groupId`, `bookId`, `chapter`, `verse`, `confirmedBy`, `confirmedAt`, `sessionId`.
- Append-only. The newest row is the group's stopping point.
- Only a wrap-up confirmation writes it (DOD-19). Setup writes the first row by explicit confirmation, never automatically.

### Personal state (synced)

**Note**
- Fields: `id` (client-generated UUID), `userId`, `anchor` (as for Question), `body`, `revision`, `updatedAt`, `deletedAt`, `deviceId`.
- Private to its author.

**NoteConflict**
- Fields: `id`, `noteId`, `userId`, `serverRevision`, `incomingBody`, `incomingDeviceId`, `createdAt`, `resolvedAt`, `resolution` (`kept_server` | `kept_incoming` | `kept_both`).
- Created when an incoming edit's base revision is stale and its body differs (D-2026-10-30-10).

**SoloPosition**
- Fields: `userId`, `translationId`, `bookId`, `chapter`, `verse`, `revision`, `updatedAt`.
- One row per user, never read by group features.

**SyncOperation**
- Fields: `opId` (client-generated, unique), `userId`, `entity`, `entityId`, `baseRevision`, `outcome`, `resultingRevision`, `receivedAt`.
- Makes every personal write idempotent across retries.

### Assistant

**AssistantConversation**
- Fields: `id`, `userId`, `runtimeSessionId` (nullable until the connector creates it), `status` (`open` | `closed`), `createdAt`.

**AssistantTurn**
- Fields:
  - `id`, `conversationId`
  - `clientTurnId`: unique — the double-submit guard (DOD-22)
  - `prompt`
  - `context`: the translation, reference, exact verse text and chosen note bodies sent with it
  - `runtimeTurnId` (nullable)
  - `status`: `queued` | `dispatched` | `streaming` | `completed` | `interrupted` | `failed` | `uncertain`
  - `failure`, `createdAt`

**TranscriptEntry**
- Fields: `conversationId`, `runtimeSeq`, `turnId`, `kind` (`user` | `assistant_delta` | `assistant_message` | `status`), `text`, `receivedAt`.
- Unique on `(conversationId, runtimeSeq)`, so a replayed event never duplicates an entry (DOD-21).

**ConnectorLink** (*in-memory*)
- The one connected Skynet connector, its last heartbeat, and the runtime version it reported.

### On the device (IndexedDB and Cache Storage, scoped by `userId`)

- **Downloads:** per chapter, a manifest with translation, chapter, content checksum, recording checksum and size. State is `downloading` | `ready` | `failed`.
  - `ready` is written only after every listed asset is stored and its checksum verified (DOD-24).
  - CSB entries carry `expiresAt`, and an expired one is shown as needing refresh.
- **Media:** audio files in Cache Storage, keyed by content hash.
- **Notes and solo position:** local copies, plus a queue of pending SyncOperations, each with a save state: `saving` → `saved_on_device` → `pending_sync` → `synced`, or `save_failed`.
- **Question drafts:** local only, never synced, shown as "Not posted".
- **Session pointer:** the current user, so logout hides every other account's records (DOD-27).

## Module boundaries

The server is one deployable split into modules that talk only through each module's exported surface. Dependency arrows point toward what is depended on.

| Module | Owns | Depends on | Exposes |
|---|---|---|---|
| `platform` | Config loading, DB pool and migrations, clock, logger, ID generation | — | `Config`, `Db`, `Clock` |
| `mail` | EmailJob outbox, SMTP transport, retry loop | `platform` | `enqueueEmail`, delivery worker |
| `identity` | Users, LoginCodes, AuthSessions, profile edits | `platform`, `mail`, `groups` (sign-in accepts the invitation) | sign-in flow, `authenticate(request)`, profile API |
| `groups` | Group, Membership, Invitation, the authorization rules | `platform` | `requireMember`, `requireOwner`, invitation API |
| `content` | Translations, Chapters, Narrators, Recordings, import, media serving, CSB refresh | `platform` | catalog/chapter/media API, `resolveRecording`, importer CLI |
| `schedule` | Occurrences, time-zone math | `platform`, `groups`, `identity` (time-zone validation), `reminders` (suppressing a changed meeting's deliveries) | occurrence API, `localizeOccurrence` |
| `reminders` | ReminderPreference, ReminderDelivery, the reminder tick | `platform`, `schedule`, `groups`, `mail`, `progress` | preferences API, scheduler |
| `progress` | GroupProgress | `platform`, `groups` | `currentStoppingPoint`, `confirmStoppingPoint` |
| `questions` | Questions, Replies, Dispositions | `platform`, `groups` | question API, `questionsForPassage` |
| `study` | StudySession, PlaybackState, SessionCommand, Presence, the WebSocket channel | `platform`, `groups`, `content`, `questions`, `progress` | session API, realtime channel |
| `personal` | Notes, NoteConflicts, SoloPosition, SyncOperations, export | `platform` | sync API, export |
| `assistant` | Conversations, Turns, Transcript, the connector link endpoint | `platform`, `content`, `personal`, `study` (the realtime hub's type, to push turn events) | assistant API, connector endpoint |
| `web` | HTTP routing, cookie auth, static app with caching headers, `/__build-id`, `/__health` | every module above | the deployable |
| `demo` | The synthetic demo group (`npm run demo:seed`) | `platform`, `groups`, `questions`, `personal` | `seedDemo`, demo CLI |

The arrows are imports. Three facts describe the graph:

- `platform` is the only sink.
- It has one cycle, `schedule` ↔ `reminders`: a moved or cancelled meeting suppresses its owed deliveries, and the reminder tick materializes the meetings ahead. Both run inside the caller's transaction, so the pair changes together.
- `progress` depends on nothing that depends on it. Neither `reminders` nor `study` is a dependency of `progress`.

A module writes only its own tables; the one exception is `schedule`, which writes the `groups.schedule_*` columns it owns. A query may read another module's tables, to join or to check state inside one transaction, rather than calling through that module's surface.

`web` is the only composition root for the server; `demo` and the CLIs compose what they need on their own.

**Connector** (separate process on the owner's PC): owns the AgentConsole child process and the outbound link to the server. It depends on the server's connector protocol and AgentConsole's runtime protocol, and nothing on the server depends on its internals.

**Client** (the installable web app), one bundle:
- `shell`: routing, auth state, install help, update prompt
- `reader`: navigation, reference parsing, display translation
- `player`: local audio element, clock sync, drift correction
- `live`: realtime channel, session view
- `questions`
- `offline`: IndexedDB stores, downloads, save states
- `sync`: personal-state push and pull
- `assistant`
- `sw`: the service worker, following the Adventures patterns

Dependencies inside the client:
- `live` → `player`, `reader`
- `sync` → `offline`
- Every UI module → `shell`

The service worker shares no code path with the UI except the download manifest format.

## Control flow

### 1. Sign-in from an invitation

1. The owner creates an Invitation and copies the link: `/join/<token>`.
2. An invitee opens the link. The app keeps the token in memory and session storage, then asks for an email address.
3. `identity` creates a LoginCode linked to the invitation and enqueues a `login_code` EmailJob (idempotency key = LoginCode id).
4. The `mail` worker sends it over SMTP.
5. The invitee types the code. `identity` verifies the hash, expiry, consumption and attempt count, then consumes the code.
6. In the same transaction, `identity` creates the User if needed and calls `groups.acceptInvitation`, which checks the invitation is unrevoked, unexpired and unaccepted, creates the Membership, and marks the invitation accepted.
7. An AuthSession cookie is set. The app opens the group with the profile prompt (display name, time zone pre-filled from the browser).

A code typed into the installed app works even though the email was opened elsewhere, which is why codes are used instead of magic links.

### 2. A shared playback command

1. A member taps Pause. `live` sends `command {commandId, expectedRevision, kind: 'pause'}` on the WebSocket.
2. `study` looks up `commandId`. If seen, it replies with the stored outcome. Otherwise it serializes on the session, then checks:
   - membership;
   - for `play`, `seek` and passage, translation, narrator or rate changes: `expectedRevision === revision`;
   - for `pause`: no revision check — pause is always applied, at the derived current position.
3. It writes the new PlaybackState with `revision + 1` and records the SessionCommand in one transaction.
4. It broadcasts `state` to every connection in the session.
5. Each client's `player` converts `anchorServerTimeMs` to local time using its measured clock offset and sets the audio element's position.
6. While playing, the player corrects drift:
   - under 40 ms: does nothing;
   - 40–1000 ms: adjusts `playbackRate` by up to ±5 %;
   - over 1000 ms: seeks.
7. Every 5 s it reports measured drift to the server for the DOD-09 report.
8. A stale command comes back as `rejected {reason: 'stale', state}`. The client shows the fresh state and does not retry.

Late join and reconnect follow one path:
1. Connect.
2. Authenticate from the cookie.
3. `join {sessionId}`.
4. Receive the snapshot.

Commands queued while disconnected are dropped, never replayed (DOD-11, DOD-26).

### 3. A weekly reminder

1. Every minute, `reminders` materializes Occurrences eight weeks ahead.
2. For each `(occurrence, member, offset)` in force and still ahead it inserts a `pending` ReminderDelivery, keyed by the occurrence's current `revision`. A revision that changed only the planned passage keeps a delivery already queued or sent for the same send time, so it is not sent twice.
3. Each tick suppresses pending deliveries that are no longer owed: an older revision, a cancelled or deleted occurrence, a removed member, or an offset the member's preference no longer includes. A delivery whose job is still queued has the job withdrawn first; one already being sent is left to finish.
4. When `sendAfter ≤ now` for a `pending` delivery with no job, `reminders` enqueues one EmailJob with idempotency key `reminder:<deliveryId>`. The next ticks copy the job's outcome to the delivery: `sent` once SMTP accepts it, `failed` once the outbox gives up.
5. The email shows the start in the recipient's zone (date, time, zone abbreviation and name), the planned passage (or the group's stopping point when none is planned), and an Open study link to the study page, which has no voice to join.
6. If a delivery's send time passed more than 30 minutes ago (for example after downtime), it is `suppressed` rather than sent late.

### 4. A personal note offline, then synced

1. The user edits a note.
2. `offline` writes the note and a pending SyncOperation (new `opId`, `baseRevision`) in one IndexedDB transaction. It shows "Saved on this device" only when that transaction completes.
   - A quota or write failure shows "Save failed" and leaves the previous saved version untouched (DOD-27).
3. On connectivity (`online` event, app start or a 60 s timer), `sync` pushes pending operations in order.
4. The server's `personal` module returns the stored outcome for a known `opId`. Otherwise:
   - when `baseRevision` matches, it applies the operation;
   - when it is stale and the body differs, it records a NoteConflict and keeps the server version;
   - when it is stale but the body is the same, it treats the operation as already applied.
5. `sync` then pulls changes since its last cursor. Conflicts surface as "Two versions — choose one" until the user resolves them.
6. Group commands and stopping-point changes are never in this queue: they are only sent live.

### 5. A study-assistant turn

1. The owner, in solo mode, asks about selected verses. The client sends `{clientTurnId, conversationId, prompt, context}`, where `context` holds the translation, reference, the exact verse text from the stored Chapter, and the notes the owner ticked.
2. `assistant` inserts the AssistantTurn. A repeated `clientTurnId` returns the existing turn, so an uncertain send never submits twice.
3. `assistant` forwards the turn to the connector over the connector link.
4. The connector:
   - creates the AgentConsole session on first use, with an opaque `principal`, a dedicated empty `cwd`, the configured provider, and the most restrictive sandbox that provider supports;
   - sends one `turns.send` containing a fixed instruction block, the context and the prompt;
   - streams `events.event` notifications back with their runtime `seq`.
5. `assistant` stores each event as a TranscriptEntry, unique by `seq`, and fans it out to the owner's open clients.
6. Stopping a turn sends `turns.interrupt`.
7. If the connector link drops mid-turn:
   - the turn becomes `uncertain`;
   - when the link returns, the connector resubscribes from the last stored `seq`;
   - on `replay_gap` it reads the missing range;
   - the turn then settles to its real terminal state;
   - it is never resent.
8. Every `permission.request` from the runtime is answered `deny`. Any tool-execution event aborts the turn as `failed: tool_attempt` (DOD-22).

## Distribution

**Server:**
- GitHub Actions builds one container image per merge to `main` and pushes it to GHCR (`ghcr.io/the-running-dev/subzerodev.biblestudy:<sha>` and `:latest`).
- When the repository variable `DEPLOY_ENABLED` is true, it then calls the Portainer redeploy webhook stored in the `PORTAINER_REDEPLOY_WEBHOOK_URL` secret. This is the same pipeline Adventures uses.
- The Portainer Git stack, defined by the repository's `compose.yaml`, runs:
  - the app container (service `biblestudy`);
  - PostgreSQL with a named volume;
  - a named media volume;
  - a one-shot `migrate` service that the app waits on;
  - a `backup` service: a nightly `pg_dump` plus a media manifest, with a shared deduplicated store for recordings and a restore that checks every checksum first (`docs/deploy.md`).
- The stack joins the existing `proxy-net`, and the existing reverse proxy terminates TLS for the app hostname (proposed: `biblestudy.subzerodev.com`).
- Migrations run in the `migrate` service, each in one transaction, before the new app starts. Compose stops the old app before it waits on `migrate`, so a failed migration leaves the site down, with nothing applied, until the previous image is redeployed by pinning `BIBLESTUDY_IMAGE` (the drill checks both). The app also migrates on start, before the listener opens, and exits non-zero if that fails, so it never serves a half-migrated schema.
- `/__build-id` reports the commit for deploy verification. `/__health` runs `SELECT 1` and is the image's health check.

**Content:**
- An importer command, run inside the `biblestudy` container on the VPS, fills Chapters, Recordings and the media volume and writes an ImportManifest.
- Full BSB text is imported once. Audio is imported per chapter:
  - Romans for every enabled narrator during setup;
  - any other chapter on first request (shown as "Preparing narration").
- CSB chapters are fetched by the server when first requested and refreshed after 14 days, only while a key is configured.

**People:**
- Members open the hostname in Safari or Chrome. Installing to the home screen is optional and explained by in-app help for iPhone and Android.
- Updates arrive as a new service worker. The app shows "Update ready" and applies it only on approval. Approval is refused while a live session is joined, during sign-in, or while other windows of the app are open (DOD-27).

**Connector:**
- The connector runs on the owner's PC from a clone of this repository, with a start command and three environment variables: server URL, connector token, and AgentConsole runtime path.
- To upgrade it, pull and restart. It is not distributed to anyone else.

## Failure modes

**SMTP relay unreachable or rejecting**
- Detected by: send error or SMTP response code.
- System: the job retries with backoff (1, 5, 15, 60 min), and a 5xx permanent rejection fails the job immediately.
- Users see:
  - a sign-in screen that says "Code not sent yet — retrying" after 30 s, with the server's real job status;
  - reminders that are late but never duplicated.
- Left behind: the `failed` job and its last error. Account → Operational status (S20) shows a fixed safe failure category and guidance, recipient, attempts and job ID; the raw error stays on the server. Transient retries and suppressed reminders are distinct from terminal failures.

**Login code wrong, expired or reused**
- Detected by: hash mismatch, `expiresAt` or `consumedAt`.
- System: rejects; the 5th failure kills the code.
- Users see: "Code expired or already used — send a new one".
- Left behind: `failedAttempts` incremented.

**Invitation revoked, expired or accepted**
- Detected by: invitation row checks inside the sign-in transaction.
- System: sign-in still succeeds, but no membership is created.
- Users see: "This invitation is no longer valid — ask Ben for a new link".
- Left behind: the User without a membership.

**PostgreSQL down**
- Detected by: query error, or the container health check, `GET /__health`, which runs `SELECT 1`.
- System: HTTP 503 `unavailable`, and the WebSocket closes with `closeUnavailable` (4503); the client shows "Server unavailable" and reconnects with backoff. The container turns unhealthy, which Portainer shows. Docker's `restart: unless-stopped` acts on an exit only, so the app is not restarted for it, and needs not be: it reconnects once the database is back.
- Users see: "Server unavailable"; downloaded chapters, notes and solo listening keep working.
- Left behind: nothing partial, because every write is a single transaction.

**App process restart mid-session**
- Detected by: startup finds an `active` session.
- System: on load, sets `status = paused` at the derived position and bumps `revision` (DOD-11).
- Users see: clients reconnect and see "Paused — server restarted".
- Left behind: the session stays active and paused.

**Client network loss**
- Detected by: WebSocket close or missed heartbeats (15 s).
- System: the connection is dropped from Presence; queued commands are discarded on the client.
- Users see: "Reconnecting…", then the fresh snapshot.

**Room empties**
- Detected by: Presence count reaches 0.
- System: after a 20 s grace period, applies pause at the derived position.
- Users see: paused on return.

**Media file missing or checksum mismatch**
- Detected by: media serve checks the file exists. The importer verifies size and hash.
- System: the Recording is marked unavailable and the chapter falls back to text plus manual verse marker.
- Users see: "Narration unavailable for this chapter: <reason>".
- Left behind: the manifest records the failure.

**Verse timing missing or invalid**
- Detected by: import validation.
- System: `timingStatus = absent` or `rejected`; the player plays the chapter without verse following.
- Users see: "Verse following unavailable for this recording".

**AO Lab unavailable during import**
- Detected by: HTTP error or timeout.
- System: per-chapter retry three times, then that chapter is `failed` in the manifest; text already imported stays.
- Users see: only the importer operator sees it; members see "Preparing narration failed — try later" for on-demand audio.

**API.Bible key missing, revoked, over quota or CSB access not granted**
- Detected by: configuration check or 401/403/429.
- System: CSB availability becomes `not_configured` or `unavailable` with the reason. Stored CSB text is shown until its `expiresAt`, never after.
- Users see: CSB stays selectable, and the reader shows the reason, for example "API.Bible rejected the key" (D-2026-10-30-04).

**Skynet connector offline**
- Detected by: no link, or no heartbeat for 30 s.
- System: the assistant reports `offline`, and new turns are refused (not queued).
- Users see: "Study assistant offline (PC not connected)". Reading, notes and narration are unaffected (DOD-21).

**Link drops mid-turn**
- Detected by: link close while a turn is `streaming`.
- System: the turn becomes `uncertain`; it is resolved by resubscribe/read on reconnect, never resent.
- Users see: "Connection lost — checking whether the answer finished".

**Runtime asks for a tool or permission**
- Detected by: a `permission.request` or tool event.
- System: deny; then interrupt and fail the turn.
- Users see: "The assistant tried to use a tool; this turn was stopped".
- Left behind: the turn is `failed: tool_attempt`.

**IndexedDB write fails or over quota**
- Detected by: transaction error or `QuotaExceededError`.
- System: the write is aborted and the previous version kept.
- Users see: "Save failed — not enough storage" with a link to remove downloads.

**Download interrupted**
- Detected by: fetch error or checksum mismatch.
- System: the partial assets are deleted and the manifest marked `failed`.
- Users see: "Download failed — retry"; it never shows Ready.

**Sync conflict**
- Detected by: stale base revision with a different body.
- System: a NoteConflict is recorded and both versions kept.
- Users see: a "Two versions" chooser.

**Safari evicts storage of a non-installed site after 7 days without use**
- Detected by: missing stores or manifests at start.
- System: anything missing is treated as not downloaded; synced notes are pulled again.
- Users see: install help explains that installing keeps downloads. The download list shows only what is really present.

**Clock skew between device and server**
- Detected by: the offset measured from WebSocket ping samples (the minimum-RTT sample of 8).
- System: all playback anchoring uses server time plus the measured offset; device wall time is never trusted.

## Concurrency and ordering

**Playback commands.** These are the only contended writes.
- Inside the single app process they are serialized per session through an in-process queue.
- The database enforces the same rule with `UPDATE … WHERE id = $1 AND revision = $2`. A second process could not corrupt state, only produce `rejected_stale`.
- Pause skips the revision check by design.
- `commandId` uniqueness makes retries idempotent.

**One active session per group.** Enforced by a partial unique index on `(groupId) WHERE status = 'active'`. Starting a session while one is active joins it instead.

**Group stopping point.** It is append-only. The confirmation carries the GroupProgress id the client last saw. A confirmation based on an older id is rejected as stale, so two members confirming at once cannot silently overwrite each other; the second sees the first's choice.

**Email.**
- Workers claim jobs with `SELECT … FOR UPDATE SKIP LOCKED` and mark them `sending`.
- A job stuck in `sending` for more than 10 minutes is retried. Because SMTP gives no idempotency, a crash between SMTP acceptance and the status write can, rarely, resend one message.
- Reminder dedupe holds at the ReminderDelivery level. That one window is the only duplicate path, and it is accepted.

**Reminder materialization.** It is an upsert keyed by the delivery's unique tuple, so concurrent ticks are harmless. Only one tick runs at a time, held by a Postgres advisory lock.

**Personal sync.**
- Operations from one device are pushed in creation order.
- Operations from different devices interleave and are ordered by the server's revision check.
- `opId` uniqueness makes replays harmless.

**Questions and replies.** These are independent inserts. Edits carry the revision they were made against, and stale edits are rejected with the current text. Deleting a post with replies blanks its body but keeps its row (DOD-18).

**Assistant turns.**
- One turn at a time per conversation: a send while a turn is `streaming` or `uncertain` is refused.
- `clientTurnId` uniqueness guards double submit.
- TranscriptEntry uniqueness on `runtimeSeq` guards replayed events.

**Several windows on one device.**
- IndexedDB writes go through one transaction per save.
- A `BroadcastChannel` tells other windows about saves, logout and account switches, so they hide or refresh records (DOD-27).
- Update approval checks the number of open clients through the service worker and refuses when more than one is open.

**Downloads.** One download per chapter at a time, enforced by a Web Lock named after the chapter.

## Alternatives considered

1. **Overall architecture.**
   - Chosen: the **minimal** approach. One Node/TypeScript service, PostgreSQL and a media volume on the VPS, a single origin for the web app, API and WebSocket, and a PC-side connector for Skynet.
   - Rejected: the **ideal** approach — separate API, realtime and worker services, object storage with a CDN for media, and a managed voice provider. It adds three moving parts and a paid-plan risk for a three-person group, and the voice part is out of v1.
   - Rejected: the **lateral** framing — "the call stays where it is; the app is only a companion". Since voice was dropped, v1 effectively converges on it anyway. The difference is that synchronized narration and shared controls stay in the app, which that framing would have given up.

2. **Group voice.**
   - Chosen: none in v1 (owner decision, D-2026-10-30-02).
   - Rejected: LiveKit Cloud's free tier, because the owner has a different solution for later.
   - Rejected: self-hosted LiveKit or plain WebRTC with a TURN server, which adds operations the owner does not want in v1.

3. **Where scripture and audio come from at runtime.**
   - Chosen: the server imports into its own database and media volume, with pinned editions and checksums; clients only talk to our origin.
   - Rejected: clients fetching AO Lab directly. Its audio host sends no CORS headers, so verification and download into Cache Storage would not work. An upstream change would also silently change displayed text, breaking DOD-14.
   - Rejected: bundling all audio in the image. It is gigabytes per narrator.

4. **CSB text.**
   - Chosen: API.Bible's free Starter plan. It is noncommercial, has up to 3 licensed Bibles and 5,000 calls a month. The owner creates the account and requests CSB, cached text expires after 14 days, Fair Use reporting is on, and there is no CSB audio.
   - Rejected: copying from read.csbible.com. That is not a licensed source.
   - Rejected: dropping CSB. It is required by DOD-12.
   - Rejected: a paid licence. The owner declined paying.

5. **Email.**
   - Chosen: the app speaks SMTP to any relay named by one `SMTP_URL`, using an open-source mail library. The default is the owner's existing Gmail account with an app password: free, no new account, about 500 messages a day, and Gmail's own deliverability.
   - Alternative, still supported: a self-hosted open-source Postfix container in the stack, signing DKIM. It is selected by `SMTP_URL` and needs the VPS's outbound port 25 open, plus SPF, DKIM, DMARC and reverse-DNS records.
   - Rejected: commercial sending APIs. They need a new account and their free tiers can change.
   - Rejected as the default: self-hosting. A fresh VPS IP often lands in spam for sign-in codes, and many VPS providers block port 25.
   - Mailpit, also open source, captures mail in development only.

6. **Sign-in.**
   - Chosen: a 6-digit emailed code with server-side sessions in an HttpOnly cookie.
   - Rejected: magic links. On iPhone, a link opened from Mail lands in Safari, not the installed app, so the home-screen app never gets signed in.
   - Rejected: stateless JWTs. They cannot be revoked on logout or member removal without a server lookup anyway.

7. **Realtime transport.**
   - Chosen: one WebSocket per client.
   - Rejected: server-sent events plus POST. That needs two channels and a separate clock-sync path.
   - Rejected: polling. It cannot hold a 500 ms drift target or show pauses promptly.

8. **Reaching Skynet.**
   - Chosen: a connector on the PC that dials out to the server.
   - Rejected: running AgentConsole on the VPS. The model CLIs and the owner's subscriptions live on the PC, and moving them there widens what the VPS can do.
   - Rejected: exposing the PC through a tunnel. That opens an inbound path to the owner's development machine.

9. **Serving the web app.**
   - Chosen: the Node service serves the built app itself, on one origin.
   - Rejected: Adventures' separate nginx container. With one origin the session cookie, WebSocket and media share no CORS or cookie-domain configuration, and one image is one thing to deploy.

10. **Narration sync.**
    - Chosen: every device plays the same server-hosted file, aligned to server time (approved premise).
    - Rejected: streaming one device's audio to the others. That needs a media server and makes one device the host, which DOD-06 forbids.
    - Rejected: synthesizing speech locally. That is a non-goal.

## Open questions

- Which real phones run the device checks (an iPhone with its iOS and Safari version, and an Android phone with its Chrome version)? DOD-23, DOD-28 and DOD-29 cannot pass without them.
- Is `biblestudy.subzerodev.com` the hostname, and does the owner add its DNS record and reverse-proxy route, or should another name be used?
- When the owner's later voice solution arrives, does it live inside this app or alongside it? This only matters after v1. Nothing in v1 depends on it, and the WebSocket channel leaves room for either.
