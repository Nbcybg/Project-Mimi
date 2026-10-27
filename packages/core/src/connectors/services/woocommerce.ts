import type { ConnectorSpec } from '@mimi/shared';

export const woocommerceConnector: ConnectorSpec = {
  key: 'woocommerce',
  label: 'WooCommerce',
  category: 'commerce',
  description: 'อ่านสินค้า/คำสั่งซื้อ สร้างสินค้า และอัปเดตสถานะคำสั่งซื้อ',
  baseUrl: 'https://your-store.example/wp-json/wc/v3',
  auth: {
    kind: 'basic',
    fields: [
      { key: 'username', label: 'Consumer key', type: 'secret', required: true },
      { key: 'password', label: 'Consumer secret', type: 'secret', required: true },
    ],
  },
  operations: [
    {
      key: 'list_products',
      label: 'List products',
      method: 'GET',
      path: '/products',
      risk: 'read',
      fields: [{ key: 'per_page', label: 'Per page', type: 'number', required: false, default: 50 }],
    },
    {
      key: 'get_product',
      label: 'Get product',
      method: 'GET',
      path: '/products/{productId}',
      risk: 'read',
      fields: [{ key: 'productId', label: 'Product ID', type: 'number', required: true }],
    },
    {
      key: 'create_product',
      label: 'Create product',
      method: 'POST',
      path: '/products',
      risk: 'write',
      body: { name: '{{name}}', regular_price: '{{price}}', description: '{{description}}' },
      fields: [
        { key: 'name', label: 'Name', type: 'string', required: true },
        { key: 'price', label: 'Price', type: 'string', required: false },
        { key: 'description', label: 'Description', type: 'string', required: false },
      ],
    },
    {
      key: 'list_orders',
      label: 'List orders',
      method: 'GET',
      path: '/orders',
      risk: 'read',
      fields: [{ key: 'per_page', label: 'Per page', type: 'number', required: false, default: 50 }],
    },
    {
      key: 'update_order',
      label: 'Update order status',
      method: 'PUT',
      path: '/orders/{orderId}',
      risk: 'write',
      body: { status: '{{status}}' },
      fields: [
        { key: 'orderId', label: 'Order ID', type: 'number', required: true },
        { key: 'status', label: 'Status', type: 'string', required: true, placeholder: 'completed' },
      ],
    },
  ],
};
