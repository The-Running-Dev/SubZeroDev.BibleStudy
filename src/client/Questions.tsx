import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { QuestionStatus, QuestionView, ReplyView, TranslationId } from '../shared/api.ts';
import { formatReference } from '../shared/reference.ts';
import { ApiFailure, api, messageFor } from './api.ts';
import { draftId, loadDraft, removeDraft, saveDraft } from './drafts.ts';
import { useOnline } from './online.ts';
import { parseVerses, unsettled } from './questions.ts';

export interface ChapterAt {
  translationId: TranslationId;
  bookId: string;
  chapter: number;
}

export const statusLabels: Record<QuestionStatus, string> = {
  open: 'Open',
  carried: 'Carried over',
  resolved: 'Resolved',
  closed: 'Closed',
  no_longer_relevant: 'No longer relevant',
};

const filters: { label: string; statuses: QuestionStatus[] | undefined }[] = [
  { label: 'Open', statuses: unsettled },
  ...(['carried', 'resolved', 'closed', 'no_longer_relevant'] as const).map((status) => ({ label: statusLabels[status], statuses: [status] })),
  { label: 'All', statuses: undefined },
];

// One id per draft, kept across retries so a post that reached the server before the connection dropped is not posted twice.
function useOpId(): { idFor: (draft: string) => string; reset: () => void } {
  const pending = useRef<{ id: string; draft: string } | null>(null);
  return {
    idFor(draft) {
      if (pending.current?.draft !== draft) pending.current = { id: crypto.randomUUID(), draft };
      return pending.current.id;
    },
    reset() {
      pending.current = null;
    },
  };
}

// S8.6: every question on the reader's chapter, filtered by status, without joining a study.
export function ReaderQuestions(props: { groupId: string; userId: string; at: ChapterAt; verseCount: number; verse: number | null }) {
  const { groupId, at } = props;
  const [filter, setFilter] = useState(0);
  const [questions, setQuestions] = useState<QuestionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [load, setLoad] = useState(0);
  const statuses = filters[filter].statuses;

  useEffect(() => {
    let current = true;
    api
      .questions(groupId, { bookId: at.bookId, chapter: at.chapter, status: statuses })
      .then((list) => {
        if (!current) return;
        setQuestions(list);
        setError(null);
      })
      .catch((e) => current && setError(messageFor(e)));
    return () => {
      current = false;
    };
  }, [groupId, at.bookId, at.chapter, statuses, load]);

  const reload = () => setLoad((n) => n + 1);
  return (
    <section className="questions" aria-label="Questions">
      <div className="questions-bar">
        <h2>Questions</h2>
        <select value={filter} onChange={(e) => setFilter(Number(e.target.value))} aria-label="Show questions">
          {filters.map((f, i) => (
            <option key={f.label} value={i}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      {error && <p role="alert">{error}</p>}
      {questions && <QuestionList groupId={groupId} userId={props.userId} questions={questions} onChanged={reload} empty="No questions here yet." />}
      <AskForm groupId={groupId} userId={props.userId} at={at} verseCount={props.verseCount} verse={props.verse} onPosted={reload} />
    </section>
  );
}

// Posting a question on a verse, a range, or the whole chapter. What is typed is kept on the device as a draft until
// it is posted (S15.5); posting needs a connection and a tap, and reuses the draft's op id so it posts once.
export function AskForm(props: { groupId: string; userId: string; at: ChapterAt; verseCount?: number; verse: number | null; onPosted: (question: QuestionView) => void }) {
  // The chapter the question is on, fixed when the form opens: the reading may move on while it is written.
  const [opened, setOpened] = useState<{ at: ChapterAt; verseCount?: number } | null>(null);
  const [verses, setVerses] = useState('');
  const [text, setText] = useState('');
  const [stored, setStored] = useState<'saved_on_device' | 'save_failed' | null>(null);
  // The op id this text will be posted under; a new one with every edit (S15.5).
  const [opId, setOpId] = useState<string>(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = useOnline();
  const { groupId, userId } = props;
  const { translationId, bookId, chapter } = props.at;

  // A draft left on this chapter opens the form with it.
  useEffect(() => {
    if (opened) return;
    let current = true;
    loadDraft(userId, draftId(groupId, { bookId, chapter }))
      .then((draft) => {
        if (!current || !draft) return;
        setVerses(draft.verses);
        setText(draft.body);
        setOpId(draft.clientOpId);
        setStored('saved_on_device');
        setOpened({ at: { translationId, bookId, chapter }, verseCount: props.verseCount });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [opened, userId, groupId, translationId, bookId, chapter, props.verseCount]);

  function start() {
    setVerses(props.verse === null ? '' : String(props.verse));
    setText('');
    setOpId(crypto.randomUUID());
    setStored(null);
    setError(null);
    setOpened({ at: props.at, verseCount: props.verseCount });
  }

  async function keep(next: { verses: string; body: string }) {
    if (!opened) return;
    setVerses(next.verses);
    setText(next.body);
    const clientOpId = crypto.randomUUID();
    setOpId(clientOpId);
    try {
      await saveDraft({ userId, id: draftId(groupId, opened.at), groupId, ...next, clientOpId });
      setStored('saved_on_device');
    } catch {
      setStored('save_failed');
    }
  }

  async function cancel() {
    if (opened) await removeDraft(userId, draftId(groupId, opened.at)).catch(() => undefined);
    setOpened(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!opened || busy) return;
    const { at, verseCount } = opened;
    const range = parseVerses(verses);
    if (!range || (verseCount !== undefined && range.endVerse !== null && range.endVerse > verseCount)) {
      setError(`Verses are a number or a range within 1–${verseCount ?? '…'}, or blank for the whole chapter.`);
      return;
    }
    const anchor = { ...at, ...range };
    const id = draftId(groupId, at);
    setBusy(true);
    try {
      // A device with no room still posts; the draft is only a safety copy.
      await saveDraft({ userId, id, groupId, verses, body: text, clientOpId: opId }).catch(() => undefined);
      const question = await api.postQuestion(groupId, { clientOpId: opId, anchor, body: text });
      await removeDraft(userId, id).catch(() => undefined);
      setText('');
      setStored(null);
      setOpened(null);
      setError(null);
      props.onPosted(question);
    } catch (e) {
      setError(e instanceof TypeError ? 'Not posted: there is no connection. Your question is kept on this device.' : messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  if (!opened) {
    return (
      <button type="button" className="secondary" onClick={start}>
        Ask a question
      </button>
    );
  }
  return (
    <form className="question-form" onSubmit={submit}>
      <label>
        Verses (blank for the whole chapter)
        <input value={verses} onChange={(e) => void keep({ verses: e.target.value, body: text })} inputMode="numeric" placeholder="e.g. 4 or 4-6" />
      </label>
      <textarea value={text} onChange={(e) => void keep({ verses, body: e.target.value })} rows={3} aria-label="Your question" required maxLength={4000} />
      {stored === 'saved_on_device' && (
        <p className="note-state" data-save-state="not_posted">
          Not posted · saved on this device
        </p>
      )}
      {stored === 'save_failed' && <p className="note-state">Not posted · could not save on this device</p>}
      {!online && <p className="note-state">Posting needs a connection.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="question-actions">
        <button type="submit" disabled={busy || !online || !text.trim()}>
          Post question
        </button>
        <button type="button" className="secondary" onClick={() => void cancel()}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function QuestionList(props: { groupId: string; userId: string; questions: QuestionView[]; onChanged: () => void; empty: string }) {
  if (!props.questions.length) return <p className="player-note">{props.empty}</p>;
  return (
    <ol className="question-list">
      {props.questions.map((question) => (
        <QuestionItem key={question.id} groupId={props.groupId} userId={props.userId} question={question} onChanged={props.onChanged} />
      ))}
    </ol>
  );
}

function QuestionItem(props: { groupId: string; userId: string; question: QuestionView; onChanged: () => void }) {
  const { question } = props;
  const [replying, setReplying] = useState(false);
  return (
    <li className="question" data-testid="question" data-question={question.id}>
      <p className="question-meta">
        <strong>{formatReference(question.anchor)}</strong>
        {question.status !== 'open' && <span className="question-status"> · {statusLabels[question.status]}</span>}
      </p>
      <Post groupId={props.groupId} userId={props.userId} post={question} target={{ questionId: question.id }} onChanged={props.onChanged} />
      {question.replies.length > 0 && (
        <ol className="replies" aria-label="Replies">
          {question.replies.map((reply) => (
            <li key={reply.id} data-testid="reply">
              <Post groupId={props.groupId} userId={props.userId} post={reply} target={{ replyId: reply.id }} onChanged={props.onChanged} />
            </li>
          ))}
        </ol>
      )}
      {replying ? (
        <ReplyForm
          groupId={props.groupId}
          questionId={question.id}
          onDone={(posted) => {
            setReplying(false);
            if (posted) props.onChanged();
          }}
        />
      ) : (
        <button type="button" className="link" onClick={() => setReplying(true)}>
          Reply
        </button>
      )}
    </li>
  );
}

function ReplyForm(props: { groupId: string; questionId: string; onDone: (posted: boolean) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opId = useOpId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.postReply(props.groupId, props.questionId, { clientOpId: opId.idFor(text), body: text });
      opId.reset();
      props.onDone(true);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="question-form" onSubmit={submit}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label="Your reply" required maxLength={4000} />
      {error && <p role="alert">{error}</p>}
      <div className="question-actions">
        <button type="submit" disabled={busy || !text.trim()}>
          Post reply
        </button>
        <button type="button" className="secondary" onClick={() => props.onDone(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// A question's or reply's text, with edit and delete for its author (S8.4, S8.5).
function Post(props: { groupId: string; userId: string; post: QuestionView | ReplyView; target: { questionId: string } | { replyId: string }; onChanged: () => void }) {
  const { post } = props;
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm-delete'>('view');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = post.author.userId === props.userId && !post.removed;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      setMode('view');
      setError(null);
    } catch (e) {
      // The draft stays; the latest version arrives with the reload below, and saving again replaces it.
      if (e instanceof ApiFailure && e.body.error === 'stale_revision') setError('This post changed since you opened it. Your text is kept — save again to replace it.');
      else setError(messageFor(e));
    } finally {
      setBusy(false);
      props.onChanged();
    }
  }

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(() => api.editPost(props.groupId, props.target, { expectedRevision: post.revision, body: draft }));
  };

  return (
    <div className="post">
      <p className="post-author">
        {post.author.displayName}
        {post.editedAt && !post.removed && <span className="post-edited"> · edited</span>}
      </p>
      {mode === 'edit' ? (
        <form className="question-form" onSubmit={save}>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} aria-label="Edit post" required maxLength={4000} />
          <div className="question-actions">
            <button type="submit" disabled={busy || !draft.trim()}>
              Save
            </button>
            <button type="button" className="secondary" onClick={() => setMode('view')}>
              Cancel
            </button>
          </div>
        </form>
      ) : post.removed ? (
        <p className="post-body post-removed">removed</p>
      ) : (
        <p className="post-body">{post.body}</p>
      )}
      {error && <p role="alert">{error}</p>}
      {mine && mode === 'view' && (
        <div className="question-actions">
          <button
            type="button"
            className="link"
            onClick={() => {
              setDraft(post.body ?? '');
              setMode('edit');
            }}
          >
            Edit
          </button>
          <button type="button" className="link" onClick={() => setMode('confirm-delete')}>
            Delete
          </button>
        </div>
      )}
      {mine && mode === 'confirm-delete' && (
        <div className="question-actions">
          <button type="button" disabled={busy} onClick={() => void run(() => api.deletePost(props.groupId, props.target))}>
            Delete for everyone
          </button>
          <button type="button" className="secondary" onClick={() => setMode('view')}>
            Keep
          </button>
        </div>
      )}
    </div>
  );
}
