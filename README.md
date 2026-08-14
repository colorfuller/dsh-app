<div align="center">

<img src="assets/icon.svg" width="96" alt="dsh-app logo" />

# DeepSeek Harness Desktop（dsh-app）

**双击即用的 DeepSeek Harness 桌面版 —— 免装 Node、不开浏览器、数据零迁移**

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 变成原生桌面应用：
下载 → 双击 → 开始使用，剩下的交给它。

[![Build](https://github.com/colorfuller/dsh-app/actions/workflows/build.yml/badge.svg)](https://github.com/colorfuller/dsh-app/actions/workflows/build.yml)
[![Version](https://img.shields.io/badge/version-0.1.1-3964FE)](https://github.com/colorfuller/dsh-app/releases)
[![Windows](https://img.shields.io/badge/Windows-NSIS-0078D6?logo=windows&logoColor=white)](https://github.com/colorfuller/dsh-app/releases)
[![macOS](https://img.shields.io/badge/macOS-DMG-000000?logo=apple)](https://github.com/colorfuller/dsh-app/releases)
[![Linux](https://img.shields.io/badge/Linux-deb%2FAppImage-FCC624?logo=linux&logoColor=black)](https://github.com/colorfuller/dsh-app/releases)

</div>

> **English TL;DR** — dsh-desktop is a one-click desktop launcher for the DeepSeek Harness Web UI. It bundles a Node runtime and `@deepseek-ai/dsh`, opens the UI inside a native Tauri window (no browser, no installs), reuses your existing `~/.dsh` data, and self-updates in the background with automatic rollback. Available on Windows, macOS, and Linux.

<!-- 建议在此放置一张应用截图 / 演示 GIF，传播效果会更好 -->

---

## ✨ 优势：为什么值得一试

- **双击即用，零环境依赖**：安装包里已内置 Node 运行时和 dsh 核心。不需要先装 Node.js、npm，也不需要打开终端敲命令。
- **原生桌面体验**：UI 直接渲染在独立应用窗口里（Tauri / WebView2），启动带 splash，不会淹没在一堆浏览器标签页中。
- **托盘常驻、单实例**：关闭窗口不会退出，服务继续在后台运行，随时可从系统托盘唤起；重复双击只唤醒已有实例，不会开第二个。
- **数据无缝继承**：API Key、会话、插件配置全部沿用你现有的 `~/.dsh`，装了就能用，零迁移成本。
- **默认安全**：服务只监听 `127.0.0.1`，端口由操作系统自动分配，不冲突、不暴露到局域网。
- **永不阻塞的自动更新**：启动后后台检查 npm registry 上的 dsh 新版本，下次打开自动生效；失败自动回退到应用自带版本，不影响当前会话。
- **跨平台、可复现**：Windows（NSIS）、macOS（DMG）、Linux（deb/AppImage），一条命令即可从源码完整构建。
- **轻量原生，不背 Chromium**：基于 Tauri 2（Rust）调用系统 WebView 渲染，而不是像 Electron 壳那样内置整套 Chromium——安装包更小、内存占用更低。
- **官方 UI 零魔改**：直接驱动官方 dsh Web UI，不打补丁、不改界面；上游升级不漂移，体验与官方完全一致。

## 🆚 和命令行版比，差别在哪

| 体验 | `npx @deepseek-ai/dsh web` | **dsh-app** |
| --- | --- | --- |
| 环境要求 | 需要 Node.js + npm | **免安装，自带运行时** |
| 启动方式 | 打开终端输命令 | **双击图标** |
| UI 载体 | 浏览器标签页 | **原生应用窗口** |
| 端口 | 手动管理，可能冲突 | **系统自动分配，零冲突** |
| 数据与配置 | `~/.dsh` | **完全一致，无需迁移** |
| 更新 | 手动升级 | **后台自动更新，失败自动回退** |

## 🆚 和同类桌面壳比，强在哪

社区里另外两个热门的 DeepSeek Harness 桌面封装（[dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop) 与 [anywhere-labs/deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)）都选择了 Electron 路线，而本项目用 Tauri 走了另一条路：

| 维度 | **dsh-app（本项目）** | dataelement/dsh-desktop | anywhere-labs/deepseek-harness-desktop |
| --- | --- | --- | --- |
| 技术栈 | **Tauri 2（Rust）· 系统 WebView** | Electron · 内置 Chromium | Electron · 内置 Chromium |
| 平台覆盖 | **Windows · macOS（ARM/Intel）· Linux** | macOS · Windows x64（Intel/Windows 运行时待验证，ARM 暂不支持） | macOS Apple Silicon · Windows x64（macOS Intel 计划中） |
| 官方 Web UI | **100% 原样，零魔改** | patch-package 定制 onboarding 与品牌 | 桌面界面适配 |
| CLI 数据兼容 | **直接复用 `~/.dsh`，零迁移** | 独立应用数据目录（Electron userData） | 未声明与 CLI 共用 |
| dsh 核心更新 | **后台直连 npm registry 更新，下次启动生效，失败自动回退** | 应用级自动更新尚未完全集成 | 未提供自动更新，需重新下载安装包 |
| 更新粒度 | **只更新核心，无需重装整个应用** | 应用整体更新 | 应用整体更新 |
| 托盘常驻 | **支持（关闭最小化到托盘）** | 未提及 | 支持 |

> 对比信息来自各仓库 README（2026-08 核对），上游项目仍在快速迭代，请以官方仓库为准。

## 🚀 一分钟上手

1. 在 [Releases](https://github.com/colorfuller/dsh-app/releases) 下载对应平台安装包：Windows 选 `.exe`，macOS 选 `.dmg`，Linux 选 `.deb` / `.AppImage`；
2. 安装后双击打开 dsh-app；
3. 首次启动会看到 splash，服务就绪后自动进入 Web UI。

无需任何配置：已经用过 dsh CLI 的话，原有数据原样可用；从零开始的话，按界面提示填好 API Key 即可。

## 🛠 从源码构建

### 前置条件

- Node.js 22+、pnpm、npm（`runtime:prepare` 会联网安装 dsh 生产依赖）；
- Rust stable（Tauri 2）；
- Windows：Visual Studio Build Tools/Community（MSVC C++ 工具链）与 WebView2 Runtime（Windows 10/11 通常已内置）；
- pkg 首次编译会下载对应平台的 Node 基础二进制，需要网络。

### 构建安装包

```powershell
# 安装根依赖
pnpm install

# 生成应用图标（首次构建前执行一次）
pnpm icons

# 完整构建 Windows NSIS 安装包
pnpm build:nsi
```

构建产物位于 `src-tauri/target/release/`，安装包位于 `src-tauri/target/release/bundle/nsis/`。

### 单独构建某一层

```powershell
pnpm runtime:prepare   # 生成 runtime/node_modules
pnpm npm-cli:prepare   # 生成 npm-cli/（运行时自动更新依赖的 npm CLI，构建缺失时自动补）
pnpm core:build        # 生成 dist-core/dsh-core.exe
pnpm build:nsi         # runtime + core + Tauri 全量构建
```

也可以直接以 Node 验证核心逻辑（dev 模式会打开系统浏览器）：

```powershell
pnpm dev
```

## ⚙️ 工作原理（30 秒读懂）

1. Tauri 壳以隐藏方式拉起内置核心（pkg 内嵌 Node 运行时）；
2. 核心在进程内执行 `dsh web --host 127.0.0.1 --port 0`；
3. 等待 dsh 自己打印的就绪信号（端口由操作系统分配，不会冲突）；
4. 应用窗口直接导航到本地 Web UI——不弹系统浏览器；关闭窗口会最小化到系统托盘，服务继续在后台运行，从托盘菜单“退出”才完全停止。

详细设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## 🧰 常用配置（可选）

| 变量 / 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | 用户数据目录，覆盖后 API Key 与会话随之迁移 |
| `DSH_NPM_REGISTRY` | `https://registry.npmjs.org` | 自动更新的 npm registry，可配镜像 |
| `DSH_UPDATE_CHECK_INTERVAL_MINUTES` | `360` | 更新检查间隔；`0` 表示每次启动都检查 |
| `DSH_NO_AUTO_UPDATE` / `--no-update` | 关闭 | 关闭后台自动更新 |

如果默认 `~/.dsh` 不可写（例如权限被锁定），会自动回退到应用数据目录；`DSH_HOME` 仍可显式指定。

## 🧩 相关生态

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：上游主项目，模型、工具、技能、会话、沙箱、存储、循环、调度、UI——一切皆插件
- [开发者文档](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)：快速上手与插件开发指南
- [社区插件](https://github.com/topics/dsh-plugin)：可自由替换、灵活重组的插件生态
- [Cordis 论文](https://github.com/cordiverse/paper)：Harness 背后的架构论文

## ⚠️ 已知限制（v1）

- 运行时热更新（不重启直接切换新版本）计划在 v2 实现。

## 🤝 贡献

欢迎提交 [Issue](https://github.com/colorfuller/dsh-app/issues) 与 PR。构建脚本全链路可复现，代码结构见 [docs/DESIGN.md](docs/DESIGN.md)。
