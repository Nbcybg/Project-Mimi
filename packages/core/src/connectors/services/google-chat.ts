import type { ConnectorSpec } from '@mimi/shared';

export const googleChatConnector: ConnectorSpec = {
  key: 'google_chat',
  label: 'Google Chat',
  category: 'communication',
  description: 'List spaces and messages, and send text messages through the Google Chat API',
  baseUrl: 'https://chat.googleapis.com',
  auth: {
    kind: 'oauth2',
    fields: [],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/chat.spaces.readonly',
      'https://www.googleapis.com/auth/chat.messages',
      'https://www.googleapis.com/auth/chat.messages.readonly',
    ],
    extra: { provider: 'google' },
  },
  operations: [
    {
      key: 'list_spaces',
      label: 'List spaces',
      method: 'GET',
      path: '/v1/spaces',
      risk: 'read',
      fields: [],
      response: { itemsPath: 'spaces' },
      paginated: true,
    },
    {
      key: 'send_message',
      label: 'Send message',
      method: 'POST',
      path: '/v1/spaces/{spaceId}/messages',
      risk: 'write',
      body: { text: '{{text}}' },
      fields: [
        { key: 'spaceId', label: 'Space ID', type: 'string', required: true, placeholder: 'spaces/AAAA1234' },
        { key: 'text', label: 'Text', type: 'string', required: true },
      ],
    },
    {
      key: 'list_messages',
      label: 'List messages',
      method: 'GET',
      path: '/v1/spaces/{spaceId}/messages',
      risk: 'read',
      fields: [{ key: 'spaceId', label: 'Space ID', type: 'string', required: true }],
      response: { itemsPath: 'messages' },
      untrustedInput: true,
      paginated: true,
    },
  ],
  pagination: { mode: 'nextPageToken', cursorParam: 'pageToken', itemsPath: 'messages', nextPath: 'nextPageToken' },
  rateLimit: { requests: 10, perMs: 1000, burst: 10 },
};
