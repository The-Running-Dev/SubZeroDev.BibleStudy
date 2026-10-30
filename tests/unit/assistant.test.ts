import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { stopStatus } from '../../src/connector/connector.ts';
import { dispatchText, parseConnectorMessage } from '../../src/server/assistant/assistant.ts';
import { loadConfig } from '../../src/server/platform/config.ts';
import { connectorAuthorized } from '../../src/server/web/assistant-routes.ts';

const conversationId = '0192f0a0-0000-7000-8000-000000000001';
const turnId = '0192f0a0-0000-7000-8000-000000000002';
const parse = (message: object) => parseConnectorMessage(JSON.stringify(message));

describe('parseConnectorMessage', () => {
  test('narrows each well-formed message', () => {
    assert.deepEqual(parse({ t: 'hello', runtimeVersion: '1.0.0', provider: 'claude', sandbox: null }), {
      t: 'hello',
      runtimeVersion: '1.0.0',
      provider: 'claude',
      sandbox: null,
    });
    assert.deepEqual(parse({ t: 'accepted', turnId, runtimeSessionId: 's-1', runtimeTurnId: 'rt-1' }), {
      t: 'accepted',
      turnId,
      runtimeSessionId: 's-1',
      runtimeTurnId: 'rt-1',
    });
    assert.deepEqual(parse({ t: 'event', conversationId, runtimeSessionId: 's-1', seq: 4, turnId, kind: 'status', status: 'completed' }), {
      t: 'event',
      conversationId,
      runtimeSessionId: 's-1',
      seq: 4,
      turnId,
      kind: 'status',
      status: 'completed',
    });
    assert.deepEqual(parse({ t: 'resumed', conversationId, sessionFound: false, activeRuntimeTurnId: null }), {
      t: 'resumed',
      conversationId,
      sessionFound: false,
      activeRuntimeTurnId: null,
    });
    assert.deepEqual(parse({ t: 'failed', turnId, reason: 'runtime_exited' }), { t: 'failed', turnId, reason: 'runtime_exited', retryable: false });
    assert.deepEqual(parse({ t: 'pong' }), { t: 'pong' });
  });

  test('requires the runtime session on accepted and event: turn ids and seqs are unique only within it', () => {
    assert.equal(parse({ t: 'accepted', turnId, runtimeTurnId: 'rt-1' }), null);
    assert.equal(parse({ t: 'event', conversationId, seq: 1, turnId: null, kind: 'delta', text: 'x' }), null);
    assert.equal(parse({ t: 'event', conversationId, runtimeSessionId: '', seq: 1, turnId: null, kind: 'delta', text: 'x' }), null);
  });

  test('rejects malformed messages', () => {
    assert.equal(parseConnectorMessage('not json'), null);
    assert.equal(parseConnectorMessage('null'), null);
    assert.equal(parse({ t: 'unknown' }), null);
    assert.equal(parse({ t: 'session', conversationId: 'not-a-uuid', runtimeSessionId: 's-1' }), null);
    assert.equal(parse({ t: 'event', conversationId, runtimeSessionId: 's-1', seq: -1, turnId: null, kind: 'delta' }), null);
    assert.equal(parse({ t: 'event', conversationId, runtimeSessionId: 's-1', seq: 1.5, turnId: null, kind: 'delta' }), null);
    assert.equal(parse({ t: 'event', conversationId, runtimeSessionId: 's-1', seq: 1, turnId: null, kind: 'shell' }), null);
    assert.equal(parse({ t: 'event', conversationId, runtimeSessionId: 's-1', seq: 1, turnId: null, kind: 'status', status: 'odd' }), null);
    assert.equal(parse({ t: 'event', conversationId, runtimeSessionId: 's-1', seq: 1, turnId: null, kind: 'message', text: 7 }), null);
    assert.equal(parse({ t: 'hello', runtimeVersion: '1.0.0', provider: 'claude' }), null);
    assert.equal(parse({ t: 'failed', turnId, reason: '' }), null);
  });
});

describe('dispatchText', () => {
  test('sends the rules, the passage as the reader sees it, then the question', () => {
    const text = dispatchText('Who is the righteous?', 'Romans 1:16–17', 'BSB', [
      { number: 16, text: 'For I am not ashamed of the gospel…' },
      { number: 17, text: 'The righteous will live by faith.' },
    ]);
    assert.match(text, /You have no tools/);
    assert.ok(
      text.endsWith(
        [
          'Passage: Romans 1:16–17 (BSB)',
          '16 For I am not ashamed of the gospel…',
          '17 The righteous will live by faith.',
          '',
          'Question: Who is the righteous?',
        ].join('\n'),
      ),
    );
  });
});

describe('connectorAuthorized', () => {
  const token = 'c'.repeat(40);
  const request = (authorization?: string) => ({ headers: authorization === undefined ? {} : { authorization } }) as FastifyRequest;

  test('accepts only the configured bearer', () => {
    assert.equal(connectorAuthorized(request(`Bearer ${token}`), token), true);
    assert.equal(connectorAuthorized(request(`Bearer ${token}x`), token), false);
    assert.equal(connectorAuthorized(request(token), token), false);
    assert.equal(connectorAuthorized(request(), token), false);
  });

  test('refuses everyone when no token is configured', () => {
    assert.equal(connectorAuthorized(request('Bearer '), null), false);
    assert.equal(connectorAuthorized(request(`Bearer ${token}`), null), false);
  });
});

describe('stopStatus', () => {
  test('maps the runtime stop reason; anything unknown is a failure', () => {
    assert.equal(stopStatus('completed'), 'completed');
    assert.equal(stopStatus('interrupted'), 'interrupted');
    assert.equal(stopStatus('error'), 'failed');
    assert.equal(stopStatus(undefined), 'failed');
  });
});

describe('assistant configuration', () => {
  const base = { DATABASE_URL: 'postgres://x', APP_SECRET: 'a'.repeat(32), SMTP_URL: 'smtp://localhost:1025' };

  test('is off unless set; the owner email is lower-cased', () => {
    const off = loadConfig(base);
    assert.equal(off.assistantOwnerEmail, null);
    assert.equal(off.connectorToken, null);
    const on = loadConfig({ ...base, ASSISTANT_OWNER_EMAIL: ' Owner@Example.TEST ', CONNECTOR_TOKEN: 't'.repeat(32) });
    assert.equal(on.assistantOwnerEmail, 'owner@example.test');
    assert.equal(on.connectorToken, 't'.repeat(32));
  });

  test('rejects a bad owner email or a short connector token', () => {
    assert.throws(() => loadConfig({ ...base, ASSISTANT_OWNER_EMAIL: 'owner' }), /ASSISTANT_OWNER_EMAIL must be an email address/);
    assert.throws(() => loadConfig({ ...base, CONNECTOR_TOKEN: 'short' }), /CONNECTOR_TOKEN must be at least 32 characters/);
  });
});
