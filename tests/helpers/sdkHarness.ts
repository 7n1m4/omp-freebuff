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
  type MockModel,
  registerMockApi,
  type MockResponse,
} from "@oh-my-pi/pi-ai/providers/mock";

export interface HarnessOptions {
  extensions?: ExtensionFactory[];
  responses?: MockResponse[];
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
