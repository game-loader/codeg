# Fork 预览版发布

`Preview Release` 工作流面向 `game-loader/codeg`，独立于上游的正式版发布流程。它不需要 Apple 开发者证书、公证凭据、Tauri 更新签名密钥或 Docker Hub 账号。

## 触发与下载

- 推送到 `feat/academic-zotero` 或 `main` 会触发构建；不通过 Pull Request 发布。
- 工作流也声明了 `workflow_dispatch`。GitHub 的手动运行入口要求工作流存在于默认分支；届时可以在 Actions 中选择分支并点击 **Run workflow**。
- 所有构建成功后，在当前仓库创建独立的预览版 Release，标签为 `preview-<run_id>-<run_attempt>`，记录对应提交和构建链接。它不会移动旧标签或替换正式版的 `latest`。
- 从 [Releases](https://github.com/game-loader/codeg/releases) 下载。构建失败时不会公开不完整的 Release，可以在 Actions 日志中查看失败步骤。

## 安装包

| 文件 | 用途 |
| --- | --- |
| `codeg-desktop-darwin-arm64.dmg` | Apple Silicon Mac 桌面客户端 |
| `codeg-desktop-darwin-x64.dmg` | Intel Mac 桌面客户端 |
| `codeg-desktop-linux-x64.deb` | Linux x64 桌面客户端，Ubuntu 22.04 或兼容系统 |
| `codeg-desktop-linux-arm64.deb` | Linux ARM64 桌面客户端，Ubuntu 24.04 或兼容系统 |
| `codeg-server-linux-x64.tar.gz` | Linux x64 Server、MCP 伴生程序及网页资源 |
| `codeg-server-linux-arm64.tar.gz` | Linux ARM64 Server、MCP 伴生程序及网页资源 |
| `codeg-web.tar.gz` | 单独的网页静态资源，解压后为 `web/` |
| `codeg-academic-bridge-*.xpi` | Zotero 10 插件 |
| `SHA256SUMS` | 所有安装包的 SHA-256 校验值 |

Linux Server 与对应桌面包使用相同架构和构建系统版本；更旧系统需要自行编译。工作流同时打包真正的 `codeg-mcp`，不会使用本地开发时可能生成的零字节占位文件。

## macOS 签名说明

桌面签名用于识别安装包发布者，Apple 公证用于 Apple 的分发检查；两者与 iOS 应用无关。本工作流的 macOS 包没有 Developer ID 签名或 Apple 公证，可以采用本机临时签名（ad-hoc），无需申请证书。

下载后将应用拖入 Applications。首次打开若被 macOS 阻止，在确认下载来源后，通过「系统设置 → 隐私与安全性 → 仍要打开」允许这一个应用。无需关闭整个系统的 Gatekeeper。

## 部署服务器和网页

解压与服务器架构对应的包，保留 `codeg-server`、`codeg-mcp` 和 `web/` 的相对位置。配置 `CODEG_STATIC_DIR` 指向这个 `web/`，`CODEG_DATA_DIR` 指向现有持久化数据目录，并沿用现有 Codeg 访问令牌。停止旧进程后切换程序和网页资源，再启动服务器。

单独的网页压缩包不能代替 Codeg Server。远端工作区的界面由桌面客户端内置，因此使用学术功能需要同步更新客户端和服务器。Zotero 插件的安装及配对参见 [学术工作区说明](academic-zotero.md)。

预览包用于手动安装和替换更新，不生成签名更新清单。应用中原有更新入口仍面向上游正式版本；不要用它更新这套预览版，否则可能覆盖学术功能。后续预览版从本 fork 的 Releases 下载，工作流不修改或绕过应用的更新签名校验。
