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
  weeklyTime?: { weekday: number; hour: number; minute: number };
}

type StateMap = Record<string, string>; // task name → ISO last-run timestamp

/** Weekday name (and common abbreviations) → JS getDay() index (Sunday = 0). */
const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

// ─── Schedule parser ─────────────────────────────────────────────────────────

/** Parse HH:MM, returning null if out of range (so it surfaces as invalid). */
function parseHM(h: string, m: string): { hour: number; minute: number } | null {
  const hour = parseInt(h, 10);
  const minute = parseInt(m, 10);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function parseSchedule(schedule: string): Pick<ParsedTask, 'intervalMs' | 'dailyTime' | 'weeklyTime'> {
  const minuteMatch = schedule.match(/every\s+(\d+)\s*m(?:in(?:utes?)?)?(?:\s|$)/i);
  if (minuteMatch) return { intervalMs: parseInt(minuteMatch[1]) * 60_000 };

  const hourMatch = schedule.match(/every\s+(\d+)\s*h(?:ours?)?(?:\s|$)/i);
  if (hourMatch) return { intervalMs: parseInt(hourMatch[1]) * 3_600_000 };

  const dayMatch = schedule.match(/every\s+(\d+)\s*d(?:ays?)?(?:\s|$)/i);
  if (dayMatch) return { intervalMs: parseInt(dayMatch[1]) * 86_400_000 };

  // weekly on a named day: "weekly friday 09:00" / "every sunday 12:00"
  const weeklyMatch = schedule.match(/(?:weekly|every)\s+([a-z]+)\s+(\d{1,2}):(\d{2})/i);
  if (weeklyMatch) {
    const weekday = WEEKDAYS[weeklyMatch[1].toLowerCase()];
    const hm = parseHM(weeklyMatch[2], weeklyMatch[3]);
    if (weekday !== undefined && hm) return { weeklyTime: { weekday, ...hm } };
  }

  const dailyMatch = schedule.match(/daily(?:\s+at)?\s+(\d{1,2}):(\d{2})/i);
  if (dailyMatch) {
    const hm = parseHM(dailyMatch[1], dailyMatch[2]);
    if (hm) return { dailyTime: hm };
  }

  return {};
}

// ─── TASKS.md parser ──────────────────────────────────────────────────────────
//
// Expected format:
//   ## task-name
//   schedule: every 1h   (or: every 30m / every 2h / daily 18:00)
//   action: Send me a short joke

const SCHEDULE_HELP =
  'Use "every 30m", "every 2h", "every 1d", "daily 18:00", or "weekly friday 09:00".';

interface ParseResult {
  tasks: ParsedTask[];
  /** Human-readable problems (unrecognized schedule, incomplete block). */
  errors: string[];
}

function parseTasksFile(content: string): ParseResult {
  const tasks: ParsedTask[] = [];
  const errors: string[] = [];
  let name = '';
  let scheduleStr = '';
  let actionStr = '';

  const push = () => {
    if (!name) return;
    // A block with a name but only part of schedule/action is a likely typo —
    // surface it rather than silently dropping the task.
    if (!scheduleStr || !actionStr) {
      if (scheduleStr || actionStr) {
        errors.push(`Task "${name}" is missing its ${!scheduleStr ? 'schedule:' : 'action:'} line.`);
      }
      name = scheduleStr = actionStr = '';
      return;
    }
    const sched = parseSchedule(scheduleStr);
    if (sched.intervalMs === undefined && !sched.dailyTime && !sched.weeklyTime) {
      errors.push(`Task "${name}" has an unrecognized schedule "${scheduleStr}". ${SCHEDULE_HELP}`);
    } else {
      tasks.push({ name, action: actionStr, ...sched });
    }
    name = scheduleStr = actionStr = '';
  };

  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t.startsWith('## ')) { push(); name = t.slice(3).trim(); }
    else if (/^schedule:/i.test(t)) scheduleStr = t.replace(/^schedule:\s*/i, '').trim();
    else if (/^action:/i.test(t)) actionStr = t.replace(/^action:\s*/i, '').trim();
  }
  push();
  return { tasks, errors };
}

/** Returns null if valid, or an error string describing what's wrong. */
export function validateTasksContent(content: string): string | null {
  const { tasks, errors } = parseTasksFile(content);
  if (errors.length > 0) return errors.join(' ');
  if (tasks.length === 0 && content.includes('##')) {
    return `No valid tasks found. Each task needs ## name, schedule:, and action: lines. ${SCHEDULE_HELP}`;
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
  if (task.weeklyTime) {
    const { weekday, hour, minute } = task.weeklyTime;
    if (now.getDay() !== weekday) return false; // not the scheduled day
    const scheduledToday = new Date(now);
    scheduledToday.setHours(hour, minute, 0, 0);
    if (now < scheduledToday) return false; // day matches, but time not reached
    if (!lastRun) return true;
    return lastRun < scheduledToday; // ran before this week's scheduled slot
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

    const { tasks, errors } = parseTasksFile(tasksContent);
    for (const err of errors) {
      console.warn(`[${this.agentName}] TASKS.md: ${err}`);
    }
    if (tasks.length === 0) return;

    const state = this.readState();
    const now = new Date();

    for (const task of tasks) {
      const lastRun = state[task.name] ? new Date(state[task.name]) : null;
      if (!isDue(task, lastRun, now)) continue;

      console.log(`[${this.agentName}] Task due: ${task.name} → ${task.action}`);
      // Record the fire BEFORE awaiting execution so this occurrence counts as
      // done even if execution throws (LLM error, circuit breaker, Slack API
      // hiccup) or the process crashes mid-run. Otherwise lastRun never advances
      // and the task re-fires on every tick until it happens to succeed — the
      // storm that spammed #daily-summary. Trade-off: a failed run is skipped
      // until the next scheduled occurrence rather than retried.
      state[task.name] = now.toISOString();
      this.writeState(state);
      try {
        await this.execute(task.action);
      } catch (err) {
        console.error(`[${this.agentName}] Task execution failed (${task.name}):`, err);
      }
    }
  }
}
