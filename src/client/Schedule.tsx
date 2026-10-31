import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { GroupView, OccurrenceView, UpdateOccurrenceRequest } from '../shared/api.ts';
import { formatReference, parseReference } from '../shared/reference.ts';
import { instantFor, isoWeekday, wallClock } from '../shared/zones.ts';
import { ApiFailure, api, messageFor } from './api.ts';

export const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Mon 2 Nov", from a wall-clock date; never through the browser's zone.
export function formatLocalDate(localDate: string): string {
  const [, month, day] = localDate.split('-').map(Number);
  return `${weekdays[isoWeekday(localDate) - 1].slice(0, 3)} ${day} ${months[month - 1]}`;
}

// The next meetings in the member's profile zone (S10.5), with the time each was set in when that zone differs.
export function Meetings(props: { groupId: string; version: number }) {
  const [meetings, setMeetings] = useState<OccurrenceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMeetings(await api.occurrences(props.groupId));
      setError(null);
    } catch (failure) {
      setError(messageFor(failure));
    }
  }, [props.groupId]);

  useEffect(() => {
    void load();
  }, [load, props.version]);

  const replace = (updated: OccurrenceView) => setMeetings((list) => list && list.map((m) => (m.id === updated.id ? updated : m)));

  return (
    <>
      <h3>Next meetings</h3>
      {error && <p role="alert">{error}</p>}
      {meetings && meetings.length === 0 && <p>No meetings in the next eight weeks.</p>}
      {meetings && meetings.length > 0 && (
        <ul className="meetings">
          {meetings.map((meeting) => (
            <Meeting key={meeting.id} groupId={props.groupId} meeting={meeting} onChanged={replace} onMoved={load} />
          ))}
        </ul>
      )}
    </>
  );
}

type Editing = 'move' | 'plan' | null;

function Meeting(props: { groupId: string; meeting: OccurrenceView; onChanged: (m: OccurrenceView) => void; onMoved: () => Promise<void> }) {
  const { meeting } = props;
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = meeting.status === 'cancelled';
  const { viewer, anchor } = meeting;

  // Based on the revision shown, so a change someone made meanwhile is shown rather than overwritten (S10.4).
  async function change(request: Omit<UpdateOccurrenceRequest, 'expectedRevision'>, after?: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      props.onChanged(await api.updateOccurrence(props.groupId, meeting.id, { ...request, expectedRevision: meeting.revision }));
      setEditing(null);
      await after?.();
    } catch (failure) {
      const current = failure instanceof ApiFailure && failure.body.error === 'stale_revision' ? (failure.body.details?.current as OccurrenceView | undefined) : undefined;
      if (current) {
        props.onChanged(current);
        setError('Someone changed this meeting first. Check it, then try again.');
      } else setError(messageFor(failure));
    } finally {
      setBusy(false);
    }
  }

  // Entered in the member's own zone; stored as the wall-clock time in the zone the meeting was set in.
  function move(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const at = Date.parse(instantFor(String(form.get('date')), String(form.get('time')), viewer.timeZone));
    void change(wallClock(at, anchor.timeZone), props.onMoved);
  }

  function plan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get('passage')).trim();
    const plannedPassage = text ? parseReference(text) : null;
    if (text && !plannedPassage) return setError(`"${text}" is not a passage. Try "Romans 3" or "Romans 3:1-8".`);
    void change({ plannedPassage });
  }

  const differs = viewer.timeZone !== anchor.timeZone;
  return (
    <li className={cancelled ? 'cancelled' : undefined}>
      <span>
        <strong>
          {formatLocalDate(viewer.localDate)}, {viewer.localTime} {viewer.abbreviation}
        </strong>
        {differs && ` (${anchor.localTime} ${anchor.timeZone})`}
        {cancelled && ' · Cancelled'}
        {meeting.plannedPassage && ` · ${formatReference(meeting.plannedPassage)}`}
      </span>
      <span className="meeting-actions">
        {!cancelled && (
          <button type="button" className="link" disabled={busy} onClick={() => setEditing(editing === 'move' ? null : 'move')}>
            Move…
          </button>
        )}
        <button type="button" className="link" disabled={busy} onClick={() => setEditing(editing === 'plan' ? null : 'plan')}>
          Plan passage…
        </button>
        <button type="button" className="link" disabled={busy} onClick={() => change({ status: cancelled ? 'scheduled' : 'cancelled' })}>
          {cancelled ? 'Restore' : 'Cancel meeting'}
        </button>
      </span>
      {editing === 'move' && (
        <form className="meeting-form" onSubmit={move}>
          <label>
            Date
            <input name="date" type="date" required defaultValue={viewer.localDate} />
          </label>
          <label>
            Time ({viewer.abbreviation})
            <input name="time" type="time" required defaultValue={viewer.localTime} />
          </label>
          <button type="submit" disabled={busy}>
            Move meeting
          </button>
        </form>
      )}
      {editing === 'plan' && (
        <form className="meeting-form" onSubmit={plan}>
          <label>
            Passage
            <input name="passage" defaultValue={meeting.plannedPassage ? formatReference(meeting.plannedPassage) : ''} placeholder="Romans 3" />
          </label>
          <button type="submit" disabled={busy}>
            Save plan
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

// Owner only (S10.3): meetings ahead that nobody moved follow the new schedule.
export function ScheduleForm(props: { group: GroupView; onSaved: (group: GroupView) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { schedule } = props.group;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      props.onSaved(
        await api.updateSchedule(props.group.id, {
          weekday: Number(form.get('weekday')),
          localTime: String(form.get('time')),
          timeZone: String(form.get('zone')).trim(),
        }),
      );
      setOpen(false);
    } catch (failure) {
      setError(messageFor(failure));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        Change schedule
      </button>
    );
  }
  return (
    <form className="meeting-form" onSubmit={save} aria-label="Change schedule">
      <label>
        Day
        <select name="weekday" defaultValue={schedule.weekday}>
          {weekdays.map((day, i) => (
            <option key={day} value={i + 1}>
              {day}
            </option>
          ))}
        </select>
      </label>
      <label>
        Time
        <input name="time" type="time" required defaultValue={schedule.localTime} />
      </label>
      <label>
        Time zone
        <input name="zone" required defaultValue={schedule.timeZone} />
      </label>
      <button type="submit" disabled={busy}>
        Save schedule
      </button>
      <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
