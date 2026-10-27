# 单窗口多机器 worktree 验证记录

验证日期：2026-10-11。实现位于 `feat/multi-host-worktrees` 的独立工作目录 `/home/droid/worktrees/codeg-multi-host`，基于 `f5eae7db`。对应版本以 Git 提交为准；原工作目录及其已有未提交内容保持不变。

本文记录实现阶段的本地检查及双临时服务器验收。安装包使用仓库现有的 [预览发布流程](preview-release.md) 单独构建，包含 macOS Apple Silicon 客户端及 Linux x64/ARM64 Server，不构建 Linux 桌面包。

## 实现范围

- 同一桌面窗口的机器 → 仓库 → worktree 列表、跨机器标签及水平/垂直分屏。
- 固定后端客户端、独立资源 store/缓存/订阅；隐藏视图保留会话和任务，不因切换机器而终止进程。
- 完整 worktree 清单、指定 base 创建、仅注册重试、按路径移除、部分分支清理失败后的显式恢复。
- 文件、终端、浏览器出口、原生拖放、延迟截图和操作弹窗的机器及连接代次隔离。
- 配置更换时拒绝旧请求和事件；未保存文件及草稿进入只读恢复记录，不重放到新服务器。
- 保留旧单后端、浏览器访问服务器及独立远程窗口流程。新增文案仅中文/英文，其他语言使用英文回退。

## 最终结果

| 验证 | 结果 |
| --- | --- |
| 全量前端 Vitest | 596 个文件、8,647 项测试通过 |
| TypeScript、全仓 ESLint、Next.js 静态导出 | 全部通过 |
| 桌面 Rust 全量库测试 | 5,042 项通过，1 项既有忽略 |
| 服务器 Rust 全量库测试 | 4,813 项通过，1 项既有忽略 |
| 服务器入口测试 / worktree HTTP 集成测试 | 2 项 / 1 项通过 |
| 桌面与服务器 check / Clippy（`-D warnings`） | 全部通过 |
| Git 2.25 兼容及防注入回归 | 两种模式各 6 项通过，包括目录丢失且锁定的工作树 |
| Git 2.34、2.47 worktree 回归 | 两种模式、各版本均 71 项通过 |
| 更新后二进制的双服务器烟测 | 58 项通过，159 次 HTTP 请求 |
| 最终前端及 Rust 问题闭环复审 | 无未关闭 P1/P2 |

前端真实 Provider 测试挂载生产 ACP、workspace、tab、terminal 和路由组件，并故意使用两台机器上的相同资源编号。覆盖后台会话空闲保护、发送和审批归属、文件 watcher、上传及连接代次变化。拖放测试使用两个真实附件处理实例；截图测试验证旧代次的延迟结果不能修改新实例的编辑器或触发上传。

Rust 回归覆盖旧版 Git 的权威注册信息校验、锁定条目的状态保留、移除后注册消失再清理数据库，以及旧 401 与配置更新、新订阅和最终清理交错的确定性竞态。

双服务器烟测使用更新后的服务器二进制、独立临时令牌/数据库/HOME/Git 仓库和仅回环访问的端口。覆盖认证、相同编号及路径的资源隔离、worktree 创建/注册/保护/移除、文件读写、真实终端命令及终止隔离。两套临时服务器已停止并移除，记录已脱敏；未操作用户真实机器。

## 运行方式与环境

前端执行：

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm test
pnpm exec tsc --noEmit --incremental false
pnpm lint .
pnpm build
```

上述 `NODE_OPTIONS` 用于当前 Node.js 26 环境，使 Vitest 使用 jsdom 的 localStorage。

Rust 在具备原生开发依赖的 Docker 环境中验证：

```bash
cd src-tauri
cargo check
cargo clippy --all-targets --features test-utils -- -D warnings
cargo check --no-default-features --features server-bin --bin codeg-server
cargo clippy --no-default-features --features server-bin --bin codeg-server --lib -- -D warnings
cargo test --features test-utils --lib --no-run
cargo test --no-default-features --features server-bin,test-utils --lib --no-run
cargo test --no-default-features --features server-bin,test-utils --bin codeg-server --test multi_host_worktrees --no-run
cargo build --no-default-features --features server-bin --bin codeg-server
```

编译出的测试二进制在非 root、带 `--init` 的容器中全量执行，保留权限测试及子进程回收的真实语义。没有为环境问题修改或跳过产品测试。旧 Git 测试使用隔离的 Git 可执行文件及配置环境。

## 尚未验证的边界

- 未进行真实 Tauri 桌面 GUI 的双远端交互烟测，包括原生 webview 几何、弹窗复用和实际浏览器渲染；组件、代理和事件测试不等同于实机验收。
- 未执行 Linux 桌面 release 或安装包构建。本地检查环境的桌面 sidecar 占位文件只满足检查/测试，不能视为可分发安装包；预览发布流程另行编译并校验真实 sidecar。
- 双服务器烟测验证 HTTP/API 与真实进程，不代表已在桌面 GUI 中完成全部跨机器操作。

使用说明见 [在一个窗口使用多台机器](multi-host-worktrees.md)。
