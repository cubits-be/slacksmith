---
name: expense-tracker
description: Use when asked to check, track, or report on incoming invoices from Exact — fetches invoice emails from no-reply@exact.com for a given period (last 7 days by default, or month-to-date, previous month, last 30 days, or a custom range) and produces a summary report
---

# Expense Tracker

## When to use this skill

Use this skill when:
- Asked to check, track, or summarize incoming invoices
- Asked for an expense or invoice report
- Someone mentions "Exact", "facturen", or "invoices received"
- Running a periodic finance check

## Step 1 — Determine the date range

Resolve the date range from the user's request. Supported ranges:

| What the user says | Gmail query filter | Report label |
|---|---|---|
| "last 7 days" *(default)* | `newer_than:7d` | Last 7 Days |
| "month to date" / "this month" | `after:YYYY/MM/01` (first day of current month) | Month to Date (Month YYYY) |
| "previous month" / "last month" | `after:YYYY/MM/01 before:YYYY/MM/01` (full prior month) | [Month name] YYYY |
| "last 30 days" | `newer_than:30d` | Last 30 Days |
| Custom (e.g. "May 1–15") | `after:YYYY/MM/DD before:YYYY/MM/DD` | DD MMM – DD MMM YYYY |

If no range is specified, default to **last 7 days**.

## Step 2 — Fetch invoice emails

Search Gmail for invoice notification emails from Exact in the resolved date range:

- **Query**: `from:no-reply@exact.com subject:"Nieuwe factuur ontvangen" [date filter from Step 1]`
- Use `_gmail_list_messages` (or the hub Gmail tool) to run this search.
- Fetch **each matching message** in full to extract the invoice details.

The email body follows this exact pattern (Dutch):

```
Je hebt een nieuwe factuur van {SUPPLIER} voor {COMPANY}.
Het factuurnummer is {INVOICE_NUMBER} en het totale bedrag is €{AMOUNT}.
```

Extract the following from each email:
- **Date received** — from the email's Date header
- **Supplier** — the value after `"nieuwe factuur van"` and before `"voor"`
- **Company** — the value after `"voor"` and before `"."` (e.g. "Cubits")
- **Invoice number** — the value after `"Het factuurnummer is"` and before `"en"`
- **Amount** — the value after `"het totale bedrag is €"` (preserve formatting, e.g. `€1.000,05`)

If a field is not found in the email, mark it as `—`.

## Step 2 — Build the report

Compile all extracted invoices into a structured report.

Format the report as follows:

```
📊 *Expense Report — Incoming Invoices ([Report label from Step 1])*
─────────────────────────────────────────────────────

[For each invoice:]
• 🗓 *[date received]*  🏢 [supplier]
  📄 Invoice #[invoice number] — 💶 €[amount]

─────────────────────────────────────────────────────
📦 *Total invoices:* [count]
💰 *Total amount:* €[sum of all amounts]
📅 *Report generated:* [current date]
```

If no invoices were found, report:
```
📊 *Expense Report — Incoming Invoices ([Report label])*
No invoice emails from no-reply@exact.com found for this period.
```

## Step 3 — Post to Slack

Post the report to the **#daily-summary** channel (or to the channel/DM where the request came from, if different).

Use `_post_message` to post. Keep it clean and scannable — the format above is designed for Slack's markdown renderer.

## Notes

- Exact sends invoice notification emails in Dutch with a fixed sentence structure — use the pattern above for reliable extraction.
- Amounts use Dutch formatting (`1.000,05` = 1000.05). When summing, convert accordingly.
- Do not fabricate invoice details. If an email doesn't match the expected pattern, list it with whatever data is available and note `[could not fully parse]`.
- If there are many invoices (>10), group by supplier.
