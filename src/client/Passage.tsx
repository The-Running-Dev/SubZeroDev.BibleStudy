import { Fragment } from 'react';
import type { ChapterView } from '../shared/api.ts';

// `onTap` makes each verse a button (the shared manual verse marker).
export function Passage(props: { chapter: ChapterView; marked: (verse: number) => boolean; playing: number | null; onTap?: (verse: number) => void }) {
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
          <p
            id={`v-${verse.number}`}
            className={['verse', props.marked(verse.number) && 'marked', props.playing === verse.number && 'playing'].filter(Boolean).join(' ')}
            aria-current={props.marked(verse.number) ? 'true' : undefined}
            data-playing={props.playing === verse.number ? 'true' : undefined}
            role={props.onTap ? 'button' : undefined}
            tabIndex={props.onTap ? 0 : undefined}
            onClick={props.onTap ? () => props.onTap!(verse.number) : undefined}
            onKeyDown={props.onTap ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), props.onTap!(verse.number)) : undefined}
          >
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
