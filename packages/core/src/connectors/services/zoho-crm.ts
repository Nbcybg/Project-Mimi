import type { ConnectorSpec } from '@mimi/shared';

export const zohoCrmConnector: ConnectorSpec = {
  key: 'zoho_crm',
  label: 'Zoho CRM',
  category: 'crm',
  description: 'List and create contacts and deals in Zoho CRM',
  baseUrl: 'https://www.zohoapis.com/crm/v5',
  auth: {
    kind: 'oauth2',
    fields: [
      { key: 'clientId', label: 'Client ID', type: 'string', required: true },
      { key: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
      { key: 'refreshToken', label: 'Refresh token', type: 'secret', required: true },
      { key: 'accessToken', label: 'Access token', type: 'secret' },
      { key: 'expiresAt', label: 'Expires at', type: 'string' },
    ],
    authorizeUrl: 'https://accounts.zoho.com/oauth/v2/auth',
    tokenUrl: 'https://accounts.zoho.com/oauth/v2/token',
    scopes: ['ZohoCRM.modules.ALL'],
    extra: { prefix: 'Zoho-oauthtoken ' },
  },
  operations: [
    {
      key: 'list_contacts',
      label: 'List contacts',
      method: 'GET',
      path: '/Contacts',
      risk: 'read',
      fields: [
        { key: 'page', label: 'Page', type: 'number', required: false, default: 1 },
        { key: 'perPage', label: 'Per page', type: 'number', required: false, default: 20 },
      ],
      response: { itemsPath: 'data' },
    },
    {
      key: 'create_contact',
      label: 'Create contact',
      method: 'POST',
      path: '/Contacts',
      risk: 'write',
      body: { data: [{ Last_Name: '{{lastName}}', First_Name: '{{firstName}}', Email: '{{email}}', Phone: '{{phone}}' }] },
      fields: [
        { key: 'lastName', label: 'Last name', type: 'string', required: true },
        { key: 'firstName', label: 'First name', type: 'string', required: false },
        { key: 'email', label: 'Email', type: 'string', required: false },
        { key: 'phone', label: 'Phone', type: 'string', required: false },
      ],
    },
    {
      key: 'list_deals',
      label: 'List deals',
      method: 'GET',
      path: '/Deals',
      risk: 'read',
      fields: [
        { key: 'page', label: 'Page', type: 'number', required: false, default: 1 },
        { key: 'perPage', label: 'Per page', type: 'number', required: false, default: 20 },
      ],
      response: { itemsPath: 'data' },
    },
    {
      key: 'create_deal',
      label: 'Create deal',
      method: 'POST',
      path: '/Deals',
      risk: 'write',
      body: { data: [{ Deal_Name: '{{dealName}}', Amount: '{{amount}}', Stage: '{{stage}}', Closing_Date: '{{closingDate}}' }] },
      fields: [
        { key: 'dealName', label: 'Deal name', type: 'string', required: true },
        { key: 'amount', label: 'Amount', type: 'number', required: false },
        { key: 'stage', label: 'Stage', type: 'string', required: false },
        { key: 'closingDate', label: 'Closing date (YYYY-MM-DD)', type: 'string', required: false },
      ],
    },
  ],
  pagination: { mode: 'page', pageParam: 'page', sizeParam: 'per_page', itemsPath: 'data' },
  rateLimit: { requests: 10, perMs: 1000, burst: 10 },
};
