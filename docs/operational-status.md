# Owner operational status (S20)

Open the account menu (your name), then **Operational status**. Only the active owner of the one v1 group can fetch `GET /api/owner/status`; assistant access alone does not grant operational access.

**Refresh status** fetches a new snapshot. The page shows when it was checked and clears the previous snapshot before refreshing. A server or authorization failure shows unavailable. This is an on-demand view on the existing best-effort VPS, without a monitoring or paging service. It cannot report its own server's outage while unreachable.

## Email

Permanent failures are terminal jobs: a relay's 5xx rejection, exhausted retries or a sign-in code that expired before it could be sent. Retrying deliveries are queued after a failed attempt or currently sending another attempt. First-attempt queued jobs and all sending jobs have separate counters; sending retries are included in the sending count as well. Suppressed reminders (for moved/cancelled meetings) are counted separately and are not delivery failures.

Each failure/retry shows recipient, message kind, attempts, creation time, job ID and fixed safe guidance. Queued retries also show their next-attempt time; an overdue time remains overdue rather than implying a delivery happened. The page does not restart jobs or change worker behavior. Each list contains the newest 50 records by creation time and ID, with a full retained count so older failures cannot silently disappear from the summary. There is no new retention policy.

Raw SMTP errors may contain codes, credentials or message contents, so the page replaces them with safe categories. Check relay credentials for authentication failures; check server network access for connection failures; check the recipient and relay policy for permanent rejections. Use the job ID to correlate with restricted server logs when more detail is needed. After the cause is fixed, request a new sign-in code if the old one expired or failed. Do not expect a terminal job to retry automatically.

“No permanent delivery failures” describes the stored outbox only. “Accepted by relay” is not proof of inbox receipt. Neither statement probes SMTP or proves the worker is currently running.

## Connector

- **Online:** the existing authenticated connector link has sent its hello and has not disconnected or expired under the existing heartbeat. This is not a model-provider health check.
- **Offline:** start/reconnect the connector on the owner's PC. Reading and narration remain available. A disconnection time is shown when known within this server process; a fresh process may not know it.
- **Not configured:** complete the existing assistant setup on the server and owner's PC. The response does not reveal configuration values.

This page does not grant permission to use the assistant, expose its transcript, or show tokens, runtime IDs, provider details or paths. Email bodies, subjects, sealed secrets and idempotency/provider identifiers are excluded from the response. Operational responses use `no-store` and are not saved in the offline database or service-worker cache.

## Validation and deployment

S20 acceptance is in [the slice plan](../design/30-slices.md). Focused suites are `tests/unit/mail-status.test.ts`, `tests/integration/status.test.ts` and `tests/e2e/status.test.ts`; the existing CI also runs typecheck, lint, all unit/integration/browser suites, the stack drill and the documentation check.

The PR records results actually observed, separately from CI and live deployment checks. Deployment continues through the existing merged-main image/drill/Portainer workflow. After deployment, the owner can check the new build ID, open the page as owner, verify a member's direct API request is forbidden, and confirm connector state against the real PC. Real SMTP delivery, provider readiness and physical-phone checks are separate from the synthetic test results.
