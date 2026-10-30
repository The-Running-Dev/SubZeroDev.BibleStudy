import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { generateCode, hashCode } from '../../src/server/identity/codes.ts';
import { isValidTimeZone, normalizeDisplayName, normalizeEmail } from '../../src/server/identity/validation.ts';
import { fillPlaceholders, nextDelayMinutes } from '../../src/server/mail/worker.ts';
import { isPermanentFailure } from '../../src/server/mail/transport.ts';
import { deriveKey } from '../../src/server/platform/secrets.ts';

describe('normalizeEmail', () => {
  test('trims and lower-cases', () => {
    assert.equal(normalizeEmail('  Member@Example.TEST '), 'member@example.test');
  });

  for (const bad of ['', 'no-at-sign', 'a@b', 'two@@example.test', 'space in@example.test', 42, null, `${'a'.repeat(250)}@x.io`]) {
    test(`rejects ${JSON.stringify(bad).slice(0, 30)}`, () => {
      assert.throws(() => normalizeEmail(bad), (error: { code?: string }) => error.code === 'invalid_email');
    });
  }
});

describe('isValidTimeZone', () => {
  test('accepts IANA zones and rejects anything else', () => {
    assert.ok(isValidTimeZone('Europe/Sofia'));
    assert.ok(isValidTimeZone('America/Chicago'));
    assert.ok(isValidTimeZone('UTC'));
    assert.ok(!isValidTimeZone('Mars/Base'));
    assert.ok(!isValidTimeZone(''));
    assert.ok(!isValidTimeZone(3));
  });
});

describe('normalizeDisplayName', () => {
  test('collapses whitespace and enforces length', () => {
    assert.equal(normalizeDisplayName('  Ana   Maria '), 'Ana Maria');
    assert.throws(() => normalizeDisplayName('   '));
    assert.throws(() => normalizeDisplayName('x'.repeat(61)));
  });
});

describe('login codes', () => {
  test('are six digits', () => {
    for (let i = 0; i < 200; i++) assert.match(generateCode(), /^\d{6}$/);
  });

  test('hash differently per code id, so the same digits never share a hash', () => {
    const pepper = deriveKey('unit-test-secret-0123456789abcdefghij', 'pepper');
    assert.notEqual(hashCode(pepper, 'id-1', '123456'), hashCode(pepper, 'id-2', '123456'));
    assert.ok(!hashCode(pepper, 'id-1', '123456').includes('123456'));
  });
});

describe('mail retry policy', () => {
  test('backs off 1, 5, 15, 60 minutes, then gives up', () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(nextDelayMinutes), [1, 5, 15, 60, null]);
  });

  test('treats 5xx replies as permanent and everything else as transient', () => {
    assert.ok(isPermanentFailure({ responseCode: 550 }));
    assert.ok(!isPermanentFailure({ responseCode: 421 }));
    assert.ok(!isPermanentFailure(new Error('ECONNREFUSED')));
  });

  test('fills known placeholders and leaves unknown ones', () => {
    assert.equal(fillPlaceholders('code {{code}} {{other}}', { code: '123456' }), 'code 123456 {{other}}');
  });
});
