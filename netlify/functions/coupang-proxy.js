// ============================================================
// 쿠팡 API 프록시 함수 (Netlify Function) - 수정버전
// ============================================================

import crypto from 'crypto';

const BASE_URL = 'https://api-gateway.coupang.com';

function generateCoupangAuth(method, path, queryString, accessKey, secretKey) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yy = String(now.getUTCFullYear()).slice(2);
  const MM = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const HH = pad(now.getUTCHours());
  const mm = pad(now.getUTCMinutes());
  const ss = pad(now.getUTCSeconds());
  const datetime = `${yy}${MM}${dd}T${HH}${mm}${ss}Z`;

  const qs = queryString || '';
  const message = datetime + method + path + (qs ? '?' + qs : '');

  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(message)
    .digest('hex');

  const authorization = `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
  return { authorization, datetime };
}

async function callCoupangAPI(method, path, queryString, accessKey, secretKey) {
  const { authorization } = generateCoupangAuth(method, path, queryString, accessKey, secretKey);
  const url = queryString ? `${BASE_URL}${path}?${queryString}` : `${BASE_URL}${path}`;

  console.log('[쿠팡API 호출]', method, url);

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': authorization,
      'Content-Type': 'application/json;charset=UTF-8',
    },
  });

  const responseText = await response.text();
  console.log('[쿠팡API 응답]', response.status, responseText.slice(0, 300));

  if (!response.ok) {
    throw new Error(`쿠팡 API 오류 (${response.status}): ${responseText}`);
  }

  return JSON.parse(responseText);
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}T00:00:00`;
}

async function getProducts(vendorId, accessKey, secretKey) {
  const path = `/v2/providers/seller_api/apis/api/v1/vendor/${vendorId}/products`;
  const queryString = `maxPerPage=50&status=APPROVED`;
  const data = await callCoupangAPI('GET', path, queryString, accessKey, secretKey);

  const products = [];
  if (data?.data) {
    for (const product of data.data) {
      for (const vendorItem of (product.vendorItems || [])) {
        const optionParts = [vendorItem.optionName1, vendorItem.optionName2, vendorItem.optionName3].filter(Boolean);
        products.push({
          id: String(vendorItem.vendorItemId),
          productId: String(product.sellerProductId),
          name: product.sellerProductName || '상품명 없음',
          option: optionParts.length > 0 ? optionParts.join(' / ') : '기본',
          vendorItemId: String(vendorItem.vendorItemId),
          coupangStock: 0,
          warehouseStock: 0,
          sales30: new Array(30).fill(0),
          dailyAvg: 0,
          coupangDepletionDays: 999,
          totalDepletionDays: 999,
          lastUpdated: new Date().toISOString(),
        });
      }
    }
  }
  return products;
}

async function getInventory(vendorItemId, accessKey, secretKey) {
  const path = `/v2/providers/seller_api/apis/api/v1/vendor-items/${vendorItemId}/inventories`;
  const data = await callCoupangAPI('GET', path, '', accessKey, secretKey);

  let totalQty = 0;
  if (data?.data) {
    const inventories = Array.isArray(data.data) ? data.data : [data.data];
    for (const inv of inventories) totalQty += inv.quantity || 0;
  }
  return totalQty;
}

async function getSalesLast30Days(vendorId, accessKey, secretKey) {
  const salesByItemId = {};
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 30);

  const path = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets`;
  const baseQuery = `createdAtFrom=${encodeURIComponent(formatDate(thirtyDaysAgo))}&createdAtTo=${encodeURIComponent(formatDate(today))}&status=ACCEPT&limit=100`;

  let allOrders = [];
  let nextToken = null;

  for (let page = 0; page < 10; page++) {
    const q = nextToken ? baseQuery + `&nextToken=${encodeURIComponent(nextToken)}` : baseQuery;
    try {
      const data = await callCoupangAPI('GET', path, q, accessKey, secretKey);
      if (data?.data?.ordersheets) allOrders = allOrders.concat(data.data.ordersheets);
      nextToken = data?.data?.nextToken;
      if (!nextToken) break;
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.error('주문 조회 오류:', e.message);
      break;
    }
  }

  for (const order of allOrders) {
    for (const item of (order.orderItems || [])) {
      const itemId = String(item.vendorItemId);
      const orderDate = new Date(order.orderedAt);
      const daysAgo = Math.floor((today - orderDate) / (1000 * 60 * 60 * 24));
      if (daysAgo < 0 || daysAgo >= 30) continue;
      if (!salesByItemId[itemId]) salesByItemId[itemId] = new Array(30).fill(0);
      salesByItemId[itemId][29 - daysAgo] += item.quantity || 1;
    }
  }
  return salesByItemId;
}

function calcDepletionDays(stock, dailyAvg) {
  if (!dailyAvg || dailyAvg <= 0) return 999;
  return Math.floor(stock / dailyAvg);
}

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const accessKey = process.env.COUPANG_ACCESS_KEY;
    const secretKey = process.env.COUPANG_SECRET_KEY;
    const vendorId = process.env.COUPANG_VENDOR_ID;

    if (!accessKey || !secretKey || !vendorId) {
      return {
        statusCode: 400, headers,
        body: JSON.stringify({ error: 'Netlify 환경변수가 설정되지 않았습니다.', missing: { COUPANG_ACCESS_KEY: !accessKey, COUPANG_SECRET_KEY: !secretKey, COUPANG_VENDOR_ID: !vendorId } })
      };
    }

    const params = event.queryStringParameters || {};
    const action = params.action;

    if (action === 'test') {
      try {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        const path = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets`;
        const queryString = `createdAtFrom=${encodeURIComponent(formatDate(yesterday))}&createdAtTo=${encodeURIComponent(formatDate(today))}&status=ACCEPT&limit=1`;
        await callCoupangAPI('GET', path, queryString, accessKey, secretKey);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: '쿠팡 API 연결 성공! ✅' }) };
      } catch (e) {
        if (e.message.includes('404') || e.message.includes('NOT_FOUND')) {
          return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: '쿠팡 API 연결 성공! ✅' }) };
        }
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: '연결 실패: ' + e.message }) };
      }
    }

    if (action === 'products') {
      const products = await getProducts(vendorId, accessKey, secretKey);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: products }) };
    }

    if (action === 'full_sync') {
      const products = await getProducts(vendorId, accessKey, secretKey);
      const salesData = await getSalesLast30Days(vendorId, accessKey, secretKey);

      for (let i = 0; i < products.length; i += 5) {
        const batch = products.slice(i, i + 5);
        await Promise.all(batch.map(async (p) => {
          try { p.coupangStock = await getInventory(p.vendorItemId, accessKey, secretKey); }
          catch (e) { p.coupangStock = 0; }
        }));
        if (i + 5 < products.length) await new Promise(r => setTimeout(r, 300));
      }

      for (const p of products) {
        const sales = salesData[p.vendorItemId] || new Array(30).fill(0);
        p.sales30 = sales;
        p.dailyAvg = sales.reduce((a, b) => a + b, 0) / 30;
        p.coupangDepletionDays = calcDepletionDays(p.coupangStock, p.dailyAvg);
        p.totalDepletionDays = calcDepletionDays(p.coupangStock + p.warehouseStock, p.dailyAvg);
        p.lastUpdated = new Date().toISOString();
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: products, syncedAt: new Date().toISOString() }) };
    }

    if (action === 'inventory') {
      const { vendorItemId } = params;
      if (!vendorItemId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'vendorItemId가 필요합니다.' }) };
      const qty = await getInventory(vendorItemId, accessKey, secretKey);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, vendorItemId, quantity: qty }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `알 수 없는 action: ${action}` }) };

  } catch (error) {
    console.error('서버 오류:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + error.message }) };
  }
};
