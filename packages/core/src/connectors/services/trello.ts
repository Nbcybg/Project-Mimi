import type { ConnectorSpec } from '@mimi/shared';

export const trelloConnector: ConnectorSpec = {
  key: 'trello',
  label: 'Trello',
  category: 'project-management',
  description: 'อ่าน board/list และสร้างหรือย้ายการ์ดใน Trello',
  baseUrl: 'https://api.trello.com/1',
  auth: {
    kind: 'apiKey',
    fields: [
      { key: 'key', label: 'API key', type: 'secret', required: true },
      { key: 'token', label: 'Token', type: 'secret', required: true },
    ],
    extra: { location: 'query', queryNames: { key: 'key', token: 'token' } },
  },
  operations: [
    {
      key: 'list_boards',
      label: 'List boards',
      method: 'GET',
      path: '/members/me/boards',
      risk: 'read',
      fields: [{ key: 'fields', label: 'Fields', type: 'string', required: false, default: 'id,name,url' }],
    },
    {
      key: 'list_lists',
      label: 'List lists',
      method: 'GET',
      path: '/boards/{boardId}/lists',
      risk: 'read',
      fields: [{ key: 'boardId', label: 'Board ID', type: 'string', required: true }],
    },
    {
      key: 'list_cards',
      label: 'List cards',
      method: 'GET',
      path: '/lists/{listId}/cards',
      risk: 'read',
      fields: [{ key: 'listId', label: 'List ID', type: 'string', required: true }],
    },
    {
      key: 'create_card',
      label: 'Create card',
      method: 'POST',
      path: '/cards',
      risk: 'write',
      fields: [
        { key: 'idList', label: 'List ID', type: 'string', required: true },
        { key: 'name', label: 'Name', type: 'string', required: true },
        { key: 'desc', label: 'Description', type: 'string', required: false },
      ],
    },
    {
      key: 'move_card',
      label: 'Move card',
      method: 'PUT',
      path: '/cards/{cardId}',
      risk: 'write',
      fields: [
        { key: 'cardId', label: 'Card ID', type: 'string', required: true },
        { key: 'idList', label: 'List ID', type: 'string', required: true },
      ],
    },
  ],
};
