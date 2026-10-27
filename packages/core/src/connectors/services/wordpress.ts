import type { ConnectorSpec } from '@mimi/shared';

export const wordpressConnector: ConnectorSpec = {
  key: 'wordpress',
  label: 'WordPress',
  category: 'cms',
  description: 'อ่าน เขียน และอัปโหลดสื่อไปยัง WordPress ผ่าน REST API',
  baseUrl: 'https://your-site.example/wp-json/wp/v2',
  auth: {
    kind: 'basic',
    fields: [
      { key: 'username', label: 'Username', type: 'string', required: true },
      { key: 'password', label: 'Application password', type: 'secret', required: true },
    ],
  },
  operations: [
    {
      key: 'list_posts',
      label: 'List posts',
      method: 'GET',
      path: '/posts',
      risk: 'read',
      fields: [{ key: 'per_page', label: 'Per page', type: 'number', required: false, default: 20 }],
    },
    {
      key: 'get_post',
      label: 'Get post',
      method: 'GET',
      path: '/posts/{postId}',
      risk: 'read',
      fields: [{ key: 'postId', label: 'Post ID', type: 'number', required: true }],
    },
    {
      key: 'create_post',
      label: 'Create post',
      method: 'POST',
      path: '/posts',
      risk: 'write',
      body: { title: '{{title}}', content: '{{content}}', status: '{{status}}' },
      fields: [
        { key: 'title', label: 'Title', type: 'string', required: true },
        { key: 'content', label: 'Content', type: 'string', required: true },
        { key: 'status', label: 'Status', type: 'string', required: false, default: 'draft' },
      ],
    },
    {
      key: 'update_post',
      label: 'Update post',
      method: 'PUT',
      path: '/posts/{postId}',
      risk: 'write',
      body: { title: '{{title}}', content: '{{content}}' },
      fields: [
        { key: 'postId', label: 'Post ID', type: 'number', required: true },
        { key: 'title', label: 'Title', type: 'string', required: true },
        { key: 'content', label: 'Content', type: 'string', required: false },
      ],
    },
    {
      key: 'upload_media',
      label: 'Upload media',
      method: 'POST',
      path: '/media',
      risk: 'write',
      bodyFormat: 'binary',
      body: '{{content}}',
      headers: {
        'content-type': '{{mime}}',
        'content-disposition': 'attachment; filename="{{filename}}"',
      },
      fields: [
        { key: 'filename', label: 'File name', type: 'string', required: true },
        { key: 'mime', label: 'MIME type', type: 'string', required: true, default: 'image/png' },
        { key: 'content', label: 'Content (base64)', type: 'string', required: true },
      ],
    },
  ],
};
