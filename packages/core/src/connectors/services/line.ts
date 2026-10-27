import type { ConnectorSpec } from '@mimi/shared';

export const lineConnector: ConnectorSpec = {
  key: 'line',
  label: 'LINE',
  category: 'communication',
  description: 'Send text or Flex messages and list follower IDs through the LINE Messaging API',
  baseUrl: 'https://api.line.me/v2',
  auth: {
    kind: 'apiKey',
    fields: [{ key: 'channelAccessToken', label: 'Channel access token', type: 'secret', required: true, description: 'Bearer token from the LINE Developers console' }],
  },
  operations: [
    {
      key: 'send_text',
      label: 'Send text',
      method: 'POST',
      path: '/bot/message/push',
      risk: 'write',
      body: { to: '{{to}}', messages: [{ type: 'text', text: '{{text}}' }] },
      fields: [
        { key: 'to', label: 'User, group or room ID', type: 'string', required: true },
        { key: 'text', label: 'Text', type: 'string', required: true },
      ],
    },
    {
      key: 'send_flex',
      label: 'Send Flex message',
      method: 'POST',
      path: '/bot/message/push',
      risk: 'write',
      body: { to: '{{to}}', messages: [{ type: 'flex', altText: '{{altText}}', contents: '{{contents}}' }] },
      fields: [
        { key: 'to', label: 'User, group or room ID', type: 'string', required: true },
        { key: 'altText', label: 'Alternative text', type: 'string', required: true },
        { key: 'contents', label: 'Flex contents (JSON)', type: 'json', required: true },
      ],
    },
    {
      key: 'list_followers',
      label: 'List follower IDs',
      method: 'GET',
      path: '/bot/followers/ids',
      risk: 'read',
      fields: [{ key: 'start', label: 'Start token', type: 'string', required: false }],
      response: { itemsPath: 'userIds' },
    },
  ],
  rateLimit: { requests: 10, perMs: 1000, burst: 10 },
};
