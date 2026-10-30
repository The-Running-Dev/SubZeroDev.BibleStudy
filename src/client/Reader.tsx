import { Fragment, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ChapterView, PassageRef, TranslationId, TranslationView } from '../shared/api.ts';
import { adjacentChapter, bookById, books } from '../shared/books.ts';
import { formatReference, parseReference } from '../shared/reference.ts';
import { api, messageFor } from './api.ts';

type Text = { kind: 'loading' } | { kind: 'ready'; chapter: ChapterView } | { kind: 'unavailable'; message: string };

const start: PassageRef = { bookId: 'ROM', chapter: 1, startVerse: null, endVerse: null };

export function Reader() {
  const [translations, setTranslations] = useState<TranslationView[]>([]);
  const [translationId, setTranslationId] = useState<TranslationId>('BSB');
  const [at, setAt] = useState<PassageRef>(start);
  const [text, setText] = useState<Text>({ kind: 'loading' });
  const [entry, setEntry] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);

  useEffect(() => {
    api
      .translations()
      .then(setTranslations)
      .catch(() => setTranslations([]));
  }, []);

  useEffect(() => {
    let current = true;
    setText({ kind: 'loading' });
    api
      .chapter(translationId, at.bookId, at.chapter)
      .then((chapter) => current && setText({ kind: 'ready', chapter }))
      .catch((error) => current && setText({ kind: 'unavailable', message: messageFor(error) }));
    return () => {
      current = false;
    };
  }, [translationId, at.bookId, at.chapter]);

  const shown = text.kind === 'ready' && text.chapter.bookId === at.bookId && text.chapter.chapter === at.chapter ? text.chapter : null;

  // A jump to a verse scrolls it into view once its chapter is on screen; a plain chapter starts at the top.
  // `at` is a new object on every jump, so entering the same reference again scrolls back to it.
  useEffect(() => {
    if (!shown) return;
    const target = at.startVerse === null ? null : document.getElementById(`v-${at.startVerse}`);
    if (target) target.scrollIntoView({ block: 'center' });
    else window.scrollTo({ top: 0 });
    if (at.startVerse !== null && !target) setEntryError(`${formatReference({ ...at, startVerse: null, endVerse: null })} has ${shown.verseCount} verses.`);
  }, [shown, at]);

  const book = bookById(at.bookId)!;
  const notice = translations.find((t) => t.id === translationId)?.copyrightNotice;
  const previous = adjacentChapter(at, -1);
  const next = adjacentChapter(at, 1);
  const go = (bookId: string, chapter: number) => setAt({ bookId, chapter, startVerse: null, endVerse: null });
  const marked = (verse: number) => shown !== null && at.startVerse !== null && verse >= at.startVerse && verse <= (at.endVerse ?? at.startVerse);

  function jump(event: FormEvent) {
    event.preventDefault();
    const ref = parseReference(entry);
    if (!ref) {
      setEntryError(`"${entry}" is not a reference. Try "Romans 3:12".`);
      return;
    }
    setEntryError(null);
    setEntry('');
    setAt(ref);
  }

  return (
    <>
      <header className="reader-bar">
        <h1 aria-live="polite" data-testid="reference">
          {formatReference(at)}
        </h1>
        <div className="reader-controls">
          <select value={translationId} onChange={(e) => setTranslationId(e.target.value as TranslationId)} aria-label="Translation">
            {(translations.length ? translations.map((t) => t.id) : (['BSB'] as TranslationId[])).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <select value={at.bookId} onChange={(e) => go(e.target.value, 1)} aria-label="Book">
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select value={at.chapter} onChange={(e) => go(at.bookId, Number(e.target.value))} aria-label="Chapter">
            {Array.from({ length: book.chapters }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
        </div>
        <form className="reader-jump" onSubmit={jump}>
          <input value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="Go to, e.g. Romans 3:12" aria-label="Reference" enterKeyHint="go" />
          <button type="submit">Go</button>
        </form>
        {entryError && <p role="alert">{entryError}</p>}
      </header>

      <article className="passage" aria-busy={text.kind === 'loading'}>
        {text.kind === 'unavailable' && <p role="status">{text.message}</p>}
        {text.kind === 'ready' && <Passage chapter={text.chapter} marked={marked} />}
        {text.kind === 'ready' && notice && <p className="copyright">{notice}</p>}
      </article>

      <nav className="chapter-nav" aria-label="Chapters">
        <button type="button" className="secondary" disabled={!previous} onClick={() => previous && go(previous.bookId, previous.chapter)}>
          ‹ {previous ? `${bookById(previous.bookId)!.name} ${previous.chapter}` : 'Previous'}
        </button>
        <button type="button" className="secondary" disabled={!next} onClick={() => next && go(next.bookId, next.chapter)}>
          {next ? `${bookById(next.bookId)!.name} ${next.chapter}` : 'Next'} ›
        </button>
      </nav>
    </>
  );
}

function Passage(props: { chapter: ChapterView; marked: (verse: number) => boolean }) {
  const { chapter } = props;
  return (
    <>
      {chapter.verses.map((verse) => (
        <Fragment key={verse.number}>
          {chapter.headings
            .filter((h) => h.beforeVerse === verse.number)
            .map((h, i) => (
              <h2 key={i} className="passage-heading">
                {h.text}
              </h2>
            ))}
          <p id={`v-${verse.number}`} className={props.marked(verse.number) ? 'verse marked' : 'verse'} aria-current={props.marked(verse.number) ? 'true' : undefined}>
            <sup className="verse-number">{verse.number}</sup>
            {verse.text}
          </p>
        </Fragment>
      ))}
      {chapter.footnotes.length > 0 && (
        <aside className="footnotes" aria-label="Footnotes">
          {chapter.footnotes.map((note, i) => (
            <p key={i}>
              <a href={`#v-${note.verse}`}>{note.verse}</a> {note.text}
            </p>
          ))}
        </aside>
      )}
    </>
  );
}
