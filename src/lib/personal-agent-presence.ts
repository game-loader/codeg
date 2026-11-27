const SKIPPED = ["/login", "/pet", "/computer-indicator", "/computer-marker"]

export function skipsPresence(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/"
  return SKIPPED.some((p) => path === p || path.startsWith(`${p}/`))
}

export function isWorkspacePath(pathname: string): boolean {
  return pathname === "/workspace" || pathname.startsWith("/workspace/")
}
