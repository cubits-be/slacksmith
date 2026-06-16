import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { McpConfig } from './types';

dotenv.config();

function validateRequired(name: string, value: string): void {
  if (!value || value.trim() === '') {
    throw new Error(`${name} is required — add it to .env`);
  }
}

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
  validateRequired('OPENAI_API_KEY', config.llm.apiKey);
  validateRequired('SLACK_USER_ID', config.slackUserId);

  if (!fs.existsSync(config.mcpConfigPath)) {
    return { servers: [] };
  }

  const raw = fs.readFileSync(config.mcpConfigPath, 'utf8');
  const substituted = raw.replace(/\$\{([^}]+)\}/g, (match, key) => {
    const [envKey, defaultVal] = key.split(':-');
    return process.env[envKey.trim()] ?? defaultVal ?? match;
  });

  return JSON.parse(substituted) as McpConfig;
}
