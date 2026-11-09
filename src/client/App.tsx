import { useEffect, useState } from 'react';
import type { GroupSummary, Profile } from '../shared/api.ts';
import { ApiFailure, api } from './api.ts';
import { DownloadsList } from './Download.tsx';
import { GroupPanel } from './Group.tsx';
import { InstallHelp } from './InstallHelp.tsx';
import { clearInvitation, invalidInvitationMessage, pendingInvitation } from './invitation.ts';
import { forgetProfile, rememberProfile, rememberedProfile } from './offline.ts';
import { ProfileForm } from './ProfileForm.tsx';
import { Reader } from './Reader.tsx';
import { onAccountSwitch, onUpdateReady, requestUpdate, switchAccount, updateReady } from './shell.ts';
import type { UpdateResult } from './shell.ts';
import { SignIn } from './SignIn.tsx';
import { OwnerStatusPanel } from './OwnerStatus.tsx';
import { Study } from './Study.tsx';

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

const refusals: Record<Extract<UpdateResult, { applied: false }>['reason'], string> = {
  live_session: 'Leave the study session first, then update.',
  signing_in: 'Finish signing in first, then update.',
  multiple_windows: 'Close the other windows of this app first, then update.',
};

// S16: a new build is applied only when the member says so, and only when nothing would be cut off.
function UpdatePrompt() {
  const [ready, setReady] = useState(updateReady);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => onUpdateReady(() => setReady(true)), []);
  if (!ready) return null;
  async function apply() {
    const result = await requestUpdate();
    setRefused(result.applied ? null : refusals[result.reason]);
  }
  return (
    <div className="update-ready" role="status">
      <span>Update ready</span>
      <button type="button" onClick={apply}>
        Update
      </button>
      {refused && <span className="update-refused">{refused}</span>}
    </div>
  );
}

export function App() {
  return (
    <>
      <UpdatePrompt />
      <Account />
    </>
  );
}

function Account() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const signedIn = state.kind === 'home' || state.kind === 'setup' ? state.profile.id : null;

  useEffect(() => {
    api
      .me()
      .then(async (profile) => setState({ kind: 'home', profile, notice: await acceptPending() }))
      .catch((error) => {
        if (error instanceof ApiFailure && error.status === 401) {
          forgetProfile();
          setState({ kind: 'signed-out' });
          return;
        }
        // S14.2: with no server, the member last signed in on this device still reaches their downloads.
        const remembered = rememberedProfile<Profile>();
        if (remembered) setState({ kind: 'home', profile: remembered, notice: 'Server unavailable — showing what is on this device.' });
        else setState({ kind: 'error', message: 'Cannot reach the server. Reload to try again.' });
      });
  }, []);

  useEffect(() => {
    if (state.kind === 'home' || state.kind === 'setup') rememberProfile(state.profile);
  }, [state]);

  // Another window logged out or signed in as someone else: this one stops showing the account at once.
  useEffect(() => {
    if (!signedIn) return;
    return onAccountSwitch((userId) => {
      if (userId !== signedIn) setState({ kind: 'signed-out' });
    });
  }, [signedIn]);

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
      return (
        <SignIn
          onSignedIn={(profile, notice) => {
            void switchAccount(profile.id);
            setState({ kind: 'setup', profile, notice });
          }}
        />
      );
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

// Home is the reader, or the group's study; the account sits behind a menu so the text keeps the screen.
function Home(props: { profile: Profile; notice: string | null; onChange: (profile: Profile) => void; onSignedOut: () => void }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [showGroup, setShowGroup] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  // A reminder email's Open study link lands on /study.
  const [studying, setStudying] = useState(() => window.location.pathname === '/study');

  useEffect(() => {
    if (window.location.pathname === '/study') window.history.replaceState(null, '', '/');
  }, []);

  useEffect(() => {
    api
      .groups()
      .then(setGroups)
      .catch(() => setGroups([]));
  }, []);
  const group = groups?.[0] ?? null;

  async function signOut() {
    await api.logout().catch(() => undefined);
    forgetProfile();
    await switchAccount(null);
    props.onSignedOut();
  }

  return (
    <div className="reader">
      <div className="home-bar">
        <button type="button" className="link" aria-expanded={showGroup} disabled={groups === null} onClick={() => setShowGroup(!showGroup)}>
          {group?.name ?? 'Group'}
        </button>
        {group && (
          <button type="button" className="link" aria-pressed={studying} onClick={() => setStudying(!studying)}>
            {studying ? 'Read alone' : 'Study'}
          </button>
        )}
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
          {groups?.some((g) => g.role === 'owner') && (
            <button type="button" className="secondary" aria-expanded={showStatus} onClick={() => setShowStatus(!showStatus)}>
              Operational status
            </button>
          )}
          {showStatus && <OwnerStatusPanel />}
          <DownloadsList userId={props.profile.id} />
          <InstallHelp />
        </section>
      )}
      {studying && group ? <Study groupId={group.id} userId={props.profile.id} /> : <Reader groupId={group?.id ?? null} userId={props.profile.id} />}
    </div>
  );
}
