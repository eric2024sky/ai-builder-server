// 라우팅 문제 테스트 스크립트

const fetch = require('node-fetch');

async function testRouting() {
  console.log('=== 라우팅 문제 테스트 시작 ===\n');

  // 테스트할 URL들
  const urls = [
    'http://localhost:4000/preview/test-project-id',
    'http://localhost:4000/preview/test-project-id/about',
    'http://localhost:5173/preview/test-project-id',
    'http://localhost:5173/preview/test-project-id/about'
  ];

  for (const url of urls) {
    console.log(`테스트 URL: ${url}`);
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
      });

      console.log(`상태 코드: ${response.status}`);
      console.log(`Content-Type: ${response.headers.get('content-type')}`);
      
      const text = await response.text();
      
      // 응답 내용 분석
      if (text.includes('Only Idea')) {
        console.log('❌ 서비스 메인 페이지가 반환됨');
      } else if (text.includes('404')) {
        console.log('⚠️ 404 에러 페이지');
      } else if (text.includes('AI Web Builder')) {
        console.log('✅ AI 빌더로 생성된 페이지');
      } else {
        console.log('❓ 알 수 없는 응답');
      }
      
      // 첫 200자만 출력
      console.log(`응답 내용: ${text.substring(0, 200)}...`);
      console.log('---\n');
      
    } catch (error) {
      console.log(`❌ 에러 발생: ${error.message}`);
      console.log('---\n');
    }
  }
  
  console.log('=== 테스트 완료 ===\n');
  console.log('문제 해결 제안:');
  console.log('1. Express 서버(4000)로 직접 접속 시 작동한다면 Vite 프록시 문제');
  console.log('2. 둘 다 실패한다면 Express 라우트 정의 문제');
  console.log('3. "Only Idea" 페이지가 나온다면 React 앱이 모든 경로를 가로채는 문제');
}

testRouting();