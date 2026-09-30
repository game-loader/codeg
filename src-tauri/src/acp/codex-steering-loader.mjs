// Applied only to the npm bundles whose steering lifecycle was reviewed.
// Node's load hook preserves the original module URL and dependency resolution;
// nothing in the user's installed package is rewritten.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

const bundles = new Map([
  [
    "1.13.1",
    "4c1f6c00e67c2ace5a96f0e0fe6e812502a48827a403014d4b68373464f55fce",
  ],
  ["2.0.0", "b401982fc64ae68ed6566b18b7c3d8e879e936650175e453c5a5f1c650c78faa"],
  ["2.0.1", "2729d2a39c9fde47c494828a76c7eb2fabc0f9940f2723183426c1afbf1a5e7d"],
])

export function patchSteering(source, version) {
  if (
    createHash("sha256").update(source).digest("hex") !== bundles.get(version)
  ) {
    return null
  }
  const edits = [
    [
      "steering: {\n          supported: true\n        }",
      "steering: {\n          supported: true,\n          codegPromptRequired: 1\n        }",
    ],
    [
      "    return await this.startNewTurnFromSteering(params);",
      '    if (params.idleBehavior === "promptRequired") {\n      return { outcome: "promptRequired" };\n    }\n    return await this.startNewTurnFromSteering(params);',
    ],
    [
      "    return {\n      sessionId,\n      prompt\n    };\n  }\n  createSessionConfigOptions",
      '    return {\n      sessionId,\n      prompt,\n      idleBehavior: params["_meta"]?.steering?.idleBehavior\n    };\n  }\n  createSessionConfigOptions',
    ],
  ]
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) return null
    source = source.replace(before, after)
  }
  return source
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context)
  if (!url.startsWith("file:") || !url.endsWith("/dist/index.js")) return loaded
  let pkg
  try {
    pkg = JSON.parse(await readFile(new URL("../package.json", url), "utf8"))
  } catch {
    return loaded
  }
  if (pkg.name !== "@agentclientprotocol/codex-acp" || !loaded.source)
    return loaded
  const source = patchSteering(
    Buffer.from(loaded.source).toString("utf8"),
    pkg.version
  )
  if (source === null) {
    process.stderr.write(
      `[codeg] Native steering compatibility unavailable for codex-acp ${pkg.version}\n`
    )
    return loaded
  }
  // Do not install our loader into Node tools later launched by Codex. Restore
  // the inherited options in the adapter's main thread before it spawns them.
  const option = ` --loader=${import.meta.url}`
  const restore = `process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ?? "").replace(${JSON.stringify(option)}, "");\n`
  const firstLine = source.indexOf("\n") + 1
  return {
    ...loaded,
    source: source.slice(0, firstLine) + restore + source.slice(firstLine),
  }
}
