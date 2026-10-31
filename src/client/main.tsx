import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { captureInstallPrompt } from './install.ts';
import { captureInvitation } from './invitation.ts';
import { watchForUpdate } from './shell.ts';
import './styles.css';

captureInvitation();
captureInstallPrompt();

// S14: the shell is stored for starts with no connection. Development builds have no service worker. S16: a new
// build waits for the member's approval; the browser looks for one on each start and this every hour.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker
    .register('/sw.js')
    .then((registration) => {
      watchForUpdate(registration);
      setInterval(() => void registration.update().catch(() => undefined), 60 * 60 * 1000);
    })
    .catch(() => undefined);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
