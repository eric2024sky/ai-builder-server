# Preview 라우팅 문제 해결 가이드

## 문제 상황
- iframe 내에서는 네비게이션이 정상 작동
- 새 탭에서 하위 페이지 직접 접속 시 서비스 메인 페이지("Only Idea")가 표시됨

## 문제 원인
Vite 개발 서버가 SPA 모드로 작동하면서 존재하지 않는 경로에 대해 자동으로 index.html을 반환합니다. `/preview/*` 경로가 프록시 설정에 있지만, 새 탭에서 직접 접속할 때는 Vite가 먼저 처리합니다.

## 해결 방법

### 방법 1: Express 서버로 직접 접속 (권장)
개발 중 preview를 확인할 때는 Express 서버(4000번 포트)로 직접 접속하세요:
- ❌ `http://localhost:5173/preview/projectId/pageName`
- ✅ `http://localhost:4000/preview/projectId/pageName`

### 방법 2: iframe 내에서만 사용
현재 설정에서는 iframe 내부 네비게이션이 정상 작동하므로, 애플리케이션 내에서만 preview를 사용하세요.

### 방법 3: 프로덕션 환경에서 테스트
```bash
# 프론트엔드 빌드
cd ai-builder-client
npm run build

# Express 서버를 프로덕션 모드로 실행
cd ../ai-builder-server
NODE_ENV=production npm start
```

프로덕션 환경에서는 Express 서버가 모든 라우팅을 처리하므로 문제가 발생하지 않습니다.

## 개발 팁
1. **미리보기 URL 복사**: iframe에서 미리보기를 볼 때, URL을 복사하여 포트를 4000으로 변경하면 새 탭에서도 볼 수 있습니다.
2. **브라우저 북마크**: 자주 사용하는 프로젝트는 4000번 포트 URL로 북마크하세요.
3. **개발자 도구**: iframe 내에서 마우스 우클릭 > "프레임을 새 탭에서 열기"를 사용하면 4000번 포트로 자동 열립니다.

## 기술적 배경
Vite는 개발 서버에서 HTML5 History API를 지원하기 위해 fallback 기능을 제공합니다. 이로 인해 존재하지 않는 경로에 대해 index.html을 반환하고, React 앱이 로드되어 "Only Idea" 페이지가 표시됩니다.

프록시 설정은 API 호출이나 iframe 내부 네비게이션에서는 작동하지만, 브라우저 주소창에 직접 입력하거나 새 탭에서 열 때는 Vite의 fallback이 먼저 작동합니다.