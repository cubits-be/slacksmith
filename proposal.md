# 🔨 Slacksmith

**A personal Slack interface for LLMs and MCP tools — plain-text memory, zero external databases.**

**Stack:** Node.js · TypeScript · Docker Compose

---

## 1. Purpose

Slacksmith turns Slack into a personal AI workspace. You DM agents directly; they respond using LLMs and can invoke any MCP tool you've configured. Agents remember context across conversations, run autonomous tasks on a schedule you define in plain text, and collaborate with each other via Slack.

**Core use cases:**

- Talk to an LLM through Slack DMs without switching apps
- Trigger MCP tools via natural language ("check my GitHub notifications", "search the web for X")
- Let agents run background tasks on your behalf ("send me a summary at 6pm")
- Each agent has a distinct persona and tool set, accessed as a separate Slack bot

**This is a personal tool** — there is one user (you). The design optimises for low setup friction and long-term maintainability over scalability or team features.

---

## 2. High-Level Architecture

```
  Your Slack Workspace
  ┌────────────────────────────────────────────┐
  │   DM @forge       DM @sage       ...       │
  └───┬───────────────┬────────────────────────┘
      │ Socket Mode    │ Socket Mode
      ▼                ▼

               Slacksmith Container               │
                                                 │
   ┌─────────────┐   ┌─────────────┐             │
   │ Forge Agent │   │  Sage Agent │   ...        │
   │ (own token) │   │ (own token) │             │
   └──────┬──────┘   └──────┬──────┘             │
          │                 │                    │
          ▼                 ▼                    │
  │   ┌───────────────
   │           Shared Core Services           │  │
   │   - LLM client                           │  │
   │   - MCP client + server registry         │  │
   │   - Task runner (15-min tick)            │  │
   │   - Plain-text memory system             │  │
   └──────────────────────────────────────────┘  │

                       │
                       ▼
         ┌──────────────────────────────┐
         │      Memory (bind mount)     │
         │  memory/                     │
         │  ├── context.md              │
         │  └── agents/                 │
         │      ├── forge/              │
         │      │   ├── TASKS.md        │
         │      │   ├── STATE.md        │
         │      │   ├── daily/  (.txt)  │
         │      │   └── notes/  (.md)   │
         │      └── sage/               │
         │          ├── TASKS.md        │
         │          ├── STATE.md        │
         │          ├── daily/          │
         │          └── notes/          │
         └──────────────────────────────┘
```

---

## 3. Agents

### 3.1 Start Small

Slacksmith ships with **one default general-purpose agent**. Add more only when you find you want a genuinely different persona or tool set. Each additional agent requires creating a new Slack App (two tokens) — not difficult, but real overhead.

**Default agent:**

| Bot | Handle | Role |
|---|---|---|
| 🔨 Forge | `@forge` | General assistant, code help, MCP tools |

**Example additions:**

| Bot | Handle | Role |
|---|---|---|
| 🧠 Sage | `@sage` | Research, web search, document work |
| 🤖 Sentinel | `@sentinel` | Autonomous monitoring, scheduled checks |

### 3.2 One Slack App per Agent

Each agent is a separate Slack App with its own identity (name, avatar, bot token). This means:

- You DM each agent individually — primary interaction is DM, not channels
- Agents can post to channels autonomously (summaries, alerts)
- Agents mention each other in Slack when handing off — no internal API needed
- Each agent only handles its own mentions and DMs

**Agent config:**

```typescript
interface AgentConfig {
  id: string;                  // e.g. "forge"
  name: string;                // e.g. "Forge"
  slackBotToken: string;       // SLACK_BOT_TOKEN_FORGE
  slackAppToken: string;       // SLACK_APP_TOKEN_FORGE
  persona: string;             // system prompt
  tools: string[];             // MCP tool names this agent can use
  model?: string;              // overrides LLM_MODEL default
}
```

### 3.3 Agent Runtime

All agents start concurrently in a single Node.js process:

```typescript
// src/index.ts
await Promise.all([
  new ForgeAgent().start(),
  new SageAgent().start(),
]);
```

Each agent runs its own Bolt app instance. Node.js's event loop handles them concurrently.

---

## 4. Slack UX

### 4.1 Primary Interface: DM

The main way to use Slacksmith is to **DM an agent directly**. Agents also respond to `@mention` in channels, useful for autonomous posts or cross-agent collaboration.

### 4.2 Message Handling

Slack doesn't support true word-by-word streaming (the `chat.update` rate limit is ~1/sec). Instead, Slacksmith uses a **post-then-update** pattern that gives immediate feedback without a wall of silence:

1. Agent posts `⏳ thinking…` immediately on receipt — you know it's working
2. For each tool call, the message is updated: `🔧 running github_search…`
3. Final response replaces the status message in-place via `chat.update`

This gives meaningful progress visibility, especially for multi-tool chains.

| Scenario | Behaviour |
|---|---|
| Response < 3 000 chars | Updates the "thinking" message in-place |
| Response ≥ 3 000 chars | Posts first 500 chars in-place, full response uploaded as a Slack snippet |
| Tool call in progress | Status message updated per tool: `🔧 running \`tool_name\`…` |
| Tool result > 2 000 chars | Result summarised inline; full output saved to file, path shared |
| Error | Error posted clearly in-place with suggested next steps |

### 4.4 Code and Structured Output

- Code blocks rendered with Slack triple-backtick formatting
- File diffs, logs, and large structured outputs uploaded as Slack snippets
- Lists and markdown rendered using Slack's mrkdwn format

---

## 5. MCP Integration

MCP is a first-class concern — the primary reason to use Slacksmith over a web chat interface is that agents can invoke real tools on your behalf.

### 5.1 Server Configuration

MCP servers are defined in `mcp.config.json` at the repo root. Each server has a name, transport, and optional per-agent access list.

```json
{
  "servers": [
    {
      "name": "filesystem",
      "transport": "http",
      "url": "http://localhost:3001"
    },
    {
      "name": "github",
      "transport": "http",
      "url": "http://localhost:3002"
    },
    {
      "name": "web-search",
      "transport": "http",
      "url": "http://localhost:3003"
    }
  ]
}
```

HTTP transport means MCP servers are just URLs — no child processes, no lifecycle management, no crash recovery needed on Slacksmith's side. Servers run independently and are queried over HTTP.

Each agent's config declares which servers it can access via the `tools` list. If omitted, the agent has access to all servers.

### 5.2 Tool Discovery

On startup, the MCP client connects to each configured server and fetches its tool manifest. Tools are made available to the LLM via function-calling. No code changes are needed to add new tools — edit `mcp.config.json` and restart.

### 5.3 Large Tool Results

MCP tools can return large payloads (file contents, API responses, search results). Strategy:

1. If result ≤ 2 000 chars → include directly in LLM context
2. If result > 2 000 chars → save to a temp file, pass a truncated summary + file path to the LLM
3. LLM decides whether to read the full file or work from the summary

---

## 6. Memory System (Plain Text)

All memory is stored as plain text files on a bind-mounted volume. Files load directly into LLM context — no serialization, no transformation, no database.

### 6.1 Personal Context (`context.md`)

A single file at `memory/context.md` — **read by all agents** at the start of every conversation. Contains your personal context: who you are, your projects, preferences, and anything you want every agent to always know.

```markdown
# Context

- Name: Ives
- Main projects: slacksmith, internal API, blog
- Preferred language: TypeScript
- Current focus: shipping slacksmith v1
- Notes: I prefer concise answers unless I ask for detail
```

You maintain this file manually. Agents can suggest additions but will not edit it autonomously.

### 6.2 Session Journal (Daily Log)

- **Format:** `.txt` with `[ME timestamp]` / `[AGENT timestamp]` markers
- **Path:** `memory/agents/<agentId>/daily/YYYY-MM-DD.txt`
- One file per agent per day — a chronological log of your conversations with that agent
- Loaded as real-time context; gives the agent continuity across the day
- Writes are serialized through a **per-agent async queue** — rapid concurrent messages never corrupt the file

```
[ME 2026-05-22T09:00:00Z]
Can you review the auth PR?

[FORGE 2026-05-22T09:00:04Z]
Reviewed. Three issues: missing error handling on line 42...

[ME 2026-05-22T11:30:00Z]
What was wrong with that PR again?

[FORGE 2026-05-22T11:30:03Z]
The auth PR had three issues — missing error handling on line 42...
```

### 6.3 Agent Notes (Long-Term)

- **Format:** Markdown (`.md`), one file per topic
- **Path:** `memory/agents/<agentId>/notes/<topic>.md`
- Written by the agent when you ask it to remember something, or when you trigger a manual distillation
- Read at context load time as background knowledge

```
memory/agents/forge/notes/
  projects/slacksmith.md   ← architecture decisions, current status
  projects/api.md          ← known issues, design notes
```

### 6.4 Manual Distillation

There is no automatic nightly distillation job. Instead, you trigger it explicitly:

- *"Forge, summarise this week and save anything useful to your notes"*
- Or add a distillation task to `TASKS.md` (e.g., "every Sunday evening, review the week's logs and update notes")

This keeps the system simple and gives you control over what gets persisted. Daily logs older than **14 days are deleted automatically** by a lightweight cleanup cron — no LLM call needed.

### 6.5 Context Loading

Memory is loaded in priority order until an **8 000-character budget** is reached:

1. `context.md` (always loaded first)
2. Today's session journal
3. Yesterday's session journal (if budget allows)
4. Agent notes (most recently modified first)

---

## 7. Task System (TASKS.md + STATE.md)

Each agent has two files for autonomous behaviour:

- **`TASKS.md`** — plain-English task definitions. Committed to git. Edited by you directly, or by the agent when you ask it to add/change a task via Slack.
- **`STATE.md`** — runtime record of when tasks last ran. Gitignored. Written only by the agent.

A **15-minute tick** reads both files and asks the LLM whether anything is due.

**`memory/agents/forge/TASKS.md`:**

```markdown
# Forge — Tasks

- Check GitHub notifications every 2 hours; DM me if anything needs attention
- Send me a summary of what we worked on today at approximately 6pm
- Every Sunday evening, review this week's session logs and update notes/
```

**`memory/agents/forge/STATE.md`:**

```markdown
- Last GitHub check: 2026-05-22T14:00:00Z
- Last EOD summary: 2026-05-21T18:02:00Z
- Last weekly review: 2026-05-18T19:45:00Z
```

**On each tick:**

```
Current time: 2026-05-22T16:03:00Z  (Thursday)

Given your tasks (TASKS.md) and when they last ran (STATE.md),
is there anything due right now? If yes, describe the action.
If no, reply NOTHING.
```

The LLM reasons naturally — *"GitHub check was 2h ago, that's due"*, *"EOD summary is for 6pm, it's 4pm, skip"*. After running a task, the agent updates `STATE.md` only.

**You can update tasks via Slack:**
> *"Forge, check GitHub every hour instead of every 2 hours"*
> → agent rewrites `TASKS.md` and confirms the change

---

## 8. Development

Hot reloading is handled by `ts-node-dev` — the process restarts automatically on any TypeScript file change.

```bash
# Install
npm install

# Run with hot reload
npm run dev        # ts-node-dev --respawn src/index.ts

# Lint / type-check
npm run typecheck  # tsc --noEmit
```

Since Socket Mode is used, there's no need for a tunnel or public URL during development. Run the app locally and it connects to your Slack workspace directly.

**Dev Slack workspace:** no dedicated workspace is needed — run Slacksmith bots in your existing workspace. Recommend a private `#slacksmith-dev` channel for testing autonomous posts so they don't pollute other channels.

---

## 9. Docker

Single container. Memory is a bind mount — files are directly readable and editable on the host.

```yaml
services:
  slacksmith:
    build: .
    env_file: .env
    volumes:
      - ./memory:/app/memory
      - ./mcp.config.json:/app/mcp.config.json:ro
    restart: unless-stopped
```

---

## 10. Environment Variables

```env
# LLM
OPENAI_API_KEY=sk-...
LLM_MODEL=gpt-4o

# MCP tool credentials
GITHUB_TOKEN=ghp-...
BRAVE_API_KEY=...

# Forge
SLACK_BOT_TOKEN_FORGE=xoxb-...
SLACK_APP_TOKEN_FORGE=xapp-...

# Sage (if added)
SLACK_BOT_TOKEN_SAGE=xoxb-...
SLACK_APP_TOKEN_SAGE=xapp-...
```

---

## 11. Project Structure

```
mcp.config.json                    ← MCP server definitions
memory/
 context.md                     ← your personal context (committed)
 agents/
    └── forge/
        └── TASKS.md               ← committed seed

src/
 index.ts                       ← starts all agents concurrently
 agents/
   ├── base/
   │   ├── SlacksmithAgent.ts     ← abstract base class
   │   └── types.ts
   ├── forge/
   │   ├── index.ts
   │   └── persona.ts
   └── sage/
       ├── index.ts
       └── persona.ts
 memory/
   ├── MemorySystem.ts            ← load context budget
   ├── DailyLog.ts                ← read/write/cleanup daily .txt
   └── Notes.ts                   ← read/append .md notes
 mcp/
   ├── McpRegistry.ts             ← reads mcp.config.json, connects servers
   ├── McpClient.ts               ← executes tool calls
   └── resultHandler.ts           ← large result truncation + file save
 tasks/
   └── TaskRunner.ts              ← 15-min tick + TASKS/STATE management
 slack/
   └── formatting.ts              ← long message splitting, code blocks
 llm/
   ├── client.ts
   └── prompts.ts
 core/
    ├── types.ts
    └── config.ts
```

---

## 12. Agent Lifecycle

```
 1. Container starts; memory/ bind mount and mcp.config.json available
 2. MCP registry connects to all configured servers, fetches tool manifests
 3. Seed context.md and TASKS.md files if not present
 4. All agents start concurrently via Promise.all
 5. Each agent connects to Slack via Socket Mode (own token)
 6. TaskRunner starts 15-minute tick loop
 7. ─── DM or mention arrives ───
 8. Load context: context.md → today's log → yesterday's log → notes (8k budget)
 9. LLM called with full context + available MCP tools
10. MCP tools invoked as needed; large results saved to file
11. Response formatted and posted to Slack
12. Turn appended to today's session journal
13. ─── every 15 minutes ───
14. TaskRunner reads TASKS.md + STATE.md
15. LLM decides if any task is due
16. If yes: task executed, STATE.md updated
17. ─── daily cleanup ───
18. Session journals older than 14 days deleted (no LLM call)
```

---

## 13. Adding a New Agent

1. Create a Slack App at [api.slack.com](https://api.slack.com) — enable Socket Mode, add `app_mentions:read`, `chat:write`, `im:history` scopes
2. Add its tokens to `.env`
3. Create `src/agents/<name>/index.ts` and `persona.ts`
4. Register it in `src/index.ts`
5. Commit `memory/agents/<name>/TASKS.md`

---

## 14. Key Design Decisions

| Decision | Rationale |
|---|---|
| **Personal-first design** | Single user; optimises for low setup friction over team features |
| **DM as primary UX** | Natural for personal use; channels used for autonomous posts only |
| **MCP as first-class** | Core value prop — tool invocation via natural language; config-driven, no code changes to add tools |
| **`context.md` instead of shared memory** | One file captures all personal context; shared memory was a team concept |
| **Manual distillation** | Low message volume makes automatic distillation unnecessary; you control what gets persisted |
| **14-day log retention** | Simple cleanup with no LLM cost; keeps storage lean |
| **Start with one agent** | Each additional Slack App is real setup overhead; add agents when you have a genuine need |
| **TASKS.md + STATE.md split** | Clean separation of intent (git-tracked, editable) vs. runtime state (gitignored, agent-only) |
| **Plain text throughout** | Zero transformation into LLM context; human-readable, editable, version-controllable |
| **Bind mount for memory** | Files directly inspectable and editable on the host without entering the container |
| **Socket Mode** | No public HTTP endpoint; works behind firewalls and locally |
| **HTTP MCP transport** | Servers are independent URL endpoints — no child process management or crash recovery needed |
| **Per-agent write queue** | Serializes file writes per agent — safe under rapid concurrent messages without locks |
| **Post-then-update UX** | Immediate `⏳ thinking…` post gives feedback; in-place update avoids message spam |
