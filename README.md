# Copilot Approval Guard

A VS Code extension to audit and remove auto-approved commands for GitHub Copilot and Claude Code agent tools.

> **Audit only** — this extension never adds approvals. It only shows what is already approved and lets you remove entries.

## Features

- **Terminal Commands** — view and remove entries from `chat.tools.terminal.autoApprove` (user and workspace scopes), with risk assessment (HIGH / MEDIUM / LOW) for dangerous patterns like `rm -rf`, force-push, `eval`, etc.
- **URLs** — view and remove entries from `chat.tools.urls.autoApprove`
- **MCP Servers** — shows enabled MCP servers from the VS Code state database and the individual tools you have auto-approved for each server (from `chat/autoconfirm` and `chat/autoconfirm-post`)
- **Startup scan** — alerts you at launch if any HIGH-risk terminal commands are auto-approved

## Usage

Open the **Copilot Approval Guard** panel from the activity bar (shield icon). Hover over any entry and click the trash icon to remove it. Server-level MCP entries are expandable to show individual tool approvals.

Removing an entry from the MCP section edits the VS Code SQLite state database and requires a window reload to take effect (you will be prompted).

## Requirements

- VS Code 1.85+
- `sqlite3` CLI must be available on `PATH` (macOS: included by default; Linux: `apt install sqlite3`)

## Extension Settings

This extension does not add any settings. It reads and manages existing Copilot approval settings.

## Release Notes

### 0.1.0

Initial release.
