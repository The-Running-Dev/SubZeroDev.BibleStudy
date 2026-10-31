import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { captureInstallPrompt } from './install.ts';
import { captureInvitation } from './invitation.ts';
import './styles.css';

captureInvitation();
captureInstallPrompt();

// S14: the shell is stored for starts with no connection. Development builds have no service worker.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
