import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadConfig } from '../../src/server/platform/config.ts';
import { uuidv7 } from '../../src/server/platform/ids.ts';
import { deriveKey, equalHex, hmacHex, seal, unseal } from '../../src/server/platform/secrets.ts';

describe('uuidv7', () => {
  test('is a version 7, variant 10 UUID that sorts by time', () => {
    const early = uuidv7(Date.parse('2026-11-01T12:00:00Z'));
    const late = uuidv7(Date.parse('2026-11-01T12:00:01Z'));
    assert.match(early, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(early < late);
    assert.equal(early.slice(0, 13).replace('-', ''), Date.parse('2026-11-01T12:00:00Z').toString(16).padStart(12, '0'));
  });
});

describe('secrets', () => {
  const secret = 'unit-test-secret-0123456789abcdefghij';

  test('derived keys differ by purpose', () => {
    assert.notDeepEqual(deriveKey(secret, 'a'), deriveKey(secret, 'b'));
    assert.deepEqual(deriveKey(secret, 'a'), deriveKey(secret, 'a'));
  });

  test('seal round-trips and rejects tampering or the wrong key', () => {
    const key = deriveKey(secret, 'seal');
    const sealed = seal(key, '{"code":"123456"}');
    assert.ok(!sealed.includes('123456'));
    assert.equal(unseal(key, sealed), '{"code":"123456"}');
    const raw = Buffer.from(sealed, 'base64url');
    raw[raw.length - 1] ^= 1;
    assert.throws(() => unseal(key, raw.toString('base64url')));
    assert.throws(() => unseal(deriveKey(secret, 'other'), sealed));
  });

  test('hmac comparison is exact', () => {
    const key = deriveKey(secret, 'pepper');
    assert.ok(equalHex(hmacHex(key, 'x'), hmacHex(key, 'x')));
    assert.ok(!equalHex(hmacHex(key, 'x'), hmacHex(key, 'y')));
    assert.ok(!equalHex(hmacHex(key, 'x'), 'abcd'));
  });
});

describe('loadConfig', () => {
  const base = { DATABASE_URL: 'postgres://x', APP_SECRET: 'a'.repeat(32), SMTP_URL: 'smtp://localhost:1025' };

  test('applies defaults', () => {
    const config = loadConfig(base);
    assert.equal(config.port, 3000);
    assert.equal(config.cookieSecure, true);
    assert.equal(config.trustProxy, false);
    assert.equal(config.buildId, 'dev');
  });

  test('imported CSB defaults to owner only, can be disabled, and rejects wider modes', () => {
    assert.equal(loadConfig(base).csbImportedAccess, 'owner');
    assert.equal(loadConfig({ ...base, CSB_IMPORTED_ACCESS: 'disabled' }).csbImportedAccess, 'disabled');
    assert.throws(() => loadConfig({ ...base, CSB_IMPORTED_ACCESS: 'group' }), /CSB_IMPORTED_ACCESS must be owner or disabled/);
  });

  test('S13 API.Bible is off without a key, and a key needs the CSB Bible id', () => {
    assert.equal(loadConfig(base).apibible, null);
    assert.deepEqual(loadConfig({ ...base, APIBIBLE_KEY: 'k', APIBIBLE_CSB_BIBLE_ID: 'csb-id' }).apibible, {
      key: 'k',
      bibleId: 'csb-id',
      baseUrl: 'https://rest.api.bible/v1',
    });
    assert.equal(loadConfig({ ...base, APIBIBLE_KEY: 'k', APIBIBLE_CSB_BIBLE_ID: 'csb-id', APIBIBLE_BASE_URL: 'http://127.0.0.1:9/v1/' }).apibible?.baseUrl, 'http://127.0.0.1:9/v1');
    assert.throws(() => loadConfig({ ...base, APIBIBLE_KEY: 'k' }), /APIBIBLE_CSB_BIBLE_ID is required when APIBIBLE_KEY is set/);
    assert.throws(() => loadConfig({ ...base, APIBIBLE_KEY: 'replace-with-your-api-bible-key', APIBIBLE_CSB_BIBLE_ID: 'csb-id' }), /APIBIBLE_KEY is still the example placeholder/);
    for (const url of ['http://api.example.test/v1', 'ftp://127.0.0.1/v1', 'not a url']) {
      assert.throws(() => loadConfig({ ...base, APIBIBLE_KEY: 'k', APIBIBLE_CSB_BIBLE_ID: 'csb-id', APIBIBLE_BASE_URL: url }), /APIBIBLE_BASE_URL must be an https URL/, url);
    }
    assert.equal(loadConfig({ ...base, APIBIBLE_KEY: 'k', APIBIBLE_CSB_BIBLE_ID: 'csb-id', APIBIBLE_BASE_URL: 'http://localhost:9/v1' }).apibible?.baseUrl, 'http://localhost:9/v1');
    assert.throws(() => loadConfig({ ...base, APIBIBLE_CSB_BIBLE_ID: 'csb-id' }), /APIBIBLE_CSB_BIBLE_ID is set without APIBIBLE_KEY/);
    assert.equal(loadConfig({ ...base, APIBIBLE_BASE_URL: 'https://rest.api.bible/v1' }).apibible, null);
  });

  test('names every missing or weak variable', () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL is required; APP_SECRET is required; SMTP_URL is required/);
    assert.throws(() => loadConfig({ ...base, APP_SECRET: 'short' }), /APP_SECRET must be at least 32 characters/);
    assert.throws(() => loadConfig({ ...base, APP_SECRET: 'replace-with-at-least-32-random-characters' }), /APP_SECRET is still the example placeholder/);
    assert.throws(() => loadConfig({ ...base, CONNECTOR_TOKEN: 'replace-with-at-least-32-random-characters' }), /CONNECTOR_TOKEN is still the example placeholder/);
    assert.throws(() => loadConfig({ ...base, PORT: 'abc' }), /PORT must be a positive integer/);
  });

  test('trusts a hop count or proxy addresses, never every hop', () => {
    assert.equal(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy, 1);
    assert.equal(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8' }).trustProxy, '10.0.0.0/8');
    assert.throws(() => loadConfig({ ...base, TRUST_PROXY: 'true' }), /TRUST_PROXY=true trusts every hop/);
  });

  test('strips a trailing slash from PUBLIC_URL', () => {
    assert.equal(loadConfig({ ...base, PUBLIC_URL: 'https://study.example.test/' }).publicUrl, 'https://study.example.test');
  });
});
