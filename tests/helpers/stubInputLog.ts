// Reader for the stub child's keystroke log (FREEBUFF_STUB_INPUT_LOG): the
// whitelist assertions in the e2e tiers go through this, so the event shapes
// cannot drift between suites.
import { readFileSync } from "node:fs";

export type StubEvent = { event: string; key?: string; text?: string; t: number; pid?: number };

export const readInputLog = (path: string): StubEvent[] =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as StubEvent);

export const eventsOf = (events: StubEvent[], event: string): StubEvent[] => events.filter((entry) => entry.event === event);

export const kindsOf = (events: StubEvent[]): string[] => events.map((entry) => entry.event);
