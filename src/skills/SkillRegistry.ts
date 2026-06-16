import fs from 'fs';
import path from 'path';
import { config } from '../core/config';

export interface SkillMeta {
  name: string;
  description: string;
  filename: string;
}

/** Parse YAML frontmatter from a skill file. */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = value;
  }
  return result;
}

export class SkillRegistry {
  private readonly skillsDir: string;

  constructor(agentId: string) {
    this.skillsDir = path.join(config.agentsDir, agentId, 'skills');
  }

  /** List all available skills (name + description only, for the tool definition). */
  list(): SkillMeta[] {
    if (!fs.existsSync(this.skillsDir)) return [];

    return fs
      .readdirSync(this.skillsDir)
      .filter(f => f.endsWith('.md'))
      .flatMap(filename => {
        try {
          const content = fs.readFileSync(path.join(this.skillsDir, filename), 'utf8');
          const fm = parseFrontmatter(content);
          const name = fm.name ?? filename.replace('.md', '');
          const description = fm.description ?? `Skill: ${name}`;
          return [{ name, description, filename }];
        } catch {
          return [];
        }
      });
  }

  /** Read the full content of a skill by name. */
  read(skillName: string): string | null {
    const skill = this.list().find(s => s.name === skillName);
    if (!skill) return null;
    try {
      return fs.readFileSync(path.join(this.skillsDir, skill.filename), 'utf8');
    } catch {
      return null;
    }
  }
}
