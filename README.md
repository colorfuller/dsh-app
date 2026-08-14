# dsh-desktop

一键启动 DeepSeek Harness Web UI 的桌面应用。双击 `dsh-app.exe` 后：

1. Tauri 壳以隐藏方式拉起内置核心（pkg 内嵌 Node 运行时）；
2. 核心在进程内执行 `dsh web --host 127.0.0.1 --port 0`；
3. 等待 dsh 自己打印的端口就绪信号（端口由操作系统分配，不会冲突）；
4. 把应用窗口直接导航到本地 Web UI，不弹系统浏览器。

详细设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## 目录结构

```text
src/launcher.js             pkg 入口：进程内启动 dsh web + 就绪协议
src-tauri/                  Tauri v2 壳：隐藏子进程、splash、窗口内打开 Web UI
scripts/                    运行时组装 / pkg 编译 / 总构建
ui/index.html               状态窗口（零前端依赖）
docs/DESIGN.md              架构设计文档
```

## 快速开始

```powershell
# 安装根依赖（@deepseek-ai/dsh、pkg、Tauri CLI）
pnpm install

# 直接以 Node 验证核心逻辑（dev 模式会打开系统浏览器）
pnpm dev

# 生成应用图标（首次构建前执行一次）
pnpm icons

# 完整构建 Windows NSIS 安装包
pnpm build:nsi
```

构建产物位于 `src-tauri/target/release/`，安装包位于
`src-tauri/target/release/bundle/nsis/`。

## 构建前置条件

- Node.js 22+、pnpm、npm（`runtime:prepare` 会联网安装 dsh 生产依赖）；
- Rust stable（Tauri 2）；
- Windows：Visual Studio Build Tools/Community（MSVC C++ 工具链）与 WebView2 Runtime
  （Windows 10/11 通常已内置）；
- pkg 首次编译会下载对应平台的 Node 基础二进制，需要网络。

## 单独构建某一层

```powershell
pnpm runtime:prepare   # 生成 runtime/node_modules
pnpm npm-cli:prepare   # 生成 npm-cli/（运行时自动更新依赖的 npm CLI，构建缺失时自动补）
pnpm core:build        # 生成 dist-core/dsh-core.exe
pnpm build:nsi         # runtime + core + Tauri 全量构建
```

## 常用说明

- dsh 用户数据仍在 `~/.dsh`（可用 `DSH_HOME` 覆盖），API Key、会话与已有配置不变。
- 关闭应用窗口会同时停止 Web 服务；v1 不提供托盘常驻。
- v1 没有单实例锁，重复双击会再启动一个实例；这是已知限制。

## Runtime 自动更新

launcher 先以当前 runtime 立即启动，应用就绪后在后台检查 npm registry 上的
`@deepseek-ai/dsh` 最新版本；有新版本就后台安装到
`$DSH_HOME/runtime/<version>`（默认 `~/.dsh/runtime`），下次启动生效，**不阻塞
当前启动**。默认每 6 小时最多检查一次（`DSH_UPDATE_CHECK_INTERVAL_MINUTES` 可调，
`0` 表示每次启动都检查）。安装/网络失败不影响当前会话，下次启动仍回退到应用
自带 runtime。可用 `--no-update` 或环境变量 `DSH_NO_AUTO_UPDATE=1` 关闭，
registry 可用 `DSH_NPM_REGISTRY` 覆盖（默认 `https://registry.npmjs.org`）。
如果默认 `~/.dsh` 不可写（例如权限被锁定），会自动回退到应用数据目录
（`DSH_HOME` 仍可显式指定）。端到端验证：`pnpm smoke:update`。

## 日志

- 壳日志：`%APPDATA%\dev.dsh.desktop\logs\shell.log`（应用数据目录不可写时
  改用系统临时目录 `dsh-app-logs`），包含核心进程全部 stdout/stderr 与退出事件；
- 核心日志：`$DSH_HOME/logs/core.log`（`~/.dsh/logs/core.log` 或回退目录），
  包含 runtime 选择、更新状态与 dsh 子进程输出；
- 启动失败时错误窗口会直接显示最近 stderr 和日志文件路径。
