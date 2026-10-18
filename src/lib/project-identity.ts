import type { GitRemote } from "@/lib/types"

/**
 * Which backend a resource lives on: this machine, or a saved remote
 * connection. Folder and conversation IDs are only unique per backend.
 */
export type BackendKey = "local" | `remote:${number}`

/**
 * A logical project that may be checked out on several machines.
 *
 * `git:` keys come from a remote URL, so the same repository cloned on two
 * machines resolves to the same key. `local:` keys belong to one folder on
 * one backend and never merge with anything.
 */
export type ProjectKey = `git:${string}` | `local:${BackendKey}:${number}`

// Hosts whose repository paths are case-insensitive, so `Owner/Repo` and
// `owner/repo` name the same project. Self-hosted servers keep their case.
const CASE_INSENSITIVE_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "gitee.com",
])

/** scp-style remote: `[user@]host:path`, with no scheme and no `//`. */
const SCP_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/

/**
 * Normalize a git remote URL to `host/path`, or null when it doesn't name a
 * network host (local paths, `file://`, empty strings).
 */
export function canonicalRemoteKey(rawUrl: string): string | null {
  const url = rawUrl.trim()
  if (!url) return null

  let host: string
  let path: string
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)
  if (scheme) {
    const protocol = scheme[1].toLowerCase()
    if (protocol === "file") return null
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    host = parsed.hostname
    path = decodeURIComponent(parsed.pathname)
  } else {
    const scp = SCP_REMOTE.exec(url)
    // A Windows drive path (`C:\repo`) also matches scp syntax; one-letter
    // "hosts" are never real remotes.
    if (!scp || scp[1].length === 1) return null
    host = scp[1]
    path = scp[2]
  }

  host = host.toLowerCase().replace(/^\[|\]$/g, "")
  path = path
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
  if (!host || !path) return null
  if (CASE_INSENSITIVE_HOSTS.has(host)) path = path.toLowerCase()
  return `${host}/${path}`
}

/** `origin` first, otherwise the first remote by name — stable across calls. */
export function pickIdentityRemote(
  remotes: readonly GitRemote[]
): GitRemote | null {
  const origin = remotes.find((r) => r.name === "origin")
  if (origin) return origin
  return [...remotes].sort((a, b) => a.name.localeCompare(b.name))[0] ?? null
}

export function projectKeyFor(
  backendKey: BackendKey,
  folderId: number,
  remotes: readonly GitRemote[]
): ProjectKey {
  const remote = pickIdentityRemote(remotes)
  const canonical = remote ? canonicalRemoteKey(remote.url) : null
  return canonical ? `git:${canonical}` : `local:${backendKey}:${folderId}`
}
