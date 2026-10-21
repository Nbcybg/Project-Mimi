import type { ConnectorField, ConnectorSpec } from '@mimi/shared';

const databaseId: ConnectorField = {
  key: 'databaseId',
  label: 'Database ID',
  type: 'string',
  required: true,
  placeholder: 'a1b2c3d4e5f6…',
  description: 'คัดลอก id จาก URL ของ database ใน Notion',
};

export const notionConnector: ConnectorSpec = {
  key: 'notion',
  label: 'Notion',
  category: 'productivity',
  description: 'ค้นหา อ่าน และสร้างหน้าใน Notion ผ่าน Integration API',
  baseUrl: 'https://api.notion.com/v1',
  auth: {
    kind: 'apiKey',
    fields: [
      {
        key: 'token',
        label: 'Integration token',
        type: 'secret',
        required: true,
        placeholder: 'ntn_…',
        description: 'สร้างที่ Notion → Settings → Connections → Develop or manage integrations',
      },
    ],
    extra: { headers: { 'Notion-Version': '2022-06-28' } },
  },
  operations: [
    {
      key: 'search',
      label: 'ค้นหา',
      description: 'ค้นหาหน้าและ database ที่ integration เข้าถึงได้',
      method: 'POST',
      path: '/search',
      risk: 'read',
      untrustedInput: true,
      body: { query: '{{query}}', page_size: '{{pageSize}}' },
      fields: [
        { key: 'query', label: 'คำค้นหา', type: 'string', required: false, placeholder: 'เว้นว่าง = ทั้งหมด' },
        { key: 'pageSize', label: 'จำนวน', type: 'number', required: false, default: 100 },
      ],
      response: { itemsPath: 'results' },
    },
    {
      key: 'get_page',
      label: 'อ่านหน้า',
      description: 'อ่าน metadata ของหน้า Notion (เนื้อหาเป็นข้อความจากบุคคลที่สาม)',
      method: 'GET',
      path: '/pages/{pageId}',
      risk: 'read',
      untrustedInput: true,
      fields: [{ key: 'pageId', label: 'Page ID', type: 'string', required: true }],
    },
    {
      key: 'create_page',
      label: 'สร้างหน้า',
      description: 'สร้างหน้าใหม่ใน database พร้อม properties ที่กำหนด',
      method: 'POST',
      path: '/pages',
      risk: 'write',
      body: { parent: { database_id: '{{databaseId}}' }, properties: '{{properties}}' },
      fields: [
        databaseId,
        {
          key: 'properties',
          label: 'Properties (JSON)',
          type: 'json',
          required: true,
          description: 'รูปแบบตาม property ของ database เช่น {"Name":{"title":[{"text":{"content":"Hello"}}]}}',
        },
      ],
    },
    {
      key: 'append_blocks',
      label: 'เพิ่มเนื้อหา',
      description: 'ต่อ block ใหม่ท้ายหน้า Notion',
      method: 'POST',
      path: '/blocks/{blockId}/children',
      risk: 'write',
      body: { children: '{{children}}' },
      fields: [
        { key: 'blockId', label: 'Page/Block ID', type: 'string', required: true },
        { key: 'children', label: 'Blocks (JSON)', type: 'json', required: true },
      ],
    },
    {
      key: 'query_database',
      label: 'Query database',
      description: 'อ่านรายการหน้าจาก database (ข้อความเป็นข้อความจากบุคคลที่สาม)',
      method: 'POST',
      path: '/databases/{databaseId}/query',
      risk: 'read',
      untrustedInput: true,
      body: { page_size: '{{pageSize}}' },
      fields: [
        databaseId,
        { key: 'pageSize', label: 'จำนวน', type: 'number', required: false, default: 100 },
      ],
      response: { itemsPath: 'results' },
    },
  ],
  pagination: { mode: 'cursor', cursorParam: 'start_cursor', sizeParam: 'page_size', nextPath: 'next_cursor', itemsPath: 'results' },
  rateLimit: { requests: 3, perMs: 1000, burst: 3 },
};
