#!/usr/bin/env node
/**
 * bgg-trending-sync.js
 *
 * Fetches BoardGameGeek's "Hot Games" list, matches it against products in
 * the board-games collection (matched via the custom.bgg_id product
 * metafield), and writes the ordered, matched list to a shop-level
 * metafield (custom.trending_products) as a list.product_reference.
 *
 * Safety: if the BGG fetch fails, the XML can't be parsed, or zero matches
 * are found, the script aborts WITHOUT touching the existing metafield —
 * the storefront keeps showing yesterday's "Trending" list rather than an
 * empty or partial one.
 *
 * Requires Node 18+ (native fetch) and the fast-xml-parser package:
 *   npm install fast-xml-parser
 *
 * Required env vars:
 *   SHOPIFY_STORE_DOMAIN   e.g. made-in-camelot.myshopify.com
 *   SHOPIFY_CLIENT_ID
 *   SHOPIFY_CLIENT_SECRET
 */

const { XMLParser } = require('fast-xml-parser');

// ---- Config -------------------------------------------------------------

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2025-01'; // keep in sync with your other scripts

const BOARD_GAMES_COLLECTION_HANDLE = 'board-games';
const BGG_HOT_URL = 'https://boardgamegeek.com/xmlapi2/hot?type=boardgame';
const MAX_TRENDING_ITEMS = 12; // how many matched games the section will show

const TRENDING_METAFIELD_NAMESPACE = 'custom';
const TRENDING_METAFIELD_KEY = 'trending_products';
const BGG_ID_METAFIELD_NAMESPACE = 'custom';
const BGG_ID_METAFIELD_KEY = 'bgg_id';

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
  console.error('Missing required env vars: SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET');
  process.exit(1);
}

// ---- Auth (Client Credentials Grant) ------------------------------------

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

  if (!res.ok) {
    throw new Error(`Failed to get access token: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function shopifyGraphQL(token, query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();

  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

// ---- Step 1: fetch + parse the BGG hot list ------------------------------

async function fetchBggHotList() {
  const res = await fetch(BGG_HOT_URL, {
    headers: { 'User-Agent': 'made-in-camelot-trending-sync/1.0' },
  });

  if (!res.ok) {
    throw new Error(`BGG hot list request failed: ${res.status}`);
  }

  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml);

  const rawItems = parsed?.items?.item;
  if (!rawItems) {
    throw new Error('BGG hot list response had no <item> entries — aborting');
  }

  // A single-item response comes back as an object rather than an array.
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  const hotList = items
    .map((item) => ({
      bggId: String(item['@_id']),
      rank: Number(item['@_rank']),
      name: item.name?.['@_value'] ?? '(unknown)',
    }))
    .filter((item) => item.bggId && !Number.isNaN(item.rank))
    .sort((a, b) => a.rank - b.rank);

  if (hotList.length === 0) {
    throw new Error('Parsed BGG hot list but found zero valid entries — aborting');
  }

  return hotList;
}

// ---- Step 2: build a bggId -> product lookup from the collection --------

const COLLECTION_PRODUCTS_QUERY = `
  query CollectionProducts($handle: String!, $cursor: String) {
    collectionByHandle(handle: $handle) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          metafield(namespace: "${BGG_ID_METAFIELD_NAMESPACE}", key: "${BGG_ID_METAFIELD_KEY}") {
            value
          }
        }
      }
    }
  }
`;

async function buildBggIdLookup(token) {
  const lookup = new Map(); // bggId (string) -> { id, title }
  let cursor = null;
  let hasNextPage = true;
  let pageCount = 0;

  while (hasNextPage) {
    pageCount += 1;
    const data = await shopifyGraphQL(token, COLLECTION_PRODUCTS_QUERY, {
      handle: BOARD_GAMES_COLLECTION_HANDLE,
      cursor,
    });
    const products = data?.collectionByHandle?.products;

    if (!products) {
      throw new Error(`Collection "${BOARD_GAMES_COLLECTION_HANDLE}" not found — aborting`);
    }

    for (const product of products.nodes) {
      const bggId = product.metafield?.value?.trim();
      if (bggId) {
        lookup.set(bggId, { id: product.id, title: product.title });
      }
    }

    hasNextPage = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;

    if (pageCount > 20) {
      // ~462 products fits in 2 pages at 250/page — this is just a guard
      // against an unexpected infinite pagination loop.
      throw new Error('Paginated over 20 pages of products — aborting as a precaution');
    }
  }

  return lookup;
}

// ---- Step 3: match hot list against lookup, preserving BGG rank order ---

function matchTrendingProducts(hotList, lookup) {
  const matched = [];

  for (const hotItem of hotList) {
    const product = lookup.get(hotItem.bggId);
    if (product) {
      matched.push({ ...hotItem, productId: product.id, productTitle: product.title });
    }
    if (matched.length >= MAX_TRENDING_ITEMS) break;
  }

  return matched;
}

// ---- Step 4: write the ordered result to the shop metafield -------------

const METAFIELDS_SET_MUTATION = `
  mutation SetTrendingProducts($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace type }
      userErrors { field message }
    }
  }
`;

async function writeTrendingMetafield(token, matched) {
  const shopData = await shopifyGraphQL(token, `query { shop { id } }`);
  const shopId = shopData.shop.id;

  const value = JSON.stringify(matched.map((m) => m.productId));

  const result = await shopifyGraphQL(token, METAFIELDS_SET_MUTATION, {
    metafields: [
      {
        ownerId: shopId,
        namespace: TRENDING_METAFIELD_NAMESPACE,
        key: TRENDING_METAFIELD_KEY,
        type: 'list.product_reference',
        value,
      },
    ],
  });

  const userErrors = result.metafieldsSet.userErrors;
  if (userErrors.length > 0) {
    throw new Error(`metafieldsSet userErrors: ${JSON.stringify(userErrors)}`);
  }

  return result.metafieldsSet.metafields[0];
}

// ---- Main -----------------------------------------------------------------

async function main() {
  console.log('Fetching BGG hot list...');
  const hotList = await fetchBggHotList();
  console.log(`  Parsed ${hotList.length} hot items.`);

  console.log('Building bgg_id lookup from the board-games collection...');
  const token = await getAccessToken();
  const lookup = await buildBggIdLookup(token);
  console.log(`  Found bgg_id on ${lookup.size} products.`);

  const matched = matchTrendingProducts(hotList, lookup);
  console.log(`  Matched ${matched.length} hot games against the catalog:`);
  matched.forEach((m) => console.log(`    #${m.rank}  ${m.name}  ->  ${m.productTitle}`));

  if (matched.length === 0) {
    console.log('No matches found — leaving existing trending_products metafield untouched.');
    return;
  }

  console.log('Writing custom.trending_products metafield...');
  await writeTrendingMetafield(token, matched);
  console.log('Done.');
}

main().catch((err) => {
  console.error('bgg-trending-sync failed:', err.message);
  console.error('Existing custom.trending_products metafield was left untouched.');
  process.exit(1);
});
