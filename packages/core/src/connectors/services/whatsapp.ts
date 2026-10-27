import type { ConnectorSpec } from '@mimi/shared';

export const whatsappConnector: ConnectorSpec = {
  key: 'whatsapp',
  label: 'WhatsApp',
  category: 'communication',
  description: 'ส่งข้อความและ template ผ่าน WhatsApp Business Cloud API',
  baseUrl: 'https://graph.facebook.com/v21.0',
  auth: {
    kind: 'bearer',
    fields: [{ key: 'token', label: 'Access token', type: 'secret', required: true }],
  },
  operations: [
    {
      key: 'send_text',
      label: 'Send text',
      method: 'POST',
      path: '/{phoneNumberId}/messages',
      risk: 'write',
      body: { messaging_product: 'whatsapp', to: '{{to}}', type: 'text', text: { body: '{{text}}' } },
      fields: [
        { key: 'phoneNumberId', label: 'Phone number ID', type: 'string', required: true },
        { key: 'to', label: 'To', type: 'string', required: true },
        { key: 'text', label: 'Message', type: 'string', required: true },
      ],
    },
    {
      key: 'send_template',
      label: 'Send template',
      method: 'POST',
      path: '/{phoneNumberId}/messages',
      risk: 'write',
      body: {
        messaging_product: 'whatsapp',
        to: '{{to}}',
        type: 'template',
        template: { name: '{{template}}', language: { code: '{{language}}' } },
      },
      fields: [
        { key: 'phoneNumberId', label: 'Phone number ID', type: 'string', required: true },
        { key: 'to', label: 'To', type: 'string', required: true },
        { key: 'template', label: 'Template name', type: 'string', required: true },
        { key: 'language', label: 'Language code', type: 'string', required: false, default: 'en_US' },
      ],
    },
    {
      key: 'list_templates',
      label: 'List templates',
      method: 'GET',
      path: '/{businessAccountId}/message_templates',
      risk: 'read',
      fields: [{ key: 'businessAccountId', label: 'Business account ID', type: 'string', required: true }],
      response: { itemsPath: 'data' },
    },
    {
      key: 'list_phone_numbers',
      label: 'List phone numbers',
      method: 'GET',
      path: '/{businessAccountId}/phone_numbers',
      risk: 'read',
      fields: [{ key: 'businessAccountId', label: 'Business account ID', type: 'string', required: true }],
      response: { itemsPath: 'data' },
    },
    {
      key: 'get_media',
      label: 'Get media URL',
      method: 'GET',
      path: '/{mediaId}',
      risk: 'read',
      fields: [{ key: 'mediaId', label: 'Media ID', type: 'string', required: true }],
    },
  ],
};
