import { describe, expect, it } from "vitest"
import {
  buildMonacoModelPath,
  collectLiveModelPaths,
} from "@/lib/monaco-model-path"

describe("Monaco model identity across machines", () => {
  it("keeps equal file paths and undo histories in separate models", () => {
    const a = buildMonacoModelPath("/repo/src/a.ts", "file:a", "remote:1")
    const b = buildMonacoModelPath("/repo/src/a.ts", "file:a", "remote:2")
    expect(a).toBe("codeg://remote-1/file/repo/src/a.ts")
    expect(b).toBe("codeg://remote-2/file/repo/src/a.ts")
    expect(a).not.toBe(b)
    expect(
      collectLiveModelPaths(
        [{ path: "/repo/src/a.ts", id: "file:a" }],
        "remote:1"
      )
    ).not.toContain(b)
  })

  it("distinguishes UNC, POSIX and pathless tabs within the same machine", () => {
    const unc = buildMonacoModelPath("//server/share/a.ts", "a", "remote:1")
    const posix = buildMonacoModelPath("/server/share/a.ts", "a", "remote:1")
    expect(unc).not.toBe(posix)
    expect(buildMonacoModelPath(null, "a", "remote:1")).not.toBe(
      buildMonacoModelPath(null, "a", "remote:2")
    )
  })

  it("preserves the existing model URIs outside the multi-host workspace", () => {
    expect(buildMonacoModelPath("/repo/a.ts", "a")).toBe("file:///repo/a.ts")
    expect(buildMonacoModelPath(null, "a")).toBe("inmemory://model/a")
  })
})
