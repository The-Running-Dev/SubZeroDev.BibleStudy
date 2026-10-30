import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

// Purpose-bound keys derived from APP_SECRET, so one configured secret never serves two uses.
export function deriveKey(appSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', appSecret, 'subzerodev.biblestudy', purpose, 32));
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacHex(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

export function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

// AES-256-GCM: iv(12) | tag(16) | ciphertext, base64url.
export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function unseal(key: Buffer, sealed: string): string {
  const raw = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
