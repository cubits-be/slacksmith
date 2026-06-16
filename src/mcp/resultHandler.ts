import fs from 'fs';
import path from 'path';
import { config } from '../core/config';

/** Characters returned inline to the LLM (~20k ≈ ~5k tokens, well within context). */
const MAX_INLINE_CHARS = 20_000;

/** If result is large, save to a temp file and return a truncated summary. */
export function handleToolResult(toolName: string, result: string): string {
  if (result.length <= MAX_INLINE_CHARS) return result;

  const tmpDir = path.join(config.agentsDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const filename = `${toolName}-${Date.now()}.txt`;
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, result, 'utf8');

  const preview = result.slice(0, 8_000);
  return (
    `[Result truncated — ${result.length} chars, full response saved to ${filePath}]\n\n` +
    `${preview}\n\n[...continued in file above]`
  );
}
