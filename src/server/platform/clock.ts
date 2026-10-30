// Every time-dependent rule reads time from a Clock, so tests can move it.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date | string = '2026-11-01T12:00:00Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(at: Date | string): void {
    this.current = new Date(at).getTime();
  }
}
