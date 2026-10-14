import * as React from "react"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { fireEvent, render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { cn } from "@/lib/utils"
import { scopePanelId } from "@/lib/backend/resource-identity"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  WorkspaceRuntimeVisibilityProvider,
  useWorkspaceRuntimeVisibility,
} from "@/contexts/workspace-runtime-visibility-context"

// Run the real pane layout with leaf viewers replaced. This checks that removing
// chrome adds no empty strip and preserves the live content reconciliation slots.
const source = ts.createSourceFile(
  "layout.tsx",
  readFileSync("src/app/workspace/layout.tsx", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
const declarations = source.statements.filter(
  (node) =>
    (ts.isFunctionDeclaration(node) &&
      ["WorkspaceContent", "KeptMountedSurface", "isSameLayout"].includes(
        node.name?.text ?? ""
      )) ||
    (ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((d) =>
        /^(WORKSPACE_|DEFAULT_FUSION_LAYOUT)/.test(d.name.getText(source))
      ))
)
const code = ts.transpileModule(
  declarations.map((node) => node.getText(source)).join("\n"),
  { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }
).outputText
const useTabs = (selector: (s: { tabs: unknown[] }) => unknown) =>
  selector({ tabs: [{}] })
const passChildren = ({ children }: { children: React.ReactNode }) => (
  <>{children}</>
)
const bindings = {
  React,
  useRef: React.useRef,
  useState: React.useState,
  useEffect: React.useEffect,
  useCallback: React.useCallback,
  useMemo: React.useMemo,
  useWorkspaceRuntimeVisibility,
  useBackendStoreSelection: () => ({ tabs: useTabs }),
  useOptionalBackendClient: () => null,
  scopePanelId,
  cn,
  selectIsSplit: () => false,
  useWorkspaceView: () => ({
    mode: "fusion",
    filesMaximized: false,
    conversationMaximized: false,
  }),
  useWorkspaceActions: () => ({ setActivePane: vi.fn() }),
  useWorkbenchRoute: () => ({ isConversations: true }),
  useHasWorkbenchRouteStrip: () => false,
  useSidebarContext: () => ({ isOpen: false }),
  useAuxPanelContext: () => ({ isOpen: false }),
  usePlatform: () => ({ isMac: false, isWindows: false, isLinux: false }),
  useZoomLevel: () => ({ zoomLevel: 1 }),
  isDesktop: () => false,
  leftChromeReserve: () => 0,
  rightChromeReserve: () => 0,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  OverlayHostHiddenProvider: passChildren,
  ChromeReserve: () => null,
  TabBar: () => <div role="tablist" aria-label="Conversation tabs" />,
  FileWorkspaceTabBar: () => <div role="tablist" aria-label="File tabs" />,
  FileWorkspaceHeader: () => <header>File actions</header>,
  FileWorkspacePanel: () => (
    <textarea aria-label="File editor" defaultValue="unsaved file" />
  ),
}
const Content = new Function(
  ...Object.keys(bindings),
  `${code}\nreturn WorkspaceContent`
)(...Object.values(bindings)) as React.ComponentType<{
  children: React.ReactNode
}>
function content(managed: boolean) {
  return (
    <WorkspaceRuntimeVisibilityProvider
      value={{ managed, visible: true, focused: true }}
    >
      <Content>
        <textarea
          aria-label="Conversation draft"
          defaultValue="unsent message"
        />
      </Content>
    </WorkspaceRuntimeVisibilityProvider>
  )
}

it("omits both pane tab rows in a managed window while keeping editors and drafts mounted", () => {
  const result = render(content(false))
  expect(screen.getAllByRole("tablist")).toHaveLength(2)
  const draft = screen.getByRole("textbox", { name: "Conversation draft" })
  const editor = screen.getByRole("textbox", { name: "File editor" })
  fireEvent.change(draft, { target: { value: "retained draft" } })
  fireEvent.change(editor, { target: { value: "retained file buffer" } })
  result.rerender(content(true))
  expect(screen.queryAllByRole("tablist")).toHaveLength(0)
  expect(screen.getByRole("textbox", { name: "Conversation draft" })).toBe(
    draft
  )
  expect(screen.getByRole("textbox", { name: "File editor" })).toBe(editor)
  expect(draft).toHaveValue("retained draft")
  expect(editor).toHaveValue("retained file buffer")
  expect(screen.getByText("File actions")).toBeVisible()
  expect(
    result.container.querySelector('[data-workspace-pane="conversation"]')
      ?.previousElementSibling
  ).toBeNull()
  expect(
    result.container.querySelector('[data-workspace-pane="files"]')
      ?.previousElementSibling
  ).toBeNull()
})
