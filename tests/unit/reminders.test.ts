import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { meetingTime, reminderEmail } from '../../src/server/reminders/reminders.ts';

const startsAt = new Date('2026-11-02T12:15:00Z');
const base = { display_name: 'Mark', group_name: 'Romans study', time_zone: 'Europe/Sofia', offset_minutes: 1440, startsAt, publicUrl: 'https://study.example.test' };

describe('S11 reminder email text', () => {
  test('S11.2 the meeting time is in the recipient’s zone, with its name', () => {
    assert.equal(meetingTime(startsAt, 'Europe/Sofia'), 'Monday 2 November 2026, 14:15 EET (Europe/Sofia)');
    assert.equal(meetingTime(startsAt, 'America/Chicago'), 'Monday 2 November 2026, 06:15 CST (America/Chicago)');
    assert.equal(meetingTime(new Date('2026-11-02T23:30:00Z'), 'Asia/Tokyo'), 'Tuesday 3 November 2026, 08:30 GMT+9 (Asia/Tokyo)');
  });

  test('S11.2 subject, passage, Open study link and how to change reminders', () => {
    const email = reminderEmail({ ...base, passage: 'Passage: Romans 2:1–16' });
    assert.equal(email.subject, 'Romans study: Monday 2 November 2026, 14:15 EET (Europe/Sofia)');
    assert.equal(
      email.text,
      [
        'Hi Mark,',
        '',
        'Romans study meets Monday 2 November 2026, 14:15 EET (Europe/Sofia).',
        'Passage: Romans 2:1–16',
        '',
        'Open study: https://study.example.test/study',
        '',
        'You get this 1 day before each meeting. Change your reminders in the app, under Group.',
      ].join('\n'),
    );
    assert.match(email.html, /<a href="https:\/\/study\.example\.test\/study">Open study<\/a>/);
  });

  test('no passage line when nothing is planned or confirmed; offsets read as days, hours or minutes', () => {
    const plain = reminderEmail({ ...base, passage: null, offset_minutes: 120 });
    assert.ok(!plain.text.includes('Passage'));
    assert.match(plain.text, /You get this 2 hours before/);
    assert.match(reminderEmail({ ...base, passage: null, offset_minutes: 60 }).text, /1 hour before/);
    assert.match(reminderEmail({ ...base, passage: null, offset_minutes: 10080 }).text, /7 days before/);
    assert.match(reminderEmail({ ...base, passage: null, offset_minutes: 15 }).text, /15 minutes before/);
  });

  test('names are escaped in the HTML body', () => {
    const email = reminderEmail({ ...base, display_name: '<b>Mark</b>', group_name: 'Tom & Jerry', passage: null });
    assert.ok(!email.html.includes('<b>Mark</b>'));
    assert.match(email.html, /&#60;b&#62;Mark&#60;\/b&#62;/);
    assert.match(email.html, /Tom &#38; Jerry/);
  });
});
