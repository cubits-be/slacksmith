import { loadMcpConfig } from '../core/config';
import { McpServerConfig, McpTool } from '../core/types';
import { McpClient } from './McpClient';

interface RegisteredTool {
  tool: McpTool;
  client: McpClient;
  /** Original tool name on the server (before namespacing) */
  serverToolName: string;
}

// Startup: retry the initial connect so a transient hub outage at boot doesn't
// leave the registry empty for the whole process lifetime.
const STARTUP_ATTEMPTS = Math.max(1, parseInt(process.env.MCP_STARTUP_ATTEMPTS ?? '5', 10));
const STARTUP_RETRY_MS = Math.max(0, parseInt(process.env.MCP_STARTUP_RETRY_MS ?? '5000', 10));
// Background health check: probes live sessions and reconnects if the hub went
// away or restarted (which invalidates the session captured at connect time).
const MONITOR_INTERVAL_MS = Math.max(0, parseInt(process.env.MCP_MONITOR_INTERVAL_MS ?? '60000', 10));

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export class McpRegistry {
  private tools = new Map<string, RegisteredTool>();
  private servers: McpServerConfig[] = [];
  private globalExcludedTools: string[] = [];
  /** One live client per successfully-connected server — used to probe health. */
  private clients: McpClient[] = [];
  private monitorStarted = false;
  /** In-flight reconnect, so concurrent triggers coalesce into one rebuild. */
  private reconnecting?: Promise<void>;

  async initialize(): Promise<void> {
    const { servers, globalExcludedTools } = loadMcpConfig();
    this.servers = servers;
    this.globalExcludedTools = globalExcludedTools ?? [];

    // Bounded startup retry: keep trying until we have tools (or run out of attempts).
    for (let attempt = 1; attempt <= STARTUP_ATTEMPTS; attempt++) {
      await this.connect();
      if (this.tools.size > 0 || this.servers.length === 0) break;
      if (attempt < STARTUP_ATTEMPTS) {
        console.warn(
          `MCP: no tools connected (attempt ${attempt}/${STARTUP_ATTEMPTS}) — retrying in ${STARTUP_RETRY_MS}ms`,
        );
        await sleep(STARTUP_RETRY_MS);
      }
    }

    console.log(`MCP: ${this.tools.size} total tools available`);
    this.startMonitor();
  }

  /** Connect every configured server with a fresh client and atomically swap in
   *  the resulting tool map. A fresh client means a fresh session, which is what
   *  repairs a stale-session state after the hub restarts. Concurrent callers
   *  share a single in-flight rebuild. */
  private connect(): Promise<void> {
    if (!this.reconnecting) {
      this.reconnecting = this.doConnect().finally(() => { this.reconnecting = undefined; });
    }
    return this.reconnecting;
  }

  private async doConnect(): Promise<void> {
    const nextTools = new Map<string, RegisteredTool>();
    const nextClients: McpClient[] = [];

    for (const serverConfig of this.servers) {
      try {
        const client = new McpClient(serverConfig);
        await client.initialize();
        const serverTools = await client.listTools();

        for (const tool of serverTools) {
          // Namespace the tool if the name collides with an existing one
          const key = nextTools.has(tool.name)
            ? `${serverConfig.name}__${tool.name}`
            : tool.name;

          nextTools.set(key, {
            tool: { ...tool, name: key },
            client,
            serverToolName: tool.name,
          });
        }

        nextClients.push(client);
        console.log(`MCP: ${serverConfig.name} connected → ${client.getPostUrl()} (${serverTools.length} tools)`);
        if (process.env.DEBUG_MCP_TOOLS === 'true') {
          for (const tool of serverTools) console.log(`  tool: ${tool.name}`);
        }
      } catch (err) {
        console.warn(
          `MCP: could not connect to ${serverConfig.name}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Only replace a populated registry if the rebuild produced tools — never wipe
    // a healthy map because of a transient failure. The synchronous assignment is
    // the atomic swap (getTools() is sync and never sees a half-built map).
    if (nextTools.size > 0 || this.tools.size === 0) {
      this.tools = nextTools;
      this.clients = nextClients;
    }
  }

  private startMonitor(): void {
    if (this.monitorStarted || this.servers.length === 0 || MONITOR_INTERVAL_MS === 0) return;
    this.monitorStarted = true;
    // .unref() so the timer never keeps the process alive at shutdown.
    setInterval(() => { void this.healthCheck(); }, MONITOR_INTERVAL_MS).unref();
  }

  /** Probe live sessions; reconnect only when something is actually wrong. Probing
   *  the existing clients (rather than always rebuilding) avoids churning a new
   *  session every tick while still catching an empty registry or a dead session. */
  private async healthCheck(): Promise<void> {
    let healthy = this.tools.size > 0 && this.clients.length === this.servers.length;
    if (healthy) {
      for (const client of this.clients) {
        try {
          await client.listTools();
        } catch {
          healthy = false;
          break;
        }
      }
    }
    if (!healthy) {
      console.warn('MCP: health check failed — reconnecting…');
      await this.connect();
      console.log(`MCP: ${this.tools.size} total tools available after reconnect`);
    }
  }

  /** Returns tools the agent is allowed to use. Undefined = all tools, capped at maxTools.
   *  excludeList entries can be exact names or prefix wildcards ending in * (e.g. "fs__*").
   */
  getTools(allowList?: string[], maxTools = 128, excludeList?: string[]): McpTool[] {
    const all = Array.from(this.tools.values()).map(r => r.tool);

    const combinedExclude = [...this.globalExcludedTools, ...(excludeList ?? [])];

    const isExcluded = (name: string): boolean => {
      if (combinedExclude.length === 0) return false;
      return combinedExclude.some(e =>
        e.endsWith('*') ? name.startsWith(e.slice(0, -1)) : name === e,
      );
    };

    let filtered = (allowList && allowList.length > 0)
      ? all.filter(t => allowList.includes(t.name))
      : all;

    filtered = filtered.filter(t => !isExcluded(t.name));

    if (filtered.length > maxTools) {
      console.warn(
        `MCP: ${filtered.length} tools exceeds OpenAI limit of ${maxTools} — truncating. ` +
        `Set FORGE_ALLOWED_TOOLS or FORGE_EXCLUDED_TOOLS in .env to reduce the tool count.`,
      );
      return filtered.slice(0, maxTools);
    }
    return filtered;
  }

  async callTool(name: string, args: Record<string, unknown>, retry = true): Promise<string> {
    const registered = this.tools.get(name);
    if (!registered) {
      // Registry may be empty/stale (hub was down at startup, or restarted) —
      // try one reconnect before declaring the tool unknown.
      if (retry) {
        await this.connect();
        return this.callTool(name, args, false);
      }
      throw new Error(`Unknown MCP tool: ${name}`);
    }
    try {
      return await registered.client.callTool(registered.serverToolName, args);
    } catch (err) {
      // A dead session (e.g. hub restarted) fails here — reconnect once and retry
      // against the refreshed registry rather than waiting for the next health tick.
      if (retry) {
        console.warn(
          `MCP: tool call ${name} failed (${err instanceof Error ? err.message : err}) — reconnecting and retrying once`,
        );
        await this.connect();
        return this.callTool(name, args, false);
      }
      throw err;
    }
  }
}
