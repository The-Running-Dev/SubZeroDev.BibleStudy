import { useEffect, useRef, useState } from 'react';
import { bookById } from '../shared/books.ts';
import { messageFor } from './api.ts';
import { downloadChapter, downloadManifest, downloadState, formatBytes, listDownloads, removeDownload, storageAvailable } from './offline.ts';
import type { ChapterRef, DownloadState, DownloadSummary } from './offline.ts';

const label = (ref: ChapterRef) => `${bookById(ref.bookId)?.name ?? ref.bookId} ${ref.chapter} (${ref.translationId})`;

type Sizes = { text: number | null; narration: number | null; error: string | null } | null;

// Keeping the displayed chapter on this device for reading with no connection (S14.1, S14.3).
export function Download(props: { userId: string; at: ChapterRef; narrated: boolean; fromDevice: boolean }) {
  const { userId, at, narrated, fromDevice } = props;
  const [state, setState] = useState<DownloadState>({ state: 'absent' });
  const [open, setOpen] = useState(false);
  const [sizes, setSizes] = useState<Sizes>(null);
  const [withNarration, setWithNarration] = useState(narrated);
  const abort = useRef<AbortController | null>(null);
  const key = `${at.translationId}/${at.bookId}/${at.chapter}`;

  useEffect(() => {
    let current = true;
    setOpen(false);
    setSizes(null);
    downloadState(userId, at)
      .then((s) => current && setState(s))
      .catch(() => current && setState({ state: 'absent' }));
    return () => {
      current = false;
      abort.current?.abort();
    };
    // `at` is a new object each render; the key names the chapter.
  }, [userId, key]);

  if (!storageAvailable()) return null;
  if (fromDevice) {
    return (
      <p className="download-note" role="status">
        Reading the copy downloaded to this device.
      </p>
    );
  }

  async function showSizes() {
    setOpen(true);
    setWithNarration(narrated);
    setSizes(null);
    try {
      const text = await downloadManifest(at, false);
      const narration = narrated ? await downloadManifest(at, true).then((m) => m.totalBytes, () => null) : null;
      setSizes({ text: text.totalBytes, narration, error: null });
    } catch (error) {
      setSizes({ text: null, narration: null, error: messageFor(error) });
    }
  }

  async function start() {
    const controller = new AbortController();
    abort.current = controller;
    setOpen(false);
    setState({ state: 'downloading', doneBytes: 0, totalBytes: 0 });
    const result = await downloadChapter(userId, at, withNarration && sizes?.narration != null, controller.signal, (s) => {
      if (!controller.signal.aborted) setState(s);
    });
    abort.current = null;
    setState(result);
  }

  async function remove() {
    await removeDownload(userId, at);
    setState({ state: 'absent' });
  }

  const percent = state.state === 'downloading' && state.totalBytes > 0 ? Math.floor((state.doneBytes / state.totalBytes) * 100) : 0;

  return (
    <section className="download" aria-label="Offline download">
      {state.state === 'absent' && !open && (
        <button type="button" className="secondary" onClick={() => void showSizes()}>
          Download for offline
        </button>
      )}
      {state.state === 'downloading' && (
        <div className="download-progress">
          <progress max={100} value={percent} aria-label="Download progress" />
          <span>{percent}%</span>
          <button type="button" className="secondary" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        </div>
      )}
      {state.state === 'ready' && (
        <div className="download-row">
          <span role="status">Downloaded{state.withNarration ? ' with narration' : ''} — readable offline.</span>
          <button type="button" className="secondary" onClick={() => void remove()}>
            Remove download
          </button>
        </div>
      )}
      {state.state === 'failed' && !open && (
        <div className="download-row">
          <span role="alert">Download failed — {state.reason}</span>
          <button type="button" className="secondary" onClick={() => void showSizes()}>
            Retry
          </button>
        </div>
      )}
      {state.state === 'expired' && !open && (
        <div className="download-row">
          <span role="status">This download has expired.</span>
          <button type="button" className="secondary" onClick={() => void showSizes()}>
            Download again
          </button>
        </div>
      )}
      {open && (
        <div className="download-dialog" role="dialog" aria-label={`Download ${label(at)}`}>
          <p>
            <strong>Download {label(at)}</strong>
          </p>
          {!sizes && <p>Checking sizes…</p>}
          {sizes?.error && <p role="alert">{sizes.error}</p>}
          {sizes?.text != null && (
            <fieldset>
              <label>
                <input type="radio" name="download-kind" checked={!withNarration || sizes.narration == null} onChange={() => setWithNarration(false)} />
                Text only · {formatBytes(sizes.text)}
              </label>
              {narrated && (
                <label>
                  <input type="radio" name="download-kind" disabled={sizes.narration == null} checked={withNarration && sizes.narration != null} onChange={() => setWithNarration(true)} />
                  Text and narration · {sizes.narration == null ? 'narration not ready to download' : formatBytes(sizes.narration)}
                </label>
              )}
            </fieldset>
          )}
          <div className="download-row">
            <button type="button" disabled={sizes?.text == null} onClick={() => void start()}>
              Download
            </button>
            <button type="button" className="secondary" onClick={() => setOpen(false)}>
              Not now
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// Every chapter this member has downloaded on this device, with a way to remove each (S14.5).
export function DownloadsList(props: { userId: string }) {
  const [items, setItems] = useState<DownloadSummary[] | null>(null);

  useEffect(() => {
    let current = true;
    listDownloads(props.userId)
      .then((list) => current && setItems(list))
      .catch(() => current && setItems([]));
    return () => {
      current = false;
    };
  }, [props.userId]);

  if (!storageAvailable()) return null;

  async function remove(item: DownloadSummary) {
    await removeDownload(props.userId, item);
    setItems((all) => all?.filter((i) => i !== item) ?? null);
  }

  return (
    <section className="downloads" aria-label="Downloads on this device">
      <h2>Downloads on this device</h2>
      {items === null && <p>Loading…</p>}
      {items?.length === 0 && <p>No chapters downloaded on this device.</p>}
      {items && items.length > 0 && (
        <ul>
          {items.map((item) => (
            <li key={`${item.translationId}/${item.bookId}/${item.chapter}`}>
              <span>
                {label(item)} · {item.withNarration ? 'with narration' : 'text only'} · {formatBytes(item.totalBytes)}
                {item.expired ? ' · expired' : ''}
              </span>
              <button type="button" className="secondary" onClick={() => void remove(item)} aria-label={`Remove ${label(item)}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
