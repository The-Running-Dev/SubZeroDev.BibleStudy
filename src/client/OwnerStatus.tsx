import { useEffect, useState } from 'react';
import type { OperationalEmail, OwnerStatus } from '../shared/api.ts';
import { api, messageFor } from './api.ts';

const when = (value: string) => new Date(value).toLocaleString();

function DeliveryList(props: {
  title: string;
  jobs: OperationalEmail[];
  count: number;
  limit: number;
}) {
  return (
    <section aria-label={props.title}>
      <h3>
        {props.title} ({props.count})
      </h3>
      {props.count > props.jobs.length && (
        <p>
          Showing the newest {props.limit} of {props.count} jobs. Use job IDs to inspect server
          logs.
        </p>
      )}
      {props.jobs.length === 0 ? (
        <p>None.</p>
      ) : (
        <ul className="operational-jobs">
          {props.jobs.map((job) => (
            <li key={job.id}>
              <strong>
                {job.state === 'failed'
                  ? 'Permanently failed'
                  : job.state === 'sending_retry'
                    ? 'Sending retry'
                    : 'Retry scheduled'}
              </strong>
              <p>
                {job.kind === 'login_code' ? 'Sign-in code' : 'Study reminder'} to {job.to}
              </p>
              <p>
                {job.failure.summary} {job.failure.action}
              </p>
              <p>
                Attempts: {job.attempts}. Created: {when(job.createdAt)}.
              </p>
              {job.nextAttemptAt && (
                <p>Next attempt: {when(job.nextAttemptAt)}. Automatic retries remain active.</p>
              )}
              <p>
                Job ID: <code>{job.id}</code>
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function OwnerStatusPanel() {
  const [status, setStatus] = useState<OwnerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    // Drop the old snapshot on refresh, including when access was revoked or the server is offline.
    setStatus(null);
    setError(null);
    api
      .ownerStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch((failure) => {
        if (active) setError(messageFor(failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);

  return (
    <section className="operational-status" aria-label="Operational status" aria-busy={loading}>
      <h2>Operational status</h2>
      <button type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>
        Refresh status
      </button>
      {loading && <p>Checking status…</p>}
      {error && <p role="alert">Status unavailable. {error}</p>}
      {status && (
        <>
          <p>Checked: {when(status.checkedAt)}. Refresh to check again.</p>
          <h3>Study assistant connector</h3>
          {status.assistant.state === 'online' && (
            <p>Online — connector ready. This does not check the model provider.</p>
          )}
          {status.assistant.state === 'offline' && (
            <p>
              Offline — start the connector on the owner's PC. Reading and narration remain
              available.
              {status.assistant.since && <> Disconnected: {when(status.assistant.since)}.</>}
            </p>
          )}
          {status.assistant.state === 'not_configured' && (
            <p>Not configured — complete the assistant setup on the server and owner's PC.</p>
          )}
          <h3>Email deliveries</h3>
          <p>
            {status.mail.counts.failed === 0
              ? 'No permanent delivery failures.'
              : 'Permanent delivery failures require attention.'}{' '}
            Retrying: {status.mail.counts.retrying}.
          </p>
          <p>
            Queued for first attempt: {status.mail.counts.queued}. Sending (including retries):{' '}
            {status.mail.counts.sending}. Accepted by relay: {status.mail.counts.sent}. Suppressed
            reminders: {status.mail.counts.suppressed}.
          </p>
          <p>
            Stored delivery records only; this does not probe SMTP or confirm inbox receipt. Counts
            cover all retained jobs. Suppressed reminders are not delivery failures.
          </p>
          <DeliveryList
            title="Permanent failures"
            jobs={status.mail.failed}
            count={status.mail.counts.failed}
            limit={status.mail.limit}
          />
          <DeliveryList
            title="Retrying deliveries"
            jobs={status.mail.retrying}
            count={status.mail.counts.retrying}
            limit={status.mail.limit}
          />
        </>
      )}
    </section>
  );
}
