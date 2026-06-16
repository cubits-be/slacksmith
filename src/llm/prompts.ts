export function buildSystemPrompt(persona: string, memoryContext: string, autonomous = false): string {
  const now = new Date().toISOString();
  const parts = [persona, `Current time: ${now}`];
  if (autonomous) {
    parts.push(
      'CONTEXT: You are executing an autonomous scheduled task. ' +
      'Your response will be delivered directly to the user as a Slack message — YOU are the one sending it. ' +
      'Do not say you cannot send or automate messages. Just perform the task and send the result.',
    );
  }
  if (memoryContext) parts.push(memoryContext);
  return parts.join('\n\n');
}
