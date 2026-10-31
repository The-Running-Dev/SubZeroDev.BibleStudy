// This browser's id among the user's devices, sent with each note change so a conflict can say where each side came from.
// Kept across sign-ins; a private window, or storage that is blocked, gets a new one each page load.

const storageKey = 'bible-study.device';

let memory: string | null = null;

export function deviceId(): string {
  if (memory) return memory;
  try {
    memory = localStorage.getItem(storageKey);
    if (!memory) {
      memory = crypto.randomUUID();
      localStorage.setItem(storageKey, memory);
    }
  } catch {
    memory ??= crypto.randomUUID();
  }
  return memory;
}
