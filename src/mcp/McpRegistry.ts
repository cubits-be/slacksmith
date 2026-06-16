import { loadMcpConfig } from '../core/config';
import { McpTool } from '../core/types';
import { McpClient } from './McpClient';

interface RegisteredTool {
  tool: McpTool;
  client: McpClient;
  /** Original tool name on the server (before namespacing) */
  serverToolName: string;
}

export class McpRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private globalExcludedTools: string[] = [];

  async initialize(): Promise<void> {
    const { servers, globalExcludedTools } = loadMcpConfig();
    this.globalExcludedTools = globalExcludedTools ?? [];

    for (const serverConfig of servers) {
      try {
        const client = new McpClient(serverConfig);
        await client.initialize();
        const serverTools = await client.listTools();

        for (const tool of serverTools) {
          // Namespace the tool if the name collides with an existing one
          const key = this.tools.has(tool.name)
            ? `${serverConfig.name}__${tool.name}`
            : tool.name;

          this.tools.set(key, {
            tool: { ...tool, name: key },
            client,
            serverToolName: tool.name,
          });
        }

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

    console.log(`MCP: ${this.tools.size} total tools available`);
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

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const registered = this.tools.get(name);
    if (!registered) throw new Error(`Unknown MCP tool: ${name}`);
    return registered.client.callTool(registered.serverToolName, args);
  }
}
