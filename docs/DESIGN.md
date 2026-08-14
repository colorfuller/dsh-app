# dsh-desktop 设计方案

## 1. 目标

用户双击 `dsh-app.exe`（或 macOS/Linux 上的应用）后，应用自动完成：

1. 启动随应用内置的 Node 运行时与 `@deepseek-ai/dsh`；
2. 执行 `dsh web`（浏览器 UI 服务）；
3. 等待本地 HTTP 端口真正就绪；
4. 在应用自身的 Tauri 窗口内直接打开 Web UI。

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│ dsh-app.exe (Tauri v2 shell, GUI subsystem, no console)     │
│                                                            │
│  ┌──────────────────┐   spawn (CREATE_NO_WINDOW)           │
│  │ WebView2 窗口     │ ──────────────────────────────┐      │
│  │  splash → 导航到  │                                ▼      │
│  │  127.0.0.1:<port> │   dsh-core-<triple>.exe (pkg: 内置 Node)│
│  └──────────────────┘   │                                │
│          ▲              │  src/launcher.js                │
│          │ eval(DOM)    │  ├─ 改写 process.argv           │
│          │              │  ├─ 拦截 console.log            │
│  ┌───────┴──────────┐   │  ├─ 动态 import dsh/lib/bin.js  │
│  │ Rust 后台线程     │◄──┤  │  └─ 输出 DSH_READY {...}     │
│  │ 读 stdout/stderr  │   │                                │
│  └──────────────────┘   └──────────────┬──────────────────┘
│          │ navigate(window)              │ 真实磁盘资源
│          ▼                              ▼
│   http://127.0.0.1:<os-assigned-port>   runtime/node_modules/@deepseek-ai/dsh
└────────────────────────────────────────────────────────────┘
```

## 3. 关键设计决策

### 3.1 就绪信号：消费 dsh 自己打印的 URL 行

实测 `dsh web --host 127.0.0.1 --port 0` 会在服务树结算、端口已绑定后打印：

```text
dsh web: http://127.0.0.1:65246
```

因此不做“固定端口盲轮询”：

- `--port 0` 让操作系统分配空闲端口，彻底避免端口冲突；
- 启动器改写 `console.log`，捕获这行 URL，再输出机器可读的
  `DSH_READY {"url":"http://127.0.0.1:65246","host":"127.0.0.1","port":65246}`；
- Tauri 壳解析 `DSH_READY` 后把当前 WebView2 窗口导航到该 URL。

`--host` 固定为 `127.0.0.1`：dsh 明确拒绝 `0.0.0.0`（会暴露远程执行能力），
桌面启动器也不应放宽这个边界。

### 3.2 为什么 dsh 不整体打进 pkg 单文件

`@deepseek-ai/dsh` 的 boot 过程依赖真实磁盘布局：

- 按包名通过 `createRequire(anchor).resolve.paths(packageName)` 解析 bundle；
- 在 `$DSH_HOME/profiles/node_modules` 为依赖闭包建立 junction；
- Cordis Loader 按 profile 中的包名动态加载插件层。

pkg 的只读快照文件系统无法满足这种运行时 Node 解析。所以：

- **pkg 只内嵌 Node 22 运行时与我们的启动器代码**，这部分没有快照外的动态解析需求；
- **`@deepseek-ai/dsh` 以 `runtime/` 目录随应用资源分发**，启动器从磁盘动态 `import()`
  它的 `lib/bin.js`，其依赖由相邻的真实 `node_modules` 解析。

这是“单文件 exe”与“dsh 可正常运行”之间的必要权衡。若某平台需要严格单文件，
可在首次运行把资源解压到应用数据目录；v1 不实现，保持可维护性优先。

### 3.3 进程内启动，而不是二次 spawn

启动器把 `process.argv` 改写为 `[process.execPath, dshBin, "web", ...]` 后直接
`await import(pathToFileURL(dshBin))`。dsh 的 ESM 顶层 `await runProfile(...)` 会在
服务树结算后 resolve，因此：

- `import` 成功返回本身就是一个“启动完成”信号；
- dsh 自己安装的 `SIGINT/SIGTERM`、shutdown 逻辑保持原样；
- 不经过第二个 pkg 子进程，避免 pkg 对子脚本路径的额外限制。

### 3.4 Tauri 壳负责“无控制台”和窗口内打开 Web UI

pkg 产物在 Windows 上是控制台子系统程序，直接双击会挂一个黑窗口。Tauri 壳：

- 用 `CREATE_NO_WINDOW` 隐藏启动 sidecar；
- 后台线程逐行读子进程 stdout/stderr；
- 先显示内置 splash 页，收到 `DSH_READY` 后把同一个 WebView2 窗口导航到
  `http://127.0.0.1:<port>`，因此 Web UI 直接出现在应用窗口内，不弹系统浏览器；
- 关闭窗口时隐藏到系统托盘并保持服务运行，从托盘菜单“退出”时才终止 sidecar；
- 注册单实例锁，重复双击只会唤醒已有实例并聚焦主窗口。

系统托盘与单实例现已实现：关闭窗口最小化到托盘、服务后台常驻；重复双击只唤醒已有实例。

## 4. 仓库布局

```text
dsh-app/
  docs/DESIGN.md              # 本文档
  src/launcher.js             # pkg 入口：进程内启动 dsh web
  scripts/
    prepare-runtime.mjs       # 生成 runtime/（npm 生产依赖安装）
    prepare-npm-cli.mjs       # 生成 npm-cli/（运行时更新用的 npm CLI）
    build-core.mjs            # pkg 编译 dsh-core.exe
    build.mjs                 # 总编排：runtime → core → tauri build
    smoke-update.mjs          # 假 registry 端到端验证 npm 直下更新
  runtime/                    # 生成物（gitignore）：dsh 完整生产依赖
  npm-cli/                    # 生成物（gitignore）：内嵌 npm CLI 资源
  dist-core/                  # 生成物（gitignore）：pkg 核心 exe
  src-tauri/                  # Tauri v2 壳
    src/main.rs
    src/lib.rs
    build.rs
    Cargo.toml
    tauri.conf.json
    capabilities/default.json
    icons/                    # tauri icon 生成
    binaries/                 # 构建时放入 dsh-core-<triple>.exe
    target/                   # 构建产物；runtime/ 与 npm-cli/ 资源复制到这里
  ui/index.html               # splash/错误状态页（零依赖）
  assets/icon.svg             # 应用图标源文件
```

## 5. 构建流水线

```text
pnpm runtime:prepare   npm install --omit=dev --ignore-scripts → runtime/
pnpm npm-cli:prepare   复制 node_modules/npm → npm-cli/（构建缺失时自动补）
pnpm core:build        pkg src/launcher.js → dist-core/dsh-core.exe
pnpm app:build         复制 sidecar+runtime → tauri build → 安装包
```

Windows sidecar 命名遵循 Tauri 约定：`dsh-core-x86_64-pc-windows-msvc.exe`。

## 6. 错误与生命周期

- 启动器把异常以 `DSH_ERROR {"message":...}` 写到 stderr；Tauri 壳显示错误详情。
- 壳侧设置 90 秒无活动超时（更新安装期间 launcher 每 30 秒发心跳），超时终止
  sidecar 并提示。
- 应用窗口关闭 = 隐藏到系统托盘，服务继续运行；从托盘菜单“退出”才停止服务并退出应用。
- `DSH_HOME` 透传给子进程，用户已有配置、会话与 API 密钥保持兼容。
- 默认 `~/.dsh` 不可写时（ACL 锁定、只读账户等），launcher 自动回退到
  应用数据目录 `dsh-home/`，再回退到系统临时目录，并通过
  `DSH_STATUS {"state":"home-fallback"}` 提示；`DSH_HOME` 显式指定时始终优先。
- 日志：壳把核心 stdout/stderr 与退出事件写入应用数据目录
  `logs/shell.log`；launcher 把 runtime 选择、更新状态与子进程输出写入
  `$DSH_HOME/logs/core.log`（8MB 轮转）。错误/退出状态会附带最近 stderr
  与日志路径，方便直接定位问题。

## 7. Runtime 自动更新（npm 直下）

v1 采用“后台检查、下次启动生效”，不阻塞启动：launcher 先以当前 runtime 立即
启动 dsh，`DSH_READY` 后在后台查询 npm registry 的 `@deepseek-ai/dsh` 最新版；
有新版本就后台把新 runtime 装到用户目录并写入 `current` 指针，下次启动使用新
版本；安装失败静默回退应用自带的 bundled runtime。整个更新不替换壳、不要求
用户装 Node/npm。

### 7.1 更新目录与安装器

- 更新源：npm registry（默认 `https://registry.npmjs.org`，可用
  `DSH_NPM_REGISTRY` 或 `npm_config_registry` 覆盖，便于配镜像）；
- 安装位置：`$DSH_HOME/runtime/<version>/`（`DSH_HOME` 默认 `~/.dsh`）。
  Program Files 下的 bundled `runtime/` 只读，不能原地更新；用户目录天然可写，
  且每个版本独立目录，天然支持回退；
- 安装器：npm CLI 作为 Tauri resource（`npm-cli/`，构建期由
  `scripts/prepare-npm-cli.mjs` 从 `node_modules/npm` 复制）随应用分发。
  launcher 用内嵌 Node 的 plain-node 模式（`PKG_EXECPATH=PKG_INVOKE_NODEJS`）
  执行：

  ```text
  npm install --omit=dev --ignore-scripts --no-audit --no-fund
              --no-progress --no-package-lock
  ```

  参数与构建期 `prepare-runtime.mjs` 一致，临时目录安装完成后原子 rename；
- 校验：npm 安装过程按 `dist.integrity` 校验每个 tarball；装完 launcher 再
  检查 `package.json` 版本与 `dsh --version` 输出。
- 节流：默认每 6 小时最多检查一次（`$DSH_HOME/runtime/.last-update-check`
  时间戳），`DSH_UPDATE_CHECK_INTERVAL_MINUTES=0` 可改为每次启动都检查；
  断网时也会写入时间戳，避免离线环境每次启动都等 20 秒 registry 超时。

### 7.2 版本选择、指针与回退

- 选择顺序：`DSH_RUNTIME_DIR` 显式指定 > `$DSH_HOME/runtime/current` 指针
  > `$DSH_HOME/runtime/` 下最高可用版本 > bundled `runtime/`；
- `runtime/current` 是 last-known-good 指针：后台安装并校验成功后写入，下次
  启动优先使用；
- 启动失败（`DSH_READY` 前子进程退出）会在该版本目录写 `.failed`，下次启动
  跳过它并回退到上一版或 bundled；
- 每次成功后清理旧版本，保留当前版 + 上一版两个目录。

### 7.3 状态协议与超时

- launcher 新增 `DSH_STATUS {json}` 行：`checking-update` / `updating` /
  `update-installed` / `update-failed`，Rust 壳渲染到 splash 页；窗口已导航到
  Web UI 后这些状态主要记录在日志里（v2 可在应用内做“新版本已就绪”提示）；
- 壳侧超时从“90 秒启动超时”改为“90 秒无活动输出”：任何 stdout/stderr 行都会
  刷新活动时间；npm 安装期间 launcher 每 30 秒发一次心跳，避免下载大依赖闭包
  时被误杀；
- 安装/校验/网络失败均不阻塞启动：提示 `update-failed` 后用现有版本正常启动。

### 7.4 运行期热更（v2，未实现）

真正替换“正在运行”的 dsh 需要重启服务：安装新版本后终止当前 dsh 子进程，
用新的 `$DSH_HOME/runtime/<version>` 重新 spawn，收到新 `DSH_READY` 后窗口
重新导航。进程内会话会中断（`~/.dsh` 里的会话文件不受影响），因此 v1 选择在
启动时更新，用户下次打开应用即为新版本。
