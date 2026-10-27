import type { ConnectorSpec } from '@mimi/shared';

export const googleAnalyticsConnector: ConnectorSpec = {
  key: 'google_analytics',
  label: 'Google Analytics',
  category: 'analytics',
  description: 'List Analytics properties and run a Data API report',
  baseUrl: 'https://analyticsdata.googleapis.com',
  auth: {
    kind: 'oauth2',
    fields: [],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    extra: { provider: 'google' },
  },
  operations: [
    {
      key: 'list_properties',
      label: 'List properties',
      method: 'GET',
      path: 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries',
      risk: 'read',
      fields: [],
      response: { itemsPath: 'accountSummaries' },
    },
    {
      key: 'run_report',
      label: 'Run report',
      method: 'POST',
      path: '/v1beta/properties/{propertyId}:runReport',
      risk: 'read',
      body: {
        dateRanges: [{ startDate: '{{startDate}}', endDate: '{{endDate}}' }],
        dimensions: [{ name: '{{dimension}}' }],
        metrics: [{ name: '{{metric}}' }],
      },
      fields: [
        { key: 'propertyId', label: 'Property ID', type: 'string', required: true, placeholder: 'properties/123456' },
        { key: 'startDate', label: 'Start date', type: 'string', required: true, default: '7daysAgo' },
        { key: 'endDate', label: 'End date', type: 'string', required: true, default: 'today' },
        { key: 'dimension', label: 'Dimension', type: 'string', required: true, default: 'date' },
        { key: 'metric', label: 'Metric', type: 'string', required: true, default: 'sessions' },
      ],
    },
  ],
  rateLimit: { requests: 10, perMs: 1000, burst: 10 },
};
