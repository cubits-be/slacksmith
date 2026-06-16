import './core/config'; // load dotenv early
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { config } from './core/config';
import { AgentFileConfig } from './core/types';
import { LLMClient } from './llm/client';
import { McpRegistry } from './mcp/McpRegistry';
import { DynamicAgent } from './agents/dynamic';
import { SlacksmithAgent } from './agents/base/SlacksmithAgent';
import { SharedServices } from './agents/base/SlacksmithAgent';

function loadAgents(services: SharedServices): SlacksmithAgent[] {
  const agents: SlacksmithAgent[] = [];

  if (!fs.existsSync(config.agentsDir)) {
    console.warn(`Agents directory not found: ${config.agentsDir}`);
    return agents;
  }

  for (const entry of fs.readdirSync(config.agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const cfgPath = path.join(config.agentsDir, id, 'agent.json');
    if (!fs.existsSync(cfgPath)) continue;

    const agentCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as AgentFileConfig;

    // Load agent-local .env (preferred), fall back to root .env convention
    let botToken: string | undefined;
    let appToken: string | undefined;
    let model: string | undefined;

    const agentEnvPath = path.join(config.agentsDir, id, '.env');
    if (fs.existsSync(agentEnvPath)) {
      const agentEnv = dotenv.parse(fs.readFileSync(agentEnvPath, 'utf8'));
      botToken = agentEnv.SLACK_BOT_TOKEN || undefined;
      appToken = agentEnv.SLACK_APP_TOKEN || undefined;
      model = agentEnv.LLM_MODEL || undefined;
    }

    // Fall back to root .env convention: SLACK_BOT_TOKEN_<ID>
    const envId = id.toUpperCase().replace(/-/g, '_');
    botToken ??= process.env[`SLACK_BOT_TOKEN_${envId}`];
    appToken ??= process.env[`SLACK_APP_TOKEN_${envId}`];
    model = model ?? process.env[`LLM_MODEL_${envId}`] ?? agentCfg.model;

    if (!botToken || !appToken) {
      console.warn(`[${id}] Skipping — no Slack tokens found (set in agents/${id}/.env or root .env as SLACK_BOT_TOKEN_${envId})`);
      continue;
    }

    agents.push(new DynamicAgent(
      id,
      agentCfg.name,
      botToken,
      appToken,
      services,
      model,
      agentCfg.allowedTools,
      agentCfg.excludedTools,
    ));
  }

  return agents;
}

async function main(): Promise<void> {
  const llm = new LLMClient();
  const mcp = new McpRegistry();

  console.log('Initializing MCP registry…');
  await mcp.initialize();

  const services = { llm, mcp };
  const agents = loadAgents(services);

  if (agents.length === 0) {
    console.error('No agents configured. Add an agents/<id>/agent.json and set SLACK_BOT_TOKEN_<ID> + SLACK_APP_TOKEN_<ID> in .env');
    process.exit(1);
  }

  console.log(`Starting ${agents.length} agent(s)…`);
  await Promise.all(agents.map(a => a.start()));
  console.log('All agents running. Ctrl+C to stop.');

  // ── Startup notification ────────────────────────────────────────────────────
  const firstAgent = agents[0];
  const toolCount = mcp.getTools(firstAgent.allowedTools, 128, firstAgent.excludedTools).length;
  const agentList = agents.map(a => `@${a.id}`).join(', ');
  await agents[0].postToUser(
    `🔨 *Slacksmith ready* — ${toolCount} MCP tool${toolCount !== 1 ? 's' : ''} · ${agents.length} agent${agents.length !== 1 ? 's' : ''} (${agentList})`,
  );

  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down…');
    await Promise.all(agents.map(a => a.stop()));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
