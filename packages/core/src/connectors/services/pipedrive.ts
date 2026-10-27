import type { ConnectorSpec } from '@mimi/shared';

export const pipedriveConnector: ConnectorSpec = {
  key: 'pipedrive',
  label: 'Pipedrive',
  category: 'crm',
  description: 'อ่าน person/deal และสร้างหรืออัปเดตดีลใน Pipedrive',
  baseUrl: 'https://api.pipedrive.com/v1',
  auth: {
    kind: 'apiKey',
    fields: [{ key: 'token', label: 'API token', type: 'secret', required: true }],
    extra: { location: 'query', queryNames: { token: 'api_token' } },
  },
  operations: [
    {
      key: 'list_persons',
      label: 'List persons',
      method: 'GET',
      path: '/persons',
      risk: 'read',
      fields: [{ key: 'limit', label: 'Limit', type: 'number', required: false, default: 50 }],
      response: { itemsPath: 'data' },
    },
    {
      key: 'create_person',
      label: 'Create person',
      method: 'POST',
      path: '/persons',
      risk: 'write',
      body: { name: '{{name}}', email: '{{email}}' },
      fields: [
        { key: 'name', label: 'Name', type: 'string', required: true },
        { key: 'email', label: 'Email', type: 'string', required: false },
      ],
    },
    {
      key: 'list_deals',
      label: 'List deals',
      method: 'GET',
      path: '/deals',
      risk: 'read',
      fields: [{ key: 'limit', label: 'Limit', type: 'number', required: false, default: 50 }],
      response: { itemsPath: 'data' },
    },
    {
      key: 'create_deal',
      label: 'Create deal',
      method: 'POST',
      path: '/deals',
      risk: 'write',
      body: { title: '{{title}}', value: '{{value}}', person_id: '{{personId}}' },
      fields: [
        { key: 'title', label: 'Title', type: 'string', required: true },
        { key: 'value', label: 'Value', type: 'number', required: false },
        { key: 'personId', label: 'Person ID', type: 'number', required: false },
      ],
    },
    {
      key: 'update_deal',
      label: 'Update deal',
      method: 'PUT',
      path: '/deals/{dealId}',
      risk: 'write',
      body: { status: '{{status}}', value: '{{value}}' },
      fields: [
        { key: 'dealId', label: 'Deal ID', type: 'number', required: true },
        { key: 'status', label: 'Status', type: 'string', required: true, placeholder: 'won' },
        { key: 'value', label: 'Value', type: 'number', required: false },
      ],
    },
  ],
};
