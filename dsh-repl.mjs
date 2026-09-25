#!/usr/bin/env node
/**
 * dsh-repl —— DeepSeek Harness 的交互式终端
 *
 * 只用官方组件：
 *   - `dsh --profile acp`  ← 官方 ACP (Agent Client Protocol) v1 服务器
 *   - @agentclientprotocol/sdk ← 官方 ACP 客户端 SDK
 *
 * 与 `dsh --profile headless` 的区别：常驻一个进程，多轮对话不重启，
 * 并且带「权限批准」通道（沙箱升权、危险操作都能交互批准）。
 *
 * 用法：
 *   node dsh-repl.mjs [--cwd <目录>] [--dsh <dsh可执行文件>] [--debug]
 */

import { client, ndJsonStream, methods } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

/* ------------------------------ 参数 ------------------------------ */

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const CWD = resolve(opt("--cwd", process.cwd()));
const DSH_BIN = opt("--dsh", "dsh");
const DEBUG = argv.includes("--debug");

// 沙箱模式：dsh 从 DSH_PERMISSION_MODE 读取（默认 workspace-write）。
//   read-only | workspace-write | danger-full-access
// D 盘目录缺 WRITE_OWNER，workspace-write 会起不来（Win32 5）→ 每条命令都要批准。
// --full-access 直接关掉沙箱介入：不改 ACL、不打 Low 标签、免批准。
const MODE =
  opt("--mode", null) ??
  (argv.includes("--full-access") ? "danger-full-access" : null);

/* ------------------------------ 颜色 ------------------------------ */

const C = {
  dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m",
  red: "\x1b[31m", gray: "\x1b[90m", magenta: "\x1b[35m",
};
const out = (s = "") => process.stdout.write(s + "\n");

/* ------------------------------ 终端输入 ------------------------------ */

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: process.stdin.isTTY === true,
});

// 行队列：readline 会立刻消费输入（管道喂进来的行也一并吞掉），
// 所以不能直接 rl.question()，必须先把行缓冲起来，需要时再取。
const lineQueue = [];
const waiters = [];
let inputClosed = false;

rl.on("line", (l) => {
  const w = waiters.shift();
  if (w) w(l);
  else lineQueue.push(l);
});
rl.on("close", () => {
  inputClosed = true;
  while (waiters.length) waiters.shift()(null); // null = EOF
});

function ask(q) {
  process.stdout.write(q);
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (inputClosed) return Promise.resolve(null);
  return new Promise((r) => waiters.push(r));
}

// 流式输出时是否已在本行写过内容（用于决定要不要补换行）
let lineOpen = false;
const streamWrite = (s) => { lineOpen = true; process.stdout.write(s); };
const closeLine = () => { if (lineOpen) { process.stdout.write("\n"); lineOpen = false; } };

/* --------------------------- 会话状态 --------------------------- */

const toolCalls = new Map(); // toolCallId -> { title, kind }
let session = null;
let turnCount = 0;

/* --------------------------- 上游事件渲染 --------------------------- */

function renderUpdate(u) {
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const c = u.content;
      if (c?.type === "text") streamWrite(c.text);
      else if (c?.type === "image") { closeLine(); out(`${C.gray}[图片]${C.reset}`); }
      else if (c) { closeLine(); out(`${C.gray}[${c.type ?? "内容"}]${C.reset}`); }
      break;
    }
    case "agent_thought_chunk": {
      const c = u.content;
      if (c?.type === "text") {
        closeLine();
        out(`${C.gray}${C.dim}💭 ${String(c.text).trim()}${C.reset}`);
      }
      break;
    }
    case "tool_call": {
      closeLine();
      const title = u.title ?? u.kind ?? "工具";
      toolCalls.set(u.toolCallId, { title, kind: u.kind });
      out(`${C.cyan}⚙ ${title}${C.reset}${u.status ? ` ${C.gray}(${u.status})${C.reset}` : ""}`);
      break;
    }
    case "tool_call_update": {
      const prev = toolCalls.get(u.toolCallId);
      // 只报状态变化，避免刷屏
      if (u.status && u.status !== prev?.status) {
        closeLine();
        const color = u.status === "failed" ? C.red : u.status === "completed" ? C.green : C.gray;
        out(`${color}  └ ${u.title ?? prev?.title ?? u.toolCallId} → ${u.status}${C.reset}`);
        if (prev) prev.status = u.status;
      }
      break;
    }
    case "notice": {
      closeLine();
      const t = u.content?.text ?? u.message ?? JSON.stringify(u);
      out(`${C.yellow}⚠ ${t}${C.reset}`);
      break;
    }
    case "usage_update": {
      if (DEBUG) { closeLine(); out(`${C.gray}[usage] ${JSON.stringify(u)}${C.reset}`); }
      break;
    }
    case "available_commands_update":
    case "session_info_update":
    case "config_option_update":
    case "current_mode_update":
      if (DEBUG) { closeLine(); out(`${C.gray}[${u.sessionUpdate}] ${JSON.stringify(u).slice(0, 200)}${C.reset}`); }
      break;
    default:
      if (DEBUG) { closeLine(); out(`${C.gray}[${u.sessionUpdate}] ${JSON.stringify(u).slice(0, 300)}${C.reset}`); }
  }
}

/* --------------------------- 权限批准 --------------------------- */

async function handlePermission({ params }) {
  closeLine();
  const tool = params.toolCall ?? {};
  // 批准请求往往只带 toolCallId，标题要从之前那条 tool_call 更新里取
  const known = toolCalls.get(tool.toolCallId) ?? {};
  const title = tool.title ?? known.title ?? tool.kind ?? known.kind ?? "工具调用";

  out("");
  out(`${C.yellow}${C.bold}┌─ 需要你批准 ─────────────────────────────${C.reset}`);
  out(`${C.yellow}│${C.reset} ${C.bold}${title}${C.reset}`);
  if (tool.kind ?? known.kind) out(`${C.yellow}│${C.reset} ${C.gray}类型: ${tool.kind ?? known.kind}${C.reset}`);
  const raw =
    tool.rawInput ??
    tool.content?.find?.((c) => c.type === "content")?.content ??
    null;
  if (raw) {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 1);
    for (const line of text.split("\n").slice(0, 14)) out(`${C.yellow}│${C.reset} ${C.gray}${line}${C.reset}`);
  }
  out(`${C.yellow}└──────────────────────────────────────────${C.reset}`);
  if (!MODE && params.options?.some((o) => o.kind?.startsWith("allow"))) {
    out(`${C.gray}  提示：D 盘工作区每条命令都要批准。想免批准可退出后用 dshr --full-access 重开。${C.reset}`);
  }

  const options = params.options ?? [];
  options.forEach((o, i) => {
    const label = o.kind?.startsWith("allow") ? C.green : C.red;
    out(`  ${C.bold}${i + 1}${C.reset}) ${label}${o.name}${C.reset} ${C.gray}(${o.kind})${C.reset}`);
  });

  const rawAnswer = await ask(`${C.cyan}选择 [1-${options.length}]，直接回车=拒绝: ${C.reset}`);
  const answer = (rawAnswer ?? "").trim();

  if (!answer) {
    const reject = options.find((o) => o.kind?.startsWith("reject")) ?? options[options.length - 1];
    return { outcome: { outcome: "selected", optionId: reject.optionId } };
  }
  const n = Number.parseInt(answer, 10);
  const chosen = Number.isFinite(n) && n >= 1 && n <= options.length ? options[n - 1] : null;
  if (!chosen) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: chosen.optionId } };
}

/* --------------------------- 组装 ACP 客户端 --------------------------- */

const app = client({ name: "dsh-repl" })
  // 流式事件
  .onNotification(methods.client.session.update, ({ params }) => {
    if (DEBUG) out(`${C.gray}<< ${JSON.stringify(params).slice(0, 400)}${C.reset}`);
    renderUpdate(params.update);
  })
  // 权限批准（这就是 headless 缺的那条通道）
  .onRequest(methods.client.session.requestPermission, handlePermission)
  // 文件读取：ACP 约定由客户端提供文件系统能力
  .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
    try {
      const text = await readFile(params.path, "utf8");
      return { content: text };
    } catch (e) {
      throw new Error(`读取失败 ${params.path}: ${e.message}`);
    }
  })
  .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
    try {
      await writeFile(params.path, params.content ?? "", "utf8");
      return {};
    } catch (e) {
      throw new Error(`写入失败 ${params.path}: ${e.message}`);
    }
  });

/* --------------------------- 启动 & 主循环 --------------------------- */

// Windows 上 dsh 是 .cmd，不能直接 spawn（会 EINVAL），但也别用 shell:true
// （那会把参数拼成字符串，Node 会告警）。走 cmd.exe /c，参数仍按数组传。
const isWin = process.platform === "win32";
const spawnCmd = isWin ? process.env.ComSpec || "cmd.exe" : DSH_BIN;
const spawnArgs = isWin
  ? ["/d", "/s", "/c", `${DSH_BIN} --profile acp`]
  : ["--profile", "acp"];

const child = spawn(spawnCmd, spawnArgs, {
  cwd: CWD,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: MODE ? { ...process.env, DSH_PERMISSION_MODE: MODE } : process.env,
});

child.on("error", (e) => { out(`${C.red}无法启动 dsh：${e.message}${C.reset}`); process.exit(1); });

// 上游诊断日志：默认折叠，--debug 时透传
child.stderr.on("data", (b) => {
  const s = b.toString();
  if (DEBUG) process.stderr.write(`${C.gray}${s}${C.reset}`);
  else process.stderr.write(""); // 丢弃
});

child.on("exit", (code) => {
  closeLine();
  out(`${C.gray}dsh 已退出（code=${code}）${C.reset}`);
  rl.close();
  process.exit(0);
});

const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));

out(`${C.bold}DeepSeek Harness${C.reset} ${C.gray}· 官方 ACP 通道 · 交互式终端${C.reset}`);
out(`${C.gray}工作区: ${CWD}${C.reset}`);
if (MODE) out(`${C.yellow}沙箱模式: ${MODE}${C.reset}`);

try {
  await app.connectWith(stream, async (ctx) => {
    // ACP 握手
    const init = await ctx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });
    if (DEBUG) out(`${C.gray}[initialize] ${JSON.stringify(init)}${C.reset}`);

    // 建会话
    const active = await ctx.buildSession(CWD).start();
    session = active;
    out(`${C.gray}会话已建立。输入 /exit 退出，/help 看命令。${C.reset}`);
    out("");

    // 交互循环
    while (true) {
      const raw = await ask(`${C.cyan}dsh>${C.reset} `);
      if (raw === null) { out(""); out(`${C.gray}输入结束，退出。${C.reset}`); break; }
      const line = raw.trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/help") {
        out(`${C.gray}/exit 退出   /help 帮助   /cwd 显示工作区${C.reset}`);
        continue;
      }
      if (line === "/cwd") { out(`${CWD}`); continue; }

      turnCount++;
      lineOpen = false;
      out("");
      try {
        const res = await active.prompt(line);
        closeLine();
        out(`${C.gray}── 第 ${turnCount} 轮结束 · ${res?.stopReason ?? "?"}${C.reset}`);
      } catch (e) {
        closeLine();
        out(`${C.red}本轮出错：${e.message}${C.reset}`);
      }
      out("");
    }
  });
} catch (e) {
  closeLine();
  out(`${C.red}连接失败：${e?.message ?? e}${C.reset}`);
  if (DEBUG) console.error(e);
} finally {
  try { child.kill(); } catch {}
  rl.close();
}
