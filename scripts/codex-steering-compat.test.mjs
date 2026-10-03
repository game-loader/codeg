import assert from "node:assert/strict"
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, after } from "node:test"
import {
  patchSteering,
  load,
} from "../src-tauri/src/acp/codex-steering-loader.mjs"

// Point this at the unmodified dist/index.js from the published npm package.
// The loader verifies its exact bytes before the adapter is executed.
const bundle = process.env.CODEG_CODEX_ACP_BUNDLE
if (!bundle)
  throw new Error("Set CODEG_CODEX_ACP_BUNDLE to codex-acp 2.1.1 dist/index.js")
const original = await readFile(bundle, "utf8")
const patched = patchSteering(original, "2.1.1")
assert.ok(patched, "all three anchors must be unique in the verified release")
const harnessDir = await mkdtemp(join(tmpdir(), "codeg-task3-steering-probe-"))
after(() => rm(harnessDir, { recursive: true, force: true }))
const harness = join(harnessDir, "adapter.mjs")
await writeFile(
  harness,
  patched.slice(0, patched.indexOf('if (process.argv.includes("--version"))')) +
    "\nexport { CodexAcpServer, AgentMode, CodexSubagentEventRouter };\n"
)
const { CodexAcpServer, AgentMode, CodexSubagentEventRouter } = await import(
  pathToFileURL(harness)
)
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const params = (text = "inserted", optIn = true) => ({
  sessionId: "s1",
  prompt: [{ type: "text", text }],
  ...(optIn ? { _meta: { steering: { idleBehavior: "promptRequired" } } } : {}),
})
function fixture() {
  const done = deferred(),
    started = deferred(),
    calls = []
  const client = {
    initialize: async () => {},
    waitForSessionNotifications: async () => {},
    subscribeToSessionEvents: async () => {},
    steerTurn: async (p) => {
      calls.push(["steer", p])
    },
    sendPrompt: async (
      p,
      _mode,
      _model,
      _tier,
      _summary,
      _cwd,
      _dirs,
      onStart
    ) => {
      calls.push(["prompt", p])
      onStart("t1")
      started.resolve()
      return done.promise
    },
  }
  const server = new CodexAcpServer(
    { notify: async () => {}, request: async () => ({}) },
    client
  )
  server.publishFirstAuthStatusAfterResponse = () => {}
  server.availableCommands.tryHandleCommand = async () => ({ handled: false })
  server.availableCommands.publish = async () => {}
  const state = {
    sessionId: "s1",
    cwd: "/tmp",
    additionalDirectories: [],
    currentTurnId: null,
    currentModelId: "gpt-6[medium]",
    agentMode: AgentMode.WorkspaceWrite,
    supportedReasoningEfforts: [],
    supportedInputModalities: ["text"],
    clientCapabilities: {},
    currentModelSupportsFast: false,
    fastModeEnabled: false,
    subagents: new CodexSubagentEventRouter(
      "s1",
      false,
      { update: async () => {} },
      () => {}
    ),
    collaborationMode: "default",
  }
  server.sessions.set("s1", state)
  const complete = () =>
    done.resolve({ turn: { id: "t1", status: "completed" } })
  return { server, state, client, done, started, calls, complete }
}

test("verified bytes only; unreviewed versions and modified bytes stay untouched", () => {
  assert.equal(patchSteering(original, "2.1.2"), null)
  assert.equal(patchSteering(original + "\n", "2.1.1"), null)
})
test("loader preserves the module and removes its option from child processes", async () => {
  const url = pathToFileURL(bundle).href
  const loaded = { format: "module", source: original }
  const result = await load(url, {}, async () => loaded)
  assert.equal(result.format, loaded.format)
  assert.match(result.source, /codegPromptRequired: 1/)
  assert.match(result.source, /process\.env\.NODE_OPTIONS =/)
})
test("initialize advertises the patch marker", async () => {
  const { server } = fixture()
  const init = await server.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
  })
  assert.equal(init.agentInfo.version, "2.1.1")
  assert.equal(init._meta.steering.codegPromptRequired, 1)
})
test("idle opt-in does not consume input or start another prompt", async () => {
  const { server, calls } = fixture()
  const result = await server.executeOrQueueSteeringRequest(
    server.parseSessionSteerParams(params())
  )
  assert.deepEqual(result, { outcome: "promptRequired" })
  assert.deepEqual(calls, [])
})
test("active steering retains its owning prompt until completion", async () => {
  const f = fixture()
  let settled = false
  const owner = f.server.prompt(params("original", false)).then((result) => {
    settled = true
    return result
  })
  await f.started.promise
  const result = await f.server.executeOrQueueSteeringRequest(
    f.server.parseSessionSteerParams(params())
  )
  assert.deepEqual(result, { outcome: "injected" })
  assert.equal(settled, false)
  assert.equal(f.calls.filter(([kind]) => kind === "prompt").length, 1)
  f.complete()
  assert.equal((await owner).stopReason, "end_turn")
})
test("completion race returns input to the host without a detached prompt", async () => {
  const f = fixture()
  const owner = f.server.prompt(params("original", false))
  await f.started.promise
  f.client.steerTurn = async () => {
    f.state.currentTurnId = null
    f.complete()
    throw new Error("no active turn to steer")
  }
  assert.deepEqual(
    await f.server.executeOrQueueSteeringRequest(
      f.server.parseSessionSteerParams(params())
    ),
    { outcome: "promptRequired" }
  )
  await owner
  assert.equal(f.calls.filter(([kind]) => kind === "prompt").length, 1)
})
test("clients without opt-in retain the upstream new-turn fallback", async () => {
  const f = fixture()
  assert.deepEqual(
    await f.server.executeOrQueueSteeringRequest(
      f.server.parseSessionSteerParams(params("legacy", false))
    ),
    { outcome: "startedNewTurn" }
  )
  assert.equal(f.calls.filter(([kind]) => kind === "prompt").length, 1)
  f.complete()
  while (f.server.activePrompts.has("s1"))
    await new Promise((resolve) => setImmediate(resolve))
})
test("concurrent steering stays serialized in the upstream queue", async () => {
  const f = fixture()
  f.state.currentTurnId = "t1"
  const first = deferred(),
    entered = deferred(),
    texts = []
  let active = 0,
    maximum = 0
  f.client.steerTurn = async (p) => {
    active++
    maximum = Math.max(maximum, active)
    const text = p.prompt[0].text
    texts.push(text)
    if (text === "first") {
      entered.resolve()
      await first.promise
    }
    active--
  }
  const one = f.server.executeOrQueueSteeringRequest(
    f.server.parseSessionSteerParams(params("first"))
  )
  await entered.promise
  const two = f.server.executeOrQueueSteeringRequest(
    f.server.parseSessionSteerParams(params("second"))
  )
  assert.deepEqual(texts, ["first"])
  first.resolve()
  assert.deepEqual(await Promise.all([one, two]), [
    { outcome: "injected" },
    { outcome: "injected" },
  ])
  assert.equal(maximum, 1)
  assert.deepEqual(texts, ["first", "second"])
})
