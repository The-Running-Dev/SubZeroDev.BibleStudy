# ADR-0002: Commit verified downloads and enforce licensed expiry

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

S14 and S15 are already implemented on main by PRs #17 and #18. S14 follow-up work must keep the existing `biblestudy` IndexedDB database, `media-v1` cache and S15 outbox. A successful IndexedDB request is not proof that its transaction committed. Previously cached audio must meet the same integrity checks as newly received audio.

## Decision

- Validate the manifest's chapter/audio inventory, byte counts, digests and expiry before fetching assets. Require an expiry for CSB. Check the downloaded chapter's identity and expiry against the manifest, and reject an expiry reached during transfer.
- Verify reused cached audio before allowing it into a ready download. Keep the exact chapter asset digest and byte count on new records and verify them when opening the download. Records from PR #17 remain readable without a schema upgrade; their audio is still verified.
- Wait for the download transaction's `complete` event before reporting ready or removed. Aborted writes clean staged audio and leave personal stores untouched.
- Expire a chapter already open in the reader on its deadline and on focus/visibility changes after phone sleep. Purge its saved text and audio through the existing download store. The operating system can suspend JavaScript while the app is closed; stored expired bytes are purged on the next access and are never displayed after the expiry check.
- Serve licensed chapter responses with `private, no-store`, so the HTTP cache does not retain another copy beyond the managed download's expiry. The service worker caches shell assets only.
- Discover offline translation choices from that member's download metadata, without adding another catalog or persistence system.

## Consequences

Rechecking stored audio costs a digest calculation when checking or opening downloads. Removing downloads touches neither notes nor pending sync operations. Content expiry still uses the device wall clock; intentional clock manipulation and server-verified offline leases are not introduced by this slice.

Synthetic browser tests exercise real service workers, IndexedDB transactions, cache integrity, audio decoding and offline startup without an API.Bible key or upstream imports. They complement the existing database/import tests. Browser simulations do not satisfy physical iPhone or Android acceptance.

## Alternatives considered

- Trusting Cache Storage because the URL contains a hash would miss damaged or replaced bytes.
- Reporting ready on request success could claim a download survived a transaction that subsequently aborted.
- Creating a second offline database would split the persistence system already used by S15 and complicate note preservation.

See [the device acceptance checklist](../offline-acceptance.md) for the checks still requiring phones.
