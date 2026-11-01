# ADR-0004: Read-only owner operational status

- **Status:** Accepted
- **Date:** 2026-11-01

## Context

The November 1 reconciliation after S18 left the owner's promised operational status page unimplemented. The existing outbox persists delivery outcomes and last errors; the assistant already owns connector hello, disconnect and heartbeat state. The operating model is one group per instance, best-effort VPS availability and no paid monitoring or paging.

## Decision

Add S20, independently of S18, with Account → Operational status and `GET /api/owner/status`. Require an active persisted owner membership using the existing group lookup before reading operational records. Assistant permission remains independent.

Read retained mail status in a read-only repeatable-read transaction. Separate terminal failures, active retries, first-attempt queues, sending jobs, relay acceptance and suppressed reminders. Return full counts and at most the newest 50 entries in each attention list. Show job ID, recipient, kind, attempts and timestamps. Use only fixed safe error guidance; arbitrary raw SMTP text may contain codes, credentials or message contents. Do not select bodies, sealed secrets, provider identifiers or idempotency keys.

Project connector state from the existing assistant link, with a not-configured state if required settings are missing. Return no provider/runtime details or configuration. Do not introduce a probe, change the protocol or grant assistant access.

Use `no-store` and explicit refresh with a checked-at timestamp. A failed refresh clears the last snapshot and shows unavailable. Keep the worker, authentication, deployment and retention conventions unchanged.

## Consequences and alternatives

The page is operational evidence from retained records, not worker/SMTP/inbox/provider liveness monitoring. It cannot monitor its own unavailable VPS. Counts include all retained history; older failures remain in the total when the list is truncated. Logs can be correlated by job ID for details omitted from the browser.

Redacting arbitrary error strings was rejected because secrets can appear in arbitrary formats. Resend controls, import administration, external subscriptions and paging are outside S20. The existing import workflow remains the source for manifests.

See [the S20 plan](../../design/30-slices.md), [decision log](../../design/90-decisions.md) and [operating notes](../operational-status.md).
