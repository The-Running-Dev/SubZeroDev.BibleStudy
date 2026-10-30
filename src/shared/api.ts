// Types shared by the server and the installable client. Signatures follow design/20-contract.md.

export type Uuid = string;
export type IsoInstant = string;
export type IanaZone = string;
export type TranslationId = 'BSB' | 'CSB';
export type BookId = string; // USFM code, e.g. 'ROM'

export interface PassageRef {
  bookId: BookId;
  chapter: number;
  startVerse: number | null;
  endVerse: number | null;
}

export type Availability =
  | { state: 'available' }
  | { state: 'not_configured'; reason: string }
  | { state: 'unavailable'; reason: string };

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
  | 'translation_unavailable'
  | 'chapter_not_found'
  | 'upstream_failed'
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

export interface TranslationView {
  id: TranslationId;
  name: string;
  copyrightNotice: string;
  availability: Availability;
  narration: Availability;
}

export interface BookView {
  bookId: BookId;
  name: string;
  chapters: number;
}

export interface ChapterContent {
  verses: { number: number; text: string }[];
  headings: { beforeVerse: number; text: string }[];
  footnotes: { verse: number; text: string }[];
}

export interface ChapterView extends ChapterContent {
  translationId: TranslationId;
  bookId: BookId;
  chapter: number;
  verseCount: number;
  contentSha256: string;
  expiresAt: IsoInstant | null;
  fums?: { token: string };
}
