import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { detectTurnEnd, lineMentionsPrompt, newestChatDir, partialAnswer, projectKey, readChats } from "../src/protocol/chatStore";
import type { ChatDirSnapshot, TurnBaseline } from "../src/protocol/chatStore";

const dir = new URL("./fixtures/chat/", import.meta.url);
const load = (name: string): string => readFileSync(new URL(name, dir), "utf8");
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const upTo = (text: string, marker: string): number => bytes(text.slice(0, text.indexOf(marker) + marker.length));
const prefix = (text: string, logBytes: number): string => Buffer.from(text, "utf8").subarray(0, logBytes).toString("utf8");

const snap = (dirName: string, mtimeMs: number, logText: string, logBytes = bytes(logText)): ChatDirSnapshot =>
  ({ dirName, mtimeMs, logBytes, logText });
const baselineOf = (s: ChatDirSnapshot): TurnBaseline => ({ dirName: s.dirName, logBytes: s.logBytes });

describe("projectKey", () => {
  it("keys the chat store by the plain basename", () => {
    expect(projectKey("C:/work/demo-app")).toBe("demo-app");
  });

  it("accepts basename collisions across parents (issue #1)", () => {
    expect(projectKey("C:/work/demo-app")).toBe(projectKey("D:/elsewhere/demo-app"));
  });
});

describe("lineMentionsPrompt", () => {
  const prompt = "Reply with exactly one word and nothing else: ping";

  it("matches the prompt as the msg field", () => {
    expect(lineMentionsPrompt({ msg: prompt }, prompt)).toBe(true);
  });

  it("matches an exact data.prompt (stub and small real pastes)", () => {
    expect(lineMentionsPrompt({ data: { prompt } }, prompt)).toBe(true);
  });

  it("matches a `[Pasted Text]`-labeled paste carrying the prompt as tail (2026-09 CLI)", () => {
    expect(lineMentionsPrompt({ data: { prompt: `[Pasted Text]\n${prompt}` } }, prompt)).toBe(true);
  });

  it("rejects an unrelated stored prompt", () => {
    expect(lineMentionsPrompt({ data: { prompt: "unrelated" } }, prompt)).toBe(false);
  });

  it("rejects a near-miss that does not end with the prompt", () => {
    expect(lineMentionsPrompt({ data: { prompt: `x${prompt.slice(1)}` } }, prompt)).toBe(false);
    expect(lineMentionsPrompt({ data: { prompt: prompt.slice(0, -1) } }, prompt)).toBe(false);
  });

  it("rejects when the prompt is present but not as tail", () => {
    expect(lineMentionsPrompt({ data: { prompt: `${prompt}\ntrailing chatter` } }, prompt)).toBe(false);
  });
});

describe("newestChatDir", () => {
  it("returns null when there are no chat dirs", () => {
    expect(newestChatDir([])).toBeNull();
  });

  it("picks the dir with the newest mtime", () => {
    const a = snap("chat-a", 1000, "");
    const b = snap("chat-b", 2000, "");
    expect(newestChatDir([a, b])).toBe(b);
  });

  it("breaks mtime ties by dirName", () => {
    const a = snap("chat-a", 1000, "");
    const b = snap("chat-b", 1000, "");
    expect(newestChatDir([a, b])).toBe(b);
  });
});

describe("detectTurnEnd", () => {
  it("sees a completed turn and extracts the answer", () => {
    const text = load("full-turn.jsonl");
    const baseline: TurnBaseline = { dirName: "chat-001", logBytes: upTo(text, '"parts":["fix the login bug"]') };
    expect(detectTurnEnd([snap("chat-001", 1000, text)], baseline)).toEqual({ done: true, answer: "Fixed the login redirect." });
  });

  it("tolerates lazy flushes spread over several observations", () => {
    const text = load("lazy-flush.jsonl");
    const head = text.slice(0, text.indexOf("\n") + 1);
    const baseline: TurnBaseline = { dirName: "chat-002", logBytes: bytes(head) };

    expect(detectTurnEnd([snap("chat-002", 1000, head)], baseline)).toEqual({ done: false, answer: null });

    const cut = text.indexOf('"msg"') + '"msg":"Main prompt fin'.length;
    expect(detectTurnEnd([snap("chat-002", 1000, prefix(text, cut))], baseline)).toEqual({ done: false, answer: null });

    expect(detectTurnEnd([snap("chat-002", 1000, text)], baseline)).toEqual({ done: true, answer: "Added /health returning ok." });
  });

  it("follows a completion into a newer chat dir", () => {
    const before = load("newer-dir-before.jsonl");
    const after = load("newer-dir-after.jsonl");
    const old = snap("2026-09-23--a111", 1000, before);
    const newer = snap("2026-09-23--b222", 2000, after);
    expect(detectTurnEnd([old, newer], baselineOf(old))).toEqual({ done: true, answer: "Refactor complete." });
  });

  it("finds the answer even when it predates the baseline", () => {
    const text = load("answer-below-baseline.jsonl");
    const baseline: TurnBaseline = { dirName: "chat-004", logBytes: upTo(text, '"parts":["now benchmark it"]') };
    expect(detectTurnEnd([snap("chat-004", 1000, text)], baseline)).toEqual({ done: true, answer: "Parser handles nested lists." });
  });

  it("detects completion past a baseline that contains multibyte characters", () => {
    const text =
      '{"type":"user","parts":["explain 🤖 emoji handling"]}\n' +
      '{"type":"end","role":"agent","shouldEndTurn":true,"data":{"fullResponse":"Emoji-safe."}}\n' +
      '{"msg":"Main prompt finished"}\n';
    const baseline: TurnBaseline = { dirName: "chat-007", logBytes: upTo(text, '"parts":["explain 🤖 emoji handling"]') };
    expect(detectTurnEnd([snap("chat-007", 1000, text)], baseline)).toEqual({ done: true, answer: "Emoji-safe." });
  });

  it("ignores a JSONL line split at the byte boundary", () => {
    const text = load("split-line.jsonl");
    const s = snap("chat-005", 1000, text, upTo(text, '"parts":["run the tests"]}'));
    expect(detectTurnEnd([s], baselineOf(s))).toEqual({ done: false, answer: null });
  });

  it("stays pending without a completion line", () => {
    const text = load("no-completion.jsonl");
    const s = snap("chat-006", 1000, text);
    expect(detectTurnEnd([s], baselineOf(s))).toEqual({ done: false, answer: null });
  });

  it("scans past a torn non-JSON line before the completion marker", () => {
    const text =
      '{"type":"end","role":"agent","shouldEndTurn":true,"data":{"fullResponse":"Kept the answer."}}\n' +
      '{"msg":"Main prompt finished"  // torn append\n' +
      '{"msg":"Main prompt finished"}\n';
    const s = snap("chat-008", 1000, text, 0);
    expect(detectTurnEnd([s], baselineOf(s))).toEqual({ done: true, answer: "Kept the answer." });
  });
});

describe("partialAnswer", () => {
  it("takes the last unfinished step's fullResponse over earlier ones", () => {
    const text =
      '{"shouldEndTurn":false,"data":{"fullResponse":"first step"}}\n' +
      '{"shouldEndTurn":false,"data":{"fullResponse":"second step"}}\n';
    expect(partialAnswer(text)).toBe("second step");
  });

  it("ignores completed-turn lines", () => {
    const text =
      '{"shouldEndTurn":true,"data":{"fullResponse":"the finished answer"}}\n' +
      '{"shouldEndTurn":false,"data":{"fullResponse":"the partial"}}\n';
    expect(partialAnswer(text)).toBe("the partial");
  });

  it("skips an unfinished line without a fullResponse and falls back to an earlier one", () => {
    const text =
      '{"shouldEndTurn":false,"data":{"fullResponse":"earlier step"}}\n' +
      '{"shouldEndTurn":false,"data":{}}\n' +
      '{"type":"user","parts":["still going"]}\n';
    expect(partialAnswer(text)).toBe("earlier step");
  });

  it("returns null with no unfinished step", () => {
    expect(partialAnswer("")).toBeNull();
    expect(partialAnswer('{"shouldEndTurn":true,"data":{"fullResponse":"done"}}\n')).toBeNull();
    expect(partialAnswer('{"msg":"hello"}\n')).toBeNull();
  });

  it("reads data.fullResponse else the top-level field", () => {
    expect(partialAnswer('{"shouldEndTurn":false,"data":{"fullResponse":"nested"}}\n')).toBe("nested");
    expect(partialAnswer('{"shouldEndTurn":false,"fullResponse":"top level"}\n')).toBe("top level");
  });

  it("tolerates torn lines around the partial", () => {
    const text =
      '{"shouldEndTurn":false,"data":{"fullResp' +
      "\n" +
      '{"shouldEndTurn":false,"data":{"fullResponse":"kept"}}\n';
    expect(partialAnswer(text)).toBe("kept");
  });
});

describe("readChats", () => {
  const root = mkdtempSync(join(tmpdir(), "chatstore-fs-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  // The on-disk layout, written literally: <configDir>/projects/<key>/chats/<chat>/log.jsonl.
  const store = (key: string): string => join(configDir, "projects", key, "chats");
  const logSnap = (chats: string, dirName: string, log: string): ChatDirSnapshot =>
    ({ dirName, mtimeMs: statSync(join(chats, dirName, "log.jsonl")).mtimeMs, logBytes: bytes(log), logText: log });

  it("reads a missing store as none", () => {
    expect(readChats(configDir, "C:/work/demo-app")).toEqual([]);
  });

  it("reads each chat dir with log mtime, size and text", () => {
    const chats = store("logged");
    const log = "first line\nsecond line\n";
    mkdirSync(join(chats, "chat-1"), { recursive: true });
    writeFileSync(join(chats, "chat-1", "log.jsonl"), log);
    expect(readChats(configDir, "C:/work/logged")).toEqual([logSnap(chats, "chat-1", log)]);
  });

  // freebuff creates the chat dir before log.jsonl exists (the Turn-start race);
  // the reader keeps the dir as a fallback entry instead of dropping it.
  it("keeps a log-less chat dir as a dir-mtime entry", () => {
    const chats = store("mixed");
    mkdirSync(join(chats, "chat-a"), { recursive: true });
    writeFileSync(join(chats, "chat-a", "log.jsonl"), "only line\n");
    mkdirSync(join(chats, "chat-b"), { recursive: true });
    expect(readChats(configDir, "C:/work/mixed")).toEqual([
      logSnap(chats, "chat-a", "only line\n"),
      { dirName: "chat-b", mtimeMs: statSync(join(chats, "chat-b")).mtimeMs, logBytes: 0, logText: "" },
    ]);
  });
});
