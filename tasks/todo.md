# 하위 페이지 이동 문제 해결

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