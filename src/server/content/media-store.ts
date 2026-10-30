import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '../platform/secrets.ts';

// The media volume: one file per distinct recording, named by the SHA-256 of its bytes.
// A file is written under a temporary name, read back and hashed, then renamed; it is never modified in place.

const extensions: Record<string, string> = { 'audio/mpeg': 'mp3' };

export const sha256Pattern = /^[0-9a-f]{64}$/;

export function mediaFileName(sha256: string, mimeType: string): string {
  const ext = extensions[mimeType];
  if (!ext || !sha256Pattern.test(sha256)) throw new Error(`no media file name for ${sha256} (${mimeType})`);
  return `${sha256}.${ext}`;
}

export function mediaPath(mediaDir: string, sha256: string, mimeType: string): string {
  return join(mediaDir, mediaFileName(sha256, mimeType));
}

export function mediaExists(mediaDir: string, sha256: string, mimeType: string): boolean {
  return existsSync(mediaPath(mediaDir, sha256, mimeType));
}

export async function storeMedia(mediaDir: string, bytes: Buffer, mimeType: string): Promise<{ sha256: string; bytes: number; path: string }> {
  const sha256 = sha256Hex(bytes);
  const path = mediaPath(mediaDir, sha256, mimeType);
  const existing = await stat(path).catch(() => null);
  if (existing?.size === bytes.length) return { sha256, bytes: bytes.length, path };

  await mkdir(mediaDir, { recursive: true });
  const temp = join(mediaDir, `.${sha256}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    const written = await readFile(temp);
    if (written.length !== bytes.length || sha256Hex(written) !== sha256) throw new Error(`media write for ${sha256} did not read back intact`);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
  return { sha256, bytes: bytes.length, path };
}
