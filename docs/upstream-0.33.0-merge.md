# Upstream 0.33.0 merge

Merged the official `v0.33.0` tag (`4c4c26af`) into the local fork based on
`be28e09b`. The integration stays on the task branch for review.

## Integration decisions

- Adopt upstream's Computer Use, workspace restoration, agent package pins,
  Codex error handling and transcript parsing, and touch composer focus.
- Use upstream's session-busy explanation and fork-parent close behavior.
- Retain the fork's Zotero academic workspaces and opt-in MCP tools,
  SSH/Tailscale machine management, Bark notifications, PDF/video previews,
  upload limits, image references, draft restoration and session safeguards.
- Keep upstream's Codex ACP 2.1.1 pin. Its published bundle still drops the
  `promptRequired` steering opt-in, so retain the fork's compatibility loader
  and extend its exact bundle hash and capability gate to 2.1.1. Keep
  upstream's steering queue and prompt lifecycle.
- Combine Zotero and Computer Use tool groups without enabling other groups.
  A regression test verifies their simultaneous availability.
- Route the fork's local-window hiding through upstream's restore tracker so
  a dismissed local workspace stays dismissed after restart.
- Preserve macOS ARM64 desktop releases and existing server targets. Use
  upstream's sidecar preparation script for previews; package the computer
  helper beside the server in preview archives and Docker images.

## Validation

| Check | Result |
| --- | --- |
| Frontend Vitest | 8,453 passed |
| Frontend lint and TypeScript | Passed |
| Next.js static export | Passed |
| Zotero plugin | 17 passed |
| Rust desktop and all targets | 5,102 passed; 2 ignored |
| Rust without desktop runtime and all targets | 4,880 passed; 2 ignored |
| Published Codex ACP 2.1.1 compatibility probes | 8 passed |
| Desktop `cargo check` | Passed |
| Desktop and server/MCP/helper Clippy with `-D warnings` | Passed |
| Release YAML, shell syntax and helper staging | Passed |

Rust checks use the existing builder image with a non-root user and an init
process, allowing filesystem-permission and process-reaping tests to behave
normally. `test-utils` enables the new standalone binary features and test
fixtures. Frontend tests use `NODE_OPTIONS=--no-experimental-webstorage`.

The Codex probes execute the actual npm bundle with a stub app-server client;
they require no inference requests. Their command is documented in
[codex-steering.md](codex-steering.md).

macOS packaging, code signing, Screen Recording and Accessibility behavior
require the macOS release runner or a Mac for validation; they were not run
in this Linux task workspace.
