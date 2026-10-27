import type { ConnectorSpec } from '@mimi/shared';

export const googleSearchConsoleConnector: ConnectorSpec = {
  key: 'google_search_console',
  label: 'Google Search Console',
  category: 'analytics',
  description: 'List verified sites and query the Search Analytics API for clicks, impressions, CTR and position',
  baseUrl: 'https://www.googleapis.com',
  auth: {
    kind: 'oauth2',
    fields: [],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    extra: { provider: 'google' },
  },
  operations: [
    {
      key: 'list_sites',
      label: 'List sites',
      method: 'GET',
      path: '/webmasters/v3/sites',
      risk: 'read',
      fields: [],
      response: { itemsPath: 'siteEntry' },
    },
    {
      key: 'query_search_analytics',
      label: 'Query search analytics',
      method: 'POST',
      path: '/webmasters/v3/sites/{siteUrl}/searchAnalytics/query',
      risk: 'read',
      body: {
        startDate: '{{startDate}}',
        endDate: '{{endDate}}',
        dimensions: ['{{dimension}}'],
        rowLimit: '{{rowLimit}}',
      },
      fields: [
        { key: 'siteUrl', label: 'Site URL', type: 'string', required: true, placeholder: 'https://example.com/' },
        { key: 'startDate', label: 'Start date', type: 'string', required: true, placeholder: '2024-01-01' },
        { key: 'endDate', label: 'End date', type: 'string', required: true, placeholder: '2024-01-31' },
        { key: 'dimension', label: 'Dimension', type: 'string', required: true, default: 'query' },
        { key: 'rowLimit', label: 'Row limit', type: 'number', required: true, default: 25 },
      ],
      response: { itemsPath: 'rows' },
    },
  ],
  rateLimit: { requests: 10, perMs: 1000, burst: 10 },
};
