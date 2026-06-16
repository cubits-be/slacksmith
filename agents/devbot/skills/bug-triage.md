---
name: bug-triage
description: Use when investigating a reported bug — to systematically check issue tracker, recent commits, open PRs, and Sentry errors
---

# Bug Triage Protocol

## Step 1 — Acknowledge

Post an ack to **#dev-handoff** (ID: `C0B5WMSK2BC`) using `_post_message`:
```
```

## Step 2 — Understand the report

Before touching any tools, re-read the handoff:
- What is the reported behaviour?
- What is the expected behaviour?
- Which project and which area of the system?
- Is there a timestamp, error message, or user ID to search for?

## Step 3 — Check the issue tracker

Search GitHub issues for the project:
- Look for existing open issues matching the description
- If a duplicate exists, note the issue number and link

## Step 4 — Check recent activity

Look at recent commits and merged PRs (last 7 days):
- Did anything ship recently that could have caused this?
- Look for changes in the affected area of the codebase

## Step 5 — Check Sentry

Search for errors matching the described behaviour:
- Use the error message or affected route as search terms
- Note: first seen, last seen, frequency, affected users

## Step 6 — Post findings

Post your findings to **#dev-handoff** (ID: `C0B5WMSK2BC`) using `_post_message`:

```
**Bug Triage: [short title]**

**Likely cause:** [your assessment]
**Evidence:** [Sentry link / commit / PR that supports your theory]
**Existing issue:** [GitHub issue # if found, or "none"]
**Recommended action:** [fix X / revert commit Y / needs more info from user]
**Confidence:** [high / medium / low]
```

If confidence is low, list what additional information would help.
