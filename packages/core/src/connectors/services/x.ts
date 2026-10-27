import type { ConnectorSpec } from '@mimi/shared';

export const xConnector: ConnectorSpec = {
  key: 'x',
  label: 'X',
  category: 'marketing',
  description: 'Publish, list and delete posts through the X API v2; OAuth2 with PKCE and the usual developer plan limits apply',
  baseUrl: 'https://api.twitter.com',
  auth: {
    kind: 'oauth2',
    fields: [
      { key: 'clientId', label: 'Client ID', type: 'string', required: true },
      { key: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
      { key: 'refreshToken', label: 'Refresh token', type: 'secret', required: true },
      { key: 'accessToken', label: 'Access token', type: 'secret' },
      { key: 'expiresAt', label: 'Expires at', type: 'string' },
    ],
    authorizeUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
    extra: { pkce: true },
  },
  operations: [
    {
      key: 'create_post',
      label: 'Create post',
      method: 'POST',
      path: '/2/tweets',
      risk: 'write',
      body: { text: '{{text}}' },
      fields: [{ key: 'text', label: 'Text', type: 'string', required: true }],
    },
    {
      key: 'list_posts',
      label: 'List user posts',
      method: 'GET',
      path: '/2/users/{userId}/tweets',
      risk: 'read',
      fields: [
        { key: 'userId', label: 'User ID', type: 'string', required: true },
        { key: 'maxResults', label: 'Max results', type: 'number', required: false, default: 10 },
      ],
      response: { itemsPath: 'data' },
      untrustedInput: true,
      paginated: true,
    },
    {
      key: 'delete_post',
      label: 'Delete post',
      method: 'DELETE',
      path: '/2/tweets/{postId}',
      risk: 'delete',
      fields: [{ key: 'postId', label: 'Post ID', type: 'string', required: true }],
    },
  ],
  pagination: { mode: 'cursor', cursorParam: 'pagination_token', itemsPath: 'data', nextPath: 'meta.next_token' },
  rateLimit: { requests: 10, perMs: 1000, burst: 10 },
};
