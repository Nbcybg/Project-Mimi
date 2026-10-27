import type { ConnectorSpec } from '@mimi/shared';

export const googleDriveConnector: ConnectorSpec = {
  key: 'google_drive',
  label: 'Google Drive',
  category: 'storage',
  description: 'ค้นหา อ่าน สร้างโฟลเดอร์ ย้าย และลบไฟล์ใน Google Drive',
  baseUrl: 'https://www.googleapis.com',
  auth: {
    kind: 'oauth2',
    fields: [],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/drive'],
    extra: { provider: 'google' },
  },
  operations: [
    {
      key: 'list_files',
      label: 'List files',
      method: 'GET',
      path: '/drive/v3/files',
      risk: 'read',
      fields: [
        { key: 'q', label: 'Query', type: 'string', required: false, placeholder: "name contains 'report'" },
        { key: 'pageSize', label: 'Page size', type: 'number', required: false, default: 50 },
      ],
      response: { itemsPath: 'files' },
    },
    {
      key: 'get_file',
      label: 'Get file',
      method: 'GET',
      path: '/drive/v3/files/{fileId}',
      risk: 'read',
      fields: [{ key: 'fileId', label: 'File ID', type: 'string', required: true }],
    },
    {
      key: 'create_folder',
      label: 'Create folder',
      method: 'POST',
      path: '/drive/v3/files',
      risk: 'write',
      body: { name: '{{name}}', mimeType: 'application/vnd.google-apps.folder' },
      fields: [{ key: 'name', label: 'Folder name', type: 'string', required: true }],
    },
    {
      key: 'move_file',
      label: 'Move file',
      method: 'PATCH',
      path: '/drive/v3/files/{fileId}?addParents={addParent}&removeParents={removeParent}',
      risk: 'write',
      fields: [
        { key: 'fileId', label: 'File ID', type: 'string', required: true },
        { key: 'addParent', label: 'New folder ID', type: 'string', required: true },
        { key: 'removeParent', label: 'Old folder ID', type: 'string', required: true },
      ],
    },
    {
      key: 'delete_file',
      label: 'Delete file',
      method: 'DELETE',
      path: '/drive/v3/files/{fileId}',
      risk: 'delete',
      fields: [{ key: 'fileId', label: 'File ID', type: 'string', required: true }],
    },
  ],
};
