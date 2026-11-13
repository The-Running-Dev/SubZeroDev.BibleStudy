import { useEffect, useRef, useState } from 'react';
import { bookById } from '../shared/books.ts';
import type { TranslationId } from '../shared/api.ts';
import { downloadBible, bibleChapterCount, savedBibleChapterCount } from './bible-download.ts';
import type { BibleDownloadProgress } from './bible-download.ts';
import { downloadsChangedEvent, notifyDownloadsChanged, storageAvailable } from './offline.ts';
import { useOnline } from './online.ts';

export function BibleDownload({ userId, translationId }: { userId: string; translationId: TranslationId }) {
  const [saved, setSaved] = useState<number | null>(null);
  const [progress, setProgress] = useState<BibleDownloadProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const online = useOnline();

  useEffect(() => {
    let current = true;
    const refresh = () => {
      if (controller.current) return;
      void savedBibleChapterCount(userId, translationId).then((count) => {
        if (current && !controller.current) setSaved(count);
      }).catch(() => {
        if (current) {
          setNotice('Could not check device storage. Try again.');
          setFailed(true);
        }
      });
    };
    refresh();
    window.addEventListener(downloadsChangedEvent, refresh);
    return () => {
      current = false;
      controller.current?.abort();
      controller.current = null;
      window.removeEventListener(downloadsChangedEvent, refresh);
    };
  }, [userId, translationId]);

  if (!storageAvailable()) return null;

  async function start() {
    const abort = new AbortController();
    controller.current = abort;
    setNotice(null);
    setFailed(false);
    setProgress({ saved: saved ?? 0, current: null });
    const result = await downloadBible(userId, translationId, abort.signal, (next) => {
      if (controller.current === abort) {
        setSaved(next.saved);
        setProgress(next);
      }
    });
    if (controller.current !== abort) return;
    controller.current = null;
    setSaved(result.saved);
    setProgress(null);
    setFailed(result.state === 'failed');
    setNotice(result.state === 'paused' ? 'Download paused. Resume to keep going; saved chapters are kept.' : result.state === 'failed' ? `${translationId} download stopped — ${result.reason} Saved chapters are kept.` : null);
    notifyDownloadsChanged();
  }

  const complete = saved === bibleChapterCount && progress === null;
  return (
    <section className="download" aria-label={`Entire ${translationId} Bible offline`}>
      {complete ? <p role="status">{translationId} Bible downloaded — all 1,189 chapters are readable offline.</p> : <>
        <p>Save the entire {translationId} Bible on this device: all 1,189 chapters, with headings and notes. Keep this page open while downloading.</p>
        <div className="download-row">
          {progress ? <button type="button" className="secondary" onClick={() => controller.current?.abort()}>Pause {translationId} download</button> :
            <button type="button" disabled={!online || (saved === null && !failed)} onClick={() => void start()}>{saved ? `Resume ${translationId} download` : `Download entire ${translationId} Bible`}</button>}
          <span role="status">{saved === null ? `Checking saved ${translationId} chapters…` : `${saved.toLocaleString('en-US')} of 1,189 chapters saved`}</span>
        </div>
        {progress && <div className="download-progress">
          <progress max={bibleChapterCount} value={saved ?? 0} aria-label={`Entire ${translationId} Bible download progress`} />
          {progress.current && <span>Saving {bookById(progress.current.bookId)?.name} {progress.current.chapter}…</span>}
        </div>}
        {!online && <p>Connect to the internet to download the remaining chapters.</p>}
      </>}
      {notice && <p role={failed ? 'alert' : 'status'}>{notice}</p>}
    </section>
  );
}
