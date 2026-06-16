# Slacksmith

A personal Slack-based LLM assistant with MCP tool integration. Each agent runs as its own Slack bot, configured from its own directory under `agents/`.

## Getting started

1. Copy `.env.example` to `.env` and fill in shared config (MCP URL, OpenAI key, etc.)
2. For each agent, copy `agents/<id>/.env.example` to `agents/<id>/.env` and add its Slack tokens
3. Start with Docker: `docker compose up`

## Adding a new agent

1. Create `agents/<id>/` directory
2. Add `agent.json` — minimum: `{ "name": "MyBot" }`
3. Add `.env` with `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
4. Optionally add `PERSONA.md`, `TASKS.md`, and `skills/*.md`
5. Restart — the agent is auto-discovered on startup

Use `slack-app-manifest.yml` as a template when creating the Slack app.

## Agent directory structure

```
agents/
  context.md              # shared personal context (all agents load this)
  tmp/                    # rate limit dumps, temp files
  <id>/
    agent.json            # name, model, allowedTools, excludedTools
    .env                  # SLACK_BOT_TOKEN, SLACK_APP_TOKEN
    .env.example
    PERSONA.md            # system prompt, hot-reloaded on every message
    TASKS.md              # scheduled autonomous tasks
    skills/               # on-demand skill files (loaded by LLM when relevant)
      *.md
    daily/                # conversation logs
    notes/                # persistent notes
```

## Skills

Skills are `.md` files in `agents/<id>/skills/` with YAML frontmatter:

```markdown
---
name: my-skill
description: Short description shown to the LLM so it knows when to load this skill
---

Full skill instructions here...
```

The agent sees all skill names and descriptions at all times via the `_read_skill` tool. It loads the full content on demand when the task matches. This keeps the system prompt lean while still providing detailed workflow instructions when needed.

## MCP tools

Agents call external services via an MCP hub. Tools are namespaced by server (e.g. `tars-hub-gmail__draft_email`).

Use `allowedTools` (allowlist) or `excludedTools` (blocklist) in `agent.json` to restrict which tools an agent can access. Entries support exact names or wildcard prefixes (e.g. `"github__*"`). Prefer `allowedTools` for tight control (e.g. DevBot only needs GitHub and Sentry tools).

### ⚠️ Conflicting Slack tools when using an MCP hub

If your MCP hub exposes Slack tools (e.g. `tars-hub-slack__slack_post_message`), be aware:

- Those tools use the **hub's Slack token**, not the individual bot's token
- All agents calling those tools will appear to come from the **same Slack identity** (the hub bot)
- Asking "what channels am I in?" via MCP will return the hub's channels, not the bot's

Slacksmith provides native internal tools instead — `_post_message` and `_list_channels` — which use each agent's own Slack token so messages are posted with the correct bot identity.

**To avoid this conflict, exclude MCP Slack tools in each agent's `agent.json`:**

```json
{
  "name": "MyBot",
  "excludedTools": ["tars-hub-slack__*"]
}
```

The `_post_message` internal tool supports posting to any channel or DM, with optional thread replies. Use `_list_channels` to discover channel IDs the bot has been invited to.

## Scheduled tasks

Define tasks in `agents/<id>/TASKS.md`:

```markdown
## task-slug
schedule: every 1h
action: What the agent should do when this task fires
```

Supported schedule formats: `every 30m`, `every 2h`, `every 1d`, `daily 18:00`, `every 1h between 8AM and 10PM`.

## Rate limit handling

On a 429 response from the LLM API, the full request payload is saved to `agents/tmp/ratelimit-<timestamp>.json` for analysis. Includes a `_meta` block with estimated token counts.

### Circuit breaker

To prevent runaway spend on rate limit storms, a circuit breaker is built into the LLM client. After N consecutive 429 responses, all LLM requests are blocked for a cooldown period. Configurable via `.env`:

```
LLM_CIRCUIT_TRIP=5          # consecutive 429s before opening the circuit
LLM_CIRCUIT_COOLDOWN_MS=60000  # cooldown in ms before retrying
LLM_MAX_RETRIES=3            # retries per individual request before giving up
```

The circuit breaker is process-wide — a 429 from any agent increments the shared counter. This prevents all agents from hammering the API simultaneously during a quota storm.

## Agent-to-agent communication (AgentBus)

Agents can hand off work to each other in-process without going through Slack. The `AgentBus` singleton lets any agent dispatch a message to another:

```
_dispatch({ agent: "devbot", message: "Investigate this report: ..." })
```

The receiving agent runs its full LLM + tools loop silently (no "thinking…" status messages). It is responsible for posting its own output to Slack via `_post_message` as instructed by its skills and PERSONA.

**Design principle:** the framework provides only primitives (`_dispatch`, `_post_message`, `processSilently`). All workflow logic — ack messages, investigation steps, findings formatting — lives in the agent's skills and PERSONA. This keeps the framework decoupled from any specific workflow.
