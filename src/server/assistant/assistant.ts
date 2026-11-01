import type {
  AssistantEvent,
  AssistantStatus,
  AssistantTranscript,
  AssistantTurnStatus,
  ChapterView,
  ConnectorToServer,
  PassageRef,
  SendTurnResponse,
  ServerToConnector,
  TranslationId,
} from '../../shared/api.ts';
import { terminalTurnStatuses } from '../../shared/api.ts';
import { bookById } from '../../shared/books.ts';
import { formatReference, maxVerse } from '../../shared/reference.ts';
import { contentAccess } from '../content/access.ts';
import { getChapter, parseTranslationId } from '../content/catalog.ts';
import type { Csb } from '../content/catalog.ts';
import { ownNotes } from '../personal/personal.ts';
import type { Clock } from '../platform/clock.ts';
import type { Config } from '../platform/config.ts';
import type { Db } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import { isUuid, uuidv7 } from '../platform/ids.ts';
import { log } from '../platform/log.ts';
import type { RealtimeHub } from '../study/realtime.ts';

// The study assistant: the owner's conversations, and the one link to the connector on their PC.
// The connector relays AgentConsole; this module decides turn state, and only text and status reach a browser (I-25).

export const maxPromptLength = 4_000;
// The server pings every 10 s; a link that sends nothing for 30 s is offline (design: connector).
const pingEveryMs = 10_000;
const silentLinkMs = 30_000;

// The part of a WebSocket the link needs; `ws` sockets satisfy it.
export interface LinkSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface Assistant {
  status(userId: string): Promise<AssistantStatus>;
  latestConversation(userId: string): Promise<{ id: string | null }>;
  createConversation(userId: string): Promise<{ id: string }>;
  transcript(userId: string, conversationId: string, afterSeq: number): Promise<AssistantTranscript>;
  sendTurn(userId: string, conversationId: string, body: unknown): Promise<SendTurnResponse>;
  interrupt(userId: string, turnId: string): Promise<{ status: AssistantTurnStatus }>;
  // A connector authenticated on /connector. A second link replaces the first.
  attach(socket: LinkSocket): { message(raw: unknown): void; closed(): void };
  stop(): void;
}

export interface AssistantDeps {
  db: Db;
  clock: Clock;
  config: Config;
  hub: RealtimeHub;
  csb: Csb | null;
}

interface TurnRow {
  id: string;
  conversation_id: string;
  user_id: string;
  status: AssistantTurnStatus;
  failure: string | null;
  runtime_turn_id: string | null;
  runtime_session_id: string | null;
}

interface Link {
  socket: LinkSocket;
  // Set by hello; the link is online only from then.
  runtimeVersion: string | null;
  lastHeard: number;
}

const inFlight = ['queued', 'dispatched', 'streaming', 'uncertain'];
const isTerminal = (status: AssistantTurnStatus) => terminalTurnStatuses.includes(status);
const turnStatuses: AssistantTurnStatus[] = ['queued', 'dispatched', 'streaming', 'completed', 'interrupted', 'failed', 'uncertain'];

const notPermitted = () => new AppError('assistant_not_permitted', 403, 'The study assistant is available to its owner only.');
const offline = () => new AppError('assistant_offline', 503, 'Study assistant offline (PC not connected).', { retryable: true });
const notFound = () => new AppError('not_found', 404, 'No such conversation.');
const invalid = (message: string) => new AppError('invalid_request', 400, message);

const int = (value: unknown): value is number => Number.isInteger(value);
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);

function parseRef(value: unknown): PassageRef {
  const p = value as Record<string, unknown> | null;
  if (!p || typeof p !== 'object' || typeof p.bookId !== 'string' || !int(p.chapter)) throw invalid('context.ref is { bookId, chapter, startVerse, endVerse }.');
  const verse = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    if (!int(v) || v < 1 || v > maxVerse) throw invalid('Verses are whole numbers from 1.');
    return v;
  };
  const startVerse = verse(p.startVerse);
  const endVerse = startVerse === null ? null : (verse(p.endVerse) ?? startVerse);
  if (endVerse !== null && startVerse !== null && endVerse < startVerse) throw invalid('The passage ends before it starts.');
  return { bookId: p.bookId, chapter: p.chapter, startVerse, endVerse };
}

interface TurnInput {
  clientTurnId: string;
  prompt: string;
  translationId: TranslationId;
  ref: PassageRef;
  noteIds: string[];
}

// Notes a reader can hand the assistant with one question.
export const maxNotesPerTurn = 20;

function parseTurn(body: unknown): TurnInput {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') throw invalid('Send { clientTurnId, prompt, context }.');
  if (!isUuid(b.clientTurnId)) throw invalid('clientTurnId is a UUID.');
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt || prompt.length > maxPromptLength) throw invalid(`Ask something, up to ${maxPromptLength} characters.`);
  // Postgres text cannot hold NUL.
  if (prompt.includes('\u0000')) throw invalid('The question contains a character that cannot be stored.');
  const context = b.context as Record<string, unknown> | null;
  if (!context || typeof context !== 'object') throw invalid('context is { translationId, ref, noteIds }.');
  const noteIds = context.noteIds;
  if (!Array.isArray(noteIds) || noteIds.length > maxNotesPerTurn || !noteIds.every(isUuid)) {
    throw invalid(`noteIds is a list of at most ${maxNotesPerTurn} note ids.`);
  }
  // Ids are stored lowercase; an uppercase one names the same note.
  const ids = noteIds.map((id: string) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw invalid('Each note can be attached once.');
  return { clientTurnId: b.clientTurnId, prompt, translationId: parseTranslationId(context.translationId), ref: parseRef(context.ref), noteIds: ids };
}

// Narrows a connector message; null when its shape is wrong.
export function parseConnectorMessage(raw: unknown): ConnectorToServer | null {
  let m: Record<string, unknown> | null;
  try {
    m = JSON.parse(String(raw)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const id = (v: unknown) => text(v, 200);
  switch (m.t) {
    case 'hello':
      return id(m.runtimeVersion) && id(m.provider) && (m.sandbox === null || id(m.sandbox))
        ? { t: 'hello', runtimeVersion: m.runtimeVersion as string, provider: m.provider as string, sandbox: m.sandbox as string | null }
        : null;
    case 'session':
      return isUuid(m.conversationId) && id(m.runtimeSessionId) ? { t: 'session', conversationId: m.conversationId, runtimeSessionId: m.runtimeSessionId as string } : null;
    case 'accepted':
      return isUuid(m.turnId) && id(m.runtimeSessionId) && id(m.runtimeTurnId)
        ? { t: 'accepted', turnId: m.turnId, runtimeSessionId: m.runtimeSessionId as string, runtimeTurnId: m.runtimeTurnId as string }
        : null;
    case 'event': {
      const kinds = ['delta', 'message', 'status', 'tool_attempt'];
      if (!isUuid(m.conversationId) || !id(m.runtimeSessionId) || !int(m.seq) || m.seq < 0 || typeof m.kind !== 'string' || !kinds.includes(m.kind)) return null;
      if (m.turnId !== null && !isUuid(m.turnId)) return null;
      if (m.runtimeTurnId !== undefined && !id(m.runtimeTurnId)) return null;
      if (m.text !== undefined && typeof m.text !== 'string') return null;
      if (m.kind === 'status' && !turnStatuses.includes(m.status as AssistantTurnStatus)) return null;
      return {
        t: 'event',
        conversationId: m.conversationId,
        runtimeSessionId: m.runtimeSessionId as string,
        seq: m.seq,
        turnId: m.turnId as string | null,
        ...(m.runtimeTurnId === undefined ? {} : { runtimeTurnId: m.runtimeTurnId as string }),
        kind: m.kind as 'delta' | 'message' | 'status' | 'tool_attempt',
        // Postgres text cannot hold NUL, so a runtime that emits one does not fail the store.
        ...(m.text === undefined ? {} : { text: (m.text as string).replaceAll('\u0000', '') }),
        ...(m.kind === 'status' ? { status: m.status as AssistantTurnStatus } : {}),
      };
    }
    case 'resumed':
      return isUuid(m.conversationId) && typeof m.sessionFound === 'boolean' && (m.activeRuntimeTurnId === null || id(m.activeRuntimeTurnId))
        ? { t: 'resumed', conversationId: m.conversationId, sessionFound: m.sessionFound, activeRuntimeTurnId: m.activeRuntimeTurnId as string | null }
        : null;
    case 'failed':
      return isUuid(m.turnId) && id(m.reason) ? { t: 'failed', turnId: m.turnId, reason: m.reason as string, retryable: false } : null;
    case 'pong':
      return { t: 'pong' };
    default:
      return null;
  }
}

export interface ContextNote {
  id: string;
  reference: string;
  body: string;
}

// What the runtime is asked: the rules, the passage as the reader sees it, the reader's chosen notes, then the question.
export function dispatchText(
  prompt: string,
  reference: string,
  translationId: TranslationId,
  verses: { number: number; text: string }[],
  notes: ContextNote[] = [],
): string {
  return [
    'You are a Bible study assistant answering one reader about the passage below.',
    'You have no tools. Do not try to read files, run commands or browse; answer from the passage and general knowledge.',
    'Quote the passage exactly as given when you quote it.',
    '',
    `Passage: ${reference} (${translationId})`,
    ...verses.map((v) => `${v.number} ${v.text}`),
    ...(notes.length ? ['', "The reader's own notes:", ...notes.map((n) => `- ${n.reference}: ${n.body}`)] : []),
    '',
    `Question: ${prompt}`,
  ].join('\n');
}

export function createAssistant(deps: AssistantDeps): Assistant {
  const { db, clock, config, hub, csb } = deps;
  let link: Link | null = null;
  let offlineSince: Date | null = null;
  // Interrupts asked for before the runtime named the turn; sent once `accepted` arrives.
  const pendingInterrupts = new Set<string>();
  // Link messages and link changes are handled one at a time, in arrival order.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work).catch((error: Error) => log('error', 'assistant link handling failed', { error: error.message }));
  };

  const online = () => link !== null && link.runtimeVersion !== null;

  function send(message: ServerToConnector): boolean {
    if (!link || link.runtimeVersion === null) return false;
    try {
      link.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  const heartbeat = setInterval(() => {
    if (!link) return;
    if (Date.now() - link.lastHeard > silentLinkMs) {
      link.socket.terminate();
      return;
    }
    try {
      link.socket.send(JSON.stringify({ t: 'ping' } satisfies ServerToConnector));
    } catch {
      // Closing; its close event drops the link.
    }
  }, pingEveryMs);
  heartbeat.unref();

  function fanOut(userId: string, event: AssistantEvent): void {
    hub.sendToUser(userId, { t: 'assistant', event });
  }

  function statusEvent(row: { id: string; status: AssistantTurnStatus; failure: string | null }): AssistantEvent {
    return { kind: 'turn_status', turnId: row.id, status: row.status, ...(row.failure ? { failure: row.failure } : {}) };
  }

  // Moves a turn to `status` unless it already finished; terminal states never change. Tells the owner when it moved.
  async function transition(turnId: string, status: AssistantTurnStatus, failure: string | null, from: string[] = inFlight): Promise<boolean> {
    const result = await db.query<{ id: string; status: AssistantTurnStatus; failure: string | null; user_id: string }>(
      `UPDATE assistant_turns t SET status = $2, failure = $3
         FROM assistant_conversations c
        WHERE t.id = $1 AND c.id = t.conversation_id AND t.status = ANY($4::text[]) AND t.status <> $2
        RETURNING t.id, t.status, t.failure, c.user_id`,
      [turnId, status, failure, from],
    );
    const row = result.rows[0];
    if (row) fanOut(row.user_id, statusEvent(row));
    return Boolean(row);
  }

  // Turns a link was carrying when it went away: whether they finished is unknown until the connector resumes.
  async function strandInFlight(): Promise<void> {
    const stranded = await db.query<{ id: string }>(`SELECT id FROM assistant_turns WHERE status IN ('dispatched', 'streaming')`);
    for (const row of stranded.rows) await transition(row.id, 'uncertain', null, ['dispatched', 'streaming']);
    const queued = await db.query<{ id: string }>(`SELECT id FROM assistant_turns WHERE status = 'queued'`);
    for (const row of queued.rows) await transition(row.id, 'failed', 'connector_offline', ['queued']);
  }

  async function requireOwner(userId: string): Promise<void> {
    if (!config.assistantOwnerEmail) throw notPermitted();
    const result = await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
    if (result.rows[0]?.email !== config.assistantOwnerEmail) throw notPermitted();
  }

  async function ownedConversation(userId: string, conversationId: string): Promise<{ id: string; runtime_session_id: string | null }> {
    if (!isUuid(conversationId)) throw notFound();
    const result = await db.query<{ id: string; runtime_session_id: string | null }>(
      'SELECT id, runtime_session_id FROM assistant_conversations WHERE id = $1 AND user_id = $2',
      [conversationId, userId],
    );
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }

  // A turn's own runtime session, once known; until then the conversation's.
  const turnColumns = `t.id, t.conversation_id, c.user_id, t.status, t.failure, t.runtime_turn_id, COALESCE(t.runtime_session_id, c.runtime_session_id) AS runtime_session_id`;

  // The turn a runtime event belongs to: by its id, else by the runtime's turn id, else the conversation's one
  // unfinished turn the runtime has not named yet (an event that overtook `accepted`).
  async function resolveTurn(conversationId: string, turnId: string | null, runtimeSessionId: string, runtimeTurnId: string | undefined): Promise<TurnRow | null> {
    if (turnId) {
      const byId = await db.query<TurnRow>(
        `SELECT ${turnColumns} FROM assistant_turns t JOIN assistant_conversations c ON c.id = t.conversation_id WHERE t.id = $1 AND t.conversation_id = $2`,
        [turnId, conversationId],
      );
      const row = byId.rows[0] ?? null;
      if (row && runtimeTurnId && !row.runtime_turn_id) {
        await nameTurn(row.id, runtimeSessionId, runtimeTurnId);
        row.runtime_turn_id = runtimeTurnId;
        row.runtime_session_id = runtimeSessionId;
      }
      return row;
    }
    if (!runtimeTurnId) return null;
    const byRuntime = await db.query<TurnRow>(
      `SELECT ${turnColumns} FROM assistant_turns t JOIN assistant_conversations c ON c.id = t.conversation_id
        WHERE t.conversation_id = $1 AND t.runtime_session_id = $2 AND t.runtime_turn_id = $3`,
      [conversationId, runtimeSessionId, runtimeTurnId],
    );
    if (byRuntime.rows[0]) return byRuntime.rows[0];
    const unnamed = await db.query<TurnRow>(
      `UPDATE assistant_turns t SET runtime_session_id = $2, runtime_turn_id = $3 FROM assistant_conversations c
        WHERE c.id = t.conversation_id AND t.conversation_id = $1 AND t.runtime_turn_id IS NULL AND t.status = ANY($4::text[])
        RETURNING ${turnColumns}`,
      [conversationId, runtimeSessionId, runtimeTurnId, inFlight],
    );
    return unnamed.rows[0] ?? null;
  }

  async function nameTurn(turnId: string, runtimeSessionId: string, runtimeTurnId: string): Promise<void> {
    await db.query('UPDATE assistant_turns SET runtime_session_id = $2, runtime_turn_id = $3 WHERE id = $1 AND runtime_turn_id IS NULL', [
      turnId,
      runtimeSessionId,
      runtimeTurnId,
    ]);
  }

  // The entry's transcript position, or null when the runtime event was stored already (or has no seq).
  async function storeEntry(row: TurnRow, runtimeSessionId: string, seq: number, kind: 'assistant_message' | 'status', body: string): Promise<number | null> {
    if (seq < 1) return null;
    const result = await db.query<{ position: string }>(
      `INSERT INTO transcript_entries (conversation_id, runtime_session_id, runtime_seq, turn_id, kind, text, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING position`,
      [row.conversation_id, runtimeSessionId, seq, row.id, kind, body, clock.now()],
    );
    return result.rows[0] ? Number(result.rows[0].position) : null;
  }

  function sendInterrupt(row: TurnRow): boolean {
    if (!row.runtime_turn_id || !row.runtime_session_id) return false;
    return send({ t: 'interrupt', turnId: row.id, runtimeSessionId: row.runtime_session_id, runtimeTurnId: row.runtime_turn_id });
  }

  async function onHello(current: Link, runtimeVersion: string): Promise<void> {
    // Anything still in flight was dispatched over an earlier link or before a server restart.
    await strandInFlight();
    current.runtimeVersion = runtimeVersion;
    log('info', 'assistant connector online', { runtimeVersion });
    const uncertain = await db.query<{ conversation_id: string; runtime_session_id: string | null; from_seq: string }>(
      `SELECT c.id AS conversation_id, c.runtime_session_id,
              (SELECT COALESCE(MAX(e.runtime_seq), 0) FROM transcript_entries e
                WHERE e.conversation_id = c.id AND e.runtime_session_id = c.runtime_session_id) AS from_seq
         FROM assistant_conversations c
        WHERE EXISTS (SELECT 1 FROM assistant_turns t WHERE t.conversation_id = c.id AND t.status = 'uncertain')`,
    );
    for (const row of uncertain.rows) {
      if (!row.runtime_session_id) {
        const turns = await db.query<{ id: string }>(`SELECT id FROM assistant_turns WHERE conversation_id = $1 AND status = 'uncertain'`, [row.conversation_id]);
        for (const turn of turns.rows) await transition(turn.id, 'failed', 'not_delivered');
        continue;
      }
      send({ t: 'resume', conversationId: row.conversation_id, runtimeSessionId: row.runtime_session_id, fromSeq: Number(row.from_seq) });
    }
  }

  async function onEvent(message: Extract<ConnectorToServer, { t: 'event' }>): Promise<void> {
    const row = await resolveTurn(message.conversationId, message.turnId, message.runtimeSessionId, message.runtimeTurnId);
    if (!row) return;
    switch (message.kind) {
      case 'delta':
        if (!isTerminal(row.status) && message.text) fanOut(row.user_id, { kind: 'delta', turnId: row.id, seq: message.seq, text: message.text });
        return;
      case 'message': {
        if (!message.text) return;
        const position = await storeEntry(row, message.runtimeSessionId, message.seq, 'assistant_message', message.text);
        if (position !== null) fanOut(row.user_id, { kind: 'message', turnId: row.id, seq: position, text: message.text });
        return;
      }
      case 'status': {
        const status = message.status!;
        await storeEntry(row, message.runtimeSessionId, message.seq, 'status', status);
        if (status === 'streaming') await transition(row.id, 'streaming', null, ['queued', 'dispatched', 'uncertain']);
        else if (isTerminal(status)) await transition(row.id, status, status === 'failed' ? (message.text ?? 'error').slice(0, 200) : null);
        return;
      }
      case 'tool_attempt':
        // I-26: a turn that shows a tool execution is stopped and reported.
        await storeEntry(row, message.runtimeSessionId, message.seq, 'status', 'failed');
        if (await transition(row.id, 'failed', 'tool_attempt')) log('warn', 'assistant turn tried a tool', { turnId: row.id });
        sendInterrupt(row);
        return;
    }
  }

  async function onResumed(message: Extract<ConnectorToServer, { t: 'resumed' }>): Promise<void> {
    if (!message.sessionFound) {
      await db.query('UPDATE assistant_conversations SET runtime_session_id = NULL WHERE id = $1', [message.conversationId]);
    }
    // Every event the runtime logged was resent before this, so a turn still unfinished here either is the runtime's
    // open turn or never will finish.
    const open = await db.query<{ id: string; runtime_turn_id: string | null }>(
      `SELECT id, runtime_turn_id FROM assistant_turns WHERE conversation_id = $1 AND status IN ('dispatched', 'streaming', 'uncertain')`,
      [message.conversationId],
    );
    for (const turn of open.rows) {
      const active = message.sessionFound && message.activeRuntimeTurnId !== null && turn.runtime_turn_id === message.activeRuntimeTurnId;
      if (active) await transition(turn.id, 'streaming', null, ['dispatched', 'uncertain']);
      else await transition(turn.id, 'failed', turn.runtime_turn_id ? 'lost' : 'not_delivered');
    }
  }

  async function handle(current: Link, message: ConnectorToServer): Promise<void> {
    if (message.t !== 'hello' && current.runtimeVersion === null) return;
    switch (message.t) {
      case 'hello':
        if (current.runtimeVersion === null) await onHello(current, message.runtimeVersion);
        return;
      case 'session':
        // The runtime may have lost the old session; the connector's newest one replaces it.
        await db.query('UPDATE assistant_conversations SET runtime_session_id = $2 WHERE id = $1', [
          message.conversationId,
          message.runtimeSessionId,
        ]);
        return;
      case 'accepted': {
        await nameTurn(message.turnId, message.runtimeSessionId, message.runtimeTurnId);
        if (!pendingInterrupts.delete(message.turnId)) return;
        const row = await db.query<TurnRow>(`SELECT ${turnColumns} FROM assistant_turns t JOIN assistant_conversations c ON c.id = t.conversation_id WHERE t.id = $1`, [
          message.turnId,
        ]);
        if (row.rows[0] && !isTerminal(row.rows[0].status)) sendInterrupt(row.rows[0]);
        return;
      }
      case 'event':
        return onEvent(message);
      case 'resumed':
        return onResumed(message);
      case 'failed':
        await transition(message.turnId, 'failed', message.reason.slice(0, 200));
        return;
      case 'pong':
        return;
    }
  }

  return {
    async status(userId) {
      try {
        await requireOwner(userId);
      } catch {
        return { state: 'not_permitted' };
      }
      if (link && link.runtimeVersion !== null) return { state: 'online', runtimeVersion: link.runtimeVersion };
      return { state: 'offline', since: offlineSince ? offlineSince.toISOString() : null };
    },

    async latestConversation(userId) {
      await requireOwner(userId);
      const result = await db.query<{ id: string }>('SELECT id FROM assistant_conversations WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [userId]);
      return { id: result.rows[0]?.id ?? null };
    },

    async createConversation(userId) {
      await requireOwner(userId);
      const id = uuidv7(clock.now().getTime());
      await db.query('INSERT INTO assistant_conversations (id, user_id, created_at) VALUES ($1, $2, $3)', [id, userId, clock.now()]);
      return { id };
    },

    async transcript(userId, conversationId, afterSeq) {
      await requireOwner(userId);
      await ownedConversation(userId, conversationId);
      const turns = await db.query<{ id: string; prompt: string; status: AssistantTurnStatus; failure: string | null }>(
        'SELECT id, prompt, status, failure FROM assistant_turns WHERE conversation_id = $1 ORDER BY created_at, id',
        [conversationId],
      );
      const entries = await db.query<{ position: string; turn_id: string; kind: 'assistant_message' | 'status'; text: string }>(
        'SELECT position, turn_id, kind, text FROM transcript_entries WHERE conversation_id = $1 AND position > $2 ORDER BY position',
        [conversationId, afterSeq],
      );
      return {
        turns: turns.rows.map((t) => ({ id: t.id, prompt: t.prompt, status: t.status, ...(t.failure ? { failure: t.failure } : {}) })),
        entries: entries.rows.map(
          (e): AssistantEvent =>
            e.kind === 'assistant_message'
              ? { kind: 'message', turnId: e.turn_id, seq: Number(e.position), text: e.text }
              : { kind: 'turn_status', turnId: e.turn_id, status: e.text as AssistantTurnStatus },
        ),
      };
    },

    async sendTurn(userId, conversationId, body) {
      await requireOwner(userId);
      const input = parseTurn(body);
      const conversation = await ownedConversation(userId, conversationId);
      const existing = async () => {
        const found = await db.query<{ id: string; status: AssistantTurnStatus }>(
          'SELECT id, status FROM assistant_turns WHERE conversation_id = $1 AND client_turn_id = $2',
          [conversationId, input.clientTurnId],
        );
        return found.rows[0] ?? null;
      };
      // I-23: a retried send returns the turn the first one created, online or not.
      const before = await existing();
      if (before) return { turnId: before.id, status: before.status, existing: true };
      if (!online()) throw offline();

      if (!bookById(input.ref.bookId)) throw invalid(`${input.ref.bookId} is not a book.`);
      const chapter = JSON.parse((await getChapter(db, input.translationId, input.ref.bookId, input.ref.chapter, csb, await contentAccess(db, config, userId))).body) as ChapterView;
      const end = input.ref.endVerse ?? input.ref.startVerse;
      if (end !== null && end > chapter.verseCount) throw invalid(`${formatReference({ ...input.ref, startVerse: null, endVerse: null })} has ${chapter.verseCount} verses.`);
      const verses = chapter.verses
        .filter((v) => input.ref.startVerse === null || (v.number >= input.ref.startVerse && v.number <= (end ?? v.number)))
        .map((v) => ({ number: v.number, text: v.text }));
      const reference = formatReference(input.ref);
      // S12.5: only the caller's own live notes; anything else refuses the whole turn.
      const notes: ContextNote[] = (await ownNotes(db, userId, input.noteIds)).map((n) => ({ id: n.id, reference: formatReference(n.anchor), body: n.body }));
      // I-11: CSB text may not outlive its 14-day copy, so a CSB turn records which verses it was about, not their text.
      const kept = input.translationId === 'CSB' ? verses.map((v) => ({ number: v.number })) : verses;
      const context = { translationId: input.translationId, ref: input.ref, reference, verses: kept, notes };

      const turnId = uuidv7(clock.now().getTime());
      try {
        await db.query(
          `INSERT INTO assistant_turns (id, conversation_id, client_turn_id, prompt, context, status, created_at) VALUES ($1, $2, $3, $4, $5, 'queued', $6)`,
          [turnId, conversationId, input.clientTurnId, input.prompt, JSON.stringify(context), clock.now()],
        );
      } catch (error) {
        const pg = error as { code?: string; constraint?: string };
        if (pg.code !== '23505') throw error;
        if (pg.constraint === 'assistant_turns_one_active') {
          throw new AppError('turn_in_progress', 409, 'Wait for the current answer to finish, or stop it.', { retryable: true });
        }
        const raced = await existing();
        if (!raced) throw error;
        return { turnId: raced.id, status: raced.status, existing: true };
      }

      // I-23: dispatched once. A turn whose dispatch cannot be written is failed, never sent again.
      const marked = await db.query(`UPDATE assistant_turns SET status = 'dispatched' WHERE id = $1 AND status = 'queued'`, [turnId]);
      if (marked.rowCount !== 1) {
        // A link replaced meanwhile already failed it as not delivered; it is not sent.
        const now = await existing();
        return { turnId, status: now?.status ?? 'failed', existing: false };
      }
      const sent = send({
        t: 'dispatch',
        turnId,
        conversationId,
        runtimeSessionId: conversation.runtime_session_id,
        text: dispatchText(input.prompt, reference, input.translationId, verses, notes),
      });
      if (!sent) {
        await transition(turnId, 'failed', 'connector_offline');
        return { turnId, status: 'failed', existing: false };
      }
      fanOut(userId, { kind: 'turn_status', turnId, status: 'dispatched' });
      return { turnId, status: 'dispatched', existing: false };
    },

    async interrupt(userId, turnId) {
      await requireOwner(userId);
      if (!isUuid(turnId)) throw new AppError('not_found', 404, 'No such turn.');
      const result = await db.query<TurnRow>(
        `SELECT ${turnColumns} FROM assistant_turns t JOIN assistant_conversations c ON c.id = t.conversation_id WHERE t.id = $1 AND c.user_id = $2`,
        [turnId, userId],
      );
      const row = result.rows[0];
      if (!row) throw new AppError('not_found', 404, 'No such turn.');
      if (isTerminal(row.status)) return { status: row.status };
      if (!online()) throw offline();
      if (!sendInterrupt(row)) pendingInterrupts.add(row.id);
      return { status: row.status };
    },

    attach(socket) {
      const previous = link;
      const current: Link = { socket, runtimeVersion: null, lastHeard: Date.now() };
      link = current;
      if (previous) {
        // Interrupts waiting on the old link's 'accepted' would never be answered.
        pendingInterrupts.clear();
        enqueue(strandInFlight);
        try {
          previous.socket.close(4409, 'replaced');
        } catch {
          // Already gone.
        }
      }
      return {
        message(raw) {
          current.lastHeard = Date.now();
          const message = parseConnectorMessage(raw);
          if (!message) {
            log('warn', 'assistant connector sent an invalid message');
            return;
          }
          enqueue(() => (link === current ? handle(current, message) : Promise.resolve()));
        },
        closed() {
          if (link !== current) return;
          link = null;
          offlineSince = clock.now();
          pendingInterrupts.clear();
          log('info', 'assistant connector offline');
          enqueue(strandInFlight);
        },
      };
    },

    stop() {
      clearInterval(heartbeat);
      const current = link;
      link = null;
      current?.socket.close(1001, 'server_stopping');
    },
  };
}
