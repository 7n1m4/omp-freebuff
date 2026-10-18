# freebuff chat store as a live progress feed — research report

Date: 2026-10-18 · Binary: `C:\Users\vadash\.config\manicode\freebuff.exe` (Bun standalone, 123,693,312 bytes, v0.2.29)
Method: plain-bytes regex scan of the embedded JS; all offsets are byte offsets in the exe. Minified identifiers are quoted verbatim.

## Verdict

**Yes** — the chat store is a usable live feed: `log.jsonl` is appended **synchronously per line** (step boundaries land within milliseconds), and `chat-messages.json`/`run-state.json` are **atomically rewritten mid-turn roughly every 5 s** (plus an opt-in append-only `trace.jsonl` per-step stream enabled via `CODEBUFF_TRACE=1`).

## Evidence

### Who writes what

| File | Writer (offset) | Mechanism |
|---|---|---|
| `log.jsonl` | init `TEL(H)` @100586528; called @100587112 with `join(NC(),"log.jsonl")` | `pino({level:"debug"}, pino.destination({dest:H, mkdir:!0, sync:!0}))` — **sync flush per line, append** |
| `chat-messages.json` / `run-state.json` / `chat-meta.json` | save `mTL` @103442912 (async) and `_R` @103443380 (sync) in module `fxH` | temp file `open("wx")` → write → **fsync** → `rename` (=atomic full rewrite), then `y_H` writes `chat-meta.json` (`{messageCount, firstPrompt, messagesSize, messagesMtimeMs}`) |
| `trace.jsonl` | writer `tvA` @~103410991, filename const `ovA="trace.jsonl"` | **`appendFileSync` per step**; enabled only if env `CODEBUFF_TRACE` ∈ {`1`,`true`,`yes`} or debug mode (`ATL` @~103410500); path = `<chatDir>/trace.jsonl` (debug: `<projectRoot>/debug/trace.jsonl`) |

### Mid-turn trigger chain (the key finding)

1. SDK agent loop (@100434696): `if(PH){…vA=setInterval(tA, tr$)…}` with **`tr$=5000`** (@100441554). The tick fires the `onStateSnapshot` handler **only when `rH.mainAgentState.messageHistory` reference changed** (guarded: `let e$=rH.mainAgentState.messageHistory; if(e$===ZA)return;`).
2. freebuff UI wires the handler (@103823808):
   `onStateSnapshot:(SD)=>{let JE=PlA(SD,NH); if(rH=JE,TH.signal.aborted||!yH())return; s.current=JE, ExH(JE, VA.getState().messages, tH)}`
   i.e. it snapshots **the live UI message array** (`VA.getState().messages` — the same objects that streaming/tool events mutate via `updateAiMessageBlocks`) plus the run state.
3. `ExH(H,A,$)` (@103443403) enqueues into `OR` — a **Map keyed by chat dir, so pending saves coalesce** — and starts drain loop `cTL()` (@103443470, serial, `setImmediate` between items) → `mTL` → atomic rewrite of `run-state.json` then `chat-messages.json` then meta.
4. Abort path (@103819995): an abort listener calls `ExH(rH, VA.getState().messages, tH)` — **immediate save on cancel**. Shutdown sync-flush: `sbA()` (@103440673, called @104824891).
5. Chat dir resolution: `ZC()` @100585394 = `join(configDir,"projects", basename(projectRoot))`; `NC()` @100585898 = `chats/<ts>` where the ts is **memoized per process** (`Lk()` @100585216, `if(!MN)MN=new Date().toISOString().replace(/:/g,"-")`), so the chat dir is stable for the session and `trace.jsonl`'s path is stable too. `i3A()` @100585516 = "newest `chats/` subdir by mtime".

### Per-step log/trace payloads

- SDK loop emits `I.debug({iteration, agentId, model, prompt, shouldEndTurn, duration, fullResponse, messageCount, toolCalls, toolResults, stepCreditsUsed}, `End agent ${agent} step ${y} (${userInputId}…)`)` (@99983770) and a matching `"Start agent … step N"` (@99978268) with `{iteration, runId, model, contextTokenCount, messageCount, prompt, systemTokens, agentTemplateId, toolNames[]}`. Observed live in `projects\freebuff-ws-a0235ecf\chats\2026-10-17T20-45-13.406Z\log.jsonl`: `toolCalls:[{toolName:"read_files",input:{paths:[…]},toolCallId:"S5z2noeZctA"}]`, `toolResults:[{role:"tool",toolName,toolCallId,content:[{type:"json",value:[…full file contents…]}]}]`.
- Turn end marker `"Main prompt finished"` (@99985333) with `{outputType:"lastMessage", messageCount}` — this is what the existing prototype's `detectTurnEnd` uses.
- Other lifecycle lines observed: `[message-queue] Processing next message from queue`, `[send-message] Sending message with sdk run config` (with `runConfig`), `Main prompt finished`, `[message-queue] Processing lock released`.

## Schema of blocks/messages

Message (array in `chat-messages.json`): `{variant:"ai"|"user"|"error", id (ai ids prefixed "ai-", factory @103446xxx), content, timestamp, blocks[], isComplete, completionTime?, credits?, metadata:{allowInlineAds?, runState?}}`. Finalization `IkA` sets `isComplete:true` and normalizes blocks; error factory `Jm` = `{id:"error-<ts>", variant:"error", content}`.

Block producers found in the binary:

| Block | Producer / offset | Shape |
|---|---|---|
| text / reasoning | `hbA` @~103431900 (stream chunk appender) | `{type:"text", textType:"text"\|"reasoning", text}` — appended per chunk classifier `gbA` (@103431603): string→root/text, `subagent_chunk`→agent/text, `reasoning_chunk`→root/agent + reasoning |
| tool call | `_TL` @103434669 (event `tool_call` → `jTL`) | `{type:"tool", toolCallId, toolName, input, agentId?, includeToolCall?}`; on `tool_result`, `CTL` updates it with `output`/result value (@103435000 region) |
| agent (subagent) | `ajH` @~103424667 (event `subagent_start`) | `{type:"agent", agentId, agentName, agentType, content, status:"running"→"complete", blocks:[…nested…], initialPrompt, params?, spawnToolCallId?, spawnIndex?, isCollapsed?}` — **recursive**: subagent blocks nest inside agent blocks; `spawn_agents` expands one tool call into N agent blocks (`OTL`) |
| mode divider | `lTL` @103446062 | `{id:"divider-<ts>", variant:"ai", content:"", blocks:[{type:"mode-divider", mode}]}` |

`run-state.json`: `{inference, output, sessionState:{fileContext, fileTree, knowledgeFiles, agentTemplates, …, mainAgentState:{messageHistory[…]}}, traceSessionId}`. During a run `output` is the placeholder `{type:"error", message:"The session ended before this response completed. Partial progress has been preserved."}` (const `Oe` @100441563) until the turn's real output replaces it.

## Mid-turn update behaviour

- **`log.jsonl`: updates live, per line, synchronously** (`sync:!0`). Every agent step Start/End (incl. tool name, args, full results, partial `fullResponse`, `shouldEndTurn`, duration) hits disk at step end. Also note `toolResults` embed **full** result contents (e.g. whole file bodies) — lines can be large.
- **`chat-messages.json` + `run-state.json` + `chat-meta.json`: rewritten mid-turn, atomically, ≈per LLM step, sampled at ≤5 s** (5 s poll ∧ messageHistory changed → coalescing queue → fsync+rename). Not per token: during one long step there are **no** intermediate writes of these files; streaming text becomes visible only at the next qualifying tick. Because saves are rename-based full rewrites, the file's identity changes on every save (relevant for `fs.watch` on Windows — watch the dir or poll size+mtime instead).
- **`trace.jsonl` (opt-in)**: if the wrapper launches freebuff with `CODEBUFF_TRACE=1`, freebuff appends per-step JSON lines `{timestamp, agentId, agentType, runId, userInputId, step, type:"history_rewritten"|"system"|"message", …}` — an append-only, tail-safe full history delta stream.
- Live-turn observation: **not performed** — route (a) (binary flush logic) was conclusive, so per the assignment's cost caveat I skipped the one supervisor turn. `projects/pi-freebuff/chats/` does not exist yet (no chat has run from that cwd); the sampled chat dir was `projects\freebuff-ws-a0235ecf\` (basename of that session's project root — consistent with `ZC()`).

## What a wrapper could stream, and at what latency

1. **Tail `log.jsonl`** (poll size every 100–250 ms, parse appended pino lines): step-granular feed — "Start agent step N" (model, context tokens), "End agent step N" (tool name + args + results + partial response + `shouldEndTurn`), "Main prompt finished" = turn end. **Latency ≈ instant** (sync write at event time). This is the best primary feed; it already contains everything the final-answer path uses plus everything between.
2. **Poll `chat-messages.json`** (every ~1 s, or dir-watch): rendered blocks (streaming text bursts ≤5 s stale, tool inputs, agent status) — good for a UI mirror, redundant for pure progress events. Expect mtime/size to step at ~5 s cadence during activity, silence during a single long step.
3. **Set `CODEBUFF_TRACE=1`** when spawning freebuff for an append-only per-step `trace.jsonl` with full message-history deltas — cleanest to tail, but requires env control over the freebuff process and adds ~1 file of history duplication per step.

## UNKNOWNs

- Exact moment `mainAgentState.messageHistory` is reassigned inside the loop (step start vs end) — **[INFERENCE]**: after each step (messages are pushed during the loop; the 5 s tick catches it within ≤5 s).
- pino destination `append` flag value (docs default `true`; not verified in binary) — observed files accumulate across a session, consistent with append.
- Whether `completionTime`/`credits` are set only at finalization — **[INFERENCE]** yes (`IkA` finalize path).
- The `nDH` chat-dir override path (`d3A`, resume) was not fully traced.
- Real-world save cadence under the supervisor (does a step's `messageHistory` change actually tick within 5 s) — verified in code, not observed live; one trivial supervisor turn would confirm mtimes if ever needed.
