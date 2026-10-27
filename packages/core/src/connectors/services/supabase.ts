import type { ConnectorSpec } from '@mimi/shared';

export const supabaseConnector: ConnectorSpec = {
  key: 'supabase',
  label: 'Supabase',
  category: 'database',
  description: 'อ่าน เพิ่ม แก้ไข ลบ และ upsert แถวผ่าน Supabase REST API',
  baseUrl: 'https://your-project.supabase.co/rest/v1',
  auth: {
    kind: 'apiKey',
    fields: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true }],
    extra: { header: 'apikey', prefix: '' },
  },
  operations: [
    {
      key: 'select_rows',
      label: 'Select rows',
      method: 'GET',
      path: '/{table}',
      risk: 'read',
      fields: [
        { key: 'table', label: 'Table', type: 'string', required: true },
        { key: 'select', label: 'Select', type: 'string', required: false, default: '*' },
      ],
    },
    {
      key: 'insert_rows',
      label: 'Insert row',
      method: 'POST',
      path: '/{table}',
      risk: 'write',
      body: '{{row}}',
      fields: [
        { key: 'table', label: 'Table', type: 'string', required: true },
        { key: 'row', label: 'Row (JSON)', type: 'json', required: true },
      ],
    },
    {
      key: 'update_rows',
      label: 'Update row',
      method: 'PATCH',
      path: '/{table}?id=eq.{id}',
      risk: 'write',
      body: '{{row}}',
      fields: [
        { key: 'table', label: 'Table', type: 'string', required: true },
        { key: 'id', label: 'Row ID', type: 'string', required: true },
        { key: 'row', label: 'Fields (JSON)', type: 'json', required: true },
      ],
    },
    {
      key: 'delete_rows',
      label: 'Delete row',
      method: 'DELETE',
      path: '/{table}?id=eq.{id}',
      risk: 'delete',
      fields: [
        { key: 'table', label: 'Table', type: 'string', required: true },
        { key: 'id', label: 'Row ID', type: 'string', required: true },
      ],
    },
    {
      key: 'upsert_rows',
      label: 'Upsert row',
      method: 'POST',
      path: '/{table}',
      risk: 'write',
      body: '{{row}}',
      headers: { prefer: 'resolution=merge-duplicates,return=representation' },
      fields: [
        { key: 'table', label: 'Table', type: 'string', required: true },
        { key: 'row', label: 'Row (JSON)', type: 'json', required: true },
      ],
    },
  ],
};
