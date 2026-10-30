import type { ConnectorToServer, ServerToConnector } from '../shared/api.ts';
import type { RuntimeClient, RuntimeEvent } from './runtime-client.ts';
import { RuntimeError } from './runtime-client.ts';

// Relays the server's dispatch, interrupt and resume to AgentConsole, and AgentConsole's events back as text
// and status. Tool activity is never relayed: it is denied, reported as tool_attempt, and the turn interrupted (I-26).

const initialCredit = 256;
const readPage = 1000;

interface Conversation {
  id: string;
  sessionId: string;
  subscriptionId: string | null;
  // The runtime turn that started and has not ended; message.delta frames carry no turn id of their own.
  openTurn: string | null;
  // Highest seq relayed, so a replay_gap resumes from there.
  through: number;
}

export interface ConnectorOptions {
  runtime: RuntimeClient;
  principal: string;
  // The directory a conversation's runtime session runs in. The runtime refuses a second live session in one
  // directory (workspace_busy), so each conversation gets its own.
  workspace(conversationId: string): string;
  provider: string;
  send(message: ConnectorToServer): void;
}

export interface Connector {
  handle(message: ServerToConnector): Promise<void>;
}

export function stopStatus(stopReason: unknown): 'completed' | 'interrupted' | 'failed' {
  if (stopReason === 'completed') return 'completed';
  if (stopReason === 'interrupted') return 'interrupted';
  return 'failed';
}

export function createConnector(options: ConnectorOptions): Connector {
  const { runtime, principal, send } = options;
  const conversations = new Map<string, Conversation>();
  const bySubscription = new Map<string, Conversation>();
  // Runtime turn → server turn, for turns dispatched through this process. Keyed by session as well, since
  // runtime turn ids are unique only within one session; dropped when the turn ends.
  const turnIds = new Map<string, string>();
  // Runtime turns already reported and interrupted for tool use, keyed the same way.
  const toolReported = new Set<string>();
  const turnKey = (sessionId: string, runtimeTurnId: string) => `${sessionId}:${runtimeTurnId}`;

  runtime.onEvent((subscriptionId, event) => {
    const conversation = bySubscription.get(subscriptionId);
    runtime.call('events.credit', { principal, subscriptionId, count: 1 }).catch(() => undefined);
    if (!conversation) return;
    if (event.kind === 'error' && event.data.kind === 'replay_gap') {
      void resubscribe(conversation);
      return;
    }
    void relay(conversation, event);
  });

  function forward(conversation: Conversation, event: RuntimeEvent, kind: 'delta' | 'message' | 'status' | 'tool_attempt', runtimeTurnId: string | null, extra: { text?: string; status?: 'streaming' | 'completed' | 'interrupted' | 'failed' }) {
    send({
      t: 'event',
      conversationId: conversation.id,
      runtimeSessionId: conversation.sessionId,
      seq: event.seq ?? 0,
      turnId: runtimeTurnId ? (turnIds.get(turnKey(conversation.sessionId, runtimeTurnId)) ?? null) : null,
      ...(runtimeTurnId ? { runtimeTurnId } : {}),
      kind,
      ...extra,
    });
  }

  async function stopForTool(conversation: Conversation, event: RuntimeEvent, runtimeTurnId: string | null) {
    if (!runtimeTurnId || toolReported.has(turnKey(conversation.sessionId, runtimeTurnId))) return;
    toolReported.add(turnKey(conversation.sessionId, runtimeTurnId));
    forward(conversation, event, 'tool_attempt', runtimeTurnId, {});
    await runtime.call('turns.interrupt', { sessionId: conversation.sessionId, principal, turnId: runtimeTurnId }).catch(() => undefined);
  }

  // One runtime event, as the server sees it. `live` is false for events replayed during a resume.
  async function relay(conversation: Conversation, event: RuntimeEvent, live = true): Promise<void> {
    if (event.seq !== undefined) conversation.through = Math.max(conversation.through, event.seq);
    const turnOf = typeof event.data.turnId === 'string' ? event.data.turnId : conversation.openTurn;
    switch (event.kind) {
      case 'message.delta':
        if (live && typeof event.data.text === 'string') forward(conversation, event, 'delta', conversation.openTurn, { text: event.data.text });
        return;
      case 'message':
        if (event.data.role === 'assistant' && typeof event.data.text === 'string' && event.data.text) forward(conversation, event, 'message', turnOf, { text: event.data.text });
        return;
      case 'turn.started':
        conversation.openTurn = turnOf;
        forward(conversation, event, 'status', turnOf, { status: 'streaming' });
        return;
      case 'turn.ended': {
        if (conversation.openTurn === turnOf) conversation.openTurn = null;
        const status = stopStatus(event.data.stopReason);
        forward(conversation, event, 'status', turnOf, { status, ...(status === 'failed' ? { text: String(event.data.stopReason ?? 'error') } : {}) });
        if (turnOf) {
          turnIds.delete(turnKey(conversation.sessionId, turnOf));
          toolReported.delete(turnKey(conversation.sessionId, turnOf));
        }
        return;
      }
      case 'permission.request':
        if (live && typeof event.data.requestId === 'string') {
          await runtime
            .call('permissions.respond', { sessionId: conversation.sessionId, principal, requestId: event.data.requestId, decision: 'deny', reason: 'The study assistant has no tools.' })
            .catch(() => undefined);
        }
        if (live) await stopForTool(conversation, event, turnOf);
        else forward(conversation, event, 'tool_attempt', turnOf, {});
        return;
      case 'tool.call':
      case 'tool.result':
        if (live) await stopForTool(conversation, event, turnOf);
        else forward(conversation, event, 'tool_attempt', turnOf, {});
        return;
      default:
        return;
    }
  }

  async function subscribe(conversation: Conversation, fromSeq: number) {
    const { subscriptionId } = await runtime.call<{ subscriptionId: string }>('events.subscribe', { sessionId: conversation.sessionId, principal, fromSeq });
    conversation.subscriptionId = subscriptionId;
    bySubscription.set(subscriptionId, conversation);
    await runtime.call('events.credit', { principal, subscriptionId, count: initialCredit });
  }

  async function unsubscribe(conversation: Conversation) {
    if (!conversation.subscriptionId) return;
    bySubscription.delete(conversation.subscriptionId);
    await runtime.call('events.unsubscribe', { principal, subscriptionId: conversation.subscriptionId }).catch(() => undefined);
    conversation.subscriptionId = null;
  }

  async function resubscribe(conversation: Conversation) {
    await unsubscribe(conversation);
    await subscribe(conversation, conversation.through).catch(() => undefined);
  }

  // Every logged event of a session, one page at a time.
  async function readAll(sessionId: string, each: (event: RuntimeEvent) => Promise<void>) {
    let after = 0;
    for (;;) {
      const page = await runtime.call<{ events: RuntimeEvent[]; nextSeq: number }>('events.read', { sessionId, principal, fromSeq: after, limit: readPage });
      for (const event of page.events) await each(event);
      if (page.events.length < readPage || page.nextSeq <= after) return;
      after = page.nextSeq;
    }
  }

  async function sessionExists(sessionId: string): Promise<{ lastSeq: number } | null> {
    try {
      const session = await runtime.call<{ lastSeq: number; state: string }>('sessions.get', { sessionId, principal });
      return session.state === 'ended' ? null : { lastSeq: session.lastSeq };
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'not_found') return null;
      throw error;
    }
  }

  // The conversation's session, created when the server has none or the runtime lost it.
  async function open(conversationId: string, runtimeSessionId: string | null): Promise<Conversation> {
    const known = conversations.get(conversationId);
    if (known && known.sessionId === runtimeSessionId) return known;
    // The server has no session when it missed the 'session' message (the link dropped); this one is still live.
    if (known && runtimeSessionId === null && (await sessionExists(known.sessionId))) {
      send({ t: 'session', conversationId, runtimeSessionId: known.sessionId });
      return known;
    }
    if (known) await unsubscribe(known);
    const existing = runtimeSessionId ? await sessionExists(runtimeSessionId) : null;
    let conversation: Conversation;
    if (runtimeSessionId && existing) {
      conversation = { id: conversationId, sessionId: runtimeSessionId, subscriptionId: null, openTurn: null, through: existing.lastSeq };
    } else {
      const created = await runtime.call<{ sessionId: string }>('sessions.create', { principal, provider: options.provider, cwd: options.workspace(conversationId), sandbox: null });
      conversation = { id: conversationId, sessionId: created.sessionId, subscriptionId: null, openTurn: null, through: 0 };
      send({ t: 'session', conversationId, runtimeSessionId: created.sessionId });
    }
    conversations.set(conversationId, conversation);
    await subscribe(conversation, conversation.through);
    return conversation;
  }

  async function dispatch(message: Extract<ServerToConnector, { t: 'dispatch' }>) {
    try {
      const conversation = await open(message.conversationId, message.runtimeSessionId);
      const { turnId } = await runtime.call<{ turnId: string }>('turns.send', { sessionId: conversation.sessionId, principal, text: message.text });
      turnIds.set(turnKey(conversation.sessionId, turnId), message.turnId);
      send({ t: 'accepted', turnId: message.turnId, runtimeSessionId: conversation.sessionId, runtimeTurnId: turnId });
    } catch (error) {
      const reason = error instanceof RuntimeError ? error.code : 'connector_error';
      send({ t: 'failed', turnId: message.turnId, reason, retryable: false });
    }
  }

  async function resume(message: Extract<ServerToConnector, { t: 'resume' }>) {
    const exists = await sessionExists(message.runtimeSessionId);
    if (!exists) {
      send({ t: 'resumed', conversationId: message.conversationId, sessionFound: false, activeRuntimeTurnId: null });
      return;
    }
    const known = conversations.get(message.conversationId);
    if (known) await unsubscribe(known);
    const conversation: Conversation = { id: message.conversationId, sessionId: message.runtimeSessionId, subscriptionId: null, openTurn: null, through: 0 };
    conversations.set(message.conversationId, conversation);
    // The whole log decides which turn is still open; only what the server has not stored is resent.
    await readAll(conversation.sessionId, async (event) => {
      const turnOf = typeof event.data.turnId === 'string' ? event.data.turnId : null;
      if (event.kind === 'turn.started') conversation.openTurn = turnOf;
      if (event.kind === 'turn.ended' && conversation.openTurn === turnOf) conversation.openTurn = null;
      if ((event.seq ?? 0) > message.fromSeq) await relay(conversation, event, false);
      else if (event.seq !== undefined) conversation.through = Math.max(conversation.through, event.seq);
    });
    await subscribe(conversation, conversation.through);
    send({ t: 'resumed', conversationId: conversation.id, sessionFound: true, activeRuntimeTurnId: conversation.openTurn });
  }

  return {
    async handle(message) {
      switch (message.t) {
        case 'ping':
          send({ t: 'pong' });
          return;
        case 'dispatch':
          return dispatch(message);
        case 'interrupt':
          await runtime.call('turns.interrupt', { sessionId: message.runtimeSessionId, principal, turnId: message.runtimeTurnId }).catch(() => undefined);
          return;
        case 'resume':
          // A failure here leaves the turns uncertain; the caller drops the link so the next hello resumes again.
          return resume(message);
      }
    },
  };
}
