# Slices — SubZeroDev.BibleStudy

Built from [10-design.md](10-design.md) and [20-contract.md](20-contract.md).

**Order.** The order exercises the design's riskiest bets early:

- audio import with verse timing: S3;
- shared narration drift and recovery: S5;
- a real, tool-free Skynet turn: S6;
- the VPS pipeline: S7.

The narrow path in the brief is S1–S5 and S8–S9. The solo path adds S6 and S12.

**Owner-side prerequisites.** Some criteria need things only the owner can provide:

- an SMTP app password;
- an API.Bible key;
- DNS, the proxy route and the deploy webhook;
- real phones.

Each such criterion says so. A slice whose code is complete but whose owner-side check cannot run yet is reported with that check marked not performed, never as passed.

## S1 — Sign in with an emailed code
Status: done
Delivers: A group member can sign in with nothing but their email address and a code sent to it, then set their name and time zone. They stay signed in on that device and can sign in on another.
Touches: platform, mail, identity, web, client shell; CI gates; container image
Depends on: none
Acceptance:
  - S1.1 Requesting a code for `member@example.test` enqueues exactly one `login_code` job. In development the code arrives in Mailpit within 10 s; the database stores only its hash.
  - S1.2 Verifying the correct code sets an HttpOnly, Secure, SameSite=Lax session cookie and returns the profile. The same code verified a second time returns `code_expired`.
  - S1.3 A code verified 10 minutes and 1 second after issue returns `code_expired`. Five wrong codes kill the code, so the right code then returns `code_expired`.
  - S1.4 Requesting a second code makes the first one return `code_expired`.
  - S1.5 A sixth code request for one email within an hour returns `rate_limited` with `retryAfterSeconds`.
  - S1.6 Signing in on a second browser profile with the same email resolves to the same user id. Logout revokes only that browser's session.
  - S1.7 `PATCH /api/me` with `timeZone: 'Mars/Base'` returns `invalid_zone`. With `Europe/Sofia` it is stored and returned.
  - S1.8 Every non-auth API route returns `unauthenticated` without a cookie.
  - S1.9 The container image starts against an empty PostgreSQL, applies migrations, and serves `/__build-id` with the commit.
  - S1.10 CI runs typecheck, unit tests, integration tests against a real PostgreSQL service, and the docs check.
  - S1.11 With `SMTP_URL` pointing at a real relay, a code reaches a real inbox.
    - This needs the owner's relay credentials. Until then it is reported as not performed.
Out of scope: invitations and groups (S4); reminder emails (S11); any styling beyond a usable sign-in screen.

## S2 — Read the Bible and find a passage
Status: done
Delivers: A signed-in member opens the app at Romans 1 in the BSB. They can move to any book and chapter, type a reference such as "Romans 3:12" to jump there, and always see where they are.
Touches: content (translations, chapters, import CLI, catalog/chapter API, `parseReference`), client reader
Depends on: S1
Acceptance:
  - S2.1 `import-content --translation BSB` imports all 66 books from the AO Lab API.
    - It writes an ImportManifest with the source translation's checksum and per-chapter `contentSha256`.
    - Re-running it changes no rows when the source is unchanged.
  - S2.2 `GET /api/content/BSB/ROM/1` returns 32 verses whose text equals the source chapter's verse text, and a `contentSha256` that hashes the stored content.
  - S2.3 `parseReference` behaves as follows:
    - `'Romans 3:12'` → `{ROM, 3, 12, 12}`
    - `'rom 3'` → `{ROM, 3, null, null}`
    - `'Romans 3:12-15'` → `{ROM, 3, 12, 15}`
    - `'Romans 17'` → null
    - `'1 Cor 13:4'` → `{1CO, 13, 4, 4}`
  - S2.4 A new user's first screen shows Romans 1 with the reference visible.
  - S2.5 The book and chapter selectors, previous/next chapter and reference entry reach Romans 2 and 3 and back. At Romans 16, next goes to 1 Corinthians 1.
  - S2.6 Jumping to `Romans 3:12` scrolls verse 12 into view and marks it.
  - S2.7 `GET /api/content/translations` lists BSB `available` and CSB `not_configured` with a reason. Choosing CSB shows "CSB text not available from a licensed source" and no text.
Out of scope: audio (S3); CSB fetching (S13); personal display translation (S12).

## S3 — Listen to a chapter with the verse highlighted
Status: done
Delivers: A member can play the narrated chapter, see each verse highlighted as it is read, and play just a selected range that stops at its end. They are told plainly when a recording or verse following is missing.
Touches: content (narrators, recordings, audio import, media serving, `listRecordings`, `resolveRecording`), client player (solo playback only)
Depends on: S2
Acceptance:
  - S3.1 Importing audio for Romans 1–16 stores one file per chapter and narrator for `souer` and `hays`.
    - Each file is named by its SHA-256.
    - Byte counts and hashes are recorded in the manifest.
    - `david` is not imported while disabled.
  - S3.2 Romans 1 / `souer` gets `timingStatus = 'verified'` with 32 increasing starts.
    - A test fixture with 31 entries is stored as `rejected` with reason `verse count 31 ≠ 32`.
    - A fixture with a non-increasing entry is stored as `rejected`.
  - S3.3 `GET /media/<sha>` with `Range: bytes=0-99` returns 206 and 100 bytes. The full file hashes to `<sha>`.
  - S3.4 During playback of Romans 1 the highlighted verse matches the verse whose start time precedes the current position, checked at 5 positions.
  - S3.5 Playing `Romans 1:16-17` starts at the verse 16 start time and stops within 250 ms of the verse 18 start time.
  - S3.6 A recording with `timingStatus ≠ verified` plays the whole chapter and shows "Verse following unavailable for this recording". Range playback is disabled for it.
  - S3.7 An on-demand request for a chapter with no imported audio returns `preparing`, then lists the recording once imported. A failed import lists the narrator under `failed` with the reason.
  - S3.8 The player labels the narrator and translation. No BSB recording is offered while CSB is the displayed translation.
Out of scope: shared playback (S5); downloads for offline (S14).

## S4 — Create the group and invite members
Status: done
Delivers: The owner sets up the private group and sends each member a private link. The member signs in through it and lands in the group. Only the owner can revoke links or remove members.
Touches: groups (Group, Membership, Invitation, `requireMember`, `requireOwner`, `acceptInvitation`), identity (invitation carried through sign-in), client group screens
Depends on: S1
Acceptance:
  - S4.1 The first user signing in with `OWNER_EMAIL` becomes owner of the one group with schedule Monday 06:15 `America/Chicago` and start passage Romans 1.
  - S4.2 The owner creates a link. A new user who opens it, signs in by code and verifies gets `invitation: 'accepted'` and is a member. The same link used by a third user returns `invitation: 'invalid'` and creates no membership.
  - S4.3 A revoked link, and a link 14 days and 1 second old, both return `invitation: 'invalid'`.
  - S4.4 A member calling create, revoke or remove gets `not_owner`. A signed-in non-member calling `GET /api/groups/:id` gets `not_member`.
  - S4.5 A removed member's next group request returns `not_member`, and their open realtime connection is closed.
  - S4.6 The invitation token survives the code step in the installed-app flow: the link is opened, then the app is reloaded before the code is typed.
Out of scope: emailing invitations (never in v1); schedule editing (S10).

## S5 — Play narration together
Status: done
Delivers: Any member can start or join the study, and everyone hears the same narration at the same point. Anyone can play, pause, seek, change passage, narrator or rate, and everyone sees who paused. Late joiners, refreshes and dropped connections catch up without replaying anything.
Touches: study (StudySession, PlaybackState, SessionCommand, Presence, `/ws`, `startOrJoinSession`, `driftReport`), client live and player (clock sync, drift correction, manual verse marker)
Depends on: S3, S4
Acceptance:
  - S5.1 Two members starting a session at once end up in one active session (one row with `status = 'active'`).
  - S5.2 `pause` with a stale `expectedRevision` is applied. `seek` with a stale revision returns `rejected_stale` with the current state, and the revision is unchanged.
  - S5.3 Resending a `commandId` returns the original outcome and does not change the revision.
  - S5.4 Three browser clients on one machine play Romans 1 for 120 s.
    - The drift report shows p95 ≤ 500 ms across ready clients.
    - The measured values are reported in the pull request, pass or fail.
  - S5.5 A member's pause reaches the other clients within 1 s, and all show that member's name.
  - S5.6 A client that loses its connection for 20 s and returns gets a snapshot. Commands it issued while disconnected are not applied.
  - S5.7 The original starter leaving does not end the session. The last connection closing pauses playback after 20 s grace with `pausedReason: 'room_empty'`.
  - S5.8 Killing and restarting the server during playback leaves the session `paused` with `pausedReason: 'server_restart'` at the derived position ±1 s.
  - S5.9 With CSB as the shared translation (no narration), the session runs in `manual` mode, and any member's `set_manual_verse` highlights that verse for everyone.
  - S5.10 A signed-in non-member's `join` and `command` return `not_member`.
Out of scope: questions in the session (S8); wrap-up and stopping point (S9); voice (out of v1).

## S6 — Ask the study assistant about a passage
Status: done
Delivers: The owner can ask Skynet about the passage they are reading and watch the answer stream in. They can stop it, come back later to the same conversation, and still read and listen when the PC is off.
Touches: assistant (conversations, turns, transcript, `/connector`), connector process (AgentConsole over stdio), client assistant panel
Depends on: S2
Acceptance:
  - S6.1 With the connector running against the real AgentConsole runtime, a turn about `Romans 1:16-17` streams deltas into the app and completes.
    - The runtime received the translation, reference and exact verse text, shown in the turn's stored context.
  - S6.2 Interrupt during streaming ends the turn `interrupted` within 5 s.
  - S6.3 Reloading the page shows the transcript once. Killing and restarting the connector mid-turn yields one terminal state and no duplicate entries (unique `runtimeSeq`).
  - S6.4 Sending the same `clientTurnId` twice returns `existing: true` with one runtime turn dispatched.
  - S6.5 A prompt asking the assistant to list files in its working directory produces no tool execution. Either the permission is denied or the turn fails `tool_attempt`; the runtime log shows a `deny` decision or no request.
  - S6.6 With the connector stopped, the status shows offline, a send returns `assistant_offline`, and reading and narration still work.
  - S6.7 A member who is not `ASSISTANT_OWNER_EMAIL` gets `assistant_not_permitted`.
  - S6.8 No API response or WebSocket message to the browser contains the connector token, runtime session id, principal or `cwd` (checked by a test over all assistant payloads).
Out of scope: notes in the context (S12 adds `noteIds`); LLM in group sessions (non-goal).

## S7 — Deploy to the VPS
Status: done
Delivers: The owner can run the app on their VPS from a merged commit, with nightly backups and a restore they have seen work, so the group can use it with the PC off.
Touches: container image, compose stack, GitHub Actions publish workflow, backup job, deploy docs
Depends on: S1
Acceptance:
  - S7.1 A merge to `main` pushes `ghcr.io/the-running-dev/subzerodev.biblestudy:<sha>` and `:latest`. The webhook call is skipped unless `DEPLOY_ENABLED` is `true`.
  - S7.2 `docker compose up` from the repository's stack file with `.env.example` values (passwords replaced) serves `/__build-id` on the app port. Postgres data and media survive `docker compose down && up`.
  - S7.3 The backup job writes a `pg_dump` and a media manifest. Restoring them into an empty stack reproduces users, groups and chapters (row counts and chapter checksums equal). The drill result is recorded.
  - S7.4 A migration that fails exits the container non-zero before the listener opens.
  - S7.5 Deployed on the VPS at the owner's hostname, `/__build-id` returns the merged commit.
    - This needs the DNS record, proxy route and webhook secret. Until then it is reported as not performed.
Out of scope: monitoring or paging; a second environment.

## S8 — Post and answer questions on verses
Status: done
Delivers: Members preparing during the week can post questions on a verse, a range or a whole chapter, and reply to each other without joining the study. During the study, those questions pop up as the narration reaches their verses.
Touches: questions (posts, replies, edits, deletes), study (questions in the snapshot and `question` messages), client questions UI
Depends on: S5
Acceptance:
  - S8.1 A question on `Romans 2:4` posted by one member is listed for another member reading Romans 2 without a session. Their reply is visible to the first member. The group stopping point is unchanged.
  - S8.2 Re-posting with the same `clientOpId` returns the same question; there is one row.
  - S8.3 During shared playback of Romans 2, the `Romans 2:4` question appears when verse 4 starts, without pausing. Seeking back over verse 4 does not add it a second time. A chapter question is listed from the start.
  - S8.4 Editing one's own post sets `editedAt` and shows "edited". Editing another member's post returns `not_author`.
  - S8.5 Deleting a question with no replies removes it. Deleting one with replies returns `body_removed`, and the replies remain listed under a "removed" placeholder.
  - S8.6 The full question list for a chapter stays available from the reader, filtered by status.
Out of scope: wrap-up dispositions (S9); offline drafts (S15).

## S9 — Wrap up and resume where the group stopped
Status: done
Delivers: At the end of a study, the group confirms where it stopped and settles each open question. Next time, Resume study opens exactly there with carried questions back in view.
Touches: progress (`currentStoppingPoint`, `confirmStoppingPoint`, `wrapUpSuggestion`), questions (`setDisposition`), client wrap-up and Resume study
Depends on: S8
Acceptance:
  - S9.1 After playback reaches `Romans 2:16`, wrap-up suggests `ROM 2:16`. A member can adjust it to `ROM 2:11` and confirm, and Resume study then opens Romans 2:11.
  - S9.2 Two confirmations based on the same previous id: the first succeeds, the second returns `stale_progress` and shows the first's choice.
  - S9.3 Browsing to Romans 5, seeking, changing the passage and posting questions leave `currentStoppingPoint` unchanged. Solo position is never written by group actions.
  - S9.4 Each open question can be marked Close, Carry forward, Resolved or No longer relevant. A carried question appears in the next session's wrap-up and question list with its original anchor and replies.
  - S9.5 Rehearsal setup can confirm Romans 3:1 as the starting point by an explicit confirmation. No chapter is marked studied without one.
Out of scope: schedule (S10).

## S10 — See the meeting time in your own time zone
Status: done
Delivers: Every member sees the next meetings at the right local time for them, correct across both countries' clock changes, and any member can move, cancel or plan the passage for an occurrence.
Touches: schedule (occurrences, `listOccurrences`, `updateOccurrence`, `localizeOccurrence`, `instantFor`), owner schedule edit, client schedule view
Depends on: S4
Acceptance:
  - S10.1 The 2 November 2026 occurrence localizes as follows:
    - `startsAt` is `2026-11-02T12:15:00Z`;
    - a viewer in `America/Chicago` sees 06:15;
    - a viewer in `Europe/Sofia` sees 14:15.
  - S10.2 The 26 October 2026 occurrence shows 06:15 in Chicago and 13:15 in Sofia, and 9 March 2026 shows 06:15 and 13:15.
  - S10.3 Changing the owner's schedule to 07:00 regenerates the following eight weeks of scheduled occurrences. Moved and cancelled ones keep their overrides.
  - S10.4 Moving an occurrence with a stale revision returns `stale_revision`.
  - S10.5 Each member's view uses their profile zone, not the browser's.
Out of scope: reminder emails (S11); calendar export (P1).

## S11 — Get reminded before each study
Status: done
Delivers: Each member gets an email a day and an hour before each study, in their own time, with the passage and an Open study link. They can change when reminders come or turn them off without affecting anyone else.
Touches: reminders (preferences, `reminderTick`), mail, schedule
Depends on: S10, S1
Acceptance:
  - S11.1 With a fake clock, a tick at `startsAt − 24h` enqueues one reminder per member with the default preference. Further ticks enqueue nothing more.
  - S11.2 A Sofia member's email says "Monday 2 November 2026, 14:15 EET (Europe/Sofia)". It includes the planned passage and an Open study link to the study page.
  - S11.3 A member with offsets `[120]` gets only the 2-hour reminder. A member with reminders off gets none. Both still receive login codes.
  - S11.4 Moving the occurrence after the 24 h reminder was queued but before sending suppresses the old one and schedules new ones for the new time. Cancelling suppresses all pending ones.
  - S11.5 A tick 31 minutes after a reminder's send time (simulated downtime) suppresses it.
  - S11.6 Killing the worker between claim and send leads to at most one delivered message per delivery in the integration test against Mailpit.
  - S11.7 Development and tests send only to Mailpit and synthetic addresses. No real member is emailed during development or the demo preparation.
Out of scope: push notifications (non-goal).

## S12 — Study alone with private notes
Status: done
Delivers: A member can read and listen on their own, with their own place kept separately from the group's. They can write private notes on verses, display a different translation for themselves only, and hand chosen notes to the study assistant.
Touches: personal (notes, solo position, `pushOps`, `pull`), identity (`displayTranslationId`), assistant (`noteIds` in context), client solo mode
Depends on: S3, S6
Acceptance:
  - S12.1 Solo mode works for a user who belongs to no group and with the connector stopped.
  - S12.2 Moving through Romans 4 in solo mode updates solo position. `currentStoppingPoint` is unchanged, and the reverse also holds.
  - S12.3 A note on `Romans 4:3` is returned by `pull` for its author only. Another member's request for it returns nothing, and no group endpoint includes it.
  - S12.4 Setting `displayTranslationId` to CSB while the group shares BSB affects only that member, and the reader labels it "Your display translation".
  - S12.5 An assistant turn with two `noteIds` stores those note bodies in its context. Another user's note id is rejected.
Out of scope: offline saving and conflicts (S15).

## S13 — Read CSB when the owner's key is set
Status: done
Delivers: Once the owner adds their free API.Bible key, members can read the CSB, with its copyright notice shown and the text refreshed as the licence requires. Without the key they are told why it is missing.
Touches: content (CSB source, expiry, FUMS token), client reader
Depends on: S2
Acceptance:
  - S13.1 Without `APIBIBLE_KEY`, CSB is `not_configured`.
  - S13.2 With an invalid key, CSB is `unavailable` with reason `API.Bible rejected the key` (verified with a recorded 401 fixture).
  - S13.3 With a valid key and CSB access, `GET /api/content/CSB/ROM/1` returns text from API.Bible, the copyright notice and `expiresAt = fetchedAt + 14 days`.
    - This needs the owner's key and approved CSB access. Until then it is reported as not performed.
  - S13.4 A stored CSB chapter past `expiresAt` is not served. It is refetched when possible, otherwise `translation_unavailable`.
  - S13.5 Narration for CSB reports `unavailable: no licensed CSB recording`.
  - S13.6 The Fair Use token is reported as the API terms require, and queued while offline.
    - The call format is settled by this slice from the API.Bible documentation, and the pull request names the source.
Out of scope: CSB audio (none exists).

## S14 — Install on a phone and download chapters for offline
Status: done
Delivers: A member can add the app to their phone's home screen with in-app help, download chosen chapters (text only, or with narration, size shown first), and read and listen to them with no connection after a full close.
Touches: client shell (manifest, install help), service worker, offline (`downloadChapter`, `removeDownload`), content (`downloadManifest`)
Depends on: S3
Acceptance:
  - S14.1 The download dialog for Romans 1 with narration shows the total size from the manifest before starting.
  - S14.2 An interrupted download (network cut at 50 %) ends `failed`, never `ready`. Its partial assets are removed.
  - S14.3 With Romans 1 downloaded with narration, the app runs from a cold start with the network blocked. In an automated browser test it shows Romans 1, plays the narration and follows verses.
  - S14.4 An undownloaded chapter offline says "Not downloaded — needs a connection". A text-only download offers no play button offline.
  - S14.5 Removing a download keeps the notes on that chapter.
  - S14.6 Install help shows the Safari Share → Add to Home Screen steps on iPhone and the Chrome install prompt or menu steps on Android.
  - S14.7 On a real iPhone and a real Android phone, the installed app launches standalone and runs a downloaded chapter offline. Login and storage differences between installed and browser use are recorded.
    - This needs the owner's phones. Until then it is reported as not performed.
Out of scope: offline note sync (S15).

## S15 — Save notes and drafts offline and sync them safely
Status: done
Delivers: A member's notes, solo place and question drafts save on their phone even offline, show honestly whether they are saved, and sync when the connection returns without duplicates. If two devices disagree, both versions are kept for them to choose.
Touches: offline (`saveNote`, `saveDraft`, save states), sync engine, personal (`pushOps`, `pull`, `resolveConflict`)
Depends on: S12, S14
Acceptance:
  - S15.1 A note saved offline shows "Saved on this device" only after the IndexedDB transaction completes. It survives a full close and offline restart.
  - S15.2 A simulated `QuotaExceededError` shows "Save failed" and leaves the previous version readable.
  - S15.3 On reconnect, pending operations push once. Pushing the same batch twice yields `already_applied` and one note.
  - S15.4 Editing the same note on two devices from revision 3 creates a NoteConflict. The chooser offers both versions, and `kept_both` leaves two notes.
  - S15.5 A question draft saved offline shows "Not posted". Posting requires a connection and a tap, and posts once.
  - S15.6 Playback commands and stopping-point confirmations issued offline are refused in the UI and never sent later.
Out of scope: multi-window and account switching (S16).

## S16 — Updates, logout and export that never lose data
Status: done
Delivers: Members get app updates only when they approve them and it is safe, and logging out or switching accounts hides the previous account's data everywhere. Anyone can export their own data.
Touches: client shell (update prompt, `requestUpdate`, `switchAccount`), service worker, personal (`exportPersonal`)
Depends on: S15
Acceptance:
  - S16.1 A new build shows "Update ready". Approving it applies the update while the app is idle, and notes and downloads are intact afterwards.
  - S16.2 Approval returns `live_session` while joined to a session, `signing_in` during sign-in, and `multiple_windows` with two windows open.
  - S16.3 Logging out in one window hides the account's notes, drafts and downloads in the other open window within 2 s. Signing in as another user shows none of them.
  - S16.4 Export returns a file containing the user's profile, notes, solo position, authored questions and replies, and conversations, and nothing of other users.
Out of scope: background sync (not in v1).

## S17 — Works on small phones and real devices
Status: done
Delivers: Every screen works on the smallest phones in either orientation, with larger text and the keyboard open. Phone-specific audio behaviour on the owner's devices is checked and written down.
Touches: client layout across reader, controls, questions, downloads, install help, assistant
Depends on: S16
Acceptance:
  - S17.1 Automated layout checks at 320×568 and 360×640, in portrait and landscape, at 200 % text: no horizontal page scroll on any main screen.
  - S17.2 With the on-screen keyboard open on the question composer, the send and save buttons are visible.
  - S17.3 Safe-area insets are respected in standalone mode, checked in the simulator.
  - S17.4 On the owner's phones the following are recorded:
    - autoplay handling (the first play needs a tap);
    - narration after a screen lock and return;
    - headphones and Bluetooth output;
    - speaker echo when the group call runs alongside.
    - This needs the owner's phones. Until then it is reported as not performed.
  - Checked: S17.1 and S17.2 in `tests/e2e/layout.test.ts`. S17.3 is checked in Chromium with the insets overridden through CDP, not in a simulator (no Mac here). S17.4 is not performed.
Out of scope: new features.

## S18 — Hand over: setup, demo and results
Status: done
Delivers: The owner can set up, import content, deploy, install on phones and run the demo from written instructions, and sees exactly which checks passed, which were not performed, and what is still limited.
Touches: README and docs, `.env.example`, demo seed with synthetic users
Depends on: S1–S17
Acceptance:
  - S18.1 Following the setup instructions from a fresh clone gives a working local app with synthetic demo data. Verified by doing it in a clean checkout.
  - S18.2 Every environment variable the code reads appears in `.env.example` with a placeholder and a one-line purpose. A test compares the two lists.
  - S18.3 The handover lists the following:
    - each DOD item with its evidence or the reason it was not performed;
    - test counts from the last CI run;
    - the import manifest identifiers;
    - remaining limitations.
  - S18.4 The demo preparation uses synthetic accounts only and sends no real invitations or reminders.
  - Checked: S18.1 by following the README in a clean clone on 31 October 2026 against an empty database (migrations, BSB text, Romans 1 narration, `npm run demo:seed`, sign-in as a demo member through Mailpit, the shared socket). It found two setup defects, now fixed: the example `CONNECTOR_TOKEN` placeholder stopped the server, and the dev client's `/api` proxy also caught `/api.ts`, leaving a blank page; `/media/` and `/ws` were not proxied. S18.2 in `tests/unit/env-example.test.ts`, S18.3 in `docs/handover.md`, S18.4 in `tests/integration/demo.test.ts`.
Out of scope: new features.


## S19 — Contain imported CSB distribution
Status: implemented; full CI validation pending
Delivers: A reversible owner-only default for imported CSB, independent of group membership and licensing approval.
Touches: content access/catalog, web/assistant loading, manifests, offline records, configuration, documentation
Depends on: S13, S14, S18, PR #24
Acceptance:
  - S19.1 Signed-out requests return 401; signed-in solo accounts and ordinary members cannot retrieve imported CSB or its manifests, including encoded, HEAD and conditional requests.
  - S19.2 Only the verified OWNER_EMAIL account can read/download imports; no owner or disabled imports refuses everyone. Membership is not required for owner solo reading.
  - S19.3 Imported book availability is account-specific; BSB solo reading/downloads and expiring API.Bible content retain their behavior.
  - S19.4 New imported offline copies are scoped to the authorized account; old unscoped copies are purged by the updated client. Assistant permission alone grants no imported access.
  - S19.5 Technical containment, owner licensing confirmation and observed deployment state are reported separately. See ADR-0003.
Out of scope: enabling group distribution, declaring licence permission, recalling exported files, deploying without the established merge workflow.
