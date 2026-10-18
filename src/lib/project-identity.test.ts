import { describe, expect, it } from "vitest"
import {
  canonicalRemoteKey,
  pickIdentityRemote,
  projectKeyFor,
} from "./project-identity"

describe("canonicalRemoteKey", () => {
  it.each([
    ["https://github.com/Owner/Repo.git", "github.com/owner/repo"],
    ["https://user:secret@github.com/owner/repo/", "github.com/owner/repo"],
    ["git@github.com:owner/repo.git", "github.com/owner/repo"],
    ["ssh://git@github.com:22/owner/repo.git", "github.com/owner/repo"],
    ["git://github.com/owner/repo", "github.com/owner/repo"],
    ["  git@GitHub.com:Owner/Repo  ", "github.com/owner/repo"],
  ])("normalizes %s", (url, expected) => {
    expect(canonicalRemoteKey(url)).toBe(expected)
  })

  it("keeps path case on self-hosted servers", () => {
    expect(canonicalRemoteKey("git@git.example.com:Team/Repo.git")).toBe(
      "git.example.com/Team/Repo"
    )
  })

  it("keeps nested group paths", () => {
    expect(canonicalRemoteKey("https://gitlab.com/group/sub/project.git")).toBe(
      "gitlab.com/group/sub/project"
    )
  })

  it.each([
    "",
    "/srv/git/repo.git",
    "../repo",
    "file:///srv/git/repo.git",
    "C:\\repos\\app",
    "not a url",
  ])("rejects non-network remote %j", (url) => {
    expect(canonicalRemoteKey(url)).toBeNull()
  })
})

describe("pickIdentityRemote", () => {
  it("prefers origin", () => {
    expect(
      pickIdentityRemote([
        { name: "upstream", url: "a" },
        { name: "origin", url: "b" },
      ])?.name
    ).toBe("origin")
  })

  it("falls back to the first remote by name", () => {
    expect(
      pickIdentityRemote([
        { name: "zeta", url: "a" },
        { name: "fork", url: "b" },
      ])?.name
    ).toBe("fork")
  })

  it("returns null without remotes", () => {
    expect(pickIdentityRemote([])).toBeNull()
  })
})

describe("projectKeyFor", () => {
  it("merges the same repository across machines", () => {
    const a = projectKeyFor("local", 3, [
      { name: "origin", url: "git@github.com:game-loader/codeg.git" },
    ])
    const b = projectKeyFor("remote:7", 3, [
      { name: "origin", url: "https://github.com/game-loader/codeg" },
    ])
    expect(a).toBe("git:github.com/game-loader/codeg")
    expect(b).toBe(a)
  })

  it("keeps folders without a usable remote on their own backend", () => {
    expect(projectKeyFor("local", 3, [])).toBe("local:local:3")
    expect(
      projectKeyFor("remote:7", 3, [{ name: "origin", url: "/srv/repo.git" }])
    ).toBe("local:remote:7:3")
  })
})
