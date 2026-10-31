import { useEffect, useState } from 'react';
import { canPrompt, onInstallPromptChange, platform, promptInstall } from './install.ts';

// How to put the app on this phone's home screen, for the browser it is open in (S14.6).
export function InstallHelp() {
  const [prompting, setPrompting] = useState(canPrompt);
  const [installed, setInstalled] = useState(false);
  useEffect(() => onInstallPromptChange(() => setPrompting(canPrompt())), []);

  const where = platform();
  if (where === 'installed' || installed) return <p>This app is installed on this device.</p>;

  return (
    <section className="install-help" aria-label="Install on your phone">
      <h2>Install on your phone</h2>
      {where === 'ios-safari' && (
        <ol>
          <li>Tap the Share button (the square with an arrow) at the bottom of Safari.</li>
          <li>Scroll down and tap Add to Home Screen.</li>
          <li>Tap Add. Open Bible Study from the new icon and sign in once more there.</li>
        </ol>
      )}
      {where === 'ios-other' && <p>On iPhone, open this page in Safari, then tap Share and Add to Home Screen.</p>}
      {where !== 'ios-safari' && where !== 'ios-other' && prompting && (
        <button type="button" onClick={() => void promptInstall().then(setInstalled)}>
          Install Bible Study
        </button>
      )}
      {where === 'android' && !prompting && (
        <ol>
          <li>Open Chrome's menu (⋮, top right).</li>
          <li>Tap Install app, or Add to Home screen.</li>
          <li>Tap Install. Open Bible Study from the new icon.</li>
        </ol>
      )}
      {where === 'other' && !prompting && <p>Open this page on your phone: in Safari on iPhone, or in Chrome on Android.</p>}
      <p className="player-note">Chapters you download stay on the device where you downloaded them.</p>
    </section>
  );
}
