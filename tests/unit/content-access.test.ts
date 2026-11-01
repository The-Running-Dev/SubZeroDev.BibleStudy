import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offlineContentPermitted } from '../../src/client/content-access.ts';

test('imported CSB offline copies require an exact account scope, including old unscoped copies', () => {
  assert.equal(offlineContentPermitted('owner', 'CSB', { expiresAt: null, restrictedToUserId: 'owner' }), true);
  assert.equal(offlineContentPermitted('member', 'CSB', { expiresAt: null, restrictedToUserId: 'owner' }), false);
  assert.equal(offlineContentPermitted('owner', 'CSB', { expiresAt: null }), false);
  assert.equal(offlineContentPermitted('solo', 'BSB', { expiresAt: null }), true);
  assert.equal(offlineContentPermitted('solo', 'CSB', { expiresAt: '2026-11-02T00:00:00Z' }), true);
});
