import * as vscode from "vscode";
import { execFileSync } from "child_process";
import * as path from "path";

// ── Risk patterns ─────────────────────────────────────────────────────────────

interface RiskAssessment {
  level: "high" | "medium" | "low" | "safe";
  reason?: string;
}

const RISK_PATTERNS: {
  pattern: RegExp;
  reason: string;
  level: "high" | "medium" | "low";
}[] = [
  {
    pattern: /\brm\s+(-[rRfF]|-rf|-fr|--recursive|--force)/i,
    reason: "Recursive or forced file deletion",
    level: "high",
  },
  {
    pattern: /curl\s+\S+\s*\|\s*(ba)?sh\b|wget\s+\S+\s*\|\s*(ba)?sh\b/i,
    reason: "Executes remote script directly",
    level: "high",
  },
  {
    pattern: /git\s+push\s+(.*\s+)?(--force|-f)\b/i,
    reason: "Force push overwrites remote history",
    level: "high",
  },
  {
    pattern: /git\s+reset\s+--hard\b/i,
    reason: "Discards uncommitted changes permanently",
    level: "high",
  },
  { pattern: /\beval\s*\(/i, reason: "Dynamic code execution", level: "high" },
  {
    pattern: /(DROP|TRUNCATE)\s+TABLE\b/i,
    reason: "Destructive database operation",
    level: "high",
  },
  {
    pattern: /chmod\s+[0-9]*7[0-9]*/i,
    reason: "World-writable file permissions",
    level: "high",
  },
  {
    pattern: /\bsudo\b/i,
    reason: "Elevated privilege execution",
    level: "medium",
  },
  {
    pattern: /git\s+commit\s+.*--amend\b/i,
    reason: "Modifies published commit history",
    level: "medium",
  },
  {
    pattern: /\b(npm|yarn|pnpm)\s+publish\b/i,
    reason: "Publishes to package registry",
    level: "medium",
  },
  {
    pattern: /git\s+(tag\s+.*-d\b|push\s+.*--delete\b)/i,
    reason: "Deletes remote refs",
    level: "medium",
  },
  { pattern: /\bgit\s+push\b/i, reason: "Pushes code to remote", level: "low" },
];

function assessRisk(value: string): RiskAssessment {
  for (const { pattern, reason, level } of RISK_PATTERNS) {
    if (pattern.test(value)) {
      return { level, reason };
    }
  }
  return { level: "safe" };
}

// ── SQLite state DB helpers ───────────────────────────────────────────────────

interface SelectedToolData {
  version: number;
  toolSetEntries: [string, boolean][];
  toolEntries: [string, boolean][];
}

/** Read all tool approval data from VS Code's globalStorage/state.vscdb */
function readSelectedToolData(dbPath: string): SelectedToolData {
  try {
    const out = execFileSync(
      "sqlite3",
      [dbPath, "SELECT value FROM ItemTable WHERE key = 'chat/selectedTools';"],
      { encoding: "utf8", timeout: 3000 },
    );
    const data = JSON.parse(out.trim()) as Partial<SelectedToolData>;
    return {
      version: data.version ?? 2,
      toolSetEntries: data.toolSetEntries ?? [],
      toolEntries: data.toolEntries ?? [],
    };
  } catch {
    return { version: 2, toolSetEntries: [], toolEntries: [] };
  }
}

/** Write the full tool approval data back to state.vscdb */
function writeSelectedToolData(dbPath: string, data: SelectedToolData): void {
  const json = JSON.stringify(data);
  // Escape single quotes for SQLite string literal
  const escaped = json.replace(/'/g, "''");
  execFileSync(
    "sqlite3",
    [
      dbPath,
      `UPDATE ItemTable SET value = '${escaped}' WHERE key = 'chat/selectedTools';`,
    ],
    { encoding: "utf8", timeout: 3000 },
  );
}

/** Read the flat autoconfirm map, merging both pre- and post-call keys */
function readAutoconfirm(dbPath: string): Record<string, boolean> {
  const merged: Record<string, boolean> = {};
  for (const key of ["chat/autoconfirm", "chat/autoconfirm-post"]) {
    try {
      const out = execFileSync(
        "sqlite3",
        [dbPath, `SELECT value FROM ItemTable WHERE key = '${key}';`],
        { encoding: "utf8", timeout: 3000 },
      );
      const trimmed = out.trim();
      if (!trimmed) {
        continue;
      }
      const data = JSON.parse(trimmed) as Record<string, boolean>;
      for (const [k, v] of Object.entries(data)) {
        // A tool is auto-approved if true in either key
        if (v) {
          merged[k] = true;
        }
      }
    } catch {
      // key absent or parse error — skip
    }
  }
  return merged;
}

/** Remove a tool from both autoconfirm keys */
function removeFromAutoconfirm(dbPath: string, toolKey: string): void {
  for (const dbKey of ["chat/autoconfirm", "chat/autoconfirm-post"]) {
    try {
      const out = execFileSync(
        "sqlite3",
        [dbPath, `SELECT value FROM ItemTable WHERE key = '${dbKey}';`],
        { encoding: "utf8", timeout: 3000 },
      );
      const trimmed = out.trim();
      if (!trimmed) {
        continue;
      }
      const data = JSON.parse(trimmed) as Record<string, boolean>;
      if (!(toolKey in data)) {
        continue;
      }
      delete data[toolKey];
      const json = JSON.stringify(data).replace(/'/g, "''");
      execFileSync(
        "sqlite3",
        [
          dbPath,
          `UPDATE ItemTable SET value = '${json}' WHERE key = '${dbKey}';`,
        ],
        { encoding: "utf8", timeout: 3000 },
      );
    } catch {
      // key absent — nothing to remove
    }
  }
}

/** Extract the server name from a toolSetEntries key */
function serverNameFromKey(key: string): string {
  const ws = key.match(/^mcp\.config\.ws\d+\.(.+)$/);
  if (ws) {
    return ws[1];
  }
  const user = key.match(/^mcp\.config\.usrlocal\.(.+)$/);
  if (user) {
    return user[1];
  }
  return key.replace(/^mcp\.config\./, "");
}

/**
 * Extract the server segment from a toolEntries key.
 * "mcp_ado_repo_create_branch" → "ado"
 * "mcp_chrome-devtoo_click"   → "chrome-devtoo"
 * Splits on the first underscore after "mcp_" that is NOT part of a hyphenated
 * segment, i.e. index 1 of key.split('_').
 */
function serverSegmentFromToolEntry(key: string): string | undefined {
  const match = key.match(/^mcp_(.+?)_/);
  return match?.[1];
}

/**
 * Given a server segment extracted from a toolEntries key (e.g. "chrome-devtoo"),
 * find the matching server name from toolSetEntries (e.g. "chrome-devtools").
 * Handles VS Code's silent truncation of server names in tool IDs.
 */
function resolveServerName(
  segment: string,
  serverNames: string[],
): string | undefined {
  if (serverNames.includes(segment)) {
    return segment;
  }
  // Truncation case: server name starts with the segment
  return serverNames.find((n) => n.startsWith(segment));
}

/** Return a human-readable label for an MCP tool set key */
function formatMcpLabel(key: string): string {
  const wsMatch = key.match(/^mcp\.config\.ws(\d+)\.(.+)$/);
  if (wsMatch) {
    const name = wsMatch[2];
    const idx = parseInt(wsMatch[1], 10);
    return idx === 0 ? name : `${name} (ws${idx + 1})`;
  }
  const userMatch = key.match(/^mcp\.config\.usrlocal\.(.+)$/);
  if (userMatch) {
    return userMatch[1];
  }
  return key.replace(/^mcp\.config\./, "");
}

// ── Monitored settings keys ───────────────────────────────────────────────────

/**
 * Each monitored setting is a flat-object map where:
 *   key   = command string / URL / regex pattern
 *   value = true | { approve: boolean, ... }
 *
 * Both `chat.tools.terminal.autoApprove` and `chat.tools.urls.autoApprove`
 * follow this shape.
 */
type ApproveMap = Record<string, boolean | Record<string, unknown>>;

const MONITORED_KEYS: { fullKey: string; label: string; isUrl?: boolean }[] = [
  { fullKey: "chat.tools.terminal.autoApprove", label: "Terminal Commands" },
  { fullKey: "chat.tools.urls.autoApprove", label: "URLs", isUrl: true },
];

const SCOPES: {
  target: vscode.ConfigurationTarget;
  label: string;
  icon: string;
}[] = [
  {
    target: vscode.ConfigurationTarget.Global,
    label: "User Settings",
    icon: "account",
  },
  {
    target: vscode.ConfigurationTarget.Workspace,
    label: "Workspace Settings",
    icon: "folder-library",
  },
];

// ── Tree items ────────────────────────────────────────────────────────────────

type ItemKind =
  | "root"
  | "scopeGroup"
  | "entry"
  | "placeholder"
  | "dbEntry"
  | "dbToolEntry";

class ApprovalItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: ItemKind,
    public readonly fullKey?: string,
    public readonly configTarget?: vscode.ConfigurationTarget,
    public readonly entryKey?: string,
    risk?: RiskAssessment,
    public readonly dbKey?: string,
  ) {
    super(label, collapsibleState);
    this.contextValue = kind;

    switch (kind) {
      case "root":
        this.iconPath = new vscode.ThemeIcon("shield");
        break;

      case "scopeGroup": {
        const scopeDef = SCOPES.find((s) => s.target === configTarget);
        this.iconPath = new vscode.ThemeIcon(scopeDef?.icon ?? "folder");
        break;
      }

      case "entry":
        if (risk) {
          const iconByLevel: Record<RiskAssessment["level"], string> = {
            high: "error",
            medium: "warning",
            low: "info",
            safe: "check",
          };
          const colorByLevel: Record<RiskAssessment["level"], string> = {
            high: "errorForeground",
            medium: "editorWarning.foreground",
            low: "editorInfo.foreground",
            safe: "terminal.ansiGreen",
          };
          this.iconPath = new vscode.ThemeIcon(
            iconByLevel[risk.level],
            new vscode.ThemeColor(colorByLevel[risk.level]),
          );
          this.description =
            risk.level !== "safe" ? risk.level.toUpperCase() : undefined;
          this.tooltip = new vscode.MarkdownString(
            risk.reason
              ? `**Risk:** ${risk.level.toUpperCase()}  \n**Reason:** ${risk.reason}  \n\n\`${entryKey}\``
              : `\`${entryKey}\``,
          );
        }
        break;

      case "placeholder":
        this.iconPath = new vscode.ThemeIcon(
          "check",
          new vscode.ThemeColor("terminal.ansiGreen"),
        );
        break;

      case "dbEntry":
        this.iconPath = new vscode.ThemeIcon("plug");
        break;

      case "dbToolEntry":
        this.iconPath = new vscode.ThemeIcon("tools");
        break;
    }
  }
}

// ── Tree data provider ────────────────────────────────────────────────────────

class ApprovalTreeProvider implements vscode.TreeDataProvider<ApprovalItem> {
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onChange.event;

  constructor(private readonly dbPath: string) {}

  refresh(): void {
    this._onChange.fire();
  }

  getTreeItem(element: ApprovalItem): ApprovalItem {
    return element;
  }

  getChildren(element?: ApprovalItem): ApprovalItem[] {
    if (!element) {
      return this.buildRoots();
    }
    if (element.kind === "root") {
      if (element.fullKey === "mcp/selectedTools") {
        return this.buildMcpServerItems();
      }
      if (element.fullKey) {
        return this.buildScopeGroups(element.fullKey);
      }
    }
    if (
      element.kind === "scopeGroup" &&
      element.fullKey &&
      element.configTarget !== undefined
    ) {
      return this.buildEntries(element.fullKey, element.configTarget);
    }
    // Expand MCP server node → show its individual tool approvals
    if (element.kind === "dbEntry" && element.dbKey) {
      return this.buildMcpToolEntries(element.dbKey);
    }
    return [];
  }

  // ── Roots (one per setting key that has values) ───────────────────────────

  private buildRoots(): ApprovalItem[] {
    const roots: ApprovalItem[] = [];

    for (const { fullKey, label, isUrl } of MONITORED_KEYS) {
      const inspected = vscode.workspace
        .getConfiguration()
        .inspect<ApproveMap>(fullKey);
      if (!inspected) {
        continue;
      }

      const hasAny =
        inspected.globalValue !== undefined ||
        inspected.workspaceValue !== undefined;
      if (!hasAny) {
        continue;
      }

      const count =
        Object.keys(inspected.globalValue ?? {}).length +
        Object.keys(inspected.workspaceValue ?? {}).length;

      const item = new ApprovalItem(
        label,
        vscode.TreeItemCollapsibleState.Expanded,
        "root",
        fullKey,
      );
      item.description = `${count} ${count === 1 ? "entry" : "entries"}`;

      // Flag high-risk terminal commands
      if (!isUrl) {
        const allKeys = [
          ...Object.keys(inspected.globalValue ?? {}),
          ...Object.keys(inspected.workspaceValue ?? {}),
        ];
        if (allKeys.some((k) => assessRisk(k).level === "high")) {
          item.iconPath = new vscode.ThemeIcon(
            "warning",
            new vscode.ThemeColor("editorWarning.foreground"),
          );
        }
      }

      roots.push(item);
    }

    if (roots.length === 0) {
      return [
        new ApprovalItem(
          "No auto-approved entries found",
          vscode.TreeItemCollapsibleState.None,
          "placeholder",
        ),
      ];
    }

    // Append MCP server section from SQLite state DB
    const mcpRoot = this.buildMcpRoot();
    if (mcpRoot) {
      roots.push(mcpRoot);
    }

    return roots;
  }

  // ── Scope groups (User / Workspace) ───────────────────────────────────────

  private buildScopeGroups(fullKey: string): ApprovalItem[] {
    const inspected = vscode.workspace
      .getConfiguration()
      .inspect<ApproveMap>(fullKey);
    if (!inspected) {
      return [];
    }

    const groups: ApprovalItem[] = [];

    for (const { target, label } of SCOPES) {
      const value =
        target === vscode.ConfigurationTarget.Global
          ? inspected.globalValue
          : inspected.workspaceValue;
      if (!value || Object.keys(value).length === 0) {
        continue;
      }

      const count = Object.keys(value).length;
      const item = new ApprovalItem(
        label,
        vscode.TreeItemCollapsibleState.Expanded,
        "scopeGroup",
        fullKey,
        target,
      );
      item.description = `${count} ${count === 1 ? "entry" : "entries"}`;
      groups.push(item);
    }

    return groups;
  }

  // ── Individual entries ────────────────────────────────────────────────────

  private buildEntries(
    fullKey: string,
    target: vscode.ConfigurationTarget,
  ): ApprovalItem[] {
    const isUrl =
      MONITORED_KEYS.find((k) => k.fullKey === fullKey)?.isUrl ?? false;
    const inspected = vscode.workspace
      .getConfiguration()
      .inspect<ApproveMap>(fullKey);
    if (!inspected) {
      return [];
    }

    const value =
      target === vscode.ConfigurationTarget.Global
        ? inspected.globalValue
        : inspected.workspaceValue;

    if (!value || Object.keys(value).length === 0) {
      return [
        new ApprovalItem(
          "(empty)",
          vscode.TreeItemCollapsibleState.None,
          "placeholder",
        ),
      ];
    }

    return Object.keys(value).map((entryKey) => {
      const risk = isUrl ? { level: "safe" as const } : assessRisk(entryKey);
      return new ApprovalItem(
        entryKey,
        vscode.TreeItemCollapsibleState.None,
        "entry",
        fullKey,
        target,
        entryKey,
        risk,
      );
    });
  }

  // ── MCP servers (from state.vscdb) ────────────────────────────────────────

  private buildMcpRoot(): ApprovalItem | undefined {
    const { toolSetEntries } = readSelectedToolData(this.dbPath);
    const enabledServers = toolSetEntries.filter(
      ([k, v]) => k.startsWith("mcp.config.") && v === true,
    );
    if (enabledServers.length === 0) {
      return undefined;
    }
    const serverNames = enabledServers.map(([k]) => serverNameFromKey(k));
    const autoconfirmed = readAutoconfirm(this.dbPath);
    const toolCount = Object.keys(autoconfirmed).filter((k) => {
      const seg = serverSegmentFromToolEntry(k);
      return (
        seg !== undefined && resolveServerName(seg, serverNames) !== undefined
      );
    }).length;

    const item = new ApprovalItem(
      "MCP Servers",
      vscode.TreeItemCollapsibleState.Expanded,
      "root",
      "mcp/selectedTools",
    );
    item.iconPath = new vscode.ThemeIcon("server-environment");
    item.description = `${enabledServers.length} server${enabledServers.length !== 1 ? "s" : ""}, ${toolCount} auto-approved`;
    item.tooltip =
      "Enabled MCP servers and their auto-approved tools (VS Code state DB)";
    return item;
  }

  private buildMcpServerItems(): ApprovalItem[] {
    const { toolSetEntries } = readSelectedToolData(this.dbPath);
    const enabledServers = toolSetEntries.filter(
      ([k, v]) => k.startsWith("mcp.config.") && v === true,
    );
    if (enabledServers.length === 0) {
      return [
        new ApprovalItem(
          "(none enabled)",
          vscode.TreeItemCollapsibleState.None,
          "placeholder",
        ),
      ];
    }
    const serverNames = enabledServers.map(([k]) => serverNameFromKey(k));
    const autoconfirmed = readAutoconfirm(this.dbPath);

    return enabledServers.map(([k]) => {
      const serverName = serverNameFromKey(k);
      const label = formatMcpLabel(k);
      const toolsForServer = Object.keys(autoconfirmed).filter((tk) => {
        const seg = serverSegmentFromToolEntry(tk);
        return (
          seg !== undefined &&
          resolveServerName(seg, serverNames) === serverName
        );
      });

      const item = new ApprovalItem(
        label,
        toolsForServer.length > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
        "dbEntry",
        undefined,
        undefined,
        undefined,
        undefined,
        k,
      );
      const scope = k.includes(".ws") ? "workspace" : "user";
      item.description =
        toolsForServer.length > 0
          ? `${toolsForServer.length} auto-approved`
          : `${scope} — none auto-approved`;
      item.tooltip = new vscode.MarkdownString(
        `**Key:** \`${k}\`  \n**Scope:** ${scope}  \n\nDisabling removes this MCP server's tools from Copilot.`,
      );
      return item;
    });
  }

  private buildMcpToolEntries(serverKey: string): ApprovalItem[] {
    const { toolSetEntries } = readSelectedToolData(this.dbPath);
    const serverNames = toolSetEntries
      .filter(([k]) => k.startsWith("mcp.config."))
      .map(([k]) => serverNameFromKey(k));
    const serverName = serverNameFromKey(serverKey);
    const autoconfirmed = readAutoconfirm(this.dbPath);

    const tools = Object.keys(autoconfirmed).filter((tk) => {
      const seg = serverSegmentFromToolEntry(tk);
      return (
        seg !== undefined && resolveServerName(seg, serverNames) === serverName
      );
    });

    if (tools.length === 0) {
      return [
        new ApprovalItem(
          "(no auto-approved tools)",
          vscode.TreeItemCollapsibleState.None,
          "placeholder",
        ),
      ];
    }

    return tools.map((tk) => {
      // Strip the "mcp_<segment>_" prefix for a readable tool name
      const seg = serverSegmentFromToolEntry(tk) ?? "";
      const toolName = tk.slice(`mcp_${seg}_`.length);
      const item = new ApprovalItem(
        toolName,
        vscode.TreeItemCollapsibleState.None,
        "dbToolEntry",
        undefined,
        undefined,
        undefined,
        undefined,
        tk,
      );
      item.description = tk;
      item.tooltip = new vscode.MarkdownString(`**Tool key:** \`${tk}\``);
      return item;
    });
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function removeEntry(item: ApprovalItem): Promise<void> {
  if (!item.fullKey || item.configTarget === undefined || !item.entryKey) {
    return;
  }

  const config = vscode.workspace.getConfiguration();
  const inspected = config.inspect<ApproveMap>(item.fullKey);
  if (!inspected) {
    return;
  }

  const current =
    item.configTarget === vscode.ConfigurationTarget.Global
      ? inspected.globalValue
      : inspected.workspaceValue;
  if (!current) {
    return;
  }

  const pick = await vscode.window.showWarningMessage(
    `Remove "${item.entryKey}" from auto-approved list?`,
    { modal: true },
    "Remove",
  );
  if (pick !== "Remove") {
    return;
  }

  const updated = { ...current };
  delete updated[item.entryKey];

  await config.update(
    item.fullKey,
    Object.keys(updated).length > 0 ? updated : undefined,
    item.configTarget,
  );
}

async function removeAllFromScope(item: ApprovalItem): Promise<void> {
  if (!item.fullKey || item.configTarget === undefined) {
    return;
  }

  const scopeLabel =
    item.configTarget === vscode.ConfigurationTarget.Global
      ? "User Settings"
      : "Workspace Settings";

  const pick = await vscode.window.showWarningMessage(
    `Remove ALL auto-approved entries from ${scopeLabel} for "${item.fullKey}"?`,
    { modal: true },
    "Remove All",
  );
  if (pick !== "Remove All") {
    return;
  }

  await vscode.workspace
    .getConfiguration()
    .update(item.fullKey, undefined, item.configTarget);
}

// ── Startup risk scan ─────────────────────────────────────────────────────────

async function removeDbEntry(
  item: ApprovalItem,
  dbPath: string,
): Promise<void> {
  if (!item.dbKey) {
    return;
  }

  const pick = await vscode.window.showWarningMessage(
    `Disable MCP server "${item.dbKey}" from Copilot tool access?\n\nThis edits the VS Code state database. A window reload is required to take effect.`,
    { modal: true },
    "Disable",
  );
  if (pick !== "Disable") {
    return;
  }

  try {
    const data = readSelectedToolData(dbPath);
    data.toolSetEntries = data.toolSetEntries.filter(([k]) => k !== item.dbKey);
    writeSelectedToolData(dbPath, data);
    const action = await vscode.window.showInformationMessage(
      `MCP server "${item.dbKey}" disabled. Reload VS Code to apply.`,
      "Reload Now",
    );
    if (action === "Reload Now") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(
      `Failed to update state DB: ${msg}. Is sqlite3 CLI available?`,
    );
  }
}

async function removeDbToolEntry(
  item: ApprovalItem,
  dbPath: string,
): Promise<void> {
  if (!item.dbKey) {
    return;
  }

  const pick = await vscode.window.showWarningMessage(
    `Remove auto-approval for tool "${item.dbKey}"?\n\nThis edits the VS Code state database. A window reload is required to take effect.`,
    { modal: true },
    "Remove",
  );
  if (pick !== "Remove") {
    return;
  }

  try {
    removeFromAutoconfirm(dbPath, item.dbKey);
    const action = await vscode.window.showInformationMessage(
      `Auto-approval removed for "${item.dbKey}". Reload VS Code to apply.`,
      "Reload Now",
    );
    if (action === "Reload Now") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(
      `Failed to update state DB: ${msg}. Is sqlite3 CLI available?`,
    );
  }
}

// ── Startup risk scan ─────────────────────────────────────────────────────────

async function scanForRiskyEntries(): Promise<void> {
  const highRiskFound: string[] = [];

  for (const { fullKey, label, isUrl } of MONITORED_KEYS) {
    if (isUrl) {
      continue;
    }
    const inspected = vscode.workspace
      .getConfiguration()
      .inspect<ApproveMap>(fullKey);
    if (!inspected) {
      continue;
    }

    for (const [scope, value] of [
      ["User", inspected.globalValue],
      ["Workspace", inspected.workspaceValue],
    ] as const) {
      if (!value) {
        continue;
      }
      for (const key of Object.keys(value)) {
        const risk = assessRisk(key);
        if (risk.level === "high") {
          highRiskFound.push(
            `${label} [${scope}]: "${key}" — ${risk.reason ?? ""}`,
          );
        }
      }
    }
  }

  if (highRiskFound.length > 0) {
    const plural = highRiskFound.length > 1 ? "s" : "";
    const action = await vscode.window.showWarningMessage(
      `⚠️ Copilot Approval Guard: ${highRiskFound.length} HIGH RISK command${plural} detected`,
      "Review in Panel",
      "Dismiss",
    );
    if (action === "Review in Panel") {
      await vscode.commands.executeCommand("approvalGuard.approvals.focus");
    }
  }
}

// ── Extension lifecycle ───────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // Derive path to VS Code's globalStorage/state.vscdb from the extension's
  // own globalStorageUri (e.g. .../User/globalStorage/<ext-id> → parent dir).
  const dbPath = path.join(
    path.dirname(context.globalStorageUri.fsPath),
    "state.vscdb",
  );

  const provider = new ApprovalTreeProvider(dbPath);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("approvalGuard.approvals", provider),

    vscode.commands.registerCommand("approvalGuard.refresh", () =>
      provider.refresh(),
    ),

    vscode.commands.registerCommand(
      "approvalGuard.removeEntry",
      async (item: ApprovalItem) => {
        await removeEntry(item);
        provider.refresh();
      },
    ),

    vscode.commands.registerCommand(
      "approvalGuard.removeAllFromScope",
      async (item: ApprovalItem) => {
        await removeAllFromScope(item);
        provider.refresh();
      },
    ),

    vscode.commands.registerCommand(
      "approvalGuard.removeDbEntry",
      async (item: ApprovalItem) => {
        await removeDbEntry(item, dbPath);
        provider.refresh();
      },
    ),

    vscode.commands.registerCommand(
      "approvalGuard.removeDbToolEntry",
      async (item: ApprovalItem) => {
        await removeDbToolEntry(item, dbPath);
        provider.refresh();
      },
    ),

    // Auto-refresh when any monitored setting changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        MONITORED_KEYS.some(({ fullKey }) => e.affectsConfiguration(fullKey))
      ) {
        provider.refresh();
      }
    }),
  );

  void scanForRiskyEntries();
}

export function deactivate(): void {}
