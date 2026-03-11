import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = 'https://api-gateway.coupang.com';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../dist')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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

  // ✅ ? 없이 바로 붙임 (공식 PHP 예제 기준)
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
  const query = entries.map(([k, v]) => `${k}=${v}`).join('&');

  const authorization = generateAuth(method, path, query, accessKey, secretKey);
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

function formatDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

async function getSellerProductIds(ak, sk, vi) {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;
  const allIds = [];
  let nextToken = null;
  for (let page = 0; page < 20; page++) {
    const params = { vendorId: vi, maxPerPage: 100, status: 'APPROVED', ...(nextToken ? { nextToken } : {}) };
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

async function getProductDetail(sellerProductId, ak, sk) {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`;
  const data = await callAPI('GET', path, null, ak, sk);
  return data?.data;
}

async function getProducts(ak, sk, vi) {
  const ids = await getSellerProductIds(ak, sk, vi);
  const products = [];
  for (let i = 0; i < ids.length; i += 3) {
    const details = await Promise.all(
      ids.slice(i, i + 3).map(id =>
        getProductDetail(id, ak, sk).catch(e => {
          console.error(`상품상세 실패(${id}):`, e.message); return null;
        })
      )
    );
    for (const p of details) {
      if (!p) continue;
      for (const item of (p.items || [])) {
        products.push({
          id: String(item.rocketGrowthItemData?.vendorItemId || item.vendorItemId),
          productId: String(p.sellerProductId),
          name: p.sellerProductName || '상품명 없음',
          option: item.itemName || '기본',
          vendorItemId: String(item.rocketGrowthItemData?.vendorItemId || item.vendorItemId),
          marketplaceVendorItemId: String(item.marketplaceItemData?.vendorItemId || ''),
          coupangStock: 0, warehouseStock: 0,
          sales30: new Array(30).fill(0),
          dailyAvg: 0, coupangDepletionDays: 999, totalDepletionDays: 999,
          lastUpdated: new Date().toISOString(),
        });
      }
    }
    if (i + 3 < ids.length) await new Promise(r => setTimeout(r, 300));
  }
  console.log(`[상품목록] 총 ${products.length}개`);
  return products;
}

// 로켓창고 재고 + 30일 판매량 통합 조회
async function getRGInventorySummaries(ak, sk, vi) {
  const apiPath = `/v2/providers/rg_open_api/apis/api/v1/vendors/${vi}/rg/inventory/summaries`;
  const result = {}; // { vendorItemId: { stock, sales30total } }
  let nextToken = null;

  for (let page = 0; page < 50; page++) {
    const params = { ...(nextToken ? { nextToken } : {}) };
    const data = await callAPI('GET', apiPath, Object.keys(params).length ? params : null, ak, sk);
    const items = data?.data || [];
    for (const item of items) {
      const vid = String(item.vendorItemId);
      result[vid] = {
        stock: item.inventoryDetails?.totalOrderableQuantity ?? 0,
        sales30total: item.salesCountMap?.SALES_COUNT_LAST_THIRTY_DAYS ?? 0,
      };
    }
    nextToken = data?.nextToken;
    if (!nextToken || items.length === 0) break;
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`[재고+판매량] 총 ${Object.keys(result).length}개 옵션`);
  return result;
}

async function getRocketStock(vendorItemId, ak, sk) {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/inventories`;
  const data = await callAPI('GET', path, null, ak, sk);
  console.log(`[재고 ${vendorItemId}]`, JSON.stringify(data?.data));
  return data?.data?.amountInStock ?? 0;
}

async function getSales30(vendorId, ak, sk) {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 30);
  const apiPath = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets`;
  let orders = [], nextToken = null;
  for (let i = 0; i < 10; i++) {
    const params = {
      createdAtFrom: formatDate(from), createdAtTo: formatDate(today),
      status: 'ACCEPT', limit: 100,
      ...(nextToken ? { nextToken } : {}),
    };
    try {
      const data = await callAPI('GET', apiPath, params, ak, sk);
      // 응답 구조: data.data 가 배열로 바로 옴
      const batch = Array.isArray(data?.data) ? data.data
                  : Array.isArray(data?.data?.ordersheets) ? data.data.ordersheets
                  : [];
      if (batch.length > 0) {
  
        orders = orders.concat(batch);
      }
      nextToken = data?.data?.nextToken || data?.nextToken;
      if (!nextToken || batch.length === 0) break;
      await new Promise(r => setTimeout(r, 200));
    } catch (e) { console.error('[판매량 조회 오류]', e.message); break; }
  }
  console.log(`[판매량] 총 ${orders.length}개 주문`);
  const byItem = {};
  for (const order of orders) {
    const items = order.orderItems || order.items || [];
    for (const item of items) {
      // vendorItemId 우선 사용 (vendorItemPackageId는 0일 수 있어서 제외)
      const id = String(item.vendorItemId || '');
      if (!id || id === 'undefined' || id === '0' || id === '') continue;
      const daysAgo = Math.floor((today - new Date(order.orderedAt)) / 86400000);
      if (daysAgo < 0 || daysAgo >= 30) continue;
      if (!byItem[id]) byItem[id] = new Array(30).fill(0);
      byItem[id][29 - daysAgo] += item.shippingCount || item.quantity || 1;
    }
  }
  console.log(`[판매량] 집계된 옵션 수: ${Object.keys(byItem).length}개`);
  return byItem;
}

const depletion = (stock, avg) => (!avg || avg <= 0) ? 999 : Math.floor(stock / avg);

app.get('/api/coupang-proxy', async (req, res) => {
  try {
    const ak = (process.env.COUPANG_ACCESS_KEY || '').trim();
    const sk = (process.env.COUPANG_SECRET_KEY || '').trim();
    const vi = (process.env.COUPANG_VENDOR_ID  || '').trim();

    if (!ak || !sk || !vi) {
      return res.status(400).json({ error: '환경변수 미설정', missing: { ak: !ak, sk: !sk, vi: !vi } });
    }

    const { action, vendorItemId } = req.query;

    if (action === 'test') {
      try {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        const path = `/v2/providers/openapi/apis/api/v4/vendors/${vi}/ordersheets`;
        await callAPI('GET', path, {
          createdAtFrom: formatDate(yesterday),
          createdAtTo: formatDate(today),
          status: 'ACCEPT', limit: 1,
        }, ak, sk);
        return res.json({ success: true, message: '쿠팡 API 연결 성공! ✅' });
      } catch (e) {
        if (e.message.includes('404')) return res.json({ success: true, message: '쿠팡 API 연결 성공! ✅' });
        return res.json({ success: false, message: '연결 실패: ' + e.message });
      }
    }

    if (action === 'products') {
      const products = await getProducts(ak, sk, vi);
      return res.json({ success: true, data: products });
    }

    // 상품 관리용: 재고/판매 없이 목록만 빠르게
    if (action === 'list_all') {
      const products = await getProducts(ak, sk, vi);
      return res.json({ success: true, data: products });
    }

    if (action === 'full_sync') {
      const enabledIds = req.query.enabledIds ? req.query.enabledIds.split(',') : null;
      let products = await getProducts(ak, sk, vi);
      if (enabledIds && enabledIds.length > 0) {
        products = products.filter(p => enabledIds.includes(p.vendorItemId));
      }
      // 로켓창고 API로 재고 + 30일 판매량 한번에 조회
      const rgData = await getRGInventorySummaries(ak, sk, vi);
      for (const p of products) {
        const d = rgData[p.vendorItemId] || { stock: 0, sales30total: 0 };
        p.coupangStock = d.stock;
        // 30일 판매량을 균등 분배 (일별 배열로 변환)
        const dailyAvg = d.sales30total / 30;
        p.sales30  = new Array(30).fill(Math.round(dailyAvg * 10) / 10);
        p.dailyAvg = dailyAvg;
        p.coupangDepletionDays = depletion(p.coupangStock, p.dailyAvg);
        p.totalDepletionDays   = depletion(p.coupangStock + p.warehouseStock, p.dailyAvg);
        p.lastUpdated = new Date().toISOString();
      }
      return res.json({ success: true, data: products, syncedAt: new Date().toISOString() });
    }

    if (action === 'inventory') {
      if (!vendorItemId) return res.status(400).json({ error: 'vendorItemId 필요' });
      const qty = await getRocketStock(vendorItemId, ak, sk);
      return res.json({ success: true, vendorItemId, quantity: qty });
    }

    // vendorItemId로 상품명/옵션명 조회
    if (action === 'item_info') {
      if (!vendorItemId) return res.status(400).json({ error: 'vendorItemId 필요' });
      const ids = await getSellerProductIds(ak, sk, vi);
      for (let i = 0; i < ids.length; i += 10) {
        const batch = ids.slice(i, i + 10);
        const details = await Promise.all(
          batch.map(id => getProductDetail(id, ak, sk).catch(() => null))
        );
        for (const p of details) {
          if (!p) continue;
          for (const item of (p.items || [])) {
            const vid = String(item.rocketGrowthItemData?.vendorItemId);
            if (vid === String(vendorItemId)) {
              return res.json({
                success: true,
                vendorItemId: vid,
                name: p.sellerProductName || '상품명 없음',
                option: item.itemName || '기본',
              });
            }
          }
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return res.json({ success: false, error: '해당 옵션 ID를 찾을 수 없어요' });
    }

    return res.status(400).json({ error: `알 수 없는 action: ${action}` });

  } catch (err) {
    console.error('서버오류:', err);
    return res.status(500).json({ error: '서버 오류: ' + err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ 서버 실행중: http://localhost:${PORT}`);
});
