// Every time-dependent rule reads time from a Clock, so tests can move it.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private current: number;
  // Set while the clock runs with real time, for browser tests that play audio against it.
  private runningSince: number | null = null;

  constructor(start: Date | string = '2026-11-01T12:00:00Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current + (this.runningSince === null ? 0 : Date.now() - this.runningSince));
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(at: Date | string): void {
    this.current = new Date(at).getTime();
    if (this.runningSince !== null) this.runningSince = Date.now();
  }

  // From now on the clock moves with real time, still offset by advance() and set().
  run(): void {
    if (this.runningSince !== null) return;
    this.runningSince = Date.now();
  }
}
