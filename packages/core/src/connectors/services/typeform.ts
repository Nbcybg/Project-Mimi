import type { ConnectorSpec } from '@mimi/shared';

export const typeformConnector: ConnectorSpec = {
  key: 'typeform',
  label: 'Typeform',
  category: 'forms',
  description: 'List forms, read one form and list its responses',
  baseUrl: 'https://api.typeform.com',
  auth: {
    kind: 'oauth2',
    fields: [
      { key: 'clientId', label: 'Client ID', type: 'string', required: true },
      { key: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
      { key: 'refreshToken', label: 'Refresh token', type: 'secret', required: true },
      { key: 'accessToken', label: 'Access token', type: 'secret' },
      { key: 'expiresAt', label: 'Expires at', type: 'string' },
    ],
    authorizeUrl: 'https://api.typeform.com/oauth/authorize',
    tokenUrl: 'https://api.typeform.com/oauth/token',
    scopes: ['forms:read', 'responses:read'],
  },
  operations: [
    {
      key: 'list_forms',
      label: 'List forms',
      method: 'GET',
      path: '/forms',
      risk: 'read',
      fields: [
        { key: 'search', label: 'Search', type: 'string', required: false },
        { key: 'pageSize', label: 'Page size', type: 'number', required: false, default: 10 },
      ],
      response: { itemsPath: 'items' },
    },
    {
      key: 'get_form',
      label: 'Get form',
      method: 'GET',
      path: '/forms/{formId}',
      risk: 'read',
      fields: [{ key: 'formId', label: 'Form ID', type: 'string', required: true }],
    },
    {
      key: 'list_responses',
      label: 'List responses',
      method: 'GET',
      path: '/forms/{formId}/responses',
      risk: 'read',
      fields: [
        { key: 'formId', label: 'Form ID', type: 'string', required: true },
        { key: 'pageSize', label: 'Page size', type: 'number', required: false, default: 10 },
        { key: 'since', label: 'Since (ISO 8601)', type: 'string', required: false },
        { key: 'until', label: 'Until (ISO 8601)', type: 'string', required: false },
      ],
      response: { itemsPath: 'items' },
      untrustedInput: true,
    },
  ],
  pagination: { mode: 'page', pageParam: 'page', sizeParam: 'pageSize', itemsPath: 'items' },
  rateLimit: { requests: 5, perMs: 1000, burst: 5 },
};
