// Host seam. Bare specifiers `@oh-my-pi/pi-natives` and `@oh-my-pi/pi-utils/vterm`
// cannot load outside OMP without the pinned devDependencies; inside OMP the scoped
// resolver pins them to the host copy, so runtime behavior is identical. This file
// is the only place host internals are reached; tests/hostSeam.test.ts enforces it.
export { PtySession } from "@oh-my-pi/pi-natives";
export type {
  PtyStartOptions,
  PtyArgvStartOptions,
  PtyRunResult,
} from "@oh-my-pi/pi-natives";
export { Terminal } from "@oh-my-pi/pi-utils/vterm";
export type {
  TerminalOptions,
  Disposable,
  TerminalModes,
  TerminalBuffers,
} from "@oh-my-pi/pi-utils/vterm";
