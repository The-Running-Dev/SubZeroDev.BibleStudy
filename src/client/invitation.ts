// The invitation token from a /join/<token> link. It is kept in memory and session storage so a
// reload during the code step (the installed app often reloads when switching to the mail app) keeps it.
const storageKey = 'bs_invitation';
let memory: string | null = null;

export const invalidInvitationMessage = "This invitation is no longer valid — ask the group's owner for a new link.";

export function captureInvitation(): void {
  const match = /^\/join\/([A-Za-z0-9_-]{1,128})\/?$/.exec(window.location.pathname);
  if (!match) return;
  memory = match[1];
  try {
    sessionStorage.setItem(storageKey, memory);
  } catch {
    // Storage blocked; memory still carries it while the page stays open.
  }
  // The token never stays in the address bar or history.
  window.history.replaceState(null, '', '/');
}

export function pendingInvitation(): string | null {
  if (memory) return memory;
  try {
    return sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

export function clearInvitation(): void {
  memory = null;
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // Nothing stored.
  }
}
