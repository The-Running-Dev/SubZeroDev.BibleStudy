import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AssistantEvent, AssistantStatus, AssistantTranscript, AssistantTurnView, PassageRef, TranslationId } from '../shared/api.ts';
import { terminalTurnStatuses } from '../shared/api.ts';
import { formatReference } from '../shared/reference.ts';
import { api, messageFor } from './api.ts';
import type { LiveStatus } from './live.ts';
import { connectLive } from './live.ts';

// The study assistant: its owner asks about the passage on screen and watches the answer stream in.
// Everyone else never sees it. The server keeps the transcript; live events fill it in between fetches,
// and a reconnect fetches what came after the last entry this page holds.

const statusEveryMs = 15_000;

export function AssistantPanel(props: { translationId: TranslationId; at: PassageRef }) {
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
  return <Conversation status={status} onStatus={setStatus} translationId={props.translationId} at={props.at} />;
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

function Conversation(props: { status: AssistantStatus; onStatus: (status: AssistantStatus) => void; translationId: TranslationId; at: PassageRef }) {
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
  // Kept until the send is answered, so a retry after a dropped response is the same turn.
  const pendingTurnId = useRef<string | null>(null);

  function addAnswer(turnId: string, position: number, text: string) {
    cursor.current = Math.max(cursor.current, position);
    setAnswers((all) => ({ ...all, [turnId]: { ...all[turnId], [position]: text } }));
    setDrafts((all) => without(all, turnId));
  }

  function absorb(transcript: AssistantTranscript) {
    setTurns(transcript.turns);
    for (const entry of transcript.entries) if (entry.kind === 'message') addAnswer(entry.turnId, entry.seq, entry.text);
    const done = new Set(transcript.turns.filter(isTerminal).map((t) => t.id));
    setDrafts((all) => Object.fromEntries(Object.entries(all).filter(([id]) => !done.has(id))));
  }

  async function refresh() {
    if (!conversation.current) return;
    try {
      absorb(await api.assistantTranscript(conversation.current, cursor.current));
    } catch {
      // The next reconnect or event tries again.
    }
  }

  function apply(event: AssistantEvent) {
    switch (event.kind) {
      case 'delta':
        setDrafts((all) => ({ ...all, [event.turnId]: (all[event.turnId] ?? '') + event.text }));
        return;
      case 'message':
        addAnswer(event.turnId, event.seq, event.text);
        return;
      case 'turn_status': {
        let known = false;
        setTurns((all) =>
          all.map((t) => {
            if (t.id !== event.turnId) return t;
            known = true;
            const next: AssistantTurnView = { id: t.id, prompt: t.prompt, status: event.status };
            if (event.failure) next.failure = event.failure;
            return next;
          }),
        );
        if (terminalTurnStatuses.includes(event.status)) setDrafts((all) => without(all, event.turnId));
        // A turn sent from another tab: fetch it.
        if (!known) void refresh();
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
        const transcript = await api.assistantTranscript(id, 0);
        if (current) absorb(transcript);
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
          // Whatever happened while the page was away is in the transcript.
          if (wasOpen) {
            void refresh();
            api.assistantStatus().then(props.onStatus, () => undefined);
          }
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
      pendingTurnId.current ??= crypto.randomUUID();
      const result = await api.sendTurn(id, {
        clientTurnId: pendingTurnId.current,
        prompt: text,
        context: { translationId: props.translationId, ref: props.at, noteIds: [] },
      });
      pendingTurnId.current = null;
      setPrompt('');
      setTurns((all) => (all.some((t) => t.id === result.turnId) ? all : [...all, { id: result.turnId, prompt: text, status: result.status }]));
      if (result.existing || result.status === 'failed') await refresh();
    } catch (e) {
      setError(messageFor(e));
      if (!online) pendingTurnId.current = null;
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
            const note = reconnecting && turn === active ? 'Connection lost — checking whether the answer finished' : outcome(turn);
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
