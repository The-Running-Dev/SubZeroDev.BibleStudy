import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ReminderPreference } from '../shared/api.ts';
import { api, messageFor } from './api.ts';

const choices: { minutes: number; label: string }[] = [
  { minutes: 10080, label: '1 week before' },
  { minutes: 1440, label: '1 day before' },
  { minutes: 120, label: '2 hours before' },
  { minutes: 60, label: '1 hour before' },
  { minutes: 15, label: '15 minutes before' },
];

function label(minutes: number): string {
  return choices.find((c) => c.minutes === minutes)?.label ?? `${minutes} minutes before`;
}

// The member's own reminder emails for this group's meetings (S11). Login codes come whatever this says.
export function Reminders(props: { groupId: string }) {
  const [saved, setSaved] = useState<ReminderPreference | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [offsets, setOffsets] = useState<number[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSaved(null);
    setStatus(null);
    setFailed(false);
    api
      .reminders(props.groupId)
      .then((preference) => {
        setSaved(preference);
        setEnabled(preference.enabled);
        setOffsets(preference.offsetsMinutes);
      })
      .catch((failure) => {
        setFailed(true);
        setStatus(messageFor(failure));
      });
  }, [props.groupId]);

  if (!saved) return status ? <p role="alert">{status}</p> : null;
  // A stored offset the app does not offer stays listed, so saving never drops it unseen.
  const shown = [...choices.map((c) => c.minutes), ...saved.offsetsMinutes.filter((m) => !choices.some((c) => c.minutes === m))];

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const preference = await api.updateReminders(props.groupId, { enabled, offsetsMinutes: offsets });
      setSaved(preference);
      setOffsets(preference.offsetsMinutes);
      setFailed(false);
      setStatus('Reminders saved.');
    } catch (failure) {
      setFailed(true);
      setStatus(messageFor(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="reminders" aria-label="Reminders" onSubmit={save}>
      <h3>Reminders</h3>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setStatus(null);
          }}
        />{' '}
        Email me before meetings
      </label>
      <fieldset disabled={!enabled}>
        <legend>When</legend>
        {shown.map((minutes) => (
          <label key={minutes}>
            <input
              type="checkbox"
              checked={offsets.includes(minutes)}
              onChange={(e) => {
                setOffsets(e.target.checked ? [...offsets, minutes] : offsets.filter((m) => m !== minutes));
                setStatus(null);
              }}
            />{' '}
            {label(minutes)}
          </label>
        ))}
      </fieldset>
      <button type="submit" disabled={busy}>
        Save reminders
      </button>
      {status && <p role={failed ? 'alert' : 'status'}>{status}</p>}
    </form>
  );
}
