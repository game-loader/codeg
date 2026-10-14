import * as React from "react"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { render, waitFor, within } from "@testing-library/react"
import { expect, it } from "vitest"
import { renderToString } from "react-dom/server"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  WorkspaceRuntimeVisibilityProvider,
  useWorkspaceRuntimeVisibility,
} from "@/contexts/workspace-runtime-visibility-context"
import { scopePanelId } from "@/lib/backend/resource-identity"

// Execute the real shell function with leaf content replaced. This keeps the
// resizable library, layout effects and default sizes while avoiding the full
// Monaco/agent/Next page graph (the same boundary used by production wiring tests).
const file = ts.createSourceFile(
  "layout.tsx",
  readFileSync("src/app/workspace/layout.tsx", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
const declarations = file.statements.filter(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    [
      "FolderWorkspaceShell",
      "clamp",
      "toPercent",
      "isSameLayout",
      "resolvePanelSizeRange",
      "usePanelSlideOnToggle",
    ].includes(node.name?.text ?? "")
)
const constants = file.statements
  .filter(ts.isVariableStatement)
  .filter((node) =>
    node.declarationList.declarations.some((d) =>
      /^(FOLDER_|MIN_|LAYOUT_EPSILON|PANEL_SLIDE)/.test(d.name.getText(file))
    )
  )
const code = ts.transpileModule(
  [...constants, ...declarations].map((node) => node.getText(file)).join("\n"),
  { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }
).outputText
let sidebarOpen = true
let restored = false
const bindings = {
  React,
  useRef: React.useRef,
  useState: React.useState,
  useEffect: React.useEffect,
  useCallback: React.useCallback,
  useMemo: React.useMemo,
  useLayoutEffect: React.useLayoutEffect,
  useWorkspaceRuntimeVisibility,
  useOptionalBackendClient: () => null,
  scopePanelId,
  useSidebarContext: () => ({
    isOpen: sidebarOpen,
    restored,
    width: 320,
    minWidth: 200,
    maxWidth: 900,
    setWidth: () => {},
  }),
  useAuxPanelContext: () => ({
    isOpen: false,
    restored: true,
    width: 320,
    minWidth: 200,
    maxWidth: 900,
    setWidth: () => {},
  }),
  useTerminalContext: () => ({
    isOpen: false,
    height: 300,
    minHeight: 150,
    maxHeight: 600,
    setHeight: () => {},
  }),
  useWorkbenchRoute: () => ({ isConversations: true }),
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
  Sidebar: () => <aside>Legacy Sidebar</aside>,
  WorkspaceContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TerminalPanel: () => null,
  AuxPanel: () => null,
}
const Shell = new Function(
  ...Object.keys(bindings),
  `${code}\nreturn FolderWorkspaceShell`
)(...Object.values(bindings)) as React.ComponentType<{
  children: React.ReactNode
}>
function shell(managed: boolean) {
  return (
    <WorkspaceRuntimeVisibilityProvider
      value={{ managed, visible: true, focused: true }}
    >
      <Shell>
        <main>Conversation content</main>
      </Shell>
    </WorkspaceRuntimeVisibilityProvider>
  )
}

it("allocates zero sidebar width on managed SSR, hydration and toggles while preserving the legacy shell", async () => {
  restored = false
  sidebarOpen = true
  const markup = renderToString(shell(true))
  expect(markup).not.toContain("Legacy Sidebar")
  const container = document.createElement("div")
  container.innerHTML = markup
  document.body.appendChild(container)
  expect(
    (
      container.querySelector(
        '[data-panel-id="folder-shell-left-panel"]'
      )! as HTMLElement
    ).style.flexGrow
  ).toBe("0")
  const rendered = render(shell(true), { container, hydrate: true })
  const panel = rendered.container.querySelector(
    '[data-panel-id="folder-shell-left-panel"]'
  )! as HTMLElement
  expect(panel.style.flexGrow).toBe("0")
  expect(panel.nextElementSibling).toHaveAttribute(
    "data-panel-resize-handle-enabled",
    "false"
  )
  expect(panel.nextElementSibling).toHaveClass("w-0")
  restored = true
  rendered.rerender(shell(true))
  expect(panel.style.flexGrow).toBe("0")
  sidebarOpen = false
  rendered.rerender(shell(true))
  sidebarOpen = true
  rendered.rerender(shell(true))
  expect(panel.style.flexGrow).toBe("0")
  expect(within(rendered.container).queryByText("Legacy Sidebar")).toBeNull()
  rendered.unmount()
  const legacy = render(shell(false))
  expect(within(legacy.container).getByText("Legacy Sidebar")).toBeVisible()
  await waitFor(() =>
    expect(
      Number(
        (
          legacy.container.querySelector(
            '[data-panel-id="folder-shell-left-panel"]'
          )! as HTMLElement
        ).style.flexBasis.replace("px", "")
      )
    ).toBeGreaterThan(0)
  )
})
