import type { ConnectorSpec } from '@mimi/shared';

export const openaiConnector: ConnectorSpec = {
  key: 'openai',
  label: 'OpenAI',
  category: 'ai',
  description: 'เรียก OpenAI models, responses, embeddings และ chat completions',
  baseUrl: 'https://api.openai.com/v1',
  auth: {
    kind: 'bearer',
    fields: [{ key: 'token', label: 'API key', type: 'secret', required: true, placeholder: 'sk-...' }],
  },
  operations: [
    {
      key: 'list_models',
      label: 'List models',
      method: 'GET',
      path: '/models',
      risk: 'read',
      fields: [],
      response: { itemsPath: 'data' },
    },
    {
      key: 'create_response',
      label: 'Create response',
      method: 'POST',
      path: '/responses',
      risk: 'write',
      body: { model: '{{model}}', input: '{{input}}' },
      fields: [
        { key: 'model', label: 'Model', type: 'string', required: false, default: 'gpt-4.1-mini' },
        { key: 'input', label: 'Input', type: 'string', required: true },
      ],
    },
    {
      key: 'create_embedding',
      label: 'Create embedding',
      method: 'POST',
      path: '/embeddings',
      risk: 'write',
      body: { model: '{{model}}', input: '{{input}}' },
      fields: [
        { key: 'model', label: 'Model', type: 'string', required: false, default: 'text-embedding-3-small' },
        { key: 'input', label: 'Input', type: 'string', required: true },
      ],
      response: { itemsPath: 'data' },
    },
    {
      key: 'chat_completion',
      label: 'Chat completion',
      method: 'POST',
      path: '/chat/completions',
      risk: 'write',
      body: { model: '{{model}}', messages: [{ role: 'user', content: '{{input}}' }] },
      fields: [
        { key: 'model', label: 'Model', type: 'string', required: false, default: 'gpt-4.1-mini' },
        { key: 'input', label: 'Message', type: 'string', required: true },
      ],
      response: { itemsPath: 'choices' },
    },
    {
      key: 'list_files',
      label: 'List files',
      method: 'GET',
      path: '/files',
      risk: 'read',
      fields: [],
      response: { itemsPath: 'data' },
    },
  ],
};
