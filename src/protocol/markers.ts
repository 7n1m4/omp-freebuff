// Wording-bearing screen markers captured from the real freebuff TUI (0.2.29
// layout). A later slice's doctor checks the ones the Welcome screen, ready,
// Continue, Session-in-use dialog, login gate and connecting screens render
// against the live screen; the signatures search them in fixture-pinned regions.
export const READY_PROMPT = "Enter a coding task or / for commands";
// The Welcome screen's info box: the Instance idles here with no Hour session; the
// first submitted message starts the session.
export const WELCOME_BOX = "Your first message starts the session";
export const CONNECTING = "Connecting";
// Whole-word match, mirroring the recognizer: `Connecting...` on the connecting
// status line, never a transcript's unrelated 'Connecting'.
export const CONNECTING_REGEX = new RegExp(`\\b${CONNECTING}\\b`, "i");
export const LOGIN_REQUIRED = "Not authenticated";
// Continue screen after the Hour session is out of credits; the prompt tail every
// wording generation shares (`Press Enter to continue` appears nowhere else).
export const CONTINUE_PROMPT = "Press Enter to continue";
// The first submit of a fresh Hour session pops the model-cost confirm modal over
// the input box; the Turn starts only after it is confirmed.
export const COST_MODAL_CONFIRM = "confirm and send";
export const COST_MODAL_CANCEL = "back to draft";
// 0.2.29 Session-in-use dialog: a second window finds the Hour session held and
// offers to take it over. The Enter hint row is the sharp marker; the tolerant
// wording covers the dialog body.
export const TAKEOVER_ENTER = "Enter: take over";
export const TAKEOVER_TOLERANT = "Take over to";
// 0.2.29 working composer: the input placeholder is re-labeled while a Turn runs.
export const COMPOSER_WORKING = "Add to the current task";
// The draft screen's footer chat segment (`… · Chat: New chat`): the first submit
// stranded as a draft names a chat that does not exist yet. This footer segment is
// also the first-submit acceptance signal (issue #14, story 47).
export const FOOTER_CHAT_NEW = "Chat: New chat";
// Tail of the session usage row (` 34m left · 15.2K (1%)  ✕ End session`). The row
// exists only while the Hour session is live, so its absence distinguishes a
// displaced layout from ready.
export const END_SESSION = "✕ End session";
// Countdown on the usage row: `7h 12m left`, `1h left`, `59m left`, `2:58 left`.
// Used as ready's weak marker and stripped from the freeze key, never parsed into
// a value.
export const COUNTDOWN_REGEX = /(?:(\d+)h(?:\s+(\d+)m)?|(\d+)m)\s+left|(\d+):(\d\d)\s+left/;
// The usage-row signals as a whole (the `✕ End session` tail plus the countdown);
// displaced's absent veto fires when any of them hits.
export const USAGE_ROW_MARKERS: readonly (string | RegExp)[] = [END_SESSION, COUNTDOWN_REGEX];
// Status-line separator (`1h left · 13.5K (1%)`, `H · History`).
export const STATUS_SEPARATOR = "·";
// Balance on the Welcome screen (`25/25 Freebucks remaining`; the pre-0.0.20x
// picker said `daily`). Informative only: no decision gates on the balance; the
// regexes below survive solely as freeze-key strippers.
export const FREEBUCKS_BALANCE_REGEX = /(\d+)\/(\d+)\s+Freebucks\s+(?:remaining|daily)/;
// Remaining balance as the 0.0.193 Continue screen rendered it (`Session ended  ·
// 20 Freebucks left`). Kept for the freeze key: such a line must never mask a freeze.
export const FREEBUCKS_LEFT_REGEX = /(\d+)\s+Freebucks left/;
// Known error renderings seen during a Turn; logged, never acted on.
export const KNOWN_ERROR_STRINGS: readonly string[] = ["Command not found: "];
