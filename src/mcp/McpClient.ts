import { McpServerConfig, McpTool } from '../core/types';

interface JsonRpcResponse {
  result?: unknown;
  error?: { message: string };
}

interface ToolsListResult {
  tools: McpTool[];
}

interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
}

/** Derive the POST endpoint from the server config.
 *  - SSE transport: POST to /message (or explicit messageUrl)
 *  - Streamable HTTP: POST to url directly
 *  Auto-detects SSE if url ends with /sse.
 */
function resolvePostUrl(cfg: McpServerConfig): string {
  if (cfg.messageUrl) return cfg.messageUrl;
  const isSSE = cfg.transport === 'sse' || cfg.url.endsWith('/sse');
  if (isSSE) return cfg.url.replace(/\/sse$/, '/message');
  return cfg.url;
}

/** Parse a JSON-RPC result from either a plain JSON or SSE-wrapped response body. */
async function parseRpcResponse(res: Response): Promise<JsonRpcResponse> {
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();

  if (contentType.includes('text/event-stream')) {
    // Extract the first `data:` line from the SSE stream
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        return JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
      }
    }
    throw new Error('SSE response contained no data line');
  }

  return JSON.parse(text) as JsonRpcResponse;
}

export class McpClient {
  private nextId = 1;
  private readonly postUrl: string;
  private sessionId: string | null = null;

  constructor(private readonly serverConfig: McpServerConfig) {
    this.postUrl = resolvePostUrl(serverConfig);
  }

  getPostUrl(): string { return this.postUrl; }

  private async rpc(method: string, params?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const res = await fetch(this.postUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: this.nextId++ }),
    });

    if (!res.ok) {
      throw new Error(`${this.serverConfig.name}: HTTP ${res.status}`);
    }

    // Capture session ID from initialize response
    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;

    const data = await parseRpcResponse(res);
    if (data.error) throw new Error(`${this.serverConfig.name}: ${data.error.message}`);
    return data.result;
  }

  async initialize(): Promise<void> {
    try {
      await this.rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'slacksmith', version: '1.0.0' },
      });
    } catch {
      // Optional — some servers skip the handshake
    }
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.rpc('tools/list')) as ToolsListResult;
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.rpc('tools/call', {
      name,
      arguments: args,
    })) as ToolCallResult;

    return (result.content ?? [])
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('\n');
  }
}
