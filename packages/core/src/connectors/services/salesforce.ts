import type { ConnectorSpec } from '@mimi/shared';

export const salesforceConnector: ConnectorSpec = {
  key: 'salesforce',
  label: 'Salesforce',
  category: 'crm',
  description: 'ค้นหาและจัดการ Contact/Opportunity ผ่าน Salesforce REST API',
  baseUrl: 'https://your-instance.my.salesforce.com/services/data/v60.0',
  auth: {
    kind: 'bearer',
    fields: [{ key: 'token', label: 'Access token', type: 'secret', required: true }],
  },
  operations: [
    {
      key: 'search',
      label: 'SOQL search',
      method: 'GET',
      path: '/query?q={q}',
      risk: 'read',
      fields: [{ key: 'q', label: 'SOQL', type: 'string', required: true, placeholder: 'SELECT Id, Name FROM Contact LIMIT 20' }],
      response: { itemsPath: 'records' },
    },
    {
      key: 'list_contacts',
      label: 'List contacts',
      method: 'GET',
      path: '/sobjects/Contact',
      risk: 'read',
      fields: [],
      response: { itemsPath: 'records' },
    },
    {
      key: 'create_contact',
      label: 'Create contact',
      method: 'POST',
      path: '/sobjects/Contact',
      risk: 'write',
      body: { LastName: '{{lastName}}', FirstName: '{{firstName}}', Email: '{{email}}' },
      fields: [
        { key: 'lastName', label: 'Last name', type: 'string', required: true },
        { key: 'firstName', label: 'First name', type: 'string', required: false },
        { key: 'email', label: 'Email', type: 'string', required: false },
      ],
    },
    {
      key: 'list_opportunities',
      label: 'List opportunities',
      method: 'GET',
      path: '/sobjects/Opportunity',
      risk: 'read',
      fields: [],
      response: { itemsPath: 'records' },
    },
    {
      key: 'update_opportunity',
      label: 'Update opportunity',
      method: 'PATCH',
      path: '/sobjects/Opportunity/{opportunityId}',
      risk: 'write',
      body: { StageName: '{{stage}}', Amount: '{{amount}}' },
      fields: [
        { key: 'opportunityId', label: 'Opportunity ID', type: 'string', required: true },
        { key: 'stage', label: 'Stage', type: 'string', required: true },
        { key: 'amount', label: 'Amount', type: 'number', required: false },
      ],
    },
  ],
};
