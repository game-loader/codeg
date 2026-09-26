import { cpSync, mkdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

// Serve every PDF.js resource locally, including CJK character maps and the
// JPEG2000 decoder. Versioned paths keep cached workers paired with the API.
const require = createRequire(import.meta.url)
const packagePath = require.resolve("pdfjs-dist/package.json")
const { version } = JSON.parse(readFileSync(packagePath, "utf8"))
const source = dirname(packagePath)
const target = join("public", "pdfjs", version)
mkdirSync(target, { recursive: true })
cpSync(
  join(source, "legacy/build/pdf.worker.min.mjs"),
  join(target, "pdf.worker.min.mjs")
)
for (const folder of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(join(source, folder), join(target, folder), { recursive: true })
}
