import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AssistantEvent, AssistantStatus, AssistantTranscript, AssistantTurnView, NoteView, PassageRef, TranslationId } from '../shared/api.ts';
import { terminalTurnStatuses } from '../shared/api.ts';
import { formatReference } from '../shared/reference.ts';
import { api, messageFor } from './api.ts';
import type { LiveStatus } from './live.ts';
import { connectLive } from './live.ts';

// The study assistant: its owner asks about the passage on screen and watches the answer stream in.
// Everyone else never sees it. The server keeps the transcript; live events fill it in between fetches,
// and a reconnect fetches what came after the last entry this page holds.

const statusEveryMs = 15_000;

// `notes` are the reader's own notes on this chapter; the ones they tick go with the question (S12.5).
export function AssistantPanel(props: { translationId: TranslationId; at: PassageRef; notes: NoteView[] }) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);

  useEffect(() => {
    let current = true;
    const check = () =>
      api
        .assistantStatus()
        .then((s) => current && setStatus(s))
        .catch(() => undefined);
    void check();
    const timer = setInterval(check, statusEveryMs);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, []);

  if (!status || status.state === 'not_permitted') return null;
  return <Conversation status={status} onStatus={setStatus} translationId={props.translationId} at={props.at} notes={props.notes} />;
}

const isTerminal = (turn: AssistantTurnView) => terminalTurnStatuses.includes(turn.status);

function without(all: Record<string, string>, turnId: string): Record<string, string> {
  const rest = { ...all };
  delete rest[turnId];
  return rest;
}

function outcome(turn: AssistantTurnView): string | null {
  switch (turn.status) {
    case 'queued':
    case 'dispatched':
      return 'Waiting for the assistant…';
    case 'uncertain':
      return 'Connection lost — checking whether the answer finished';
    case 'interrupted':
      return 'Stopped.';
    case 'failed':
      if (turn.failure === 'tool_attempt') return 'The assistant tried to use a tool; this turn was stopped';
      return turn.failure === 'connector_offline' || turn.failure === 'not_delivered'
        ? 'Not sent: the study assistant went offline.'
        : 'This answer did not finish.';
    default:
      return null;
  }
}

function Conversation(props: {
  status: AssistantStatus;
  onStatus: (status: AssistantStatus) => void;
  translationId: TranslationId;
  at: PassageRef;
  notes: NoteView[];
}) {
  const [attached, setAttached] = useState<string[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<AssistantTurnView[]>([]);
  // Stored answers by turn, keyed by transcript position so a refetch never shows one twice.
  const [answers, setAnswers] = useState<Record<string, Record<number, string>>>({});
  // Text streamed for a turn whose answer is not stored yet.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [live, setLive] = useState<LiveStatus>('connecting');
  const cursor = useRef(0);
  const conversation = useRef<string | null>(null);
  // Kept until the send is answered, so a retry after a dropped response is the same turn. A changed
  // question or passage is a new turn.
  const pendingTurn = useRef<{ id: string; key: string } | null>(null);
  // The turns as last rendered, for the event handlers.
  const turnsRef = useRef<AssistantTurnView[]>([]);
  // Only the newest fetch is applied, so a slow one never puts back an older state.
  const fetchGeneration = useRef(0);
  // Turns already under way when this page fetched them: the text streamed before is gone, so their
  // deltas would show a fragment. They show a note until the stored answer arrives.
  const [partial, setPartial] = useState<ReadonlySet<string>>(new Set());
  const partialRef = useRef<ReadonlySet<string>>(new Set());

  function showTurns(next: AssistantTurnView[]) {
    turnsRef.current = next;
    setTurns(next);
  }

  function markPartial(next: ReadonlySet<string>) {
    partialRef.current = next;
    setPartial(next);
  }

  function addAnswer(turnId: string, position: number, text: string) {
    cursor.current = Math.max(cursor.current, position);
    setAnswers((all) => ({ ...all, [turnId]: { ...all[turnId], [position]: text } }));
    setDrafts((all) => without(all, turnId));
  }

  // `missed` is true when this page may have missed deltas (first load, reconnect): open turns become partial.
  function absorb(transcript: AssistantTranscript, missed: boolean) {
    // A fetch answered before a turn finished, or before it was sent, never takes back what an event already showed:
    // a finished turn stays finished, and a turn sent from this page stays listed.
    const known = new Map(turnsRef.current.map((t) => [t.id, t]));
    const fetched = transcript.turns.map((t) => {
      const local = known.get(t.id);
      return local && isTerminal(local) && !isTerminal(t) ? local : t;
    });
    const listed = new Set(fetched.map((t) => t.id));
    showTurns([...fetched, ...turnsRef.current.filter((t) => !listed.has(t.id))]);
    for (const entry of transcript.entries) if (entry.kind === 'message') addAnswer(entry.turnId, entry.seq, entry.text);
    const open = new Set(transcript.turns.filter((t) => !isTerminal(t)).map((t) => t.id));
    if (missed) markPartial(open);
    // Drafts of finished turns are replaced by their stored answers.
    setDrafts((all) => Object.fromEntries(Object.entries(all).filter(([id]) => open.has(id) && !partialRef.current.has(id))));
  }

  async function refresh(missed = false) {
    if (!conversation.current) return;
    const generation = ++fetchGeneration.current;
    try {
      const transcript = await api.assistantTranscript(conversation.current, cursor.current);
      if (generation === fetchGeneration.current) absorb(transcript, missed);
    } catch {
      // The next reconnect or event tries again.
    }
  }

  function apply(event: AssistantEvent) {
    switch (event.kind) {
      case 'delta':
        if (partialRef.current.has(event.turnId)) return;
        setDrafts((all) => ({ ...all, [event.turnId]: (all[event.turnId] ?? '') + event.text }));
        return;
      case 'message':
        addAnswer(event.turnId, event.seq, event.text);
        return;
      case 'turn_status': {
        // A turn sent from another tab: fetch it.
        if (!turnsRef.current.some((t) => t.id === event.turnId)) {
          void refresh();
          return;
        }
        showTurns(
          turnsRef.current.map((t) => {
            if (t.id !== event.turnId) return t;
            const next: AssistantTurnView = { id: t.id, prompt: t.prompt, status: event.status };
            if (event.failure) next.failure = event.failure;
            return next;
          }),
        );
        if (terminalTurnStatuses.includes(event.status)) {
          setDrafts((all) => without(all, event.turnId));
          if (partialRef.current.has(event.turnId)) markPartial(new Set([...partialRef.current].filter((id) => id !== event.turnId)));
        }
        return;
      }
    }
  }

  useEffect(() => {
    let current = true;
    api
      .latestConversation()
      .then(async ({ id }) => {
        if (!current || !id) return;
        conversation.current = id;
        setConversationId(id);
        const generation = ++fetchGeneration.current;
        const transcript = await api.assistantTranscript(id, 0);
        if (current && generation === fetchGeneration.current) absorb(transcript, true);
      })
      .catch((e) => current && setError(messageFor(e)));

    let wasOpen = false;
    const channel = connectLive({
      onMessage: (message) => {
        if (message.t === 'assistant') apply(message.event);
      },
      onStatus: (s) => {
        setLive(s);
        if (s === 'open') {
          // Whatever happened while the page was away, or before the channel first opened, is in the transcript.
          void refresh(true);
          if (wasOpen) api.assistantStatus().then(props.onStatus, () => undefined);
          wasOpen = true;
        }
      },
    });
    return () => {
      current = false;
      channel.close();
    };
    // Mounted once per page; the handlers read refs, not props.
  }, []);

  const active = turns.find((t) => !isTerminal(t)) ?? null;
  const online = props.status.state === 'online';
  const reconnecting = live === 'reconnecting' && active !== null;

  async function ask(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      let id = conversation.current;
      if (!id) {
        id = (await api.createConversation()).id;
        conversation.current = id;
        setConversationId(id);
      }
      // Only ticked notes still on this chapter go; moving on drops the rest.
      const noteIds = attached.filter((noteId) => props.notes.some((n) => n.id === noteId));
      const key = JSON.stringify([id, text, props.translationId, props.at, noteIds]);
      if (pendingTurn.current?.key !== key) pendingTurn.current = { id: crypto.randomUUID(), key };
      const result = await api.sendTurn(id, {
        clientTurnId: pendingTurn.current.id,
        prompt: text,
        context: { translationId: props.translationId, ref: props.at, noteIds },
      });
      pendingTurn.current = null;
      setPrompt('');
      setAttached([]);
      if (!turnsRef.current.some((t) => t.id === result.turnId)) showTurns([...turnsRef.current, { id: result.turnId, prompt: text, status: result.status }]);
      if (result.existing || result.status === 'failed') await refresh();
    } catch (e) {
      setError(messageFor(e));
      if (!online) pendingTurn.current = null;
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (!active) return;
    try {
      await api.interruptTurn(active.id);
    } catch (e) {
      setError(messageFor(e));
    }
  }

  return (
    <section className="assistant" aria-label="Study assistant" data-conversation={conversationId ?? undefined}>
      <h2>Ask about {formatReference(props.at)}</h2>
      {!online && <p role="status">Study assistant offline (PC not connected)</p>}
      {turns.length > 0 && (
        <ol className="assistant-turns">
          {turns.map((turn) => {
            const stored = Object.entries(answers[turn.id] ?? {}).sort(([a], [b]) => Number(a) - Number(b));
            const draft = drafts[turn.id];
            const note =
              reconnecting && turn === active
                ? 'Connection lost — checking whether the answer finished'
                : (outcome(turn) ?? (partial.has(turn.id) && stored.length === 0 ? 'Answer in progress…' : null));
            return (
              <li key={turn.id} data-status={turn.status}>
                <p className="assistant-prompt">{turn.prompt}</p>
                {stored.map(([position, text]) => (
                  <p key={position} className="assistant-answer">
                    {text}
                  </p>
                ))}
                {draft && stored.length === 0 && (
                  <p className="assistant-answer" aria-busy="true">
                    {draft}
                  </p>
                )}
                {note && (
                  <p className="assistant-note" role={turn.failure === 'tool_attempt' ? 'alert' : 'status'}>
                    {note}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <form onSubmit={ask}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What does this passage say about…"
          aria-label="Question for the study assistant"
          rows={3}
          maxLength={4000}
        />
        {props.notes.length > 0 && (
          <fieldset className="assistant-notes">
            <legend>Include my notes</legend>
            {props.notes.map((note) => (
              <label key={note.id}>
                <input
                  type="checkbox"
                  checked={attached.includes(note.id)}
                  onChange={(e) => setAttached(e.target.checked ? [...attached, note.id] : attached.filter((noteId) => noteId !== note.id))}
                />{' '}
                {formatReference(note.anchor)}: {note.body.length > 60 ? `${note.body.slice(0, 60)}…` : note.body}
              </label>
            ))}
          </fieldset>
        )}
        <div className="assistant-actions">
          {active ? (
            <button type="button" className="secondary" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!online || sending || prompt.trim() === ''}>
              Ask
            </button>
          )}
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
