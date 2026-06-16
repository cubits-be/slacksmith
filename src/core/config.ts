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
    const sepIdx = key.indexOf(':-');
    const envKey = (sepIdx === -1 ? key : key.slice(0, sepIdx)).trim();
    const defaultVal = sepIdx === -1 ? undefined : key.slice(sepIdx + 2);
    const value = process.env[envKey] ?? defaultVal;
    if (value === undefined) {
      throw new Error(`mcp.config.json references unset env var: ${envKey} (add it to .env or provide a default with \${${envKey}:-default})`);
    }
    return value;
  });

  return JSON.parse(substituted) as McpConfig;
}
