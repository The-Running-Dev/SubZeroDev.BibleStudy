# Offline installation and acceptance (S14)

## Automated checks

After `npm ci`, `npx playwright install chromium` and `npm run build`:

```bash
node --test tests/e2e/download-integrity.test.ts
```

This suite uses the production client and service worker with synthetic HTTP chapter/audio responses. It needs no PostgreSQL, SMTP, API.Bible key or AO Lab access. It checks cold offline startup after fully closing the browser, text-only and narrated chapters, actual audio decoding and verse following, a network cut halfway through audio, digest failures, transaction aborts after request success, unavailable content, CSB expiration, and preservation of offline notes and their pending operations when downloads are removed.

The cold-start check disables browser networking and stops the origin server as well: some Chromium versions allow a service worker's fetch to bypass Playwright's context offline setting. The interruption check also closes the origin's open connections after disabling networking, so an already open stream really ends.

The existing `tests/e2e/offline.test.ts` covers server-generated manifests, imported content, persistent profiles and install guidance. Run it with the repository's PostgreSQL and Mailpit services and upstream content access, or run `npm run test:e2e` for all browser suites. Synthetic responses do not validate real API.Bible authorization or licensing access.

## Physical devices — not performed

S14.7 remains **not performed** until both rows below have evidence. Changing a browser's viewport or user-agent does not count as a phone test.

| Device | Standalone launch | Text and narration after full close, airplane mode | Login/storage differences | Result |
| --- | --- | --- | --- | --- |
| iPhone / Safari (record model and iOS version) | Not performed | Not performed | Not recorded | Not performed |
| Android / Chrome (record model, OS and browser versions) | Not performed | Not performed | Not recorded | Not performed |

1. Use the deployed HTTPS origin. Open the account menu's **Install on your phone** help.
2. On iPhone, follow Safari **Share → Add to Home Screen → Add**. Open the icon, sign in if asked, and record whether the browser's login/downloads carried over.
3. On Android, use **Install Bible Study** when Chrome offers it, or Chrome's **Install app / Add to Home screen** menu. Open the icon and record whether login/downloads carried over.
4. Confirm standalone launch. Download one chapter with narration and another text only. Confirm the displayed size before starting. Make a private note.
5. Fully close the installed app, enable airplane mode with Wi-Fi also off, and reopen it from its icon. Read both chapters, play narration and confirm verse highlighting; an undownloaded chapter must request a connection and text-only content must offer no offline playback.
6. Remove the narrated download from the account menu. Confirm the note remains after closing and reopening. Reconnect and verify the existing S15 sync flow independently.
7. Record device/version, date, observed login/storage behavior and pass/fail evidence here. Check interruption/cancellation and an expired synthetic CSB lease in a controlled test environment; do not modify real licensed content or claim live CSB access without an approved key.

Downloads belong to the browser or installed application that saved them. Mobile operating systems may evict storage; missing or damaged assets must require a new download. CSB text expires at the server-provided deadline and cannot be downloaded indefinitely.
