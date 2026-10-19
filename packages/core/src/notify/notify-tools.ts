import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';

/** Posts into the agent's direct chat and raises a notification; says where it landed. */
export type NotifyUser = (agent: string, message: string, title?: string) => { chatId?: number };

/**
 * Lets an agent reach the user on its own: the message lands in the agent's direct chat
 * (even while the agent is working for another agent or on a schedule) and the user gets
 * a notification in the app, on every device that turned push on.
 */
export function createNotifyTools(notifyUser: NotifyUser): ToolDefinition<any>[] {
  const notify = defineTool({
    name: 'notify_user',
    description:
      'Send the user a notification and post the message in your own chat with them. Use it when something needs their attention while they may be elsewhere: a finished task, an important email, an upcoming appointment, a reminder another agent asked you to pass on. Keep it short and self-contained; do not use it for your normal reply in the chat the user is talking to you in.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      message: z.string().min(1).max(4000).describe('What the user should know, complete on its own'),
      title: z.string().max(120).optional().describe('A few words for the notification title (default: your name)'),
    }),
    summarize: (input) => `Notify the user: ${input.message.slice(0, 120)}`,
    async execute(input, context) {
      const { chatId } = notifyUser(context.agent, input.message.trim(), input.title?.trim() || undefined);
      return chatId !== undefined ? `Notified the user and posted it in your chat (#${chatId}).` : 'Notified the user.';
    },
  });
  return [notify];
}
