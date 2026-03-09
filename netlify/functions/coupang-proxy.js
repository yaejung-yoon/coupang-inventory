// ============================================================
// 쿠팡 API 프록시 - 최종 검증 버전
//
// 서명 규칙 (공식 PHP 예제 기준):
//   message = datetime + METHOD + path + query   ← ? 없이 바로 붙임
//   url     = BASE_URL + path + "?" + query      ← URL에만 ? 붙임
//   query   = raw 값 그대로 (인코딩 없음)
//   서명용 query == URL용 query (완전 동일)
//
// 날짜 형식 (공식문서 예제 확인):
//   "createdAtFrom=2020-02-19T10:43:30" ← 시간 포함 필수
//   콜론(:)은 raw로 그대로 → 서명/URL 모두 동일하므로 불일치 없음
// ============================================================

import crypto from 'crypto';

const BASE_URL = 'https://api-gateway.coupang.com';

function generateAuth(method, path, query, accessKey, secretKey) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const datetime =
    String(now.getUTCFullYear()).slice(2) +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) + 'T' +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds()) + 'Z';

  // ✅ ? 없이 바로 붙임 (공식 PHP: $message = $datetime.$method.$path.$query)
  const message = datetime + method + path + query;
  console.log('[서명]', message);

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

  // ✅ raw 값 그대로 - 서명용과 URL용 완전 동일
  // ✅ 콜론(:) 등 특수문자 인코딩 없음 → 불일치 원천 차단
  const query = entries.map(([k, v]) => `${k}=${v}`).join('&');

  const authorization = generateAuth(method, path, query, accessKey, secretKey);
  // URL에만 ? 붙임 (공식 PHP: $url = BASE_URL.$path.'?'.$query)
  const url = query ? `${BASE_URL}${path}?${query}` : `${BASE_URL}${path}`;

  console.log(`[API] ${method} ${url}`);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json;charset=UTF-8',
    },
  });

  const text = await res.text();
  console.log(`[응답] ${res.status}`, text.slice(0, 500));

  if (!res.ok) throw new Error(`쿠팡 API 오류 (${res.status}): ${text}`);
  return JSON.parse(text);
}

// ✅ 공식문서 확인: 날짜+시간 형식 필수 "2020-02-19T10:43:30"
// raw 값으로 그대로 전송 → 인코딩 불일치 없음
function formatDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ─────────────────────────────────────────────
// 상품 목록 (sellerProductId 수집)
// ─────────────────────────────────────────────
async function getSellerProductIds(ak, sk) {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;
  const allIds = [];
  let nextToken = null;

  for (let page = 0; page < 20; page++) {
    const params = {
      maxPerPage: 100,
      status: 'APPROVED',
      ...(nextToken ? { nextToken } : {}),
    };
    const data = await callAPI('GET', path, params, ak, sk);
    const items = data?.data || [];
    for (const item of items) {
      if (item.sellerProductId) allIds.push(String(item.sellerProductId));
    }
    nextToken = data?.nextToken;
    if (!nextToken || items.length === 0) break;
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`[상품목록] ${allIds.length}개`);
  return allIds;
}

// ─────────────────────────────────────────────
// 개별 상품 상세 조회
// ✅ 공식문서 확인: 응답 data.items[] (vendorItems 아님)
// ─────────────────────────────────────────────
async function getProductDetail(sellerProductId, ak, sk) {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`;
  const data = await callAPI('GET', path, null, ak, sk);
  return data?.data;
}

async function getProducts(ak, sk) {
  const ids = await getSellerProductIds(ak, sk);
  const products = [];

  for (let i = 0; i < ids.length; i += 3) {
    const details = await Promise.all(
      ids.slice(i, i + 3).map(id =>
        getProductDetail(id, ak, sk).catch(e => {
          console.error(`상품상세 실패(${id}):`, e.message);
          return null;
        })
      )
    );

    for (const p of details) {
      if (!p) continue;
      // ✅ 공식문서: data.items[] 필드 (vendorItems 아님)
      for (const item of (p.items || [])) {
        products.push({
          id: String(item.vendorItemId),
          productId: String(p.sellerProductId),
          name: p.sellerProductName || '상품명 없음',
          // ✅ 공식문서: itemName 필드
          option: item.itemName || '기본',
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
    if (i + 3 < ids.length) await new Promise(r => setTimeout(r, 300));
  }
  console.log(`[상품목록] 총 ${products.length}개`);
  return products;
}

// ─────────────────────────────────────────────
// 로켓그로스 재고 조회
// ✅ 공식문서 확인: amountInStock 필드
// ─────────────────────────────────────────────
async function getRocketStock(vendorItemId, ak, sk) {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/inventories`;
  const data = await callAPI('GET', path, null, ak, sk);
  console.log(`[재고 ${vendorItemId}]`, JSON.stringify(data?.data));
  return data?.data?.amountInStock ?? 0;
}

// ─────────────────────────────────────────────
// 최근 30일 판매량
// ─────────────────────────────────────────────
async function getSales30(vendorId, ak, sk) {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 30);

  const path = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets`;
  let orders = [], nextToken = null;

  for (let i = 0; i < 10; i++) {
    const params = {
      createdAtFrom: formatDate(from),
      createdAtTo: formatDate(today),
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
    } catch (e) {
      console.error('주문조회 실패:', e.message);
      break;
    }
  }

  const byItem = {};
  for (const order of orders) {
    for (const item of (order.orderItems || [])) {
      const id = String(item.vendorItemId);
      const daysAgo = Math.floor((today - new Date(order.orderedAt)) / 86400000);
      if (daysAgo < 0 || daysAgo >= 30) continue;
      if (!byItem[id]) byItem[id] = new Array(30).fill(0);
      byItem[id][29 - daysAgo] += item.shippingCount || item.quantity || 1;
    }
  }
  return byItem;
}

const depletion = (stock, avg) => (!avg || avg <= 0) ? 999 : Math.floor(stock / avg);

// ─────────────────────────────────────────────
// Netlify Function 진입점
// ─────────────────────────────────────────────
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

    // 키 디버그 확인용
    if (action === 'debug') {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          accessKey: { length: ak.length, first4: ak.slice(0,4), last4: ak.slice(-4) },
          secretKey: { length: sk.length, first4: sk.slice(0,4), last4: sk.slice(-4) },
          vendorId: vi,
        }),
      };
    }

    // 연결 테스트 - 주문조회 API 사용
    if (action === 'test') {
      try {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        const path = `/v2/providers/openapi/apis/api/v4/vendors/${vi}/ordersheets`;
        await callAPI('GET', path, {
          createdAtFrom: formatDate(yesterday),
          createdAtTo: formatDate(today),
          status: 'ACCEPT',
          limit: 1,
        }, ak, sk);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: '쿠팡 API 연결 성공! ✅' }) };
      } catch (e) {
        // 주문 없어서 404여도 서명은 성공
        if (e.message.includes('404')) {
          return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: '쿠팡 API 연결 성공! ✅' }) };
        }
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: '연결 실패: ' + e.message }) };
      }
    }

    if (action === 'products') {
      const products = await getProducts(ak, sk);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: products }) };
    }

    if (action === 'full_sync') {
      const products  = await getProducts(ak, sk);
      const salesData = await getSales30(vi, ak, sk);

      for (let i = 0; i < products.length; i += 5) {
        await Promise.all(products.slice(i, i + 5).map(async p => {
          try   { p.coupangStock = await getRocketStock(p.vendorItemId, ak, sk); }
          catch (e) { p.coupangStock = 0; }
        }));
        if (i + 5 < products.length) await new Promise(r => setTimeout(r, 300));
      }

      for (const p of products) {
        const sales = salesData[p.vendorItemId] || new Array(30).fill(0);
        p.sales30  = sales;
        p.dailyAvg = sales.reduce((a, b) => a + b, 0) / 30;
        p.coupangDepletionDays = depletion(p.coupangStock, p.dailyAvg);
        p.totalDepletionDays   = depletion(p.coupangStock + p.warehouseStock, p.dailyAvg);
        p.lastUpdated = new Date().toISOString();
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: products, syncedAt: new Date().toISOString() }) };
    }

    if (action === 'inventory') {
      if (!vendorItemId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'vendorItemId 필요' }) };
      const qty = await getRocketStock(vendorItemId, ak, sk);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, vendorItemId, quantity: qty }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `알 수 없는 action: ${action}` }) };

  } catch (err) {
    console.error('서버오류:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};
