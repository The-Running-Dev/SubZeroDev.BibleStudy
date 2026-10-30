# Decision log

Append-only. Newest at the top. The rejected alternatives are the point — without them, every future session relitigates the same choice.

## Open
- Which real phones run the device checks (DOD-23, DOD-28, DOD-29).
- Whether `biblestudy.subzerodev.com` is the hostname, and who adds its DNS record and proxy route.

---

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
