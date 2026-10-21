import type { ConnectorSpec } from '@mimi/shared';

const oauth = {
  kind: 'oauth2' as const,
  fields: [],
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: ['https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/drive.file'],
  extra: { provider: 'google' },
};

export const googleDocsConnector: ConnectorSpec = {
  key: 'google_docs',
  label: 'Google Docs',
  category: 'productivity',
  description: 'สร้าง อ่าน และแก้ไข Google Docs ด้วยบัญชี Google ที่เชื่อมต่อไว้',
  baseUrl: 'https://docs.googleapis.com/v1',
  auth: oauth,
  operations: [
    {
      key: 'create_document',
      label: 'สร้างเอกสาร',
      description: 'สร้าง Google Doc ใหม่',
      method: 'POST',
      path: '/documents',
      risk: 'write',
      body: { title: '{{title}}' },
      fields: [{ key: 'title', label: 'ชื่อเอกสาร', type: 'string', required: true }],
    },
    {
      key: 'get_document',
      label: 'อ่านเอกสาร',
      description: 'อ่านเนื้อหาเอกสาร (ข้อความเป็นข้อความจากบุคคลที่สาม)',
      method: 'GET',
      path: '/documents/{documentId}',
      risk: 'read',
      untrustedInput: true,
      fields: [{ key: 'documentId', label: 'Document ID', type: 'string', required: true }],
    },
    {
      key: 'append_text',
      label: 'ต่อท้ายข้อความ',
      description: 'เพิ่มข้อความต่อท้ายเอกสาร',
      method: 'POST',
      path: '/documents/{documentId}:batchUpdate',
      risk: 'write',
      body: {
        requests: [{ insertText: { endOfSegmentLocation: {}, text: '{{text}}' } }],
      },
      fields: [
        { key: 'documentId', label: 'Document ID', type: 'string', required: true },
        { key: 'text', label: 'ข้อความ', type: 'string', required: true },
      ],
    },
    {
      key: 'replace_text',
      label: 'แทนที่ข้อความ',
      description: 'แทนที่ข้อความทั้งเอกสาร',
      method: 'POST',
      path: '/documents/{documentId}:batchUpdate',
      risk: 'write',
      body: {
        requests: [
          {
            replaceAllText: {
              containsText: { text: '{{find}}', matchCase: '{{matchCase}}' },
              replaceText: '{{replace}}',
            },
          },
        ],
      },
      fields: [
        { key: 'documentId', label: 'Document ID', type: 'string', required: true },
        { key: 'find', label: 'ข้อความที่หา', type: 'string', required: true },
        { key: 'replace', label: 'ข้อความใหม่', type: 'string', required: true },
        { key: 'matchCase', label: 'ตรงตัวพิมพ์', type: 'boolean', required: false, default: false },
      ],
    },
  ],
};
