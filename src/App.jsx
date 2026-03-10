import { useState, useEffect, useCallback, useRef } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';

// ──────────────────────────────────────────────
// 계산 유틸리티
// ──────────────────────────────────────────────
const calcDailyAvg = (sales30) =>
  sales30.reduce((a, b) => a + b, 0) / 30;

const calcDepletionDays = (stock, dailyAvg) => {
  if (!dailyAvg || dailyAvg <= 0) return 999;
  return Math.floor(stock / dailyAvg);
};

const calcRestockQty = (dailyAvg, currentStock, targetDays) =>
  Math.max(0, Math.ceil(dailyAvg * targetDays) - currentStock);

function getStatus(days) {
  if (days <= 15) return { label: '⚠️ 긴급', color: '#EF4444', bg: '#2D1515', border: '#EF4444' };
  if (days <= 20) return { label: '🔶 입고필요', color: '#F97316', bg: '#2D1A0A', border: '#F97316' };
  if (days <= 50) return { label: '📦 모니터링', color: '#FBBF24', bg: '#2D2200', border: '#FBBF24' };
  if (days <= 60) return { label: '🔵 여유', color: '#60A5FA', bg: '#0D1E3A', border: '#3B82F6' };
  return { label: '✅ 안전', color: '#34D399', bg: '#0D2E1A', border: '#10B981' };
}

// ──────────────────────────────────────────────
// 샘플 데이터 (API 연결 전 시연용)
// ──────────────────────────────────────────────
const DEMO_PRODUCTS = [
  { id: 'demo-1', name: '스킨케어 세트 A', option: '50ml / 화이트닝', vendorItemId: 'DEMO001', coupangStock: 120, warehouseStock: 200, sales30: [12,10,15,8,11,14,9,13,10,12,11,15,8,10,14,12,9,11,13,10,12,15,8,11,14,9,13,10,12,11], lastUpdated: new Date().toISOString() },
  { id: 'demo-2', name: '스킨케어 세트 A', option: '100ml / 화이트닝', vendorItemId: 'DEMO002', coupangStock: 35, warehouseStock: 80, sales30: [8,9,10,8,9,11,8,10,9,8,10,9,11,8,9,10,8,9,10,8,9,11,8,10,9,8,10,9,11,8], lastUpdated: new Date().toISOString() },
  { id: 'demo-3', name: '모이스처라이저 B', option: '기본 / 청정해제', vendorItemId: 'DEMO003', coupangStock: 18, warehouseStock: 30, sales30: [5,6,5,7,6,5,6,7,5,6,5,7,6,5,6,5,7,6,5,6,7,5,6,5,7,6,5,6,7,5], lastUpdated: new Date().toISOString() },
  { id: 'demo-4', name: '모이스처라이저 B', option: '대용량 / 청정해제', vendorItemId: 'DEMO004', coupangStock: 8, warehouseStock: 15, sales30: [3,4,3,4,3,4,3,4,3,4,3,4,3,4,3,4,3,4,3,4,3,4,3,4,3,4,3,4,3,4], lastUpdated: new Date().toISOString() },
  { id: 'demo-5', name: '선크림 C', option: 'SPF50+ / 일반', vendorItemId: 'DEMO005', coupangStock: 250, warehouseStock: 500, sales30: [20,22,25,18,21,24,20,22,25,18,21,24,20,22,25,18,21,24,20,22,25,18,21,24,20,22,25,18,21,24], lastUpdated: new Date().toISOString() },
  { id: 'demo-6', name: '선크림 C', option: 'SPF50+ / 무기자차', vendorItemId: 'DEMO006', coupangStock: 12, warehouseStock: 20, sales30: [7,8,7,8,7,8,7,8,7,8,7,8,7,8,7,8,7,8,7,8,7,8,7,8,7,8,7,8,7,8], lastUpdated: new Date().toISOString() },
];

function enrichProducts(rawProducts) {
  return rawProducts.map(p => {
    const dailyAvg = calcDailyAvg(p.sales30);
    const coupangDepletionDays = calcDepletionDays(p.coupangStock, dailyAvg);
    const totalDepletionDays = calcDepletionDays(p.coupangStock + p.warehouseStock, dailyAvg);
    return { ...p, dailyAvg, coupangDepletionDays, totalDepletionDays };
  });
}

// ──────────────────────────────────────────────
// API 호출 함수들
// ──────────────────────────────────────────────
const api = {
  test: () => fetch('/api/coupang-proxy?action=test').then(r => r.json()),
  fullSync: () => fetch('/api/coupang-proxy?action=full_sync').then(r => r.json()),
  addItem: (vendorItemId) => fetch(`/api/coupang-proxy?action=inventory&vendorItemId=${vendorItemId}`).then(r => r.json()),
  itemInfo: (vendorItemId) => fetch(`/api/coupang-proxy?action=item_info&vendorItemId=${vendorItemId}`).then(r => r.json()),
  listAll: () => fetch('/api/coupang-proxy?action=list_all').then(r => r.json()),
  fullSyncFiltered: (enabledIds) => fetch(`/api/coupang-proxy?action=full_sync&enabledIds=${enabledIds.join(',')}`).then(r => r.json()),
};

// ──────────────────────────────────────────────
// 컴포넌트: 상태 배지
// ──────────────────────────────────────────────
function StatusBadge({ days }) {
  const s = getStatus(days);
  return (
    <span style={{
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
      borderRadius: 6, padding: '2px 10px', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap'
    }}>{days >= 999 ? '∞' : `${days}일`} {s.label}</span>
  );
}

// ──────────────────────────────────────────────
// 컴포넌트: 카드
// ──────────────────────────────────────────────
function Card({ children, style }) {
  return (
    <div style={{
      background: 'linear-gradient(135deg, #141F2E, #1A2740)',
      border: '1px solid #1E3A5F', borderRadius: 14, ...style
    }}>{children}</div>
  );
}

// ──────────────────────────────────────────────
// 메인 앱
// ──────────────────────────────────────────────
export default function App() {
  const [products, setProducts] = useState(enrichProducts(DEMO_PRODUCTS));
  const [isDemo, setIsDemo] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');
  const [lastSync, setLastSync] = useState(null);
  const [tab, setTab] = useState('dashboard');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [warehouseEdits, setWarehouseEdits] = useState({});
  const [warehouseData, setWarehouseData] = useState({});
  const [autoSyncInterval, setAutoSyncInterval] = useState(null);
  const intervalRef = useRef(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newItemId, setNewItemId] = useState('');
  const [newItemName, setNewItemName] = useState('');
  const [newItemOption, setNewItemOption] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState('');
  const [infoLoading, setInfoLoading] = useState(false);
  const [allProducts, setAllProducts] = useState([]); // 상품 관리용 전체 목록
  const [enabledIds, setEnabledIds] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('enabledIds') || 'null') || []); }
    catch { return new Set(); }
  });
  const [listLoading, setListLoading] = useState(false);

  const lookupItemInfo = async (vid) => {
    if (!vid || vid.length < 5) return;
    setInfoLoading(true);
    setAddError('');
    try {
      const result = await api.itemInfo(vid.trim());
      if (result.success) {
        setNewItemName(result.name);
        setNewItemOption(result.option);
      } else {
        setAddError('자동조회 실패: ' + (result.error || '옵션 ID를 확인해주세요'));
      }
    } catch (e) {
      setAddError('조회 오류: ' + e.message);
    } finally {
      setInfoLoading(false);
    }
  };

  // API 연결 테스트
  const testConnection = async () => {
    setLoading(true);
    setSyncStatus('API 연결 테스트 중...');
    try {
      const result = await api.test();
      if (result.success) {
        setIsConnected(true);
        setSyncStatus('✅ API 연결 성공!');
        return true;
      } else {
        setSyncStatus('❌ 연결 실패: ' + result.message);
        return false;
      }
    } catch (e) {
      setSyncStatus('❌ 서버 오류: ' + e.message);
      return false;
    } finally {
      setLoading(false);
    }
  };

  // 전체 동기화
  const fullSync = useCallback(async () => {
    setLoading(true);
    setSyncStatus('쿠팡 API에서 데이터 가져오는 중...');
    try {
      const ids = enabledIds.size > 0 ? [...enabledIds] : null;
      const result = ids ? await api.fullSyncFiltered(ids) : await api.fullSync();
      if (result.success) {
        // API 데이터에 창고 재고 병합
        const merged = result.data.map(p => ({
          ...p,
          warehouseStock: warehouseData[p.vendorItemId] || p.warehouseStock || 0,
        }));
        setProducts(enrichProducts(merged));
        setIsDemo(false);
        setLastSync(new Date());
        setSyncStatus(`✅ 동기화 완료 (${merged.length}개 옵션)`);
      } else {
        setSyncStatus('❌ 동기화 실패: ' + (result.error || '알 수 없는 오류'));
      }
    } catch (e) {
      setSyncStatus('❌ 오류: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, [warehouseData, enabledIds]);

  // 자동 동기화 (5분마다)
  const toggleAutoSync = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      setAutoSyncInterval(null);
    } else {
      const id = setInterval(() => { fullSync(); }, 5 * 60 * 1000);
      intervalRef.current = id;
      setAutoSyncInterval(id);
    }
  };

  // 상품 삭제
  const deleteProduct = (productId) => {
    if (!window.confirm('이 상품을 목록에서 삭제할까요?')) return;
    setProducts(prev => prev.filter(p => p.id !== productId));
  };

  // 상품 추가 (vendorItemId로)
  const addProductById = async () => {
    const vid = newItemId.trim();
    if (!vid) { setAddError('옵션 ID를 입력해주세요'); return; }
    setAddLoading(true);
    setAddError('');
    try {
      const result = await api.addItem(vid);
      if (!result.success) { setAddError('조회 실패: ' + result.error); return; }
      const exists = products.find(p => p.vendorItemId === vid);
      if (exists) { setAddError('이미 목록에 있는 옵션 ID예요'); return; }
      const newProduct = enrichProducts([{
        id: vid,
        productId: vid,
        name: newItemName || `상품 (${vid})`,
        option: newItemOption || '기본',
        vendorItemId: vid,
        coupangStock: result.quantity || 0,
        warehouseStock: 0,
        sales30: new Array(30).fill(0),
        dailyAvg: 0,
        coupangDepletionDays: 999,
        totalDepletionDays: 999,
        lastUpdated: new Date().toISOString(),
      }])[0];
      setProducts(prev => [...prev, newProduct]);
      setShowAddModal(false);
      setNewItemId(''); setNewItemName(''); setNewItemOption('');
    } catch (e) {
      setAddError('오류: ' + e.message);
    } finally {
      setAddLoading(false);
    }
  };

  // 창고 재고 수정
  const saveWarehouseStock = (productId, vendorItemId) => {
    const val = parseInt(warehouseEdits[productId]);
    if (isNaN(val) || val < 0) return;
    const newWarehouseData = { ...warehouseData, [vendorItemId]: val };
    setWarehouseData(newWarehouseData);
    setProducts(prev => enrichProducts(prev.map(p =>
      p.id === productId ? { ...p, warehouseStock: val } : p
    )));
    setWarehouseEdits(prev => { const n = { ...prev }; delete n[productId]; return n; });
  };

  // 통계
  const urgent = products.filter(p => p.coupangDepletionDays <= 20);
  const purchaseNeeded = products.filter(p => p.totalDepletionDays < 60);
  const totalCoupang = products.reduce((a, p) => a + p.coupangStock, 0);
  const totalWarehouse = products.reduce((a, p) => a + p.warehouseStock, 0);

  // 판매량 차트 데이터
  const chartData = selectedProduct
    ? selectedProduct.sales30.map((qty, i) => {
        const d = new Date(); d.setDate(d.getDate() - (29 - i));
        return { date: `${d.getMonth()+1}/${d.getDate()}`, qty };
      })
    : [];

  const TabBtn = ({ id, label }) => (
    <button onClick={() => setTab(id)} style={{
      background: 'none', border: 'none',
      borderBottom: tab === id ? '2px solid #E4412A' : '2px solid transparent',
      color: tab === id ? '#fff' : '#64829B',
      padding: '12px 18px', fontWeight: tab === id ? 700 : 500,
      fontSize: 14, cursor: 'pointer', transition: 'all 0.15s',
      fontFamily: 'Noto Sans KR, sans-serif'
    }}>{label}</button>
  );

  return (
    <div style={{ fontFamily: "'Noto Sans KR', sans-serif", background: '#0F1923', minHeight: '100vh', color: '#E8EDF2' }}>

      {/* ─── 상품 추가 모달 ─── */}
      {showAddModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#141F2E', border: '1px solid #1E3A5F', borderRadius: 16, padding: 28, width: 420, maxWidth: '90vw' }}>
            <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 20, color: '#E2E8F0' }}>➕ 상품 직접 추가</div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: '#64829B', fontWeight: 600, marginBottom: 6 }}>옵션 ID (Vendor Item ID) <span style={{ color: '#EF4444' }}>*필수</span></div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={newItemId} onChange={e => setNewItemId(e.target.value)}
                  placeholder="예: 91221573088"
                  style={{ flex: 1, background: '#0D1520', border: '1px solid #1E3A5F', borderRadius: 8, padding: '10px 14px', color: '#E2E8F0', fontSize: 14, fontFamily: 'Noto Sans KR', boxSizing: 'border-box' }} />
                <button onClick={() => lookupItemInfo(newItemId)} disabled={infoLoading || !newItemId}
                  style={{ background: infoLoading ? '#1E3A5F' : '#1E3A5F', color: '#60A5FA', border: '1px solid #3B82F6', borderRadius: 8, padding: '10px 14px', fontSize: 12, fontWeight: 700, cursor: infoLoading ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', fontFamily: 'Noto Sans KR' }}>
                  {infoLoading ? '⏳' : '🔍 자동조회'}
                </button>
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: '#64829B', fontWeight: 600, marginBottom: 6 }}>상품명 (선택)</div>
              <input value={newItemName} onChange={e => setNewItemName(e.target.value)}
                placeholder="예: 머치온탑 캣타워"
                style={{ width: '100%', background: '#0D1520', border: '1px solid #1E3A5F', borderRadius: 8, padding: '10px 14px', color: '#E2E8F0', fontSize: 14, fontFamily: 'Noto Sans KR', boxSizing: 'border-box' }} />
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: '#64829B', fontWeight: 600, marginBottom: 6 }}>옵션명 (선택)</div>
              <input value={newItemOption} onChange={e => setNewItemOption(e.target.value)}
                placeholder="예: XL 브라운"
                style={{ width: '100%', background: '#0D1520', border: '1px solid #1E3A5F', borderRadius: 8, padding: '10px 14px', color: '#E2E8F0', fontSize: 14, fontFamily: 'Noto Sans KR', boxSizing: 'border-box' }} />
            </div>

            {addError && <div style={{ color: '#EF4444', fontSize: 13, marginBottom: 14, background: '#2D1515', padding: '8px 12px', borderRadius: 8 }}>{addError}</div>}

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={addProductById} disabled={addLoading}
                style={{ flex: 1, background: addLoading ? '#1E3A5F' : 'linear-gradient(135deg, #10B981, #059669)', color: '#fff', border: 'none', borderRadius: 8, padding: '11px', fontWeight: 700, fontSize: 14, cursor: addLoading ? 'not-allowed' : 'pointer', fontFamily: 'Noto Sans KR' }}>
                {addLoading ? '⏳ 조회 중...' : '✅ 추가하기'}
              </button>
              <button onClick={() => { setShowAddModal(false); setNewItemId(''); setNewItemName(''); setNewItemOption(''); setAddError(''); }}
                style={{ background: '#1E3A5F', color: '#94A3B8', border: 'none', borderRadius: 8, padding: '11px 20px', fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'Noto Sans KR' }}>
                취소
              </button>
            </div>

            <div style={{ marginTop: 14, fontSize: 12, color: '#64829B', lineHeight: 1.8 }}>
              💡 옵션 ID는 쿠팡 WING → 로켓그로스 → 상품 상세에서 확인하거나,<br/>
              동기화 후 <b style={{ color: '#60A5FA' }}>쿠팡 창고 재고 탭</b>의 Vendor Item ID 열에서 복사하세요.
            </div>
          </div>
        </div>
      )}

      {/* ─── HEADER ─── */}
      <div style={{ background: 'linear-gradient(180deg, #0A1420 0%, #0F1923 100%)', borderBottom: '1px solid #1E3A5F' }}>
        <div style={{ maxWidth: 1400, margin: '0 auto', padding: '0 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 64 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ background: 'linear-gradient(135deg, #E4412A, #FF6B4A)', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 18, color: '#fff' }}>C</div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 17, letterSpacing: -0.3 }}>쿠팡 재고관리 시스템</div>
                <div style={{ fontSize: 11, color: '#64829B' }}>Rocket Growth Inventory Manager</div>
              </div>
              {isDemo && (
                <span style={{ background: '#1E3A5F', color: '#60A5FA', fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, border: '1px solid #2D4F6F' }}>DEMO 모드</span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {lastSync && <span style={{ fontSize: 12, color: '#64829B' }}>동기화: {lastSync.toLocaleTimeString('ko-KR')}</span>}
              {syncStatus && <span style={{ fontSize: 12, color: syncStatus.startsWith('✅') ? '#34D399' : syncStatus.startsWith('❌') ? '#EF4444' : '#FBBF24' }}>{syncStatus}</span>}

              <button onClick={fullSync} disabled={loading} style={{
                background: loading ? '#1E3A5F' : 'linear-gradient(135deg, #E4412A, #FF6B4A)',
                color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px',
                fontWeight: 700, fontSize: 13, cursor: loading ? 'not-allowed' : 'pointer',
                fontFamily: 'Noto Sans KR, sans-serif', opacity: loading ? 0.7 : 1
              }}>
                {loading ? '⏳ 동기화 중...' : '🔄 지금 동기화'}
              </button>

              <button onClick={toggleAutoSync} style={{
                background: autoSyncInterval ? '#0D2E1A' : '#1E3A5F',
                color: autoSyncInterval ? '#34D399' : '#94A3B8',
                border: `1px solid ${autoSyncInterval ? '#34D399' : '#2D4F6F'}`,
                borderRadius: 8, padding: '8px 14px', fontWeight: 600, fontSize: 12,
                cursor: 'pointer', fontFamily: 'Noto Sans KR, sans-serif'
              }}>{autoSyncInterval ? '🟢 자동동기화 ON' : '⏱ 자동동기화'}</button>

              <button onClick={testConnection} style={{
                background: isConnected ? '#0D2E1A' : '#1E3A5F',
                color: isConnected ? '#34D399' : '#94A3B8',
                border: `1px solid ${isConnected ? '#34D399' : '#2D4F6F'}`,
                borderRadius: 8, padding: '8px 14px', fontWeight: 600, fontSize: 12,
                cursor: 'pointer', fontFamily: 'Noto Sans KR, sans-serif'
              }}>{isConnected ? '🟢 API 연결됨' : '🔌 API 테스트'}</button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 0 }}>
            <TabBtn id="dashboard" label="📊 대시보드" />
            <TabBtn id="coupang" label="🏭 쿠팡 창고 재고" />
            <TabBtn id="warehouse" label="📦 자체 창고 재고" />
            <TabBtn id="restock" label="🚨 발주 가이드" />
            <TabBtn id="manage" label="⚙️ 상품 관리" />
            <TabBtn id="guide" label="📖 설치 가이드" />
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px' }}>

        {/* ══════════════════════════════════
            TAB: 대시보드
        ══════════════════════════════════ */}
        {tab === 'dashboard' && (
          <div>
            {/* 요약 카드 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
              {[
                { label: '쿠팡 창고 총재고', value: totalCoupang.toLocaleString(), unit: '개', icon: '🏭', color: '#3B82F6', sub: 'API 실시간 연동' },
                { label: '자체 창고 재고', value: totalWarehouse.toLocaleString(), unit: '개', icon: '📦', color: '#8B5CF6', sub: '수동 입력' },
                { label: '긴급 입고 필요', value: urgent.length, unit: '개 옵션', icon: '⚠️', color: '#EF4444', sub: '소진 20일 이하' },
                { label: '구매 검토 필요', value: purchaseNeeded.length, unit: '개 옵션', icon: '🛒', color: '#F59E0B', sub: '합산 60일 미만' },
              ].map((c, i) => (
                <Card key={i} style={{ padding: '20px 22px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontSize: 11, color: '#64829B', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{c.label}</div>
                      <div style={{ fontSize: 34, fontWeight: 900, color: c.color, letterSpacing: -1, lineHeight: 1 }}>{c.value}</div>
                      <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 4 }}>{c.unit} · {c.sub}</div>
                    </div>
                    <span style={{ fontSize: 28 }}>{c.icon}</span>
                  </div>
                </Card>
              ))}
            </div>

            {/* 긴급 알림 */}
            {urgent.length > 0 && (
              <Card style={{ marginBottom: 16, border: '1px solid #DC2626', background: 'linear-gradient(135deg, #1F0A0A, #2D1515)' }}>
                <div style={{ padding: '14px 20px', borderBottom: '1px solid #3D1A1A' }}>
                  <div style={{ fontWeight: 800, color: '#EF4444', fontSize: 15 }}>⚠️ 즉시 쿠팡 입고 필요 ({urgent.length}개 옵션)</div>
                </div>
                <div style={{ padding: '12px 20px', display: 'grid', gap: 8 }}>
                  {urgent.map(p => (
                    <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1A0808', borderRadius: 8, padding: '10px 16px', flexWrap: 'wrap', gap: 8 }}>
                      <span style={{ color: '#FCA5A5', fontSize: 13, fontWeight: 600 }}>📌 {p.name} — {p.option}</span>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                        <span style={{ color: '#EF4444', fontSize: 13 }}>잔여 <b>{p.coupangDepletionDays}일</b></span>
                        <span style={{ color: '#FBBF24', fontSize: 13, fontWeight: 700 }}>
                          → 즉시 <b>{calcRestockQty(p.dailyAvg, p.coupangStock, 50).toLocaleString()}개</b> 입고 권장
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* 전체 현황 테이블 */}
            <Card>
              <div style={{ padding: '16px 22px', borderBottom: '1px solid #1E3A5F', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>📋 전체 재고 현황</span>
                <button onClick={() => { setShowAddModal(true); setAddError(''); }}
                  style={{ background: '#0D2E1A', color: '#34D399', border: '1px solid #34D399', borderRadius: 8, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'Noto Sans KR' }}>
                  ＋ 상품 추가
                </button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#0D1520' }}>
                      {['상품명', '옵션', '일평균 판매', '쿠팡 재고', '쿠팡 소진', '창고 재고', '합산 소진', '상태', '차트', ''].map(h => (
                        <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, color: '#64829B', fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid #1E3A5F' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p, i) => (
                      <tr key={p.id} style={{ borderBottom: '1px solid #131D2A', background: i % 2 === 0 ? 'transparent' : '#0A1018' }}>
                        <td style={{ padding: '11px 14px', fontSize: 13, fontWeight: 700, color: '#C8D8E8', whiteSpace: 'nowrap' }}>{p.name}</td>
                        <td style={{ padding: '11px 14px', fontSize: 12, color: '#94A3B8', whiteSpace: 'nowrap' }}>{p.option}</td>
                        <td style={{ padding: '11px 14px', fontSize: 13, color: '#F0ABFC', fontWeight: 600 }}>{p.dailyAvg.toFixed(1)}개/일</td>
                        <td style={{ padding: '11px 14px', fontSize: 13, fontWeight: 700, color: p.coupangStock < 30 ? '#EF4444' : '#60A5FA' }}>{p.coupangStock.toLocaleString()}</td>
                        <td style={{ padding: '11px 14px' }}><StatusBadge days={p.coupangDepletionDays} /></td>
                        <td style={{ padding: '11px 14px', fontSize: 13, color: '#A78BFA', fontWeight: 600 }}>{p.warehouseStock.toLocaleString()}</td>
                        <td style={{ padding: '11px 14px' }}><StatusBadge days={p.totalDepletionDays} /></td>
                        <td style={{ padding: '11px 14px' }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: getStatus(p.coupangDepletionDays).color }}>
                            {getStatus(p.coupangDepletionDays).label}
                          </span>
                        </td>
                        <td style={{ padding: '11px 14px' }}>
                          <button onClick={() => setSelectedProduct(selectedProduct?.id === p.id ? null : p)}
                            style={{ background: '#1E3A5F', color: '#60A5FA', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontFamily: 'Noto Sans KR' }}>
                            {selectedProduct?.id === p.id ? '닫기' : '📈 보기'}
                          </button>
                        </td>
                        <td style={{ padding: '11px 14px' }}>
                          <button onClick={() => deleteProduct(p.id)}
                            style={{ background: '#2D1515', color: '#EF4444', border: '1px solid #EF4444', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontFamily: 'Noto Sans KR' }}>
                            🗑️
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 판매 차트 */}
              {selectedProduct && (
                <div style={{ padding: '20px 22px', borderTop: '1px solid #1E3A5F', background: '#0D1520' }}>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14, color: '#60A5FA' }}>
                    📈 {selectedProduct.name} — {selectedProduct.option} 최근 30일 판매량 (일평균: {selectedProduct.dailyAvg.toFixed(1)}개)
                  </div>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1E3A5F" />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#64829B' }} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: '#64829B' }} tickLine={false} />
                      <Tooltip contentStyle={{ background: '#0D1520', border: '1px solid #1E3A5F', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: '#94A3B8' }} itemStyle={{ color: '#60A5FA' }} />
                      <Bar dataKey="qty" name="판매량" radius={[3, 3, 0, 0]}>
                        {chartData.map((entry, i) => (
                          <Cell key={i} fill={entry.qty > selectedProduct.dailyAvg * 1.2 ? '#E4412A' : '#3B82F6'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
          </div>
        )}

        {/* ══════════════════════════════════
            TAB: 쿠팡 창고 재고
        ══════════════════════════════════ */}
        {tab === 'coupang' && (
          <div>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ padding: '16px 22px', borderBottom: '1px solid #1E3A5F', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>🏭 쿠팡 로켓그로스 창고 재고</div>
                  <div style={{ fontSize: 12, color: '#64829B', marginTop: 2 }}>API 실시간 연동 · 최근 30일 판매 기준 소진일 계산</div>
                </div>
                <span style={{ fontSize: 12, background: isDemo ? '#1E3A5F' : '#0D2E1A', color: isDemo ? '#60A5FA' : '#34D399', padding: '4px 14px', borderRadius: 20, fontWeight: 700 }}>
                  {isDemo ? '📋 데모 데이터' : '🟢 실시간 API'}
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#0D1520' }}>
                      {['상품명', '옵션', 'Vendor Item ID', '쿠팡 재고', '일평균', '7일판매', '14일판매', '30일판매', '소진 예상', '50일 입고권장'].map(h => (
                        <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, color: '#64829B', fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid #1E3A5F' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p, i) => {
                      const last7 = p.sales30.slice(-7).reduce((a, b) => a + b, 0);
                      const last14 = p.sales30.slice(-14).reduce((a, b) => a + b, 0);
                      const last30 = p.sales30.reduce((a, b) => a + b, 0);
                      const restock = calcRestockQty(p.dailyAvg, p.coupangStock, 50);
                      return (
                        <tr key={p.id} style={{ borderBottom: '1px solid #131D2A', background: i % 2 === 0 ? 'transparent' : '#0A1018' }}>
                          <td style={{ padding: '11px 14px', fontSize: 13, fontWeight: 700, color: '#C8D8E8', whiteSpace: 'nowrap' }}>{p.name}</td>
                          <td style={{ padding: '11px 14px', fontSize: 12, color: '#94A3B8', whiteSpace: 'nowrap' }}>{p.option}</td>
                          <td style={{ padding: '11px 14px', fontSize: 11, color: '#64829B', fontFamily: 'monospace' }}>{p.vendorItemId}</td>
                          <td style={{ padding: '11px 14px', fontSize: 13, fontWeight: 700, color: p.coupangStock < 30 ? '#EF4444' : '#60A5FA' }}>{p.coupangStock.toLocaleString()}개</td>
                          <td style={{ padding: '11px 14px', fontSize: 13, color: '#F0ABFC', fontWeight: 600 }}>{p.dailyAvg.toFixed(1)}개</td>
                          <td style={{ padding: '11px 14px', fontSize: 12, color: '#94A3B8' }}>{last7}</td>
                          <td style={{ padding: '11px 14px', fontSize: 12, color: '#94A3B8' }}>{last14}</td>
                          <td style={{ padding: '11px 14px', fontSize: 12, color: '#94A3B8' }}>{last30}</td>
                          <td style={{ padding: '11px 14px' }}><StatusBadge days={p.coupangDepletionDays} /></td>
                          <td style={{ padding: '11px 14px' }}>
                            {p.coupangDepletionDays <= 20
                              ? <span style={{ color: '#FBBF24', fontWeight: 800, fontSize: 13 }}>🚨 {restock.toLocaleString()}개</span>
                              : <span style={{ color: '#2D4F6F', fontSize: 12 }}>–</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card style={{ padding: '16px 22px' }}>
              <div style={{ fontWeight: 700, color: '#60A5FA', marginBottom: 8, fontSize: 13 }}>📌 계산 공식</div>
              <div style={{ fontSize: 13, color: '#94A3B8', lineHeight: 2 }}>
                <b style={{ color: '#E2E8F0' }}>소진 예상일</b> = 현재 쿠팡 재고 ÷ 일평균 판매량 (최근 30일 합계 ÷ 30)<br />
                <b style={{ color: '#FBBF24' }}>입고 권장 수량</b> = (일평균 × 50일) − 현재 쿠팡 재고 → 소진 예상 15~20일 이하일 때 표시
              </div>
            </Card>
          </div>
        )}

        {/* ══════════════════════════════════
            TAB: 자체 창고 재고
        ══════════════════════════════════ */}
        {tab === 'warehouse' && (
          <div>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ padding: '16px 22px', borderBottom: '1px solid #1E3A5F' }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>📦 자체 창고 재고 관리</div>
                <div style={{ fontSize: 12, color: '#64829B', marginTop: 2 }}>숫자를 클릭해서 직접 수정하세요. 합산 재고는 즉시 반영됩니다.</div>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#0D1520' }}>
                      {['상품명', '옵션', '쿠팡 창고', '자체 창고 재고 (수정 가능)', '합산 재고', '합산 소진 예상', '상태'].map(h => (
                        <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, color: '#64829B', fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid #1E3A5F' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p, i) => {
                      const total = p.coupangStock + p.warehouseStock;
                      const isEditing = warehouseEdits[p.id] !== undefined;
                      return (
                        <tr key={p.id} style={{ borderBottom: '1px solid #131D2A', background: i % 2 === 0 ? 'transparent' : '#0A1018' }}>
                          <td style={{ padding: '11px 14px', fontSize: 13, fontWeight: 700, color: '#C8D8E8', whiteSpace: 'nowrap' }}>{p.name}</td>
                          <td style={{ padding: '11px 14px', fontSize: 12, color: '#94A3B8', whiteSpace: 'nowrap' }}>{p.option}</td>
                          <td style={{ padding: '11px 14px', fontSize: 13, fontWeight: 700, color: '#60A5FA' }}>{p.coupangStock.toLocaleString()}개</td>
                          <td style={{ padding: '11px 14px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <input
                                type="number" min="0"
                                value={isEditing ? warehouseEdits[p.id] : p.warehouseStock}
                                onFocus={() => setWarehouseEdits(prev => ({ ...prev, [p.id]: p.warehouseStock }))}
                                onChange={e => setWarehouseEdits(prev => ({ ...prev, [p.id]: e.target.value }))}
                                style={{ background: '#0D1520', border: `1px solid ${isEditing ? '#8B5CF6' : '#1E3A5F'}`, borderRadius: 6, padding: '5px 10px', color: '#A78BFA', fontSize: 13, fontWeight: 600, width: 90, outline: 'none', fontFamily: 'Noto Sans KR' }}
                              />
                              <span style={{ color: '#64829B', fontSize: 12 }}>개</span>
                              {isEditing && (
                                <button onClick={() => saveWarehouseStock(p.id, p.vendorItemId)}
                                  style={{ background: '#5B21B6', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'Noto Sans KR' }}>
                                  저장
                                </button>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '11px 14px', fontSize: 13, fontWeight: 700, color: '#E2E8F0' }}>{total.toLocaleString()}개</td>
                          <td style={{ padding: '11px 14px' }}><StatusBadge days={p.totalDepletionDays} /></td>
                          <td style={{ padding: '11px 14px' }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: getStatus(p.totalDepletionDays).color }}>
                              {getStatus(p.totalDepletionDays).label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}

        {/* ══════════════════════════════════
            TAB: 상품 관리
        ══════════════════════════════════ */}
        {tab === 'manage' && (
          <div>
            <Card style={{ marginBottom: 16 }}>
              <div style={{ padding: '18px 22px', borderBottom: '1px solid #1E3A5F', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 16, color: '#E2E8F0' }}>⚙️ 상품 관리</div>
                  <div style={{ fontSize: 12, color: '#64829B', marginTop: 3 }}>ON인 상품만 대시보드에 표시됩니다. 변경 후 동기화 버튼을 눌러주세요.</div>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  {enabledIds.size > 0 && (
                    <span style={{ fontSize: 12, color: '#34D399', background: '#0D2E1A', padding: '4px 12px', borderRadius: 20, fontWeight: 700 }}>
                      {enabledIds.size}개 선택됨
                    </span>
                  )}
                  <button onClick={async () => {
                    setListLoading(true);
                    try {
                      const result = await api.listAll();
                      if (result.success) {
                        // 상품명 기준으로 그룹핑해서 중복 표시
                        setAllProducts(result.data);
                        // 처음 불러올 때 아무것도 선택 안 됐으면 전체 선택
                        if (enabledIds.size === 0) {
                          const all = new Set(result.data.map(p => p.vendorItemId));
                          setEnabledIds(all);
                          localStorage.setItem('enabledIds', JSON.stringify([...all]));
                        }
                      }
                    } catch(e) { alert('불러오기 실패: ' + e.message); }
                    finally { setListLoading(false); }
                  }} disabled={listLoading}
                    style={{ background: listLoading ? '#1E3A5F' : 'linear-gradient(135deg, #3B82F6, #2563EB)', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontWeight: 700, fontSize: 13, cursor: listLoading ? 'not-allowed' : 'pointer', fontFamily: 'Noto Sans KR' }}>
                    {listLoading ? '⏳ 불러오는 중...' : '🔄 전체 목록 불러오기'}
                  </button>
                  {allProducts.length > 0 && (
                    <button onClick={() => {
                      const all = new Set(allProducts.map(p => p.vendorItemId));
                      setEnabledIds(all);
                      localStorage.setItem('enabledIds', JSON.stringify([...all]));
                    }} style={{ background: '#0D2E1A', color: '#34D399', border: '1px solid #34D399', borderRadius: 8, padding: '8px 14px', fontWeight: 600, fontSize: 12, cursor: 'pointer', fontFamily: 'Noto Sans KR' }}>
                      전체 ON
                    </button>
                  )}
                  {allProducts.length > 0 && (
                    <button onClick={() => {
                      setEnabledIds(new Set());
                      localStorage.setItem('enabledIds', JSON.stringify([]));
                    }} style={{ background: '#2D1515', color: '#EF4444', border: '1px solid #EF4444', borderRadius: 8, padding: '8px 14px', fontWeight: 600, fontSize: 12, cursor: 'pointer', fontFamily: 'Noto Sans KR' }}>
                      전체 OFF
                    </button>
                  )}
                </div>
              </div>

              {allProducts.length === 0 ? (
                <div style={{ padding: '40px', textAlign: 'center', color: '#64829B', fontSize: 14 }}>
                  위의 "전체 목록 불러오기" 버튼을 눌러주세요 (1~2분 소요)
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#0D1520' }}>
                        {['표시', '상품명', '옵션', 'Vendor Item ID'].map(h => (
                          <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, color: '#64829B', fontWeight: 600, borderBottom: '1px solid #1E3A5F', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {allProducts.map((p, i) => {
                        const isOn = enabledIds.has(p.vendorItemId);
                        return (
                          <tr key={p.id} style={{ borderBottom: '1px solid #131D2A', background: i % 2 === 0 ? 'transparent' : '#0A1018', opacity: isOn ? 1 : 0.4 }}>
                            <td style={{ padding: '10px 14px' }}>
                              <div onClick={() => {
                                const next = new Set(enabledIds);
                                if (isOn) next.delete(p.vendorItemId);
                                else next.add(p.vendorItemId);
                                setEnabledIds(next);
                                localStorage.setItem('enabledIds', JSON.stringify([...next]));
                              }} style={{
                                width: 42, height: 24, borderRadius: 12, cursor: 'pointer', position: 'relative',
                                background: isOn ? '#10B981' : '#1E3A5F', transition: 'background 0.2s',
                                border: `1px solid ${isOn ? '#10B981' : '#2D4F6F'}`
                              }}>
                                <div style={{
                                  position: 'absolute', top: 3, left: isOn ? 20 : 3,
                                  width: 16, height: 16, borderRadius: '50%', background: '#fff',
                                  transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
                                }} />
                              </div>
                            </td>
                            <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: '#C8D8E8' }}>{p.name}</td>
                            <td style={{ padding: '10px 14px', fontSize: 12, color: '#94A3B8' }}>{p.option}</td>
                            <td style={{ padding: '10px 14px', fontSize: 11, color: '#64829B', fontFamily: 'monospace' }}>{p.vendorItemId}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )}

        {/* ══════════════════════════════════
            TAB: 발주 가이드
        ══════════════════════════════════ */}
        {tab === 'restock' && (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 800, color: '#E4412A', marginBottom: 16 }}>🏭 쿠팡 입고 가이드 — 소진 20일 이하 옵션</h2>

            {urgent.length === 0
              ? <Card style={{ padding: '20px 24px', marginBottom: 24, border: '1px solid #16A34A', background: '#0D2E1A' }}><span style={{ color: '#34D399', fontWeight: 700 }}>✅ 현재 긴급 입고가 필요한 옵션이 없습니다.</span></Card>
              : urgent.map(p => {
                  const restock = calcRestockQty(p.dailyAvg, p.coupangStock, 50);
                  return (
                    <Card key={p.id} style={{ marginBottom: 12, border: '1px solid #DC2626', background: 'linear-gradient(135deg, #1F0A0A, #2D1515)' }}>
                      <div style={{ padding: '18px 22px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                          <div>
                            <div style={{ fontWeight: 800, fontSize: 15, color: '#FCA5A5' }}>{p.name} — {p.option}</div>
                            <div style={{ fontSize: 12, color: '#64829B', marginTop: 2 }}>Vendor Item ID: <code style={{ color: '#FCA5A5', background: '#1A0808', padding: '1px 6px', borderRadius: 4 }}>{p.vendorItemId}</code></div>
                          </div>
                          <StatusBadge days={p.coupangDepletionDays} />
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                          {[
                            { label: '현재 쿠팡 재고', value: `${p.coupangStock}개`, color: '#EF4444' },
                            { label: '일평균 판매량', value: `${p.dailyAvg.toFixed(1)}개/일`, color: '#F97316' },
                            { label: '즉시 입고 권장', value: `${restock.toLocaleString()}개`, color: '#FCD34D', highlight: true },
                          ].map((c, i) => (
                            <div key={i} style={{ background: c.highlight ? '#1A1200' : '#150808', border: c.highlight ? '1px solid #FBBF24' : 'none', borderRadius: 8, padding: '12px 16px' }}>
                              <div style={{ fontSize: 11, color: c.highlight ? '#FBBF24' : '#64829B', fontWeight: 600, marginBottom: 4 }}>{c.label}</div>
                              <div style={{ fontSize: 22, fontWeight: 900, color: c.color }}>{c.value}</div>
                              {c.highlight && <div style={{ fontSize: 11, color: '#B45309', marginTop: 2 }}>→ 입고 후 50일치 확보</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    </Card>
                  );
                })
            }

            <h2 style={{ fontSize: 16, fontWeight: 800, color: '#F59E0B', marginTop: 28, marginBottom: 16 }}>🛒 신규 구매 가이드 — 합산 재고 60일 미만</h2>

            {purchaseNeeded.length === 0
              ? <Card style={{ padding: '20px 24px', border: '1px solid #16A34A', background: '#0D2E1A' }}><span style={{ color: '#34D399', fontWeight: 700 }}>✅ 현재 구매가 필요한 옵션이 없습니다.</span></Card>
              : purchaseNeeded.map(p => {
                  const total = p.coupangStock + p.warehouseStock;
                  const buyQty = calcRestockQty(p.dailyAvg, total, 120);
                  return (
                    <Card key={p.id} style={{ marginBottom: 12, border: '1px solid #D97706', background: 'linear-gradient(135deg, #1A1500, #2D2200)' }}>
                      <div style={{ padding: '18px 22px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                          <div>
                            <div style={{ fontWeight: 800, fontSize: 15, color: '#FDE68A' }}>{p.name} — {p.option}</div>
                            <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 2 }}>쿠팡 {p.coupangStock}개 + 창고 {p.warehouseStock}개 = 합산 {total}개</div>
                          </div>
                          <StatusBadge days={p.totalDepletionDays} />
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                          {[
                            { label: '합산 총재고', value: `${total.toLocaleString()}개`, color: '#FCD34D' },
                            { label: '일평균 판매량', value: `${p.dailyAvg.toFixed(1)}개/일`, color: '#F97316' },
                            { label: '구매 권장 수량', value: `${buyQty.toLocaleString()}개`, color: '#FCD34D', highlight: true },
                          ].map((c, i) => (
                            <div key={i} style={{ background: c.highlight ? '#1A1200' : '#130E00', border: c.highlight ? '1px solid #F59E0B' : 'none', borderRadius: 8, padding: '12px 16px' }}>
                              <div style={{ fontSize: 11, color: c.highlight ? '#F59E0B' : '#64829B', fontWeight: 600, marginBottom: 4 }}>{c.label}</div>
                              <div style={{ fontSize: 22, fontWeight: 900, color: c.color }}>{c.value}</div>
                              {c.highlight && <div style={{ fontSize: 11, color: '#B45309', marginTop: 2 }}>→ 구매 후 120일치 확보</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    </Card>
                  );
                })
            }

            <Card style={{ marginTop: 20, padding: '18px 22px' }}>
              <div style={{ fontWeight: 700, color: '#60A5FA', fontSize: 13, marginBottom: 8 }}>📌 발주 계산 공식</div>
              <div style={{ fontSize: 13, color: '#94A3B8', lineHeight: 2 }}>
                <b style={{ color: '#FCA5A5' }}>쿠팡 입고</b>: 소진 20일 이하 → (일평균 × 50일) − 현재 쿠팡 재고 = 입고 수량<br />
                <b style={{ color: '#FDE68A' }}>신규 구매</b>: 합산 소진 60일 미만 → (일평균 × 120일) − 합산 재고 = 구매 수량
              </div>
            </Card>
          </div>
        )}

        {/* ══════════════════════════════════
            TAB: 설치 가이드
        ══════════════════════════════════ */}
        {tab === 'guide' && (
          <div>
            <Card style={{ marginBottom: 16, border: '1px solid #1E3A5F' }}>
              <div style={{ padding: '20px 24px' }}>
                <div style={{ fontWeight: 800, fontSize: 18, color: '#60A5FA', marginBottom: 4 }}>🚀 실제 쿠팡 API 연결하기</div>
                <div style={{ fontSize: 13, color: '#64829B' }}>아래 5단계를 순서대로 따라하시면 실제 재고 데이터가 표시됩니다 (소요 시간: 약 30분)</div>
              </div>
            </Card>

            {[
              {
                step: 1, icon: '🔑', title: '쿠팡 API 키 발급',
                color: '#3B82F6',
                items: [
                  'wing.coupang.com 에 로그인합니다',
                  '우측 상단 계정명 클릭 → [개발자 센터] 클릭',
                  '"API 사용 신청" 버튼을 클릭하고 신청서 작성',
                  '승인 후 Access Key 와 Secret Key 두 가지를 메모장에 복사해두세요',
                  'Vendor ID는 개발자 센터 첫 화면 또는 WING 판매자 정보에서 확인 (A로 시작하는 숫자)',
                ]
              },
              {
                step: 2, icon: '📂', title: 'GitHub에 코드 올리기',
                color: '#8B5CF6',
                items: [
                  'github.com 에서 무료 계정 가입 (이미 있으면 로그인)',
                  '우측 상단 "+" 버튼 → "New repository" 클릭',
                  '이름: coupang-inventory 입력 → "Create repository" 클릭',
                  '받으신 ZIP 파일을 압축 해제합니다',
                  'github.com/new/import 에서 "Upload files" 로 압축 해제한 파일 전체 업로드',
                ]
              },
              {
                step: 3, icon: '🌐', title: 'Netlify 계정 만들기',
                color: '#10B981',
                items: [
                  'netlify.com 에 접속합니다',
                  '"Sign up" 클릭 → "Continue with GitHub" 로 GitHub 계정으로 가입',
                  '가입 완료 후 Netlify 대시보드가 열립니다',
                ]
              },
              {
                step: 4, icon: '🔗', title: 'Netlify에 배포하기',
                color: '#F59E0B',
                items: [
                  'Netlify 대시보드에서 "Add new site" → "Import an existing project" 클릭',
                  '"Deploy with GitHub" 클릭 → GitHub 계정 연결',
                  'coupang-inventory 저장소 선택',
                  'Build command: npm run build / Publish directory: dist 확인 후 "Deploy site" 클릭',
                  '2~3분 기다리면 배포 완료! 주소가 생성됩니다 (예: https://amazing-site-123.netlify.app)',
                ]
              },
              {
                step: 5, icon: '⚙️', title: 'API 키 환경변수 설정 (가장 중요!)',
                color: '#E4412A',
                items: [
                  'Netlify 사이트 대시보드 → "Site configuration" → "Environment variables" 클릭',
                  '"Add a variable" 클릭',
                  'COUPANG_ACCESS_KEY = (발급받은 Access Key 붙여넣기)',
                  'COUPANG_SECRET_KEY = (발급받은 Secret Key 붙여넣기)',
                  'COUPANG_VENDOR_ID = (판매자 Vendor ID 붙여넣기)',
                  '"Save" 후 → "Deploys" 탭 → "Trigger deploy" → 재배포',
                  '완료! 사이트에서 [API 테스트] 버튼을 눌러 연결을 확인하세요',
                ]
              },
            ].map(section => (
              <Card key={section.step} style={{ marginBottom: 12 }}>
                <div style={{ padding: '18px 22px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                    <div style={{ background: section.color, borderRadius: '50%', width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 15, color: '#fff', flexShrink: 0 }}>{section.step}</div>
                    <div style={{ fontSize: 22 }}>{section.icon}</div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: '#E2E8F0' }}>{section.title}</div>
                  </div>
                  <div style={{ paddingLeft: 46 }}>
                    {section.items.map((item, i) => (
                      <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 8, alignItems: 'flex-start' }}>
                        <span style={{ color: section.color, fontWeight: 700, fontSize: 13, flexShrink: 0, marginTop: 1 }}>{i + 1}.</span>
                        <span style={{ fontSize: 13, color: '#C8D8E8', lineHeight: 1.6 }}>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>
            ))}

            <Card style={{ padding: '18px 22px', border: '1px solid #F59E0B', background: 'linear-gradient(135deg, #1A1200, #2D2000)' }}>
              <div style={{ fontWeight: 700, color: '#FBBF24', fontSize: 14, marginBottom: 8 }}>💡 자주 묻는 질문</div>
              {[
                { q: '비용이 드나요?', a: 'GitHub 무료 계정 + Netlify 무료 플랜으로 운영 가능합니다. 월 방문 10만 건까지 완전 무료입니다.' },
                { q: '데이터가 자동으로 갱신되나요?', a: '상단의 [자동동기화] 버튼을 켜두면 5분마다 자동으로 쿠팡 API에서 재고와 판매량을 가져옵니다.' },
                { q: 'API 연결 오류가 나요', a: 'Netlify 환경변수 설정 후 반드시 재배포(Trigger deploy)를 해야 적용됩니다. 변수 이름에 띄어쓰기나 오타가 없는지 확인하세요.' },
                { q: '쿠팡에서 API 사용 신청이 거절됐어요', a: '쿠팡 파트너 센터(1:1 문의)에 "로켓그로스 재고 관리용 API 사용 신청"으로 문의하시면 됩니다.' },
              ].map((faq, i) => (
                <div key={i} style={{ marginBottom: 12, background: '#130E00', borderRadius: 8, padding: '12px 16px' }}>
                  <div style={{ fontWeight: 700, color: '#FDE68A', fontSize: 13, marginBottom: 4 }}>Q. {faq.q}</div>
                  <div style={{ fontSize: 13, color: '#94A3B8', lineHeight: 1.6 }}>A. {faq.a}</div>
                </div>
              ))}
            </Card>
          </div>
        )}

      </div>
    </div>
  );
}
