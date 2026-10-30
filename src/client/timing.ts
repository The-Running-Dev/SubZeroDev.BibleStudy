// The verse being read at `seconds`: the last one whose start is at or before it, or null before verse 1.
export function verseAt(starts: number[], seconds: number): number | null {
  let verse: number | null = null;
  for (let i = 0; i < starts.length && starts[i] <= seconds; i++) verse = i + 1;
  return verse;
}
