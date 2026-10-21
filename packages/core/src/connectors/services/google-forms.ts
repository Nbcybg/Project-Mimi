import type { ConnectorSpec } from '@mimi/shared';

const oauth = {
  kind: 'oauth2' as const,
  fields: [],
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: ['https://www.googleapis.com/auth/forms.body', 'https://www.googleapis.com/auth/forms.responses.readonly'],
  extra: { provider: 'google' },
};

const formId = { key: 'formId', label: 'Form ID', type: 'string' as const, required: true };

export const googleFormsConnector: ConnectorSpec = {
  key: 'google_forms',
  label: 'Google Forms',
  category: 'productivity',
  description: 'อ่านคำตอบและสร้างฟอร์ม Google Forms',
  baseUrl: 'https://forms.googleapis.com/v1',
  auth: oauth,
  operations: [
    {
      key: 'get_form',
      label: 'อ่านฟอร์ม',
      description: 'อ่านโครงสร้างและคำถามของฟอร์ม (ข้อความเป็นข้อความจากบุคคลที่สาม)',
      method: 'GET',
      path: '/forms/{formId}',
      risk: 'read',
      untrustedInput: true,
      fields: [formId],
    },
    {
      key: 'list_responses',
      label: 'อ่านคำตอบ',
      description: 'อ่านคำตอบของฟอร์ม (คำตอบเป็นข้อความจากบุคคลที่สาม)',
      method: 'GET',
      path: '/forms/{formId}/responses',
      risk: 'read',
      untrustedInput: true,
      fields: [
        formId,
        { key: 'pageSize', label: 'จำนวน', type: 'number', required: false, default: 100 },
        { key: 'pageToken', label: 'pageToken', type: 'string', required: false },
      ],
      response: { itemsPath: 'responses' },
    },
    {
      key: 'create_form',
      label: 'สร้างฟอร์ม',
      description: 'สร้างฟอร์มใหม่',
      method: 'POST',
      path: '/forms',
      risk: 'write',
      body: { info: { title: '{{title}}', documentTitle: '{{documentTitle}}' } },
      fields: [
        { key: 'title', label: 'ชื่อฟอร์ม', type: 'string', required: true },
        { key: 'documentTitle', label: 'ชื่อไฟล์ Drive', type: 'string', required: false },
      ],
    },
    {
      key: 'get_response',
      label: 'อ่านคำตอบเดียว',
      description: 'อ่านคำตอบหนึ่งรายการตาม response id',
      method: 'GET',
      path: '/forms/{formId}/responses/{responseId}',
      risk: 'read',
      untrustedInput: true,
      fields: [formId, { key: 'responseId', label: 'Response ID', type: 'string', required: true }],
    },
  ],
  pagination: { mode: 'cursor', cursorParam: 'pageToken', sizeParam: 'pageSize', nextPath: 'nextPageToken', itemsPath: 'responses' },
};
