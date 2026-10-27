import type { ConnectorSpec } from '@mimi/shared';

export const clickupConnector: ConnectorSpec = {
  key: 'clickup',
  label: 'ClickUp',
  category: 'project-management',
  description: 'อ่าน space/list/task และสร้างหรืออัปเดตงานใน ClickUp',
  baseUrl: 'https://api.clickup.com/api/v2',
  auth: {
    kind: 'bearer',
    fields: [{ key: 'token', label: 'Personal API token', type: 'secret', required: true }],
  },
  operations: [
    {
      key: 'list_spaces',
      label: 'List spaces',
      method: 'GET',
      path: '/team/{teamId}/space',
      risk: 'read',
      fields: [{ key: 'teamId', label: 'Team ID', type: 'string', required: true }],
      response: { itemsPath: 'spaces' },
    },
    {
      key: 'list_lists',
      label: 'List lists',
      method: 'GET',
      path: '/space/{spaceId}/list',
      risk: 'read',
      fields: [{ key: 'spaceId', label: 'Space ID', type: 'string', required: true }],
      response: { itemsPath: 'lists' },
    },
    {
      key: 'list_tasks',
      label: 'List tasks',
      method: 'GET',
      path: '/list/{listId}/task',
      risk: 'read',
      fields: [
        { key: 'listId', label: 'List ID', type: 'string', required: true },
        { key: 'page', label: 'Page', type: 'number', required: false },
      ],
      response: { itemsPath: 'tasks' },
    },
    {
      key: 'create_task',
      label: 'Create task',
      method: 'POST',
      path: '/list/{listId}/task',
      risk: 'write',
      body: { name: '{{name}}', description: '{{description}}' },
      fields: [
        { key: 'listId', label: 'List ID', type: 'string', required: true },
        { key: 'name', label: 'Name', type: 'string', required: true },
        { key: 'description', label: 'Description', type: 'string', required: false, default: '' },
      ],
    },
    {
      key: 'update_task',
      label: 'Update task',
      method: 'PUT',
      path: '/task/{taskId}',
      risk: 'write',
      body: { name: '{{name}}', status: '{{status}}' },
      fields: [
        { key: 'taskId', label: 'Task ID', type: 'string', required: true },
        { key: 'name', label: 'Name', type: 'string', required: true },
        { key: 'status', label: 'Status', type: 'string', required: false },
      ],
    },
  ],
};
