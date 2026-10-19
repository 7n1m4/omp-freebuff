// Protocol-faithful stub of the freebuff 0.2.29 TUI for driver e2e tests. Run
// under the repo's own runtime (`bun tests/helpers/stub-freebuff.mjs`) with no
// imports beyond node:fs/node:path: the screen wording and the chat-store layout
// duplicate src/ on purpose, so the driver under test stays the only side
// consuming the real modules. Frames replay the captured 0.2.29 fixtures
// verbatim; the cost modal replays its nearest capture.
//
// Env knobs:
// - FREEBUFF_CONFIG_DIR      chat-store root, <dir>/projects/<basename(cwd)>/chats/
// - FREEBUFF_STUB_MODE       happy (default) | no-ack | no-answer | first-submit |
//                            lost-first-submit | cost-modal | kill-mid-turn |
//                            slow-ack | takeover | displaced | unknown
// - FREEBUFF_STUB_INPUT_LOG  JSON-lines file; one line per keystroke class
// - FREEBUFF_STUB_HELD_LOG_MS 'exit' buffers every chat-store write until the
//                            process exits, so no Turn line lands while it runs
//                            (reserved for #20's detach e2e: ack by screen alone)
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const TURN_END_MSG = "Main prompt finished";
const PASTE_START = "200~";
const PASTE_END = "201~";
const CLEAR = "\x1b[2J\x1b[H";

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));
const out = (s) => process.stdout.write(s);

const mode = process.env.FREEBUFF_STUB_MODE ?? "happy";
const configDir = process.env.FREEBUFF_CONFIG_DIR;
const inputLog = process.env.FREEBUFF_STUB_INPUT_LOG ?? null;
const heldLogMs = process.env.FREEBUFF_STUB_HELD_LOG_MS ?? null;

const logInput = (entry) => {
  if (inputLog !== null) appendFileSync(inputLog, JSON.stringify({ t: Date.now(), ...entry }) + "\n");
};

// Fixtures store the flattened screen with \n behind a \x1b[2J\x1b[H prefix; the
// ConPTY across the driver needs \r\n like the real TUI. The trailing newline is
// dropped: a 48-row body plus a final CRLF would scroll the 48-row screen one
// row up.
const fixture = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const plain = (name) => fixture(name).replace("\x1b[2J\x1b[H", "").replace(/\n$/, "");
const frame = (name) => CLEAR + plain(name).replace(/\n/g, "\r\n");
const paint = (text) => out(CLEAR + text.replace(/\n/g, "\r\n"));

const welcomeBody = () => plain("../fixtures/screen/0.2.29/welcome.ansi");
const readyBody = () => plain("../fixtures/screen/0.2.29/ready.ansi");
const workingBody = () => plain("../fixtures/screen/0.2.29/working.ansi");
const takeOverBody = () => plain("../fixtures/screen/0.2.29/take-over-prompt.ansi");
const displacedBody = () => plain("../fixtures/screen/0.2.29/displaced.ansi");

// The answer echo reports the model the fixture footer names, the way the real
// CLI always runs whatever model it remembers.
const model = (() => {
  const line = plain("../fixtures/screen/0.2.29/welcome.ansi")
    .split("\n")
    .find((candidate) => candidate.includes("/model to change"));
  const bullet = line === undefined ? -1 : line.indexOf("•");
  return (bullet === -1 ? "" : line.slice(0, bullet)).trim() || "freebuff";
})();

// The draft frame: the queued-composer capture with the stranded prompt in the
// composer instead of the capture's own text, truncated to the row width.
const draftBody = (prompt) => {
  const lines = plain("../fixtures/screen/0.2.29/queued-composer.ansi").split("\n");
  const at = lines.findIndex((line) => line.includes("▍"));
  const shown = prompt.length > 154 ? prompt.slice(0, 154) : prompt;
  lines[at] = `│  ${shown}▍${" ".repeat(Math.max(1, 155 - shown.length))}│`;
  return lines.join("\n");
};

// The cost modal box replaces the composer box, where the live 0.2.12 capture
// shows it; the wording rows are the signature's strong and weak markers.
const modalBody = (underneath) => {
  const lines = underneath.split("\n");
  const top = lines.map((line) => line.startsWith("╭")).lastIndexOf(true);
  const bottom = lines.map((line) => line.startsWith("╰")).lastIndexOf(true);
  const row = (text) => `│ ${text.padEnd(157)}│`;
  const box = [
    `┌${"─".repeat(158)}┐`,
    row(`${model} costs 15 Freebucks/hr. Uses 5 from your wallet.`),
    row("Enter: confirm and send  Esc: back to draft"),
    `└${"─".repeat(158)}┘`,
  ];
  return [...lines.slice(0, top), ...box, ...lines.slice(bottom + 1)].join("\n");
};

// A frame no signature matches: no marker string, no bordered composer block.
const UNKNOWN_TITLE = "Quantum flux calibration panel";
const unknownBody = () =>
  [process.cwd(), "─".repeat(60), `  ${UNKNOWN_TITLE}`, "  Await further instructions.", "─".repeat(60), ""].join("\n");

const chatsRoot = () => join(configDir, "projects", basename(process.cwd()), "chats");
// The store may already carry chat dirs from earlier Turns (or pre-seeded
// ones); the next dir never reuses an index, or a Turn would append into an
// old chat and hide from the newer-dir scan.
const nextChatIndex = () => {
  let max = -1;
  try {
    for (const name of readdirSync(chatsRoot())) {
      const match = /^chat(?:-new)?-(\d+)$/.exec(name);
      if (match !== null) max = Math.max(max, Number(match[1]));
    }
  } catch {
    // No store yet.
  }
  return max + 1;
};
const chatsExist = () => {
  try {
    return readdirSync(chatsRoot()).length > 0;
  } catch {
    return false;
  }
};

// Every chat-store write of a Turn goes through here, so the held-flush knob
// covers the Ack, the Turn end and any line alike.
const heldExit = [];
let lastLogPath = null;
const storeWrite = (line) => {
  if (heldLogMs === "exit") heldExit.push([lastLogPath, line]);
  else appendFileSync(lastLogPath, line);
};
process.on("exit", () => {
  for (const [path, line] of heldExit) {
    try {
      appendFileSync(path, line);
    } catch {
      // The workspace may already be gone at exit; the held lines are then unobservable.
    }
  }
});

let phase = "idle"; // idle shows the Welcome screen, ready the session screen
let pending = "";
let pasting = false;
let pasted = "";
let csiState = 0; // 1: saw ESC, 2: inside a CSI sequence
let csi = "";
let escPending = false;
let newChatRequested = false;
let strandedDraft = null; // first-submit: the prompt stranded in the composer
let stranded = false; // first-submit: the strand already spent on the first submit
let heldDraft = null; // cost-modal: the draft behind the open modal
let modalOpen = false;
let modalArmed = mode === "cost-modal";
let lostFirst = false; // lost-first-submit: the swallow already spent on the first submit
let dialogStuck = mode === "takeover";
let unknownStuck = mode === "unknown";

const runTurn = async (prompt) => {
  phase = "ready";
  paint(workingBody());
  const dirName = newChatRequested ? `chat-new-${nextChatIndex()}` : `chat-${nextChatIndex()}`;
  newChatRequested = false;
  // The first-Turn-only guard reads the store before this Turn's dir exists,
  // so a later queued Task on a fresh stub completes normally.
  const crashThisTurn = mode === "kill-mid-turn" && !chatsExist();
  const dir = join(chatsRoot(), dirName);
  mkdirSync(dir, { recursive: true });
  lastLogPath = join(dir, "log.jsonl");
  const answer = `stub(${model}): ${prompt}`;
  await sleep(30 + Math.random() * 40);
  if (mode === "slow-ack") await sleep(1500);
  storeWrite(JSON.stringify({ msg: prompt }) + "\n");
  if (crashThisTurn) {
    setTimeout(() => process.exit(1), 100);
    return;
  }
  await sleep(30 + Math.random() * 40);
  storeWrite(
    JSON.stringify({
      type: "end",
      role: "agent",
      shouldEndTurn: true,
      data: mode === "no-answer" ? {} : { fullResponse: answer },
    }) + "\n",
  );
  await sleep(30 + Math.random() * 40);
  storeWrite(JSON.stringify({ msg: TURN_END_MSG }) + "\n");
  // A held-flush CLI is mid-Turn on screen too, so the repaint waits for the
  // same flush as the store lines: the working frame stays until exit.
  if (heldLogMs !== "exit") paint(readyBody());
};

const submit = async (prompt) => {
  if (!prompt) return;
  if (prompt === "/new") {
    newChatRequested = true;
    return;
  }
  // A line that begins with /new but carries more is a merged-command flush;
  // the real CLI renders its command-parse error and starts nothing.
  if (prompt.startsWith("/new")) {
    const dir = join(chatsRoot(), `chat-${nextChatIndex()}`);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ msg: `Command not found: "${prompt}"` }) + "\n");
    return;
  }
  // Submit accepted but nothing demonstrates it: the ready screen shows, and
  // no store line and no working screen ever land.
  if (mode === "no-ack") {
    phase = "ready";
    paint(readyBody());
    return;
  }
  // The first submit is lost outright — no draft, no line, no screen change —
  // as if the Enter never arrived; the next submit runs normally. This is the
  // re-paste retry's success story: window 2 recovers what window 1 lost.
  if (mode === "lost-first-submit" && !lostFirst) {
    lostFirst = true;
    phase = "ready";
    paint(readyBody());
    return;
  }
  // The first real submit strands as a draft; one bare Enter submits it.
  if (mode === "first-submit" && !stranded) {
    stranded = true;
    strandedDraft = prompt;
    paint(draftBody(prompt));
    return;
  }
  // The session's first real submit pops the cost modal instead of starting
  // the Turn; its Enter confirms and resubmits the held draft.
  if (modalArmed) {
    modalOpen = true;
    heldDraft = prompt;
    paint(modalBody(phase === "ready" ? readyBody() : welcomeBody()));
    return;
  }
  await runTurn(prompt);
};

const handleEnter = () => {
  if (modalOpen) {
    modalOpen = false;
    modalArmed = false;
    const draft = heldDraft;
    heldDraft = null;
    logInput({ event: "submit", text: draft });
    void submit(draft);
    return;
  }
  if (dialogStuck) {
    dialogStuck = false;
    logInput({ event: "enter", key: "\r" });
    phase = "idle";
    paint(welcomeBody());
    return;
  }
  if (unknownStuck) {
    unknownStuck = false;
    logInput({ event: "enter", key: "\r" });
    phase = "idle";
    paint(welcomeBody());
    return;
  }
  if (pending === "") {
    logInput({ event: "enter", key: "\r" });
    if (strandedDraft !== null) {
      const draft = strandedDraft;
      strandedDraft = null;
      void submit(draft);
    }
    return;
  }
  const prompt = pending;
  pending = "";
  if (prompt === "/new") logInput({ event: "new", text: prompt });
  else logInput({ event: "submit", text: prompt });
  void submit(prompt);
};

const handleEsc = () => {
  logInput({ event: "esc", key: "\x1b" });
  // Esc on the cost modal falls back to the draft; the next submit re-pops it.
  if (modalOpen) {
    modalOpen = false;
    paint(draftBody(heldDraft ?? ""));
  }
};

process.stdin.setEncoding("utf8");
// The real TUI reads raw keys; cooked stdin would let the console host swallow
// the control keys before this process ever sees them.
try {
  process.stdin.setRawMode(true);
} catch {
  // Only possible without a console (misuse outside a PTY); keys then arrive cooked.
}
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
  for (const char of chunk) {
    if (escPending) {
      escPending = false;
      if (char === "[") {
        csiState = 2;
        csi = "";
        continue;
      }
      // A bare Esc confirmed by the next key; that key is processed normally.
      handleEsc();
    }
    if (csiState === 2) {
      const code = char.charCodeAt(0);
      if (code < 0x40 || code > 0x7e) {
        csi += char;
        continue;
      }
      csiState = 0;
      const sequence = csi + char;
      if (sequence === PASTE_START) {
        pasting = true;
        pasted = "";
      } else if (sequence === PASTE_END) {
        pasting = false;
        logInput({ event: "paste", text: pasted });
        pending += pasted;
        pasted = "";
      }
      continue;
    }
    if (char === "\x1b") {
      escPending = true;
      continue;
    }
    // Inside a bracketed paste every char is literal, Enter included; the copy
    // into pending happens once, at the end marker.
    if (pasting) {
      pasted += char;
      continue;
    }
    // Raw mode delivers Enter as CR; a stray LF must not count as a second Enter.
    if (char === "\r") {
      handleEnter();
      continue;
    }
    if (char === "\n") continue;
    if (char === "\x03") {
      logInput({ event: "ctrl-c", key: "\x03" });
      continue;
    }
    pending += char;
  }
  // An Esc with no follower in the same chunk is a bare Esc key.
  if (escPending) {
    escPending = false;
    handleEsc();
  }
});

logInput({ event: "spawn", pid: process.pid });
await sleep(80);
paint("Connecting...");
await sleep(80);
if (mode === "takeover") {
  phase = "idle";
  paint(takeOverBody());
} else if (mode === "displaced") {
  phase = "ready";
  paint(displacedBody());
} else if (mode === "unknown") {
  paint(unknownBody());
} else {
  phase = "idle";
  paint(welcomeBody());
}
