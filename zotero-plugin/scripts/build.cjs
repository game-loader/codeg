/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS entrypoint. */
// Dependency-free XPI writer. XPI is a ZIP archive; stored entries are supported
// by Zotero and avoid requiring a platform-specific zip executable.
const fs = require("node:fs")
const path = require("node:path")
const root = path.resolve(__dirname, "..")
const files = ["manifest.json", "bootstrap.js", "bridge.js"]
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8")
)

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const entries = []
const directory = []
let offset = 0
for (const filename of files) {
  const name = Buffer.from(filename)
  const data = fs.readFileSync(path.join(root, filename))
  const crc = crc32(data)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0x21, 12) // 1980-01-01, deterministic ZIP timestamp
  header.writeUInt32LE(crc, 14)
  header.writeUInt32LE(data.length, 18)
  header.writeUInt32LE(data.length, 22)
  header.writeUInt16LE(name.length, 26)
  entries.push(header, name, data)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x21, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(offset, 42)
  directory.push(central, name)
  offset += header.length + name.length + data.length
}
const centralDirectory = Buffer.concat(directory)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(files.length, 8)
end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(centralDirectory.length, 12)
end.writeUInt32LE(offset, 16)
const out = path.join(
  root,
  "dist",
  `codeg-academic-bridge-${manifest.version}.xpi`
)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, Buffer.concat([...entries, centralDirectory, end]))
console.log(out)
