# Upstream 0.35.1 merge

Merged the official `v0.35.1` tag (`e21eb6b3`) with the custom branch based on
`f5eae7db`. The merge targets the release tag, including 0.34.0 and 0.35.0,
rather than unreleased changes on upstream main.

## Integration decisions

- Adopt upstream's conversation tags, UI Render skill and charts, PWA assets,
  agent package updates, structured Codex errors, browser device support,
  terminal recovery, remote reconnection and workspace restoration.
- Retain Zotero academic workspaces and opt-in MCP tools, Bark completion
  notifications, SSH/Tailscale machines with private keys and jump hosts,
  PDF/video previews, configurable upload limits, original-image references,
  draft restoration and session retirement safeguards.
- Keep the upstream Codex ACP 2.2.2 pin. Its published bundle still ignores
  `promptRequired`. Review its steering lifecycle and extend the compatibility
  loader's exact SHA-256 allowlist and explicit capability gate to this version.
  Keep upstream's per-session serialization and active-prompt ownership.
- Combine upstream's custom-Claude steering policy with the fork's verified
  Codex compatibility marker. Stock or modified Codex bundles remain gated.
- Preserve default native insertion and tool-boundary delivery. Combine
  upstream's protection for edits during asynchronous steering and its
  next-turn queue prioritization with the fork's synchronous queue ownership,
  edited-item checks and interrupt guards.
- Preserve Codex fork process recycling and actual reaping before acknowledgment,
  model/mode restoration and companion-token replacement. Keep upstream's
  non-Codex resume/close behavior and sibling conversation-tag copying.
- Pass the complete ACP error through the custom resume/load protection, so
  upstream's structured `thread_active_writer` and app-server-loss errors keep
  their `session_busy`/`session_unavailable` classification. Retain the saved
  resume failure when load is unsupported and prevent native-history sessions
  from being silently replaced. Add regression coverage for these error shapes.
- Use upstream's tracked workspace activation instead of the fork's former
  visibility-based selector. Keep local-window hiding, remote-close protection
  and cancellation of deferred fullscreen hides after an explicit local restore.
  Background restoration follows upstream's `focus` flag.
- Combine both command/API registries, startup initializers, database migrations
  and dependency sets. Keep the PDF asset-copy installation hook and both
  custom upload-limit README paragraphs. Preserve macOS ARM64 desktop release
  targets and the existing server release targets.
- Preserve the user's original `.gitignore` change and both untracked design
  documents outside the isolated merge worktree.

## Validation

| Check | Result |
| --- | --- |
| Original frontend baseline | 8,453 passed |
| Final frontend Vitest | 9,096 passed across 618 files |
| Frontend lint and TypeScript | Passed |
| Next.js static export | Passed |
| Zotero plugin tests and packaging | 17 passed; XPI built |
| Published Codex ACP 2.2.2 compatibility probes | 8 passed |
| Published Codex ACP 2.1.1 compatibility probes | 8 passed |
| Desktop `cargo check` | Passed |
| Desktop Rust tests, all targets | 5,298 passed; 2 ignored |
| Desktop Clippy, all targets, `-D warnings` | Passed |
| Server `cargo check` | Passed |
| MCP `cargo check` | Passed |
| Server/MCP/helper Rust tests, all targets | 5,064 passed; 2 ignored |
| Server/MCP/helper Clippy, all targets, `-D warnings` | Passed |

Frontend tests use `NODE_OPTIONS=--no-experimental-webstorage`. Rust validation
uses the existing `codeg-bark-builder:local` image as a non-root user with an
init process, Node and Git 2.47.3. Desktop checks compile the Linux runtime;
macOS packaging, signing and native window interactions require a Mac and were
not exercised here. Existing sidecar placeholders are only for compile checks;
release packaging must run the normal sidecar preparation step.
