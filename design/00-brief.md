# Brief — SubZeroDev.BibleStudy

> The problem, the non-goals and the definition of done are mine. A model may interrogate this
> file (`/brief`) or type it from my answers (`/interview`). It may not originate it from an idea.

**Source.** Imported on 2026-10-30 from the maintained product brief and implementation handoff (updated 2026-10-30) and its originating conversation, both in the private Notes repository: [implementation handoff](https://github.com/The-Running-Dev/Notes/blob/main/SubZeroDev.BibleStudy/2026-10-27-bible-study-implementation-handoff.md) and [original conversation](https://github.com/The-Running-Dev/Notes/blob/main/SubZeroDev.BibleStudy/2026-10-27-bible-study-full-conversation.md) (maintainer access only). Where the two differ, the handoff wins. Everything below that is not marked `Assumed:` or `Open:` was confirmed by the owner in those documents. The handoff's technology choices (stack, voice provider, content API) were proposals, so they appear here only as assumptions for `/design` to evaluate.

## Problem

A small group (Ben, Ethan and Sandra) studies the Bible together over a phone call: someone reads a passage aloud, they discuss it, and where they stopped, what they asked and what they meant to come back to lives nowhere. Missing a call means missing the study entirely.

The group wants one place where the study happens:

- **Study together** inside the app — built-in group voice, the passage on screen, one shared recorded narration everyone hears at the same point, and anyone able to pause to discuss.
- **Prepare between meetings** — anyone reads or listens ahead and posts questions anchored to verses; others see and reply during the week; those questions come up as the group reaches their verses.
- **Keep the group's place** — an explicitly confirmed stopping point that resuming returns to, separate from anyone's browsing or reading ahead.
- **Study alone** — read or listen independently with private notes and progress, and discuss the passage with an LLM through the owner's existing Skynet AgentConsole runtime, inside the app.
- **Use it on phones as a real app** — installable to the home screen, usable on mobile layouts, with explicitly downloaded chapters and personal saves available offline.

The same group model should later serve church study groups; this version serves the one private group.

## What we do instead today (and what it costs)

A Signal call: members take turns reading verses aloud, then discuss. Progress, questions and discussion are not recorded, and a member who misses the call (for example with a phone switched off) misses the study.

## Who it is for

- The first private group: Ben (owner) and two members, Ethan and Sandra. Non-technical use on desktop and phone browsers.
- Members live in different time zones (`Europe/Sofia` and `America/Chicago`).
- Solo study with the LLM is for the owner's authenticated personal use first; general church-user LLM access is outside this version.
- Later audience (not this version): church study groups.

## Non-goals

Ruled out for the initial implementation by the source documents:

- Meeting-time proposals and voting through the owner's game engine (later; the engine is not yet identified).
- Evaluating or integrating the text-to-speech project the owner will supply (later; repository not yet provided).
- A specialized local Bible-study AI for historical context and alternative interpretations (later; model, sources and approach unchosen).
- LLM participation in group sessions; spoken input or spoken responses for the solo assistant.
- Native app-store builds, video, live-call recording, automatic meeting transcription, background incoming-call behaviour.
- A general church management system: organisation roles, group discovery, large rooms, multi-session reading plans, public accounts.
- An AI-generated commentary library or a theological assessment system.
- Automatic pause on detected speech.
- An offline copy of the group's shared discussion; offline shared controls or offline question publishing.
- Anonymous guest access.
- Using independently synthesized speech on each device as the group narration mechanism.
- Sending real invitations or reminder emails to group members merely to prepare or demo the app.
- Purchasing services or enabling paid plans without the owner's authorization.

P1 (after both study paths work, not required initially): side-by-side translation comparison, calendar export, shared phrase highlights, additional narrators.

## Definition of done

Each statement is checked with real evidence; mocks do not establish voice, drift, delivery, mobile or LLM outcomes.

**Accounts and schedule**
- DOD-01 Each member signs in by entering an email address and a one-time code actually delivered by email; no password. Expired and reused codes fail. An invitation survives sign-in and opens the right group. Identity and history survive signing in on another device.
- DOD-02 Profiles hold a display name, email address and named time zone.
- DOD-03 The group meets weekly on Monday at 06:15 `America/Chicago` wall time. Each member sees each occurrence in their own profile zone, correct across both regions' clock changes (the 2 November 2026 occurrence shows 14:15 in `Europe/Sofia`); no fixed offset is stored.
- DOD-04 Reminder emails go out 24 hours and 1 hour before each occurrence by default, showing the recipient's local date, time and zone, the planned passage, and an Open study link that does not auto-join voice. Each user can change the timings or turn study reminders off without affecting other users or login codes. Changed or cancelled occurrences suppress obsolete reminders; retries never send duplicates.

**Group membership and control**
- DOD-05 The owner creates the private group and invites members by private invitation link; only the owner can revoke invitations or remove members.
- DOD-06 Any member — with the owner offline — can start or resume a study, play, pause, seek and replay, change the passage, shared translation, narrator or rate, confirm group progress, and end the session. No host handoff exists.
- DOD-07 A nonmember cannot issue group controls or obtain voice-room access; a member cannot change owner-only settings or reach another user's private notes, solo conversations, runtime paths or principals.

**Study together**
- DOD-08 Three separately signed-in members hear each other through built-in voice across at least two networks, with no other calling app; mute, leave, participant status and reconnect work.
- DOD-09 One shared narration plays for the room: any member's play, pause or seek reaches everyone; the pausing member is shown. Steady-playback drift between ready clients is measured and reported against a 500 ms target.
- DOD-10 Narration highlights the active verse where verified verse timing exists; selected-range playback stops at the range end. Where timing is missing, chapter playback still works and the absence of verse following is stated; timing is never fabricated.
- DOD-11 Late join, refresh and temporary network loss recover current state without replaying stale commands; any member leaving (including whoever started) leaves the session and controls with the rest; narration pauses when the room empties; after a backend restart the session recovers paused.

**Scripture and navigation**
- DOD-12 BSB is the default shared translation; CSB is selectable. Any member can change the shared translation; a personal display translation differs only for that member and is labelled. Narration availability per translation and chapter is reported accurately (missing CSB audio shown as missing; a BSB recording is never labelled CSB).
- DOD-13 Initial setup opens Romans 1. Book and chapter selectors, jump to verse, reference entry (e.g. "Romans 3:12"), previous/next chapter, an always-visible current reference, and Resume study work on phone and desktop; Romans 2–3 are validated.
- DOD-14 Source integrity: exact editions, recording rights, narrator, verse-timing coverage and asset checksums are recorded; displayed text matches the imported or fetched source.

**Questions and progress**
- DOD-15 During the week a member reads or listens ahead and posts verse, range or chapter questions; another member sees and replies without joining voice; the group's stopping point is unchanged.
- DOD-16 During playback, questions appear as their verses are reached without pausing; range and chapter questions stay discoverable; replay or reload never duplicates them; the full list stays available.
- DOD-17 At wrap-up each open question can be marked Close, Carry forward, Resolved or No longer relevant; carried questions reappear next session with their original anchors and replies.
- DOD-18 Authors edit their own questions and replies with an edited label; a post without replies can be deleted; removing a post with replies removes only its body and keeps the replies and structure.
- DOD-19 Wrap-up suggests the last verse reached; any member adjusts and confirms it as the group's stopping point; Resume study returns there next time. Browsing, seeking and preparation never change it, and never change anyone's solo progress.

**Solo study and LLM**
- DOD-20 Solo mode works without a group, voice room or LLM, with its own bookmark, reading, narration, notes and history kept separate from group history.
- DOD-21 A real Skynet AgentConsole turn receives the selected passage context (translation, reference, exact verse text, chosen notes), streams into the app, stops on request, and resumes without duplicate transcript entries. If Skynet is unreachable, reading and narration still work and the assistant shows its real status.
- DOD-22 The study assistant cannot execute filesystem or shell tools, is isolated from the owner's development sessions, and an uncertain send never submits a question twice.

**Phone, install and offline**
- DOD-23 Installs and launches as a standalone home-screen app on a real iPhone (Safari) and a real Android phone (Chrome), with in-app installation help for both; installed-versus-browser login and storage behaviour is recorded. Installing is optional for joining.
- DOD-24 Selected chapters download explicitly (text only, or text plus available narration and timing, with size shown first). After a full close with networking blocked, the installed app cold-starts and downloaded chapters read and play. Incomplete downloads never claim readiness; unavailable chapters say what is missing.
- DOD-25 Personal notes, solo position and verse-anchored question drafts are saved on the device, are shown as saved only after the save commits, and survive an offline restart. Offline drafts are visibly unposted; publishing needs a connection and an explicit action.
- DOD-26 On reconnect, personal state syncs without duplicates and conflicting versions are kept for the user to choose; offline group commands and bookmark changes are never replayed.
- DOD-27 A failed or over-quota save keeps the previous save; removing downloads keeps notes; logout or account switching hides that account's local records in every open window; personal export works; an approved update keeps data and is deferred during a live session, entry or with multiple windows open.
- DOD-28 Reader, controls, questions, downloads and install help work at 320 and 360 CSS pixel widths, portrait and landscape, with larger text, safe areas and the on-screen keyboard open; no horizontal page scroll; the composer's send/save stays reachable.
- DOD-29 Mobile audio on the tested devices: microphone permission, autoplay handling, speaker echo, headphones/Bluetooth, and lock/foreground recovery are recorded.

**Delivery**
- DOD-30 Delivered with setup, environment-variable names without secrets, migrations, pinned content and import manifests, demo preparation, deployment and mobile-installation instructions, actual test results, unperformed checks, and remaining limitations.

## Narrowest useful version

The three members studying one chapter together: signed in by emailed code, in one room with built-in voice, hearing the same BSB narration with verse highlighting, anyone pausing, questions posted during the week coming up at their verses, and the confirmed stopping point there next Monday. Solo study with one real Skynet conversation is the second complete path the first version also needs.

## Environment

- **Platform:** a web application usable in desktop and phone browsers and installable as a standalone home-screen PWA (iPhone/iPad Safari, Android Chrome; desktop where offered). Responsive phone, tablet and desktop layouts. No native app-store build.
- **Scale:** one private group of three; one active study session per group; small audio-only rooms.
- **Network:** live study, shared controls, question publishing, sign-in, synchronization and the LLM need connectivity. Explicitly downloaded chapters, downloaded narration for solo listening, and personal notes, position and question drafts work offline.
- **Time zones:** members in `Europe/Sofia` and `America/Chicago`; the meeting is anchored to `America/Chicago`.
- **Content:** Berean Standard Bible (BSB) text is dedicated to the public domain by its publisher, and its publisher identifies the Souer, Hays and Gilbert recordings as CC0. CSB (the owner's preferred translation, as at read.csbible.com) must be selectable; its text source, edition, terms and narration are unverified.
- **LLM:** the owner's existing Skynet AgentConsole runtime ([SubZeroDev.SkyNetHR](https://github.com/The-Running-Dev/SubZeroDev.SkyNetHR)), reached only through the server. Its credentials and runtime capabilities never reach the browser. No new model subscription or key is assumed.
- **Email:** an email sender is required for login codes and reminders.
- **Reference implementation:** the PWA installation, service-worker, IndexedDB download, save, recovery and update patterns in [SubZeroDev.Adventures](https://github.com/The-Running-Dev/SubZeroDev.Adventures) are to be reused where suitable, without its game engine.
- **Repository:** public. No credentials, real participant account data, private conversations or private Skynet material are committed; fixtures are synthetic and `.env.example` holds placeholders.

## Lifespan

Maintained: the first group uses it weekly, and the same model is meant to grow toward church study groups.

## Assumptions and open questions

- Assumed: the handoff's proposed stack (React, TypeScript and Vite PWA; Node and TypeScript server with WebSockets; PostgreSQL; LiveKit voice; static/object storage for content) is a starting proposal for `/design`, not a requirement.
- Assumed: AO Lab's Free Use Bible API is the proposed BSB text, audio and verse-timing source, subject to a live check of edition, narrators, timing coverage, seeking and CORS.
- Assumed: the handoff's offline contract (Downloading / Ready on this device / Failed / Remove; Saving / Saved on this device / Pending sync / Synced / Save failed; account-scoped local records; stable operation IDs and revisions for sync; conflicts kept for the user to choose) is the starting design for the offline requirement.
- Assumed: the playback-state contract in the handoff (one authoritative revisioned state per session, commands with IDs and expected revisions, server-time anchoring, pause always applied) is the starting design for shared narration.
- Assumed: a member may read the passage aloud when no verified narration exists for the shared translation; a manual shared verse marker is proposed for that case.
- Assumed: questions belong to the group and passage (with optional session links), so they survive cancellation, passage changes and repeated sessions.
- Assumed: private notes stay private unless explicitly shared; solo conversations are never shared.
- Assumed: if the runtime cannot enforce a text-only, no-tools policy, the assistant stays limited to the owner's personal use until it can.
- Assumed: the group's real current position (around Romans 2 or 3) is set during rehearsal setup by changing the passage; the app never marks a chapter studied on setup.
- Open: CSB text access — which source, edition and caching/offline terms are usable, and whether any CSB narration with verse timing exists. Affects DOD-12, DOD-14 and DOD-24; CSB stays required and selectable either way.
- Open: where the reviewable demo is hosted and which email sender and voice deployment are used, within no new paid plan unless authorized. Affects DOD-01, DOD-04, DOD-08 and DOD-30.
- Open: which real phones and browsers are used for device testing. Affects DOD-23, DOD-28 and DOD-29.
- Open: the original 2 November 2026 demo target predates the expanded scope and is not a commitment; delivery must be re-estimated.
