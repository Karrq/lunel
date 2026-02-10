#!/usr/bin/env node

import { WebSocket } from "ws";
import qrcode from "qrcode-terminal";
import { createOpencode } from "@opencode-ai/sdk";
import Ignore from "ignore";
const ignore = Ignore.default;
type IgnoreInstance = ReturnType<typeof ignore>;
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { spawn, ChildProcess, execSync } from "child_process";
import { createServer, Socket } from "net";

const PROXY_URL = process.env.LUNEL_PROXY_URL || "https://gateway.lunel.dev";
const VERSION = "0.1.3";

// Root directory - sandbox all file operations to this
const ROOT_DIR = process.cwd();

// Terminal sessions
const terminals = new Map<string, ChildProcess>();

// Process management
interface ManagedProcess {
  pid: number;
  proc: ChildProcess;
  command: string;
  args: string[];
  cwd: string;
  startTime: number;
  output: string[];
  channel: string;
}
const processes = new Map<number, ManagedProcess>();
const processOutputBuffers = new Map<string, string>();

// CPU usage tracking
let lastCpuInfo: { idle: number; total: number }[] | null = null;

// OpenCode client
let opencodeClient: Awaited<ReturnType<typeof createOpencode>>["client"] | null = null;

// ============================================================================
// Types
// ============================================================================

interface SessionResponse {
  code: string;
}

interface Message {
  v: 1;
  id: string;
  ns: string;
  action: string;
  payload: Record<string, unknown>;
}

interface Response {
  v: 1;
  id: string;
  ns: string;
  action: string;
  ok: boolean;
  payload: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

interface SystemMessage {
  type: "connected" | "peer_connected" | "peer_disconnected" | "error";
  role?: string;
  channel?: string;
  peer?: string;
  payload?: Record<string, unknown>;
}

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  mtime?: number;
}

interface FileStat {
  path: string;
  type: "file" | "directory";
  size: number;
  mtime: number;
  mode: number;
  [key: string]: unknown;
}

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

// ============================================================================
// Path Safety
// ============================================================================

function resolveSafePath(requestedPath: string): string | null {
  const resolved = path.resolve(ROOT_DIR, requestedPath);
  if (!resolved.startsWith(ROOT_DIR)) {
    return null;
  }
  return resolved;
}

function assertSafePath(requestedPath: string): string {
  const safePath = resolveSafePath(requestedPath);
  if (!safePath) {
    const error = new Error("Access denied: path outside root directory");
    (error as NodeJS.ErrnoException).code = "EACCES";
    throw error;
  }
  return safePath;
}

// ============================================================================
// File System Handlers
// ============================================================================

async function handleFsLs(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = (payload.path as string) || ".";
  const safePath = assertSafePath(reqPath);

  const entries = await fs.readdir(safePath, { withFileTypes: true });
  const result: FileEntry[] = [];

  for (const entry of entries) {
    const item: FileEntry = {
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    };

    // Try to get size and mtime for files
    if (entry.isFile()) {
      try {
        const stat = await fs.stat(path.join(safePath, entry.name));
        item.size = stat.size;
        item.mtime = stat.mtimeMs;
      } catch {
        // Ignore stat errors
      }
    }

    result.push(item);
  }

  return { path: reqPath, entries: result };
}

async function handleFsStat(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = payload.path as string;
  if (!reqPath) throw Object.assign(new Error("path is required"), { code: "EINVAL" });

  const safePath = assertSafePath(reqPath);
  const stat = await fs.stat(safePath);

  const result: FileStat = {
    path: reqPath,
    type: stat.isDirectory() ? "directory" : "file",
    size: stat.size,
    mtime: stat.mtimeMs,
    mode: stat.mode,
  };

  return result;
}

async function handleFsRead(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = payload.path as string;
  if (!reqPath) throw Object.assign(new Error("path is required"), { code: "EINVAL" });

  const safePath = assertSafePath(reqPath);

  // Check if binary
  const stat = await fs.stat(safePath);
  const content = await fs.readFile(safePath);

  // Try to detect if binary
  const isBinary = content.includes(0x00);

  if (isBinary) {
    return {
      path: reqPath,
      content: content.toString("base64"),
      encoding: "base64",
      size: stat.size,
    };
  }

  return {
    path: reqPath,
    content: content.toString("utf-8"),
    encoding: "utf8",
    size: stat.size,
  };
}

async function handleFsWrite(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = payload.path as string;
  const content = payload.content as string;
  const encoding = (payload.encoding as string) || "utf8";

  if (!reqPath) throw Object.assign(new Error("path is required"), { code: "EINVAL" });
  if (typeof content !== "string") throw Object.assign(new Error("content is required"), { code: "EINVAL" });

  const safePath = assertSafePath(reqPath);
  const parentDir = path.dirname(safePath);
  await fs.mkdir(parentDir, { recursive: true });

  if (encoding === "base64") {
    await fs.writeFile(safePath, Buffer.from(content, "base64"));
  } else {
    await fs.writeFile(safePath, content, "utf-8");
  }

  return { path: reqPath };
}

async function handleFsMkdir(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = payload.path as string;
  const recursive = payload.recursive !== false;

  if (!reqPath) throw Object.assign(new Error("path is required"), { code: "EINVAL" });

  const safePath = assertSafePath(reqPath);
  await fs.mkdir(safePath, { recursive });

  return { path: reqPath };
}

async function handleFsRm(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = payload.path as string;
  const recursive = payload.recursive === true;

  if (!reqPath) throw Object.assign(new Error("path is required"), { code: "EINVAL" });

  const safePath = assertSafePath(reqPath);
  await fs.rm(safePath, { recursive, force: false });

  return { path: reqPath };
}

async function handleFsMv(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const from = payload.from as string;
  const to = payload.to as string;

  if (!from) throw Object.assign(new Error("from is required"), { code: "EINVAL" });
  if (!to) throw Object.assign(new Error("to is required"), { code: "EINVAL" });

  const safeFrom = assertSafePath(from);
  const safeTo = assertSafePath(to);

  await fs.rename(safeFrom, safeTo);

  return { from, to };
}

// Load gitignore patterns
async function loadGitignore(dirPath: string): Promise<IgnoreInstance> {
  const ig = ignore();
  ig.add(".git");

  try {
    const gitignorePath = path.join(dirPath, ".gitignore");
    const content = await fs.readFile(gitignorePath, "utf-8");
    ig.add(content);
  } catch {
    // No .gitignore
  }

  return ig;
}

async function handleFsGrep(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = (payload.path as string) || ".";
  const pattern = payload.pattern as string;
  const caseSensitive = payload.caseSensitive !== false;
  const maxResults = (payload.maxResults as number) || 100;

  if (!pattern) throw Object.assign(new Error("pattern is required"), { code: "EINVAL" });

  const safePath = assertSafePath(reqPath);
  const matches: GrepMatch[] = [];
  const regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
  const rootIgnore = await loadGitignore(ROOT_DIR);

  async function searchFile(filePath: string, relativePath: string): Promise<void> {
    if (matches.length >= maxResults) return;

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (regex.test(lines[i])) {
          matches.push({
            file: relativePath,
            line: i + 1,
            content: lines[i].substring(0, 500),
          });
        }
        regex.lastIndex = 0;
      }
    } catch {
      // Skip unreadable files
    }
  }

  async function searchDir(dirPath: string, relativePath: string, ig: IgnoreInstance): Promise<void> {
    if (matches.length >= maxResults) return;

    const localIgnore = ignore().add(ig);
    try {
      const localGitignorePath = path.join(dirPath, ".gitignore");
      const content = await fs.readFile(localGitignorePath, "utf-8");
      localIgnore.add(content);
    } catch {
      // No local .gitignore
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (matches.length >= maxResults) break;

      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const checkPath = entry.isDirectory() ? `${relPath}/` : relPath;
      if (localIgnore.ignores(checkPath)) continue;

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        await searchDir(fullPath, relPath, localIgnore);
      } else if (entry.isFile()) {
        await searchFile(fullPath, relPath);
      }
    }
  }

  const stat = await fs.stat(safePath);
  if (stat.isDirectory()) {
    await searchDir(safePath, reqPath === "." ? "" : reqPath, rootIgnore);
  } else {
    await searchFile(safePath, reqPath);
  }

  return { matches };
}

async function handleFsCreate(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reqPath = payload.path as string;
  const type = payload.type as string;

  if (!reqPath) throw Object.assign(new Error("path is required"), { code: "EINVAL" });
  if (!type || (type !== "file" && type !== "directory")) {
    throw Object.assign(new Error("type must be 'file' or 'directory'"), { code: "EINVAL" });
  }

  const safePath = assertSafePath(reqPath);

  if (type === "directory") {
    await fs.mkdir(safePath, { recursive: true });
  } else {
    // Create parent directories if needed
    const parentDir = path.dirname(safePath);
    await fs.mkdir(parentDir, { recursive: true });
    // Create empty file
    await fs.writeFile(safePath, "");
  }

  return { path: reqPath };
}

// ============================================================================
// Git Handlers
// ============================================================================

async function runGit(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd: ROOT_DIR });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));

    proc.on("close", (code) => {
      resolve({ stdout, stderr, code: code || 0 });
    });

    proc.on("error", (err) => {
      resolve({ stdout: "", stderr: err.message, code: 1 });
    });
  });
}

async function handleGitStatus(): Promise<Record<string, unknown>> {
  // Get branch
  const branchResult = await runGit(["branch", "--show-current"]);
  const branch = branchResult.stdout.trim();

  // Get status
  const statusResult = await runGit(["status", "--porcelain", "-uall"]);
  const lines = statusResult.stdout.trim().split("\n").filter(Boolean);

  const staged: Array<{ path: string; status: string }> = [];
  const unstaged: Array<{ path: string; status: string }> = [];
  const untracked: string[] = [];

  for (const line of lines) {
    const index = line[0];
    const worktree = line[1];
    // Git porcelain format: XY path (where X=index status, Y=worktree status)
    // For renamed files: XY old -> new
    let filepath = line.substring(3).trim();

    // Handle quoted paths (git quotes paths with special chars)
    if (filepath.startsWith('"') && filepath.endsWith('"')) {
      filepath = filepath.slice(1, -1);
    }

    // For renamed files, extract just the new name
    if (filepath.includes(' -> ')) {
      filepath = filepath.split(' -> ')[1];
    }

    if (index === "?" && worktree === "?") {
      untracked.push(filepath);
    } else {
      if (index !== " " && index !== "?") {
        staged.push({ path: filepath, status: index });
      }
      if (worktree !== " " && worktree !== "?") {
        unstaged.push({ path: filepath, status: worktree });
      }
    }
  }

  // Get ahead/behind
  const aheadBehind = await runGit(["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  let ahead = 0;
  let behind = 0;
  if (aheadBehind.code === 0) {
    const parts = aheadBehind.stdout.trim().split(/\s+/);
    behind = parseInt(parts[0]) || 0;
    ahead = parseInt(parts[1]) || 0;
  }

  return { branch, ahead, behind, staged, unstaged, untracked };
}

async function handleGitStage(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const paths = payload.paths as string[];
  if (!paths || !paths.length) throw Object.assign(new Error("paths is required"), { code: "EINVAL" });

  const result = await runGit(["add", "--", ...paths]);
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr || "git add failed"), { code: "EGIT" });
  }

  return {};
}

async function handleGitUnstage(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const paths = payload.paths as string[];
  if (!paths || !paths.length) throw Object.assign(new Error("paths is required"), { code: "EINVAL" });

  // Use git restore --staged (Git 2.23+) which is more reliable
  // Falls back to git reset HEAD for older versions
  let result = await runGit(["restore", "--staged", "--", ...paths]);
  if (result.code !== 0) {
    // Fallback to reset for older git versions
    result = await runGit(["reset", "HEAD", "--", ...paths]);
    if (result.code !== 0) {
      throw Object.assign(new Error(result.stderr || "git unstage failed"), { code: "EGIT" });
    }
  }

  return {};
}

async function handleGitCommit(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const message = payload.message as string;
  if (!message) throw Object.assign(new Error("message is required"), { code: "EINVAL" });

  const result = await runGit(["commit", "-m", message]);
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr || "git commit failed"), { code: "EGIT" });
  }

  // Get the commit hash
  const hashResult = await runGit(["rev-parse", "HEAD"]);
  const hash = hashResult.stdout.trim().substring(0, 7);

  return { hash, message };
}

async function handleGitLog(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const limit = (payload.limit as number) || 20;

  const result = await runGit([
    "log",
    `-${limit}`,
    "--pretty=format:%H|%s|%an|%at",
  ]);

  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr || "git log failed"), { code: "EGIT" });
  }

  const commits = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, message, author, timestamp] = line.split("|");
      return {
        hash: hash.substring(0, 7),
        message,
        author,
        date: parseInt(timestamp) * 1000,
      };
    });

  return { commits };
}

async function handleGitDiff(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const filepath = payload.path as string;
  const staged = payload.staged === true;

  const args = ["diff"];
  if (staged) args.push("--staged");
  if (filepath) args.push(filepath);

  const result = await runGit(args);

  return { diff: result.stdout };
}

async function handleGitBranches(): Promise<Record<string, unknown>> {
  const result = await runGit(["branch", "-a"]);
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr || "git branch failed"), { code: "EGIT" });
  }

  const lines = result.stdout.trim().split("\n");
  let current = "";
  const branches: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("* ")) {
      current = trimmed.substring(2);
      branches.push(current);
    } else if (!trimmed.startsWith("remotes/")) {
      branches.push(trimmed);
    }
  }

  return { current, branches };
}

async function handleGitCheckout(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const branch = payload.branch as string;
  const create = payload.create === true;
  if (!branch) throw Object.assign(new Error("branch is required"), { code: "EINVAL" });

  const args = create ? ["checkout", "-b", branch] : ["checkout", branch];
  const result = await runGit(args);
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr || "git checkout failed"), { code: "EGIT" });
  }

  return { branch };
}

async function handleGitPull(): Promise<Record<string, unknown>> {
  const result = await runGit(["pull"]);
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr || "git pull failed"), { code: "EGIT" });
  }

  return { success: true, summary: result.stdout.trim() || result.stderr.trim() };
}

async function handleGitPush(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const setUpstream = payload.setUpstream === true;

  const args = ["push"];
  if (setUpstream) {
    // Get current branch name
    const branchResult = await runGit(["branch", "--show-current"]);
    const branch = branchResult.stdout.trim();
    args.push("-u", "origin", branch);
  }

  const result = await runGit(args);
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr || "git push failed"), { code: "EGIT" });
  }

  return { success: true };
}

async function handleGitDiscard(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const paths = payload.paths as string[] | undefined;
  const all = payload.all === true;

  if (!paths && !all) {
    throw Object.assign(new Error("paths or all is required"), { code: "EINVAL" });
  }

  if (all) {
    // Discard all changes
    const result = await runGit(["checkout", "--", "."]);
    if (result.code !== 0) {
      throw Object.assign(new Error(result.stderr || "git checkout failed"), { code: "EGIT" });
    }
    // Also clean untracked files
    await runGit(["clean", "-fd"]);
  } else if (paths && paths.length > 0) {
    const result = await runGit(["checkout", "--", ...paths]);
    if (result.code !== 0) {
      throw Object.assign(new Error(result.stderr || "git checkout failed"), { code: "EGIT" });
    }
  }

  return {};
}

// ============================================================================
// Terminal Handlers
// ============================================================================

let dataChannel: WebSocket | null = null;

function handleTerminalSpawn(payload: Record<string, unknown>): Record<string, unknown> {
  const shell = (payload.shell as string) || process.env.SHELL || "/bin/sh";
  const cols = (payload.cols as number) || 80;
  const rows = (payload.rows as number) || 24;

  const terminalId = `term-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  const proc = spawn(shell, [], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLUMNS: cols.toString(),
      LINES: rows.toString(),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  terminals.set(terminalId, proc);

  // Stream output to app via data channel
  const sendOutput = (data: Buffer) => {
    if (dataChannel && dataChannel.readyState === WebSocket.OPEN) {
      const msg: Message = {
        v: 1,
        id: `evt-${Date.now()}`,
        ns: "terminal",
        action: "output",
        payload: { terminalId, data: data.toString() },
      };
      dataChannel.send(JSON.stringify(msg));
    }
  };

  proc.stdout?.on("data", sendOutput);
  proc.stderr?.on("data", sendOutput);

  proc.on("close", (code) => {
    terminals.delete(terminalId);
    if (dataChannel && dataChannel.readyState === WebSocket.OPEN) {
      const msg: Message = {
        v: 1,
        id: `evt-${Date.now()}`,
        ns: "terminal",
        action: "exit",
        payload: { terminalId, code },
      };
      dataChannel.send(JSON.stringify(msg));
    }
  });

  return { terminalId };
}

function handleTerminalWrite(payload: Record<string, unknown>): Record<string, unknown> {
  const terminalId = payload.terminalId as string;
  const data = payload.data as string;

  if (!terminalId) throw Object.assign(new Error("terminalId is required"), { code: "EINVAL" });
  if (typeof data !== "string") throw Object.assign(new Error("data is required"), { code: "EINVAL" });

  const proc = terminals.get(terminalId);
  if (!proc) throw Object.assign(new Error("Terminal not found"), { code: "ENOTERM" });

  proc.stdin?.write(data);

  return {};
}

function handleTerminalResize(payload: Record<string, unknown>): Record<string, unknown> {
  const terminalId = payload.terminalId as string;
  const cols = payload.cols as number;
  const rows = payload.rows as number;

  if (!terminalId) throw Object.assign(new Error("terminalId is required"), { code: "EINVAL" });

  const proc = terminals.get(terminalId);
  if (!proc) throw Object.assign(new Error("Terminal not found"), { code: "ENOTERM" });

  // Note: For proper PTY resize, you'd need node-pty
  // This is a simplified version

  return {};
}

function handleTerminalKill(payload: Record<string, unknown>): Record<string, unknown> {
  const terminalId = payload.terminalId as string;

  if (!terminalId) throw Object.assign(new Error("terminalId is required"), { code: "EINVAL" });

  const proc = terminals.get(terminalId);
  if (!proc) throw Object.assign(new Error("Terminal not found"), { code: "ENOTERM" });

  proc.kill();
  terminals.delete(terminalId);

  return {};
}

// ============================================================================
// System Handlers
// ============================================================================

function handleSystemCapabilities(): Record<string, unknown> {
  return {
    version: VERSION,
    namespaces: ["fs", "git", "terminal", "processes", "ports", "monitor", "http", "ai"],
    platform: os.platform(),
    rootDir: ROOT_DIR,
    hostname: os.hostname(),
  };
}

function handleSystemPing(): Record<string, unknown> {
  return { pong: true, timestamp: Date.now() };
}

// ============================================================================
// Processes Handlers
// ============================================================================

function handleProcessesList(): Record<string, unknown> {
  const result: Array<{
    pid: number;
    command: string;
    startTime: number;
    status: string;
    channel: string;
    cwd: string;
  }> = [];

  for (const [pid, proc] of processes) {
    result.push({
      pid,
      command: `${proc.command} ${proc.args.join(" ")}`.trim(),
      startTime: proc.startTime,
      status: proc.proc.killed ? "stopped" : "running",
      channel: proc.channel,
      cwd: proc.cwd,
    });
  }

  return { processes: result };
}

function handleProcessesSpawn(payload: Record<string, unknown>): Record<string, unknown> {
  const command = payload.command as string;
  const args = (payload.args as string[]) || [];
  const cwd = payload.cwd as string | undefined;
  const extraEnv = (payload.env as Record<string, string>) || {};

  if (!command) throw Object.assign(new Error("command is required"), { code: "EINVAL" });

  const workDir = cwd ? assertSafePath(cwd) : ROOT_DIR;

  const proc = spawn(command, args, {
    cwd: workDir,
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });

  const pid = proc.pid!;
  const channel = `proc-${pid}`;

  const managedProc: ManagedProcess = {
    pid,
    proc,
    command,
    args,
    cwd: workDir,
    startTime: Date.now(),
    output: [],
    channel,
  };

  processes.set(pid, managedProc);
  processOutputBuffers.set(channel, "");

  // Stream output
  const sendOutput = (stream: "stdout" | "stderr") => (data: Buffer) => {
    const text = data.toString();
    managedProc.output.push(text);
    processOutputBuffers.set(channel, (processOutputBuffers.get(channel) || "") + text);

    if (dataChannel && dataChannel.readyState === WebSocket.OPEN) {
      const msg: Message = {
        v: 1,
        id: `evt-${Date.now()}`,
        ns: "processes",
        action: "output",
        payload: { pid, channel, stream, data: text },
      };
      dataChannel.send(JSON.stringify(msg));
    }
  };

  proc.stdout?.on("data", sendOutput("stdout"));
  proc.stderr?.on("data", sendOutput("stderr"));

  proc.on("close", (code, signal) => {
    if (dataChannel && dataChannel.readyState === WebSocket.OPEN) {
      const msg: Message = {
        v: 1,
        id: `evt-${Date.now()}`,
        ns: "processes",
        action: "exit",
        payload: { pid, channel, code, signal },
      };
      dataChannel.send(JSON.stringify(msg));
    }
  });

  return { pid, channel };
}

function handleProcessesKill(payload: Record<string, unknown>): Record<string, unknown> {
  const pid = payload.pid as number;
  if (!pid) throw Object.assign(new Error("pid is required"), { code: "EINVAL" });

  const proc = processes.get(pid);
  if (!proc) throw Object.assign(new Error("Process not found"), { code: "ENOPROC" });

  proc.proc.kill();
  processes.delete(pid);

  return {};
}

function handleProcessesGetOutput(payload: Record<string, unknown>): Record<string, unknown> {
  const channel = payload.channel as string;
  if (!channel) throw Object.assign(new Error("channel is required"), { code: "EINVAL" });

  const output = processOutputBuffers.get(channel) || "";
  return { channel, output };
}

function handleProcessesClearOutput(payload: Record<string, unknown>): Record<string, unknown> {
  const channel = payload.channel as string;

  if (channel) {
    processOutputBuffers.set(channel, "");
  } else {
    processOutputBuffers.clear();
  }

  return {};
}

// ============================================================================
// Ports Handlers
// ============================================================================

function handlePortsList(): Record<string, unknown> {
  const platform = os.platform();
  const ports: Array<{ port: number; pid: number; process: string; address: string }> = [];

  try {
    let output: string;

    if (platform === "darwin" || platform === "linux") {
      // Use lsof on macOS/Linux
      try {
        output = execSync("lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null || true", {
          encoding: "utf-8",
          timeout: 5000,
        });

        const lines = output.trim().split("\n").slice(1); // Skip header
        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length >= 9) {
            const processName = parts[0];
            const pid = parseInt(parts[1]);
            const nameField = parts[8];
            // Parse address:port format
            const match = nameField.match(/:(\d+)$/);
            if (match) {
              const port = parseInt(match[1]);
              const address = nameField.replace(`:${port}`, "") || "0.0.0.0";
              ports.push({ port, pid, process: processName, address });
            }
          }
        }
      } catch {
        // lsof might fail, try netstat
        output = execSync("netstat -tlnp 2>/dev/null || netstat -an 2>/dev/null || true", {
          encoding: "utf-8",
          timeout: 5000,
        });
      }
    } else if (platform === "win32") {
      output = execSync("netstat -ano | findstr LISTENING", {
        encoding: "utf-8",
        timeout: 5000,
      });

      const lines = output.trim().split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const localAddr = parts[1];
          const pid = parseInt(parts[4]);
          const match = localAddr.match(/:(\d+)$/);
          if (match) {
            const port = parseInt(match[1]);
            const address = localAddr.replace(`:${port}`, "");
            ports.push({ port, pid, process: "unknown", address });
          }
        }
      }
    }
  } catch {
    // Return empty list on error
  }

  return { ports };
}

function handlePortsIsAvailable(payload: Record<string, unknown>): Record<string, unknown> {
  const port = payload.port as number;
  if (!port) throw Object.assign(new Error("port is required"), { code: "EINVAL" });

  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve({ port, available: false });
      } else {
        resolve({ port, available: false, error: err.message });
      }
    });

    server.once("listening", () => {
      server.close(() => {
        resolve({ port, available: true });
      });
    });

    server.listen(port, "127.0.0.1");
  }) as unknown as Record<string, unknown>;
}

function handlePortsKill(payload: Record<string, unknown>): Record<string, unknown> {
  const port = payload.port as number;
  if (!port) throw Object.assign(new Error("port is required"), { code: "EINVAL" });

  const platform = os.platform();

  try {
    let pid: number | null = null;

    if (platform === "darwin" || platform === "linux") {
      const output = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: "utf-8" });
      const pids = output.trim().split("\n").filter(Boolean);
      if (pids.length > 0) {
        pid = parseInt(pids[0]);
        execSync(`kill -9 ${pids.join(" ")}`, { encoding: "utf-8" });
      }
    } else if (platform === "win32") {
      const output = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf-8" });
      const lines = output.trim().split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          pid = parseInt(parts[4]);
          execSync(`taskkill /F /PID ${pid}`, { encoding: "utf-8" });
          break;
        }
      }
    }

    return { port, pid };
  } catch (err) {
    throw Object.assign(new Error(`Failed to kill process on port ${port}`), { code: "EPERM" });
  }
}

// ============================================================================
// Monitor Handlers
// ============================================================================

function getCpuUsage(): { usage: number; cores: number[] } {
  const cpus = os.cpus();
  const coreUsages: number[] = [];
  let totalIdle = 0;
  let totalTick = 0;

  for (let i = 0; i < cpus.length; i++) {
    const cpu = cpus[i];
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;

    if (lastCpuInfo && lastCpuInfo[i]) {
      const deltaTotal = total - lastCpuInfo[i].total;
      const deltaIdle = idle - lastCpuInfo[i].idle;
      const usage = deltaTotal > 0 ? ((deltaTotal - deltaIdle) / deltaTotal) * 100 : 0;
      coreUsages.push(Math.round(usage * 10) / 10);
    } else {
      coreUsages.push(0);
    }

    totalIdle += idle;
    totalTick += total;
  }

  // Update last CPU info for next calculation
  lastCpuInfo = cpus.map((cpu) => ({
    idle: cpu.times.idle,
    total: Object.values(cpu.times).reduce((a, b) => a + b, 0),
  }));

  const avgUsage = coreUsages.length > 0
    ? coreUsages.reduce((a, b) => a + b, 0) / coreUsages.length
    : 0;

  return { usage: Math.round(avgUsage * 10) / 10, cores: coreUsages };
}

function getMemoryInfo(): { total: number; used: number; free: number; usedPercent: number } {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const usedPercent = Math.round((used / total) * 1000) / 10;

  return { total, used, free, usedPercent };
}

function getDiskInfo(): Array<{ mount: string; filesystem: string; size: number; used: number; free: number; usedPercent: number }> {
  const platform = os.platform();
  const disks: Array<{ mount: string; filesystem: string; size: number; used: number; free: number; usedPercent: number }> = [];

  try {
    if (platform === "darwin" || platform === "linux") {
      const output = execSync("df -k 2>/dev/null || true", { encoding: "utf-8" });
      const lines = output.trim().split("\n").slice(1);

      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 6) {
          const filesystem = parts[0];
          const size = parseInt(parts[1]) * 1024;
          const used = parseInt(parts[2]) * 1024;
          const free = parseInt(parts[3]) * 1024;
          const mount = parts[5];

          // Skip special filesystems
          if (mount.startsWith("/") && !filesystem.startsWith("devfs") && !filesystem.startsWith("map ")) {
            disks.push({
              mount,
              filesystem,
              size,
              used,
              free,
              usedPercent: size > 0 ? Math.round((used / size) * 1000) / 10 : 0,
            });
          }
        }
      }
    } else if (platform === "win32") {
      const output = execSync("wmic logicaldisk get size,freespace,caption", { encoding: "utf-8" });
      const lines = output.trim().split("\n").slice(1);

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const mount = parts[0];
          const free = parseInt(parts[1]) || 0;
          const size = parseInt(parts[2]) || 0;
          const used = size - free;

          if (size > 0) {
            disks.push({
              mount,
              filesystem: "NTFS",
              size,
              used,
              free,
              usedPercent: Math.round((used / size) * 1000) / 10,
            });
          }
        }
      }
    }
  } catch {
    // Return empty on error
  }

  return disks;
}

function getBatteryInfo(): { hasBattery: boolean; percent: number; charging: boolean; timeRemaining: number | null } {
  const platform = os.platform();

  try {
    if (platform === "darwin") {
      const output = execSync("pmset -g batt 2>/dev/null || true", { encoding: "utf-8" });
      const percentMatch = output.match(/(\d+)%/);
      const chargingMatch = output.match(/AC Power|charging|charged/i);
      const timeMatch = output.match(/(\d+):(\d+) remaining/);

      if (percentMatch) {
        return {
          hasBattery: true,
          percent: parseInt(percentMatch[1]),
          charging: !!chargingMatch,
          timeRemaining: timeMatch ? parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]) : null,
        };
      }
    } else if (platform === "linux") {
      try {
        const capacityPath = "/sys/class/power_supply/BAT0/capacity";
        const statusPath = "/sys/class/power_supply/BAT0/status";

        const capacity = parseInt(execSync(`cat ${capacityPath} 2>/dev/null || echo 0`, { encoding: "utf-8" }).trim());
        const status = execSync(`cat ${statusPath} 2>/dev/null || echo Unknown`, { encoding: "utf-8" }).trim();

        if (capacity > 0) {
          return {
            hasBattery: true,
            percent: capacity,
            charging: status === "Charging" || status === "Full",
            timeRemaining: null,
          };
        }
      } catch {
        // No battery
      }
    } else if (platform === "win32") {
      const output = execSync("WMIC Path Win32_Battery Get EstimatedChargeRemaining,BatteryStatus 2>nul || echo", { encoding: "utf-8" });
      const lines = output.trim().split("\n").slice(1);

      if (lines.length > 0) {
        const parts = lines[0].trim().split(/\s+/);
        if (parts.length >= 2) {
          const status = parseInt(parts[0]);
          const percent = parseInt(parts[1]);

          return {
            hasBattery: true,
            percent: percent || 0,
            charging: status === 2 || status === 6, // Charging or Charging High
            timeRemaining: null,
          };
        }
      }
    }
  } catch {
    // No battery or error
  }

  return { hasBattery: false, percent: 0, charging: false, timeRemaining: null };
}

function handleMonitorSystem(): Record<string, unknown> {
  return {
    cpu: getCpuUsage(),
    memory: getMemoryInfo(),
    disk: getDiskInfo(),
    battery: getBatteryInfo(),
  };
}

function handleMonitorCpu(): Record<string, unknown> {
  const cpuInfo = getCpuUsage();
  const cpus = os.cpus();

  return {
    ...cpuInfo,
    model: cpus[0]?.model || "Unknown",
    speed: cpus[0]?.speed || 0,
  };
}

function handleMonitorMemory(): Record<string, unknown> {
  return getMemoryInfo();
}

function handleMonitorDisk(): Record<string, unknown> {
  return { disks: getDiskInfo() };
}

function handleMonitorBattery(): Record<string, unknown> {
  return getBatteryInfo();
}

// ============================================================================
// HTTP Handlers
// ============================================================================

async function handleHttpRequest(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const method = (payload.method as string) || "GET";
  const url = payload.url as string;
  const headers = (payload.headers as Record<string, string>) || {};
  const body = payload.body as string | undefined;
  const timeout = (payload.timeout as number) || 30000;

  if (!url) throw Object.assign(new Error("url is required"), { code: "EINVAL" });

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method,
      headers,
      body: body || undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const responseBody = await response.text();
    const timing = Date.now() - startTime;

    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      timing,
    };
  } catch (err) {
    const error = err as Error;
    if (error.name === "AbortError") {
      throw Object.assign(new Error("Request timed out"), { code: "ETIMEOUT" });
    }
    throw Object.assign(new Error(error.message || "Network error"), { code: "ENETWORK" });
  }
}

// ============================================================================
// AI Handlers (OpenCode SDK)
// ============================================================================

async function handleAiCreateSession(payload: Record<string, unknown>) {
  const title = (payload.title as string) || undefined;
  const response = await opencodeClient!.session.create({ body: { title } });
  return { session: response.data };
}

async function handleAiListSessions() {
  const response = await opencodeClient!.session.list();
  return { sessions: response.data };
}

async function handleAiGetSession(payload: Record<string, unknown>) {
  const id = payload.id as string;
  const response = await opencodeClient!.session.get({ path: { id } });
  return { session: response.data };
}

async function handleAiDeleteSession(payload: Record<string, unknown>) {
  const id = payload.id as string;
  await opencodeClient!.session.delete({ path: { id } });
  return {};
}

async function handleAiGetMessages(payload: Record<string, unknown>) {
  const id = payload.id as string;
  const response = await opencodeClient!.session.messages({ path: { id } });
  return { messages: response.data };
}

async function handleAiPrompt(payload: Record<string, unknown>) {
  const sessionId = payload.sessionId as string;
  const text = payload.text as string;
  const model = payload.model as { providerID: string; modelID: string } | undefined;

  // Fire and forget — results stream via SSE events forwarded on data channel
  opencodeClient!.session.prompt({
    path: { id: sessionId },
    body: {
      parts: [{ type: "text", text }],
      ...(model ? { model } : {}),
    },
  }).catch((err) => {
    if (dataChannel && dataChannel.readyState === WebSocket.OPEN) {
      dataChannel.send(JSON.stringify({
        v: 1,
        id: `evt-${Date.now()}`,
        ns: "ai",
        action: "event",
        payload: {
          type: "prompt_error",
          properties: { sessionId, error: (err as Error).message },
        },
      }));
    }
  });

  return { ack: true };
}

async function handleAiAbort(payload: Record<string, unknown>) {
  const id = payload.sessionId as string;
  await opencodeClient!.session.abort({ path: { id } });
  return {};
}

async function handleAiAgents() {
  const response = await opencodeClient!.app.agents();
  return { agents: response.data };
}

async function handleAiProviders() {
  const response = await opencodeClient!.config.providers();
  return { providers: response.data };
}

async function handleAiSetAuth(payload: Record<string, unknown>) {
  const providerId = payload.providerId as string;
  const key = payload.key as string;
  await opencodeClient!.auth.set({
    path: { id: providerId },
    body: { type: "api", key },
  });
  return {};
}

async function handleAiCommand(payload: Record<string, unknown>) {
  const sessionId = payload.sessionId as string;
  const command = payload.command as string;
  const args = (payload.arguments as string) || "";
  const response = await opencodeClient!.session.command({
    path: { id: sessionId },
    body: { command, arguments: args },
  });
  return { result: response.data };
}

async function handleAiRevert(payload: Record<string, unknown>) {
  const sessionId = payload.sessionId as string;
  const messageId = payload.messageId as string;
  await opencodeClient!.session.revert({
    path: { id: sessionId },
    body: { messageID: messageId },
  });
  return {};
}

async function handleAiUnrevert(payload: Record<string, unknown>) {
  const sessionId = payload.sessionId as string;
  await opencodeClient!.session.unrevert({ path: { id: sessionId } });
  return {};
}

async function handleAiShare(payload: Record<string, unknown>) {
  const sessionId = payload.sessionId as string;
  const response = await opencodeClient!.session.share({ path: { id: sessionId } });
  return { share: response.data };
}

async function handleAiPermissionReply(payload: Record<string, unknown>) {
  const permissionId = payload.permissionId as string;
  const sessionId = payload.sessionId as string;
  const approved = payload.approved as boolean;

  await opencodeClient!.postSessionIdPermissionsPermissionId({
    path: { id: sessionId, permissionID: permissionId },
    body: { response: approved ? "once" : "reject" },
  });

  return {};
}

// SSE event forwarding from OpenCode to mobile app
async function subscribeToOpenCodeEvents(client: typeof opencodeClient) {
  try {
    const events = await client!.event.subscribe();

    for await (const event of events.stream) {
      if (dataChannel && dataChannel.readyState === WebSocket.OPEN) {
        const msg: Message = {
          v: 1,
          id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          ns: "ai",
          action: "event",
          payload: {
            type: (event as any).type,
            properties: (event as any).properties,
          },
        };
        dataChannel.send(JSON.stringify(msg));
      }
    }
  } catch (err) {
    console.error("OpenCode event stream error:", err);
    setTimeout(() => subscribeToOpenCodeEvents(client), 3000);
  }
}

// ============================================================================
// Message Router
// ============================================================================

async function processMessage(message: Message): Promise<Response> {
  const { v, id, ns, action, payload } = message;

  // Validate protocol version
  if (v !== 1) {
    return {
      v: 1,
      id,
      ns,
      action,
      ok: false,
      payload: {},
      error: { code: "EPROTO", message: `Unsupported protocol version: ${v}` },
    };
  }

  try {
    let result: Record<string, unknown>;

    switch (ns) {
      case "system":
        switch (action) {
          case "capabilities":
            result = handleSystemCapabilities();
            break;
          case "ping":
            result = handleSystemPing();
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "fs":
        switch (action) {
          case "ls":
            result = await handleFsLs(payload);
            break;
          case "stat":
            result = await handleFsStat(payload);
            break;
          case "read":
            result = await handleFsRead(payload);
            break;
          case "write":
            result = await handleFsWrite(payload);
            break;
          case "mkdir":
            result = await handleFsMkdir(payload);
            break;
          case "rm":
            result = await handleFsRm(payload);
            break;
          case "mv":
            result = await handleFsMv(payload);
            break;
          case "grep":
            result = await handleFsGrep(payload);
            break;
          case "create":
            result = await handleFsCreate(payload);
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "git":
        switch (action) {
          case "status":
            result = await handleGitStatus();
            break;
          case "stage":
            result = await handleGitStage(payload);
            break;
          case "unstage":
            result = await handleGitUnstage(payload);
            break;
          case "commit":
            result = await handleGitCommit(payload);
            break;
          case "log":
            result = await handleGitLog(payload);
            break;
          case "diff":
            result = await handleGitDiff(payload);
            break;
          case "branches":
            result = await handleGitBranches();
            break;
          case "checkout":
            result = await handleGitCheckout(payload);
            break;
          case "pull":
            result = await handleGitPull();
            break;
          case "push":
            result = await handleGitPush(payload);
            break;
          case "discard":
            result = await handleGitDiscard(payload);
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "terminal":
        switch (action) {
          case "spawn":
            result = handleTerminalSpawn(payload);
            break;
          case "write":
            result = handleTerminalWrite(payload);
            break;
          case "resize":
            result = handleTerminalResize(payload);
            break;
          case "kill":
            result = handleTerminalKill(payload);
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "processes":
        switch (action) {
          case "list":
            result = handleProcessesList();
            break;
          case "spawn":
            result = handleProcessesSpawn(payload);
            break;
          case "kill":
            result = handleProcessesKill(payload);
            break;
          case "getOutput":
            result = handleProcessesGetOutput(payload);
            break;
          case "clearOutput":
            result = handleProcessesClearOutput(payload);
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "ports":
        switch (action) {
          case "list":
            result = handlePortsList();
            break;
          case "isAvailable":
            result = await handlePortsIsAvailable(payload);
            break;
          case "kill":
            result = handlePortsKill(payload);
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "monitor":
        switch (action) {
          case "system":
            result = handleMonitorSystem();
            break;
          case "cpu":
            result = handleMonitorCpu();
            break;
          case "memory":
            result = handleMonitorMemory();
            break;
          case "disk":
            result = handleMonitorDisk();
            break;
          case "battery":
            result = handleMonitorBattery();
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "http":
        switch (action) {
          case "request":
            result = await handleHttpRequest(payload);
            break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      case "ai":
        switch (action) {
          case "prompt":          result = await handleAiPrompt(payload); break;
          case "createSession":   result = await handleAiCreateSession(payload); break;
          case "listSessions":    result = await handleAiListSessions(); break;
          case "getSession":      result = await handleAiGetSession(payload); break;
          case "deleteSession":   result = await handleAiDeleteSession(payload); break;
          case "getMessages":     result = await handleAiGetMessages(payload); break;
          case "abort":           result = await handleAiAbort(payload); break;
          case "agents":          result = await handleAiAgents(); break;
          case "providers":       result = await handleAiProviders(); break;
          case "setAuth":         result = await handleAiSetAuth(payload); break;
          case "command":         result = await handleAiCommand(payload); break;
          case "revert":          result = await handleAiRevert(payload); break;
          case "unrevert":        result = await handleAiUnrevert(payload); break;
          case "share":           result = await handleAiShare(payload); break;
          case "permission":      result = await handleAiPermissionReply(payload); break;
          default:
            throw Object.assign(new Error(`Unknown action: ${ns}.${action}`), { code: "EINVAL" });
        }
        break;

      default:
        throw Object.assign(new Error(`Unknown namespace: ${ns}`), { code: "EINVAL" });
    }

    return { v: 1, id, ns, action, ok: true, payload: result };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return {
      v: 1,
      id,
      ns,
      action,
      ok: false,
      payload: {},
      error: {
        code: err.code || "ERROR",
        message: err.message || "Unknown error",
      },
    };
  }
}

// ============================================================================
// WebSocket Connection
// ============================================================================

async function createSession(): Promise<string> {
  const response = await fetch(`${PROXY_URL}/v1/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status}`);
  }

  const data = (await response.json()) as SessionResponse;
  return data.code;
}

function displayQR(code: string): void {
  console.log("\n");
  qrcode.generate(code, { small: true }, (qr) => {
    console.log(qr);
    console.log(`\n  Session code: ${code}\n`);
    console.log(`  Root directory: ${ROOT_DIR}\n`);
    console.log("  Scan the QR code with the Lunel app to connect.");
    console.log("  Press Ctrl+C to exit.\n");
  });
}

function connectWebSocket(code: string): void {
  const wsBase = PROXY_URL.replace(/^http/, "ws");
  const controlUrl = `${wsBase}/v1/ws/cli/control?code=${code}`;
  const dataUrl = `${wsBase}/v1/ws/cli/data?code=${code}`;

  console.log("Connecting to proxy...");

  // Control channel
  const controlWs = new WebSocket(controlUrl);
  let controlConnected = false;

  // Data channel
  const dataWs = new WebSocket(dataUrl);
  let dataConnected = false;

  // Store data channel reference for terminal output
  dataChannel = dataWs;

  function checkFullyConnected(): void {
    if (controlConnected && dataConnected) {
      console.log("Connected to proxy (control + data channels). Waiting for app...\n");
    }
  }

  // Control channel handlers
  controlWs.on("open", () => {
    controlConnected = true;
    checkFullyConnected();
  });

  controlWs.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());

      // Handle system messages
      if (message.type === "connected") {
        return;
      }

      if (message.type === "peer_connected") {
        console.log("App connected!\n");
        return;
      }

      if (message.type === "peer_disconnected") {
        console.log("App disconnected.\n");
        return;
      }

      // Handle v1 protocol messages
      if (message.v === 1) {
        const response = await processMessage(message as Message);
        controlWs.send(JSON.stringify(response));
      }
    } catch (error) {
      console.error("Error processing control message:", error);
    }
  });

  controlWs.on("close", (code, reason) => {
    console.log(`\nControl channel disconnected (${code}: ${reason.toString()})`);
    dataWs.close();
    process.exit(0);
  });

  controlWs.on("error", (error) => {
    console.error("Control WebSocket error:", error.message);
  });

  // Data channel handlers
  dataWs.on("open", () => {
    dataConnected = true;
    checkFullyConnected();
  });

  dataWs.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());

      // Handle system messages
      if (message.type === "connected") {
        return;
      }

      // Handle v1 protocol messages
      if (message.v === 1) {
        const response = await processMessage(message as Message);
        dataWs.send(JSON.stringify(response));
      }
    } catch (error) {
      console.error("Error processing data message:", error);
    }
  });

  dataWs.on("close", (code, reason) => {
    console.log(`\nData channel disconnected (${code}: ${reason.toString()})`);
    controlWs.close();
    process.exit(0);
  });

  dataWs.on("error", (error) => {
    console.error("Data WebSocket error:", error.message);
  });

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    // Kill all terminals
    for (const [id, proc] of terminals) {
      proc.kill();
    }
    terminals.clear();
    // Kill all managed processes
    for (const [pid, managedProc] of processes) {
      managedProc.proc.kill();
    }
    processes.clear();
    processOutputBuffers.clear();
    controlWs.close();
    dataWs.close();
    process.exit(0);
  });
}

async function main(): Promise<void> {
  console.log("Lunel CLI v" + VERSION);
  console.log("=".repeat(20) + "\n");

  try {
    // Start OpenCode server + client
    console.log("Starting OpenCode...");
    const { client } = await createOpencode();
    opencodeClient = client;
    console.log("OpenCode ready.\n");

    // Subscribe to OpenCode events
    subscribeToOpenCodeEvents(client);

    const code = await createSession();
    displayQR(code);
    connectWebSocket(code);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("An unexpected error occurred");
    }
    process.exit(1);
  }
}

main();
