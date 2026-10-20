// The SDK harness: an extension's only in-process entry point. It builds a real
// agent session with extension discovery disabled, in-memory session state,
// isolated settings, no TUI, and a scripted mock model, so harness-tier tests
// drive the Extension factory the same way a host would.
//
// The prompt path gates on `modelRegistry.getApiKey(model)`, so the keyless mock
// provider needs a runtime key (`authStorage.keys.setRuntime`) before prompting.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionActions,
  type ExtensionContextActions,
  type ExtensionFactory,
  type LoadExtensionsResult,
  AuthStorage,
  type AgentSession,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";
import {
  createMockModel,
  type MockHandler,
  type MockModel,
  registerMockApi,
} from "@oh-my-pi/pi-ai/providers/mock";

export interface HarnessOptions {
  extensions?: ExtensionFactory[];
  // MockHandler, not just MockResponse: a handler function resolves per
  // request, which lets a script name an id the run only produces later.
  responses?: MockHandler[];
  cwd?: string;
}

export interface Harness {
  session: AgentSession;
  model: MockModel;
  extensionsResult: LoadExtensionsResult;
  tmp: string;
  dispose: () => Promise<void>;
}

// registerMockApi mutates a global provider table; one registration per process.
let mockRegistered = false;

// A host's mode controller initializes the extension runner after
// createAgentSession returns; the bare SDK never does, so every pi action
// method (sendMessage, appendEntry, ...) would throw
// ExtensionRuntimeNotInitializedError forever. Wire the actions extensions use
// onto this session, the way print/TUI mode does.
const initializeExtensionRunner = async (session: AgentSession): Promise<void> => {
  const runner = session.extensionRunner;
  if (runner === undefined) return;
  const actions = {
    sendMessage: (message, options) => {
      void session.sendCustomMessage(message, options).catch(() => {});
    },
    sendUserMessage: (content, options) => {
      void session.sendUserMessage(content, options).catch(() => {});
    },
    appendEntry: (customType, data) => {
      session.sessionManager.appendCustomEntry(customType, data);
    },
    setLabel: () => {},
    getActiveTools: () => session.getActiveToolNames(),
    getAllTools: () => [],
    setActiveTools: async () => {},
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "medium" as const,
    setThinkingLevel: async () => {},
    getSessionName: () => session.sessionManager.getSessionName(),
    setSessionName: async () => {},
  } as ExtensionActions; // the harness wires only the actions extensions call; the rest stay inert
  const contextActions = {
    getModel: () => undefined,
    isIdle: () => false,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: async () => {},
    getSystemPrompt: () => [],
  } as ExtensionContextActions; // ctx action reads the harness never exercises
  runner.initialize(actions, contextActions);
  // Symmetric with dispose, which fires session_shutdown: a live host emits
  // session_start right after its extension runner initializes, and
  // extensions key their per-session setup on it.
  await runner.emit({ type: "session_start" });
};

export async function createHarnessSession(options: HarnessOptions = {}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), "freebuff-harness-"));
  const cwd = options.cwd ?? join(tmp, "cwd");
  mkdirSync(cwd, { recursive: true });

  if (!mockRegistered) {
    registerMockApi();
    mockRegistered = true;
  }
  const model = createMockModel({ responses: options.responses ?? [{ content: ["ok"] }] });

  const authStorage = await AuthStorage.create(join(tmp, "auth.db"));
  authStorage.keys.setRuntime("mock", "harness-key");
  const modelRegistry = new ModelRegistry(authStorage, join(tmp, "models.yml"));

  const result = await createAgentSession({
    cwd,
    model,
    authStorage,
    modelRegistry,
    settings: Settings.isolated({}),
    sessionManager: SessionManager.inMemory(cwd),
    extensions: options.extensions ?? [],
    disableExtensionDiscovery: true,
    hasUI: false,
    enableMCP: false,
    enableLsp: false,
    agentDir: tmp,
    skills: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
  });

  await initializeExtensionRunner(result.session);

  const dispose = async (): Promise<void> => {
    try {
      await result.session.dispose();
      authStorage.close();
    } finally {
      // Bookkeeping must never mask a session error from the caller.
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // Windows file locks can hold the tmp dir briefly; the OS cleans tmp.
      }
    }
  };

  return { session: result.session, model, extensionsResult: result.extensionsResult, tmp, dispose };
}
