import type { ConnectorSpec } from '@mimi/shared';

const oauth = {
  kind: 'oauth2' as const,
  fields: [],
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: ['https://www.googleapis.com/auth/tasks'],
  extra: { provider: 'google' },
};

const tasklist = {
  key: 'tasklist',
  label: 'Task list',
  type: 'string' as const,
  required: true,
  placeholder: '@default',
  description: 'id ของ task list หรือ @default สำหรับรายการเริ่มต้น',
};

export const googleTasksConnector: ConnectorSpec = {
  key: 'google_tasks',
  label: 'Google Tasks',
  category: 'productivity',
  description: 'อ่านและสร้างงานใน Google Tasks',
  baseUrl: 'https://tasks.googleapis.com/tasks/v1',
  auth: oauth,
  operations: [
    {
      key: 'list_tasklists',
      label: 'ดูรายการ task list',
      description: 'อ่าน task list ทั้งหมดของบัญชี',
      method: 'GET',
      path: '/users/@me/lists',
      risk: 'read',
      fields: [{ key: 'maxResults', label: 'จำนวน', type: 'number', required: false, default: 100 }],
      response: { itemsPath: 'items' },
    },
    {
      key: 'list_tasks',
      label: 'ดูรายการงาน',
      description: 'อ่านงานใน task list (ชื่อและโน้ตเป็นข้อความจากบุคคลที่สาม)',
      method: 'GET',
      path: '/lists/{tasklist}/tasks',
      risk: 'read',
      untrustedInput: true,
      fields: [
        tasklist,
        { key: 'maxResults', label: 'จำนวน', type: 'number', required: false, default: 100 },
        { key: 'showCompleted', label: 'แสดงงานที่เสร็จแล้ว', type: 'boolean', required: false, default: true },
      ],
      response: { itemsPath: 'items' },
    },
    {
      key: 'create_task',
      label: 'สร้างงาน',
      description: 'สร้างงานใหม่ใน task list',
      method: 'POST',
      path: '/lists/{tasklist}/tasks',
      risk: 'write',
      body: { title: '{{title}}', notes: '{{notes}}', due: '{{due}}' },
      fields: [
        tasklist,
        { key: 'title', label: 'ชื่องาน', type: 'string', required: true },
        { key: 'notes', label: 'รายละเอียด', type: 'string', required: false },
        { key: 'due', label: 'กำหนดส่ง (RFC 3339)', type: 'string', required: false, placeholder: '2026-10-31T00:00:00Z' },
      ],
    },
    {
      key: 'complete_task',
      label: 'ทำเครื่องหมายเสร็จ',
      description: 'เปลี่ยนสถานะงานเป็น completed',
      method: 'PATCH',
      path: '/lists/{tasklist}/tasks/{task}',
      risk: 'write',
      body: { status: 'completed' },
      fields: [tasklist, { key: 'task', label: 'Task ID', type: 'string', required: true }],
    },
  ],
  pagination: { mode: 'cursor', cursorParam: 'pageToken', sizeParam: 'maxResults', nextPath: 'nextPageToken', itemsPath: 'items' },
};
