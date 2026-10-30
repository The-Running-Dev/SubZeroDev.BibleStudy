import type {
  AcceptInvitationResponse,
  ApiError,
  AssistantStatus,
  AssistantTranscript,
  AssistantTurnStatus,
  CreatedInvitation,
  GroupSummary,
  GroupView,
  InvitationView,
  ChapterView,
  RecordingsResponse,
  CodeDelivery,
  Profile,
  ProfilePatch,
  RequestCodeResponse,
  SendTurnRequest,
  SendTurnResponse,
  StudySessionResponse,
  TranslationId,
  TranslationView,
  VerifyCodeResponse,
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

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
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
};

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
