// S18.2: every environment variable the code reads is listed in .env.example with a placeholder and a comment.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
  );
}

// env.NAME, env['NAME'] and required('NAME'), the three ways the server, the CLIs and the connector read one.
function readByCode(): Set<string> {
  const names = new Set<string>();
  const patterns = [/\benv\.([A-Z][A-Z0-9_]+)/g, /\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]/g, /\brequired\(['"]([A-Z][A-Z0-9_]+)['"]\)/g];
  for (const file of [...sources('src/server'), ...sources('src/connector')]) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

test('S18.2 .env.example lists every variable the code reads, each with a placeholder and a purpose', () => {
  const lines = readFileSync('.env.example', 'utf8').split('\n');
  const listed = new Map<string, number>();
  lines.forEach((line, index) => {
    const match = /^#?\s?([A-Z][A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) listed.set(match[1], index);
  });
  const read = readByCode();
  assert.ok(read.size > 10, `found only ${read.size} variables; the scan is broken`);
  const missing = [...read].filter((name) => !listed.has(name)).sort();
  assert.deepEqual(missing, [], `read by the code but missing from .env.example: ${missing.join(', ')}`);
  for (const [name, index] of listed) {
    assert.ok(/=.+/.test(lines[index]), `${name} has no placeholder value`);
    // The purpose is the comment block above the variable, possibly shared with its neighbours.
    let above = index - 1;
    while (above >= 0 && /^#?\s?[A-Z][A-Z0-9_]+=/.test(lines[above])) above--;
    assert.ok(above >= 0 && /^# \S/.test(lines[above]), `${name} has no comment saying what it is for`);
  }
});
