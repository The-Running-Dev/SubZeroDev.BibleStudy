import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Profile } from '../shared/api.ts';
import { api, messageFor } from './api.ts';

function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const zones: string[] = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

export function ProfileForm(props: { profile: Profile; useBrowserZone?: boolean; onSaved: (profile: Profile) => void }) {
  const [displayName, setDisplayName] = useState(props.profile.displayName);
  const [timeZone, setTimeZone] = useState(props.useBrowserZone ? browserZone() : props.profile.timeZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = zones.includes(timeZone) ? zones : [timeZone, ...zones];

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      props.onSaved(await api.updateMe({ displayName, timeZone }));
    } catch (failure) {
      setError(messageFor(failure));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <label>
        Name
        <input required maxLength={60} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label>
        Time zone
        <select value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
          {options.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={busy}>
        Save
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
