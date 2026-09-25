#!/usr/bin/env node
/**
 * dshr —— DeepSeek Harness 的交互式终端（非官方）
 *
 * 只用官方组件：
 *   - `dsh --profile acp`       官方 ACP (Agent Client Protocol) v1 服务器
 *   - @agentclientprotocol/sdk  官方 ACP 客户端 SDK
 *   ＞ dsh 源码一行未改。
 *
 * 用法：
 *   dshr [--cwd <目录>] [--mode <模式>|--full-access] [--dsh <exe>] [--debug]
 * 会话内： /help  /mode  /cwd  /exit
 */

import { client, ndJsonStream, methods } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import os from "node:os";
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

/* --------------------------- 工作区体检 --------------------------- */

function isInside(parent, child) {
  const p = resolve(parent), c = resolve(child);
  if (p === c) return true;
  const rel = relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Windows ACL 沙箱硬性要求「临时目录在工作区之外」。
 * 默认 TEMP 在 C:\Users\<你>\AppData\Local\Temp —— 一旦工作区就是 C:\Users\<你>，
 * 沙箱会直接报 "Windows ACL temp root must be outside the workspace"，
 * 于是所有 shell 命令全废（连读文件都受影响）。
 * 这里挑一个确定在工作区之外的临时目录注入给子进程。
 */
function writableDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.dshr-probe-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return true;
  } catch { return false; }
}

function pickTempDir(workspace) {
  // 候选顺序：用户私有 → 公共可写（家目录当工作区时唯一的出路）→ 系统临时 → 其他盘
  const candidates = [
    join(os.homedir(), ".dshr-tmp"),
    process.env.PUBLIC ? join(process.env.PUBLIC, "dshr-tmp") : "C:\\Users\\Public\\dshr-tmp",
    os.tmpdir(),
  ];
  for (const c of candidates) {
    if (isInside(workspace, c)) continue;      // 必须在工作区之外
    if (writableDir(c)) return c;              // 而且必须真的可写
  }
  return null;
}

const TEMP_DIR = pickTempDir(CWD);
// 工作区在系统盘用户目录之外时（比如 D 盘），沙箱还可能因 ACL 缺 WRITE_OWNER 失败 —— 见 README。
const TEMP_PROBLEM = !TEMP_DIR || isInside(CWD, resolve(process.env.TEMP || process.env.TMP || ""));

/* ---------------------------- 权限模式 ---------------------------- */

// 官方三种模式（dsh-sandbox-policy 的封闭词汇）。dsh 从 DSH_PERMISSION_MODE 读取。
// ACP 协议本身有 session/set_mode，但 dsh 未对外公布任何 modes（modes: undefined），
// 所以本工具用「重启进程 + session/resume 续接会话」实现切换。
const MODES = {
  "read-only": {
    zh: "只读", en: "Read Only", alias: ["只读", "readonly", "ro", "view"],
    desc: "不能写任何文件（仅可查看）。越权写操作会被拒绝。",
  },
  "workspace-write": {
    zh: "工作区内修改", en: "Workspace Write", alias: ["手工", "manual", "work", "ww"],
    desc: "只能写工作区目录内；需要越权时弹出批准框，一条一条问你 —— 最接近 Claude Code 的默认模式。",
  },
  "danger-full-access": {
    zh: "完全权限", en: "Full Access", alias: ["自动", "auto", "full", "yolo"],
    desc: "无文件系统限制、不弹批准。⚠️ 不是 Claude Code 那种「智能判断」—— dsh 的分类器不经 ACP 暴露，所以这里的「自动」= 全部放行。",
  },
};
const MODE_IDS = Object.keys(MODES);

function normalizeMode(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (MODES[s]) return s;
  for (const [id, m] of Object.entries(MODES)) {
    if (m.alias.some((a) => a.toLowerCase() === s)) return id;
  }
  return null;
}

let currentMode =
  normalizeMode(opt("--mode", argv.includes("--full-access") ? "danger-full-access" : null)) ??
  normalizeMode(process.env.DSH_PERMISSION_MODE) ??
  "workspace-write";

/* ------------------------------ 颜色 ------------------------------ */

const C = {
  dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m",
  red: "\x1b[31m", gray: "\x1b[90m", magenta: "\x1b[35m", blue: "\x1b[34m",
};
const out = (s = "") => process.stdout.write(s + "\n");

// 小鲸鱼（DeepSeek 的 logo 就是鲸鱼）
const WHALE = [
  "        ▄▄▄▄▄▄▄▄",
  "     ▄████████████▄",
  "   ███▀            ▀███▄",
  "  ██▀   ●      ●     ▀██▄",
  "  ██                    ███",
  "  ▀██▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄████▀",
  "    ▀▀████████████▀▀",
];

function modeLabel(id = currentMode) {
  const m = MODES[id];
  return `${C.green}${m?.zh ?? id}${C.reset} ${C.gray}(${id})${C.reset}`;
}
const promptStr = () => `${C.cyan}dsh${C.gray}[${currentMode}]${C.cyan}>${C.reset} `;

function banner() {
  const info = [
    `${C.bold}dshr${C.reset} ${C.gray}· DeepSeek Harness 交互式终端${C.reset}`,
    `${C.gray}非官方 · 官方 ACP 通道 · 未修改 dsh 源码${C.reset}`,
    ``,
    `${C.gray}工作区${C.reset}   ${CWD}`,
    `${C.gray}权限模式${C.reset} ${modeLabel()}`,
  ];
  for (let i = 0; i < WHALE.length; i++) {
    const left = `${C.blue}${WHALE[i]}${C.reset}`;
    out(info[i] ? `${left}   ${info[i]}` : left);
  }
  for (let i = WHALE.length; i < info.length; i++) out(info[i]);
  if (!/^[Cc]:/.test(CWD)) {
    out(`${C.gray}提示：工作区不在 C 盘。某些盘上 dsh 沙箱起不来（ACL 缺 WRITE_OWNER），遇阻用 /mode 切「自动」。${C.reset}`);
  }
  out(`${C.gray}输入 /help 看命令，/mode 切权限模式。${C.reset}`);
  out();
}

/* ------------------------------ 输入 ------------------------------ */

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: process.stdin.isTTY === true,
});
const lineQueue = [];
const waiters = [];
let inputClosed = false;
rl.on("line", (l) => { const w = waiters.shift(); if (w) w(l); else lineQueue.push(l); });
rl.on("close", () => { inputClosed = true; while (waiters.length) waiters.shift()(null); });

function ask(q) {
  process.stdout.write(q);
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (inputClosed) return Promise.resolve(null);
  return new Promise((r) => waiters.push(r));
}

/* --------------------------- 输出渲染 --------------------------- */

let lineOpen = false;
const streamWrite = (s) => { lineOpen = true; process.stdout.write(s); };
const closeLine = () => { if (lineOpen) { process.stdout.write("\n"); lineOpen = false; } };

const toolCalls = new Map(); // toolCallId -> { title, kind, detail, status }

/** 从工具入参里提炼一句人类可读的摘要（命令 / 路径 / 模式） */
function summarizeInput(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  const cmd = input.command ?? input.cmd ?? input.script;
  if (typeof cmd === "string") return cmd;
  const p =
    input.path ?? input.file_path ?? input.filePath ?? input.target_file ??
    input.pattern ?? input.url ?? input.query;
  if (typeof p === "string") return p;
  if (Array.isArray(input.paths) && input.paths.length) return input.paths.join(", ");
  return "";
}

function firstLine(s, n = 160) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/* --------------- 沙箱失败识别：给一次可执行的提示 --------------- */

const hinted = new Set();
function sandboxHint(kind) {
  if (hinted.has(kind)) return;
  hinted.add(kind);
  closeLine();
  if (kind === "acl") {
    out(`${C.yellow}⚠ shell 跑不起来：这个盘的工作区目录没授予你 WRITE_OWNER（Windows ACL 前提）${C.reset}`);
    out(`  ${C.gray}→ 最快：${C.reset}${C.bold}/mode 自动${C.reset}${C.gray}  —— 免批准、不改 ACL（代价：沙箱不生效）${C.reset}`);
    out(`  ${C.gray}→ 想保留沙箱：把工作区放到 ${C.reset}C:\\Users\\${process.env.USERNAME ?? "<你>"}${C.gray} 下面${C.reset}`);
  } else if (kind === "temp") {
    out(`${C.yellow}⚠ shell 跑不起来：临时目录落在工作区内部${C.reset}`);
    out(`  ${C.gray}→ 别在家目录本身运行；换个子目录，或用 ${C.reset}${C.bold}/mode 自动${C.reset}`);
  }
}

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
        out(`${C.dim}${C.gray}💭 ${firstLine(c.text, 240)}${C.reset}`);
      }
      break;
    }
    case "tool_call": {
      closeLine();
      const detail = summarizeInput(u.rawInput);
      toolCalls.set(u.toolCallId, {
        title: u.title ?? u.kind ?? "工具", kind: u.kind, detail, status: u.status,
      });
      const kind = u.kind ? `${C.gray}${u.kind}${C.reset} ` : "";
      out(`${C.cyan}⏺ ${kind}${C.reset}${firstLine(detail || u.title || "工具调用", 170)}`);
      break;
    }
    case "tool_call_update": {
      const prev = toolCalls.get(u.toolCallId) ?? {};
      if (u.status && u.status !== prev.status) {
        closeLine();
        const color = u.status === "failed" ? C.red : u.status === "completed" ? C.green : C.gray;
        const mark = u.status === "failed" ? "✗" : u.status === "completed" ? "✓" : "…";
        const label = firstLine(u.title ?? prev.detail ?? prev.title ?? u.toolCallId, 120);
        out(`${color}  ${mark} ${u.status}${C.reset}${C.gray} · ${label}${C.reset}`);
        prev.status = u.status;
        toolCalls.set(u.toolCallId, prev);
      }
      // 沙箱类失败：给一次人话提示，别让 agent 自己瞎试
      const blob = JSON.stringify(u);
      if (/SetNamedSecurityInfoW/.test(blob)) sandboxHint("acl");
      else if (/temp root must be outside the workspace/i.test(blob)) sandboxHint("temp");
      break;
    }
    case "notice": {
      closeLine();
      out(`${C.yellow}⚠ ${firstLine(u.content?.text ?? u.message ?? JSON.stringify(u), 300)}${C.reset}`);
      break;
    }
    case "current_mode_update": {
      closeLine();
      out(`${C.magenta}◆ 会话模式变为: ${u.modeId ?? JSON.stringify(u)}${C.reset}`);
      break;
    }
    default:
      if (DEBUG) { closeLine(); out(`${C.gray}[${u.sessionUpdate}] ${JSON.stringify(u).slice(0, 300)}${C.reset}`); }
  }
}

/* --------------------------- 权限批准 --------------------------- */

async function handlePermission({ params }) {
  closeLine();
  const tool = params.toolCall ?? {};
  const known = toolCalls.get(tool.toolCallId) ?? {};
  const detail =
    summarizeInput(tool.rawInput) || known.detail ||
    firstLine(tool.title ?? known.title ?? "", 200) || "(无详情)";
  const kind = tool.kind ?? known.kind ?? "other";

  out("");
  out(`${C.yellow}${C.bold}╭─ 需要你批准 ────────────────────────────────${C.reset}`);
  out(`${C.yellow}│${C.reset} ${C.bold}${kind}${C.reset} ${C.gray}${firstLine(known.title ?? tool.title ?? "", 80)}${C.reset}`);
  for (const l of String(detail).split("\n").slice(0, 10)) {
    out(`${C.yellow}│${C.reset} ${C.bold}${l.slice(0, 200)}${C.reset}`);
  }
  out(`${C.yellow}╰─────────────────────────────────────────────${C.reset}`);

  const options = params.options ?? [];
  options.forEach((o, i) => {
    const label = o.kind?.startsWith("allow") ? C.green : C.red;
    out(`  ${C.bold}${i + 1}${C.reset}) ${label}${o.name}${C.reset} ${C.gray}(${o.kind})${C.reset}`);
  });
  out(`${C.gray}  输序号选择，直接回车 = 拒绝。不想再被逐条问，用 /mode 切权限模式。${C.reset}`);

  const raw = await ask(`${C.cyan}选择 [1-${options.length}]: ${C.reset}`);
  const answer = (raw ?? "").trim();
  if (!answer) {
    const rej = options.find((o) => o.kind?.startsWith("reject")) ?? options[options.length - 1];
    return { outcome: { outcome: "selected", optionId: rej.optionId } };
  }
  const n = Number.parseInt(answer, 10);
  const chosen = Number.isFinite(n) && n >= 1 && n <= options.length ? options[n - 1] : null;
  if (!chosen) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: chosen.optionId } };
}

/* --------------------------- ACP 客户端 --------------------------- */

function buildClient() {
  return client({ name: "dshr" })
    .onNotification(methods.client.session.update, ({ params }) => {
      if (DEBUG) out(`${C.gray}<< ${JSON.stringify(params).slice(0, 400)}${C.reset}`);
      renderUpdate(params.update);
    })
    .onRequest(methods.client.session.requestPermission, handlePermission)
    .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
      try { return { content: await readFile(params.path, "utf8") }; }
      catch (e) { throw new Error(`读取失败 ${params.path}: ${e.message}`); }
    })
    .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
      try { await writeFile(params.path, params.content ?? "", "utf8"); return {}; }
      catch (e) { throw new Error(`写入失败 ${params.path}: ${e.message}`); }
    });
}

/* --------------------------- 启动 agent --------------------------- */

const isWin = process.platform === "win32";

function spawnAgent(mode) {
  const spawnCmd = isWin ? process.env.ComSpec || "cmd.exe" : DSH_BIN;
  const spawnArgs = isWin ? ["/d", "/s", "/c", `${DSH_BIN} --profile acp`] : ["--profile", "acp"];
  const env = { ...process.env, DSH_PERMISSION_MODE: mode };
  // 把临时目录指到工作区之外，否则 ACL 沙箱会直接拒绝启动（shell 全废）
  if (TEMP_DIR) { env.TEMP = TEMP_DIR; env.TMP = TEMP_DIR; }
  const child = spawn(spawnCmd, spawnArgs, {
    cwd: CWD,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env,
  });
  child.on("error", (e) => { out(`${C.red}无法启动 dsh：${e.message}${C.reset}`); process.exit(1); });
  child.stderr.on("data", (b) => { if (DEBUG) process.stderr.write(`${C.gray}${b}${C.reset}`); });
  return child;
}

/* --------------------------- 单次会话 --------------------------- */

/** 返回 null = 用户退出；返回 {mode, resumeId} = 请求换模式后重启 */
async function runSession(mode, resumeId) {
  const child = spawnAgent(mode);
  const app = buildClient();
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  let sessionId = null;
  let restart = null;

  try {
    await app.connectWith(stream, async (ctx) => {
      const init = await ctx.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      });
      if (DEBUG) out(`${C.gray}[initialize] ${JSON.stringify(init).slice(0, 300)}${C.reset}`);

      // 换模式重启时，尽量续接原会话
      if (resumeId) {
        try {
          await ctx.request(methods.agent.session.resume, { sessionId: resumeId, cwd: CWD });
          sessionId = resumeId;
          out(`${C.gray}已续接会话 ${String(sessionId).slice(0, 8)}（旧历史不会重绘）${C.reset}`);
        } catch (e) {
          out(`${C.yellow}续接失败（${firstLine(e.message, 80)}），改为新会话${C.reset}`);
        }
      }
      if (!sessionId) {
        const active = await ctx.buildSession(CWD).start();
        sessionId = active.sessionId;
      }

      while (true) {
        const raw = await ask(promptStr());
        if (raw === null) return;
        const line = raw.trim();
        if (!line) continue;

        /* ---- 本地命令 ---- */
        if (line === "/exit" || line === "/quit") return;
        if (line === "/help") { printHelp(); continue; }
        if (line === "/cwd") { out(`  ${CWD}`); continue; }
        if (line === "/mode" || line.startsWith("/mode ")) {
          const argRaw = line.slice(5).trim();
          if (!argRaw) { printModes(sessionId); continue; }
          const target = normalizeMode(argRaw);
          if (!target) {
            out(`${C.red}未知模式「${argRaw}」。可用：${MODE_IDS.join(" / ")}`);
            out(`别名：${Object.values(MODES).flatMap((m) => m.alias).join(" / ")}${C.reset}`);
            continue;
          }
          if (target === mode) { out(`${C.gray}已经是 ${target} 了${C.reset}`); continue; }
          out(`${C.gray}切换 ${mode} → ${target}：重启 agent 并续接会话…${C.reset}`);
          restart = { mode: target, resumeId: sessionId };
          return;
        }

        /* ---- 交给 agent ---- */
        lineOpen = false;
        out("");
        try {
          const res = await ctx.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: line }],
          });
          closeLine();
          out(`${C.gray}── ${res?.stopReason ?? "?"}${C.reset}`);
        } catch (e) {
          closeLine();
          out(`${C.red}本轮出错：${firstLine(e.message, 200)}${C.reset}`);
        }
        out("");
      }
    });
  } catch (e) {
    closeLine();
    out(`${C.red}连接失败：${firstLine(e?.message ?? String(e), 200)}${C.reset}`);
    if (DEBUG) console.error(e);
    restart = null;
  } finally {
    try { child.kill(); } catch {}
  }
  return restart;
}

/* ------------------------------ 帮助 ------------------------------ */

function printModes(sessionId) {
  out(`\n${C.bold}权限模式${C.reset} ${C.gray}(当前: ${currentMode})${C.reset}`);
  for (const id of MODE_IDS) {
    const m = MODES[id];
    const mark = id === currentMode ? `${C.green}●${C.reset}` : "○";
    out(`  ${mark} ${C.bold}${m.zh}${C.reset} ${C.gray}${id}${C.reset}`);
    out(`     ${m.desc}`);
    out(`     ${C.gray}别名: ${m.alias.join(" / ")}${C.reset}`);
  }
  out(`\n  ${C.gray}切换：${C.bold}/mode <名称>${C.reset}${C.gray}（重启 agent 并续接同一会话）${C.reset}`);
  out(`  ${C.gray}会话 id：${sessionId}${C.reset}\n`);
}

function printHelp() {
  out(`
${C.bold}会话内命令${C.reset}
  ${C.bold}/help${C.reset}          显示本帮助
  ${C.bold}/mode${C.reset}          查看当前权限模式与可选项
  ${C.bold}/mode <名称>${C.reset}   切换权限模式（重启 agent，续接同一会话）
  ${C.bold}/cwd${C.reset}           显示工作区
  ${C.bold}/exit${C.reset}          退出

${C.bold}启动参数${C.reset}
  --cwd <目录>     指定工作区（默认当前目录）
  --mode <模式>    起始权限模式：read-only | workspace-write | danger-full-access
  --full-access    等价于 --mode danger-full-access
  --dsh <路径>     指定 dsh 可执行文件
  --debug          打印原始 ACP 事件与上游 stderr
`);
}

/* ------------------------------ 主循环 ------------------------------ */

banner();

let resumeId = null;
while (true) {
  const next = await runSession(currentMode, resumeId);
  if (!next) break;
  currentMode = next.mode;
  resumeId = next.resumeId;
  out(`\n${C.gray}── 已切换到 ${modeLabel()} ──${C.reset}\n`);
}

closeLine();
out(`${C.gray}再见 🐋${C.reset}`);
rl.close();
