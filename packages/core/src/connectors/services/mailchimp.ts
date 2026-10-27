import type { ConnectorSpec } from '@mimi/shared';

export const mailchimpConnector: ConnectorSpec = {
  key: 'mailchimp',
  label: 'Mailchimp',
  category: 'marketing',
  description: 'จัดการ audience สมาชิก และ campaign ใน Mailchimp',
  baseUrl: 'https://us1.api.mailchimp.com/3.0',
  auth: {
    kind: 'basic',
    fields: [
      { key: 'username', label: 'Username (anything)', type: 'string', required: true, placeholder: 'mimi' },
      { key: 'password', label: 'API key', type: 'secret', required: true },
    ],
  },
  operations: [
    {
      key: 'list_lists',
      label: 'List audiences',
      method: 'GET',
      path: '/lists',
      risk: 'read',
      fields: [{ key: 'count', label: 'Count', type: 'number', required: false, default: 50 }],
      response: { itemsPath: 'lists' },
    },
    {
      key: 'get_list',
      label: 'Get audience',
      method: 'GET',
      path: '/lists/{listId}',
      risk: 'read',
      fields: [{ key: 'listId', label: 'Audience ID', type: 'string', required: true }],
    },
    {
      key: 'add_member',
      label: 'Add member',
      method: 'POST',
      path: '/lists/{listId}/members',
      risk: 'write',
      body: { email_address: '{{email}}', status: '{{status}}' },
      fields: [
        { key: 'listId', label: 'Audience ID', type: 'string', required: true },
        { key: 'email', label: 'Email', type: 'string', required: true },
        { key: 'status', label: 'Status', type: 'string', required: false, default: 'subscribed' },
      ],
    },
    {
      key: 'list_campaigns',
      label: 'List campaigns',
      method: 'GET',
      path: '/campaigns',
      risk: 'read',
      fields: [{ key: 'count', label: 'Count', type: 'number', required: false, default: 20 }],
      response: { itemsPath: 'campaigns' },
    },
    {
      key: 'create_campaign',
      label: 'Create campaign',
      method: 'POST',
      path: '/campaigns',
      risk: 'write',
      body: {
        type: 'regular',
        recipients: { list_id: '{{listId}}' },
        settings: { subject_line: '{{subject}}', title: '{{title}}', from_name: '{{fromName}}', reply_to: '{{replyTo}}' },
      },
      fields: [
        { key: 'listId', label: 'Audience ID', type: 'string', required: true },
        { key: 'subject', label: 'Subject', type: 'string', required: true },
        { key: 'title', label: 'Title', type: 'string', required: true },
        { key: 'fromName', label: 'From name', type: 'string', required: true },
        { key: 'replyTo', label: 'Reply-to', type: 'string', required: true },
      ],
    },
  ],
};
