# ADR-0004: Share imported CSB with every signed-in reader

- **Status:** Accepted
- **Date:** 2026-11-09
- **Supersedes:** [ADR-0003](0003-imported-csb-access.md)'s personal-account restriction

## Decision

Ben explicitly requested that everyone see the same content. All signed-in accounts receive the same imported CSB chapters, book/translation catalogs, validators and download manifests. Group membership and `OWNER_EMAIL` do not affect scripture access. Existing sign-in requirements remain: signed-out content requests return 401, including HEAD and encoded routes.

Remove the imported-CSB access resolver, `CSB_IMPORTED_ACCESS`, `content_not_permitted` and `restrictedToUserId` response fields. Old stack environments may still contain `CSB_IMPORTED_ACCESS`; the application ignores it. `OWNER_EMAIL` retains its group-setup role and is not required for reading imports.

The shared loader serves imported CSB to any authenticated route caller and to the existing assistant. Assistant-use permissions remain separate: access to the same scripture does not grant access to another account's conversations, notes or runtime. Group controls and private-data isolation are unchanged.

## Offline and source behavior

Every signed-in reader can download the same chapter. Device records remain keyed by the reader's account, as for BSB, to preserve normal account isolation. Remove imported-only scope checks and the purge of unscoped imports. Existing unscoped downloads and older scoped bodies remain readable when otherwise valid; old scope metadata is ignored. Hash verification, cancellation and API.Bible expiry are unchanged. Copies previously purged by an older client must be downloaded again.

Imported chapters remain persistent, need no API.Bible key and take precedence at their shared storage key. If API.Bible is configured, every reader receives the imported row for that chapter instead of an account-dependent refusal. API.Bible-only rows retain their 14-day expiry, FUMS and refresh behavior. No imported text is removed, relabeled or reimported by this change.

Ben supplied the scraped-XML provenance. Licensing approval remains outside engineering acceptance; this decision makes no legal determination. XML, imported text and database backups stay outside the public repository and container image.

## Validation and deployment

Reuse the synthetic account matrix to require identical chapter bodies, ETags, catalogs and manifests for the configured owner, ordinary members and accounts without a group. Cover missing/mismatched owner configuration, the obsolete disabled setting, signed-out refusals, HEAD/conditional and encoded routes, shared API.Bible/import races, assistant passage loading and offline compatibility.

Every merge continues to deploy automatically after the image drill and publication succeed. Verify the deployed build id separately from CI; production account-matrix verification must be reported only when actually performed. Installed clients must update to stop enforcing their older offline scope rules.
