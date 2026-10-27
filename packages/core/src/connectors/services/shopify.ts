import type { ConnectorSpec } from '@mimi/shared';

export const shopifyConnector: ConnectorSpec = {
  key: 'shopify',
  label: 'Shopify',
  category: 'commerce',
  description: 'อ่านสินค้า/คำสั่งซื้อ สร้างคำสั่งซื้อ และปรับสต็อกใน Shopify',
  baseUrl: 'https://your-shop.myshopify.com/admin/api/2024-10',
  auth: {
    kind: 'apiKey',
    fields: [{ key: 'token', label: 'Admin API access token', type: 'secret', required: true }],
    extra: { header: 'X-Shopify-Access-Token', prefix: '' },
  },
  operations: [
    {
      key: 'list_products',
      label: 'List products',
      method: 'GET',
      path: '/products.json',
      risk: 'read',
      fields: [{ key: 'limit', label: 'Limit', type: 'number', required: false, default: 50 }],
      response: { itemsPath: 'products' },
    },
    {
      key: 'get_product',
      label: 'Get product',
      method: 'GET',
      path: '/products/{productId}.json',
      risk: 'read',
      fields: [{ key: 'productId', label: 'Product ID', type: 'number', required: true }],
      response: { itemsPath: 'product' },
    },
    {
      key: 'list_orders',
      label: 'List orders',
      method: 'GET',
      path: '/orders.json',
      risk: 'read',
      fields: [{ key: 'limit', label: 'Limit', type: 'number', required: false, default: 50 }],
      response: { itemsPath: 'orders' },
    },
    {
      key: 'create_order',
      label: 'Create order',
      method: 'POST',
      path: '/orders.json',
      risk: 'write',
      body: { order: { line_items: [{ variant_id: '{{variantId}}', quantity: '{{quantity}}' }] } },
      fields: [
        { key: 'variantId', label: 'Variant ID', type: 'number', required: true },
        { key: 'quantity', label: 'Quantity', type: 'number', required: false, default: 1 },
      ],
    },
    {
      key: 'update_inventory',
      label: 'Set inventory level',
      method: 'POST',
      path: '/inventory_levels/set.json',
      risk: 'write',
      body: { inventory_item_id: '{{inventoryItemId}}', location_id: '{{locationId}}', available: '{{available}}' },
      fields: [
        { key: 'inventoryItemId', label: 'Inventory item ID', type: 'number', required: true },
        { key: 'locationId', label: 'Location ID', type: 'number', required: true },
        { key: 'available', label: 'Available', type: 'number', required: true },
      ],
    },
  ],
};
