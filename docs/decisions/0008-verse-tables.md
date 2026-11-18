# ADR-0008: Scripture in verse tables, with no API.Bible

Status: Accepted

## Context

The owner holds the CSB and ESV as files and asked to drop the API.Bible path entirely: no key is needed when the text is already in hand. The text is effectively fixed, so it can be stored once in a shape that supports search, passage ranges and side-by-side reading, not only whole-chapter display.

## Decision

Remove API.Bible: its client, the browser Fair Use reporter, the `APIBIBLE_*` settings, the `not_configured` availability, and the `chapters.expires_at` and `chapters.fums_token` columns. Migration 0014 deletes any chapter that still has an expiry (an API.Bible copy) before dropping the columns. CSB's `source_kind` becomes `files`. A translation with no imported chapters is `unavailable` with the import command as its reason.

Migration 0014 adds four tables beside `chapters`:

- `canon`: the 66 books in canon order, seeded, so every translation shares one book numbering.
- `verses`: one row per verse, keyed by `(translation_id, ref)` where `ref` is `BBCCCVVV` (book, chapter, verse). A passage is a `ref BETWEEN` range. A generated `tsvector` with a GIN index gives English full-text search.
- `headings`: ordered by `seq`, placed before a verse `ref`, with an optional `level` (1 major, 2 or 3 minor).
- `verse_notes` (named apart from the personal `notes` table): ordered by `seq`, attached to a verse `ref`, `kind` `footnote` or `crossref`, with the cross-referenced `passage` when the source gives one.

All three reference their chapter with `ON DELETE CASCADE`. `chapters.content` remains the served copy, so I-10 holds and offline hashes, ETags and manifests keep working. Each import writes the chapter and rewrites its derived rows in one transaction. The migration backfills the new tables from the stored chapters; levels and cross-reference passages are filled on the next import.

Imported text is never committed to git or baked into the image. Tests use synthetic files only.

## Consequences

- No key, quota, expiry or Fair Use reporting applies to any translation. All imported text is persistent and shared with every signed-in reader (ADR-0004).
- CSB cross references are now served among the footnotes, so re-importing CSB changes those chapters' hashes once and their offline copies are refreshed on the next download. ESV served bytes are unchanged.
- A CSB cross reference placed inside a heading has no verse and is not kept.
- BSB has no heading levels or cross references; its rows carry nulls.
- The client still honours an expiry on a download made by an earlier version, so old API.Bible copies are dropped as before.
- Search and side-by-side views are enabled by the schema but not built yet.
- Supersedes the API.Bible parts of [ADR-0003](0003-imported-csb-access.md), [ADR-0004](0004-shared-imported-csb.md) and [ADR-0007](0007-whole-bible-offline.md), and D-2026-10-30-04.
