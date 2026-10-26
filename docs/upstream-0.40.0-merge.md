# Upstream 0.40.0 merge

Merged the official `v0.40.0` tag (`95fd81df`) with the custom branch based on
`bfbecb7c`. The merge targets the tagged release, so 0.36–0.39 come with it,
rather than unreleased changes on upstream main.

## Integration decisions

- Adopt upstream's activity timeline (tool-call rows, diff views, command
  grouping), persisted tool approvals, inline/side-by-side diffs, the rewritten
  PDF viewer (`pdfjs-dist` 6 + `public/pdfjs`), browser and workspace fixes,
  and the new `codeg-cli` companion (`cli-bin`, `docs/cli.md`).
- Retain Zotero academic workspaces and the opt-in MCP tools, Bark completion
  notifications, SSH/Tailscale machines with private keys and jump hosts,
  video previews, configurable upload limits (`CODEG_UPLOAD_MAX_BYTES`) with
  the XHR upload-progress path, and the Codex steering compatibility loader.
- Delete the fork's own PDF preview (`src/lib/pdf-preview.ts`,
  `scripts/copy-pdf-assets.mjs` and their tests) in favour of upstream's
  implementation, and drop the duplicate `isPdfFile`/`PdfPreview` branches that
  the 0.35.1 merge left next to it.
- Keep the fork's Codex fork process recycling: `handle_fork_or_exit` still
  returns a `ForkRestart` and `run_connection` reaps the app-server before
  acknowledging the fork, so the parent's writer lock is released. Upstream's
  non-Codex fork/resume/close behaviour is unchanged, and Claude forks still
  name the same MCP servers and `_meta.claudeCode` as their resume.
- Thread the fork's `CancellationToken` handshake through `run_connection` and
  keep the exit-signal wiring, both of which the 0.40 restart loop has to
  carry.
- Combine both request lists in the ACP connection feature string
  (`…,tasks,result,…,browser_eval,academic,computer,computer_launch,computer_clipboard`),
  both event-notification groups (Kiro metadata and the fork's own), and both
  command/migration registries. The academic migration keeps its timestamp
  position ahead of upstream's newer canvas/assistant/tool-approval migrations.
- Keep `codeg-computer-helper` and the new `codeg-cli` as sidecars in
  `tauri.conf.json`, `prepare-sidecars.mjs`, the Dockerfiles and the release
  workflow, including the macOS helper-app staging and permission audits.
- Keep the router's `upload_body_limit` derived from `upload_max_bytes()` and
  the fork's env parser, so a configured limit still governs the body limit.
- Preserve the local PDF-token-free `pdfjs` lint exception, the Node 26
  `localStorage` shim in `src/test-setup.ts`, and the existing `.gitignore`
  change outside the merge worktree.

## Validation

| Check | Result |
| --- | --- |
| Frontend Vitest | 10,950 passed across 740 files |
| Frontend lint and TypeScript | Passed |
| Next.js static export | Passed |
| Desktop `cargo check` | Passed |
| Desktop Rust lib tests | 6,127 passed; 2 ignored |
| Desktop integration test targets | 70 passed; 1 ignored |
| Desktop Clippy, all targets, `-D warnings` | Passed |
| Server `cargo check` | Passed |
| Server `cargo clippy --all-targets`, `-D warnings` | Passed |
| Server lib tests | 5,881 passed; 1 ignored |
| `codeg-mcp`, `codeg-cli`, `codeg-computer-helper` Clippy | Passed |

Rust validation runs in Docker (`rust:1-bookworm` + Tauri/GTK/WebKit and Node
18 for the subprocess fork tests), with the test binaries executed as uid 1000
so the permission-dependent tests (backup, folder links, DeepSeek parser,
delegation socket) exercise real `EACCES` paths; as root those same eight tests
fail by design. Desktop checks compile the Linux runtime; macOS packaging,
signing and native window interactions require a Mac and were not exercised
here. Existing sidecar placeholders are only for compile checks; release
packaging runs the normal `pnpm tauri:prepare-sidecars` step.

## Notes

- v0.40 migrates the database. Data written by 0.39 cannot be opened by 0.39
  again, so back up the data directory (`CODEG_DATA_DIR`, or the desktop app's
  data folder) before the first 0.40 launch.
- The iOS client is wire-compatible: no route it calls was removed, every ACP
  event it decodes is unchanged for the fields it reads, and its event decoder
  already treats unknown types as `.unknown`. New approval/lifecycle events and
  snapshot fields are additive.
