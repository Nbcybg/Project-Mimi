import type { ConnectorSpec } from '@mimi/shared';

export const googleSlidesConnector: ConnectorSpec = {
  key: 'google_slides',
  label: 'Google Slides',
  category: 'productivity',
  description: 'Create presentations, read a presentation and insert text into a shape through the Google Slides API',
  baseUrl: 'https://slides.googleapis.com',
  auth: {
    kind: 'oauth2',
    fields: [],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/presentations', 'https://www.googleapis.com/auth/drive.file'],
    extra: { provider: 'google' },
  },
  operations: [
    {
      key: 'create_presentation',
      label: 'Create presentation',
      method: 'POST',
      path: '/v1/presentations',
      risk: 'write',
      body: { title: '{{title}}' },
      fields: [{ key: 'title', label: 'Title', type: 'string', required: true }],
    },
    {
      key: 'get_presentation',
      label: 'Get presentation',
      method: 'GET',
      path: '/v1/presentations/{presentationId}',
      risk: 'read',
      fields: [{ key: 'presentationId', label: 'Presentation ID', type: 'string', required: true }],
      untrustedInput: true,
    },
    {
      key: 'add_text',
      label: 'Add text',
      description: 'Batch update that inserts text into the shape with the given object ID',
      method: 'POST',
      path: '/v1/presentations/{presentationId}:batchUpdate',
      risk: 'write',
      body: { requests: [{ insertText: { objectId: '{{objectId}}', text: '{{text}}' } }] },
      fields: [
        { key: 'presentationId', label: 'Presentation ID', type: 'string', required: true },
        { key: 'objectId', label: 'Shape object ID', type: 'string', required: true },
        { key: 'text', label: 'Text', type: 'string', required: true },
      ],
    },
  ],
  rateLimit: { requests: 10, perMs: 1000, burst: 10 },
};
