# 쿠팡 로켓그로스 재고관리 시스템

쿠팡 API와 실시간 연동해서 재고를 관리하는 웹 앱입니다.

## 주요 기능

- ✅ 쿠팡 로켓그로스 창고 재고 실시간 조회
- ✅ 최근 30일 판매량 기반 일평균 판매량 계산
- ✅ 쿠팡 창고 재고 소진 예상일 계산
- ✅ 소진 15~20일 이하: 50일치 입고 권장 수량 자동 계산
- ✅ 자체 창고 재고 수동 입력 및 합산 관리
- ✅ 합산 재고 60일 미만 시 120일치 구매 권장 수량 안내
- ✅ 5분마다 자동 동기화 기능

## 배포 방법 (Netlify)

1. GitHub에 이 코드를 업로드
2. netlify.com에서 GitHub 저장소 연결하여 배포
3. Netlify 환경변수 설정:
   - `COUPANG_ACCESS_KEY` = 쿠팡 Access Key
   - `COUPANG_SECRET_KEY` = 쿠팡 Secret Key
   - `COUPANG_VENDOR_ID` = 판매자 Vendor ID
4. 재배포 후 [API 테스트] 버튼으로 연결 확인

## 쿠팡 API 키 발급

1. wing.coupang.com 로그인
2. 우측 상단 계정명 → 개발자 센터
3. API 사용 신청 후 Access Key / Secret Key 발급

## 로컬 개발 환경 (개발자용)

```bash
npm install
netlify dev  # netlify-cli 필요: npm install -g netlify-cli
```

환경변수 파일 생성 (로컬 테스트용):
```
# .env 파일 생성
COUPANG_ACCESS_KEY=your_access_key
COUPANG_SECRET_KEY=your_secret_key
COUPANG_VENDOR_ID=your_vendor_id
```
