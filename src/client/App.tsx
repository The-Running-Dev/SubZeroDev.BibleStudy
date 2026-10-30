import { useEffect, useState } from 'react';
import type { Profile } from '../shared/api.ts';
import { ApiFailure, api } from './api.ts';
import { ProfileForm } from './ProfileForm.tsx';
import { SignIn } from './SignIn.tsx';

type State = { kind: 'loading' } | { kind: 'signed-out' } | { kind: 'setup'; profile: Profile } | { kind: 'home'; profile: Profile } | { kind: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    api
      .me()
      .then((profile) => setState({ kind: 'home', profile }))
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
      return <SignIn onSignedIn={(profile) => setState({ kind: 'setup', profile })} />;
    case 'setup':
      return (
        <main className="screen">
          <h1>Welcome</h1>
          <p>Check your name and time zone. Meeting times are shown in this zone.</p>
          <ProfileForm profile={state.profile} useBrowserZone onSaved={(profile) => setState({ kind: 'home', profile })} />
        </main>
      );
    case 'home':
      return <Home profile={state.profile} onChange={(profile) => setState({ kind: 'home', profile })} onSignedOut={() => setState({ kind: 'signed-out' })} />;
  }
}

function Home(props: { profile: Profile; onChange: (profile: Profile) => void; onSignedOut: () => void }) {
  const [editing, setEditing] = useState(false);

  async function signOut() {
    await api.logout().catch(() => undefined);
    props.onSignedOut();
  }

  return (
    <main className="screen">
      <h1>Bible Study</h1>
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
    </main>
  );
}
