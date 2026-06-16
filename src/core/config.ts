import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { McpConfig } from './types';

dotenv.config();

export const config = {
  llm: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'gpt-4o',
  },
  agentsDir: path.resolve(process.env.AGENTS_DIR ?? './agents'),
  mcpConfigPath: path.resolve(process.env.MCP_CONFIG_PATH ?? './mcp.config.json'),
  slackUserId: process.env.SLACK_USER_ID ?? '',
};

export function loadMcpConfig(): McpConfig {
  if (!fs.existsSync(config.mcpConfigPath)) {
    return { servers: [] };
  }
  return JSON.parse(fs.readFileSync(config.mcpConfigPath, 'utf8')) as McpConfig;
}
