import type { ConnectorSpec } from '@mimi/shared';

export const sendgridConnector: ConnectorSpec = {
  key: 'sendgrid',
  label: 'SendGrid',
  category: 'communication',
  description: 'ส่งอีเมลและอ่าน template/sender/สถิติจาก SendGrid',
  baseUrl: 'https://api.sendgrid.com/v3',
  auth: {
    kind: 'bearer',
    fields: [{ key: 'token', label: 'API key', type: 'secret', required: true, placeholder: 'SG....' }],
  },
  operations: [
    {
      key: 'send_email',
      label: 'Send email',
      method: 'POST',
      path: '/mail/send',
      risk: 'write',
      body: {
        personalizations: [{ to: [{ email: '{{to}}' }] }],
        from: { email: '{{from}}' },
        subject: '{{subject}}',
        content: [{ type: 'text/plain', value: '{{text}}' }],
      },
      fields: [
        { key: 'to', label: 'To', type: 'string', required: true },
        { key: 'from', label: 'From', type: 'string', required: true },
        { key: 'subject', label: 'Subject', type: 'string', required: true },
        { key: 'text', label: 'Text', type: 'string', required: true },
      ],
    },
    {
      key: 'list_templates',
      label: 'List templates',
      method: 'GET',
      path: '/templates',
      risk: 'read',
      fields: [{ key: 'page_size', label: 'Page size', type: 'number', required: false, default: 50 }],
      response: { itemsPath: 'result' },
    },
    {
      key: 'get_template',
      label: 'Get template',
      method: 'GET',
      path: '/templates/{templateId}',
      risk: 'read',
      fields: [{ key: 'templateId', label: 'Template ID', type: 'string', required: true }],
    },
    {
      key: 'list_senders',
      label: 'List senders',
      method: 'GET',
      path: '/senders',
      risk: 'read',
      fields: [],
    },
    {
      key: 'get_stats',
      label: 'Get stats',
      method: 'GET',
      path: '/stats?start_date={startDate}',
      risk: 'read',
      fields: [{ key: 'startDate', label: 'Start date', type: 'string', required: true, placeholder: '2026-01-01' }],
    },
  ],
};
