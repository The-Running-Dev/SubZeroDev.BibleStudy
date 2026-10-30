import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { CodeDelivery, Profile } from '../shared/api.ts';
import { api, messageFor } from './api.ts';

const slowDeliveryMs = 30_000;
const statusPollMs = 5_000;

export function SignIn(props: { onSignedIn: (profile: Profile) => void }) {
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestedAt, setRequestedAt] = useState(0);

  async function requestCode(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.requestCode(email);
      setStep('code');
      setCode('');
      setRequestedAt(Date.now());
    } catch (failure) {
      setError(messageFor(failure));
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.verifyCode(email, code);
      props.onSignedIn(result.user);
    } catch (failure) {
      setError(messageFor(failure));
      setBusy(false);
    }
  }

  if (step === 'email') {
    return (
      <main className="screen">
        <h1>Sign in</h1>
        <form onSubmit={requestCode}>
          <label>
            Email
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button type="submit" disabled={busy}>
            Email me a code
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  }

  return (
    <main className="screen">
      <h1>Enter your code</h1>
      <p>We sent a 6-digit code to {email}. It works once, for 10 minutes.</p>
      <form onSubmit={verify}>
        <label>
          Code
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        <button type="submit" disabled={busy || code.length !== 6}>
          Sign in
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      <DeliveryNotice email={email} requestedAt={requestedAt} />
      <button type="button" className="secondary" disabled={busy} onClick={() => requestCode()}>
        Send a new code
      </button>
      <button type="button" className="link" onClick={() => setStep('email')}>
        Use a different email
      </button>
    </main>
  );
}

// After 30 s without a sent code, tell the member the server is still trying.
function DeliveryNotice(props: { email: string; requestedAt: number }) {
  const [delivery, setDelivery] = useState<CodeDelivery>('queued');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setDelivery('queued');
    const timer = setInterval(async () => {
      setNow(Date.now());
      try {
        setDelivery((await api.codeStatus(props.email)).delivery);
      } catch {
        // Status is advisory; the code may still arrive.
      }
    }, statusPollMs);
    return () => clearInterval(timer);
  }, [props.email, props.requestedAt]);

  if (delivery === 'failed') return <p role="status">We could not send the code. Send a new one.</p>;
  if (delivery !== 'sent' && now - props.requestedAt >= slowDeliveryMs) return <p role="status">Code not sent yet — retrying.</p>;
  return null;
}
