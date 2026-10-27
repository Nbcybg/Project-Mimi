import type { ConnectorSpec } from '@mimi/shared';

export const mondayConnector: ConnectorSpec = {
  key: 'monday',
  label: 'monday.com',
  category: 'project-management',
  description: 'อ่าน board/item และสร้างงานหรืออัปเดตใน monday.com ผ่าน GraphQL',
  baseUrl: 'https://api.monday.com/v2',
  auth: {
    kind: 'apiKey',
    fields: [{ key: 'token', label: 'API token', type: 'secret', required: true }],
    extra: { header: 'Authorization', prefix: '' },
  },
  operations: [
    {
      key: 'list_boards',
      label: 'List boards',
      method: 'POST',
      path: '/',
      risk: 'read',
      body: { query: 'query { boards { id name } }' },
      fields: [],
      response: { itemsPath: 'data.boards' },
    },
    {
      key: 'list_items',
      label: 'List items',
      method: 'POST',
      path: '/',
      risk: 'read',
      body: {
        query: 'query($board: [ID]) { boards(ids: $board) { items_page { items { id name } } } }',
        variables: { board: ['{{boardId}}'] },
      },
      fields: [{ key: 'boardId', label: 'Board ID', type: 'string', required: true }],
      response: { itemsPath: 'data.boards.0.items_page.items' },
    },
    {
      key: 'create_item',
      label: 'Create item',
      method: 'POST',
      path: '/',
      risk: 'write',
      body: {
        query: 'mutation($board: ID!, $name: String!) { create_item(board_id: $board, item_name: $name) { id } }',
        variables: { board: '{{boardId}}', name: '{{name}}' },
      },
      fields: [
        { key: 'boardId', label: 'Board ID', type: 'string', required: true },
        { key: 'name', label: 'Name', type: 'string', required: true },
      ],
      response: { itemsPath: 'data.create_item' },
    },
    {
      key: 'update_item',
      label: 'Update item name',
      method: 'POST',
      path: '/',
      risk: 'write',
      body: {
        query: 'mutation($board: ID!, $item: ID!, $name: String!) { change_simple_column_value(board_id: $board, item_id: $item, column_id: "name", value: $name) { id } }',
        variables: { board: '{{boardId}}', item: '{{itemId}}', name: '{{name}}' },
      },
      fields: [
        { key: 'boardId', label: 'Board ID', type: 'string', required: true },
        { key: 'itemId', label: 'Item ID', type: 'string', required: true },
        { key: 'name', label: 'Name', type: 'string', required: true },
      ],
      response: { itemsPath: 'data.change_simple_column_value' },
    },
    {
      key: 'create_update',
      label: 'Post update',
      method: 'POST',
      path: '/',
      risk: 'write',
      body: {
        query: 'mutation($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { id } }',
        variables: { item: '{{itemId}}', body: '{{body}}' },
      },
      fields: [
        { key: 'itemId', label: 'Item ID', type: 'string', required: true },
        { key: 'body', label: 'Update', type: 'string', required: true },
      ],
      response: { itemsPath: 'data.create_update' },
    },
  ],
};
