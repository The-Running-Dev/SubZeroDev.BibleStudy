// Repository text checks that hold before any implementation language is chosen:
// tracked text files are UTF-8 with LF endings and a final newline, and relative
// Markdown links resolve to tracked paths.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const binary = /\.(png|jpe?g|gif|webp|ico|mp3|m4a|ogg|wav|woff2?|pdf|zip)$/i;
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const tracked = new Set(files.map(f => normalize(f)));
const dirs = new Set(files.flatMap(f => {
  const parts = normalize(f).split(/[\\/]/);
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}).map(d => normalize(d)));
const problems: string[] = [];
const decoder = new TextDecoder('utf-8', { fatal: true });

for (const file of files) {
  if (binary.test(file)) continue;
  const bytes = readFileSync(file);
  if (bytes.length === 0) continue;
  let text: string;
  try { text = decoder.decode(bytes); } catch { problems.push(`${file}: not valid UTF-8`); continue; }
  if (text.includes('\r')) problems.push(`${file}: contains CR line endings`);
  if (!text.endsWith('\n')) problems.push(`${file}: missing final newline`);
  if (!file.endsWith('.md')) continue;
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    const path = normalize(join(dirname(file), decodeURI(target.split('#')[0]))).replace(/[\\/]+$/, '');
    if (!tracked.has(path) && !dirs.has(path)) problems.push(`${file}: broken link ${target}`);
  }
}

for (const p of problems) console.error(p);
console.log(`${files.length} tracked files checked, ${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);
