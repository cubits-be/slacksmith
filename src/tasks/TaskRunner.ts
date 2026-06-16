import fs from 'fs';
import path from 'path';
import { config } from '../core/config';

const TICK_INTERVAL_MS = 15 * 60 * 1_000;
const INITIAL_DELAY_MS = 60 * 1_000;

export type TaskExecutor = (description: string) => Promise<void>;

interface ParsedTask {
  name: string;
  action: string;
  intervalMs?: number;
  dailyTime?: { hour: number; minute: number };
}

type StateMap = Record<string, string>; // task name → ISO last-run timestamp

// ─── Schedule parser ─────────────────────────────────────────────────────────

function parseSchedule(schedule: string): Pick<ParsedTask, 'intervalMs' | 'dailyTime'> {
  const minuteMatch = schedule.match(/every\s+(\d+)\s*m(?:in(?:utes?)?)?(?:\s|$)/i);
  if (minuteMatch) return { intervalMs: parseInt(minuteMatch[1]) * 60_000 };

  const hourMatch = schedule.match(/every\s+(\d+)\s*h(?:ours?)?(?:\s|$)/i);
  if (hourMatch) return { intervalMs: parseInt(hourMatch[1]) * 3_600_000 };

  const dayMatch = schedule.match(/every\s+(\d+)\s*d(?:ays?)?(?:\s|$)/i);
  if (dayMatch) return { intervalMs: parseInt(dayMatch[1]) * 86_400_000 };

  const dailyMatch = schedule.match(/daily(?:\s+at)?\s+(\d{1,2}):(\d{2})/i);
  if (dailyMatch) return { dailyTime: { hour: parseInt(dailyMatch[1]), minute: parseInt(dailyMatch[2]) } };

  return {};
}

// ─── TASKS.md parser ──────────────────────────────────────────────────────────
//
// Expected format:
//   ## task-name
//   schedule: every 1h   (or: every 30m / every 2h / daily 18:00)
//   action: Send me a short joke

function parseTasksFile(content: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  let name = '';
  let scheduleStr = '';
  let actionStr = '';

  const push = () => {
    if (!name || !scheduleStr || !actionStr) return;
    const task: ParsedTask = { name, action: actionStr, ...parseSchedule(scheduleStr) };
    if (task.intervalMs !== undefined || task.dailyTime) tasks.push(task);
    name = scheduleStr = actionStr = '';
  };

  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t.startsWith('## ')) { push(); name = t.slice(3).trim(); }
    else if (/^schedule:/i.test(t)) scheduleStr = t.replace(/^schedule:\s*/i, '').trim();
    else if (/^action:/i.test(t)) actionStr = t.replace(/^action:\s*/i, '').trim();
  }
  push();
  return tasks;
}

/** Returns null if valid, or an error string describing what's wrong. */
export function validateTasksContent(content: string): string | null {
  const tasks = parseTasksFile(content);
  if (tasks.length === 0 && content.includes('##')) {
    return 'No valid tasks found. Each task needs ## name, schedule:, and action: lines with a recognised schedule format.';
  }
  return null;
}



function isDue(task: ParsedTask, lastRun: Date | null, now: Date): boolean {
  if (task.intervalMs !== undefined) {
    if (!lastRun) return true;
    return now.getTime() - lastRun.getTime() >= task.intervalMs;
  }
  if (task.dailyTime) {
    const { hour, minute } = task.dailyTime;
    const scheduledToday = new Date(now);
    scheduledToday.setHours(hour, minute, 0, 0);
    if (now < scheduledToday) return false; // not yet today
    if (!lastRun) return true;
    return lastRun < scheduledToday; // ran before today's scheduled slot
  }
  return false;
}

// ─── TaskRunner ────────────────────────────────────────────────────────────────

export class TaskRunner {
  private timer?: ReturnType<typeof setInterval>;
  private initialTimer?: ReturnType<typeof setTimeout>;
  private ticking = false;

  constructor(
    private readonly agentId: string,
    private readonly agentName: string,
    private readonly execute: TaskExecutor,
  ) {}

  start(): void {
    this.initialTimer = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    }, INITIAL_DELAY_MS);
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
  }

  private tasksPath(): string {
    return path.join(config.agentsDir, this.agentId, 'TASKS.md');
  }

  private statePath(): string {
    return path.join(config.agentsDir, this.agentId, 'STATE.json');
  }

  readTasks(): string {
    try { return fs.readFileSync(this.tasksPath(), 'utf8'); } catch { return ''; }
  }

  writeTasks(content: string): void {
    const p = this.tasksPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }

  private readState(): StateMap {
    try { return JSON.parse(fs.readFileSync(this.statePath(), 'utf8')) as StateMap; } catch { return {}; }
  }

  private writeState(state: StateMap): void {
    fs.writeFileSync(this.statePath(), JSON.stringify(state, null, 2), 'utf8');
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      console.log(`[${this.agentName}] TaskRunner: previous tick still running, skipping`);
      return;
    }
    this.ticking = true;
    try { await this.doTick(); }
    finally { this.ticking = false; }
  }

  private async doTick(): Promise<void> {
    const tasksContent = this.readTasks();
    if (!tasksContent.trim()) return;

    const tasks = parseTasksFile(tasksContent);
    if (tasks.length === 0) return;

    const state = this.readState();
    const now = new Date();

    for (const task of tasks) {
      const lastRun = state[task.name] ? new Date(state[task.name]) : null;
      if (!isDue(task, lastRun, now)) continue;

      console.log(`[${this.agentName}] Task due: ${task.name} → ${task.action}`);
      try {
        await this.execute(task.action);
        state[task.name] = now.toISOString();
        this.writeState(state); // persist after each task in case of crash
      } catch (err) {
        console.error(`[${this.agentName}] Task execution failed (${task.name}):`, err);
      }
    }
  }
}
