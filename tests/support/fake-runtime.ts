import type { RuntimeClient, RuntimeEvent } from '../../src/connector/runtime-client.ts';
import { RuntimeError } from '../../src/connector/runtime-client.ts';

// An in-memory AgentConsole runtime for the connector: sessions with an event log, subscriptions that replay
// then follow it, and turns whose course the test picks. The real runtime is exercised by assistant-runtime.test.ts.

export type TurnScript = 'complete' | 'hold' | 'tool';

interface Session {
  cwd: string;
  events: RuntimeEvent[];
  openTurn: string | null;
}

let instances = 0;

export class FakeRuntime implements RuntimeClient {
  readonly sessions = new Map<string, Session>();
  // Every turns.send, with the text the runtime received.
  readonly sent: { sessionId: string; turnId: string; text: string }[] = [];
  readonly decisions: { requestId: string; decision: string }[] = [];
  readonly interrupts: string[] = [];
  script: TurnScript = 'complete';
  answer = ['The righteous ', 'shall live by faith.'];
  private subscriptions = new Map<string, { sessionId: string; through: number }>();
  private listeners: ((subscriptionId: string, event: RuntimeEvent) => void)[] = [];
  private nextId = 0;
  // Session ids are unique across runtimes, as the real runtime's UUIDs are; turn ids and seqs restart in each.
  private readonly instance = ++instances;

  private id(prefix: string): string {
    return `${prefix}-${++this.nextId}`;
  }

  // Appends to the log (unless a frame) and delivers to every subscription of the session.
  emit(sessionId: string, kind: string, data: Record<string, unknown>, frame = false): void {
    const session = this.sessions.get(sessionId)!;
    const event: RuntimeEvent = frame ? { kind, data } : { seq: session.events.length + 1, kind, data };
    if (!frame) session.events.push(event);
    for (const [subscriptionId, sub] of this.subscriptions) {
      if (sub.sessionId !== sessionId) continue;
      if (event.seq !== undefined) sub.through = event.seq;
      for (const listener of this.listeners) listener(subscriptionId, event);
    }
  }

  // The runtime process restarted: its subscriptions and listeners are gone, its logged sessions remain.
  restart(): void {
    this.subscriptions.clear();
    this.listeners = [];
  }

  // Finishes a held turn as the model would.
  finish(sessionId: string, turnId: string): void {
    for (const text of this.answer) this.emit(sessionId, 'message.delta', { role: 'assistant', text }, true);
    this.emit(sessionId, 'message', { turnId, role: 'assistant', text: this.answer.join('') });
    this.emit(sessionId, 'turn.ended', { turnId, stopReason: 'completed' });
    this.sessions.get(sessionId)!.openTurn = null;
  }

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const result = this.dispatch(method, params);
    // Answers arrive on a later tick, as they would over stdio.
    await new Promise((resolve) => setImmediate(resolve));
    return result as T;
  }

  private session(params: Record<string, unknown>): Session {
    const session = this.sessions.get(String(params.sessionId));
    if (!session) throw new RuntimeError('not_found', 'no such session');
    return session;
  }

  private dispatch(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'sessions.create': {
        // As the real runtime: one live session per working directory.
        if ([...this.sessions.values()].some((s) => s.cwd === params.cwd)) throw new RuntimeError('workspace_busy', 'a session is live in that directory');
        const id = this.id(`rt-session-${this.instance}`);
        this.sessions.set(id, { cwd: String(params.cwd), events: [], openTurn: null });
        return { sessionId: id };
      }
      case 'sessions.get': {
        const session = this.session(params);
        return { lastSeq: session.events.length, state: 'live' };
      }
      case 'events.subscribe': {
        const session = this.session(params);
        const subscriptionId = this.id('sub');
        const fromSeq = Number(params.fromSeq);
        this.subscriptions.set(subscriptionId, { sessionId: String(params.sessionId), through: session.events.length });
        const replay = session.events.filter((e) => (e.seq ?? 0) > fromSeq);
        setImmediate(() => {
          for (const event of replay) for (const listener of this.listeners) listener(subscriptionId, event);
        });
        return { subscriptionId };
      }
      case 'events.unsubscribe':
        this.subscriptions.delete(String(params.subscriptionId));
        return {};
      case 'events.credit':
        return {};
      case 'events.read': {
        const session = this.session(params);
        const fromSeq = Number(params.fromSeq);
        const events = session.events.filter((e) => (e.seq ?? 0) > fromSeq).slice(0, Number(params.limit));
        return { events, nextSeq: events.at(-1)?.seq ?? fromSeq };
      }
      case 'turns.send': {
        const sessionId = String(params.sessionId);
        const session = this.session(params);
        if (session.openTurn) throw new RuntimeError('turn_in_flight', 'a turn is open');
        const turnId = this.id('rt-turn');
        this.sent.push({ sessionId, turnId, text: String(params.text) });
        session.openTurn = turnId;
        setImmediate(() => {
          this.emit(sessionId, 'message', { turnId, role: 'user', text: String(params.text) });
          this.emit(sessionId, 'turn.started', { turnId });
          if (this.script === 'complete') this.finish(sessionId, turnId);
          if (this.script === 'tool') this.emit(sessionId, 'permission.request', { turnId, requestId: this.id('perm'), tool: 'Bash' });
          if (this.script === 'hold') this.emit(sessionId, 'message.delta', { role: 'assistant', text: this.answer[0] }, true);
        });
        return { turnId };
      }
      case 'turns.interrupt': {
        const sessionId = String(params.sessionId);
        const session = this.session(params);
        this.interrupts.push(String(params.turnId));
        if (session.openTurn === params.turnId) {
          session.openTurn = null;
          setImmediate(() => this.emit(sessionId, 'turn.ended', { turnId: params.turnId, stopReason: 'interrupted' }));
        }
        return {};
      }
      case 'permissions.respond':
        this.decisions.push({ requestId: String(params.requestId), decision: String(params.decision) });
        return {};
      default:
        throw new RuntimeError('bad_request', `fake runtime does not implement ${method}`);
    }
  }

  onEvent(listener: (subscriptionId: string, event: RuntimeEvent) => void): void {
    this.listeners.push(listener);
  }

  onExit(): void {}

  stop(): void {}
}
