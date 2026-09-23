import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { platform, homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import cors from "cors";
import pty from "node-pty";

import { scanAgents, validateCustomBinary, buildCustomAgent } from "./scanner.js";
import { triggerContextHandoff } from "./gitHelper.js";
import { buildCommand } from "./shellEscape.js";
import {
  type AgentDefinition,
  type SessionRecord,
  type ClientMessage,
  type AgentConfig,
  RATE_LIMIT_PATTERNS,
  MAX_SCROLLBACK,
  DEFAULT_GROUPS,
} from "./types.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT || "3777", 10);
// Bind to localhost by default so LAN peers cannot hit unauthenticated
// mutating endpoints (/api/shutdown, /api/workspace, custom agents).
// Opt into LAN with HOST=0.0.0.0 (Issue #3).
const HOST = process.env.HOST || "127.0.0.1";
// Where the local CLIs run by default (overridable via TARGET_DIR / the UI).
let workspaceDir = process.env.TARGET_DIR || process.cwd();
const isWindows = platform() === "win32";
const isMac = platform() === "darwin";

// ── Data Directory ───────────────────────────────────────────────
const DATA_DIR = join(homedir(), ".switchyard");
const SESSIONS_DIR = join(DATA_DIR, "sessions");
const CONFIG_DIR = join(DATA_DIR, "config");
try { mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
try { mkdirSync(CONFIG_DIR, { recursive: true }); } catch {}

import { gzipSync } from "node:zlib";

const app = express();

// Performance: Real gzip compression for text/JSON responses.
// Only compress when the client advertises gzip support, and actually
// gzip the payload. (Previously this just *claimed* gzip on everything,
// which made browsers fail to decode the plain-text HTML/JSON and show a
// black screen.)
// Match the media type (without "; charset=..." etc.) of compressible responses
const TEXT_TYPES = /^(text\/.*|application\/(json|javascript|xml|x-www-form-urlencoded)|application\/[\w.-]+\+json|application\/[\w.-]+\+xml|image\/svg\+xml|font\/(woff2?|ttf))$/;
app.use((req, res, next) => {
  const accept = (req.headers["accept-encoding"] || "") as string;
  if (!/\bgzip\b/i.test(accept)) return next();

  const send = res.send.bind(res);
  res.send = (body: any) => {
    if (typeof body !== "string" && !Buffer.isBuffer(body)) {
      return send(body);
    }
    // Compare against the mime type only (drops "; charset=…" suffix)
    const ctype = (res.getHeader("Content-Type") || "") as string;
    const mime = ctype.split(";")[0].trim().toLowerCase();
    const len = Buffer.byteLength(body);
    // Skip tiny payloads and non-text resources (negligible gain / risky)
    if (len < 1024 || !TEXT_TYPES.test(mime)) return send(body);
    try {
      const gzipped = gzipSync(Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8"));
      if (gzipped.length >= len) return send(body); // compression didn't help
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("Content-Length", String(gzipped.length));
      return send(gzipped);
    } catch {
      return send(body);
    }
  };
  next();
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));
// The app shell (index.html) is edited frequently during development of a local
// CLI tool, so do NOT pin it with an immutable cache. maxAge: 0 makes every
// reload revalidate (via ETag), so frontend edits take effect without a hard
// refresh. (The previous `maxAge:'1h', immutable:true` caused stale "still
// broken" pages right after a fix.)
app.use(express.static(resolve(__dirname, "..", "public"), {
  maxAge: 0,
}));

const server = createServer(app);
const wss = new WebSocketServer({ server });

let agents: AgentDefinition[] = [];
const sessions: Record<string, SessionRecord> = {};
const agentConfigs: Record<string, AgentConfig> = {};
const wsClients: Set<WebSocket> = new Set();

// State replay for new WebSocket connections (fixes race condition during scan)
let lastScanResult: AgentDefinition[] | null = null;
let lastSessionStatuses: Array<{ agentId: string; status: string; pid?: number; crashCount?: number }> | null = null;

// Cap reconnection queue size to prevent unbounded memory growth (Issue #8)
const MAX_RECONNECT_QUEUE = 100;

// ── Performance: Message batching ───────────────────────────────
let broadcastBuffer: Array<{type: string; payload: any}> = [];
let lastBroadcast = 0;
const BROADCAST_INTERVAL = 16; // ~60fps

function batchedBroadcast() {
  const now = Date.now();
  if (now - lastBroadcast < BROADCAST_INTERVAL) return;
  
  if (broadcastBuffer.length === 0) return;
  
  lastBroadcast = now;
  const batch = broadcastBuffer.splice(0);
  
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        for (const msg of batch) {
          client.send(JSON.stringify(msg), { binary: false });
        }
      } catch {}
    }
  }
}

setInterval(batchedBroadcast, BROADCAST_INTERVAL);

// ── Persistence ──────────────────────────────────────────────────

function loadConfigs(): void {
  try {
    const files = readdirSync(CONFIG_DIR).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const id = f.replace(".json", "");
      const data = JSON.parse(readFileSync(join(CONFIG_DIR, f), "utf-8"));
      agentConfigs[id] = data;
    }
  } catch {}
}

function saveConfig(agentId: string): void {
  const cfg = agentConfigs[agentId];
  if (!cfg) return;
  try {
    writeFileSync(join(CONFIG_DIR, `${agentId}.json`), JSON.stringify(cfg, null, 2));
  } catch {}
}

function loadSavedScrollback(agentId: string): string {
  try {
    const path = join(SESSIONS_DIR, `${agentId}.log`);
    if (existsSync(path)) return readFileSync(path, "utf-8");
  } catch {}
  return "";
}

function saveScrollback(agentId: string, data: string): void {
  // Skip saving for binary/empty data
  if (!data || data.length === 0) return;
  
  try {
    const path = join(SESSIONS_DIR, `${agentId}.log`);
    
    // Performance: Only write if we have new content
    const stats = existsSync(path) ? statSync(path) : null;
    const fileSize = stats ? stats.size : 0;
    
    // If file is large, use append with truncation
    if (fileSize > 50000) {
      // Read tail, append new data, trim
      const existing = readFileSync(path, "utf-8");
      const combined = existing + data;
      const trimmed = combined.length > 80000 ? combined.slice(-60000) : combined;
      writeFileSync(path, trimmed);
    } else {
      // For small files, simple append
      const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
      writeFileSync(path, existing + data);
    }
  } catch {}
}

// ── Git Branch Detection ─────────────────────────────────────────

async function getGitBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: dir,
      timeout: 3000,
      windowsHide: true,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ── Broadcast ────────────────────────────────────────────────────

// Use batching for JSON messages to reduce WebSocket overhead
function broadcast(msg: any) {
  // Add to batch buffer instead of sending immediately
  broadcastBuffer.push(msg);
  
  // Flush immediately if buffer gets too large
  if (broadcastBuffer.length > 50) {
    batchedBroadcast();
  }
}

// Send message to a specific WebSocket client
function sendTo(ws: WebSocket, msg: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Binary data goes directly (can't batch binary frames easily)
function broadcastBinary(data: string, agentId: string) {
  const frame = buildBinaryFrame(data, agentId);
  if (!frame) {
    broadcast({ type: "terminal_data", agentId, data });
    return;
  }
  // Send binary directly to all clients
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(frame, { binary: true });
      } catch {}
    }
  }
}

/* Build the [agentIdLen][agentId][utf8 bytes] frame, or null if id > 255. */
function buildBinaryFrame(data: string, agentId: string): Buffer | null {
  const agentBuf = Buffer.from(agentId, "utf-8");
  if (agentBuf.length > 255) return null;
  const dataBuf = Buffer.from(data, "utf-8");
  const header = Buffer.alloc(1 + agentBuf.length);
  header.writeUInt8(agentBuf.length, 0);
  agentBuf.copy(header, 1);
  return Buffer.concat([header, dataBuf]);
}

/* Unicast binary frame to one client only (scrollback replay on switch_agent
   must not leak into other connected tabs — Issue #7). */
function sendBinaryTo(ws: WebSocket, data: string, agentId: string) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const frame = buildBinaryFrame(data, agentId);
  if (!frame) {
    try { ws.send(JSON.stringify({ type: "terminal_data", agentId, data })); } catch {}
    return;
  }
  try { ws.send(frame, { binary: true }); } catch {}
}

// ── PTY Spawn ────────────────────────────────────────────────────

function getShell(): { shell: string; args: string[]; env?: Record<string, string> } {
  if (isWindows) {
    // Use ConPTY on Windows for better UTF-8 and rendering support
    return { shell: "cmd.exe", args: ["/d", "/s", "/c"] };
  }
  if (isMac) {
    return { shell: "/bin/zsh", args: ["-c"] };
  }
  return { shell: "/bin/bash", args: ["-c"] };
}

function spawnSession(agent: AgentDefinition): SessionRecord {
  const cfg = agentConfigs[agent.id];
  const args = cfg?.args?.length ? cfg.args : agent.args;
  const env = cfg?.env || {};
  const cwd = cfg?.cwd || workspaceDir;
  const fullCmd = buildCommand(agent.binary, args);

  const { shell, args: shellArgs } = getShell();
  const finalShellArgs = [...shellArgs, fullCmd];

  // Build environment with UTF-8 enforcement
  const baseEnv: Record<string, string> = {
    ...process.env,
    // UTF-8 encoding flags
    PYTHONIOENCODING: "utf-8",
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "1",
    CLICOLOR: "1",
    CLICOLOR_FORCE: "1",
  };

  // Windows-specific UTF-8 setup
  if (isWindows) {
    // chcp 65001 sets active code page to UTF-8
    // PowerShell UTF-8 output encoding
    baseEnv.CHCP = "65001";
  }

  let term!: ReturnType<typeof pty.spawn>;
  // pty.spawn() can throw (binary missing, bad working directory, ConPTY
  // failure). Fall back to a plain shell so the user always gets a usable
  // terminal, and tell the dashboard what went wrong.
  try {
    term = pty.spawn(shell, finalShellArgs, {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd,
    env: { ...baseEnv, ...env },
    // useConpty is essential on Windows 10+ for proper PTY behavior
    useConpty: isWindows,
  });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[SWITCHYARD] pty.spawn failed for "${agent.binary}": ${message}`);
    broadcast({
      type: "session_error",
      agentId: agent.id,
      message: `Could not start "${agent.binary}": ${message}. Opened a plain shell instead.`,
    });
    term = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: existsSync(cwd) ? cwd : workspaceDir,
      env: baseEnv,
      useConpty: isWindows,
    });
  }

  const record: SessionRecord = {
    pty: term,
    agent,
    scrollbackBuffer: [],
    lastActivity: Date.now(),
    rateLimited: false,
    crashCount: 0,
    exitCode: null,
  };

  // Restore saved scrollback
  const saved = loadSavedScrollback(agent.id);
  if (saved) {
    record.scrollbackBuffer = saved.split("\n").slice(-MAX_SCROLLBACK);
  }

  term.onData((data: string) => {
    record.lastActivity = Date.now();
    
    // Optimized scrollback: accumulate and flush in chunks
    if (!record._scrollbackAccum) {
      record._scrollbackAccum = "";
      record._scrollbackCount = 0;
    }
    
    record._scrollbackAccum += data;
    
    // Flush accumulated scrollback every 500ms or 4KB
    if (record._scrollbackAccum.length > 4096) {
      flushScrollback(record, agent.id);
    }
    
    // Rate limit detection - optimized single pass
    if (!record.rateLimited && RATE_LIMIT_PATTERNS.test(data)) {
      record.rateLimited = true;
      broadcast({
        type: "rate_limit_warning",
        agentId: agent.id,
        agentName: agent.name,
        message: `${agent.name} may be rate-limited. Consider switching to another agent.`,
        timestamp: Date.now(),
      });
    }
    
    // Send raw binary data to frontend for proper rendering
    broadcastBinary(data, agent.id);
  });

  // Flush scrollback accumulator
  function flushScrollback(record: SessionRecord, agentId: string) {
    if (!record._scrollbackAccum) return;
    
    const data = record._scrollbackAccum;
    record._scrollbackAccum = "";
    
    // Split into lines and add to buffer
    const lines = data.split("\n");
    for (const line of lines) {
      if (line.length > 0) {
        record.scrollbackBuffer.push(line);
        if (record._scrollbackCount !== undefined) record._scrollbackCount++;
      }
    }
    
    // Trim buffer if needed (efficient tail slice)
    if (record.scrollbackBuffer.length > MAX_SCROLLBACK) {
      record.scrollbackBuffer = record.scrollbackBuffer.slice(-MAX_SCROLLBACK);
    }
    
    // Persist to disk (debounced)
    saveScrollback(agent.id, data);
  }
  
  // Periodic flush of scrollback accumulator.
  // Stored on the record and cleared on exit/kill so sessions don't leak timers.
  record._flushTimer = setInterval(() => {
    if (record._scrollbackAccum) flushScrollback(record, agent.id);
  }, 1000);

  term.onExit(({ exitCode }) => {
    if (record._flushTimer) { clearInterval(record._flushTimer); record._flushTimer = undefined; }
    if (record._scrollbackAccum) flushScrollback(record, agent.id);
    record.lastActivity = Date.now();
    record.exitCode = exitCode;
    record.crashCount++;
    broadcast({ type: "session_killed", agentId: agent.id, exitCode, crashCount: record.crashCount });
    broadcast({ type: "notification", title: `${agent.name} stopped`, body: `Exit code: ${exitCode}`, agentId: agent.id });
    // Auto-restart if configured
    if (cfg?.autoRestart && record.crashCount < 3) {
      setTimeout(() => {
        delete sessions[agent.id];
        const a = agents.find((x) => x.id === agent.id);
        if (a && a.active) {
          trySpawn(a);
          broadcast({ type: "session_status", agentId: agent.id, status: "READY", pid: sessions[agent.id]?.pty.pid });
        }
      }, 2000);
    } else if (sessions[agent.id] === record) {
      /* No auto-restart configured: drop the dead record so the pane is not a
         black hole. The next keystroke (see the "input" handler) or clicking the
         agent spawns a fresh terminal instead of writing into a dead PTY. */
      delete sessions[agent.id];
    }
  });

  sessions[agent.id] = record;
  return record;
}

/* Spawning a PTY can fail (binary removed, bad working directory, ConPTY
   error). That must never take the whole hub down, nor leave the dashboard
   waiting on a blank pane - report the failure to the client instead. */
function trySpawn(agent: AgentDefinition, ws?: WebSocket): SessionRecord | null {
  try {
    return spawnSession(agent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[SWITCHYARD] failed to start "${agent.id}" (${agent.binary}): ${message}`);
    try { ws?.send(JSON.stringify({ type: "session_error", agentId: agent.id, message })); } catch {}
    return null;
  }
}


function killSession(agentId: string): boolean {
  const session = sessions[agentId];
  if (!session) return false;
  if (session._flushTimer) { clearInterval(session._flushTimer); session._flushTimer = undefined; }
  if (session._scrollbackAccum) {
    const acc = session._scrollbackAccum;
    session._scrollbackAccum = "";
    saveScrollback(agentId, acc);
  }
  try { session.pty.kill(); } catch {}
  delete sessions[agentId];
  return true;
}

function restartSession(agentId: string): SessionRecord | null {
  killSession(agentId);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent || !agent.active) return null;
  return trySpawn(agent);
}

// ── Custom agents (persisted) ────────────────────────────────────
// Custom agents used to live in memory only, so they vanished on every restart.

const CUSTOM_AGENTS_FILE = join(CONFIG_DIR, "custom-agents.json");

function loadCustomAgents(): AgentDefinition[] {
  try {
    if (!existsSync(CUSTOM_AGENTS_FILE)) return [];
    const raw = JSON.parse(readFileSync(CUSTOM_AGENTS_FILE, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((c: any) => c && c.id && c.name && c.binary)
      .map((c: any) => {
        const a = buildCustomAgent(c.id, c.name, c.binary, Array.isArray(c.args) ? c.args : []);
        if (typeof c.group === "string" && c.group) a.group = c.group;
        return a;
      });
  } catch {
    return [];
  }
}

function saveCustomAgents(): void {
  try {
    const custom = agents
      .filter((a) => a.tag === "CUSTOM")
      .map((a) => ({ id: a.id, name: a.name, binary: a.binary, args: a.args, group: a.group }));
    writeFileSync(CUSTOM_AGENTS_FILE, JSON.stringify(custom, null, 2));
  } catch {}
}

// ── Init ─────────────────────────────────────────────────────────

async function init() {
  loadConfigs();
  agents = [...(await scanAgents()), ...loadCustomAgents()];
  // Store last scan result for replay to new WebSocket connections
  lastScanResult = agents;
  // Apply groups and configs
  for (const a of agents) {
    a.group = agentConfigs[a.id]?.group || a.group || DEFAULT_GROUPS[a.id] || "Other";
    if (agentConfigs[a.id]) {
      if (agentConfigs[a.id].args?.length) a.args = agentConfigs[a.id].args;
    }
  }
  // Store initial session statuses for replay
  lastSessionStatuses = Object.entries(sessions).map(([id, s]) => ({
    agentId: id,
    status: "READY",
    pid: s.pty.pid,
    crashCount: s.crashCount,
  }));
  const active = agents.filter((a) => a.active).length;
  const free = agents.filter((a) => a.active && !a.requiresKey).length;
  console.log(`[SWITCHYARD] System scan: ${agents.length} agents listed, ${active} installed (${free} zero-cost / no API key)`);
}

// ── REST API ─────────────────────────────────────────────────────

app.get("/api/agents", (_req, res) => { res.json({ agents, workspaceDir }); });
app.get("/api/sessions", (_req, res) => {
  const info: Record<string, any> = {};
  for (const [id, s] of Object.entries(sessions)) {
    info[id] = { pid: s.pty.pid, lastActivity: s.lastActivity, rateLimited: s.rateLimited, bufferSize: s.scrollbackBuffer.length, crashCount: s.crashCount, exitCode: s.exitCode };
  }
  res.json(info);
});

app.get("/api/config/:agentId", (req, res) => {
  const cfg = agentConfigs[req.params.agentId] || { args: [], env: {}, cwd: workspaceDir, group: "Other", autoRestart: false };
  res.json(cfg);
});

app.get("/api/git-branch", async (req, res) => {
  const dir = (req.query.dir as string) || workspaceDir;
  const branch = await getGitBranch(dir);
  res.json({ branch });
});

app.get("/api/export/:agentId", (req, res) => {
  const session = sessions[req.params.agentId];
  if (!session) return res.status(404).json({ error: "No session" });
  const content = session.scrollbackBuffer.join("\n");
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.agentId}-log.txt"`);
  res.send(content);
});

app.get("/api/about", (_req, res) => {
  res.json({
    name: "APEX // Coder Hub",
    version: "1.0.5"
    author: "Blackjack",
    platform: platform(),
    nodeVersion: process.version,
    agentsTotal: agents.length,
    agentsActive: agents.filter((a) => a.active).length,
    sessionsActive: Object.keys(sessions).length,
    workspaceDir,
    dataDir: DATA_DIR,
  });
});

app.post("/api/agents/rescan", async (_req, res) => {
  const freshAgents = await scanAgents();
  const customOnly = agents.filter((a) => a.tag === "CUSTOM");
  agents = [...freshAgents, ...customOnly];
  for (const a of agents) {
    a.group = agentConfigs[a.id]?.group || a.group || DEFAULT_GROUPS[a.id] || "Other";
  }
  const statuses = agents.map(a => {
    const s = sessions[a.id];
    return { agentId: a.id, status: s ? (s.rateLimited ? "RATE-LIMITED" : "READY") : "OFFLINE", pid: s?.pty?.pid, crashCount: s?.crashCount };
  });
  lastSessionStatuses = statuses;
  broadcast({ type: "rescan_result", agents, statuses });
  res.json({ agents });
});

app.post("/api/agents/custom", async (req, res) => {
  const { id, name, binary, args = [], group = "Custom" } = req.body;
  if (!id || !name || !binary) return res.status(400).json({ error: "id, name, binary required" });
  const exists = await validateCustomBinary(binary);
  if (!exists.valid) return res.status(400).json({ error: `Binary "${binary}" not found` });
  if (agents.find((a) => a.id === id)) return res.status(409).json({ error: `"${id}" exists` });
  const agent = buildCustomAgent(id, name, binary, args);
  agent.group = group;
  agents.push(agent);
  saveCustomAgents();
  broadcast({ type: "custom_agent_added", agent });
  res.json({ agent });
});

// Delete a custom agent (Issue #2) — removes from memory, disk config, and per-agent settings.
app.delete("/api/agents/custom/:agentId", (req, res) => {
  const id = req.params.agentId;
  const idx = agents.findIndex((a) => a.id === id && a.tag === "CUSTOM");
  if (idx === -1) return res.status(404).json({ error: `"${id}" not found or not a custom agent` });
  killSession(id);
  agents.splice(idx, 1);
  delete agentConfigs[id];
  try { unlinkSync(join(CONFIG_DIR, `${id}.json`)); } catch {}
  saveCustomAgents();
  broadcast({ type: "custom_agent_removed", agentId: id });
  res.json({ ok: true, agentId: id });
});

app.post("/api/workspace", (req, res) => {
  const { dir } = req.body;
  if (!dir) return res.status(400).json({ error: "dir required" });
  if (!existsSync(dir)) return res.status(400).json({ error: `"${dir}" not found` });
  workspaceDir = dir;
  broadcast({ type: "workspace_changed", workspaceDir });
  res.json({ workspaceDir });
});

// ── WebSocket ────────────────────────────────────────────────────

wss.on("connection", (ws) => {
  wsClients.add(ws);
  // Replay last known state to new connection (fixes race condition)
  if (lastScanResult) {
    ws.send(JSON.stringify({ type: "rescan_result", agents: lastScanResult, workspaceDir }));
  }
  if (lastSessionStatuses) {
    for (const st of lastSessionStatuses) {
      ws.send(JSON.stringify({ type: "session_status", ...st }));
    }
  }
  ws.send(JSON.stringify({ type: "connected", text: "SWITCHYARD connected." }));
  ws.send(JSON.stringify({ type: "rescan_result", agents, workspaceDir }));
  for (const [id, s] of Object.entries(sessions)) {
    ws.send(JSON.stringify({ type: "session_status", agentId: id, status: "READY", pid: s.pty.pid, crashCount: s.crashCount }));
  }

  ws.on("message", async (raw) => {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case "input": {
        if (!msg.agentId || !msg.data) break;
        let session = sessions[msg.agentId];
        if (!session) {
          const agent = agents.find((a) => a.id === msg.agentId);
          if (!agent?.active) break;
          const spawned = trySpawn(agent, ws);
          if (!spawned) break; // trySpawn already reported the failure to the client
          session = spawned;
          ws.send(JSON.stringify({ type: "session_status", agentId: msg.agentId, status: "READY", pid: session.pty.pid }));
        }
        try {
          session.pty.write(msg.data);
        } catch (err) {
          // The PTY died underneath us - drop the stale session so the next
          // keystroke spawns a fresh one instead of throwing into the void.
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[SWITCHYARD] write to "${msg.agentId}" failed: ${message}`);
          delete sessions[msg.agentId];
          ws.send(JSON.stringify({ type: "session_status", agentId: msg.agentId, status: "DISCONNECTED" }));
        }
        break;
      }
      case "resize": {
        if (!msg.agentId || !msg.cols || !msg.rows) break;
        // Ignore degenerate sizes (a not-yet-laid-out pane used to shrink the
        // PTY to a couple of columns and crash TUI agents such as opencode).
        if (msg.cols < 20 || msg.rows < 5) break;
        try { sessions[msg.agentId]?.pty.resize(msg.cols, msg.rows); } catch {}
        break;
      }
      case "switch_agent": {
        if (!msg.agentId) break;
        let session = sessions[msg.agentId];
        if (!session) {
          const agent = agents.find((a) => a.id === msg.agentId);
          if (!agent?.active) break;
          const spawned = trySpawn(agent, ws);
          if (!spawned) break; // trySpawn already reported the failure to the client
          session = spawned;
          ws.send(JSON.stringify({ type: "session_status", agentId: msg.agentId, status: "STARTING", pid: session.pty.pid }));
        }
        // Send scrollback buffer to client for replay — only to the requester
        const buffer = session.scrollbackBuffer.join("\n");
        if (buffer) {
          sendBinaryTo(ws, buffer + "\n", msg.agentId);
        }
        ws.send(JSON.stringify({ type: "session_status", agentId: msg.agentId, status: "READY", pid: session.pty.pid }));
        break;
      }
      case "kill_session": {
        if (!msg.agentId) break;
        killSession(msg.agentId);
        broadcast({ type: "session_killed", agentId: msg.agentId });
        break;
      }
      case "restart_session": {
        if (!msg.agentId) break;
        const s = restartSession(msg.agentId);
        if (s) ws.send(JSON.stringify({ type: "session_status", agentId: msg.agentId, status: "STARTING", pid: s.pty.pid }));
        else ws.send(JSON.stringify({ type: "session_status", agentId: msg.agentId, status: "DISCONNECTED" }));
        break;
      }
      case "rescan": {
        const fresh = await scanAgents();
        const custom = agents.filter((a) => a.tag === "CUSTOM");
        agents = [...fresh, ...custom];
        for (const a of agents) a.group = agentConfigs[a.id]?.group || a.group || DEFAULT_GROUPS[a.id] || "Other";
        // Store updated session statuses for replay to new connections
        const statuses = agents.map(a => {
          const s = sessions[a.id];
          return { agentId: a.id, status: s ? (s.rateLimited ? "RATE-LIMITED" : "READY") : "OFFLINE", pid: s?.pty?.pid, crashCount: s?.crashCount };
        });
        lastSessionStatuses = statuses;
        broadcast({ type: "rescan_result", agents, statuses });
        break;
      }
      case "add_custom_agent": {
        if (!msg.agentId || !msg.name || !msg.binary) break;
        const v = await validateCustomBinary(msg.binary);
        if (!v.valid) { ws.send(JSON.stringify({ type: "custom_agent_error", message: `"${msg.binary}" not found` })); break; }
        if (agents.find((a) => a.id === msg.agentId)) { ws.send(JSON.stringify({ type: "custom_agent_error", message: `"${msg.agentId}" exists` })); break; }
        const a = buildCustomAgent(msg.agentId, msg.name, msg.binary, msg.args || []);
        a.group = "Custom";
        agents.push(a);
        saveCustomAgents();
        broadcast({ type: "custom_agent_added", agent: a });
        break;
      }
      case "delete_custom_agent": {
        if (!msg.agentId) break;
        const di = agents.findIndex((a) => a.id === msg.agentId && a.tag === "CUSTOM");
        if (di === -1) { ws.send(JSON.stringify({ type: "custom_agent_error", message: `"${msg.agentId}" not found or not custom` })); break; }
        killSession(msg.agentId);
        agents.splice(di, 1);
        delete agentConfigs[msg.agentId];
        try { unlinkSync(join(CONFIG_DIR, `${msg.agentId}.json`)); } catch {}
        saveCustomAgents();
        broadcast({ type: "custom_agent_removed", agentId: msg.agentId });
        break;
      }
      case "context_handoff": {
        if (!msg.agentId) break;
        const session = sessions[msg.agentId];
        if (!session) { ws.send(JSON.stringify({ type: "context_handoff_result", success: false, message: "No session" })); break; }
        const r = await triggerContextHandoff(workspaceDir, session.pty);
        ws.send(JSON.stringify({ type: "context_handoff_result", ...r }));
        break;
      }
      case "save_agent_config": {
        if (!msg.agentId || !msg.config) break;
        agentConfigs[msg.agentId] = { ...(agentConfigs[msg.agentId] || { args: [], env: {}, cwd: workspaceDir, group: "Other", autoRestart: false }), ...msg.config };
        saveConfig(msg.agentId);
        // Update agent definition
        const ag = agents.find((a) => a.id === msg.agentId);
        if (ag) {
          if (msg.config.args) ag.args = msg.config.args;
          if (msg.config.group) ag.group = msg.config.group;
        }
        ws.send(JSON.stringify({ type: "config_saved", agentId: msg.agentId, config: agentConfigs[msg.agentId] }));
        break;
      }
      case "get_agent_config": {
        if (!msg.agentId) break;
        const cfg = agentConfigs[msg.agentId] || { args: [], env: {}, cwd: workspaceDir, group: "Other", autoRestart: false };
        ws.send(JSON.stringify({ type: "config_loaded", agentId: msg.agentId, config: cfg }));
        break;
      }
      default:
        ws.send(JSON.stringify({ type: "error", message: "Unknown message type: " + msg.type }));
        break;
    }
  });

  ws.on("close", () => { wsClients.delete(ws); });
});

// ── Shutdown ─────────────────────────────────────────────────────

function shutdown(): void {
  console.log("\n  Shutting down APEX gracefully...");
  broadcast({ type: "server_shutdown" });
  for (const s of Object.values(sessions)) {
    try { s.pty.kill(); } catch {}
  }
  server.close(() => {
    console.log("  Server closed");
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => {
    console.error("  Force exit after timeout");
    process.exit(1);
  }, 5000);
}

app.post("/api/shutdown", (_req, res) => {
  res.json({ message: "Shutting down" });
  shutdown();
});

// A PTY / broadcast failure must never take the whole hub down with it.
process.on("unhandledRejection", (reason) => {
  console.error("[SWITCHYARD] Unhandled rejection:", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[SWITCHYARD] Uncaught exception:", err instanceof Error ? err.message : err);
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── Start ────────────────────────────────────────────────────────

init().then(() => {
  server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  ╔═══════════════════════════════════════════════╗");
  console.log("  ║    APEX // Coder Hub by Blackjack  v1.0.5  ║");
  console.log(`  ║   Port: ${String(PORT).padEnd(38)}║`);
  console.log(`  ║   Host: ${HOST.padEnd(38)}║`);
  console.log(`  ║   Workspace: ${workspaceDir.slice(0, 32).padEnd(32)}║`);
  console.log("  ╚═══════════════════════════════════════════════╝");
  console.log("");
  });
});

