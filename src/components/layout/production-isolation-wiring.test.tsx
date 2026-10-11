import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import {
  act,
  fireEvent,
  render,
  renderHook,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BackendClientProvider } from "@/contexts/backend-client-context"
import { WorkspaceRuntimeVisibilityProvider } from "@/contexts/workspace-runtime-visibility-context"
import {
  useBackendEventScope,
  useRuntimeEventScope,
} from "@/hooks/use-runtime-event-scope"
import { getBackendEventScope } from "@/lib/backend/resource-identity"
import type { BackendClient } from "@/lib/backend/types"
import {
  buildMonacoModelPath,
  collectLiveModelPaths,
} from "@/lib/monaco-model-path"
import {
  consumePendingTaskDraft,
  CREATE_TASK_FROM_TEXT_EVENT,
} from "@/lib/task-compose-events"
import { useCreateTaskFromMessage } from "@/components/message/use-create-task-from-message"
import {
  OPEN_TASK_SETTINGS_EVENT,
  TasksChromeActions,
} from "@/components/tasks/tasks-chrome-actions"
import {
  OPEN_FORGE_SETTINGS_EVENT,
  ForgeChromeActions,
} from "@/components/forge/forge-chrome-actions"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/contexts/tasks-view-context", () => ({
  useTasksView: () => ({ tasks: [], viewMode: "board", setViewMode: vi.fn() }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: vi.fn() }),
}))
vi.mock("@/contexts/backend-stores-selection-context", () => ({
  useBackendStores: () => ({
    tabs: (select: (state: unknown) => unknown) =>
      select({ rawTabs: [{ id: "tab", folderId: 1 }], activeTabId: "tab" }),
    workspace: {
      getState: () => ({
        folders: [{ id: 1, parent_id: null, kind: "regular" }],
      }),
    },
    forgeRefresh: (select: (state: unknown) => unknown) =>
      select({ refresh: null, busy: false }),
  }),
}))

// Execute the actual production effect at its ownership boundary. This avoids
// mocking the entire Monaco/ReactFlow/page graph while still checking the
// registered listener, its target, pending buffer, cleanup and call arguments.
function source(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(resolve(process.cwd(), `src/components/${path}`), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
}

function nodes<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T
): T[] {
  const matches: T[] = []
  const visit = (node: ts.Node) => {
    if (predicate(node)) matches.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return matches
}

function value(root: ts.Node, name: string): ts.Expression {
  const found = nodes(root, ts.isVariableDeclaration).filter(
    (node) => node.name.getText() === name
  )
  expect(found).toHaveLength(1)
  expect(found[0].initializer).toBeDefined()
  return found[0].initializer!
}

function effect(root: ts.Node, event: string) {
  const found = nodes(root, ts.isCallExpression).filter(
    (call) =>
      call.expression.getText() === "useEffect" &&
      call.arguments[0].getText().includes(event)
  )
  expect(found).toHaveLength(1)
  return found[0]
}

function evaluate<T>(
  expression: ts.Node,
  bindings: Record<string, unknown>
): T {
  const javascript = ts
    .transpile(`(${expression.getText()})`, { target: ts.ScriptTarget.ES2020 })
    .trim()
    .replace(/;$/, "")
  return new Function(...Object.keys(bindings), `return ${javascript}`)(
    ...Object.values(bindings)
  ) as T
}

const cleanups: (() => void)[] = []
function install(
  root: ts.Node,
  event: string,
  bindings: Record<string, unknown>
) {
  const productionEffect = effect(root, event)
  const cleanup = evaluate<() => (() => void) | undefined>(
    productionEffect.arguments[0],
    bindings
  )()
  if (cleanup) cleanups.push(cleanup)
  return productionEffect
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.restoreAllMocks()
})

const files = source("files/file-workspace-panel.tsx")
const canvas = source("canvas/canvas-view.tsx")
const tasks = source("tasks/tasks-page.tsx")
const forge = source("forge/forge-page.tsx")

function client(key: BackendClient["key"]): BackendClient {
  return { key } as BackendClient
}

function runtime(backend: BackendClient, visible: boolean, focused: boolean) {
  return renderHook(
    () => ({
      ownsEvent: useRuntimeEventScope(),
      scope: useBackendEventScope(),
    }),
    {
      wrapper: ({ children }) => (
        <BackendClientProvider client={backend}>
          <WorkspaceRuntimeVisibilityProvider
            value={{ managed: true, visible, focused }}
          >
            {children}
          </WorkspaceRuntimeVisibilityProvider>
        </BackendClientProvider>
      ),
    }
  )
}

describe("production file and canvas shortcut wiring", () => {
  it.each([
    { visible: false, focused: true },
    { visible: true, focused: false },
  ])("does not save or mutate an inactive runtime: %j", (visibility) => {
    const a = runtime(
      client("remote:1"),
      visibility.visible,
      visibility.focused
    )
    const b = runtime(client("remote:2"), true, true)
    const saves = [vi.fn(), vi.fn()]
    const deletes = [vi.fn(), vi.fn()]
    const drafts = [vi.fn(), vi.fn()]
    ;[a, b].forEach((pane, index) => {
      const fileEffect = install(files, 'window.addEventListener("keydown"', {
        ownsEvent: pane.result.current.ownsEvent,
        isFileTab: true,
        canEdit: true,
        saveActiveFile: saves[index],
      })
      expect(fileEffect.arguments[1].getText()).toContain("ownsEvent")
      const canvasEffect = install(canvas, '"keydown", onKeyDown, true', {
        ownsEvent: pane.result.current.ownsEvent,
        surfaceRef: { current: null },
        selectedIds: new Set(["node:1"]),
        deleteSelection: deletes[index],
        startDraft: drafts[index],
        screenToFlowPosition: (point: unknown) => point,
        DETAIL_CARD_WIDTH: 400,
        DETAIL_CARD_HEIGHT: 300,
      })
      expect(canvasEffect.arguments[1].getText()).toContain("ownsEvent")
    })
    fireEvent.keyDown(document, { key: "s", metaKey: true })
    fireEvent.keyDown(document, { key: "Delete" })
    fireEvent.keyDown(document, { key: "n", metaKey: true })
    expect(saves[0]).not.toHaveBeenCalled()
    expect(deletes[0]).not.toHaveBeenCalled()
    expect(drafts[0]).not.toHaveBeenCalled()
    expect(saves[1]).toHaveBeenCalledTimes(1)
    expect(deletes[1]).toHaveBeenCalledTimes(1)
    expect(drafts[1]).toHaveBeenCalledTimes(1)
  })

  it("uses explicit file DOM ownership even when React focuses the other pane", () => {
    const a = runtime(client("remote:1"), true, true)
    const b = runtime(client("remote:2"), true, false)
    const saves = [vi.fn(), vi.fn()]
    ;[a, b].forEach((pane, index) => {
      install(files, 'window.addEventListener("keydown"', {
        ownsEvent: pane.result.current.ownsEvent,
        isFileTab: true,
        canEdit: true,
        saveActiveFile: saves[index],
      })
    })
    const view = render(<div data-backend-key="remote:2">file editor</div>)
    fireEvent.keyDown(view.container.firstChild!, { key: "s", ctrlKey: true })
    expect(saves[0]).not.toHaveBeenCalled()
    expect(saves[1]).toHaveBeenCalledTimes(1)
  })
})

describe("production Monaco generation wiring", () => {
  it("gives equal paths and diff IDs distinct model/keep URIs for A, B and replacement A", () => {
    expect(value(files, "modelScope").getText()).toBe(
      "getBackendEventScope(useOptionalBackendClient())"
    )
    const calls = nodes(files, ts.isCallExpression).filter((call) =>
      ["buildMonacoModelPath", "collectLiveModelPaths"].includes(
        call.expression.getText()
      )
    )
    expect(calls).toHaveLength(2)
    calls.forEach((call) => {
      expect(call.arguments[call.arguments.length - 1].getText()).toBe(
        "modelScope"
      )
    })
    const a = client("remote:1")
    const b = client("remote:2")
    const replacement = client("remote:1")
    const tab = { id: "file:shared", path: "/repo/shared.ts" }
    const model = value(files, "editorModelPath")
    const keep = value(files, "liveModelUrisKey")
    const modelUris = [a, b, replacement].map((backend) => {
      const bindings = {
        modelScope: getBackendEventScope(backend),
        activeFileTab: tab,
        activeScope: tab.id,
        fileTabs: [tab, { id: "diff:1", path: null }],
        buildMonacoModelPath,
        collectLiveModelPaths,
        useMemo: (compute: () => unknown) => compute(),
      }
      const uri = evaluate<string>(model, bindings)
      const live = evaluate<string>(keep, bindings).split("\n")
      expect(live).toContain(uri)
      expect(live).toContain(
        buildMonacoModelPath(null, "diff:1", bindings.modelScope)
      )
      return uri
    })
    expect(new Set(modelUris).size).toBe(3)
    const retained = runtime(a, false, false)
    retained.rerender()
    expect(retained.result.current.scope).toBe(getBackendEventScope(a))
    expect(runtime(a, true, false).result.current.scope).toBe(
      getBackendEventScope(a)
    )
    expect(getBackendEventScope(null)).toBeUndefined()
    expect(
      evaluate(model, {
        activeFileTab: tab,
        activeScope: tab.id,
        modelScope: undefined,
        buildMonacoModelPath,
      })
    ).toBe("file:///repo/shared.ts")
  })
})

describe("production canvas export ownership", () => {
  it("selects the exact own viewport when two boards are mounted", () => {
    const view = render(
      <>
        <div data-testid="a">
          <div className="react-flow__viewport" />
        </div>
        <div data-testid="b">
          <div className="react-flow__viewport" />
        </div>
      </>
    )
    const query = value(canvas, "viewportEl")
    for (const id of ["a", "b"]) {
      const surface = within(view.container).getByTestId(id)
      expect(evaluate(query, { surfaceRef: { current: surface } })).toBe(
        surface.firstChild
      )
    }
    expect(evaluate(query, { surfaceRef: { current: null } })).toBeUndefined()
  })
})

describe("production task handoff and settings generations", () => {
  it("parks a real message producer's draft only for its fixed client's TasksPage", () => {
    const a = client("remote:1")
    const b = client("remote:2")
    const replacement = client("remote:1")
    const producer = renderHook(
      () => useCreateTaskFromMessage(() => "A text"),
      {
        wrapper: ({ children }) => (
          <BackendClientProvider client={a}>{children}</BackendClientProvider>
        ),
      }
    )
    act(() => producer.result.current())
    const open = [vi.fn(), vi.fn(), vi.fn()]
    const prefill = [vi.fn(), vi.fn(), vi.fn()]
    ;[b, replacement, a].forEach((backend, index) => {
      const mounted = install(tasks, "CREATE_TASK_FROM_TEXT_EVENT", {
        backendScope: getBackendEventScope(backend),
        consumePendingTaskDraft,
        CREATE_TASK_FROM_TEXT_EVENT,
        setEditorTask: vi.fn(),
        setEditorPrefill: prefill[index],
        setEditorOpen: open[index],
      })
      expect(mounted.arguments[1].getText()).toContain("backendScope")
    })
    expect(open[0]).not.toHaveBeenCalled()
    expect(open[1]).not.toHaveBeenCalled()
    expect(prefill[2]).toHaveBeenCalledWith({
      text: "A text",
      folderId: 1,
      backendKey: a.key,
      backendScope: getBackendEventScope(a),
    })
    act(() => producer.result.current())
    expect(open[0]).not.toHaveBeenCalled()
    expect(open[1]).not.toHaveBeenCalled()
    expect(open[2]).toHaveBeenCalledTimes(2)
    expect(consumePendingTaskDraft(getBackendEventScope(a))).toBeNull()
  })

  it("preserves the provider-free message handoff", () => {
    const prefill = vi.fn()
    install(tasks, "CREATE_TASK_FROM_TEXT_EVENT", {
      backendScope: undefined,
      consumePendingTaskDraft,
      CREATE_TASK_FROM_TEXT_EVENT,
      setEditorTask: vi.fn(),
      setEditorPrefill: prefill,
      setEditorOpen: vi.fn(),
    })
    const producer = renderHook(() => useCreateTaskFromMessage(() => "Legacy"))
    act(() => producer.result.current())
    expect(prefill).toHaveBeenCalledWith({
      text: "Legacy",
      folderId: 1,
      backendKey: undefined,
      backendScope: undefined,
    })
  })

  it.each([
    {
      page: tasks,
      event: OPEN_TASK_SETTINGS_EVENT,
      name: "OPEN_TASK_SETTINGS_EVENT",
      Actions: TasksChromeActions,
    },
    {
      page: forge,
      event: OPEN_FORGE_SETTINGS_EVENT,
      name: "OPEN_FORGE_SETTINGS_EVENT",
      Actions: ForgeChromeActions,
    },
  ])(
    "pairs the real $name producer with only its generation receiver",
    ({ page, event, name, Actions }) => {
      const a = client("remote:1")
      const b = client("remote:2")
      const replacement = client("remote:1")
      const open = [vi.fn(), vi.fn(), vi.fn(), vi.fn()]
      expect(value(page, "backendScope").getText()).toBe(
        "useBackendEventScope()"
      )
      ;[a, b, replacement, null].forEach((backend, index) => {
        const mounted = install(page, name, {
          backendScope: getBackendEventScope(backend),
          [name]: event,
          setSettingsOpen: open[index],
          backendApi: { forgeSettingsGet: () => new Promise(() => {}) },
          setSettings: vi.fn(),
        })
        expect(mounted.arguments[1].getText()).toContain("backendScope")
      })
      const buttons = render(
        <BackendClientProvider client={b}>
          <Actions buttonClassName="" iconClassName="" />
        </BackendClientProvider>
      )
      fireEvent.click(
        within(buttons.container).getByRole("button", { name: "settingsTitle" })
      )
      expect(open.map((spy) => spy.mock.calls.length)).toEqual([0, 1, 0, 0])
      buttons.rerender(
        <BackendClientProvider client={replacement}>
          <Actions buttonClassName="" iconClassName="" />
        </BackendClientProvider>
      )
      fireEvent.click(
        within(buttons.container).getByRole("button", { name: "settingsTitle" })
      )
      expect(open.map((spy) => spy.mock.calls.length)).toEqual([0, 1, 1, 0])
      buttons.rerender(
        <BackendClientProvider client={a}>
          <Actions buttonClassName="" iconClassName="" />
        </BackendClientProvider>
      )
      fireEvent.click(
        within(buttons.container).getByRole("button", { name: "settingsTitle" })
      )
      expect(open.map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1, 0])
      act(() => window.dispatchEvent(new Event(event)))
      expect(open.map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1, 1])
    }
  )
})

describe("owned global listener audit", () => {
  it.each([
    {
      root: files,
      expected: [
        "blur:onWindowBlur",
        "visibilitychange:onVisibilityChange",
        "keydown:onKeyDown",
      ],
    },
    {
      root: canvas,
      expected: [
        "keydown:sync",
        "keyup:sync",
        "blur:clear",
        "keydown:onKeyDown",
      ],
    },
    {
      root: tasks,
      expected: [
        "CREATE_TASK_FROM_TEXT_EVENT:consume",
        "OPEN_TASK_SETTINGS_EVENT:open",
        "blur:abortDrag",
        "visibilitychange:onVisibility",
      ],
    },
    { root: forge, expected: ["OPEN_FORGE_SETTINGS_EVENT:open"] },
  ])(
    "keeps the global listener inventory explicit for $root.fileName",
    ({ root, expected }) => {
      const listeners = nodes(root, ts.isCallExpression).filter((call) =>
        ["window.addEventListener", "document.addEventListener"].includes(
          call.expression.getText()
        )
      )
      expect(
        listeners.map(
          (call) =>
            `${call.arguments[0].getText().replace(/"/g, "")}:${call.arguments[1].getText()}`
        )
      ).toEqual(expected)
    }
  )

  it("guards canvas modifier state but leaves file deactivation saves running", () => {
    expect(value(canvas, "sync").getText()).toContain("ownsEvent(e.target)")
    expect(effect(canvas, '"keydown", sync').arguments[1].getText()).toContain(
      "ownsEvent"
    )
    expect(
      effect(files, '"blur", onWindowBlur').arguments[0].getText()
    ).not.toContain("ownsEvent")
  })
})
