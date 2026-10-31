import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Disposition, GroupProgressView, QuestionView, WrapUpView } from '../shared/api.ts';
import { dispositions } from '../shared/api.ts';
import { formatReference } from '../shared/reference.ts';
import { ApiFailure, api, messageFor } from './api.ts';
import { formatStop, parseStop, staleNote } from './progress.ts';
import { statusLabels } from './Questions.tsx';

const dispositionLabels: Record<Disposition, string> = {
  closed: 'Close',
  carried: 'Carry forward',
  resolved: 'Resolved',
  no_longer_relevant: 'No longer relevant',
};

// Confirms the group's stopping point (S9.1), or its starting point before the first study (S9.5). It is based on the
// stopping point this member last saw, so one confirmed meanwhile by someone else is shown, not overwritten (S9.2).
export function ConfirmStop(props: {
  groupId: string;
  sessionId?: string;
  initial: string;
  label: string;
  onConfirmed?: () => void;
}) {
  const [text, setText] = useState(props.initial);
  const [basedOn, setBasedOn] = useState<GroupProgressView | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api
      .progress(props.groupId)
      .then(({ progress }) => current && setBasedOn(progress))
      .catch((e) => current && setError(messageFor(e)));
    return () => {
      current = false;
    };
  }, [props.groupId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ref = parseStop(text);
    if (!ref) {
      setError(`"${text}" is not a verse. Try "Romans 2:11".`);
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const { id } = await api.confirmProgress(props.groupId, {
        basedOnId: basedOn?.id ?? null,
        ref,
        ...(props.sessionId ? { sessionId: props.sessionId } : {}),
      });
      setSaved(`Saved: the next study starts at ${formatStop(ref)}.`);
      props.onConfirmed?.();
      // The saved row is what a further confirmation builds on, even when the refresh that names who saved it fails.
      const mine = { id, ref, confirmedBy: 'you', confirmedAt: new Date().toISOString() };
      setBasedOn(await api.progress(props.groupId).then(({ progress }) => (progress?.id === id ? progress : mine), () => mine));
    } catch (e) {
      const current =
        e instanceof ApiFailure && e.body.error === 'stale_progress'
          ? (e.body.details?.current as GroupProgressView | undefined)
          : undefined;
      if (current) {
        setBasedOn(current);
        setError(staleNote(current));
      } else setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="question-form" onSubmit={submit}>
      <label>
        Stopping point
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Romans 2:11"
          enterKeyHint="done"
        />
      </label>
      {basedOn && (
        <p className="player-note">
          Current stopping point: {formatStop(basedOn.ref)}, confirmed by {basedOn.confirmedBy}.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">{saved}</p>}
      <div className="question-actions">
        <button type="submit" disabled={busy || basedOn === undefined || !text.trim()}>
          {props.label}
        </button>
      </div>
    </form>
  );
}

// S9.1 and S9.4: where the group stopped, and what becomes of each question still open.
export function WrapUp(props: { groupId: string; sessionId: string; onClose: () => void }) {
  const [view, setView] = useState<WrapUpView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api
      .wrapUp(props.groupId, props.sessionId)
      .then((v) => current && setView(v))
      .catch((e) => current && setError(messageFor(e)));
    return () => {
      current = false;
    };
  }, [props.groupId, props.sessionId]);

  const replace = (updated: QuestionView) => setView((v) => v && { ...v, openQuestions: v.openQuestions.map((q) => (q.id === updated.id ? updated : q)) });

  // Based on the version shown, so a decision someone else made meanwhile is shown rather than overwritten.
  async function settle(question: QuestionView, status: Disposition) {
    setError(null);
    try {
      replace(await api.setDisposition(props.groupId, question.id, { status, version: question.version, sessionId: props.sessionId }));
    } catch (e) {
      const current = e instanceof ApiFailure && e.body.error === 'stale_revision' ? (e.body.details?.current as QuestionView | undefined) : undefined;
      if (current) {
        replace(current);
        setError(`Someone changed "${current.body ?? 'a removed question'}" first; it is now ${statusLabels[current.status]}. Decide again to replace it.`);
      } else setError(messageFor(e));
    }
  }

  return (
    <section className="wrap-up" aria-label="Wrap up">
      <h2>Wrap up</h2>
      {error && <p role="alert">{error}</p>}
      {view && (
        <>
          <ConfirmStop
            groupId={props.groupId}
            sessionId={props.sessionId}
            initial={formatStop(view.suggested)}
            label="Confirm stopping point"
          />
          <h3>Open questions</h3>
          {view.openQuestions.length === 0 && <p className="player-note">No open questions.</p>}
          <ol className="question-list">
            {view.openQuestions.map((question) => (
              <li
                key={question.id}
                className="question"
                data-testid="wrap-question"
                data-question={question.id}
              >
                <p className="question-meta">
                  <strong>{formatReference(question.anchor)}</strong>
                  <span className="question-status"> · {statusLabels[question.status]}</span>
                </p>
                <p className="post-body">{question.body ?? 'removed'}</p>
                <div className="question-actions" role="group" aria-label="Decide">
                  {dispositions.map((status) => (
                    <button
                      key={status}
                      type="button"
                      className="secondary"
                      aria-pressed={question.status === status}
                      onClick={() => void settle(question, status)}
                    >
                      {dispositionLabels[status]}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      <button type="button" className="secondary" onClick={props.onClose}>
        Done
      </button>
    </section>
  );
}
