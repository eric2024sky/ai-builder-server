# Render 배포 환경 iframe 연결 거부 문제 해결

## 완료된 작업 목록
- [x] 서버측 중복된 X-Frame-Options 헤더 제거 및 통일
- [x] 클라이언트 App.jsx에서 iframe cross-origin 접근 코드 제거
- [x] iframe 에러 처리 및 대체 UI 개선
- [x] 환경 변수 설정 가이드 문서화
- [x] 테스트 및 검증

## 리뷰

### 문제 분석
Render에 클라이언트와 서버가 분리 배포되면서 발생한 cross-origin 문제였습니다:
- 클라이언트: `https://ai-builder-client.onrender.com`
- 서버: `https://ai-builder-server.onrender.com`
- 브라우저의 Same-Origin Policy로 인해 iframe 내부 접근이 차단됨

### 수행된 변경사항

#### 1. 서버측 (index.js)
- 중복된 `X-Frame-Options` 헤더 제거
- 모든 preview 라우트에 일관된 헤더 설정:
  - `X-Frame-Options: ALLOWALL`
  - `Content-Security-Policy`에 `frame-ancestors *` 포함
  - CORS 헤더 설정

#### 2. 클라이언트측 (App.jsx)
- iframe 내부 document/window 접근 시도 코드 제거
- cross-origin 접근으로 인한 에러 발생 방지
- 에러 처리 로직 단순화

#### 3. 문서화 (CLAUDE.md)
- Render 배포 시 필요한 환경 변수 설정 가이드 추가
- 클라이언트: `VITE_API_URL` 설정 필수
- 서버: `CLIENT_URL` 등 환경 변수 목록

### 배포 후 필요한 작업
1. Render 클라이언트 환경 변수에 `VITE_API_URL=https://ai-builder-server.onrender.com` 설정
2. Render 서버 환경 변수에 `CLIENT_URL=https://ai-builder-client.onrender.com` 설정
3. 양쪽 서비스 재배포
4. 브라우저 캐시 삭제 후 테스트

### 주의사항
- 환경 변수는 빌드 시점에 적용되므로 설정 후 반드시 재배포 필요
- iframe 내부 콘텐츠에는 더 이상 JavaScript로 접근할 수 없음 (보안상 정상)
- 사용자는 "새 창에서 열기" 버튼으로 대체 접근 가능

---

# 이전 작업: 하위 페이지 이동 문제 해결

## 완료된 작업 ✅

### 1. 빈 배열 전달 문제 수정
- `/api/save` 엔드포인트에서 `updateHtmlResources` 함수 호출 시 실제 프로젝트 페이지 정보 전달
- 변경: `updateHtmlResources(finalHtml, currentProjectId, pageName, [], [])` → 실제 프로젝트 페이지 배열 전달

### 2. 디버깅 로그 추가
- `updateHtmlResources` 함수에 상세한 로깅 추가
- allPageNames 배열 내용, 링크 변환 과정 등을 추적 가능

### 3. 정규식 패턴 개선
- 홈 링크 변환에 로깅 추가
- 각 링크 처리 단계별 디버그 로그 추가

### 4. 잘못된 index 링크 패턴 수정
- AI가 생성한 `/preview/{projectId}/index` 형식의 잘못된 링크를 `/preview/{projectId}`로 수정
- 이것이 **핵심 문제의 원인**이었음

### 5. 구 스키마 호환성 추가
- pageId가 없는 구 형식 프로젝트 데이터 처리
- pageName으로 페이지 검색하는 폴백 로직 추가

### 6. JavaScript 네비게이션 지원
- onclick 이벤트 링크 변환
- window.location.href 변환

### 7. iframe sandbox 속성 제거
- 클라이언트에서 iframe 내부 네비게이션 허용

## 변경 사항 요약

### 서버 측 (`/ai-builder-server/index.js`)
1. **updateHtmlResources 함수 개선**
   - 잘못된 index 링크 패턴 처리 추가
   - 상세한 디버깅 로그 추가
   - onclick 및 JavaScript 네비게이션 처리

2. **preview 라우트 핸들러 개선**
   - 구 스키마 데이터 호환성
   - 더 자세한 에러 로깅

3. **/api/save 엔드포인트 수정**
   - 실제 프로젝트 페이지 정보 전달

### 클라이언트 측 (`/ai-builder-client/src/App.jsx`)
1. **iframe 설정 변경**
   - sandbox 속성 제거로 내부 네비게이션 허용

## 문제 해결 확인
이제 하위 페이지로의 이동이 정상적으로 작동해야 합니다. 
모든 링크가 올바른 형식으로 변환되어 네비게이션이 가능합니다.