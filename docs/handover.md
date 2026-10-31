# Handover

What v1 does, how each requirement in [design/00-brief.md](../design/00-brief.md) was checked, which checks were not performed and why, and what is still limited. Setup, import, the demo and phone install are in the [README](../README.md); the VPS is in [deploy.md](deploy.md).

## Test results

From the CI run on `1ba12c8`, the S18 pull request tested merged with main ([run 41247294152](https://github.com/The-Running-Dev/SubZeroDev.BibleStudy/actions/runs/41247294152)):

| Gate | Result |
|---|---|
| Typecheck (`tsc`) | pass |
| Lint (`eslint --max-warnings 0`) | pass, 0 warnings |
| Docs check | 198 tracked files, 0 problems |
| Unit (`npm test`) | 149 pass, 0 fail |
| Integration against Postgres 17 and Mailpit | 175 pass, 0 fail |
| Browser (Playwright, Chromium at phone size) | 77 pass, 0 fail |
| Stack drill (`npm run drill`) | 9 of 9 checks pass: build id, healthy services, data surviving restart, backup, restore, refused and forced restore, failed migration and rollback |

Run once on the owner's PC, not in CI:

- the assistant against the real AgentConsole runtime and Claude (`tests/integration/assistant-runtime.test.ts`): passed in S6, a 14 s turn, and no tool ran;
- shared narration drift, three clients on one machine for 120 s: 72 samples, p50 27.5 ms, p95 36.8 ms, max 40.8 ms against the 500 ms target (S5).

## Imported content

The setup check from a clean clone on 31 October 2026 recorded these imports in `import_manifests`:

| Manifest | Scope | Result |
|---|---|---|
| `01a193fb-3af7-7969-914d-78b974d7c50f` | BSB text, all 66 books | succeeded: 1,189 chapters inserted, 0 failed |
| `01a193fb-7e81-78d6-aff7-a5a7d52e537c` | BSB narration, Romans 1, narrators Hays and Souer | succeeded: 2 recordings inserted, 0 failed |

These ids belong to that check's throwaway database. Each new database gets its own.

Each run records the source edition, every chapter's SHA-256 and every recording's checksum, narrator and timing status. A later run lists only what changed. On the VPS, run the same imports and keep their ids with the deployment notes: `SELECT id, status, scope, finished_at FROM import_manifests ORDER BY started_at`.

## Requirements and their evidence

"Automated" means a test in this repository that CI runs. "Not performed" means the code is in place but the check needs something only the owner can provide.

| Item | Status | Evidence |
|---|---|---|
| DOD-01 Sign-in by emailed code | Automated; real inbox not performed | S1.1–S1.8 integration and e2e against Mailpit; S4.6 invitation survives the code step. S1.11 (a code reaching a real inbox) needs the owner's `SMTP_URL` relay. |
| DOD-02 Profile | Automated | S1.7: display name, email, validated zone. |
| DOD-03 Weekly meeting in each zone | Automated | S10.1–S10.5, including 2 November 2026 at 14:15 Sofia and both regions' clock changes. |
| DOD-04 Reminders | Automated against Mailpit; real delivery not performed | S11.1–S11.7: default 24 h and 1 h, per-user timing and off, moved and cancelled occurrences, downtime, at most one send. Real delivery needs `SMTP_URL`. |
| DOD-05 Group and invitations | Automated | S4.1–S4.5. |
| DOD-06 Any member controls the study | Automated | S5.1–S5.9 over three browser clients; no host. |
| DOD-07 Access rules | Automated; voice part out of v1 | S4.4, S4.5, S5.10, S6.7, S6.8, S12.3. |
| DOD-08 Built-in voice | Out of v1 | Dropped by the owner (D-2026-10-30-02). The group talks over its usual call while the app keeps everyone on the same verse. |
| DOD-09 One shared narration | Automated on one machine; across networks not performed | S5.4–S5.5: pause reaches others in 30 ms, drift p95 36.8 ms. Clients on different networks need the deployed app and the owner's phones. |
| DOD-10 Verse highlight and ranges | Automated | S3.2, S3.4–S3.6: timing verified at import, never invented. |
| DOD-11 Late join, loss and restart | Automated; voice part out of v1 | S5.6–S5.8. |
| DOD-12 BSB and CSB | Automated without a key; CSB with a key not performed | S2.7, S3.8, S12.4, S13.1, S13.2, S13.4–S13.6. S13.3 (CSB text from API.Bible) needs the owner's free key with CSB access. |
| DOD-13 Navigation | Automated | S2.4–S2.6; Romans 2–3 and the Romans 16 → 1 Corinthians 1 step. |
| DOD-14 Source integrity | Automated | S2.2, S3.3; `import_manifests` above. |
| DOD-15 Questions during the week | Automated | S8.1, S8.2. |
| DOD-16 Questions during playback | Automated | S8.3, S8.6. |
| DOD-17 Wrap-up of questions | Automated | S9.4. |
| DOD-18 Editing and deleting posts | Automated | S8.4, S8.5. |
| DOD-19 Stopping point | Automated | S9.1–S9.3, S9.5. |
| DOD-20 Solo mode | Automated | S12.1–S12.3. |
| DOD-21 Real assistant turn | Real runtime run once; the rest automated | S6.1 and S6.5 against the real runtime (owner's PC); S6.2, S6.3, S6.6, S12.5 in CI against a fake runtime that speaks the same protocol. |
| DOD-22 Assistant isolation | Real runtime run once; the rest automated | S6.4, S6.5; Claude starts with no tools, MCP servers or user settings, and every permission request is denied. |
| DOD-23 Install on real phones | Install help automated; real phones not performed | S14.6; the device checklist is in [offline-acceptance.md](offline-acceptance.md). S14.7 needs the owner's iPhone and Android phone. |
| DOD-24 Offline chapters | Automated | S14.1–S14.5, including a cold start with the network blocked. |
| DOD-25 Saved on the device | Automated | S15.1, S15.5. |
| DOD-26 Sync without duplicates | Automated | S15.3, S15.4, S15.6. |
| DOD-27 Failed saves, logout, export, updates | Automated | S15.2, S14.5, S16.1–S16.4. |
| DOD-28 Small screens | Automated in Chromium; real phones not performed | S17.1–S17.3: 320×568 and 360×640, both orientations, 200 % text, keyboard, safe areas. |
| DOD-29 Phone audio | Not performed; voice parts out of v1 | S17.4 needs the owner's phones. |
| DOD-30 Delivery | This document | README, `.env.example`, `docs/deploy.md`, migrations in `migrations/`, the demo seed. |

## Checks not performed

Each needs something only the owner can provide. Nothing here was replaced by a mock and reported as passed.

| Check | Needs |
|---|---|
| S1.11 a code reaching a real inbox; real reminder delivery | `SMTP_URL` for a free relay (Gmail app password, or the VPS's own mail server) |
| S7.5 the app at the owner's hostname | the DNS record, proxy route, GHCR access and deploy webhook secret (`docs/deploy.md`) |
| S13.3 CSB text | a free API.Bible Starter key with CSB access approved |
| S14.7, S17.4 real phones | an iPhone with Safari and an Android phone with Chrome |
| DOD-09 across two networks | the deployed app and two phones off the owner's network |

## Limitations

- No built-in voice (DOD-08); the group uses its own call.
- CSB has no narration: no licensed CSB recording exists. A CSB study runs as reading together, with any member marking the verse.
- CSB text is held for 14 days, as API.Bible's terms allow, and refetched after that only with a connection.
- One group per instance. The data model is keyed by group, so a second group needs no migration, but there is no UI for it.
- The study assistant is the owner's alone and needs their PC on with the connector running.
- Codes and reminders go only through the relay in `SMTP_URL`; until a real one is set, they reach no one outside Mailpit.
- The owner's status page (mail failures, health) is designed but not built; it needs a slice from `/plan`.
- An unhealthy app (database down) shows unhealthy in Portainer and is not restarted; it serves again once the database is back.
- Layout was checked in Chromium's emulation, not in Safari. iOS-specific behaviour (keyboard resizing, standalone safe areas) is unverified until S17.4.
