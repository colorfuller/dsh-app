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
- 窗口关闭时终止 sidecar 并退出，避免无头残留进程。

v1 暂不实现系统托盘与单实例锁；重复双击会启动第二个实例，属于已知限制。

## 4. 仓库布局

```text
dsh-app/
  docs/DESIGN.md              # 本文档
  src/launcher.js             # pkg 入口：进程内启动 dsh web
  scripts/
    prepare-runtime.mjs       # 生成 runtime/（npm 生产依赖安装）
    build-core.mjs            # pkg 编译 dsh-core.exe
    build.mjs                 # 总编排：runtime → core → tauri build
  runtime/                    # 生成物（gitignore）：dsh 完整生产依赖
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
    runtime/                  # 开发模式使用的 runtime 副本
  ui/index.html               # splash/错误状态页（零依赖）
  assets/icon.svg             # 应用图标源文件
```

## 5. 构建流水线

```text
pnpm runtime:prepare   npm install --omit=dev --ignore-scripts → runtime/
pnpm core:build        pkg src/launcher.js → dist-core/dsh-core.exe
pnpm app:build         复制 sidecar+runtime → tauri build → 安装包
```

Windows sidecar 命名遵循 Tauri 约定：`dsh-core-x86_64-pc-windows-msvc.exe`。

## 6. 错误与生命周期

- 启动器把异常以 `DSH_ERROR {"message":...}` 写到 stderr；Tauri 壳显示错误详情。
- 壳侧设置 90 秒启动超时，超时终止 sidecar 并提示。
- 应用窗口关闭 = 停止服务并退出；后续可加托盘常驻。
- `DSH_HOME` 透传给子进程，用户已有配置、会话与 API 密钥保持兼容。
