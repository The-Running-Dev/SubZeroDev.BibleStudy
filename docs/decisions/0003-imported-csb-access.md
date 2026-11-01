# ADR-0003: Restrict imported CSB to the configured owner

- **Status:** Accepted technical containment; licensing approval remains open
- **Date:** 2026-11-01

## Context

PR #24 stores imported CSB chapters without an expiry. Authentication alone previously admitted every signed-in account, including accounts with no memberships. Keeping XML outside Git and images does not authorize distribution of the imported database text. No licence document or deployed-content exposure was inspected in this change.

## Decision

`CSB_IMPORTED_ACCESS=owner` is the conservative default. Only the verified server session whose user matches `OWNER_EMAIL` may retrieve imported CSB. No `OWNER_EMAIL` means nobody. `CSB_IMPORTED_ACCESS=disabled` refuses everyone, including the owner. Unknown modes fail startup. Neither a group owner role, membership nor `ASSISTANT_OWNER_EMAIL` grants imported-text access. The setting is reversible without deleting imported data; it is containment, not a finding that personal hosted use is licensed.

The shared catalog loader denies imported CSB by default. Web chapter reads, HEAD/conditional requests, manifests and assistant passage loading explicitly pass the caller's resolved access. The check runs after any shared API.Bible load, including when an import wins a race. Imported chapters cannot be returned to a denied account even when an API key is configured. Such accounts see CSB unavailable when imports are its only source and receive no imported book list. CSB remains a known translation; configuring API.Bible may independently make its catalog available.

All CSB chapter responses and account-specific catalogs use `no-store`. Imported chapters and manifests include `restrictedToUserId`; offline downloads require the same account scope in both responses. Existing unscoped imported CSB downloads are removed when the updated client inspects their state, list, translation metadata or chapter. BSB and expiring API.Bible copies retain their existing behavior. This supersedes ADR-0002's blanket CSB-expiry requirement only for scoped imported copies.

No migration or destructive content cleanup is required. The existing `CSB + expires_at IS NULL` import discriminator is retained; API.Bible rows keep their 14-day expiry and FUMS tokens. Narration remains unavailable for CSB. Group/session endpoints carry references and playback state, not chapter text; export carries personal data, not a Bible corpus.

## Options and the owner's outstanding decision

| Option | Technical implications | Permission still required |
| --- | --- | --- |
| Owner only (current default) | Verified `OWNER_EMAIL`; solo reading and account-scoped downloads; `disabled` can stop new reads/downloads. | Confirm the actual XML licence covers personal hosted storage/display, backups, offline copies and any selected text sent to the assistant/provider. |
| Authorized group sharing (not implemented) | Requires an explicit permitted group/audience policy, active membership checks at every content path, catalog filtering, and a revocation/expiry policy for offline copies. A generic member role is insufficient across groups. | Identify the specific licence/grant permitting the named hosted audience, amount of text, downloads, duration, attribution, territory and any assistant processing. Record evidence and limits before implementing a wider mode. |
| API.Bible | Requires approved CSB access for this app, server key, copyright display, FUMS and refresh/expiry. Existing 14-day expiry is preserved. An imported row currently occupies the same chapter key and blocks a nonowner from that chapter; a full switch needs separate source storage or a reviewed archive/removal of imported rows, not automatic relabeling. | Confirm the app's account/plan and CSB grant cover its audience and offline use. A key alone or an older Starter-plan note is not proof. API.Bible permission does not license these XML files. |

The owner must supply/confirm the applicable licence or rights-holder grant and choose the permitted audience and uses. No group permission is invented here. If even owner-hosted use is unconfirmed, `CSB_IMPORTED_ACCESS=disabled` is available immediately. The public quotation allowance is not treated as permission to host a complete Bible.

Primary references checked 2026-11-01:

- [Holman's CSB Reader's Bible copyright/permissions statement](https://readersbible.csbible.com/wp-content/themes/csbrb-theme/assets/sample.pdf): limited quotations with conditions; written permission beyond that allowance.
- [API.Bible licensing policies](https://care.api.bible/article/396-licensing-policies-quick-reference): translation-specific access, attribution and FUMS; specific agreements may add requirements.
- [API.Bible caching guidance](https://care.api.bible/article/401-caching-content): refresh at least every 30 days, 14 days or less recommended. This patch retains the repository's stricter 14-day rule.

## Limits and deployment verification

A server cannot recall files someone already copied. An old client remains subject to its old behavior until updated; the updated client purges legacy unscoped downloads on access. Authorized owner downloads remain offline-readable after server configuration changes: there is no remote revocation while disconnected. The account scope is an application boundary, not encryption/DRM against someone controlling their own browser storage.

Before claiming a deployed fix, merge/deploy this revision, verify `/__build-id`, update installed clients, then exercise the account matrix with synthetic text. Inspect production import/configuration state privately. This source change supplies no evidence about whether a public deployment has imported CSB or served it to anyone.
