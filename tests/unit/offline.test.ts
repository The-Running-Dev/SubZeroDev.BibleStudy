import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatBytes } from '../../src/client/offline.ts';

describe('download sizes (S14.1)', () => {
  test('sizes read in bytes, whole kilobytes, then megabytes to one place', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(48_700), '48 KB');
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(7_654_321), '7.3 MB');
  });
});
