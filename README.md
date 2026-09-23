# APEX // Coder Hub

**Multi-Agent Local Terminal Hub for CLI Coding Assistants**  
*By Blackjack | v1.0.5*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE
[![Release](https://img.shields.io/github/v/release/roarwing8/cli-coder-nexus)](https://github.com/roarwing8/cli-coder-nexus/releases)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![WebSocket](https://img.shields.io/badge/WebSocket-real--time-010101?logo=socketdotio&logoColor=white)](https://github.com/websockets/ws)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/roarwing8/cli-coder-nexus/pulls)

> Run **multiple AI coding agents side-by-side** in one dashboard — free CLIs only, zero API keys, local-first.

---

## Overview

APEX is a commercial-grade developer orchestrator that provides a unified dashboard for running multiple CLI AI coding agents side-by-side in isolated terminal sessions. Built with Node.js, xterm.js, and WebSocket-powered binary streaming, APEX delivers smooth terminal rendering with proper Unicode/box-drawing support across Windows, macOS, and Linux.

**No API keys required.** The default roster is limited to free, zero-setup CLIs
(opencode, freebuff, openclaude) - nothing in the dashboard ever prompts for a key.

## Screenshots

**Single agent — OpenCode TUI**

![Single agent view](docs/screenshot-single.png)

**Split view — OpenCode + Freebuff side-by-side**

![Split view](docs/screenshot-split.png)

**Command palette (Ctrl+K)**

![Command palette](docs/screenshot-palette.png)

---

## Features

### Terminal Rendering
- **Binary WebSocket Transport**: Raw byte streams from `node-pty` are streamed directly to xterm.js via `ArrayBuffer`, preventing UTF-8 multi-byte character corruption (no more white rectangle artifacts)
- **Unicode 11 Support**: Full box-drawing character and special glyph rendering via `@xterm/addon-unicode11`
- **Font Optimization**: Cascadia Code / JetBrains Mono / Fira Code with `letterSpacing: 0` for pixel-perfect alignment
- **Two-Pass Dimension Fitting**: Race-condition-free terminal sizing with debounced `fitAddon.fit()`

### Multi-Agent Orchestration
- **Session Registry**: In-memory session store keeps processes alive when switching tabs
- **Scrollback Buffer**: 500-line ring buffer per agent; buffered output replayed on agent switch
- **Process Lifecycle**: Clean `kill_session` and `restart_session` with proper file descriptor cleanup
- **Auto-Restart**: Configurable crash recovery with exponential backoff

### Context Handoff Engine
- Generates `.nexus_context.md` with `git status -s`, `git log -n 3 --oneline`, and capped `git diff HEAD` (4000 chars)
- Automatically adds context file to `.git/info/exclude` and `.gitignore`
- Sends safe single-line instruction to PTY: *"Please inspect .nexus_context.md for recent repository changes and resume the task."*

### Rate Limit Sentinel
- Real-time detection of token exhaustion signatures (`429`, `rate limit`, `quota exceeded`, `credits exhausted`, `daily limit`)
- Live UI notification banner suggesting agent switch

### Cross-Platform PTY
- **Windows**: `useConpty: true` with `chcp 65001` UTF-8 code page
- **macOS**: `/bin/zsh` with proper UTF-8 environment
- **Linux**: `/bin/bash` with `xterm-256color` terminal

### Dashboard UI
- Premium dynamic theme with glassmorphism effects, animated backgrounds, and sleek glass cards
- **APEX v1.0.4** branded header with premium *by Blackjack* styling
- Live status dots on agent cards (`ONLINE`, `BUSY`, `READY`)
- Sidebar showing **X of Y available** agents
- Tag chips: `ZERO-COST`, `NEEDS-KEY`, `SIGN-IN`, `ROUTER` (click any card to see the exact tag), `FREE-GATEWAY`, `CUSTOM`

---

## System-Wide Auto-Discovery

APEX scans every directory on your `PATH` on startup and on demand (hit **Rescan**
or `Ctrl+R`). It lists every known AI coding CLI it finds, grouped by what it
costs so you know what to expect before you click:

- **Zero-Cost** (`ZERO-COST`) — no API key, no sign-in at all:
  `opencode`, `freebuff`, `openclaude`, `omniroute`.
- **Needs Account / Needs Key** (`NEEDS-KEY`, `SIGN-IN`) — these prompt for a
  login or an API key, and they are only listed when the binary is actually on
  your machine (e.g. `claude`, `pool`, `cline`, `aider`, `goose`, `cursor-agent`,
  `gemini`, `qwen`, `codex`, `crush`, `amp`, `copilot`, `sgpt`, `llm`, `mods`).

The dashboard **never** auto-starts a "Needs Account" CLI - type into it (or
double-click the card) only when you want it, and you will be warned first. Edit a
card (double-click) to set args / env - that is also where an API key would go, if
you ever have one. Custom agents you add via **+ Add Custom CLI** are persisted to
`~/.switchyard/config/custom-agents.json` and survive restarts.
- Top actions: **📋 Context Handoff**, **⚡ Rescan System**, **+ Add Custom CLI**
- Bottom status strip with project directory and Git branch

---

## Installation

```bash
# Clone and install dependencies
npm install

# Build TypeScript
npm run build

# Start the server
npm start
```

Or for development with hot reload:

```bash
npm run dev
```

The dashboard will be available at `http://localhost:3777`.

---

## Usage

### Selecting an Agent
1. Click an agent card in the sidebar, or
2. Use `Ctrl+1` through `Ctrl+8` to switch to agents by index

### Split View
- **Horizontal split**: Click ⬌ or press the split button
- **Vertical split**: Click ⬍
- **Close pane**: Click the ✕ button on the pane or press `Ctrl+W`
- Maximum 4 simultaneous panes

### Context Handoff
Click the **📋 Handoff** button (or use Command Palette `Ctrl+K` → "Context Handoff") to:
1. Generate a `.nexus_context.md` file with current git state
2. Send an instruction to the active agent's terminal

### Adding Custom Agents
1. Click **+ Add** in the sidebar
2. Enter Agent ID, Display Name, Binary path, and optional arguments
3. The binary is validated via `which`/`where` before saving

### Agent Configuration
Double-click an agent card to open its settings:
- Custom arguments (space-separated)
- Working directory override
- Environment variables (KEY=VALUE, one per line)
- Group assignment
- Auto-restart on crash toggle

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      public/index.html                      │
│  ┌─────────────┐  ┌──────────────────────────────────────┐ │
│  │   Sidebar   │  │         xterm.js Terminal           │ │
│  │  Agent Deck │  │  (Unicode 11, FitAddon, Search)     │ │
│  │  Theme Swch │  │                                      │ │
│  └─────────────┘  └──────────────────────────────────────┘ │
└────────────────────────────┬────────────────────────────────┘
                             │ WebSocket (binary + JSON)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                      src/server.ts                          │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Express    │  │  WebSocket   │  │  node-pty Spawner │  │
│  │  REST API   │  │  Server      │  │  (ConPTY/WinPTY)  │  │
│  └─────────────┘  └──────────────┘  └───────────────────┘  │
│                                      ┌─────────────────────┐│
│  ┌───────────────────────────────────┤  Session Registry   ││
│  │  src/scanner.ts  src/gitHelper.ts │  (in-memory + disk) ││
│  └───────────────────────────────────┤  Scrollback Buffer  ││
│                                      └─────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents` | List all detected agents |
| `GET` | `/api/sessions` | Active session info (PID, activity, buffer size) |
| `GET` | `/api/config/:agentId` | Agent configuration |
| `GET` | `/api/git-branch` | Current Git branch for workspace |
| `GET` | `/api/export/:agentId` | Download scrollback as `.txt` |
| `GET` | `/api/about` | Server info (version, platform, stats) |
| `POST` | `/api/agents/rescan` | Re-scan for available binaries |
| `POST` | `/api/agents/custom` | Register a custom agent |
| `DELETE` | `/api/agents/custom/:id` | Remove a custom agent |
| `POST` | `/api/workspace` | Change workspace directory |
| `POST` | `/api/shutdown` | Graceful server shutdown |

---

## WebSocket Messages

### Client → Server
- `input` - Send keystrokes to agent PTY
- `resize` - Notify PTY of terminal dimension change
- `switch_agent` - Activate agent session (replays scrollback)
- `kill_session` - Terminate agent process
- `restart_session` - Restart agent process
- `rescan` - Trigger agent re-scan
- `add_custom_agent` - Register new custom agent
- `delete_custom_agent` - Remove a custom agent
- `context_handoff` - Generate and send context report
- `save_agent_config` / `get_agent_config` - Persist config

### Server → Client
- `connected` - Initial connection confirmation
- `rescan_result` - Agent list after scan
- `session_status` - Agent session state changes
- `rate_limit_warning` - Rate limit detection alert
- `session_killed` - Session termination notice
- `custom_agent_added` - New custom agent registered
- `context_handoff_result` - Context handoff outcome
- `workspace_changed` - Workspace directory update
- `server_shutdown` - Server is stopping

### Binary Frames
Terminal output is sent as binary WebSocket frames:
```
[agentIdLength:1][agentId:N][raw_bytes:N]
```
Parsed on the client as:
```javascript
const idLen = view[0];
const agentId = new TextDecoder().decode(view.slice(1, 1 + idLen));
const textData = new TextDecoder().decode(view.slice(1 + idLen));
term.write(textData);
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3777` | Server listen port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only if you intentionally want LAN access |
| `TARGET_DIR` | `process.cwd()` | Default workspace directory |

---

## Agent Registry (Enported)

APEX ships with **zero-cost agents only** by default - none of them needs an API
key:

| ID | Name | Tag | Color | Why it's free |
|----|------|-----|-------|---------------|
| `opencode` | OpenCode TUI | ZERO-COST | #d97706 | Free models via OpenCode Zen |
| `freebuff` | Freebuff AI Agent | ZERO-COST | #06b6d4 | Free tier, no key required |
| `openclaude` | OpenClaude Client | ZERO-COST | #f97316 | Gitlawb OpenGateway (free endpoint) |
| `omniroute` | OmniRoute Router | ROUTER | #f472b6 | Local router (configure a provider if you want remote models) |

The dashboard then **auto-discovers** every other known AI CLI that is actually
installed on your machine (see *System-Wide Auto-Discovery* above), grouped as
zero-cost or needs-an-account, with no API keys required. To bring back any of the
credentials-based CLIs yourself, add it via the **+ Add Custom CLI** button (e.g.
id `claude`, binary `claude`), then double-click the card to set args / env (that
is also where an API key would go, if you ever have one).

---

## Storage

Session data is persisted to `~/.switchyard/`:
```
~/.switchyard/
├── sessions/          # Per-agent scrollback logs (.log files)
└── config/           # Per-agent JSON configurations
```

---

## Keyboard Shortcuts

| Keys | Action |
|------|--------|
| `Ctrl+K` / `Cmd+K` | Focus agent search |
| `Ctrl+R` / `Cmd+R` | Rescan agents |
| `Escape` | Clear search / Close overlays |

---

## Testing

Run the built-in test suite:

```bash
npm test
```

16+ tests cover scanner logic (PATH scanning, binary validation, agent
definitions), server logic (message types, rate-limit patterns), and shell
argument escaping (injection defense).

```bash
# Watch mode
npm run test:watch
```

---

## Project status

> ⚠️ **Work in progress** — the product is not fully production-ready yet. Known rough edges are tracked in [Issues](https://github.com/roarwing8/cli-coder-nexus/issues). Found a bug? Please [open an issue](https://github.com/roarwing8/cli-coder-nexus/issues/new/choose) — or jump in and fix it with us.

## Contributing

Issues and pull requests are welcome — especially while we're hardening the product. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, guidelines, and where to help.

- 🐛 [Report a bug](https://github.com/roarwing8/cli-coder-nexus/issues/new?template=bug_report.md)
- 💡 [Request a feature](https://github.com/roarwing8/cli-coder-nexus/issues/new?template=feature_request.md)
- 🙌 Browse [`help wanted`](https://github.com/roarwing8/cli-coder-nexus/issues?q=label%3A%22help+wanted%22) issues

## License

MIT — see [LICENSE](LICENSE). Free to use, modify, and distribute.

---

## Credits

- **node-pty** - Native PTY spawning for Windows, macOS, and Linux
- **xterm.js** - Terminal emulator frontend
- **Express** + **ws** - HTTP and WebSocket server
- **Tailwind CSS** - Utility-first styling (CDN)

---

*Built with ❤️ by Blackjack*
