#!/usr/bin/env node
/**
 * create-trending-metafield-definition.js
 *
 * One-off script: creates the shop-level metafield DEFINITION for
 * custom.trending_products. This is optional — bgg-trending-sync.js works
 * fine without it — but having a definition gives you type validation and
 * (per Shopify's 2025-07 changelog) some admin-side visibility.
 *
 * Run this once. Re-running is harmless; Shopify will just report that the
 * definition already exists via userErrors.
 *
 * Required env vars: SHOPIFY_STORE_DOMAIN, SHOPIFY_TRENDING_CLIENT_ID,
 * SHOPIFY_TRENDING_CLIENT_SECRET — credentials for the least-privilege
 * "BGG Trending Sync" app (read_products only, no write_products).
 */

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2025-01';

async function getAccessToken() {
  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Failed to get access token: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

const CREATE_DEFINITION_MUTATION = `
  mutation CreateTrendingDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id name namespace key type { name } }
      userErrors { field message code }
    }
  }
`;

async function main() {
  const token = await getAccessToken();

  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({
      query: CREATE_DEFINITION_MUTATION,
      variables: {
        definition: {
          name: 'Trending Products (BGG)',
          namespace: 'custom',
          key: 'trending_products',
          type: 'list.product_reference',
          ownerType: 'SHOP',
          description: 'Ordered list of products currently on the BGG hot list, populated by bgg-trending-sync.js',
        },
      },
    }),
  });

  const json = await res.json();

  if (json.errors) {
    console.error('GraphQL error:', JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }

  const { createdDefinition, userErrors } = json.data.metafieldDefinitionCreate;

  if (userErrors.length > 0) {
    console.log('userErrors (often just means it already exists):', JSON.stringify(userErrors, null, 2));
  }

  if (createdDefinition) {
    console.log('Definition created:', createdDefinition);
  }
}

main().catch((err) => {
  console.error('Failed to create definition:', err.message);
  process.exit(1);
});
