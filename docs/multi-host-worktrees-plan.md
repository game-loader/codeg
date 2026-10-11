# 单窗口多机器 worktree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 一个桌面窗口同时操作本机和多个 Codeg Server 的仓库、worktree、会话、文件和终端，并独立恢复各机器状态。

**Architecture:** 每个后端固定一个客户端和独立 runtime，包括 API、事件以及可实例化的资源 store。React 后端上下文为现有界面注入客户端；窗口聚合机器树和资源标签，在单视图或左右分屏中保留 runtime。复用 Rust 按连接分流的 HTTP/WS 代理及现有 Git 命令。

**Tech Stack:** Tauri 2、Rust/Axum、Next.js 16 static export、React 19、TypeScript strict、Zustand、Vitest。

**Spec:** `docs/multi-host-worktrees-design.md`

## Global Constraints

- 首版复用现有 Codeg Server 连接，不引入 SSH 自动部署。
- `BackendKey = "local" | "remote:<connectionId>"`；资源 ID 与路径保持后端原值，窗口引用携带 backendKey。
- 一个异步操作始终绑定发起时的客户端，不读全窗口的活动机器；目标失效时不得回退到本机。
- 相同路径、资源 ID 和分支名称的两套后端必须完全隔离。
- 后台 runtime 保持运行，切换不取消智能体或终端。
- 连接配置变化会失效旧代次，HTTP/WS/浏览器出口一致刷新。
- 兼容旧单后端、Web 和独立操作窗口；不改服务器数据库 ID。
- 新文案仅简体中文和英文；保持静态导出。
- 保留主工作区既有未提交内容；开发目录为 `/home/droid/worktrees/codeg-multi-host`。

## Task 1: 固定客户端和 React API 绑定

**Files:** `src/lib/api.ts`, `src/lib/backend/client.ts`, `src/lib/backend/types.ts`, `src/contexts/backend-client-context.tsx`, `src/lib/academic.ts`, `src/lib/platform.ts`, 调用 API 的 React 组件和 hooks。

**Interfaces:**

```ts
export type BackendKey = "local" | `remote:${number}`
export interface BackendClient {
  readonly key: BackendKey
  readonly name: string
  readonly transport: Transport
  readonly api: BackendApi
  readonly platform: BackendPlatform
  readonly remoteConnection: RemoteWorkspaceConnection | null
}
export function createBackendApi(binding: BackendApiBinding): BackendApi
export function useBackendClient(): BackendClient
export function useBackendApi(): BackendApi
export function useBackendPlatform(): BackendPlatform
```

- [x] 添加固定 transport 的 API 工厂；现有命名导出仍使用默认客户端兼容，类型导出保持。
- [x] 工厂中所有调用、辅助函数、多步上传、弹窗 remoteConnectionId 与订阅使用固定 binding；shell 能力走本机。
- [x] React 组件和 hooks 从上下文取得 API/platform，绑定到渲染时的 backend；纯函数或模块帮助函数显式接收绑定。
- [x] 新测试同时创建 A/B 客户端，folderId=1 与 path 相同，验证两次调用分别到各自 transport；A 的上传后续提交在 B 被选择后仍发往 A。
- [x] 运行 API、platform、上传和上下文相关 Vitest 与 `tsc --noEmit`，记录新增错误与修复。

Test core:

```ts
await Promise.all([a.api.openFolder("/repo"), b.api.openFolder("/repo")])
expect(aTransport.call).toHaveBeenCalledWith("open_folder", { path: "/repo" })
expect(bTransport.call).toHaveBeenCalledWith("open_folder", { path: "/repo" })
```

## Task 2: 独立资源 store、缓存和订阅

**Files:** `src/stores/app-workspace-store.ts`, `tab-store.ts`, `conversation-runtime-store.ts`, `academic-store.ts`, `canvas-store.ts`, `canvas-boards-store.ts`, `command-terminal-link-store.ts`, `forge-refresh-store.ts`, `src/hooks/use-acp-agents.ts`, `use-workspace-state-store.ts`, `src/contexts/backend-stores-context.tsx`, 消费上述 store 的组件和上下文。

**Interfaces:**

```ts
export function createBackendStores(client: BackendClient): BackendStores
export function BackendStoresProvider(props: {
  stores: BackendStores
  children: ReactNode
}): ReactNode
export function useBackendStores(): BackendStores
```

- [x] 为所有后端资源 store 提供实例工厂，闭包包含墓碑、请求 epoch、缓存、定时器和 store 之间的订阅。
- [x] 保留默认 store 导出给旧页面与现有测试；React 消费者显式取得当前实例，包括回调内 `.getState()`。
- [x] 将 ACP agent 扫描和文件 watcher 的模块缓存按客户端实例隔离；订阅、refcount 和在途请求绑定客户端。
- [x] 后端实例退出释放资源，不因切换可见视图退出；旧代次异步写回被拒绝。
- [x] 测试 A/B 相同会话 ID 的 workspace/tab/runtime、academic、文件 watcher；A 的删除墓碑、canvas 写入或请求不能影响 B。
- [x] 跑相关 store、context、agents、workspace watcher Vitest 与 TypeScript 检查。

Test core:

```ts
a.workspace.getState().setActiveFolderId(1)
b.workspace.getState().setActiveFolderId(1)
a.workspace.getState().applyConversationRemove(1)
expect(b.workspace.getState().conversations).toEqual(bConversations)
```

## Task 3: Rust worktree 与连接生命周期

**Files:** `src-tauri/src/commands/folders.rs`, `commands/remote_proxy.rs`, `commands/remote_workspace.rs`, `web/handlers/git.rs`, `web/router.rs`, `lib.rs`, `models/folder.rs`, `workspace_transfer.rs`，相关 Rust tests。

**Interfaces:** `git_list_worktrees { path } -> GitWorktreeInfo[]`；原 `git_worktree_add` 保留 `base`；`git_remove_worktree_path { path, worktreePath, sourceFolderId, deleteBranch, force } -> GitWorktreeRemoval`。

```rust
#[derive(serde::Serialize)]
pub struct GitWorktreeInfo {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub is_main: bool,
    pub detached: bool,
    pub bare: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
}
```

- [x] 解析 `git worktree list --porcelain -z`，保留 detached、bare、locked、prunable 和含空格/换行路径。
- [x] 增加桌面/服务器共享列表接口；按路径删除复用现有忙任务、主工作树、脏文件和分支保护。
- [x] 连接 update/delete 时刷新或终止对应事件 WS；重连读取当前凭据，网络错误不冒充 401。
- [x] 代理请求可校验可选配置 revision，拒绝旧配置绑定；保持旧客户端默认参数兼容。
- [x] 上传下载进度与取消记录机器/发起窗口归属，不泄漏令牌。
- [x] 临时 Git 仓库测试列表/删除，HTTP route 测试与 Rust server/desktop check/test/clippy。

## Task 4: BackendRegistry 与单窗口外壳

**Files:** `src/lib/backend/registry.ts`, `src/components/workspace/multi-host-workspace.tsx`, `backend-runtime.tsx`, `multi-host-sidebar.tsx`, `multi-host-tabs.tsx`, `src/app/workspace/layout.tsx`, `src/contexts/remote-connection-context.tsx`。

- [x] Registry 为 local 与每个 remote 创建固定客户端及 Task 2 stores，独立记录 loading/error/generation。
- [x] 支持同时保留 runtime，统一机器树；每台机器独立取仓库和会话摘要，迟到请求只更新原机器。
- [x] 侧栏选择 worktree 激活所属 runtime 和目录；统一标签记录 `{ backendKey, resourceId }`；左右分屏可以选择不同 runtime。
- [x] 后端 content 消费自身 providers；本机窗口 chrome 仅由外层渲染，隐藏视图保留订阅。
- [x] 验证 A/B 同编号标签、双分屏发送与权限回复、单机401/断线，切换不执行 disconnect/terminalKill。

## Task 5: Worktree 管理、浏览器与恢复

**Files:** `src/components/workspace/host-worktree-dialog.tsx`, `src/lib/backend/worktrees.ts`, `src/lib/types.ts`, `src/lib/api.ts`, `src/components/browser/`, `src/components/terminal/`, `src/contexts/workspace-context.tsx`, `src/hooks/use-remote-workspace-connections.ts`, `src/i18n/messages/en.json`, `zh-CN.json`，新恢复模块。

- [x] 每台机器仓库展开完整 worktree 清单；创建固定机器/仓库/base，Git 成功后注册失败提供仅注册重试。
- [x] 删除固定机器与路径，沿用保护和用户确认；不从当前分屏重新推导目标。
- [x] 文件、terminal、浏览器、弹窗跟随 client；两个 localhost 预览使用各自 egress。
- [x] 保存版本化窗口布局，不含凭据；各服务器仅保存自己的 opened_tabs，旧布局在旧后端内迁移。
- [x] 新入口在当前窗口挂入远端；旧独立窗口入口保留兼容。
- [x] 全部可见新文案中英文；测试创建注册中断、同名文件、浏览器 egress 与重启恢复。

## Task 6: 集成与验收

- [x] 对完整 diff 执行需求与代码审查，修复路由、生命周期和兼容问题。
- [x] 前端执行 `pnpm lint .`, `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm build`。
- [x] Rust 执行受影响模式 check/test/clippy；因共享核心变更覆盖 server-bin 与桌面 test-utils。
- [x] 使用两套临时服务器数据目录和临时仓库验证 A/B 路由、worktree创建/删除、文件与终端；不操作用户真实机器。
- [x] 更新设计/用户文档和验证记录，提供分支、改动与真实验证限制。

## 验收记录

最终结果与真实桌面验收限制见 [multi-host-worktrees-validation.md](multi-host-worktrees-validation.md)。全量测试、检查及双临时服务器 API/进程烟测已通过；未声称完成原生桌面 GUI 烟测或安装包构建。
