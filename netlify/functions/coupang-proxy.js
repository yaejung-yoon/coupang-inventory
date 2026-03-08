// ============================================================
// 쿠팡 API 프록시 함수 (Netlify Function)
// 역할: 브라우저 대신 서버에서 쿠팡 API를 호출하고 결과를 반환
// ============================================================

import crypto from 'crypto';

const BASE_URL = 'https://api-gateway.coupang.com';

// ─────────────────────────────────────────────
// 쿠팡 API 인증 서명 생성
// 쿠팡 API는 HMAC-SHA256 방식으로 서명을 요구합니다
// ─────────────────────────────────────────────
function generateCoupangAuth(method, path, queryString, accessKey, secretKey) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');

  // 날짜 형식: yyMMddTHHmmssZ
  const yy = String(now.getUTCFullYear()).slice(2);
  const MM = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const HH = pad(now.getUTCHours());
  const mm = pad(now.getUTCMinutes());
  const ss = pad(now.getUTCSeconds());
  const datetime = `${yy}${MM}${dd}T${HH}${mm}${ss}Z`;

  // 서명할 문자열 조합
  const message = datetime + method + path + (queryString ? '?' + queryString : '');

  // HMAC-SHA256 서명
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(message)
    .digest('hex');

  const authorization = `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;

  return { authorization, datetime };
}

// ─────────────────────────────────────────────
// 쿠팡 API 호출 공통 함수
// ─────────────────────────────────────────────
async function callCoupangAPI(method, path, queryString, accessKey, secretKey) {
  const { authorization } = generateCoupangAuth(method, path, queryString, accessKey, secretKey);

  const url = `${BASE_URL}${path}${queryString ? '?' + queryString : ''}`;

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': authorization,
      'Content-Type': 'application/json;charset=UTF-8',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`쿠팡 API 오류 (${response.status}): ${errorText}`);
  }

  return response.json();
}

// ─────────────────────────────────────────────
// 날짜 포맷 유틸리티 (쿠팡 API 날짜 형식)
// ─────────────────────────────────────────────
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}T00:00:00`;
}

// ─────────────────────────────────────────────
// 상품 목록 가져오기
// ─────────────────────────────────────────────
async function getProducts(vendorId, accessKey, secretKey) {
  const path = `/v2/providers/seller_api/apis/api/v1/vendor/${vendorId}/products`;
  const queryString = `nextToken=&maxPerPage=100&status=APPROVED`;

  const data = await callCoupangAPI('GET', path, queryString, accessKey, secretKey);

  // 상품 데이터를 앱에서 사용하기 편한 형태로 변환
  const products = [];

  if (data?.data) {
    for (const product of data.data) {
      for (const vendorItem of (product.vendorItems || [])) {
        products.push({
          id: String(vendorItem.vendorItemId),
          productId: String(product.sellerProductId),
          name: product.sellerProductName || '상품명 없음',
          option: [
            vendorItem.optionName1 || '',
            vendorItem.optionName2 || '',
            vendorItem.optionName3 || '',
          ].filter(Boolean).join(' / ') || '기본',
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

// ─────────────────────────────────────────────
// 특정 vendorItemId의 재고 가져오기
// ─────────────────────────────────────────────
async function getInventory(vendorItemId, accessKey, secretKey) {
  const path = `/v2/providers/seller_api/apis/api/v1/vendor-items/${vendorItemId}/inventories`;

  const data = await callCoupangAPI('GET', path, '', accessKey, secretKey);

  // 총 재고 수량 계산 (입고된 재고 합산)
  let totalQty = 0;
  if (data?.data) {
    const inventories = Array.isArray(data.data) ? data.data : [data.data];
    for (const inv of inventories) {
      totalQty += inv.quantity || 0;
    }
  }

  return totalQty;
}

// ─────────────────────────────────────────────
// 최근 30일 판매 데이터 가져오기
// ─────────────────────────────────────────────
async function getSalesLast30Days(vendorId, accessKey, secretKey) {
  const salesByItemId = {}; // { vendorItemId: [일별 판매량 배열(30개)] }

  // 30일치 날짜 범위 계산
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 30);

  const createdAtFrom = formatDate(thirtyDaysAgo);
  const createdAtTo = formatDate(today);

  // 주문 목록 가져오기 (확정 주문만)
  const path = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets`;
  const queryString = `createdAtFrom=${encodeURIComponent(createdAtFrom)}&createdAtTo=${encodeURIComponent(createdAtTo)}&status=ACCEPT&limit=100`;

  let allOrders = [];
  let nextToken = null;

  // 페이징 처리 (최대 10페이지)
  for (let page = 0; page < 10; page++) {
    const q = nextToken
      ? queryString + `&nextToken=${encodeURIComponent(nextToken)}`
      : queryString;

    const data = await callCoupangAPI('GET', path, q, accessKey, secretKey);

    if (data?.data?.ordersheets) {
      allOrders = allOrders.concat(data.data.ordersheets);
    }

    nextToken = data?.data?.nextToken;
    if (!nextToken) break;

    // API 과부하 방지 딜레이
    await new Promise(r => setTimeout(r, 200));
  }

  // 일별 판매량 집계
  for (const order of allOrders) {
    for (const item of (order.orderItems || [])) {
      const itemId = String(item.vendorItemId);
      const orderDate = new Date(order.orderedAt);

      // 주문일이 30일 이내인지 확인
      const daysAgo = Math.floor((today - orderDate) / (1000 * 60 * 60 * 24));
      if (daysAgo < 0 || daysAgo >= 30) continue;

      if (!salesByItemId[itemId]) {
        salesByItemId[itemId] = new Array(30).fill(0);
      }

      // daysAgo=0이면 오늘(index 29), daysAgo=29이면 30일 전(index 0)
      const dayIndex = 29 - daysAgo;
      salesByItemId[itemId][dayIndex] += item.quantity || 1;
    }
  }

  return salesByItemId;
}

// ─────────────────────────────────────────────
// 소진일 계산
// ─────────────────────────────────────────────
function calcDepletionDays(stock, dailyAvg) {
  if (dailyAvg <= 0) return 999;
  return Math.floor(stock / dailyAvg);
}

// ─────────────────────────────────────────────
// Netlify Function 진입점
// ─────────────────────────────────────────────
export const handler = async (event) => {
  // CORS 헤더 설정
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // OPTIONS 요청 처리 (CORS preflight)
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // 환경변수에서 API 키 읽기 (Netlify 대시보드에서 설정)
    const accessKey = process.env.COUPANG_ACCESS_KEY;
    const secretKey = process.env.COUPANG_SECRET_KEY;
    const vendorId = process.env.COUPANG_VENDOR_ID;

    if (!accessKey || !secretKey || !vendorId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'API 키가 설정되지 않았습니다. Netlify 환경변수를 확인해주세요.',
          missingKeys: {
            COUPANG_ACCESS_KEY: !accessKey,
            COUPANG_SECRET_KEY: !secretKey,
            COUPANG_VENDOR_ID: !vendorId,
          }
        })
      };
    }

    // URL에서 action 파라미터 읽기
    const params = event.queryStringParameters || {};
    const action = params.action;

    // ── action: products ─ 상품 목록 가져오기
    if (action === 'products') {
      const products = await getProducts(vendorId, accessKey, secretKey);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, data: products })
      };
    }

    // ── action: full_sync ─ 전체 동기화 (재고 + 판매량)
    if (action === 'full_sync') {
      // 1) 상품 목록
      const products = await getProducts(vendorId, accessKey, secretKey);

      // 2) 판매 데이터 (30일치)
      const salesData = await getSalesLast30Days(vendorId, accessKey, secretKey);

      // 3) 각 상품 재고 조회 (병렬 처리, 최대 5개씩)
      const BATCH_SIZE = 5;
      for (let i = 0; i < products.length; i += BATCH_SIZE) {
        const batch = products.slice(i, i + BATCH_SIZE);
        await Promise.all(
          batch.map(async (product) => {
            try {
              product.coupangStock = await getInventory(product.vendorItemId, accessKey, secretKey);
            } catch (e) {
              console.error(`재고 조회 실패 (${product.vendorItemId}):`, e.message);
              product.coupangStock = 0;
            }
          })
        );
        // API 과부하 방지
        if (i + BATCH_SIZE < products.length) {
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // 4) 판매 데이터 + 계산 값 병합
      for (const product of products) {
        const sales = salesData[product.vendorItemId] || new Array(30).fill(0);
        product.sales30 = sales;

        const totalSales = sales.reduce((a, b) => a + b, 0);
        product.dailyAvg = totalSales / 30;

        product.coupangDepletionDays = calcDepletionDays(product.coupangStock, product.dailyAvg);
        product.totalDepletionDays = calcDepletionDays(
          product.coupangStock + product.warehouseStock,
          product.dailyAvg
        );
        product.lastUpdated = new Date().toISOString();
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, data: products, syncedAt: new Date().toISOString() })
      };
    }

    // ── action: inventory ─ 단일 아이템 재고 조회
    if (action === 'inventory') {
      const { vendorItemId } = params;
      if (!vendorItemId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'vendorItemId가 필요합니다.' }) };
      }
      const qty = await getInventory(vendorItemId, accessKey, secretKey);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, vendorItemId, quantity: qty })
      };
    }

    // ── action: test ─ API 연결 테스트
    if (action === 'test') {
      try {
        const path = `/v2/providers/seller_api/apis/api/v1/vendor/${vendorId}/products`;
        await callCoupangAPI('GET', path, 'nextToken=&maxPerPage=1&status=APPROVED', accessKey, secretKey);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, message: '쿠팡 API 연결 성공!' })
        };
      } catch (e) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: false, message: `연결 실패: ${e.message}` })
        };
      }
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: `알 수 없는 action: ${action}. 사용 가능: products, full_sync, inventory, test` })
    };

  } catch (error) {
    console.error('서버 오류:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: '서버 내부 오류: ' + error.message })
    };
  }
};
