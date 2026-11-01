# dsh-bash-watchdog

一个 Host-only 的 DeepSeek Harness 插件：**在 Harness 开始执行 pnpm 装卸/更新操作之前，自动关掉 win-bash 留下的常驻 `bash.exe`。**

它的清理逻辑不经过 `pwsh` 工具，也不依赖会话里有哪个 shell：Host 直接 `execFile` 一个 Windows PowerShell 子进程去 `Get-Process` + `Stop-Process`。所以即使 win-bash 按默认 `replacePwsh: true` 把 `pwsh` 从工具面里顶掉，**插件管理器/插件市场的 pnpm 操作仍然会被保护**。

它解决的是这个具体故障链：

```
@linxin666/dsh-win-bash 每个会话常驻一个 bash.exe
        ↓
这个 bash.exe 的可执行文件就在它自己的包目录里
        ↓
pnpm 更新/卸载时要“删掉旧目录 → rename 新目录进来”
        ↓
Windows 不允许替换正在执行的映像
        ↓
ERR_PNPM_EPERM ... rename '..._tmp_<pid>_<n>' -> 'dsh-win-bash'
        ↓
插件目录只替换了一半，插件损坏，甚至要重启才能恢复
```

看门狗把“等 pnpm 失败之后再来收拾”改成“**在 pnpm 到达 rename 之前先杀 shell**”。

## 触发时机

四条触发路径，外加一条持久 shell 守卫，覆盖 Harness 内所有会真正跑 pnpm 的入口：

| 触发源 | 具体信号 | 为什么够早 |
| --- | --- | --- |
| 官方插件管理器（事件） | `plugin-manager/install-state` 的 `installing`、`plugin-manager/install-log` 的第一条 pnpm 输出 | `installing` 在询问 registry 时就会发出，早于 pnpm 启动 |
| 官方插件管理器（文件） | `<profile>/.plugin-manager/logs/operation-*` 新目录（`fs.watch` 即时 + 300 ms 轮询兜底） | 管理器在 spawn pnpm **之前** `mkdir` 这个目录并写 `pnpm.log` |
| 插件市场（dshmarket） | `<profile>/.dsh-market/log.ndjson` 新增 `install` / `update-start` / `uninstall-start` 等记录（`fs.watch` 即时） | 市场在动 pnpm 前先写意图记录 |
| Agent 自己执行 | `pwsh` 等一次性 shell 工具调用，命令里含 `pnpm install/update/add/remove/...` 或 `dsh plugin ...` | 在工具派发前先杀，pnpm 启动时锁已经释放 |
| 持久 shell 守卫 | `win_bash` 里的 pnpm 命令如果指向 DSH profile，直接 **deny** 并给出替代方案 | 这种命令跑在它自己的锁上，杀 shell 只会腰斩命令；拒绝比让它把插件树写坏更安全 |

每次触发会打开一个“活动窗口”，窗口内每 2 秒复查一次：pnpm 解包期间别的会话又起了新 bash，也会被清掉。官方管理器发出 `plugin-manager/changed`（操作结束）、市场日志出现 `exit=`/`update`/`uninstall` 完成记录、或对应的 shell 工具调用结束（`tools/post-execute`）时，窗口提前收窄。

操作目录与市场日志各挂一个 `fs.watch` 即时通知，所以官方管理器写出 `operation-*` 后 **1 ms 内**就会开始清理（实测激活延迟 <1 ms），单次清理约 300 ms（Windows PowerShell 5.1 + `Stop-Process`）。300 ms 的轮询只是 watcher 起不来时的兜底。实测数据：

| 真实 pnpm 操作 | pnpm 运行时长 | 从 operation 目录出现到 bash 被杀 | 结果 |
| --- | --- | --- | --- |
| 安装 | 1.28 s | 0.31 s | 早于 pnpm 结束约 1.0 s |
| 卸载 | 0.54 s | 0.30 s | 早于 pnpm 结束约 0.24 s |

也就是说，即便是一次 0.5 秒的快速卸载，bash 也会在 pnpm 执行最后的删除/替换之前消失。

## 只杀该杀的

不是 `taskkill /IM bash.exe`。看门狗逐个检查 `bash.exe` 的可执行文件路径，**只杀路径中包含 `dsh-win-bash` 的进程**（可用 `bashPathPatterns` 改成别的子串）。系统里 Git for Windows 的 bash、其它工具自带的 bash 不会被误杀。

杀的时候优先用 `Stop-Process -Force`（约 300 ms 内完成）；如果它被拒绝，则退回 `taskkill /T /F`，连带该 shell 启动的子进程一起结束。

## 两个 bash 扩展的兼容性

Windows 上有两条独立的 bash 线，看门狗对两者的处理是不同的：

| 扩展 | 包 / 工具名 | 本机状态 | bash 进程从哪来 |
| --- | --- | --- | --- |
| 官方一次性 bash | `@deepseek-ai/dsh-tool-bash` / `bash` | base 层在 win32 上 `disabled`，本机 `inactive`；win32 的官方 shell 是 `pwsh` | `dsh-bash-local` 用 `argv: ['bash','-c',command]` 从 PATH 解析；本机解析到 `C:\Windows\System32\bash.exe` |
| 官方持久 bash | `@deepseek-ai/dsh-tool-bash-persistent` / `bash` | 本 profile **未挂载**（可选 terminal bundle 未选中） | `ctx.terminals` + `dsh-terminal-bash` 的 `shellPath`（默认 `/bin/bash`） |
| linxin666 win-bash | `@linxin666/dsh-win-bash` / `win_bash` | 已安装并启用；本机配置 `replacePwsh: false` | 包内 `runtime\win32-x64\usr\bin\bash.exe`，每个会话常驻 |

结论：**可以同时兼容，互不误伤。**

- win-bash 的常驻进程路径含 `dsh-win-bash` → 被看门狗清掉。
- 官方 bash 从 PATH 解析（本机是 `C:\Windows\System32\bash.exe`）或由 `terminal-bash` 的 `shellPath` 指定，路径不含 `dsh-win-bash` → **永远不会被误杀**；一次性 bash 还是跑完即退，本来就不会锁包。
- 官方 bash 的工具名就是 `bash`，已包含在默认 `shellToolNames` 里：如果它被挂上并执行 pnpm 变更，看门狗会先清 win-bash shell，再放行官方 bash——对官方 bash 是增益，不会拦截或改写它的调用。
- 在 POSIX 上本插件直接 inert（Windows-only），完全不参与官方 bash 的任何路径。
- 唯一例外：如果有人把官方持久 bash 的 `shellPath` **手动指向** win-bash 包里的 `bash.exe`，那它就是一个 win-bash 可执行文件，会按 win-bash 进程处理（被杀）。默认配置不会出现这种情况。

实测：同时起两个模拟进程（`...\.test\dsh-win-bash\bash.exe` 和 `...\.test\official-bash\bash.exe`），触发一次含 `pnpm install` 的 shell 调用后，**前者被杀、后者存活**，日志只记录前者的 PID；单测里也覆盖了 `bash` 工具名的拦截路径。

## 默认 `replacePwsh: true` 时到底会发生什么

先说结论：**杀进程本身不受影响，受影响的是“在 win_bash 里直接跑 pnpm”这条路径。**

`@linxin666/dsh-win-bash` 的 `replacePwsh` 默认是 `true`。开启时它做的是：

```js
scope.ctx.tools.restrict({ deny: ['pwsh'] })
```

也就是**把 `pwsh` 从该会话的工具面里隐藏**，仅此而已。它不会禁用 `powershell.exe`，不会影响 Host 的 `execFile`，也不会影响 `plugin-manager/*` 事件或 `fs.watch`。所以：

| 场景 | `replacePwsh: true` 时 |
| --- | --- |
| 插件管理器 / 插件市场装、卸、更新 | **照常被保护**：Host 侧触发 + Host 侧 `execFile` 杀进程，全程不需要 `pwsh` 工具 |
| Agent 用 `pwsh` 跑 pnpm | 不会发生：`pwsh` 不可见 |
| Agent 用 `win_bash` 跑**项目** pnpm（非 DSH profile） | 放行：不会碰 win-bash 的包目录 |
| Agent 用 `win_bash` 跑**指向 DSH profile** 的 pnpm（`dsh plugin ...`、`cd <profile> && pnpm update`、`workdir=<profile>`） | **拒绝**：这种命令由 win-bash 自己的 `bash.exe` 执行，而它正是 pnpm 要替换的文件；杀 shell 等于腰斩命令，不杀则 pnpm 必然 EPERM。插件返回明确原因并指向插件管理器/市场，或建议设 `replacePwsh: false` 后用 `pwsh` |

为什么不能在 `win_bash` 里“先杀 shell 再跑 pnpm”：`tools/pre-execute` 杀的是**旧的** shell，`win_bash` 随后会为这条命令**新起一个 bash**，新 bash 仍在同一个包目录里，pnpm 替换时照样锁。这是进程模型决定的，不是触发时机的问题。

> **改完 `replacePwsh: false` 后建议重启一次 DSH。** win-bash 的 `restrict({ deny: ['pwsh'] })` 是按会话作用域安装的；热改配置不保证正在运行的会话能把已经下发的限制收回去。重启后 `pwsh` 才会稳定地回到工具面。拒绝信息里也会带上这句提示。

因此发布版的行为是：

- **默认配置下插件管理器/市场路径完整可用**（这是绝大多数装/卸入口）。
- 想保留 Agent 直接跑 `pnpm update` 的能力，就配 `@linxin666/dsh-win-bash` → `config.replacePwsh: false`，让 `pwsh` 与 `win_bash` 并存，**并重启一次 DSH 让 `pwsh` 回来**；这也是本机当前的选择。
- 不配也可以：指向 profile 的 win_bash pnpm 命令会被明确拒绝，而不是静默写坏插件树。

## 安装

在本机工作区目录执行（`plugin_manager` 的 `target` 传绝对路径）：

```json
{ "action": "install_bundle", "target": "C:\\Users\\daeda\\Documents\\Programming\\dsh-bash-watchdog" }
```

安装成功后它是纯 Host 插件，无 UI、无网页资源、无 npm 依赖（只用 `node:` 内置模块），打开即生效，无需重启。

> 按绝对目录安装时 pnpm 用 `link:` 指向这个 checkout，不会复制文件。**移动或删除这个目录会让 profile 里的条目失效**；要挪位置就重新 `install_bundle` 一次。需要长期分发时打 tarball 或发布到 registry 再装。

## 配置

配置写在 profile 的 `cordis.patch.yml` 对应行里；所有键都可省略：

```yaml
- id: dsh-bash-watchdog
  name: dsh-bash-watchdog
  config:
    # 只杀路径里包含这些子串的 bash.exe
    bashPathPatterns: ['dsh-win-bash']
    # 一次操作触发后持续复查多久、隔多久复查
    activeWindowMs: 120000
    sweepIntervalMs: 2000
    # 一次 shell 工具调用最多把窗口撑多久（调用结束由 tools/post-execute 提前收窄）
    toolWindowMs: 120000
    # 文件/事件轮询间隔
    watcherIntervalMs: 300
    # 两次杀进程之间至少隔多久（跨触发）
    minSweepGapMs: 600
    # Host 激活本插件时先杀一次（清掉上一个 app 实例留下的孤儿 shell）
    sweepOnStartup: false
    # 四类触发器的开关
    watchPluginManagerLogs: true
    watchMarketLog: true
    interceptShellTools: true
    # 哪些工具调用算“一次性 shell 命令”
    shellToolNames: ['pwsh', 'bash', 'shell', 'terminal', 'run_command']
    # 哪些工具是持久 shell（不能靠杀它来保护命令）
    persistentShellToolNames: ['win_bash']
    # 是否拒绝持久 shell 里“指向 DSH profile”的 pnpm 命令
    denyProfilePnpmInPersistentShell: true
    # 自定义 pnpm 变更命令的识别正则（i 标志）；默认见 index.js 的 DEFAULTS
    # pnpmMutationPattern: '\bpnpm\b[^\r\n;&|]{0,160}?\binstall\b'
    # 日志大小上限
    maxLogBytes: 1048576
    # 覆盖 profile / 日志 / PowerShell 路径（一般不用）
    profileDir: null
    logPath: null
    powershellPath: null
```

`win_bash` 不在默认的 `shellToolNames` 里，而在 `persistentShellToolNames` 里：如果命令本身就跑在 win-bash 里，杀 shell 等于腰斩这条命令，而且它自己会立刻重新起一个 bash，帮不上忙。指向 profile 的 pnpm 变更会被拒绝；项目内的 pnpm 不受影响。**要让 Agent 直接跑 profile pnpm，请设 `replacePwsh: false`、重启一次 DSH 让 `pwsh` 回来，再用 `pwsh` 执行。**

## 日志

默认 `<DSH_HOME>/logs/dsh-bash-watchdog.log`（本机是 `C:\Users\daeda\.dsh\logs\dsh-bash-watchdog.log`），JSON Lines：

```json
{"event":"activate","trigger":"plugin-manager-operation:operation-abc123","at":"2026-11-01T12:00:00.000Z"}
{"event":"killed","trigger":"plugin-manager-operation:operation-abc123","at":"...","killed":[{"pid":46988,"path":"...\\@linxin666\\dsh-win-bash\\runtime\\win32-x64\\usr\\bin\\bash.exe"}],"failed":[]}
```

没有可杀的 bash 时只记 `activate`，不记空 `killed`，避免刷屏。日志超过 `maxLogBytes` 会轮转为 `.log.1`。

## 明确的边界

- **只覆盖 Harness 自己发起的 pnpm 操作。** 官方插件管理器、插件市场、`dsh plugin` CLI（会写 `operation-*`），以及 Agent 通过 `pwsh` 跑的命令都在范围内；在系统终端里直接敲一个裸 `pnpm update` 且不经过上述入口时，没有触发信号，看门狗不会动作。
- **持久 shell 里的 profile pnpm 是被拒绝，不是被保护。** 这条命令的锁就是它自己的 shell，没有任何外部杀进程方式能让它安全完成；拒绝是唯一不损坏插件树的选择。项目目录里的 pnpm 不受影响。
- **只处理 win-bash 这类“可执行文件在包目录里”的锁。** 被 DSH 进程自己加载的 `.node`（如 `lightningcss`、`@img/sharp-win32-x64`）杀不掉——杀了等于杀 DSH；这类包只有重启 DSH 后再让 pnpm 替换才安全。
- **活动窗口内会腰斩正在跑的 win-bash 命令**，包括它在跑的构建/测试。这是为了保住 pnpm 替换；窗口在操作结束时提前关闭。
- win-bash 被停用或从未产生 shell 时，本插件会正常加载但基本无事可做；等它重新启用、会话再次产生 `bash.exe` 时自动开始工作。
- 本插件不尝试修改 win-bash 包目录，也不尝试 patch 第三方市场代码。

## 测试

```powershell
node --test test/*.test.mjs
```

单元测试覆盖四类触发器、窗口复查、持久 shell 守卫与命令识别（当前 18 个）。交付时还做了真实端到端验证：

- 用复制成 `bash.exe` 的 `ping.exe` 模拟 win-bash shell（可执行文件路径含 `dsh-win-bash`）；
- 通过 `plugin_manager` 真实执行一次 pnpm 安装（1.28 s）和一次卸载（0.54 s），两次都在 pnpm 结束前杀掉了模拟 shell；
- 用**真实 win-bash 的** `runtime\win32-x64\usr\bin\bash.exe`（不是模拟进程）验证：只新建一个 `operation-*` 目录（不跑任何 pnpm），Host 的 `fs.watch` 在 295 ms 内就把它杀掉；
- 在 `win_bash` 里执行 `cd <profile> && pnpm update` 被 live 拒绝并返回替代方案；`echo 'pnpm install'` 这类项目命令正常放行；
- 另用路径**不含** `dsh-win-bash` 的 `bash.exe` 验证：同样的扫描不会误杀。
