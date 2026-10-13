# Cross-host Logical Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognize repositories with the same canonical Git source as one logical project in desktop and native iOS, preserving independent host execution.

**Architecture:** Rust reads safe canonical source identities through a bounded batch API. Each fixed-generation runtime/workspace owns its metadata loader; clients derive pure project/setup projections without changing execution or resource keys. Projects is the default catalog view, with the existing machine view available.

**Tech Stack:** Rust 2021, Tokio, SeaORM/SQLite, Axum/Tauri 2; strict TypeScript, React 19 and Zustand; Swift 5 mode, Foundation/Observation and SwiftUI, iOS 26.

**Spec:** `docs/logical-projects-design.md` (approved 2026-10-13).

## Global Constraints

- Preserve original checkouts and unrelated `.gitignore`/review report changes; use the existing isolated worktrees.
- New UI strings are English and Simplified Chinese only. No dependencies or database migrations.
- Identity is display metadata. Keep existing host/profile/configuration-generation + folder ID + exact path execution bindings and resource keys; no file sync, session merge, re-clone or draft replay.
- Remote choice is upstream, origin, then lexical usable fetch remote. GitHub source matching is case-insensitive; generic repository-path matching is case-sensitive. No raw remote URL or credentials in the new wire DTO, cache, persistence or logs.
- Default catalog view is Projects; retain Machines/Servers mode. Missing API 404/405/501 produces isolated fallback and a scoped upgrade hint.
- A successful null identity removes an old association; a failed probe retains accepted metadata only for the same generation, folder ID and exact path. Fence successes, failures and loading states against newer refreshes and retirement.
- Desktop release builds remain macOS-only; Linux server targets are unchanged. Native iOS signing/bundle ID remains unchanged.
- Workers may only write their task's production files and its own report. No nested subagents, push, publish, branch switch, reset or cleanup of unrelated artifacts. Commit only the task's explicitly staged files.

---

### Task 1: Shared Rust safe identity endpoint

**Files:**
- Create: `src-tauri/src/git_remote_identity.rs`, `src-tauri/src/commands/project_catalog.rs`.
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/models/folder.rs`, `src-tauri/src/models/mod.rs`, `src-tauri/src/web/handlers/folders.rs`, `src-tauri/src/web/router.rs`.
- Modify if useful: `src-tauri/src/db/service/folder_service.rs` (bounded lookup only), `src-tauri/src/commands/folders.rs` (corrected fetch parser reuse only).
- Test: pure normalizer tests in its module, core/real-Git tests in the command module and `src-tauri/tests/api_integration.rs`.

**Interfaces:**
- Produces: `POST /api/list_repository_project_identities`, and Tauri `list_repository_project_identities` with request `{folderIds: number[]}`.
- Response: array of `{folder_id: i32, path: string|null, status: "resolved"|"unavailable", identity: null|{project_key:string, provider:"github"|"git", host:string, repository_path:string, remote_name:string}}`.
- Produces: `list_repository_project_identities_core(&AppDatabase, Vec<i32>) -> Result<Vec<RepositoryProjectIdentityEntry>, AppCommandError>`.
- A batch is limited to 128 IDs, empty means empty, duplicate IDs are deduplicated. Requested IDs resolve only registered regular folders. Missing IDs receive unavailable entries; no scan of all folders.

- [ ] **Step 1: Read the approved spec and verify the untouched Rust baseline.** Use a cached Docker Rust toolchain because the host shell has no cargo. Run an existing focused server test before editing, retain its command/output in the report, and do not use or edit a different plan's SDD directory.
- [ ] **Step 2: Add failing parser/normalizer tests**, including these equivalences and exclusions:

```rust
assert_eq!(normalize("git@github.com:Someone/Foo.git").unwrap().project_key,
           "github:someone/foo");
assert_eq!(normalize("https://github.com/someone/foo.git").unwrap().project_key,
           "github:someone/foo");
assert_eq!(normalize("ssh://git@ssh.github.com:443/someone/foo.git").unwrap().project_key,
           "github:someone/foo");
assert!(normalize("git@github-work:someone/foo.git").is_none());
assert!(normalize("file:///home/me/foo").is_none());
assert_ne!(normalize("https://git.example.com/Team/Foo.git"),
           normalize("https://git.example.com/team/foo.git"));
```

These snippets use a test-local `normalize` adapter to the production normalizer. Also cover upstream-first priority, invalid upstream falling back to origin, fork/shared-upstream, partial-clone fetch suffix, push-only rows, enterprise-host isolation, endpoint-port distinction, credentials/query/fragment exclusion and authoritative no-remote results. Confirm red before production implementation.
- [ ] **Step 3: Implement the pure normalizer and batch core.** Use network remotes only; known GitHub provider normalization and conservative unknown SSH-alias fallback follow the spec. Never invoke a shell or fetch. Require the exact registered repository path, not an ancestor repo. Use process-global four-probe concurrency, five-second kill-on-drop read timeout, bounded captured output (256 KiB), and a 25-second batch deadline covering waiting; timed out entries are unavailable and processes are reaped. Non-Git/no-remote is resolved null; I/O/probe failure is unavailable. Keep old folder DTO/endpoints intact.

```rust
#[derive(Clone, Debug, serde::Serialize)]
pub struct RepositoryProjectIdentityEntry {
    pub folder_id: i32,
    pub path: Option<String>,
    pub status: RepositoryProjectIdentityStatus,
    pub identity: Option<RepositoryProjectIdentity>,
}
```

- [ ] **Step 4: Register HTTP and Tauri adapters** using the same core, protected existing router, camelCase request fields and snake_case response fields. Validate batch limits before DB/process work. Add HTTP tests with temporary migrated DB/Git repositories verifying shape, auth, multiple entries, shared-source identities, unknown folders, no raw secrets and null identity after removing remote.
- [ ] **Step 5: Run covering tests, server check/clippy and formatting.** Commands inside the cached Docker toolchain, from `src-tauri`: `cargo test --locked --no-default-features --features server-bin --lib git_remote_identity`, `cargo test --locked --no-default-features --features server-bin --lib project_catalog`, `cargo test --locked --no-default-features --features test-utils --test api_integration repository_project`, `cargo check --locked --no-default-features --features server-bin --bin codeg-server`, `cargo clippy --locked --no-default-features --features server-bin --bin codeg-server --lib -- -D warnings`, `cargo fmt --check`. Retain timeout/concurrency evidence; do not claim tests not run.
- [ ] **Step 6: Commit task files and write the report** including status, complete change list, red/green evidence, exact commands/results, commit and concerns. Parent dispatches independent spec/quality review before completion.

### Task 2: Desktop runtime metadata, projection and project-first catalog

**Files:**
- Create: `src/lib/backend/project-catalog.ts`, `src/lib/backend/project-catalog.test.ts`, `src/components/workspace/multi-host-projects.tsx` and corresponding component tests if splitting rendering is useful.
- Modify: `src/lib/types.ts`, `src/lib/api.ts`, `src/lib/backend/runtime.ts`, `src/lib/backend/window-layout.ts`, `src/components/workspace/multi-host-workspace.tsx`, `src/components/workspace/multi-host-sidebar.tsx`.
- Test/modify: existing runtime/registry/layout/sidebar/workspace tests; `src/i18n/messages/en.json`, `src/i18n/messages/zh-CN.json` (confirm actual locale paths before editing).

**Interfaces:**
- Consumes Task 1 exact wire DTO and endpoint; exposes `BackendApi.listRepositoryProjectIdentities(folderIds: number[]): Promise<RepositoryProjectIdentityEntry[]>` through both bound client and existing API exports.
- Produces a runtime-owned identity store and pure logical-project projection. Each setup retains original `BackendKey`, runtime generation and full `FolderDetail`; child folders are attached only within that owning host.
- Existing `onOpenFolder(key, folder)`, `onWorktrees(key, folder)`, directory browser/clone and split-pane callbacks continue to use the original owner. A captured-generation guard must reject stale row actions before resolving registry entries.

- [ ] **Step 1: Write red store/projection tests.** Include same source + different paths/hosts -> one project/two setups; same names with different source -> two; two checkouts on one host -> both retained; no identity -> host-qualified fallback; equal IDs and paths across hosts -> correct independent children.

```typescript
const projects = projectCatalog(hosts, catalogs)
expect(projects).toHaveLength(1)
expect(projects[0].setups.map((setup) => setup.backendKey)).toEqual([
  "remote:1", "remote:2",
])
expect(projects[0].setups[0].folder.path).not.toBe(
  projects[0].setups[1].folder.path
)
```

`projectCatalog` is the test-local adapter to the production projection. Add deferred responses for overlapping refresh, changed path/ID, retirement, unavailable entries, missing entries, success-null removal, capability reprobe, >128 roots and no probe during conversation-only changes. Verify red.
- [ ] **Step 2: Implement safe DTO/API adapter, runtime-owned store and projection.** Batch at 128, prune removed/path-changed folders, coalesce duplicate loads, and fence all state updates by runtime lifetime and per-refresh sequence. Preserve previously accepted metadata on transient/partial errors, but clear on authoritative absence or retired configuration. Do not persist remote metadata. Explicit refresh retries old-server capability after an upgrade; ordinary polling does not.

```typescript
type ProjectSetup = {
  backendKey: BackendKey
  generation: number
  folder: FolderDetail
  children: readonly FolderDetail[]
}
```

- [ ] **Step 3: Publish project summaries through RuntimeObserver** without tying probes to conversation/view repaint. Include open-folder root ancestors from allFolders. Refresh metadata on added folders, explicit host refresh and relevant remote changes, preserving the existing folders/error snapshots and fixed generation.
- [ ] **Step 4: Add Projects/Machines view selection, default Projects.** Persist the mode with whitelist/default handling and project-collapse state separately from active resources. Render logical-project headers as disclosure only; setup rows show host/name/path and fixed-owner worktree buttons. Keep machine status, add/refresh/manage controls reachable. In a generic project Add action, require explicit destination setup selection. English/Chinese strings only.
- [ ] **Step 5: Add component and layout regression tests**, switching modes without replacing runtimes, default/restored invalid preferences, clicking equal-ID setups/children, worktree dialogs using captured owner, stale callback rejection after replacement, host-only error hints, and preserved old machine view.
- [ ] **Step 6: Run covering Vitest, strict TypeScript, lint and static build.** Use `NODE_OPTIONS=--no-experimental-webstorage pnpm exec vitest run <changed tests>`, `pnpm exec tsc --noEmit`, `pnpm lint .`, `pnpm build`; keep exact commands/results. Commit explicitly owned files, write report, then parent spec/quality review.

### Task 3: Native iOS workspace catalog and grouped projects

**Files (iOS worktree `/home/droid/worktrees/codeg-ios-multi-host`):**
- Create: `CodegiOS/Models/LogicalProject.swift`, `CodegiOS/Features/Projects/ProjectCatalogModel.swift`, `CodegiOS/Networking/CodegClient+ProjectIdentity.swift` if a separate extension fits private read transport access.
- Modify: `CodegiOS/App/ServerWorkspaceRegistry.swift`, `CodegiOS/App/RootView.swift`, `CodegiOS/Features/Projects/MultiServerProjectListView.swift`, `CodegiOS/Features/Projects/ProjectDetailView.swift`, `CodegiOS/Networking/CodegClient.swift` (minimum internal read adapter only), `CodegiOS/Resources/Localizable.xcstrings` (confirm actual catalog location).
- Test: `CodegiOSTests/LogicalProjectCatalogTests.swift`, `CodegiOSTests/ProjectIdentityWireTests.swift`, workspace isolation/retention tests as needed; add a portable Foundation-only test script for production grouping/loader logic.

**Interfaces:**
- Consumes Task 1 exact API DTO. Swift JSONDecoder converts snake_case response fields using the client's existing configuration; request explicitly encodes `folderIds` in camelCase.
- A per-`ServerWorkspace` project catalog uses its fixed `CodegClient` and `ServerBindingLifetime`. Setup refs include server UUID, configuration revision, folder ID and exact path.
- Keep `registry.openProject(_:on:)`, worktree opening callbacks and `ProjectWorkspaceCache` execution keys unchanged. Derive grouped projects from current nonretired workspaces.

- [ ] **Step 1: Add red Foundation/native tests** for wire shape, no identity/old server, equivalent canonical projects, same-ID/path conflicts, multiple local setups, parent/child host isolation, stale sequence/path/generation responses and capability reprobe. Include a test where held conversation requests do not prevent project catalog/detail resolution, and mode changes keep drafts/project runtimes alive.

```swift
XCTAssertEqual(projects.count, 1)
XCTAssertEqual(projects[0].setups.count, 2)
XCTAssertNotEqual(projects[0].setups[0].serverID,
                 projects[0].setups[1].serverID)
XCTAssertNotEqual(projects[0].setups[0].path,
                 projects[0].setups[1].path)
```

- [ ] **Step 2: Implement wire DTO/read adapter, pure projection and independent catalog loader.** Bootstrap folder/open-folder data without `listConversations()`, loading identity only after concrete folder refs are known. Chunk 128 IDs; coalesce loads. Retain each successful endpoint's snapshot on partial errors. Check lifetime and sequence around every publication including error/loading state; omitted identity entries are unavailable, not authoritative null. Prune changed paths/removed folders and clear synchronously on retirement.
- [ ] **Step 3: Wire one loader per retained workspace in RootView/registry**, independent of Activity conversation polling. Refresh after browse/clone/worktree mutation and explicit pull-to-refresh. Resolve project details from the project catalog so slow conversation requests do not block independent project navigation. Do not remove existing Activity state used elsewhere.
- [ ] **Step 4: Add Projects/Servers mode, default Projects.** Persist in registry's injected UserDefaults, separate from server selection and navigation. Render project -> concrete owner/path -> registered worktrees, with fixed-owner management actions. Preserve per-server status/errors, open-folder/clone, server management and iPad Single Server/split choices. View-mode changes are presentation-only.
- [ ] **Step 5: Run portable production-core tests with cached `swift:6.2-jammy`, full Swift parse and existing binding/HTTP/architecture regressions.** New Foundation script must actually compile production logic, not duplicated model logic. Native XCTest is wired into existing target; Linux parsing is not a native build. Keep project version/signing unchanged in this task; parent coordinates validation and release.
- [ ] **Step 6: Commit explicitly owned iOS files and write report.** Avoid pre-existing `.gitignore` and untracked review reports. Parent dispatches spec/quality review and later actual device/simulator CI if push approval is available.

### Task 4: Whole-feature acceptance and delivery

**Files:**
- Modify: `docs/logical-projects-design.md`, this plan, `docs/preview-release.md`, iOS `docs/multi-host-worktrees.md`, READMEs/changelogs as appropriate.
- Create acceptance evidence in this plan's SDD workspace and a task-owned `/tmp/codeg-logical-projects-evidence` directory; no writes to another plan's SDD artifacts.

**Interfaces:**
- Consumes reviewed Tasks 1-3. Shared API shape, default grouping and fallback semantics must match all three layers.
- Produces focused whole-branch review, final test evidence, source commits and user-readable acceptance report. Remote push/build/publication requires the user's requested approval; it is not a prerequisite for local implementation.

- [ ] **Step 1: Independently review complete changes**, generate diff packages from the recorded task base commits (Codeg `c099c241`, iOS `fb4967e`) and check all task review findings are resolved. No unreviewed controller patches; a fix worker handles confirmed findings and receives scoped re-review.
- [ ] **Step 2: Run full frontend and affected Rust checks/tests**, both server and desktop compilation where SDK dependencies are available. Run full portable iOS regression suites and Swift source parse. Record native compilation/test coverage separately.
- [ ] **Step 3: Build/run two isolated temporary servers** with independent databases/repos and intentionally colliding folder IDs. Send authenticated real HTTP requests asserting identical normalized source for SSH/HTTPS/different paths, upstream/fork selection, different-source isolation, null after remote removal, per-entry failure and no raw credentials. Verify GET/chat/file/terminal routes remain host-qualified and never affect the other server. Clean up only test-owned containers/processes.
- [ ] **Step 4: Update user docs** with default/toggle, Git source identity, upstream priority, independent execution, old-server upgrade hint and refresh behavior; mark checklist status according to actual evidence.
- [ ] **Step 5: If the user approves remote delivery**, push only existing feature branches to their forks, let Codeg Preview Release build macOS ARM64 plus Linux server x64/ARM64, and run the native iOS Build workflow. After native tests pass, release a new iOS build using existing bundle/signature flow only with publication approval. Verify commit IDs, actual workflow conclusions, asset SHA/ZIP/plist integrity before claiming successful packaging.
- [ ] **Step 6: Preserve original checkouts and feature worktrees**, commit task docs, archive evidence/rulings, and report what is implemented and what validation/release actions are actually complete. Do not merge into main or create a PR without the user's selection.
