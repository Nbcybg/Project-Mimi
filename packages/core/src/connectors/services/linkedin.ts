import type { ConnectorSpec } from '@mimi/shared';

export const linkedinConnector: ConnectorSpec = {
  key: 'linkedin',
  label: 'LinkedIn',
  category: 'marketing',
  description: 'List administered organizations, read the signed-in profile and publish an organization post; organization scopes need LinkedIn review',
  baseUrl: 'https://api.linkedin.com',
  auth: {
    kind: 'oauth2',
    fields: [
      { key: 'clientId', label: 'Client ID', type: 'string', required: true },
      { key: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
      { key: 'refreshToken', label: 'Refresh token', type: 'secret', required: true },
      { key: 'accessToken', label: 'Access token', type: 'secret' },
      { key: 'expiresAt', label: 'Expires at', type: 'string' },
    ],
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['openid', 'profile', 'w_member_social', 'r_organization_social', 'w_organization_social'],
  },
  operations: [
    {
      key: 'list_organizations',
      label: 'List organizations',
      method: 'GET',
      path: '/v2/organizationAcls?q=roleAssignee',
      risk: 'read',
      fields: [],
      response: { itemsPath: 'elements' },
    },
    {
      key: 'create_post',
      label: 'Create organization post',
      method: 'POST',
      path: '/v2/ugcPosts',
      risk: 'write',
      body: {
        author: '{{author}}',
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: { text: '{{text}}' },
            shareMediaCategory: 'NONE',
          },
        },
        visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
      },
      fields: [
        { key: 'author', label: 'Author URN', type: 'string', required: true, placeholder: 'urn:li:organization:12345' },
        { key: 'text', label: 'Post text', type: 'string', required: true },
      ],
    },
    {
      key: 'get_profile',
      label: 'Get profile',
      method: 'GET',
      path: '/v2/userinfo',
      risk: 'read',
      fields: [],
    },
  ],
  rateLimit: { requests: 10, perMs: 1000, burst: 10 },
};
