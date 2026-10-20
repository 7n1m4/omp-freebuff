// Every known screen is declared once as a signature: its markers (each strong or
// weak), a threshold (N of M, at least one strong), markers whose hit vetoes the
// match, and the region of the screen the markers are searched in. One pure
// function recognizes the screen text against the table. Markers match
// case-insensitively and whitespace-tolerantly, so one reworded space or case
// change is not drift. When two signatures match, the table's order is the fixed
// priority: Session-in-use dialog > login gate > connecting > Continue > cost modal
// > Welcome screen > displaced > draft > working > ready. The take-over dialog
// renders the welcome box behind it (so it precedes Welcome screen); displaced sits
// after Welcome screen (the welcome frame has the composer and no usage row) and
// before ready (the usage row is its discriminator).
import {
  COMPOSER_WORKING,
  CONNECTING_REGEX,
  CONTINUE_PROMPT,
  COST_MODAL_CANCEL,
  COST_MODAL_CONFIRM,
  COUNTDOWN_REGEX,
  FOOTER_CHAT_NEW,
  LOGIN_REQUIRED,
  READY_PROMPT,
  TAKEOVER_ENTER,
  TAKEOVER_TOLERANT,
  USAGE_ROW_MARKERS,
  WELCOME_BOX,
} from "./markers";

export type KnownScreen =
  | "Welcome screen"
  | "ready"
  | "Continue"
  | "Session-in-use dialog"
  | "login gate"
  | "connecting"
  | "working"
  | "cost modal"
  | "displaced"
  | "draft";

/** pass: every marker present; degraded: threshold met, some marker missing (drift
 *  has started, the missing markers are named); fail: below threshold. */
export type RecognitionLevel = "pass" | "degraded" | "fail";

export interface Recognition {
  /** The recognized screen; `'blank'` is a paint transition (known, but no screen);
   *  null when the screen matches no known screen. */
  screen: KnownScreen | "blank" | null;
  level: RecognitionLevel;
  /** Names of the recognized screen's markers absent from its region; empty unless degraded. */
  missing: string[];
}

interface Marker {
  name: string;
  pattern: RegExp;
  /** Weak markers never recognize a screen by themselves: a threshold met without a
   *  strong marker recognizes nothing. */
  strong: boolean;
}

interface ScreenSignature {
  screen: KnownScreen;
  /** The marker search region: the bottom N rows of the rendered content for the
   *  bottom-anchored screens, or 'all' for the Welcome screen, login gate and
   *  connecting status line. */
  bottomRows: number | "all";
  threshold: number;
  markers: Marker[];
  /** A hit on any absent marker vetoes the match. */
  absent?: Marker[];
  /** The region ends at the input box's bottom border instead of the viewport
   *  bottom: 0.2.29 renders the usage row far above the viewport bottom whenever an
   *  ad box sits above the composer, so viewport-bottom regions miss it. */
  composerRegion?: boolean;
}

// The bottom `count` rows of the rendered content: the blank padding the viewport
// leaves below the last painted row (real captures fill the height, hand-made
// vectors do not) is never part of a screen's bottom.
const bottomRegion = (text: string, count: number): string => {
  const rows = text.split("\n");
  let end = rows.length;
  while (end > 0 && (rows[end - 1] ?? "").trim() === "") end -= 1;
  return rows.slice(Math.max(0, end - count), end).join("\n");
};

// The row index of the bottom-most bordered block's bottom border, or -1. Both the
// composer-anchored region and the freeze key anchor on it.
export const bottomBoxEnd = (rows: string[]): number => {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/^[╰└][─═]*[╯┘]$/.test(rows[i].trim())) return i;
  }
  return -1;
};

// The composer region: the last `count` rows ending at the input box's bottom
// border (the bottom-most bordered block). Without a bordered block (hand-made
// vectors, boot screens) fall back to the viewport bottom.
const composerRegion = (text: string, count: number): string => {
  const rows = text.split("\n");
  const end = bottomBoxEnd(rows);
  if (end === -1) return bottomRegion(text, count);
  return rows.slice(Math.max(0, end + 1 - count), end + 1).join("\n");
};

// Whitespace-tolerant wording match: words may be separated by any whitespace run,
// including the row wrap a narrow terminal produces inside a phrase.
const tolerant = (wordings: string[]): RegExp =>
  new RegExp(
    `(?:${wordings
      .map((wording) =>
        wording
          .trim()
          .split(/\s+/)
          .map((word) => word.replace(/[.*+?${}()|[\]\\]/g, "\\$&"))
          .join("\\s+"),
      )
      .join("|")})`,
    "i",
  );

// Regex-sourced markers keep the parser's strict regexes strict: as markers they
// match case-insensitively and whitespace-tolerantly, so one reworded case or row
// wrap is not drift. Weak markers alone still recognize nothing.
const marker = (pattern: RegExp): RegExp =>
  new RegExp(pattern.source.replace(/ /g, "\\s+"), pattern.flags.includes("i") ? pattern.flags : `${pattern.flags}i`);

const wordMarker = (name: string, wording: string, strong: boolean): Marker => ({
  name,
  pattern: tolerant([wording]),
  strong,
});

// Alternation over the usage-row markers, so a hit on any of them vetoes displaced.
const usageRowPattern = new RegExp(
  USAGE_ROW_MARKERS.map((item) => `(?:${(typeof item === "string" ? tolerant([item]) : marker(item)).source})`).join(
    "|",
  ),
  "i",
);

const SIGNATURES: ScreenSignature[] = [
  {
    // The 0.2.29 take-over prompt: a second window finds the Hour session held. It
    // renders the welcome box behind it, so it must outrank the Welcome screen;
    // either wording row suffices.
    screen: "Session-in-use dialog",
    bottomRows: 20,
    threshold: 1,
    composerRegion: true,
    markers: [
      wordMarker("TAKEOVER_ENTER", TAKEOVER_ENTER, true),
      wordMarker("TAKEOVER_TOLERANT", TAKEOVER_TOLERANT, true),
    ],
  },
  {
    screen: "login gate",
    bottomRows: "all",
    threshold: 1,
    markers: [wordMarker("LOGIN_REQUIRED", LOGIN_REQUIRED, true)],
  },
  {
    // Whole-word: `Connecting...` on the connecting status line, never a
    // transcript's unrelated 'Connecting'. Renders over the ready input box, so it
    // precedes the composer screens.
    screen: "connecting",
    bottomRows: 6,
    threshold: 1,
    markers: [{ name: "CONNECTING_REGEX", pattern: CONNECTING_REGEX, strong: true }],
  },
  {
    // The out-of-credits claim check. The wording appears nowhere else; a
    // transcript quote sits above the bottom-rows region.
    screen: "Continue",
    bottomRows: 8,
    threshold: 1,
    markers: [wordMarker("CONTINUE_PROMPT", CONTINUE_PROMPT, true)],
  },
  {
    // The first submit of a fresh Hour session pops the cost modal in place of the
    // input box; the frame still carries the Welcome box above it, so it must
    // outrank the Welcome screen. The confirm row is strong, the Esc row weak.
    screen: "cost modal",
    bottomRows: 8,
    threshold: 1,
    composerRegion: true,
    markers: [
      wordMarker("COST_MODAL_CONFIRM", COST_MODAL_CONFIRM, true),
      wordMarker("COST_MODAL_CANCEL", COST_MODAL_CANCEL, false),
    ],
  },
  {
    // The Instance idles here with no Hour session. It precedes displaced because
    // the welcome frame has the composer and no usage row.
    screen: "Welcome screen",
    bottomRows: "all",
    threshold: 1,
    markers: [wordMarker("WELCOME_BOX", WELCOME_BOX, true)],
  },
  {
    // The ready layout without the usage row: something displaced the session
    // screen (error box, foreign dialog), or the session screen idles with the
    // ad box above the composer. The plain bottom band spans the ad box, the
    // composer and the footer because a diff-painted dump garbles the composer's
    // own border rows, so a composer-anchored region would stop at the ad box.
    // Absence of the usage row is the discriminator: countdown or
    // `✕ End session` vetoes.
    screen: "displaced",
    bottomRows: 16,
    threshold: 1,
    markers: [wordMarker("READY_PROMPT", READY_PROMPT, true)],
    absent: [{ name: "USAGE_ROW_MARKERS", pattern: usageRowPattern, strong: false }],
  },
  {
    // The stranded first submit: the footer names the chat and no welcome box is
    // present. The footer renders below the composer, so a composer-anchored
    // region would never see it; the plain bottom band covers both. After
    // displaced: without the usage row the frame is displaced whatever the footer
    // says.
    screen: "draft",
    bottomRows: 16,
    threshold: 1,
    markers: [wordMarker("FOOTER_CHAT_NEW", FOOTER_CHAT_NEW, true)],
    absent: [wordMarker("WELCOME_BOX", WELCOME_BOX, false)],
  },
  {
    // Mid-Turn: the composer placeholder is re-labeled. It precedes ready because a
    // working frame still shows the input box and the usage row.
    screen: "working",
    bottomRows: 12,
    threshold: 1,
    composerRegion: true,
    markers: [wordMarker("COMPOSER_WORKING", COMPOSER_WORKING, true)],
  },
  {
    // The settled session screen. The countdown stays the weak marker: a drifted
    // usage row degrades ready instead of failing it, and the `✕ End session` tail
    // alone (countdown wording gone) still vetoes displaced.
    screen: "ready",
    bottomRows: 8,
    threshold: 1,
    composerRegion: true,
    markers: [
      wordMarker("READY_PROMPT", READY_PROMPT, true),
      { name: "COUNTDOWN_REGEX", pattern: marker(COUNTDOWN_REGEX), strong: false },
    ],
  },
];

/** Recognizes the flattened screen text against the signature table. A blank frame
 *  is a paint transition (ConPTY emits transient blanks between repaints), also
 *  known but no screen; the one place that rule lives. Anything unrecognized is
 *  unknown and gets dumped by the settle loop of a later slice. */
export const recognizeScreen = (text: string): Recognition => {
  if (text.trim() === "") return { screen: "blank", level: "pass", missing: [] };
  for (const signature of SIGNATURES) {
    const region =
      signature.bottomRows === "all"
        ? text
        : signature.composerRegion
          ? composerRegion(text, signature.bottomRows)
          : bottomRegion(text, signature.bottomRows);
    const missing = signature.markers.filter((m) => !m.pattern.test(region)).map((m) => m.name);
    if ((signature.absent ?? []).some((m) => m.pattern.test(region))) continue;
    const matched = signature.markers.length - missing.length;
    const strongMatched = signature.markers.some((m) => m.strong && !missing.includes(m.name));
    if (matched >= signature.threshold && strongMatched) {
      return { screen: signature.screen, level: missing.length === 0 ? "pass" : "degraded", missing };
    }
  }
  return { screen: null, level: "fail", missing: [] };
};
