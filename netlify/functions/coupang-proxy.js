// ============================================================
// 쿠팡 API 프록시 함수 - 서명 최종 수정버전
//
// 쿠팡 서명 공식:
//   message = datetime + METHOD + /path + ?key=value&key2=value2
//   ※ 서명용 쿼리스트링: 인코딩 없이 raw 값 그대로
//   ※ URL용 쿼리스트링: 값에 encodeURIComponent 적용
// ============================================================

import crypto from 'crypto';

const BASE_URL = 'https://api-gateway.coupang.com';

function generateAuth(method, path, rawQuery, accessKey, secretKey) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const datetime =
    String(now.getUTCFullYear()).slice(2) +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) + 'T' +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds()) + 'Z';

  // ✅ 서명: 인코딩 없는 raw 쿼리스트링
  const message = datetime + method + path + (rawQuery ? '?' + rawQuery : '');

  console.log('[서명메시지]', message);

  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(message)
    .digest('hex');

  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
}

async function callAPI(method, path, params, accessKey, secretKey) {
  const entries = params
    ? Object.entries(params).filter(([, v]) => v != null && v !== '')
    : [];

  // 서명용: 인코딩 없이 원본값 그대로
  const rawQuery = entries.map(([k, v]) => `${k}=${v}`).join('&');

  // URL용: 값만 encodeURIComponent
  const urlQuery = entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  const authorization = generateAuth(method, path, rawQuery, accessKey, secretKey);
  const url = urlQuery ? `${BASE_URL}${path}?${urlQuery}` : `${BASE_URL}${path}`;

  console.log(`[API] ${method} ${url}`);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json;charset=UTF-8',
    },
  });

  const text = await res.text();
  console.log(`[응답] ${res.status}`, text.slice(0, 400));

  if (!res.ok) throw new Error(`쿠팡 API 오류 (${res.status}): ${text}`);
  return JSON.parse(text);
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T00:00:00`;
}

async function getProducts(vendorId, ak, sk) {
  const path = `/v2/providers/seller_api/apis/api/v1/vendor/${vendorId}/products`;
  const data = await callAPI('GET', path, { maxPerPage: 50, status: 'APPROVED' }, ak, sk);
  const products = [];
  for (const p of (data?.data || [])) {
    for (const item of (p.vendorItems || [])) {
      const opts = [item.optionName1, item.optionName2, item.optionName3].filter(Boolean);
      products.push({
        id: String(item.vendorItemId),
        productId: String(p.sellerProductId),
        name: p.sellerProductName || '상품명 없음',
        option: opts.join(' / ') || '기본',
        vendorItemId: String(item.vendorItemId),
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
  return products;
}

// 로켓그로스 재고: 상품 아이템별 수량/가격/상태 조회
async function getRocketStock(vendorId, vendorItemId, ak, sk) {
  const path = `/v2/providers/seller_api/apis/api/v1/vendor/${vendorId}/items/${vendorItemId}`;
  const data = await callAPI('GET', path, null, ak, sk);
  return data?.data?.quantity ?? 0;
}

async function getSales30(vendorId, ak, sk) {
  const today = new Date();
  const from  = new Date(today);
  from.setDate(today.getDate() - 30);

  const path = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets`;
  let orders = [], nextToken = null;

  for (let i = 0; i < 10; i++) {
    const params = {
      createdAtFrom: formatDate(from),
      createdAtTo:   formatDate(today),
      status: 'ACCEPT',
      limit: 100,
      ...(nextToken ? { nextToken } : {}),
    };
    try {
      const data = await callAPI('GET', path, params, ak, sk);
      if (data?.data?.ordersheets) orders = orders.concat(data.data.ordersheets);
      nextToken = data?.data?.nextToken;
      if (!nextToken) break;
      await new Promise(r => setTimeout(r, 200));
    } catch (e) { console.error('주문조회실패:', e.message); break; }
  }

  const byItem = {};
  for (const order of orders) {
    for (const item of (order.orderItems || [])) {
      const id = String(item.vendorItemId);
      const daysAgo = Math.floor((today - new Date(order.orderedAt)) / 86400000);
      if (daysAgo < 0 || daysAgo >= 30) continue;
      if (!byItem[id]) byItem[id] = new Array(30).fill(0);
      byItem[id][29 - daysAgo] += item.quantity || 1;
    }
  }
  return byItem;
}

const depletion = (stock, avg) => (!avg || avg <= 0) ? 999 : Math.floor(stock / avg);

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const ak = (process.env.COUPANG_ACCESS_KEY || '').trim();
    const sk = (process.env.COUPANG_SECRET_KEY || '').trim();
    const vi = (process.env.COUPANG_VENDOR_ID  || '').trim();

    if (!ak || !sk || !vi) {
      return {
        statusCode: 400, headers,
        body: JSON.stringify({ error: '환경변수 미설정', missing: { ak: !ak, sk: !sk, vi: !vi } }),
      };
    }

    const { action, vendorItemId } = event.queryStringParameters || {};

    // ── 연결 테스트
    if (action === 'test') {
      try {
        const path = `/v2/providers/seller_api/apis/api/v1/vendor/${vi}/products`;
        await callAPI('GET', path, { maxPerPage: 1, status: 'APPROVED' }, ak, sk);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: '쿠팡 API 연결 성공! ✅' }) };
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: '연결 실패: ' + e.message }) };
      }
    }

    // ── 상품 목록
    if (action === 'products') {
      const products = await getProducts(vi, ak, sk);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: products }) };
    }

    // ── 전체 동기화
    if (action === 'full_sync') {
      const products  = await getProducts(vi, ak, sk);
      const salesData = await getSales30(vi, ak, sk);

      for (let i = 0; i < products.length; i += 5) {
        await Promise.all(products.slice(i, i + 5).map(async p => {
          try   { p.coupangStock = await getRocketStock(vi, p.vendorItemId, ak, sk); }
          catch (e) { p.coupangStock = 0; }
        }));
        if (i + 5 < products.length) await new Promise(r => setTimeout(r, 300));
      }

      for (const p of products) {
        const sales = salesData[p.vendorItemId] || new Array(30).fill(0);
        p.sales30   = sales;
        p.dailyAvg  = sales.reduce((a, b) => a + b, 0) / 30;
        p.coupangDepletionDays = depletion(p.coupangStock, p.dailyAvg);
        p.totalDepletionDays   = depletion(p.coupangStock + p.warehouseStock, p.dailyAvg);
        p.lastUpdated = new Date().toISOString();
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: products, syncedAt: new Date().toISOString() }) };
    }

    // ── 단일 재고 조회
    if (action === 'inventory') {
      if (!vendorItemId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'vendorItemId 필요' }) };
      const qty = await getRocketStock(vi, vendorItemId, ak, sk);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, vendorItemId, quantity: qty }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `알 수 없는 action: ${action}` }) };

  } catch (err) {
    console.error('서버오류:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};
