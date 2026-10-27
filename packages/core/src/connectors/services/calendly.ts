import type { ConnectorSpec } from '@mimi/shared';

export const calendlyConnector: ConnectorSpec = {
  key: 'calendly',
  label: 'Calendly',
  category: 'scheduling',
  description: 'List event types and scheduled events, and create invitees for a scheduled event',
  baseUrl: 'https://api.calendly.com',
  auth: {
    kind: 'oauth2',
    fields: [
      { key: 'clientId', label: 'Client ID', type: 'string', required: true },
      { key: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
      { key: 'refreshToken', label: 'Refresh token', type: 'secret', required: true },
      { key: 'accessToken', label: 'Access token', type: 'secret' },
      { key: 'expiresAt', label: 'Expires at', type: 'string' },
    ],
    authorizeUrl: 'https://auth.calendly.com/oauth/authorize',
    tokenUrl: 'https://auth.calendly.com/oauth/token',
    scopes: ['default'],
  },
  operations: [
    {
      key: 'list_event_types',
      label: 'List event types',
      method: 'GET',
      path: '/event_types',
      risk: 'read',
      fields: [
        { key: 'user', label: 'User URI', type: 'string', required: true, placeholder: 'https://api.calendly.com/users/AAAA' },
        { key: 'pageSize', label: 'Page size', type: 'number', required: false, default: 20 },
      ],
      response: { itemsPath: 'collection' },
    },
    {
      key: 'list_scheduled_events',
      label: 'List scheduled events',
      method: 'GET',
      path: '/scheduled_events',
      risk: 'read',
      fields: [
        { key: 'user', label: 'User URI', type: 'string', required: true, placeholder: 'https://api.calendly.com/users/AAAA' },
        {
          key: 'status',
          label: 'Status',
          type: 'select',
          required: false,
          options: [
            { value: 'active', label: 'Active' },
            { value: 'canceled', label: 'Canceled' },
          ],
        },
        { key: 'minStartTime', label: 'Min start time (ISO 8601)', type: 'string', required: false },
        { key: 'maxStartTime', label: 'Max start time (ISO 8601)', type: 'string', required: false },
      ],
      response: { itemsPath: 'collection' },
    },
    {
      key: 'create_invitee',
      label: 'Create invitee',
      method: 'POST',
      path: '/scheduled_events/{eventUuid}/invitees',
      risk: 'write',
      body: { email: '{{email}}', name: '{{name}}', timezone: '{{timezone}}' },
      fields: [
        { key: 'eventUuid', label: 'Scheduled event UUID', type: 'string', required: true },
        { key: 'email', label: 'Email', type: 'string', required: true },
        { key: 'name', label: 'Name', type: 'string', required: true },
        { key: 'timezone', label: 'Time zone', type: 'string', required: false },
      ],
    },
  ],
  rateLimit: { requests: 5, perMs: 1000, burst: 5 },
};
