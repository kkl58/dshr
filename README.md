# dshr — an ACP-based terminal front-end for DeepSeek Harness

**Unofficial.** Not affiliated with, endorsed by, or supported by DeepSeek. It is built
**only from official components** — `dsh --profile acp` (the official ACP v1 server) plus the
official [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk).
No dsh source code is modified.

## Why this exists

DeepSeek Harness ships **no interactive terminal UI**. You get:

| Surface | What it is |
|---|---|
| `dsh web` / the desktop app | The shipped human interface (browser / Electron) |
| `dsh --profile headless "task"` | One unattended task, then exits — **not** an interactive TUI |
| `dsh --profile acp` / `sdk` | JSON-RPC stdio protocols, meant for machine clients |

The official TUI package was removed on 2026-08-04
([`remove-tui-package.md`](https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/.agents/notes/archived/simplification/2026-08-04-remove-tui-package.md)),
and that decision lists what re-entry would require: *a named product or deployment, an explicit
package boundary, a concrete interaction provider, and assembled lifecycle and transcript
acceptance*. Crucially it also records that the provider-neutral `command`, `user-questions`,
**`approval`**, `tool-presentation`, `PTY` and `session-projection` capabilities **remain
available to other hosts**.

This project exercises exactly those seams through ACP. It exists as a working data point that
the seam set is sufficient in practice — and as a usable terminal front-end today.

## What it gives you

- **One long-lived process.** No per-turn restart (compare `--profile headless` at ~2.3 s/turn).
- **Streamed rendering** of `agent_thought_chunk`, `agent_message_chunk`, `tool_call` and
  `tool_call_update`.
- **Interactive approval.** Escalation and sensitive-tool requests arrive as ACP
  `session/request_permission` and are answered from your terminal. `--profile headless` has no
  approver at all, so such requests fail closed with *"no approval channel is available"*.
- **Multi-turn continuity** inside one persisted session.

## Requirements

- DeepSeek Harness `dsh` on `PATH` (developed and tested against `0.1.7-rc.2`). The `acp`
  profile must exist.
- Node.js 20+ (uses the global `fetch` and `node:stream` web interop).

## Install

```bash
git clone <this repo> dshr && cd dshr
npm install          # only dependency: @agentclientprotocol/sdk
```

Then either run it directly:

```bash
node dsh-repl.mjs
```

…or wire up a launcher. On Windows, a `.bat` that forwards to the script is enough:

```bat
@echo off
node "<path-to-repo>\dsh-repl.mjs" %*
```

## Usage

```
dshr                      # start a session in the current directory
dshr --cwd D:\proj        # explicit workspace
dshr --mode read-only     # sandbox mode: read-only | workspace-write | danger-full-access
dshr --full-access        # shorthand for --mode danger-full-access
dshr --dsh <path>         # point at a specific dsh executable
dshr --debug              # raw ACP events + upstream stderr
```

In-session: `/exit`, `/help`, `/cwd`.

### Permission modes

dsh's sandbox mode is read from the `DSH_PERMISSION_MODE` environment variable, and this tool
simply sets it for the child process. The three official modes are `read-only`,
`workspace-write` (default) and `danger-full-access`.

> ### ⚠️ `--full-access` removes the filesystem sandbox
>
> `dshr --full-access` sets `DSH_PERMISSION_MODE=danger-full-access`, which means **the agent's
> commands are not restricted at all** — it can write or delete anything your user account can.
> It exists because on some Windows setups the sandbox cannot initialise at all (see below), in
> which case every command would otherwise require manual approval.
>
> Note the effective end state is the same as approving an escalation with `allow_once`; the
> difference is that you lose the per-command checkpoint. **Use it deliberately, not by default.**

## Windows note: the ACL sandbox and non-system volumes

On Windows the ACL sandbox requires the workspace directory to grant your account
**`WRITE_OWNER`** (the Low integrity label lives in the SACL). This is *not* the case on many
data volumes, where the default ACL is:

```
D:\  BUILTIN\Administrators:(F)
     NT AUTHORITY\SYSTEM:(F)
     Authenticated Users:(M)      <- Modify only; no WRITE_OWNER
     BUILTIN\Users:(RX)
     (no explicit ACE for the user)
```

Every shell call then fails with:

```
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>)
```

Win32 5 is `ERROR_ACCESS_DENIED`, and the backend is **fail-closed**, so commands do not run
rather than degrading. The identical command succeeds when the workspace is under
`C:\Users\<you>\…` (which carries an explicit `(F)` ACE).

This is a property of the machine, not of any front-end — it affects web, desktop and terminal
alike. Your options, in the order I'd rank them:

1. **Keep the workspace on a volume where the sandbox works** (e.g. under your user profile).
2. **`dshr --full-access`** — no ACL changes, no approvals, but no write sandbox either.
3. **Grant the workspace `WRITE_OWNER`** —
   `icacls "<dir>" /grant "%USERDOMAIN%\%USERNAME%:(OI)(CI)F"` — and be aware this is not free:
   once the sandbox runs there it applies a **standing Low integrity label** to that tree, which
   outlives dsh and relaxes it against other Low-integrity processes. See the official
   `dsh-sandbox-windows-acl` documentation before doing this to anything you care about.
4. **Approve each command** — leave the mode at the default and answer the prompt. This is
   effectively "always ask" mode.

## How it compares to other community front-ends

Several community TUIs exist for dsh (for example `dsh-tianshu-tui`, `turtle-ui`, and the
`@deepseek-harness-*` npm packages). They generally have more features than this one — command
palettes, model switchers, mode cycling.

This project deliberately aims at something narrower: **no third-party library sits between you
and the approval prompt.** A terminal front-end for a coding agent receives every escalation
request and answers it, so it holds a privileged position. Here, everything on that path is
either a shipped dsh component or the official ACP SDK; the only third-party runtime dependency
is the SDK itself (`zod` comes with it). That is the whole point of the project.

## Known limitations

- **No in-session mode switching.** ACP exposes no private methods by design, so the sandbox
  mode is chosen at startup only.
- **No Markdown rendering.** Streamed text is written as-is (ANSI colours for structure only).
- **No session picker.** Each run starts a fresh session; dsh's own session store still holds
  the history.
- **Windows launcher caveat:** in Git Bash the `.bat` shim must be invoked as `dshr.bat` —
  MSYS does not append `.bat` when resolving commands.
- Tested on Windows 11 with dsh `0.1.7-rc.2`. The ACP surface is stable v1, but dsh is a
  developer preview and may change.

## License

MIT — see [LICENSE](LICENSE).

---

# 中文说明

**非官方项目**，与 DeepSeek 无隶属关系、未获其背书。它**只使用官方组件**构建：
`dsh --profile acp`（官方 ACP v1 服务器）＋ 官方
[`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk)，
**未修改 dsh 任何一行代码**。

## 为什么要做这个

DeepSeek Harness **没有交互式终端界面**：官方的人类界面是 Web 与桌面端；`headless` 是
一次性任务入口（不是交互式 TUI）；`acp` / `sdk` 是给机器客户端的协议。官方 TUI 包已于
2026-08-04 移除，而那份移除决定同时写明：**`command`、`user-questions`、`approval`、
`tool-presentation`、`PTY`、`session-projection` 这些能力「仍可供其他宿主使用」**。

本项目正是通过 ACP 使用这些缝（seams）—— 既是一份「这套缝在实践中够用」的可运行证据，
也是现在就能用的终端前端。

## 它给你什么

- **常驻单进程**（对比 `headless` 每轮约 2.3 秒的重启）
- **逐条流式**渲染：思考 / 正文 / 工具调用 / 工具调用状态
- **交互式权限批准** —— 升权请求以 ACP `session/request_permission` 抵达，从终端作答。
  （`headless` 没有应答者，这类请求会以 *"no approval channel is available"* 直接失败）
- **多轮上下文连续性**（同一持久会话）

## 用法

```bash
node dsh-repl.mjs                 # 在当前目录开会话
node dsh-repl.mjs --cwd D:\proj   # 指定工作区
node dsh-repl.mjs --mode read-only
node dsh-repl.mjs --full-access   # = danger-full-access
node dsh-repl.mjs --debug         # 看原始 ACP 事件
```

会话内：`/exit`、`/help`、`/cwd`。要求 `dsh` 在 PATH 上、Node.js 20+。

> ### ⚠️ `--full-access` 会关闭文件系统沙箱
> 它设 `DSH_PERMISSION_MODE=danger-full-access`，**agent 的命令不再受任何文件系统限制**。
> 它与「用 `allow_once` 逐条批准升权」的**最终权限相同**，区别只是少掉了每条命令的确认卡点。
> **请有意使用，别当默认值。**

## ⚠️ Windows：ACL 沙箱与非系统盘

Windows 上 ACL 沙箱要求工作区目录对当前账号授予 **`WRITE_OWNER`**（Low 完整性标签位于 SACL），
而很多数据盘的默认 ACL 不具备这一点（`Authenticated Users:(M)` 只有 Modify）。此时每条 shell
命令都报 `SetNamedSecurityInfoW failed (Win32 5)`，且沙箱 **fail-closed** → 命令完全无法执行。
同一命令在 `C:\Users\<你>\…` 下则正常。

**这是机器的属性，不是任何前端的问题**（Web、桌面端、终端一视同仁）。四种应对：
把工作区放在沙箱可用的卷上 / 用 `--full-access` / 给目录加 `WRITE_OWNER`（**注意会留下常驻
Low 标签，先读官方 `dsh-sandbox-windows-acl` 文档**）/ 保持默认模式逐条批准。

## 与其他社区前端的区别

社区有不少功能更花哨的 TUI（命令面板、模型切换、模式循环等）。本项目刻意只做一件窄事：
**你和批准提示之间不夹任何第三方库**。终端前端会收到并回答每一次升权请求，位置敏感 ——
这条链路上的一切，要么是 dsh 自带组件，要么是官方 ACP SDK。

## 已知限制

- **不支持会话内切换模式**（ACP 按设计不暴露私有方法，只能在启动时选定）
- **不渲染 Markdown** / **没有会话选择器**
- Git Bash 里启动器要写全名 `dshr.bat`（MSYS 不自动补 `.bat`）
- 在 Windows 11 + dsh `0.1.7-rc.2` 上测试。dsh 是开发者预览版，协议可能变化

## 许可证

MIT
