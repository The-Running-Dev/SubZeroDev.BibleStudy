# ADR-0006: Download the entire ESV Bible to a device

Status: Accepted

## Context

ESV is already stored in the app database. The owner wants one action to make the whole Bible readable offline instead of downloading individual chapters.

## Decision

Offer **Download entire ESV Bible** when ESV is selected in the reader. Download text, headings and notes sequentially from the app's authenticated chapter endpoints using the existing checksum verification and committed per-account device records. The expected set comes from the canonical 66-book, 1,189-chapter catalog, so a partial server import cannot be mistaken for the entire Bible.

Show the count of verified saved chapters and the chapter being downloaded. Pause, an interruption or leaving the ESV reader stops new work and keeps committed chapters. Resume scans storage again, skipping valid chapters and replacing missing, expired or damaged copies. Verify the full set again before showing completion. Prevent simultaneous whole-Bible downloads for the same account across windows where Web Locks is supported.

## Consequences

No new server import, ESV.org requests or credentials are needed. Existing individual downloads count toward completion and can still be removed. Downloads continue only while the reader remains open; reopening requires Resume. Storage remains subject to browser eviction and is specific to the account and device. Existing narration and other translations are unchanged.
