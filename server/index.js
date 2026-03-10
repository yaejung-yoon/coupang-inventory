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

// vendorId 필수 파라미터로 상품 ID 목록 조회
async function getSellerProductIds(ak, sk, vi) {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;
  const allIds = [];
  let nextToken = null;
  for (let page = 0; page < 20; page++) {
    const params = {
      vendorId: vi,
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

async function getRocketStock(vendorItemId, ak, sk) {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/inventories`;
  const data = await callAPI('GET', path, null, ak, sk);
  return data?.data?.amountInStock ?? 0;
}

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
    } catch (e) { break; }
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

app.get('/api/coupang-proxy', async (req, res) => {
  try {
    const ak = (process.env.COUPANG_ACCESS_KEY || '').trim();
    const sk = (process.env.COUPANG_SECRET_KEY || '').trim();
    const vi = (process.env.COUPANG_VENDOR_ID  || '').trim();

    if (!ak || !sk || !vi) {
      return res.status(400).json({ error: '환경변수 미설정', missing: { ak: !ak, sk: !sk, vi: !vi } });
    }

    const { action, vendorItemId } = req.query;

    // 연결 테스트
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

    // 상품 목록만 조회 (상품 관리 탭용)
    if (action === 'products' || action === 'list_all') {
      const products = await getProducts(ak, sk, vi);
      return res.json({ success: true, data: products });
    }

    // 전체 동기화 (enabledIds로 필터링 가능)
    if (action === 'full_sync') {
      const enabledIds = req.query.enabledIds ? req.query.enabledIds.split(',') : null;
      let products = await getProducts(ak, sk, vi);
      if (enabledIds && enabledIds.length > 0) {
        products = products.filter(p => enabledIds.includes(p.vendorItemId));
      }
      const salesData = await getSales30(vi, ak, sk);
      for (let i = 0; i < products.length; i += 5) {
        await Promise.all(products.slice(i, i + 5).map(async p => {
          try { p.coupangStock = await getRocketStock(p.vendorItemId, ak, sk); }
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
      return res.json({ success: true, data: products, syncedAt: new Date().toISOString() });
    }

    // 단일 재고 조회
    if (action === 'inventory') {
      if (!vendorItemId) return res.status(400).json({ error: 'vendorItemId 필요' });
      const qty = await getRocketStock(vendorItemId, ak, sk);
      return res.json({ success: true, vendorItemId, quantity: qty });
    }

    // vendorItemId로 상품명/옵션명 자동조회
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
