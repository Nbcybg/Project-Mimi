import type { ConnectorSpec } from '@mimi/shared';

export const facebookConnector: ConnectorSpec = {
  key: 'facebook',
  label: 'Facebook Pages',
  category: 'marketing',
  description: 'List managed Pages and publish or read Page feed posts through the Meta Graph API; write scopes need an app review',
  baseUrl: 'https://graph.facebook.com/v19.0',
  auth: {
    kind: 'oauth2',
    fields: [
      { key: 'clientId', label: 'Client ID', type: 'string', required: true },
      { key: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
      { key: 'refreshToken', label: 'Refresh token', type: 'secret', required: true },
      { key: 'accessToken', label: 'Access token', type: 'secret' },
      { key: 'expiresAt', label: 'Expires at', type: 'string' },
    ],
    authorizeUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
    scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
  },
  operations: [
    {
      key: 'list_pages',
      label: 'List Pages',
      method: 'GET',
      path: '/me/accounts',
      risk: 'read',
      fields: [],
      response: { itemsPath: 'data' },
      paginated: true,
    },
    {
      key: 'create_post',
      label: 'Create Page post',
      method: 'POST',
      path: '/{pageId}/feed',
      risk: 'write',
      body: { message: '{{message}}' },
      fields: [
        { key: 'pageId', label: 'Page ID', type: 'string', required: true, placeholder: '1234567890' },
        { key: 'message', label: 'Message', type: 'string', required: true },
      ],
    },
    {
      key: 'list_posts',
      label: 'List Page posts',
      method: 'GET',
      path: '/{pageId}/posts',
      risk: 'read',
      fields: [{ key: 'pageId', label: 'Page ID', type: 'string', required: true }],
      response: { itemsPath: 'data' },
      untrustedInput: true,
      paginated: true,
    },
  ],
  pagination: { mode: 'cursor', cursorParam: 'after', itemsPath: 'data', nextPath: 'paging.cursors.after' },
  rateLimit: { requests: 10, perMs: 1000, burst: 10 },
};
