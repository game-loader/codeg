# Orca-like logical projects across execution hosts

Status: approved by the user on 2026-10-13; refined by the user to one unified sidebar and merged project history on the same date; implementation in progress.

## Purpose and approved reference model

The user requested the missing Orca-like logical-project layer on top of the existing multi-host/worktree feature. A repository checked out at different paths on different machines should be recognized as one logical project when its remote identity matches. The reference is Orca commit `180e8c186f779bc8bfbddc93391855e03eeee006`, specifically `project-host-setup-projection.ts`, `project-types.ts`, `git-remote-identity.ts`, and `worktree/identity.ts`.

The same feature must be usable in the fork's desktop workspace and native iOS project catalog. Grouping is display metadata, not a synchronization mechanism or an execution target.

## Approaches considered

1. **Recommended: server-derived identities and client-side project projection.** Rust derives a safe identity on the owning machine, and both clients group host-qualified folder references. This keeps normalization consistent between TypeScript and Swift and avoids changing existing resource IDs or database schema.
2. **Client-side remote parsing.** Reuse `git_list_remotes` and normalize independently in TypeScript and Swift. This reduces backend changes but duplicates identity rules, creates per-folder requests, and exposes unnecessary raw remote URLs to new caches.
3. **Persisted global project registry and manually managed associations.** This could eventually support unrelated repositories in one user-defined project, but it requires new persistence, cross-server reconciliation, and management UI that are not needed for the requested automatic same-source grouping.

## Identity and execution boundaries

Three layers remain distinct:

- `LogicalProject`: a canonical source identity plus a list of host setups.
- `ProjectHostSetup`: an existing folder qualified by backend/profile identity, configuration generation, folder ID and exact path. Multiple checkouts on the same host remain separate setups.
- Worktree: an existing registered child folder belonging to its setup, using the current `parent_id` relationship and host-qualified resource identity.

For example:

```text
Project github:someone/foo
  Machine A /home/me/foo
    registered worktree feature/login
  Machine B /data/projects/foo
    registered worktree feature/api
```

A project header expands/collapses a combined session history across its setups and worktrees. It cannot dispatch file, terminal, chat, Git, clone or worktree operations by itself. Every actionable row supplies the original host-qualified folder reference and fixed client. New operations requiring a destination must select a host setup explicitly.

Existing file/conversation/tab/terminal keys, backend database IDs, workspace ownership, draft recovery and lifecycle fences are unchanged. Different branches and HEADs do not prevent matching source identity. Matching source identity does not imply matching commits or clean/dirty state.

## Remote identity rules

- Read fetch remote configuration on the owning machine without fetching or contacting the forge.
- Choose the first usable remote in this order: `upstream`, `origin`, then other remote names in lexical order. Push-only rows do not participate. Partial-clone fetch annotations must parse correctly.
- Accept HTTPS, HTTP, SSH URL and scp-style Git remotes. Strip transport credentials and `.git` suffixes when deriving identity. Raw remote URLs, usernames, passwords, queries and fragments are not returned by the new API, logged or persisted by the new layer.
- For github.com, derive `github:<lowercase-owner>/<lowercase-repo>`. Fold the documented `ssh.github.com` alias into github.com. GitHub-style enterprise hosts include the host in the project key so different forges cannot collide.
- Other network Git remotes use a provider-neutral `git:<host>/<repository-path>` key. Keep case-sensitive repository paths distinct and retain nondefault endpoint ports where they distinguish services.
- Unknown SSH host aliases are not sufficient evidence of cross-machine equivalence. Use a host-local fallback rather than guessing that identical aliases resolve to the same machine.
- Local filesystem/file remotes, invalid URLs, non-Git directories and repositories with no usable remote stay independent. A fallback project key includes the client backend/profile identity and folder ID, never only folder name or path.
- Forks with the same usable upstream intentionally share a logical project even when origin differs, matching Orca's upstream-first behavior. Forks without that shared identity remain separate.
- Removing/changing a remote and refreshing recomputes grouping. This does not migrate resource state or rewrite tab ownership.

## Backend wire contract

Add a shared-core batch API rather than adding expensive Git reads to all existing `FolderDetail` producers:

```text
POST /api/list_repository_project_identities
Tauri command: list_repository_project_identities
Request: { "folderIds": [1, 2] }
Response: [
  {
    "folder_id": 1,
    "path": "/home/me/foo",
    "status": "resolved",
    "identity": {
      "project_key": "github:someone/foo",
      "provider": "github",
      "host": "github.com",
      "repository_path": "someone/foo",
      "remote_name": "upstream"
    }
  },
  { "folder_id": 2, "path": "/data/plain", "status": "resolved", "identity": null }
]
```

The request addresses only existing regular folder rows belonging to this server. Empty input returns an empty array, not a filesystem scan. A request accepts at most 128 folder IDs; clients chunk larger catalogs. Git reads run with bounded concurrency and per-read timeout, with no shell interpolation and no mutation. A missing/inaccessible folder or a failed probe returns an `unavailable` entry with nullable path/identity, without raw Git errors or remote configuration. A successful probe finding no usable identity returns `resolved` with null identity so clients can distinguish authoritative absence from a transient failure.

The core implementation lives in a focused command/service module and is registered in both HTTP and Tauri. Existing folder DTOs, endpoints and database schema remain compatible. New safe metadata is keyed by both returned folder ID and exact path on the client.

## Desktop projection and view

### One unified sidebar and combined project history (latest user clarification)

The user clarified that the same source repository across devices must show a single combined history directly under its logical project. The previous project → machine/setup → folder history hierarchy is superseded. Display root and worktree conversations together, with a machine and root/worktree label on every row and a full path available for disambiguation. Keep completed and pinned conversations reachable, sort across machines, and preserve the existing delegation visibility rules. Equal numeric conversation IDs on different hosts are distinct rows because every row carries its original host, generation, folder ID and exact path.

Selecting an existing conversation opens that conversation in its owning retained runtime. Selecting a location changes context without creating a draft. Only an explicit New Chat/New Session action creates a draft. A project spans multiple possible execution destinations, so new sessions and folder/worktree operations select a concrete machine and directory; the canonical source key is never an execution target.

The desktop workspace has ONE outer sidebar. Move the original New Chat, search, navigation, view options and conversation management actions into it. Existing folderless chats remain reachable. Remove the old inner sidebar and its reserved width from managed workspace layouts, including initial hydration; retain the legacy sidebar in standalone/independent remote windows. Per-host loading/error/retry indicators remain scoped to their owner, while successful hosts continue to contribute visible history. Keep Machines mode as an alternate catalog presentation without changing runtime providers, drafts, tabs, terminal state or split selections.

Interaction regressions must cover flat merged histories with intentionally colliding IDs across hosts, root/worktree source badges, opening original sessions without draft creation, explicit destination creation, folderless history, fixed-owner context actions, original sidebar navigation/search, and actual managed shell width removal. The previously added actual no-tab panel regression remains required.

The owning `BackendRuntime` holds its identity loader/cache. Its fenced transport and runtime generation gate every result; a per-refresh sequence also rejects older results within the same generation. Runtime disposal clears the cache and subscriptions.

Load identities after the existing opened-folder catalog is available, including known root ancestors of open worktree children. Newly opened folders trigger a probe. Explicit host refresh also refreshes identities. Do not re-run Git probes merely because conversations or unrelated runtime view state changed.

Project projection is a pure function of host descriptors, visible folder catalogs and accepted identity entries. It never drops setups on identity collision, never uses a numeric folder ID across hosts, and only attaches worktree children from the owning host/setup.

The proposed default navigation is **Projects**, with a visible **Projects / Machines** toggle retaining the current machine-first catalog. Machine connection status and add/refresh/manage controls remain reachable in both modes. Every execution-location choice displays machine name and path; worktree management keeps that captured binding. Persist only view preference and collapse state, not raw remotes or credentials. Existing window layout selections and resource references are unchanged.

## Native iOS projection and view

Add safe wire DTOs and a bound `CodegClient` method for the batch endpoint. Each retained `ServerWorkspace` owns an independent identity loader/cache; it is not global session state and does not rebuild an `AppModel` when grouping changes.

The folders page uses a pure logical-project projection with setup references carrying server profile UUID, configuration revision, folder ID and path. Add the same Projects / Servers view choice, defaulting to Projects. Existing server management, per-server folder browser/clone entry points and iPad two-server pane controls remain available.

Selecting an execution location calls the existing `registry.openProject(folderID, on: owner)` with the original owner. Opening worktree management fixes that owner before presentation. Switching grouping cannot dismiss or replace retained session drafts, project runtimes, terminal emulators or split-pane bindings. Folderless chat remains folderless.

The native Projects catalog displays the logical project’s combined history across servers and worktrees directly, with original server/worktree labels and captured-owner selection. Concrete folder details also retain session access. New Task and folder/Git/worktree actions choose a concrete destination explicitly. Global Chats and folderless conversations remain available. The existing files/Git/terminal runtime is preserved across this presentation change.

Identity refresh is separate from the frequent ActivityModel conversation pulse. A successful initial/project-catalog refresh and an explicit pull-to-refresh can update identities; ordinary conversation polling must not repeatedly probe Git.

## Compatibility, failures and retirement

- Old servers returning 404/405/501 for the new endpoint keep separate host-local project entries and show a scoped upgrade hint. Existing chat, files and worktree functionality keep their current compatibility behavior.
- A temporary network/probe failure retains the last successful identity only for the same configuration generation, folder ID and exact path, with an unavailable indication. It cannot merge data from another host.
- Successful null identity removes an obsolete association. A removed folder is pruned from projection and identity cache.
- Address/token replacement or profile deletion invalidates the old cache permanently. Rename/reorder preserves it. Old metadata must never repopulate a replacement server's catalog.
- One host's error cannot erase another host's project entries or steal its active selection.
- Automatic file synchronization, re-cloning, repository movement, branch changes and merging stored conversation data are explicitly excluded. Combining history rows in the project view is required.

## Validation and acceptance

Backend tests cover SSH/HTTPS equivalence, upstream priority, fork/shared-upstream behavior, GitHub casing, documented aliases, enterprise-host isolation, generic case/port boundaries, credential redaction, local/invalid remotes, partial clones, authoritative remote removal, real temporary Git repositories, batch limits, missing folders and per-entry probe failures.

Desktop tests cover same-source/different-path grouping; same-name/different-source separation; multiple checkouts on one host; equal folder IDs and paths on different hosts; correct worktree child ownership; old-server fallback; partial failures; stale refresh/generation results; URL/token replacement; persisted view preference; and all click/dialog callbacks retaining their initiating host.

Native XCTest and portable tests cover wire decoding, equivalent project projections, profile/configuration retirement, same-ID conflicts, old-server fallback, unchanged folderless chat/session identity, retained terminal/project state, and fixed-owner callbacks. Final acceptance requires frontend lint/tests/static export, affected Rust check/test/clippy, actual iOS device compilation and simulator tests, and a two-server HTTP metadata/routing smoke test where available. Manual native desktop/iPad interaction is reported separately if unavailable.

Continue in the existing isolated feature worktrees; preserve original checkouts and unrelated `.gitignore`/review report changes. New UI strings are English and Simplified Chinese only. No dependencies or database migrations are required. Any release validation keeps macOS-only desktop builds and the existing Linux server targets; the iOS bundle ID/signing method is unchanged.
