import type { ApiError, CodeDelivery, Profile, ProfilePatch, RequestCodeResponse, VerifyCodeResponse } from '../shared/api.ts';

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
  requestCode: (email: string) => call<RequestCodeResponse>('POST', '/api/auth/code', { email }),
  verifyCode: (email: string, code: string) => call<VerifyCodeResponse>('POST', '/api/auth/verify', { email, code }),
  codeStatus: (email: string) => call<{ delivery: CodeDelivery }>('GET', `/api/auth/code-status?email=${encodeURIComponent(email)}`),
  logout: () => call<void>('POST', '/api/auth/logout'),
  me: () => call<Profile>('GET', '/api/me'),
  updateMe: (patch: ProfilePatch) => call<Profile>('PATCH', '/api/me', patch),
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
