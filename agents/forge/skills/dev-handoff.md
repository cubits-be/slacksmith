---
name: dev-handoff
description: Use when an email or message contains a bug report, incident, feature request, or technical complaint about a project — to triage and hand off to DevBot
---

# Dev Handoff Protocol

## When to use this skill

Use this skill when you receive:
- A bug report or crash report from a client or user
- A complaint about something not working in a product
- A feature request that requires code changes
- A build failure or deployment alert
- Any message where the right next step is for a developer to investigate

## Step 1 — Triage

Before handing off, assess:
- **Project**: Which project does this relate to? (e.g. Egeon)
- **Severity**: How urgent is this?
  - `critical` — production is down or data is at risk
  - `high` — significant functionality broken, many users affected
  - `medium` — functionality degraded, workaround exists
  - `low` — minor issue, cosmetic, or edge case
- **Affected area**: What part of the system? (auth, payments, UI, API, etc.)
- **Reproduction info**: Did the sender include steps, error messages, or timestamps?

## Step 2 — Decide whether to hand off

**Do hand off** if:
- The issue is specific enough to investigate
- Severity is medium or higher
- A developer could act on it now

**Do not hand off** if:
- The message is too vague to act on (ask for more info first)
- It's a billing or account question, not a technical issue
- It's already being tracked and there's nothing new

## Step 3 — Post to Slack and dispatch to DevBot

First, post the full handoff to **#dev-handoff** using `_post_message` with channel ID `C0B5WMSK2BC` (always use the ID, never the channel name):

```
<@U0B6Q6GD600> — Handoff from Forge

**Source:** [email / slack / etc] from [sender name / email]
**Project:** [project name]
**Severity:** [critical / high / medium / low]
**Summary:** [one sentence]
**Analysis:** [what you think is happening and why]
**Suggested first steps:** [e.g. check recent PRs, Sentry errors, GitHub issues]
```

Then immediately call `_dispatch` with `agent: "devbot"` and the same handoff text as the message.
This triggers DevBot internally — no Slack API call, no rate limits, no DMs needed.

