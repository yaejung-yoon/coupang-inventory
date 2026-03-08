// ============================================================
// 쿠팡 API 프록시 함수 (Netlify Function)
// 로켓그로스 전용 재고 조회 버전
// ============================================================

import crypto from 'crypto';

const BASE_URL = 'https://api-gateway.coupang.com';

// ─────────────────────────────────────────────
// 쿠팡 API 인증 서명 생성
// ─────────────────────────────────────────────
function generateCoupangAuth(method, path, rawQueryString, accessKey, secretKey) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yy = String(now.getUTCFullYear()).slice(2);
  const MM = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const HH = pad(now.getUTCHours());
  const mm = pad(now.getUTCMinutes());
  const ss = pad(now.getUTCSeconds());
  const datetime = `${yy}${MM}${dd}T${HH}${mm}${ss}Z`;

  // ※ 서명은 반드시 인코딩 없는 raw 쿼리스트링으로 계산
  const message = datetime + method + path + (rawQueryString ? '?' + rawQueryString : '');
  console.log('[서명 메시지]', message);

  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(message)
    .digest('hex');

  const authorization = `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
  return { authorization };
}

// ─────────────────────────────────────────────
// 쿠팡 API 호출 공통 함수
// params 객체 → raw 서명용 / encoded URL용 분리 처리
// ─────────────────────────────────────────────
async function callCoupangAPI(method, path, params, accessKey, secretKey) {
  const entries = params
    ? Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    : [];

  // 서명용: 인코딩 없이 그대로
  const rawQueryString = entries.map(([k, v]) => `${k}=${v}`).join('&');

  // URL용: 값만 encodeURIComponent
  const encodedQueryString = entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  const { authorization } = generateCoupangAuth(method, path, rawQueryString, accessKey, secretKey);

  const url = encodedQueryString
    ? `${BASE_URL}${path}?${encodedQueryString}`
    : `${BASE_URL}${path}`;

  console.log('[쿠팡API 호출]', method, url);

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': authorization,
      'Content-Type': 'application/json;charset=UTF-8',
    },
  });

  const responseText = await response.text();
  console.log('[쿠팡API 응답]', response.status, responseText.slice(0, 500));

  if (!response.ok) {
    throw new Error(`쿠팡 API 오류 (${response.status}): ${responseText}`);
  }

  return JSON.parse(responseText);
}

// ─────────────────────────────────────────────
// 날짜 포맷 (쿠팡 API 형식)
// ─────────────────────────────────────────────
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}T00:00:00`;
}

// ─────────────────────────────────────────────
// 상품 목록 가져오기
// 로켓그로스 상품만 필터링하기 위해 productType 확인
// ─────────────────────────────────────────────
async function getProducts(vendorId, accessKey, secretKey) {
  const path = `/v2/providers/seller_api/apis/api/v1/vendor/${vendorId}/products`;
  const data = await callCoupangAPI('GET', path, { maxPerPage: 50, status: 'APPROVED' }, accessKey, secretKey);

  const products = [];
  if (data?.data) {
    for (const product of data.data) {
      for (const vendorItem of (product.vendorItems || [])) {
        const optionParts = [
          vendorItem.optionName1,
          vendorItem.optionName2,
          vendorItem.optionName3,
        ].filter(Boolean);

        products.push({
          id: String(vendorItem.vendorItemId),
          productId: String(product.sellerProductId),
          name: product.sellerProductName || '상품명 없음',
          option: optionParts.length > 0 ? optionParts.join(' / ') : '기본',
          vendorItemId: String(vendorItem.vendorItemId),
          // 로켓그로스 여부 표시
          isRocketGrowth: product.productType === 'ROCKET_GROWTH' || vendorItem.vendorItemSaleType === 'ROCKET_GROWTH',
          coupangStock: 0,       // 로켓그로스 쿠팡 창고 재고
          warehouseStock: 0,     // 자체 창고 재고 (수동 입력)
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

// ─────────────────────────────────────────────
// 🚀 로켓그로스 재고 조회 (핵심 수정 부분)
//
// 쿠팡 공식 가이드:
//   "로켓그로스 상품의 경우 입고 수량이 상품 수량으로 반영됨"
//
// API: 상품 아이템별 수량/가격/상태 조회
//   GET /v2/providers/seller_api/apis/api/v1/vendor/{vendorId}/items/{vendorItemId}
//
// 이 API의 응답에서 quantity 값이 바로 쿠팡 물류창고 재고 수량
// ─────────────────────────────────────────────
async function getRocketGrowthInventory(vendorId, vendorItemId, accessKey, secretKey) {
  const path = `/v2/providers/seller_api/apis/api/v1/vendor/${vendorId}/items/${vendorItemId}`;

  const data = await callCoupangAPI('GET', path, null, accessKey, secretKey);

  console.log('[로켓그로스 재고 응답]', JSON.stringify(data?.data).slice(0, 200));

  // 응답 구조: data.data.quantity 가 현재 쿠팡 물류창고 재고
  const quantity = data?.data?.quantity ?? 0;
  return quantity;
}

// ─────────────────────────────────────────────
// 최근 30일 판매량 조회
// ─────────────────────────────────────────────
async function getSalesLast30Days(vendorId, accessKey, secretKey) {
  const salesByItemId = {};
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 30);

  const path = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets`;

  let allOrders = [];
  let nextToken = null;

  for (let page = 0; page < 10; page++) {
    const params = {
      createdAtFrom: formatDate(thirtyDaysAgo),
      createdAtTo: formatDate(today),
      status: 'ACCEPT',
      limit: 100,
    };
    if (nextToken) params.nextToken = nextToken;

    try {
      const data = await callCoupangAPI('GET', path, params, accessKey, secretKey);
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
    const accessKey = process.env.COUPANG_ACCESS_KEY?.trim();
    const secretKey = process.env.COUPANG_SECRET_KEY?.trim();
    const vendorId = process.env.COUPANG_VENDOR_ID?.trim();

    if (!accessKey || !secretKey || !vendorId) {
      return {
        statusCode: 400, headers,
        body: JSON.stringify({
          error: 'Netlify 환경변수가 설정되지 않았습니다.',
          missing: {
            COUPANG_ACCESS_KEY: !accessKey,
            COUPANG_SECRET_KEY: !secretKey,
            COUPANG_VENDOR_ID: !vendorId,
          }
        })
      };
    }

    const params = event.queryStringParameters || {};
    const action = params.action;

    // ── 연결 테스트
    if (action === 'test') {
      try {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);

        const path = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets`;
        await callCoupangAPI('GET', path, {
          createdAtFrom: formatDate(yesterday),
          createdAtTo: formatDate(today),
          status: 'ACCEPT',
          limit: 1,
        }, accessKey, secretKey);

        return {
          statusCode: 200, headers,
          body: JSON.stringify({ success: true, message: '쿠팡 API 연결 성공! ✅' })
        };
      } catch (e) {
        if (e.message.includes('404')) {
          return {
            statusCode: 200, headers,
            body: JSON.stringify({ success: true, message: '쿠팡 API 연결 성공! ✅' })
          };
        }
        return {
          statusCode: 200, headers,
          body: JSON.stringify({ success: false, message: '연결 실패: ' + e.message })
        };
      }
    }

    // ── 상품 목록
    if (action === 'products') {
      const products = await getProducts(vendorId, accessKey, secretKey);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, data: products })
      };
    }

    // ── 전체 동기화 (로켓그로스 재고 + 판매량)
    if (action === 'full_sync') {
      // 1) 상품 목록
      const products = await getProducts(vendorId, accessKey, secretKey);

      // 2) 판매 데이터 30일치
      const salesData = await getSalesLast30Days(vendorId, accessKey, secretKey);

      // 3) 로켓그로스 재고 조회 (5개씩 병렬 처리)
      for (let i = 0; i < products.length; i += 5) {
        await Promise.all(products.slice(i, i + 5).map(async (p) => {
          try {
            // 🚀 로켓그로스 재고: vendor items API 사용
            p.coupangStock = await getRocketGrowthInventory(vendorId, p.vendorItemId, accessKey, secretKey);
          } catch (e) {
            console.error(`재고 조회 실패 (${p.vendorItemId}):`, e.message);
            p.coupangStock = 0;
          }
        }));
        if (i + 5 < products.length) await new Promise(r => setTimeout(r, 300));
      }

      // 4) 판매 데이터 + 계산값 병합
      for (const p of products) {
        const sales = salesData[p.vendorItemId] || new Array(30).fill(0);
        p.sales30 = sales;
        p.dailyAvg = sales.reduce((a, b) => a + b, 0) / 30;
        p.coupangDepletionDays = calcDepletionDays(p.coupangStock, p.dailyAvg);
        p.totalDepletionDays = calcDepletionDays(
          p.coupangStock + p.warehouseStock,
          p.dailyAvg
        );
        p.lastUpdated = new Date().toISOString();
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, data: products, syncedAt: new Date().toISOString() })
      };
    }

    // ── 단일 로켓그로스 재고 조회
    if (action === 'inventory') {
      const { vendorItemId } = params;
      if (!vendorItemId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'vendorItemId가 필요합니다.' }) };
      }
      const qty = await getRocketGrowthInventory(vendorId, vendorItemId, accessKey, secretKey);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, vendorItemId, quantity: qty })
      };
    }

    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: `알 수 없는 action: ${action}` })
    };

  } catch (error) {
    console.error('서버 오류:', error);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: '서버 오류: ' + error.message })
    };
  }
};
