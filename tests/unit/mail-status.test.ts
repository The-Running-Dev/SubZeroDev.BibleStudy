import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeMailFailure } from '../../src/server/mail/status.ts';

test('S20.3 arbitrary SMTP text is replaced with fixed, actionable messages', () => {
  const cases = [
    [null, 'Delivery attempt failed; details withheld.'],
    ['login code expired before delivery', 'Sign-in code expired before delivery.'],
    ['Invalid login: 535 password=secret', 'Mail relay authentication failed.'],
    ['connect ECONNREFUSED smtp://user:secret@internal:587', 'Mail relay connection failed.'],
    ['send failed: 550 rejected code 123456', 'Mail relay permanently rejected delivery.'],
    ['send failed: 450 rate limit code 123456', 'Mail relay temporarily rejected delivery.'],
    [
      'AUTH abc123; body <script>secret</script>; code 123456',
      'Delivery attempt failed; details withheld.',
    ],
  ] as const;
  for (const [error, summary] of cases) {
    const result = safeMailFailure(error);
    assert.equal(result.summary, summary);
    assert.ok(result.action.length > 0);
    assert.doesNotMatch(JSON.stringify(result), /secret|123456|internal:587|<script>|abc123/);
  }
});
