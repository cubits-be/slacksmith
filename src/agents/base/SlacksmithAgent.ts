import { App, LogLevel, SocketModeReceiver } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import fs from 'fs';
import path from 'path';
import { agentBus } from '../../core/AgentBus';
import { config } from '../../core/config';
import { McpTool } from '../../core/types';
import { LLMClient } from '../../llm/client';
import { buildSystemPrompt } from '../../llm/prompts';
import { McpRegistry } from '../../mcp/McpRegistry';
import { handleToolResult } from '../../mcp/resultHandler';
import { appendToLog, cleanupOldLogs } from '../../memory/DailyLog';
import { loadMemoryContext } from '../../memory/MemorySystem';
import { postResponse, stripMention } from '../../slack/formatting';
import { SkillRegistry } from '../../skills/SkillRegistry';
import { TaskRunner, validateTasksContent } from '../../tasks/TaskRunner';

export interface SharedServices {
  llm: LLMClient;
  mcp: McpRegistry;
}

export abstract class SlacksmithAgent {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly persona: string;
  /** Allowed MCP tool names. Undefined = all tools. */
  abstract readonly allowedTools: string[] | undefined;
  /** Excluded MCP tool names/prefixes. e.g. ["fs__*", "nodered__*"] */
  abstract readonly excludedTools: string[] | undefined;

  protected readonly app: App;
  private taskRunner?: TaskRunner;
  private skillRegistry?: SkillRegistry;

  constructor(
    private readonly botToken: string,
    private readonly appToken: string,
    protected readonly services: SharedServices,
    protected readonly model?: string,
  ) {
    this.app = new App({
      token: botToken,
      receiver: new SocketModeReceiver({
        appToken,
        logLevel: LogLevel.WARN,
        clientPingTimeout: 30_000,   // 30s — default 5s is too tight for Docker
        serverPingTimeout: 120_000,  // 120s — default 30s
      }),
      logLevel: LogLevel.WARN,
    });
  }

  async start(): Promise<void> {
    this.seedMemoryFiles();
    this.registerHandlers();

    agentBus.register(this.id, this);

    this.skillRegistry = new SkillRegistry(this.id);

    this.taskRunner = new TaskRunner(
      this.id,
      this.name,
      desc => this.executeTask(desc),
    );

    await this.app.start();
    console.log(`[${this.name}] connected to Slack ✓`);

    this.taskRunner.start();
    this.scheduleDailyCleanup();
  }

  async stop(): Promise<void> {
    this.taskRunner?.stop();
    await this.app.stop();
  }

  // ─── Handlers ───────────────────────────────────────────────────────────────

  private registerHandlers(): void {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.app.message(async ({ message, client }) => {
      const msg = message as {
        subtype?: string;
        bot_id?: string;
        channel_type?: string;
        text?: string;
        channel: string;
        ts: string;
        user?: string;
      };

      if (msg.subtype) return;
      if (msg.channel_type !== 'im') return;
      if (!msg.text) return;
      if (msg.bot_id) return; // ignore bot DMs — handoffs use AgentBus now

      if (config.slackUserId && msg.user !== config.slackUserId) return;
      await this.processMessage(msg.text, msg.channel, undefined, client as WebClient);
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.app.event('app_mention', async ({ event, client }) => {
      const text = stripMention(event.text ?? '');
      if (!text) return;
      if (config.slackUserId && event.user !== config.slackUserId) return;

      const threadTs = (event as { thread_ts?: string }).thread_ts ?? event.ts;
      await this.processMessage(text, event.channel, threadTs, client as WebClient);
    });
  }

  // ─── Core conversation pipeline ─────────────────────────────────────────────

  protected async processMessage(
    text: string,
    channelId: string,
    threadTs: string | undefined,
    client: WebClient,
    logRole = 'ME',
    autonomous = false,
  ): Promise<void> {
    const statusResult = await client.chat.postMessage({
      channel: channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: '⏳ thinking…',
    });
    const statusTs = statusResult.ts as string;

    const updateStatus = async (status: string): Promise<void> => {
      await client.chat.update({ channel: channelId, ts: statusTs, text: status });
    };

    try {
      const memoryContext = loadMemoryContext(this.id);
      const systemPrompt = buildSystemPrompt(this.loadPersona(), memoryContext, autonomous);
      const internal = this.internalTools();
      const mcpTools = this.services.mcp.getTools(this.allowedTools, 128 - internal.length, this.excludedTools);
      const tools = [...mcpTools, ...internal];

      const response = await this.services.llm.runLoop(
        systemPrompt,
        text,
        tools,
        async (toolName, args) => {
          console.log(`[${this.name}] tool call: ${toolName}`, JSON.stringify(args));
          const internal = await this.handleInternalTool(toolName, args);
          if (internal !== null) {
            console.log(`[${this.name}] tool result (internal): ${internal.slice(0, 200)}`);
            return internal;
          }
          const raw = await this.services.mcp.callTool(toolName, args);
          const result = handleToolResult(toolName, raw);
          console.log(`[${this.name}] tool result: ${result.slice(0, 200)}`);
          return result;
        },
        updateStatus,
        this.model,
      );

      await postResponse(client, channelId, statusTs, threadTs, response);

      await appendToLog(this.id, logRole, text);
      await appendToLog(this.id, this.name.toUpperCase(), response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.name}] error:`, msg);
      await updateStatus(`❌ ${msg}`).catch(() => undefined);
    }
  }

  // ─── Autonomous task execution ───────────────────────────────────────────────

  /** Called by AgentBus to deliver a message from another agent. Runs the LLM loop silently. */
  async receiveHandoff(text: string): Promise<void> {
    await this.processSilently(text);
  }

  /** Run the LLM + tools silently — no reply to any user or channel.
   *  The agent is responsible for posting its own output via _post_message as instructed by its skills/persona. */
  private async processSilently(text: string): Promise<void> {
    try {
      const memoryContext = loadMemoryContext(this.id);
      const systemPrompt = buildSystemPrompt(this.loadPersona(), memoryContext, true);
      const internal = this.internalTools();
      const mcpTools = this.services.mcp.getTools(this.allowedTools, 128 - internal.length, this.excludedTools);
      const tools = [...mcpTools, ...internal];

      const response = await this.services.llm.runLoop(
        systemPrompt,
        text,
        tools,
        async (toolName, args) => {
          console.log(`[${this.name}] tool call: ${toolName}`, JSON.stringify(args));
          const internalResult = await this.handleInternalTool(toolName, args);
          if (internalResult !== null) {
            console.log(`[${this.name}] tool result (internal): ${internalResult.slice(0, 200)}`);
            return internalResult;
          }
          const raw = await this.services.mcp.callTool(toolName, args);
          const result = handleToolResult(toolName, raw);
          console.log(`[${this.name}] tool result: ${result.slice(0, 200)}`);
          return result;
        },
        async () => { /* no status updates */ },
        this.model,
      );

      await appendToLog(this.id, 'HANDOFF', text);
      await appendToLog(this.id, this.name.toUpperCase(), response);
    } catch (err) {
      console.error(`[${this.name}] silent handoff error:`, err instanceof Error ? err.message : err);
    }
  }

  private async executeTask(description: string): Promise<void> {
    if (!config.slackUserId) {
      console.warn(`[${this.name}] SLACK_USER_ID not set — skipping task DM`);
      return;
    }

    const dmResult = await this.app.client.conversations.open({ users: config.slackUserId });
    const channelId = (dmResult.channel as { id?: string })?.id;
    if (!channelId) return;

    await this.processMessage(description, channelId, undefined, this.app.client, 'TASK', true);
  }

  // ─── TASKS.md management ────────────────────────────────────────────────────

  /** Called when the user asks the agent to update its task list. */
  updateTasksFile(content: string): void {
    this.taskRunner?.writeTasks(content);
  }

  readTasksFile(): string {
    return this.taskRunner?.readTasks() ?? '';
  }

  // ─── Internal tools (task management + skills) ─────────────────────────────

  private internalTools(): McpTool[] {
    const tools: McpTool[] = [
      {
        name: '_read_tasks',
        description: 'Read your current TASKS.md — your list of autonomous scheduled tasks.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: '_update_tasks',
        description:
          'Rewrite TASKS.md with updated task definitions. ' +
          'Call this whenever the user asks you to add, change, or remove a scheduled task. ' +
          'Always read the current tasks first, then write the full updated file.\n\n' +
          'TASKS.md format — each task is a block:\n' +
          '## task-slug\n' +
          'schedule: every 1h  (or: every 30m / every 2h / every 1d / daily 18:00)\n' +
          'action: What you should do when the task fires\n\n' +
          'Example:\n' +
          '## hourly-joke\n' +
          'schedule: every 1h\n' +
          'action: Send me a short joke\n',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Full new content for TASKS.md' },
          },
          required: ['content'],
        },
      },
    ];

    const skills = this.skillRegistry?.list() ?? [];
    if (skills.length > 0) {
      const skillList = skills.map(s => `- **${s.name}**: ${s.description}`).join('\n');
      tools.push({
        name: '_read_skill',
        description:
          'Load the full instructions for one of your skills. Call this when the current task matches a skill.\n\n' +
          `Available skills:\n${skillList}`,
        inputSchema: {
          type: 'object',
          properties: {
            skill_name: {
              type: 'string',
              description: 'The name of the skill to load',
              enum: skills.map(s => s.name),
            },
          },
          required: ['skill_name'],
        },
      });
    }

    tools.push({
      name: '_dispatch',
      description:
        'Send a message to another Slacksmith agent internally — no Slack API call, no rate limits. ' +
        'Use this to hand off work to another agent (e.g., send a bug report to devbot). ' +
        `Available agents: ${agentBus.list().filter(id => id !== this.id).join(', ') || '(none yet)'}`,
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Target agent ID (e.g. "devbot")' },
          message: { type: 'string', description: 'Message to send to the agent' },
        },
        required: ['agent', 'message'],
      },
    });

    tools.push({
      name: '_post_message',
      description:
        'Post a message to a Slack channel or DM using your own bot identity. ' +
        'Use this instead of any MCP Slack tool — this posts as YOU, not as a shared hub bot. ' +
        'IMPORTANT: The channel parameter must be a channel ID (e.g. C0B5WMSK2BC), never a channel name like #dev-handoff. ' +
        'Use _list_channels to find IDs if needed.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel ID (e.g. C0B5WMSK2BC) or user ID for a DM' },
          text: { type: 'string', description: 'Message text (supports Slack mrkdwn)' },
          thread_ts: { type: 'string', description: 'Optional: thread timestamp to reply in a thread' },
        },
        required: ['channel', 'text'],
      },
    });

    tools.push({
      name: '_list_channels',
      description: 'List Slack channels this bot has joined. Use this to find channel IDs.',
      inputSchema: { type: 'object', properties: {} },
    });

    return tools;
  }

  /** Returns the result string if it is an internal tool, null to fall through to MCP. */
  private async handleInternalTool(name: string, args: Record<string, unknown>): Promise<string | null> {
    if (name === '_read_tasks') {
      return this.readTasksFile() || '(TASKS.md is empty)';
    }
    if (name === '_update_tasks') {
      const content = String(args.content ?? '');
      const err = validateTasksContent(content);
      if (err) return `TASKS.md NOT updated — validation failed: ${err}`;
      this.updateTasksFile(content);
      return 'TASKS.md updated successfully.';
    }
    if (name === '_read_skill') {
      const skillName = String(args.skill_name ?? '');
      const content = this.skillRegistry?.read(skillName);
      return content ?? `Skill "${skillName}" not found.`;
    }
    if (name === '_dispatch') {
      const targetId = String(args.agent ?? '');
      const message = String(args.message ?? '');
      return agentBus.dispatch(targetId, message);
    }
    if (name === '_post_message') {
      const channel = String(args.channel ?? '');
      const text = String(args.text ?? '');
      const thread_ts = args.thread_ts ? String(args.thread_ts) : undefined;
      try {
        await this.app.client.chat.postMessage({ channel, text, ...(thread_ts ? { thread_ts } : {}) });
        return 'Message posted.';
      } catch (err) {
        return `Failed to post message: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (name === '_list_channels') {
      try {
        const result = await this.app.client.conversations.list({ types: 'public_channel,private_channel', limit: 200, exclude_archived: true });
        const channels = (result.channels ?? [])
          .filter((c: { is_member?: boolean }) => c.is_member)
          .map((c: { id?: string; name?: string }) => `${c.id}  #${c.name}`)
          .join('\n');
        return channels || '(not a member of any channels — invite the bot first)';
      } catch (err) {
        return `Failed to list channels: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return null;
  }

  // ─── Notifications ──────────────────────────────────────────────────────────

  /** DM the configured user directly — used for milestone and task notifications. */
  async postToUser(text: string): Promise<void> {
    if (!config.slackUserId) return;
    try {
      const dmResult = await this.app.client.conversations.open({ users: config.slackUserId });
      const channelId = (dmResult.channel as { id?: string })?.id;
      if (channelId) {
        await this.app.client.chat.postMessage({ channel: channelId, text });
      }
    } catch (err) {
      console.warn(`[${this.name}] postToUser failed:`, err instanceof Error ? err.message : err);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Load persona from PERSONA.md, falling back to the hardcoded `persona` property. */
  private loadPersona(): string {
    const personaPath = path.join(config.agentsDir, this.id, 'PERSONA.md');
    try {
      const content = fs.readFileSync(personaPath, 'utf-8').trim();
      if (content) return content;
    } catch {
      // file not found — use default
    }
    return this.persona;
  }

  private seedMemoryFiles(): void {
    const agentDir = path.join(config.agentsDir, this.id);
    fs.mkdirSync(path.join(agentDir, 'daily'), { recursive: true });
    fs.mkdirSync(path.join(agentDir, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(agentDir, 'skills'), { recursive: true });

    const contextPath = path.join(config.agentsDir, 'context.md');
    if (!fs.existsSync(contextPath)) {
      fs.mkdirSync(config.agentsDir, { recursive: true });
      fs.writeFileSync(contextPath, '# Personal Context\n\n(Edit to add your personal context.)\n');
    }

    const tasksPath = path.join(agentDir, 'TASKS.md');
    if (!fs.existsSync(tasksPath)) {
      fs.writeFileSync(tasksPath, `# ${this.name} — Tasks\n\n# Add tasks using this format:\n# ## task-slug\n# schedule: every 1h  (or: every 30m / daily 18:00)\n# action: What to do\n`);
    }

    // Seed PERSONA.md only if absent (never overwrite user edits)
    const personaPath = path.join(agentDir, 'PERSONA.md');
    if (!fs.existsSync(personaPath)) {
      fs.writeFileSync(personaPath, this.persona + '\n');
    }
  }

  private scheduleDailyCleanup(): void {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const msUntilMidnight = midnight.getTime() - now.getTime();

    setTimeout(() => {
      cleanupOldLogs(this.id);
      setInterval(() => cleanupOldLogs(this.id), 86_400_000);
    }, msUntilMidnight);
  }
}
