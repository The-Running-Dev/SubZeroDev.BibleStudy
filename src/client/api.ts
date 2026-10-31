import type {
  AcceptInvitationResponse,
  ApiError,
  AssistantStatus,
  AssistantTranscript,
  AssistantTurnStatus,
  CreatedInvitation,
  GroupProgressView,
  GroupSummary,
  GroupView,
  InvitationView,
  OccurrenceView,
  ReminderPreference,
  ScheduleRequest,
  UpdateOccurrenceRequest,
  ChapterView,
  RecordingsResponse,
  CodeDelivery,
  ConfirmProgressRequest,
  DeletePostResponse,
  DispositionRequest,
  EditPostRequest,
  PostQuestionRequest,
  PostReplyRequest,
  Profile,
  ProfilePatch,
  PullResponse,
  PushResult,
  SyncOp,
  QuestionStatus,
  QuestionView,
  ReplyView,
  RequestCodeResponse,
  SendTurnRequest,
  SendTurnResponse,
  StudySessionResponse,
  TranslationId,
  TranslationView,
  VerifyCodeResponse,
  WrapUpView,
} from '../shared/api.ts';

export class ApiFailure extends Error {
  readonly status: number;
  readonly body: ApiError;

  constructor(status: number, body: ApiError) {
    super(body.message);
    this.status = status;
    this.body = body;
  }
}

// `keepalive` lets a request finish after the page is gone (a place saved on leaving).
async function call<T>(method: string, url: string, body?: unknown, keepalive = false): Promise<T> {
  const response = await fetch(url, {
    method,
    keepalive,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiFailure(response.status, json ?? { error: 'internal', message: `Request failed (${response.status}).`, retryable: false });
  }
  return json as T;
}

export const api = {
  requestCode: (email: string, invitationToken?: string) => call<RequestCodeResponse>('POST', '/api/auth/code', { email, invitationToken }),
  verifyCode: (email: string, code: string, invitationToken?: string) =>
    call<VerifyCodeResponse>('POST', '/api/auth/verify', { email, code, invitationToken }),
  codeStatus: (email: string) => call<{ delivery: CodeDelivery }>('GET', `/api/auth/code-status?email=${encodeURIComponent(email)}`),
  logout: () => call<void>('POST', '/api/auth/logout'),
  me: () => call<Profile>('GET', '/api/me'),
  updateMe: (patch: ProfilePatch) => call<Profile>('PATCH', '/api/me', patch),
  acceptInvitation: (token: string) => call<AcceptInvitationResponse>('POST', '/api/invitations/accept', { token }),
  groups: () => call<GroupSummary[]>('GET', '/api/groups'),
  group: (groupId: string) => call<GroupView>('GET', `/api/groups/${groupId}`),
  createInvitation: (groupId: string) => call<CreatedInvitation>('POST', `/api/groups/${groupId}/invitations`),
  invitations: (groupId: string) => call<InvitationView[]>('GET', `/api/groups/${groupId}/invitations`),
  revokeInvitation: (groupId: string, invitationId: string) => call<void>('DELETE', `/api/groups/${groupId}/invitations/${invitationId}`),
  removeMember: (groupId: string, userId: string) => call<void>('DELETE', `/api/groups/${groupId}/members/${userId}`),
  // The next eight weeks of meetings, in the member's profile zone.
  occurrences: (groupId: string) => call<OccurrenceView[]>('GET', `/api/groups/${groupId}/occurrences`),
  // 409 `stale_revision`, carrying the current meeting, when it changed since `expectedRevision`.
  updateOccurrence: (groupId: string, occurrenceId: string, change: UpdateOccurrenceRequest) =>
    call<OccurrenceView>('PATCH', `/api/groups/${groupId}/occurrences/${occurrenceId}`, change),
  updateSchedule: (groupId: string, schedule: ScheduleRequest) => call<GroupView>('PATCH', `/api/groups/${groupId}/schedule`, schedule),
  reminders: (groupId: string) => call<ReminderPreference>('GET', `/api/groups/${groupId}/reminders`),
  updateReminders: (groupId: string, preference: ReminderPreference) => call<ReminderPreference>('PUT', `/api/groups/${groupId}/reminders`, preference),
  translations: () => call<TranslationView[]>('GET', '/api/content/translations'),
  chapter: (translationId: TranslationId, bookId: string, chapter: number) => call<ChapterView>('GET', `/api/content/${translationId}/${bookId}/${chapter}`),
  // 202 while a recording is being prepared; the body lists what is ready so far.
  recordings: (translationId: TranslationId, bookId: string, chapter: number) =>
    call<RecordingsResponse>('GET', `/api/content/${translationId}/${bookId}/${chapter}/recordings`),
  // Starts the group's study, or returns the one already active.
  startSession: (groupId: string) => call<StudySessionResponse>('POST', `/api/groups/${groupId}/session`),
  // 404 `no_active_session` when nobody has started one.
  activeSession: (groupId: string) => call<StudySessionResponse>('GET', `/api/groups/${groupId}/session`),
  assistantStatus: () => call<AssistantStatus>('GET', '/api/assistant/status'),
  latestConversation: () => call<{ id: string | null }>('GET', '/api/assistant/conversations'),
  createConversation: () => call<{ id: string }>('POST', '/api/assistant/conversations'),
  // The turns, and the transcript entries after position `afterSeq`.
  assistantTranscript: (conversationId: string, afterSeq: number) =>
    call<AssistantTranscript>('GET', `/api/assistant/conversations/${conversationId}?afterSeq=${afterSeq}`),
  // 200 with `existing: true` when this clientTurnId was sent before.
  sendTurn: (conversationId: string, request: SendTurnRequest) => call<SendTurnResponse>('POST', `/api/assistant/conversations/${conversationId}/turns`, request),
  interruptTurn: (turnId: string) => call<{ status: AssistantTurnStatus }>('POST', `/api/assistant/turns/${turnId}/interrupt`),
  questions: (groupId: string, filter: { bookId: string; chapter: number; status?: QuestionStatus[] }) => {
    const query = new URLSearchParams({ book: filter.bookId, chapter: String(filter.chapter) });
    if (filter.status) query.set('status', filter.status.join(','));
    return call<QuestionView[]>('GET', `/api/groups/${groupId}/questions?${query}`);
  },
  // The same clientOpId again returns what the first attempt posted.
  postQuestion: (groupId: string, request: PostQuestionRequest) => call<QuestionView>('POST', `/api/groups/${groupId}/questions`, request),
  postReply: (groupId: string, questionId: string, request: PostReplyRequest) => call<ReplyView>('POST', `/api/groups/${groupId}/questions/${questionId}/replies`, request),
  // 409 `stale_revision` when the post changed since `expectedRevision`.
  editPost: (groupId: string, target: { questionId: string } | { replyId: string }, request: EditPostRequest) =>
    call<QuestionView | ReplyView>('PATCH', postUrl(groupId, target), request),
  deletePost: (groupId: string, target: { questionId: string } | { replyId: string }) => call<DeletePostResponse>('DELETE', postUrl(groupId, target)),
  setDisposition: (groupId: string, questionId: string, request: DispositionRequest) =>
    call<QuestionView>('POST', `/api/groups/${groupId}/questions/${questionId}/disposition`, request),
  progress: (groupId: string) => call<{ progress: GroupProgressView | null }>('GET', `/api/groups/${groupId}/progress`),
  // 409 `stale_progress`, carrying the current stopping point, when another member confirmed one after `basedOnId`.
  confirmProgress: (groupId: string, request: ConfirmProgressRequest) => call<{ id: string }>('POST', `/api/groups/${groupId}/progress`, request),
  // The suggested stopping point and the questions to settle; also the questions the study keeps in view.
  wrapUp: (groupId: string, sessionId: string) => call<WrapUpView>('GET', `/api/groups/${groupId}/session/${sessionId}/wrap-up`),
  // The caller's own note and solo-position operations, applied in order; each result says what became of its op.
  push: (ops: SyncOp[], keepalive = false) => call<{ results: PushResult[] }>('POST', '/api/sync/push', { ops }, keepalive),
  // The caller's own notes changed after `cursor` (every live one without it), solo position and open conflicts.
  pull: (cursor: string | null) => call<PullResponse>('GET', cursor === null ? '/api/sync/pull' : `/api/sync/pull?cursor=${encodeURIComponent(cursor)}`),
};

function postUrl(groupId: string, target: { questionId: string } | { replyId: string }): string {
  return 'questionId' in target ? `/api/groups/${groupId}/questions/${target.questionId}` : `/api/groups/${groupId}/replies/${target.replyId}`;
}

export function messageFor(error: unknown): string {
  if (error instanceof ApiFailure) {
    if (error.body.error === 'rate_limited') {
      const seconds = Number(error.body.details?.retryAfterSeconds ?? 60);
      return `Too many codes requested. Try again in ${Math.ceil(seconds / 60)} minute(s).`;
    }
    return error.body.message;
  }
  return 'Cannot reach the server. Check your connection and try again.';
}
