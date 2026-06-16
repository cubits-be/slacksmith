/** Shape of agents/<id>/agent.json */
export interface AgentFileConfig {
  name: string;
  model?: string;
  allowedTools?: string[];
  excludedTools?: string[];
}

export interface McpServerConfig {
  name: string;
  /** 'http' = streamable HTTP (POST to url); 'sse' = SSE transport (GET url for events, POST to messageUrl or derived /message) */
  transport?: 'http' | 'sse';
  url: string;
  /** Explicit POST endpoint for SSE transport. Defaults to url with /sse replaced by /message. */
  messageUrl?: string;
}

export interface McpConfig {
  servers: McpServerConfig[];
  globalExcludedTools?: string[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
