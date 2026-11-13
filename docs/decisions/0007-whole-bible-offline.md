# ADR-0007: Whole-Bible offline downloads for BSB, CSB and ESV

Status: Accepted

## Context

The owner wants the existing whole-ESV download option to work for BSB and CSB as well.

## Decision

Generalize the client downloader and reader control from [ADR-0006](0006-esv-offline-bible.md) to the selected translation. Each translation uses the same canonical 66-book, 1,189-chapter set, sequential authenticated requests, per-chapter integrity checks and final verification. Existing valid downloads count toward completion. Missing, expired or damaged chapters are downloaded again on Resume.

Keep progress, stored chapters and cross-window download locks separate by account and translation. Switching translations aborts the active download, retains committed chapters and shows the newly selected translation's saved count. Reopening or switching back allows Resume. Whole-Bible downloads include text, headings and notes; narration remains a per-chapter choice.

## Consequences

No server changes, new imports or credentials are needed for already imported content. Existing CSB source behavior remains: imported chapters do not expire, while API.Bible chapters retain their expiry and availability requirements. A missing source stops the download with an error and keeps completed chapters; a partial source cannot be reported as an entire saved Bible. Device storage and browser eviction limits remain unchanged.
