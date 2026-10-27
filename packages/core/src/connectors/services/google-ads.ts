import type { ConnectorSpec } from '@mimi/shared';

export const googleAdsConnector: ConnectorSpec = {
  key: 'google_ads',
  label: 'Google Ads',
  category: 'ads',
  description: 'Search campaigns and pause or enable a campaign through the Google Ads API',
  baseUrl: 'https://googleads.googleapis.com/v17',
  auth: {
    kind: 'oauth2',
    fields: [],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/adwords'],
    extra: { provider: 'google' },
  },
  operations: [
    {
      key: 'list_campaigns',
      label: 'List campaigns',
      method: 'POST',
      path: '/customers/{customerId}/googleAds:search',
      risk: 'read',
      headers: { 'developer-token': '{{developerToken}}' },
      body: { query: 'SELECT campaign.id, campaign.name, campaign.status FROM campaign ORDER BY campaign.id' },
      fields: [
        { key: 'customerId', label: 'Customer ID', type: 'string', required: true, placeholder: '1234567890' },
        { key: 'developerToken', label: 'Developer token', type: 'string', required: true },
        { key: 'loginCustomerId', label: 'Login customer ID (manager account)', type: 'string', required: false },
      ],
    },
    {
      key: 'get_campaign',
      label: 'Get campaign',
      method: 'POST',
      path: '/customers/{customerId}/googleAds:search',
      risk: 'read',
      headers: { 'developer-token': '{{developerToken}}' },
      body: { query: 'SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = {{campaignId}}' },
      fields: [
        { key: 'customerId', label: 'Customer ID', type: 'string', required: true, placeholder: '1234567890' },
        { key: 'campaignId', label: 'Campaign ID', type: 'string', required: true },
        { key: 'developerToken', label: 'Developer token', type: 'string', required: true },
        { key: 'loginCustomerId', label: 'Login customer ID (manager account)', type: 'string', required: false },
      ],
    },
    {
      key: 'update_campaign_status',
      label: 'Update campaign status',
      method: 'POST',
      path: '/customers/{customerId}/campaigns:mutate',
      risk: 'write',
      headers: { 'developer-token': '{{developerToken}}' },
      body: {
        operations: [
          {
            update: { resourceName: 'customers/{{customerId}}/campaigns/{{campaignId}}', status: '{{status}}' },
            updateMask: 'status',
          },
        ],
      },
      fields: [
        { key: 'customerId', label: 'Customer ID', type: 'string', required: true, placeholder: '1234567890' },
        { key: 'campaignId', label: 'Campaign ID', type: 'string', required: true },
        {
          key: 'status',
          label: 'Status',
          type: 'select',
          required: true,
          options: [
            { value: 'ENABLED', label: 'Enabled' },
            { value: 'PAUSED', label: 'Paused' },
          ],
        },
        { key: 'developerToken', label: 'Developer token', type: 'string', required: true },
        { key: 'loginCustomerId', label: 'Login customer ID (manager account)', type: 'string', required: false },
      ],
    },
  ],
  rateLimit: { requests: 5, perMs: 1000, burst: 5 },
};
