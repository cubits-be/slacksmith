import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { config } from '../core/config';
import { McpTool } from '../core/types';

export type StatusUpdater = (status: string) => Promise<void>;

const MAX_RETRIES = Math.max(0, parseInt(process.env.LLM_MAX_RETRIES ?? '3', 10));

// ── Circuit breaker (shared across all agents) ───────────────────────────────
// After CIRCUIT_TRIP_THRESHOLD consecutive 429s, all LLM requests are blocked
// for CIRCUIT_COOLDOWN_MS to prevent burning through credits in a loop.
const CIRCUIT_TRIP_THRESHOLD = parseInt(process.env.LLM_CIRCUIT_TRIP ?? '5', 10);
const CIRCUIT_COOLDOWN_MS = parseInt(process.env.LLM_CIRCUIT_COOLDOWN_MS ?? '60000', 10);

let consecutiveRateLimits = 0;
let circuitOpenUntil = 0;

function toOpenAITool(tool: McpTool): OpenAI.Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as OpenAI.FunctionParameters,
    },
  };
}

/** Parse retry-after seconds from a 429 error message ("try again in 4.538s"). */
function parseRetryAfterMs(message: string): number {
  const match = message.match(/try again in (\d+(?:\.\d+)?)s/i);
  return match ? Math.ceil(parseFloat(match[1]) * 1000) + 500 : 5000;
}

/** Save the request payload to agents/tmp/ratelimit-<timestamp>.json for token analysis. */
function saveRateLimitDump(params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming): void {
  try {
    const tmpDir = path.join(config.agentsDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, `ratelimit-${Date.now()}.json`);
    const toolTokenEstimate = (params.tools ?? []).reduce(
      (sum, t) => sum + JSON.stringify(t).length / 4, 0,
    );
    const messageTokenEstimate = params.messages.reduce(
      (sum, m) => sum + (typeof m.content === 'string' ? m.content.length / 4 : 0), 0,
    );
    fs.writeFileSync(file, JSON.stringify({
      _meta: {
        timestamp: new Date().toISOString(),
        model: params.model,
        tool_count: params.tools?.length ?? 0,
        estimated_tool_tokens: Math.round(toolTokenEstimate),
        estimated_message_tokens: Math.round(messageTokenEstimate),
        estimated_total_tokens: Math.round(toolTokenEstimate + messageTokenEstimate),
      },
      messages: params.messages,
      tools: params.tools,
    }, null, 2), 'utf8');
    console.warn(`[LLM] Rate limit dump saved to ${file}`);
  } catch (e) {
    console.warn('[LLM] Failed to save rate limit dump:', e);
  }
}

export class LLMClient {
  private readonly client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: config.llm.apiKey });
  }

  private async createWithRetry(
    params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    onStatus: StatusUpdater,
  ): Promise<OpenAI.Chat.ChatCompletion> {
    // ── Circuit breaker check ────────────────────────────────────────────────
    if (Date.now() < circuitOpenUntil) {
      const remaining = Math.ceil((circuitOpenUntil - Date.now()) / 1000);
      throw new Error(`[LLM] Circuit breaker open — cooling down for ${remaining}s (too many rate limits)`);
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.client.chat.completions.create(params);
        consecutiveRateLimits = 0; // successful call resets the counter
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const is429 = msg.includes('429') || msg.toLowerCase().includes('rate limit');
        if (is429) {
          consecutiveRateLimits++;
          if (consecutiveRateLimits >= CIRCUIT_TRIP_THRESHOLD) {
            circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
            consecutiveRateLimits = 0;
            const cooldownSec = Math.round(CIRCUIT_COOLDOWN_MS / 1000);
            console.error(`[LLM] ⚡ Circuit breaker TRIPPED after ${CIRCUIT_TRIP_THRESHOLD} consecutive rate limits — blocking all requests for ${cooldownSec}s`);
            throw new Error(`[LLM] Circuit breaker tripped — all LLM requests blocked for ${cooldownSec}s`);
          }
          if (attempt < MAX_RETRIES) {
            if (attempt === 0) saveRateLimitDump(params);
            const waitMs = parseRetryAfterMs(msg);
            console.warn(`[LLM] Rate limited — retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
            await onStatus(`⏳ Rate limited — retrying in ${Math.round(waitMs / 1000)}s…`);
            await new Promise(r => setTimeout(r, waitMs));
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
    }
    throw new Error('LLM: max retries exceeded');
  }

  async runLoop(
    systemPrompt: string,
    userMessage: string,
    tools: McpTool[],
    onToolCall: (name: string, args: Record<string, unknown>) => Promise<string>,
    onStatus: StatusUpdater,
    model?: string,
    maxIterations = 10,
  ): Promise<string> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const openAITools = tools.map(toOpenAITool);
    let iterations = 0;

    for (;;) {
      if (iterations++ >= maxIterations) {
        return `⚠️ Stopped after ${maxIterations} tool-call rounds without a final answer.`;
      }
      const response = await this.createWithRetry({
        model: model ?? config.llm.model,
        messages,
        tools: openAITools.length > 0 ? openAITools : undefined,
        tool_choice: openAITools.length > 0 ? 'auto' : undefined,
      }, onStatus);

      const choice = response.choices[0];
      const msg = choice.message;
      messages.push(msg);

      if (choice.finish_reason === 'tool_calls' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          await onStatus(`🔧 running \`${tc.function.name}\`…`);

          let result: string;
          try {
            result = await onToolCall(tc.function.name, args);
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }

          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
      } else {
        return msg.content ?? '';
      }
    }
  }
}
