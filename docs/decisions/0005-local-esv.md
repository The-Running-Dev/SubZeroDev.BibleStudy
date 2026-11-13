# ADR-0005: Import downloaded ESV text into shared chapter storage

Status: Accepted

## Context

The owner downloaded and verified all 1,189 ESV chapters and wants to import them once, select ESV in the app, and read locally without an API key. The existing chapter store, import manifests and device downloads already support imported text.

## Decision

Add ESV as a translation and a file source for the downloader's `NN-Book/NNN.json` format. Validate chapter identity, verse ordering and declared counts before storing normalized chapter content. Preserve intentional verse-number gaps, poetry line breaks, headings and footnotes; represent cross-references as labelled footnotes using the existing reader format.

Use the same shared access policy as imported CSB: every signed-in reader can read and download imported ESV chapters. Store them in Postgres without expiry or external usage callbacks. ESV works in reading positions, preferences, notes, questions and study sessions. It has no narration source.

Keep downloaded Scripture files outside git and container images. Deploy code and schema support, then perform the private one-time data import into the existing app database. The database and its backups retain the text across redeploys; browser offline downloads remain per account and device.

## Consequences

ESV reading does not depend on ESV.org or API credentials after import. The importer is idempotent and records chapter failures in its manifest. This adds a database migration widening translation constraints; existing BSB and CSB data remain intact. The original download attribution is retained in the translation metadata, while the source JSON remains the owner's local working material.
