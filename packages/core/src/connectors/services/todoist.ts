import type { ConnectorSpec } from '@mimi/shared';

export const todoistConnector: ConnectorSpec = {
  key: 'todoist',
  label: 'Todoist',
  category: 'productivity',
  description: 'อ่าน project/task และสร้างหรือปิดงานใน Todoist',
  baseUrl: 'https://api.todoist.com/rest/v2',
  auth: {
    kind: 'bearer',
    fields: [{ key: 'token', label: 'API token', type: 'secret', required: true }],
  },
  operations: [
    {
      key: 'list_projects',
      label: 'List projects',
      method: 'GET',
      path: '/projects',
      risk: 'read',
      fields: [],
    },
    {
      key: 'list_tasks',
      label: 'List tasks',
      method: 'GET',
      path: '/tasks',
      risk: 'read',
      fields: [{ key: 'project_id', label: 'Project ID', type: 'string', required: false }],
    },
    {
      key: 'get_task',
      label: 'Get task',
      method: 'GET',
      path: '/tasks/{taskId}',
      risk: 'read',
      fields: [{ key: 'taskId', label: 'Task ID', type: 'string', required: true }],
    },
    {
      key: 'create_task',
      label: 'Create task',
      method: 'POST',
      path: '/tasks',
      risk: 'write',
      body: { content: '{{content}}', project_id: '{{projectId}}', due_string: '{{due}}' },
      fields: [
        { key: 'content', label: 'Task', type: 'string', required: true },
        { key: 'projectId', label: 'Project ID', type: 'string', required: false },
        { key: 'due', label: 'Due date', type: 'string', required: false, placeholder: 'tomorrow 9am' },
      ],
    },
    {
      key: 'complete_task',
      label: 'Complete task',
      method: 'POST',
      path: '/tasks/{taskId}/close',
      risk: 'write',
      fields: [{ key: 'taskId', label: 'Task ID', type: 'string', required: true }],
    },
  ],
  triggers: [
    {
      key: 'new_tasks',
      label: 'New tasks',
      description: 'ตรวจงานใหม่ใน Todoist ตามรอบเวลา',
      kind: 'poll',
      operation: 'list_tasks',
      idField: 'id',
      fields: [{ key: 'project_id', label: 'Project ID', type: 'string', required: false }],
      sample: { id: 'task_1', content: 'Example task' },
    },
  ],
};
