// The keystroke whitelist in one place: Enter may fire only into a level-pass frame
// whose screen names the key, meaning the Continue prompt, the cost modal's confirm,
// or a draft that still carries the usage row (the stranded first submit; the caller
// proves the usage row, the text the Enter would submit). The take-over dialog, a
// displaced screen, degraded recognition and unnamed frames earn nothing, so a press
// can never steal the Hour slot or type into a foreign window.
import type { KnownScreen, RecognitionLevel } from "./signatures";

export const enterWhitelisted = (
  identity: KnownScreen | "blank" | null,
  level: RecognitionLevel,
  opts?: { usageRow?: boolean },
): boolean =>
  level === "pass" &&
  (identity === "Continue" || identity === "cost modal" || (identity === "draft" && opts?.usageRow === true));
