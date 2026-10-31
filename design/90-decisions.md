# Decision log

Append-only. Newest at the top. The rejected alternatives are the point — without them, every future session relitigates the same choice.

## Open
- Which real phones run the device checks (DOD-23, DOD-28, DOD-29).
- Whether `biblestudy.subzerodev.com` is the hostname, and who adds its DNS record and proxy route.
- The owner's status page is promised (10-design failure modes, the contract's mail errors, D-2026-10-30-15) but not built. Escalated to `/plan` for a slice.
- Whether the owner's CSB licence covers serving the imported text on the public site behind sign-in (2026-11-01). The code imports it; the licence is the owner's to confirm.

---

### 2026-11-01 — Deploy as SubZeroDev.Adventures does, with its two checks
- **Context:** The owner asked to deploy the way SubZeroDev.Adventures does. Both already publish to GHCR and redeploy a Portainer Git stack by webhook. Adventures also tests the exact image before publishing it, and after the redeploy waits for the site to serve the new revision; BibleStudy did neither.
- **Chosen:** `deploy.yml` builds the image locally, runs the stack drill on it, and pushes `:<sha>` and `:latest` only if the drill passes. With the repository variable `PUBLIC_URL` set, the deploy job polls `/__build-id` for five minutes after the webhook.
- **Rejected:** Adventures' separate frontend image and GitHub Pages path. BibleStudy serves its client from the one app image.
- **Rejected:** SSH from Actions to the VPS. Portainer owns the stack and its secrets, as in Adventures.

### 2026-11-01 — CSB imported from the owner's files
- **Context:** The owner holds the CSB as 66 `NN-Book.xml` files and asked to "integrate the CSB bible" from them. No API.Bible key exists yet, so CSB was never readable.
- **Chosen:**
  - `import-content --translation CSB --from <folder>` parses the files into the same chapter content as BSB: verses, headings and footnotes; cross-references, verse numbers and typographic spacing are dropped. Where a verse's own number marker disagrees with its element's reference, the marker wins; a table verse runs from its marker to the next.
  - An imported CSB chapter has no expiry and is served without API.Bible. An API.Bible fetch never overwrites it; an import replaces an API.Bible copy. With imported chapters and no key, CSB lists only the imported books.
  - The files stay out of git (`/bibles/`) and the image (`.dockerignore`). Tests use synthetic markup only. On the VPS they are copied into the container for the import and deleted (docs/deploy.md step 7).
  - I-11 now limits expiry to the API.Bible cache.
- **Rejected:** baking the files into the image or a volume. The repository and its image are public.
- **Rejected:** serving straight from the files at request time. Postgres gives the content hash, offline downloads and backups that BSB already has.
- **Flag:** CSB is copyrighted. Serving it on a public site, even behind sign-in, is covered only by the owner's own licence; that is the owner's to confirm (Open, above). D-2026-10-30-04 rejected copying from read.csbible.com; these are the owner's files, not that site's.

### 2026-11-01 — Align after S18: the design follows the code on modules and errors, and a database outage is now detected
- **Context:** An `/align` pass compared the design and contract with the tree after S18 and found four differences that were decisions.
- **Chosen:**
  - **Modules.** The module table in 10-design now lists the real imports. The graph has one cycle, `schedule` ↔ `reminders`, inside one transaction. A module writes only its own tables; a query may read others'. The demo seed moved out of `platform` into its own `demo` module, because a sink may not import `groups` and `questions`.
  - **Database down.** `GET /__health` runs `SELECT 1` and is the image's health check. A WebSocket whose message the database cannot serve closes with `closeUnavailable` (4503), and the client shows "Server unavailable" and reconnects with backoff. Docker restarts on exit only, so an unhealthy app is shown, not restarted; the design had said Portainer restarts it.
  - **Errors.** The contract follows the code: `assistant_offline` and `turn_in_progress` are retryable; `preparing` is a 202 response, not an error; `upstream_failed` was never raised and is removed from `ErrorCode`; the other uses of `rate_limited`, `not_found` and `invalid_request` are listed.
- **Rejected:** changing the code to the contract's errors. The retryable flags drive the client's retry, which works and is tested; the contract was the stale side.
- **Rejected:** building the status page in this pass. It is a feature, not drift, and needs a slice.

### 2026-11-01 — S18: the demo seed is synthetic and sends nothing
- **Context:** S18 must let the owner run a demo without inviting real people or sending mail.
- **Chosen:**
  - `npm run demo:seed` creates three `@example.test` members, their invitations accepted in the database, reminders off, three questions with replies on Romans 1–2 and a few notes. It refuses an `OWNER_EMAIL` outside `example.test`, and a second run changes nothing.
  - `.env.example` comments out `ASSISTANT_OWNER_EMAIL` and `CONNECTOR_TOKEN`: config rejects the placeholder token, so the server did not start for anyone following the README.
  - The Vite dev proxy matches `^/api/` (it had also caught the client's own `/api.ts`) and proxies `/media/` and `/ws`.
- **Rejected:** a demo that sends real invitations to the owner's address. The brief forbids invitations to prepare a demo.

### 2026-10-31 — S17: small phones are checked in Chromium emulation, and the composers keep their buttons with CSS alone
- **Context:** S17 must show every main screen at 320×568 and 360×640, in either orientation and at 200 % text, without sideways scroll, and keep the composers' buttons in view with the on-screen keyboard open.
- **Chosen:**
  - `tests/e2e/layout.test.ts` walks sign-in, the reader with the assistant, the question composer, the download dialog, the account panel, the group panel and a study session at each size with the root text doubled, and fails on any `scrollWidth` past the viewport. The keyboard is modelled as the viewport shrinking to what is left above it (55 % of the height in portrait, 45 % in landscape), at the phone's usual text size as S17.2 asks.
  - Controls are `border-box` and never wider than their container; the reader's book and chapter selects wrap to their own line and are cut short; the questions bar and the question buttons wrap; long words break.
  - The reader bar is sticky only on screens at least 34rem tall. On a shorter one (landscape, or the keyboard up) it scrolls away, because at 200 % text it covered the whole chapter.
  - The note's Save button and the question composer's buttons are `position: sticky; bottom: 0`, so while the composer is on screen they sit at the bottom of what is visible.
  - Safe-area insets pad every screen edge, checked by overriding them through the Chrome DevTools Protocol.
- **Rejected:** scrolling the submit button into view from script when the visible area shrinks. Chromium scrolls back to the caret on every keystroke, so the button went under the keyboard again.
- **Rejected:** an iOS Simulator run for S17.3. There is no Mac here; the CDP override checks the CSS, not Safari, and S17.4 on the owner's phones covers the real device.

### 2026-10-31 — S16: updates wait in the service worker for approval, and accounts are broadcast between windows
- **Context:** S16 must apply a new build only when the member approves it and nothing would be cut off, hide an account in every open window when it logs out, and let anyone export their own data (DOD-27).
- **Chosen:**
  - The service worker no longer calls `skipWaiting` on install. A new build waits; the page shows "Update ready" once a waiting worker exists and an older one controls the page. The page checks for a new build hourly.
  - `requestUpdate` refuses with `live_session` while joined to a study session and `signing_in` while a code is being entered, both counted in the page. Otherwise it asks the waiting worker, which counts the app's windows with `clients.matchAll` and refuses with `multiple_windows` when there is more than one, or calls `skipWaiting`. The page reloads once the new worker takes control.
  - Caches are named by build, and notes, drafts and downloads live in IndexedDB and `media-v1`, which an update never touches.
  - `switchAccount` posts the signed-in user id (null after a logout) on the BroadcastChannel `bs-account`. A window showing another account returns to sign-in at once; its local records were already keyed by user id, so the next account reads none of them.
  - `GET /api/export` returns one JSON file read in a single repeatable-read transaction: profile, live notes, solo position, the questions and replies the member wrote, and their conversations with prompts and transcript text. It leaves out other members' posts, even the questions the member replied to, and every runtime id and the context sent with a prompt.
- **Rejected:** applying updates on the next launch without asking. A launch during a session would change the client under a live playback, and the brief asks for approval.
- **Rejected:** counting windows with a BroadcastChannel ping. Windows that are frozen in the background do not answer; the service worker sees every window it controls.

### 2026-10-31 — S15: saves land on the device first, one waiting op per note, and conflicts are chosen by the member
- **Context:** S15 must say "Saved on this device" only once a save is stored, sync without duplicates when the connection returns, and keep both versions when two devices edit the same note (DOD-25, DOD-26).
- **Chosen:**
  - `outbox.ts` writes the note and its op in one IndexedDB transaction and reports `saved_on_device` only on `oncomplete`; a failed transaction (a full disk) reports `save_failed` and leaves the previous version as it was.
  - Each note has at most one waiting op. A newer save replaces it under a new op id, and the op's base revision is the last one the server confirmed. An op is removed only once the server reported its outcome, so a lost answer sends the same op id again and gets `already_applied`.
  - Sync is push then pull, single-flight per member and held under the Web Lock `outbox:<userId>` so two tabs never send at once; a call made during a run gets one more run after it. A pull never overwrites a note with a waiting op, and does not advance the cursor past one, so the server's version arrives once nothing waits on it. A save shows from the device at once; the reader then syncs on load, every 5 s while the server is unreachable, and on the browser's `online` event.
  - Deleting a note the server has not acknowledged keeps a delete that carries the unacknowledged save: that save is sent again under its own op id (so a copy that already landed is `already_applied`), and the delete follows with the revision it returned. Dropping it locally instead would let a save already in flight bring the note back.
  - A note over 64 KB is refused in the browser with the server's message, so it never becomes an op the server rejects on every push.
  - A conflict shows both versions with Keep this version, Keep the other version, and Keep both; an edit of a note deleted on another device shows the member's version with Keep my version or Let it go. `kept_incoming` on a note changed again since the conflict becomes `kept_both`, so no saved text is lost; a second resolve answers 409 `conflict_resolved`.
  - Question drafts are kept per member, group and chapter with the clientOpId their post will use, a new one with every edit, so a retried post is recognised and an edited one is not taken for it. They show "Not posted", are posted only by a tap while online, and are removed once posted. A device with no room for the draft still posts.
  - Stopping-point confirmations and playback commands are refused while offline and never queued.
  - Notes the server has never had are not attached to assistant questions.
- **Rejected:** queueing every edit as its own op. Two edits of one note in one push would conflict with each other, and a long offline stretch would grow the queue without bound.
- **Known edge:** a push whose answer is lost while the member edits the same note again can show a conflict between two of the member's own versions. Both are kept, and Keep both resolves it.

### 2026-10-31 — S14: downloads are verified against a server manifest and kept per member in IndexedDB and Cache Storage
- **Context:** S14 lets a member read and hear a chapter with no connection after a full close, with the size shown first, and an interrupted download must never look ready (DOD-23, DOD-24).
- **Chosen:**
  - The server answers `GET /api/content/:t/:b/:c/download-manifest[?narration=true]` with each asset's url, sha256 and length: the chapter JSON, and the first ready recording's `/media/:sha256` file. No recording ready answers 409 `narration_unavailable`, retryable while it is preparing.
  - The browser streams each asset, checks length and sha256, keeps the chapter in IndexedDB (`biblestudy`, keyed by user id) and the audio in Cache Storage `media-v1`, and writes the download record last. A failure or cancel removes what it added, so a partial download is never `ready`.
  - Audio shared by two downloads is kept until neither references it. Removing a download never touches notes.
  - An expired download keeps only its listing: its chapter text and audio are deleted the first time it is seen expired, so licensed text is not kept on the device past the server's limit (I-11).
  - Downloads hold the `media-v1` Web Lock shared and removals hold it exclusive, so shared audio is never removed while a download that relies on it is writing.
  - The service worker caches only the app shell, listed at build time. Offline, the reader falls back to the device copy when the server is unreachable, and plays the narration from a blob URL.
  - The signed-in profile is remembered on the device so the app opens offline; a 401 or signing out forgets it.
  - Install help names Safari's Share → Add to Home Screen on iPhone, and offers Chrome's own prompt (or the menu steps) on Android.
- **Rejected:** caching chapters in the service worker by URL. It cannot tell a member's downloads apart, give a size first, or prove a download is whole.
- **Deferred to S16:** the service worker still takes over open pages at once (`skipWaiting`); S16 makes updates wait for approval.
- **Not performed:** S14.7 needs the owner's real iPhone and Android phone.

### 2026-10-31 — S13: CSB is fetched per chapter from API.Bible by the server; Fair Use is reported by the browser
- **Context:** S13 serves CSB only from API.Bible (I-11), keeps no copy past 14 days, and reports Fair Use as the API terms require, including for displays made offline. No API.Bible key exists yet, so the live call (S13.3) cannot be run.
- **Chosen:**
  - The key stays on the server (`APIBIBLE_KEY`, `APIBIBLE_CSB_BIBLE_ID`, optional `APIBIBLE_BASE_URL`). A chapter is fetched on first read with `content-type=json` and `fums-version=3`, normalized to the same `ChapterContent` as BSB, and stored with `expiresAt = fetchedAt + 14 days` and its Fair Use token.
  - Expired CSB rows are deleted before any refetch, so the 14-day limit holds even when API.Bible is down. A fetch that fails answers 409 `translation_unavailable` with the reason (S13.4), not `upstream_failed`.
  - 401 and 403 both mean "API.Bible rejected the key" (recorded: no key is 401, an unknown key is 403). 404 means the Bible id is wrong or CSB access is not granted; 429 is the request limit.
  - Availability probes `GET /bibles/{id}`; a success stands for an hour and a failure for a minute, so the translations list does not spend the 5,000 monthly calls.
  - A refused key, the request limit or an outage makes the whole Bible unavailable for a minute, and chapter reads are refused without calling API.Bible. A chapter API.Bible lacks fails alone, for a minute.
  - An assistant turn on CSB records the verse numbers it was about, not their text, so no CSB text outlives its 14-day copy in `assistant_turns`.
  - The copyright notice shown under CSB is the one API.Bible sends with the text; it replaces the seeded notice.
  - Fair Use: on each display the browser calls `https://fums.api.bible/f3?t=<token>&dId=<device>&sId=<session>&uId=<sha256 of user id>`, the v3 format in https://docs.api.bible/guides/fair-use. Reports wait in `localStorage` while the call fails and go out on the `online` event, at most 20 tokens per call and 500 held.
- **Rejected:** reporting Fair Use from the server. The call is meant to come from the device that shows the text, and offline displays would never reach the server.
- **Rejected:** parsing API.Bible's HTML content. The JSON form carries verse ids on each text node.
- **Unresolved:** whether a cached token may be reported again (see the contract), and the exact JSON node shape, which the docs do not specify; the parser follows the shape API.Bible's JSON content uses and is checked against the real service once the key exists.

### 2026-10-31 — S12: notes and the solo position sync through one ordered change feed; the display translation lives in the study view
- **Context:** S12 needs private notes and a solo place that no group endpoint can reach (I-21), operations applied once (I-22), and a personal display translation that leaves the group's shared one alone.
- **Chosen:**
  - Notes and the solo position share one `personal_changes` sequence. A push takes a per-user advisory lock, so change numbers rise in commit order and a pull cursor (the highest number seen) never skips a write. Pull reads rows and cursor in one snapshot.
  - Every operation is recorded in `sync_operations` with its outcome; a known `opId` returns the stored outcome without applying again (a conflict comes back as the same conflict, with its id). An `opId` or note id another user owns is refused, never overwritten. A new note saved again after a lost response reuses its note id and `opId`, so it is stored once.
  - An edit that meets a newer version closes the edit form, shows the newer text, and keeps the unsaved edit under it to copy, so a second Save cannot go out on the old revision.
  - An edit applies only on the revision it saw. A stale edit with the same text is treated as applied; with other text it becomes a `note_conflicts` row and the note is unchanged. S12 records conflicts and returns them from pull; choosing between them is S15.
  - The reader restores the saved solo position before it saves any, then saves the place 2 s after the reader stops moving, so scrolling past a chapter writes one row, not dozens. A place still waiting out the delay is saved at once when the page is hidden or the reader closes. A failed first pull is retried every 5 s; a place the reader chooses meanwhile is saved.
  - The solo position is last-arrival-wins and ignores `baseRevision`: it is one place, not text, and the newest place is the useful one. Narration moves it verse by verse, at most one save per 2 s.
  - The personal display translation is chosen in the study view and shown only there and only to that member, labelled "Your display translation"; the group's shared translation is untouched.
  - Notes given to the assistant are chosen from the notes on the passage being read, sent as ids, and resolved on the server from the asker's own live notes; the bodies are stored in the turn's context in the order asked.
- **Rejected:** last-write-wins on note edits. A second device's older edit would silently erase the first.
- **Rejected:** sending note bodies with the assistant turn. The server could not tell a member's own note from text they typed, and I-21 would rest on the client.
- **Rejected:** saving the solo position on every scroll. It floods the push queue once offline saving lands (S15).
- **Left for later:**
  - `sync_operations` is never pruned. S15 decides how long a device can stay offline and prunes past that.
  - A deleted note's text stays in its `note_conflicts` rows and in the stored context of assistant turns it went with. Removing a person's data (S16) removes both.
  - The notes given to one assistant turn are capped by count (20) and size each (64 KB), not in total; a request body is capped at 16 MB.
  - A reload after a conflict replaces the notes with the pulled set even if a save landed meanwhile; S15's offline queue replaces this path.
  - S12.4 checks the display translation choice and the group's shared one; the CSB text itself is checked in S13, when CSB is available.

### 2026-10-31 — S11: reminder deliveries are owed rows, reconciled each minute, and never sent late
- **Context:** S11 needs one email per member, meeting and offset (I-07), nothing for a moved, cancelled or removed case, no duplicate after a crash, and preferences that leave login codes alone (I-08).
- **Chosen:**
  - A minute loop in the app process runs one tick under a transaction-scoped advisory lock: materialize every group's eight weeks, settle deliveries whose email finished, suppress what is no longer owed, insert deliveries for what is owed, and queue what is due. Every step is a query over current state, so a missed or repeated tick changes nothing.
  - Deliveries are inserted for every owed future reminder in the window, not only the ones about to be due, so a move or cancel shows up as suppressed rows.
  - A delivery stays `pending` with its `email_job_id` until the outbox reports `sent` or `failed`. Suppression withdraws a still-queued job in the same transaction and skips one the worker already claimed, which then finishes and is reconciled; the worker re-claims a job stuck in `sending` after 10 minutes, as for login codes.
  - D-2026-10-30-14 stands: a reminder more than 30 minutes past its send time is suppressed, not sent; exactly 30 minutes late is still sent.
  - Planning a passage bumps the revision but moves nothing: a delivery already queued or sent to the member for the same group, offset and send time stands, so the member is not reminded twice. The same rule covers a schedule changed and changed back, which deletes a meeting and makes a new one at the same time.
  - Only live deliveries (pending, sent, failed) count toward I-07's one per revision. A reminder suppressed because the member turned it off, dropped the offset or left the group is owed again if they turn it back on, restore the offset or rejoin before it is due.
  - A schedule change that deletes a meeting suppresses its pending reminders and takes back their queued emails in the same transaction; the delivery rows stay, without the meeting, as the record.
  - Queuing re-checks the meeting under a share lock (still scheduled, same revision, still ahead) and the membership, so a change committed during the tick cannot slip a stale reminder into the outbox.
  - The email names the meeting in the recipient's zone with its abbreviation. Where the runtime gives only `GMT+2`, the en-GB names are used (EET, BST); zones with none keep the offset.
  - Open study links to `/study`, which signs in if needed and lands on the group page with Start study; there is no voice to join (D-2026-10-30-02).
- **Rejected:** creating deliveries only at their send time. A move then leaves no record of what was withdrawn, and S11.4's suppression could not be checked.
- **Rejected:** marking a delivery `sent` when its job is queued. A crash before SMTP would report a reminder that never went.
- **Rejected:** a separate scheduler process or cron. One instance runs everything (D-2026-10-30-05); the advisory lock keeps a second instance from doubling up if one ever runs.

### 2026-10-31 — S10: occurrences keep their schedule slot, are materialized when listed, and convert through Intl
- **Context:** S10 needs meetings correct across both countries' clock changes with no stored offset, a schedule change that leaves members' moves and cancellations alone, and a move that cannot silently overwrite another.
- **Chosen:**
  - Zone math is `Intl.DateTimeFormat` over the runtime's zone data, in `src/shared/zones.ts` so the client converts a move entered in the viewer's zone exactly as the server does. A local time that occurs twice is its first occurrence; one skipped by clocks going forward is read with the offset before the change (02:30 becomes 03:30).
  - Each occurrence keeps its `slot_date` (the schedule date it was made for, unique per group) apart from its `local_date`, so moving one never lets materializing put a second meeting in the slot it left. `moved` marks one a member moved.
  - Listing materializes the eight-week window under a share lock on the group row; a schedule change takes the row's update lock. Materializing on read needs no worker until S11's reminder loop, which will call the same function.
  - A schedule change re-times every future occurrence nobody moved, keeping a cancelled one cancelled, and bumps its revision; a meeting the new time would put in the past is left as it was. A new weekday deletes the not-moved, scheduled, unplanned ones on the old weekday and materializes the new ones; cancelled and planned ones stay where they are, as overrides. S11 must suppress reminders for a deleted occurrence as for a cancelled one.
  - At most one scheduled meeting per group per local date; a move or restore onto a taken day is refused. A move to a time already past is refused.
  - Times show in the member's profile zone with its abbreviation and, when that differs from the group's zone, the time it was set in. Dates are formatted from the wall-clock parts, never through the browser's zone.
- **Rejected:** a materializing timer now. Nothing needs occurrences before someone looks until reminders exist.
- **Rejected:** a third-party zone library. The runtime's zone data is what I-06 names, and it covers both zones' rules.
- **Rejected:** regenerating moved occurrences on a schedule change. S10.3 requires overrides to survive.

### 2026-10-31 — S9: the stopping point is a confirmed chain, and a study resumes at its verse
- **Context:** S9 needs a stopping point that only an explicit confirmation moves, two confirmations at once that do not silently overwrite each other, and carried questions that come back.
- **Chosen:**
  - Each confirmation is a new `group_progress` row naming the one it replaced (`based_on_id`, unique per group). The current stopping point is the chain's tip; a confirmation based on anything else gets `stale_progress` with the current one, which the client shows and lets the member confirm again over. The group row is locked while confirming.
  - A session records the furthest verse reached on its chapter (`reached_verse`), from the narrated verse with verified timing or the marked verse when reading together. Seeking back does not lower it; moving to another chapter starts it over. Wrap-up suggests it, and works after the session ended.
  - A new session opens the stopping point's chapter: narration with verified timing starts at the verse's start, reading together marks the verse. Without verified timing narration can only start at the beginning of the chapter, and the member seeks to the verse.
  - The study shows its chapter's open questions, every carried one, and any posted since it started, so a question asked on one chapter stays in view after the passage moves on. A question on another chapter is shown at once rather than waiting for a verse.
  - Each disposition is kept in `question_dispositions` with the session, and raises the question's version so every client takes it.
  - S9.3's solo position does not exist until S12; group actions write only the session and the confirmed chain.
- **Rejected:** writing the stopping point automatically when a session ends. S9.5 requires an explicit confirmation.
- **Rejected:** last-write-wins confirmation. S9.2 requires the second member to see the first's choice.

### 2026-10-31 — S8: questions are revealed by the verse being read, and a reply does not make the asker's edit stale
- **Context:** S8.3 needs a verse question to appear once the narration reaches it, without pausing and without appearing twice, and S8.4 needs an edit to fail on a post that changed since it was opened.
- **Chosen:**
  - The study client reveals a verse question once the playing verse is at or past its start verse, and keeps it revealed through seeks back. A chapter question, and one's own new question, show at once. Without verified verse timing there is nothing to pace by, so every question shows; narration still being prepared shows only chapter questions until its timing arrives. A new chapter starts the revealed set over.
  - Questions reach the study as part of the snapshot (the session's chapter only) and as `question` messages to the group's active sessions; the client refetches on a chapter change and after its own edits and deletes.
  - Each post has a `revision`; an edit names the one it saw and gets `stale_revision` with the current post otherwise. A reply does not bump its question's revision, so a member answering does not make the asker's pending edit stale. A stale edit keeps the author's draft so they can save it again over the latest.
  - Each question also has a `version`, raised by every change to it or its replies under the question's row lock. The client keeps the higher version of any copy, from a broadcast or a refetch, so an out-of-order broadcast never shows an older reply list. S9's status changes must raise it too.
  - Posting keeps one `clientOpId` per draft, so a retry after a dropped connection returns the first post. A deleted post keeps its row without a body (a tombstone), so a retry that arrives after the delete returns it deleted instead of posting it again; tombstones are not listed, and a removed question with no live replies takes no new ones.
  - Every response is built in the transaction that made the change; the broadcast after commit only logs a failure, since the change itself succeeded.
  - Delete asks for confirmation in the page rather than with `confirm()`, which mobile browsers and automated tests can suppress.
  - The group stopping point is not touched by questions; S9 adds it and its acceptance re-checks S8.1's "unchanged".
- **Rejected:** pausing the narration when a question appears. S8.3 rules it out; any member can pause to discuss (DOD-06).
- **Rejected:** revealing by elapsed time instead of verse. Seeks and rate changes would show questions early or late.

### 2026-10-31 — S7: a one-shot migrate service, an in-stack backup service, and a drill in CI
- **Context:** S7 needs a failed migration to leave the database untouched and the site recoverable, nightly backups the owner has seen restore, and a deploy that costs nothing beyond the VPS.
- **Chosen:**
  - A `migrate` service runs the migrations, each in one transaction; the app and the backup depend on it completing. The app still migrates on start and exits non-zero on failure (S7.4), as a second guard.
  - A failed migration takes the site down until the previous image is redeployed. The drill found that Compose stops the old app before it waits on `migrate`, which the first version of this entry got wrong; the drill now checks that nothing is applied and that redeploying the previous image restores service.
  - A `backup` service from the same image runs `pg_dump` (custom format) daily at `BACKUP_AT` UTC. Recordings are named by SHA-256 and never change, so each is stored once in a shared store and every run's manifest lists the ones it needs. A restore verifies every checksum before touching the database and refuses a database with users unless forced.
  - `scripts/drill-stack.ts` runs the production `compose.yaml` with `stack.env.example` values and synthetic data: build id, service health, down/up persistence, backup, restore into an empty stack, a forced restore over a newer schema, a broken migration, and a broken deploy and its rollback. CI runs it in place of the single-container check.
  - The app and the stack read their placeholders from separate examples (`.env.example`, `stack.env.example`), and the server refuses an `APP_SECRET` or `CONNECTOR_TOKEN` still set to the example's value.
  - `deploy.yml` publishes `:<sha>` and `:latest` on every merge; the Portainer webhook runs only when `DEPLOY_ENABLED` is `true`.
- **Rejected:** keeping the old app up through a failed migration by running migrations outside `up` (a pre-deploy job). A Portainer Git stack has no step before `up`, and the owner's other stacks deploy the same way; a minute's downtime on a failed deploy of a small-group app does not justify a second deploy path.
- **Rejected:** a separate backup image or a host cron job. One image keeps the PostgreSQL client and the app's code at the same version, and the stack carries its own schedule.
- **Rejected:** copying every recording into every run. Media is the bulk of the data and does not change.
- **Rejected:** an off-site backup target in the stack. It needs an account or a paid service; the owner copies the backup folder with the host's own tooling.

### 2026-10-31 — S6: a tool-less Claude behind an outbound connector, one runtime session and workspace per conversation
- **Context:** S6 needs a real Skynet conversation about the passage (DOD-21, DOD-22) without exposing the runtime, its credentials or the owner's PC, and without the model running tools. AgentConsole's `claude` provider does not enforce permission gates on its own, and the `codex` provider currently fails `adapter_schema_mismatch` against this runtime build.
- **Chosen:** the connector (`npm run connector`) runs on the PC, starts AgentConsole over stdio and dials `wss://…/connector` with `CONNECTOR_TOKEN`. The server sends `dispatch`, `interrupt` and `resume`; the connector forwards runtime events with their runtime seq. Only the owner named by `ASSISTANT_OWNER_EMAIL` can see the panel or create turns. Runtime ids, the principal and paths never leave the server (I-25).
- **Chosen:** `claude` is the provider, launched through `src/connector/claude-locked.mjs`, which appends `--tools ""`, `--strict-mcp-config`, `--setting-sources project` and `--disable-slash-commands`. Any `permission.request` is still answered `deny`, the turn interrupted and failed `tool_attempt`. Verified against the real runtime: a prompt asking for a file creates none.
- **Chosen:** each conversation gets its own runtime session and its own empty working directory (`<state>/work/<conversationId>`). The runtime refuses a second live session in one directory (`workspace_busy`), which the real-runtime test found; the fake runtime now refuses it too.
- **Chosen:** runtime turn ids and seqs are unique only within a runtime session, and a lost session is replaced by a new one. So `transcript_entries` is keyed by `(conversation_id, runtime_session_id, runtime_seq)`, and a `position` identity column orders the transcript and is the `afterSeq` cursor. `design/20-contract.md` is updated to match.
- **Chosen:** the panel sits under the reader, for the owner only. It renders the server's transcript, fills streamed text from `/ws` `assistant` events, and on reconnect fetches the entries after its cursor. A retry reuses the `clientTurnId`, so a resend after a dropped response is the same turn.
- **Rejected:** queueing turns while the PC is off. The answer would arrive whenever the PC next woke, unrelated to what the owner was reading; the send is refused with `assistant_offline` instead.
- **Rejected:** the `codex` provider's sandbox as the tool barrier. It does not run against this runtime build; recorded as a limitation, revisit when AgentConsole fixes the adapter.
- **Rejected:** one working directory for all conversations. It allowed only one live session at a time.

### 2026-10-30 — S5: one shared PlaybackState, changed only by revisioned commands
- **Context:** S5 needs every member's phone to play the same narration at the same point, let anyone change it, and survive late joins, dropped connections and server restarts without a client replaying stale changes.
- **Chosen:** the server holds one `study_sessions` row per active session (a partial unique index makes concurrent starts converge on it) carrying the PlaybackState. A command names the revision it saw. `pause` always applies; any other command on a stale revision is `rejected_stale` and answered with the current state. Every command is recorded in `session_commands` by its id, so a resend returns the first outcome. Clients never queue commands: one sent while disconnected is refused in the UI, and a reconnect starts from a snapshot.
- **Chosen:** playing state is an anchor (position, server time, rate); every client derives its target from its estimate of the server clock (the lowest-latency of the last eight pings) and corrects locally: within 40 ms nothing, up to 1 s a ±5 % rate nudge, beyond that a seek. Clients report drift every 5 s once ready; the drift report is the percentiles of those samples.
- **Chosen:** a PlaybackState also carries the chosen `recording` (media URL, duration, timing), so a client needs no second request to play it. A playing session past its range end reads as paused with `range_end`.
- **Chosen:** the starter has no special role. The last connection leaving starts a 20 s grace; then the session pauses with `room_empty`. On start-up the server pauses every playing session at its derived position with `server_restart`. A server shutting down starts no grace timers.
- **Chosen:** with CSB shared, the session is `manual`: no audio, a shared `manualVerse` any member can set, and switching back to BSB starts the narration at that verse. The CSB text falls back to BSB with a notice until S13 licenses it.
- **Chosen:** routes beyond the design: `GET /api/groups/:groupId/session` (the active session, so a client can offer Join) and `GET …/session/:sessionId/drift-report`. The `/ws` upgrade checks `Origin` and allows 8 connections per user.
- **Rejected:** a host or leader client that owns the clock. Its leaving or sleeping phone would stall everyone; the server is the one place that is always up.
- **Rejected:** last-writer-wins without revisions. Two members pressing seek at once would flip everyone between positions; a stale `pause` is the one change safe to apply late.
- **Rejected:** replaying a client's offline commands on reconnect. Its view was stale while offline, so the changes could undo what others did meanwhile.

### 2026-10-30 — S4: the invitation travels with the login code, and removal closes the member's socket
- **Context:** S4.6 needs the invitation to survive the code step, including a reload when the member switches to the mail app, and a code typed on another device. S4.5 needs a removed member's live connection to end at once, not on its next message.
- **Chosen:** the client takes the token from `/join/<token>`, keeps it in memory and `sessionStorage` (`bs_invitation`), and replaces the address with `/` so the token stays out of history. The sign-in step (email, time of request) is kept in `sessionStorage` too, so a reload returns to the code step. The token is sent with both the code request and the verification. The code request stores the invitation's id on the `login_codes` row, without checking it, so a request never reveals whether a link is live; the verification accepts it, which also covers a code typed on a device that never saw the link.
- **Chosen:** an invalid invitation still signs the person in, with no membership, and the app says "This invitation is no longer valid — ask the group's owner for a new link." The brief names Ben; the copy says "the group's owner" so it stays true if the owner changes.
- **Chosen:** acceptance locks the invitation row (`FOR UPDATE`), so two people using one link at once get one membership (I-05). A current member opening a link — the owner checking it, or the invitee twice — joins nothing and leaves the link open for its invitee. A removed member's old membership row is reactivated by a new link, never by the used one.
- **Chosen:** two routes beyond the design: `GET /api/groups` lists the caller's groups so the client can find the group without knowing its id, and `POST /api/invitations/accept` joins a member who opens a link while already signed in, without a new code.
- **Chosen:** `/ws` is protected by the same session hook as `/api/`; an upgrade without a session gets 401. Open sockets are registered by user in a `RealtimeHub`. Removing a member sends `{t:'error', error:'not_member', retryable:false}` and closes each of their sockets with code 4403. v1 has one group, so all of the user's sockets close; the hub keys by user, not by group, until a second group exists. For now the channel answers `ping` with `pong` (server time) and anything else with `invalid_request`; S5 adds the study messages.
- **Chosen:** `OWNER_EMAIL` is optional configuration. Without it no group is created; the first sign-in by that address after it is set bootstraps the group.
- **Rejected:** emailing invitations from the app. Out of scope in v1; the owner sends links themselves.
- **Rejected:** checking the token at the code request and refusing to send a code for a bad link. It would tell anyone with a guessed token whether it is live, and a member with a stale link should still be able to sign in.
- **Rejected:** closing removed members' sockets on their next message. A paused member could keep listening to the live session indefinitely.

### 2026-10-30 — S3: narration is fetched on first use and stored by content hash
- **Context:** AO Lab publishes CC0 recordings for every BSB chapter by three narrators, with per-verse start times. Importing all of them up front is about 3,500 files, most of which nobody will open.
- **Chosen:** `import-content --audio ROM:1-16` imports a scope ahead of time. Any other chapter is fetched the first time a member opens its player. The recordings endpoint answers 202 with the same body as 200: what is stored, what is `preparing` and what `failed`. An `audio_jobs` row tracks each fetch. A background worker retries a 5xx or network failure after 1, 5, 15 and 60 minutes, the same schedule as email. A 404 fails at once. A failed job is reported for an hour, and the next request after that queues it again. Each job writes its own manifest, so on-demand fetches are audited like imports.
- **Chosen:** files are stored as `<sha256>.mp3` in `MEDIA_DIR` and served from `/media/<sha256>` with range requests, `ETag` = the hash, and `Cache-Control: private, max-age=31536000, immutable`. The route needs a session, like the text.
- **Chosen:** timing is validated on import: one start per verse, strictly increasing, inside the recording's duration (read from the MP3 frames). A timing file that is missing is `absent`; one that fails validation is `rejected` with its reason. Both play the whole chapter without the highlight and without range play.
- **Chosen:** `david` is seeded disabled and is refused before any download. Only enabled narrators are listed or queued.
- **Chosen:** CSB has no narration. Its availability reason is 'No CSB narration is licensed.', and no BSB recording is offered while CSB is displayed.
- **Chosen:** a range play pauses where the next verse starts and keeps the last verse of the range highlighted. Seeking out of the range ends it.
- **Rejected:** importing every recording at deploy time. Several gigabytes on the VPS for chapters that may never be played.
- **Rejected:** proxying AO Lab's audio per request. Every play would depend on their CDN, and offline download (S14) needs files we hold.
- **Rejected:** a public, unauthenticated `/media/` route. The recordings are CC0, but the service is for members, and one rule for every route is simpler to check.

### 2026-10-30 — S2: chapter text is stored as the exact JSON it is served as
- **Context:** I-10 says `contentSha256` hashes the stored content. Postgres `jsonb` reorders keys and normalises whitespace, so a hash of the input would not match what a later read returns.
- **Chosen:** `chapters.content` is `text` holding canonical JSON (`verses`, `headings`, `footnotes`, keys in a fixed order). The chapter endpoint splices those bytes into the response unchanged, and its ETag is the hash, so an unchanged chapter costs a 304. The import writes a row only when the hash differs (`ON CONFLICT … WHERE content_sha256 <> excluded.content_sha256`), which is how a re-run changes no rows.
- **Chosen:** AO Lab's structure is flattened on import. A verse is one string. Poetry lines are separated by newlines and shown with `white-space: pre-line`. Section headings and Psalm superscriptions become `headings` keyed to the verse they precede. Footnote markers are dropped from the text and footnotes are listed per verse. Footnotes attached to a whole chapter are dropped. A chapter whose verse count disagrees with the source's `numberOfVerses` fails alone; the run is then `partial`.
- **Chosen:** browser tests use the `playwright` library under `node:test`, the same runner as every other suite, against the real server and the built client.
- **Hardening from review:**
  - **Joining text pieces.** AO Lab splits text at footnote markers and the pieces carry no edge whitespace. A piece that opens with closing punctuation therefore attaches to the text before it, so Revelation 1:8 reads `Omega,” says`, not `Omega, ” says`. Any other two prose pieces get a single space between them.
  - **Edition.** The translation's `edition` is set only after a whole-translation import succeeds.
  - **Failed runs.** A run that throws part-way marks its manifest `failed` with the reason.
  - **Empty book lists.** An empty `--books` list is refused.
  - **One-chapter books.** In a one-chapter book a lone number past 1 is a verse: `Jude 5` means Jude 1:5.
  - **Verse limit.** References accept verses up to 176, the length of Psalm 119. A verse past the chapter's end tells the reader how many verses the chapter has.
  - **ETag for cached text.** When cached text carries an expiry, the ETag includes it.
- **Rejected:** `jsonb` content with a hash of `content::text`. That hash would change with Postgres's serialisation, not with the text.
- **Rejected:** `@playwright/test`. A second runner and config for five tests.

### 2026-10-30 — S1: email-job secrets are sealed, and every server key derives from one APP_SECRET
- **Context:** the outbox stores rendered mail before the worker sends it. A login code in plain text in `email_jobs` would let anyone with a database dump sign in as that member for ten minutes.
- **Chosen:** the job row carries `{{code}}` placeholders and a `sealed_secrets` column (AES-256-GCM). The worker fills the placeholders at send time and nulls the column when the job reaches `sent` or `failed`. This adds an optional `secrets` field to the contract's `enqueueEmail` input. The sealing key and the login-code pepper are HKDF-SHA256 derivations of `APP_SECRET` with distinct purposes, so deployment has one secret to keep. `GET /__build-id` returns `{"buildId": …}` as JSON, so the update check (S14) and the CI container probe parse one shape.
- **Differs from the contract:** I-01 and S1.1 say the raw code is never stored. Until the job is sent or failed (at most ten minutes), the code exists in the database encrypted under a key that is not in the database. Only its hash outlives delivery.
- **Hardening from review:** protected routes are decided on the matched route, not the raw URL, so percent-encoded paths cannot skip authentication. `TRUST_PROXY` takes a hop count or proxy addresses and refuses `true`, so clients cannot choose their own rate-limit address. Bare UTC offsets are refused as time zones and zone names are stored in canonical spelling. SMTP connections time out after 15 seconds. The per-IP code limit is serialised with its own advisory lock. `GET /api/auth/code-status` stays unthrottled: it reveals only delivery state for an address someone already typed, not whether an account exists.
- **Rejected:** plain-text bodies in the outbox. A backup would leak live codes.
- **Rejected:** separate `SEAL_KEY` and `CODE_PEPPER` variables. More secrets to rotate, with no isolation gain on a single instance.
- **Rejected:** a plain-text build id. The client would parse two formats.

## D-2026-10-30-17 — CI runs a repository text check before any language exists
- **Context:** the kit's merge tool refuses pull requests that have no checks (`NoChecksConfigured`). Before this, the repository had only Markdown.
- **Chosen:** a CI job that runs on every pull request, with no paths filter, and checks that tracked text is UTF-8 with LF endings and a final newline, and that relative Markdown links resolve. Language gates are added to the same job when code arrives.
- **Rejected:** a placeholder job that always passes. It proves nothing.
- **Rejected:** waiting for code before merging the brief. The brief would have blocked on implementation.

## D-2026-10-30-16 — Delivery re-estimate
- **Context:** the brief marks the original 2 November 2026 demo target as superseded by the expanded scope.
- **Chosen:**
  - The **narrow path** is built first. It covers sign-in by emailed code, one group, shared BSB narration with verse following, questions during the week, and the confirmed stopping point.
  - The solo and assistant path follows, then offline downloads and sync, then phone hardening.
  - Expected time to the full v1 definition of done is about three to four weeks of build sessions. The owner-side steps run in parallel and their wait is not counted:
    - the DNS record and proxy route;
    - the Gmail app password;
    - API.Bible access for CSB;
    - device testing.
  - The 2 November 2026 date is not achievable for the full scope. The narrow path is the first demoable milestone.
- **Rejected:** keeping 2 November by cutting the definition of done silently.

## D-2026-10-30-15 — Gaps the brief left, resolved as design assumptions
- **Context:** `/brief` found underspecified points and unstated environment facts. The owner asked for routine choices to be resolved without repeated questions.
- **Chosen:**
  - **Implied non-goals for v1:** push notifications, more than one group in the UI, self-service account deletion (the owner removes members; personal export exists), localization (English only), moderation tools and analytics.
  - **Backups:**
    - a nightly `pg_dump` and a media-volume manifest written to a backup volume on the VPS, keeping 14 days;
    - a restore drill is a planned slice, with its result reported.
  - **Uptime:** best effort on the VPS, with no paging. The owner's status page shows failed email jobs and the connector state.
  - **Cost ceiling:** $0 recurring. Every external service used is on a free tier the owner already has or creates themselves.
  - **Resume (DOD-21):** reopening the assistant, or reconnecting it, continues the stored transcript from its last runtime sequence number.
- **Rejected:** asking the owner each point separately. They are routine and reversible.

## D-2026-10-30-14 — Reminder timing rules
- **Context:** DOD-04 needs correct local times across clock changes, and no duplicates.
- **Chosen:**
  - Reminders are computed from each Occurrence's derived instant. One delivery row exists per occurrence revision, member and offset.
  - Moved or cancelled occurrences suppress older rows.
  - A reminder whose send time passed more than 30 minutes ago is suppressed, not sent late.
  - Reminders link to the study page, which has no voice to join.
- **Rejected:** cron-style schedules per user. They duplicate the zone math and drift across clock changes.
- **Rejected:** sending missed reminders late. After downtime, a "starts in 1 hour" email that arrives after the start is misleading.

## D-2026-10-30-13 — One container serves the app, API and WebSocket
- **Context:** Adventures serves its frontend from a separate nginx container.
- **Chosen:** the Node service serves the built app on the same origin as the API, WebSocket and media.
- **Rejected:** a separate static container. It gives no benefit at this scale, and it adds cross-origin cookie and WebSocket configuration.

## D-2026-10-30-12 — The Skynet connector runs on the owner's PC and dials out
- **Context:**
  - AgentConsole runs on the owner's PC, uses the PC's model CLIs, and speaks JSON-RPC over stdio.
  - DOD-21 and DOD-22 need a real conversation without tools and without exposing the runtime.
- **Chosen:**
  - A connector process on the PC starts AgentConsole and opens an authenticated outbound WebSocket to the server, using `CONNECTOR_TOKEN`.
  - The server relays turns only for `ASSISTANT_OWNER_EMAIL`.
  - Sessions use an opaque principal, a dedicated empty working directory, and the most restrictive sandbox the provider offers.
  - Every permission request is denied, and a tool attempt fails the turn.
  - Turns are keyed by a client turn id and never resent. Transcript entries are unique by runtime sequence number.
- **Rejected:** running AgentConsole on the VPS. The CLIs and subscriptions are on the PC.
- **Rejected:** a tunnel into the PC. It opens an inbound path to a development machine.
- **Rejected:** a separate model API key. The brief assumes none.

## D-2026-10-30-11 — Implementation stack
- **Context:** the brief lists the handoff's stack as a proposal.
- **Chosen:**
  - TypeScript throughout.
  - Node 24 for the server, with HTTP and one WebSocket endpoint.
  - PostgreSQL 17.
  - React with Vite for the installable web app.
  - A hand-written service worker and IndexedDB layer following the Adventures patterns.
  - An open-source SMTP library for mail.
- **Rejected:** a framework with server rendering. The app is a single-origin installable client; server rendering adds nothing offline.
- **Rejected:** SQLite. The concurrent writers are the realtime channel, the reminder tick and the mail worker. Advisory locks and `SKIP LOCKED` cover them directly.

## D-2026-10-30-10 — Scope of sync conflicts
- **Context:** DOD-26 asks that conflicting versions are kept for the user to choose. The brief leaves the scope open.
- **Chosen:**
  - Conflicts are kept for note bodies only.
  - Solo position takes the last write the server receives: it is a pointer, not something a user would merge.
  - Question drafts never sync: they are device-local until published.
  - Group commands and stopping points are never queued offline.
- **Rejected:** conflict choice for every personal field. That produces prompts about bookmarks no one would understand.

## D-2026-10-30-09 — Invitations are single-use links
- **Context:** the brief does not say whether an invitation link is reusable.
- **Chosen:** each link creates one membership and expires after 14 days. The owner can list and revoke links. The app never emails invitations; the owner sends the link themselves.
- **Rejected:** a reusable group link. A forwarded link would admit anyone.
- **Rejected:** emailing invitations from the app. The brief forbids sending real invitations to prepare the demo, and owner-sent links avoid it entirely.

## D-2026-10-30-08 — Sign-in by emailed code with server sessions
- **Context:** DOD-01.
- **Chosen:**
  - A 6-digit code, valid for 10 minutes, dead after 5 wrong tries, stored only as a hash.
  - A sliding 90-day session in an HttpOnly cookie.
  - The invitation token is carried through sign-in.
- **Rejected:** magic links. On iPhone they open in Safari, not the installed app.
- **Rejected:** JWTs. They cannot be revoked without a lookup.

## D-2026-10-30-07 — Email through a configurable SMTP relay, free by default
- **Context:**
  - The owner refused paid email: "there are plenty of free tools for sending email, find one, open source or something".
  - Login codes need reliable delivery to ordinary inboxes.
- **Chosen:**
  - The app sends through an open-source SMTP library to whatever `SMTP_URL` names.
  - **Default:** the owner's existing Gmail account with an app password. It is free, needs no new account, allows about 500 messages a day, and has Gmail's deliverability.
  - **Supported alternative:** a self-hosted open-source Postfix container in the stack, signing DKIM. It needs outbound port 25 from the VPS plus SPF, DKIM, DMARC and reverse-DNS records.
  - Development uses Mailpit (open source) to capture mail.
- **Rejected:** commercial sending APIs. They need a new account and their free tiers change.
- **Rejected as the default:** self-hosted direct delivery. A new VPS address is often filtered as spam and port 25 is often blocked. It remains a configuration choice.

## D-2026-10-30-06 — Narrators are enabled only with a recorded license
- **Context:**
  - The brief says the publisher identifies the Souer, Hays and Gilbert recordings as CC0.
  - The AO Lab API names its narrators `souer`, `hays` and `david`.
- **Chosen:**
  - `souer` and `hays` are enabled with the license source recorded at import.
  - `david` stays disabled until the import confirms it is the Gilbert recording and records the license source.
- **Rejected:** enabling all three on assumption. DOD-14 requires recorded recording rights.

## D-2026-10-30-05 — Content is imported into our storage, one instance, data keyed by group
- **Context:** premise 4, agreed by the owner.
- **Chosen:**
  - **Text:** BSB text from the AO Lab Free Use Bible API is imported in full with checksums and the source version.
  - **Audio:** imported per chapter (Romans at setup, other chapters on first request), with verse timing validated before use.
  - **Clients:** read only from our origin.
  - **Deployment:** one deployment serves one group, and every group-scoped row carries a group id.
- **Rejected:** clients calling AO Lab directly. The audio host sends no CORS headers, and upstream changes would alter displayed text.
- **Rejected:** multi-tenant deployment now. It is not needed for one group, and the group id keeps the door open.

## D-2026-10-30-04 — CSB text from API.Bible's free Starter plan
- **Context:**
  - CSB must be selectable (DOD-12).
  - The owner refused to pay for a text licence.
  - API.Bible's Starter plan is $0 for noncommercial use, with up to 3 licensed Bibles and 5,000 calls a month. CSB is in its catalogue.
- **Chosen:**
  - The owner creates the API.Bible account and requests CSB.
  - The server fetches CSB chapters with the key and caches each chapter for at most 14 days.
  - Clients report Fair Use as required, and show the copyright notice.
  - CSB narration is reported unavailable.
  - Until a key is configured, CSB is selectable and says it is not available from a licensed source.
- **Rejected:** copying text from read.csbible.com. It is not licensed.
- **Rejected:** dropping CSB. It is required.
- **Rejected:** a paid licence. The owner declined.

## D-2026-10-30-03 — Shared narration is one server-hosted file played on every device
- **Context:** premise 2, agreed by the owner.
- **Chosen:**
  - Each device plays the same recording, aligned to server time through one revisioned playback state per session.
  - Pause is always applied; other commands need the current revision.
  - Drift is corrected toward a 500 ms target and reported.
- **Rejected:** streaming one device's audio to the others. It needs a media server and creates a host.
- **Rejected:** synthesizing speech locally. That is a non-goal.

## D-2026-10-30-02 — Built-in group voice is dropped from v1
- **Context:** at the approach step the owner said: "Drop the audio for now, i have a different solution that does not need to be put in the first version, otherwise use my VPS."
- **Chosen:**
  - v1 has no built-in voice.
  - DOD-08, the voice-room parts of DOD-07 and DOD-11, and microphone checks in DOD-29 move out of v1.
  - Narration autoplay, lock and foreground recovery, and headphones checks in DOD-29 stay.
  - The group keeps talking on its existing call while the app synchronizes the passage and narration.
- **Rejected:** LiveKit Cloud's free tier, and self-hosted voice with TURN. The owner has a different solution for later.

## D-2026-10-30-01 — Hosted on the owner's VPS as a container stack
- **Context:** premise 1, agreed by the owner. The app must work with the owner's PC off.
- **Chosen:**
  - A Portainer Git stack on the existing VPS: the app container, PostgreSQL and the media volume.
  - Images go to GHCR from GitHub Actions, with a redeploy webhook — the Adventures pipeline.
  - The existing reverse proxy terminates TLS on a `subzerodev.com` hostname.
- **Rejected:** a managed platform. It means a new account, and possibly cost.
- **Rejected:** hosting on the PC. The app would stop when the PC is off.
