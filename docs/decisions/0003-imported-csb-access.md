# ADR-0003: Keep imported CSB private to the configured personal account

- **Status:** Accepted personal-use access policy
- **Date:** 2026-11-01
- **Revised:** 2026-11-09

## Context

PR #24 stores imported CSB chapters without an expiry. Authentication alone previously admitted every signed-in account, including accounts with no memberships. Ben clarified on 2026-11-09 that he scraped the XML from an online site for his personal use only. No particular source website has been established in this decision. The imports are private data for his configured application account; group members and other signed-in accounts are outside that audience.

## Decision

`CSB_IMPORTED_ACCESS=owner` is the conservative default. Only the verified server session whose user matches `OWNER_EMAIL` may retrieve imported CSB. No `OWNER_EMAIL` means nobody. `CSB_IMPORTED_ACCESS=disabled` refuses everyone, including the owner. Unknown modes fail startup. Neither a group owner role, membership nor `ASSISTANT_OWNER_EMAIL` grants imported-text access. Here, owner means the configured application account, not ownership of the CSB text. The setting is reversible without deleting imported data.

The shared catalog loader denies imported CSB by default. Web chapter reads, HEAD/conditional requests, manifests and assistant passage loading explicitly pass the caller's resolved access. The check runs after any shared API.Bible load, including when an import wins a race. Imported chapters cannot be returned to a denied account even when an API key is configured. Such accounts see CSB unavailable when imports are its only source and receive no imported book list. CSB remains a known translation; configuring API.Bible may independently make its catalog available.

All CSB chapter responses and account-specific catalogs use `no-store`. Imported chapters and manifests include `restrictedToUserId`; offline downloads require the same account scope in both responses. Existing unscoped imported CSB downloads are removed when the updated client inspects their state, list, translation metadata or chapter. BSB and expiring API.Bible copies retain their existing behavior. This supersedes ADR-0002's blanket CSB-expiry requirement only for scoped imported copies.

No migration or destructive content cleanup is required. The existing `CSB + expires_at IS NULL` import discriminator is retained; API.Bible rows keep their 14-day expiry and FUMS tokens. Narration remains unavailable for CSB. Group/session endpoints carry references and playback state, not chapter text; export carries personal data, not a Bible corpus.

## Personal-use scope and source behavior

- Imported XML is used for Ben's personal reading, persistent storage, backups and account-scoped offline copies. XML, imported text and database backups stay outside the public repository and container image.
- Licensing approval is not an engineering acceptance or deployment gate for this personal-use scope. This decision records the supplied provenance and intended use; it makes no legal determination or claim that a licence or ownership of the text has been verified.
- Group sharing of imported CSB is outside the requested scope. Group features may continue using BSB. A broader audience would need a separate product decision and access design.
- The existing assistant may load imported passages only for the same personal account, with its separate assistant permission also required. Selected passage text is sent through the connector to the configured runtime/provider; this feature is not a promise of device-local processing.
- API.Bible remains optional and independent. Its existing key/Bible-id configuration, copyright display, FUMS and 14-day expiry remain unchanged. It is not required to read an imported chapter, and its cache rules are not applied to imports.
- Imported and API.Bible chapters share a storage key. An imported row takes precedence and a nonowner receives 403 for it, even with API.Bible configured. Separate source storage would be needed to serve the API.Bible version independently; no imported rows are removed or relabeled here.

This revision supersedes the earlier licensing-approval checklist and any assumption that these XML files were supplied as a purchased or licensed package. It does not change the access implementation or existing account-matrix acceptance tests.

## Limits and deployment verification

A server cannot recall files someone already copied. An old client remains subject to its old behavior until updated; the updated client purges legacy unscoped downloads on access. Authorized owner downloads remain offline-readable after server configuration changes: there is no remote revocation while disconnected. The account scope is an application boundary, not encryption/DRM against someone controlling their own browser storage.

Every merge to main automatically runs the image drill, publishes the image and requests the Portainer redeploy. Before claiming deployed protection, verify `/__build-id`, update installed clients, then exercise the account matrix with synthetic text. Inspect production import/configuration state privately. Passing CI or a successful webhook alone does not establish the running account boundary.
