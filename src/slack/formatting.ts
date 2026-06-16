import type { WebClient } from '@slack/web-api';

const MAX_INLINE_LENGTH = 3000;
const SNIPPET_PREVIEW_LENGTH = 500;

export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();
}

export async function postResponse(
  client: WebClient,
  channelId: string,
  statusTs: string,
  threadTs: string | undefined,
  text: string,
): Promise<void> {
  if (text.length < MAX_INLINE_LENGTH) {
    await client.chat.update({ channel: channelId, ts: statusTs, text });
    return;
  }

  // Update with preview, upload full response as file
  const preview = `${text.slice(0, SNIPPET_PREVIEW_LENGTH)}\n\n_[Full response attached]_`;
  await client.chat.update({ channel: channelId, ts: statusTs, text: preview });

  await client.files.uploadV2({
    channel_id: channelId,
    ...(threadTs !== undefined ? { thread_ts: threadTs } : { thread_ts: statusTs }),
    content: text,
    filename: 'response.md',
    title: 'Full Response',
  });
}
