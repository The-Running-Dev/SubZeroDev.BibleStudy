// Types shared by the server and the installable client. Signatures follow design/20-contract.md.

export type Uuid = string;
export type IsoInstant = string;
export type IanaZone = string;
export type TranslationId = 'BSB' | 'CSB';

export type ErrorCode =
  | 'invalid_email'
  | 'code_invalid'
  | 'code_expired'
  | 'rate_limited'
  | 'unauthenticated'
  | 'invalid_zone'
  | 'invalid_request'
  | 'not_found'
  | 'unavailable'
  | 'internal';

export interface ApiError {
  error: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface Profile {
  id: Uuid;
  email: string;
  displayName: string;
  timeZone: IanaZone;
  displayTranslationId: TranslationId | null;
}

export interface RequestCodeResponse {
  sent: 'queued';
  codeExpiresAt: IsoInstant;
}

export interface VerifyCodeResponse {
  user: Profile;
  joinedGroupId: Uuid | null;
  invitation: 'accepted' | 'invalid' | 'none';
}

export type CodeDelivery = 'queued' | 'sending' | 'sent' | 'failed' | 'none';

export type ProfilePatch = Partial<Pick<Profile, 'displayName' | 'timeZone' | 'displayTranslationId'>>;
