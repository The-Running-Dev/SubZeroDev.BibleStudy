import { useEffect, useState } from 'react';
import type { GroupSummary, Profile } from '../shared/api.ts';
import { ApiFailure, api } from './api.ts';
import { GroupPanel } from './Group.tsx';
import { clearInvitation, invalidInvitationMessage, pendingInvitation } from './invitation.ts';
import { ProfileForm } from './ProfileForm.tsx';
import { Reader } from './Reader.tsx';
import { SignIn } from './SignIn.tsx';

type State =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'setup'; profile: Profile; notice: string | null }
  | { kind: 'home'; profile: Profile; notice: string | null }
  | { kind: 'error'; message: string };

// A link opened while already signed in joins without the code step.
async function acceptPending(): Promise<string | null> {
  const token = pendingInvitation();
  if (!token) return null;
  try {
    const result = await api.acceptInvitation(token);
    clearInvitation();
    return result.invitation === 'invalid' ? invalidInvitationMessage : null;
  } catch {
    // Kept for the next load; the member is signed in either way.
    return null;
  }
}

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    api
      .me()
      .then(async (profile) => setState({ kind: 'home', profile, notice: await acceptPending() }))
      .catch((error) => {
        if (error instanceof ApiFailure && error.status === 401) setState({ kind: 'signed-out' });
        else setState({ kind: 'error', message: 'Cannot reach the server. Reload to try again.' });
      });
  }, []);

  switch (state.kind) {
    case 'loading':
      return <main className="screen" aria-busy="true" />;
    case 'error':
      return (
        <main className="screen">
          <p role="alert">{state.message}</p>
        </main>
      );
    case 'signed-out':
      // A first sign-in goes through profile setup so the name and time zone are the member's own.
      return <SignIn onSignedIn={(profile, notice) => setState({ kind: 'setup', profile, notice })} />;
    case 'setup':
      return (
        <main className="screen">
          <h1>Welcome</h1>
          {state.notice && <p role="alert">{state.notice}</p>}
          <p>Check your name and time zone. Meeting times are shown in this zone.</p>
          <ProfileForm profile={state.profile} useBrowserZone onSaved={(profile) => setState({ kind: 'home', profile, notice: null })} />
        </main>
      );
    case 'home':
      return (
        <Home
          profile={state.profile}
          notice={state.notice}
          onChange={(profile) => setState({ kind: 'home', profile, notice: null })}
          onSignedOut={() => setState({ kind: 'signed-out' })}
        />
      );
  }
}

// Home is the reader; the account sits behind a menu so the text keeps the screen.
function Home(props: { profile: Profile; notice: string | null; onChange: (profile: Profile) => void; onSignedOut: () => void }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [showGroup, setShowGroup] = useState(false);

  useEffect(() => {
    api
      .groups()
      .then(setGroups)
      .catch(() => setGroups([]));
  }, []);
  const group = groups?.[0] ?? null;

  async function signOut() {
    await api.logout().catch(() => undefined);
    props.onSignedOut();
  }

  return (
    <div className="reader">
      <div className="home-bar">
        <button type="button" className="link" aria-expanded={showGroup} disabled={groups === null} onClick={() => setShowGroup(!showGroup)}>
          {group?.name ?? 'Group'}
        </button>
        <button type="button" className="link account-toggle" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          {props.profile.displayName}
        </button>
      </div>
      {props.notice && <p role="alert">{props.notice}</p>}
      {showGroup &&
        (group ? (
          <GroupPanel groupId={group.id} userId={props.profile.id} />
        ) : (
          <section className="group" aria-label="Group">
            <p>You are not in a group yet. Open the invitation link the group's owner sent you.</p>
          </section>
        ))}
      {menu && (
        <section className="account" aria-label="Account">
          <p>
            Signed in as <strong>{props.profile.displayName}</strong> ({props.profile.email}), {props.profile.timeZone}.
          </p>
          {editing ? (
            <ProfileForm
              profile={props.profile}
              onSaved={(profile) => {
                props.onChange(profile);
                setEditing(false);
              }}
            />
          ) : (
            <button type="button" onClick={() => setEditing(true)}>
              Edit profile
            </button>
          )}
          <button type="button" className="secondary" onClick={signOut}>
            Sign out
          </button>
        </section>
      )}
      <Reader />
    </div>
  );
}
