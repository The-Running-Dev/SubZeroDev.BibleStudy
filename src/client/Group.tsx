import { useCallback, useEffect, useState } from 'react';
import type { CreatedInvitation, GroupView, InvitationView } from '../shared/api.ts';
import { api, messageFor } from './api.ts';
import { Meetings, ScheduleForm, weekdays } from './Schedule.tsx';

export function GroupPanel(props: { groupId: string; userId: string }) {
  const [group, setGroup] = useState<GroupView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when the owner changes the schedule, so the meetings list reloads.
  const [scheduleVersion, setScheduleVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      setGroup(await api.group(props.groupId));
      setError(null);
    } catch (failure) {
      setGroup(null);
      setError(messageFor(failure));
    }
  }, [props.groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <section className="group" aria-label="Group">
        <p role="alert">{error}</p>
      </section>
    );
  }
  if (!group) return <section className="group" aria-label="Group" aria-busy="true" />;

  const { weekday, localTime, timeZone } = group.schedule;
  const owner = group.role === 'owner';
  return (
    <section className="group" aria-label="Group">
      <h2>{group.name}</h2>
      <p>
        Meets {weekdays[weekday - 1]}s at {localTime} ({timeZone}).
      </p>
      {owner && (
        <ScheduleForm
          group={group}
          onSaved={(saved) => {
            setGroup(saved);
            setScheduleVersion((v) => v + 1);
          }}
        />
      )}
      <Meetings groupId={group.id} version={scheduleVersion} />
      <h3>Members</h3>
      <ul className="members">
        {group.members.map((member) => (
          <MemberRow
            key={member.userId}
            groupId={group.id}
            member={member}
            canRemove={owner && member.role === 'member' && member.userId !== props.userId}
            onRemoved={load}
          />
        ))}
      </ul>
      {owner && <Invitations groupId={group.id} />}
    </section>
  );
}

// Removal takes two taps on the same row, so a stray tap never removes anyone.
function MemberRow(props: { groupId: string; member: GroupView['members'][number]; canRemove: boolean; onRemoved: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { member } = props;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.removeMember(props.groupId, member.userId);
      await props.onRemoved();
    } catch (failure) {
      setError(messageFor(failure));
      setBusy(false);
    }
  }

  return (
    <li>
      <span>
        {member.displayName}
        {member.role === 'owner' && ' (owner)'}
      </span>
      {props.canRemove &&
        (confirming ? (
          <span className="confirm">
            Remove {member.displayName}?{' '}
            <button type="button" disabled={busy} onClick={remove}>
              Remove
            </button>{' '}
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="link" onClick={() => setConfirming(true)}>
            Remove…
          </button>
        ))}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

function Invitations(props: { groupId: string }) {
  const [invitations, setInvitations] = useState<InvitationView[]>([]);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInvitations(await api.invitations(props.groupId));
    } catch (failure) {
      setError(messageFor(failure));
    }
  }, [props.groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (failure) {
      setError(messageFor(failure));
    } finally {
      setBusy(false);
    }
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard refused; the link stays selectable in the field.
      setCopied(false);
    }
  }

  return (
    <>
      <h3>Invitations</h3>
      <p>Each link lets one person join and works for 14 days. Send it yourself; the app never emails it.</p>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          run(async () => {
            setCreated(await api.createInvitation(props.groupId));
            setCopied(false);
          })
        }
      >
        Create invitation link
      </button>
      {created && (
        <div className="invitation-link">
          <label>
            New link
            <input readOnly value={created.link} onFocus={(event) => event.target.select()} />
          </label>
          <button type="button" className="secondary" onClick={() => copy(created.link)}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {invitations.length > 0 && (
        <ul className="invitations">
          {invitations.map((invitation) => (
            <li key={invitation.id}>
              <span>
                Created {new Date(invitation.createdAt).toLocaleDateString()}, {invitation.state}
                {invitation.state === 'open' && `, expires ${new Date(invitation.expiresAt).toLocaleDateString()}`}
              </span>
              {invitation.state === 'open' && (
                <button
                  type="button"
                  className="link"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await api.revokeInvitation(props.groupId, invitation.id);
                      if (created?.id === invitation.id) setCreated(null);
                    })
                  }
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
