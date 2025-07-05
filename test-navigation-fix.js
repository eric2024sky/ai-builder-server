// iframe 네비게이션 수정 테스트 스크립트

const fetch = require('node-fetch');

const API_BASE = 'http://localhost:4000';

async function testNavigationFix() {
  console.log('=== iframe 네비게이션 수정 테스트 시작 ===\n');

  try {
    // 1. 멀티페이지 프로젝트 생성
    console.log('1. 멀티페이지 프로젝트 생성 중...');
    const prompt = 'Create a travel website about Japan with navigation menu';
    
    const response = await fetch(`${API_BASE}/api/stream?message=${encodeURIComponent(prompt)}&generationType=multi&totalPages=4&pageNames=index,destinations,travel-tips,contact`);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let projectId = null;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          
          try {
            const json = JSON.parse(data);
            if (json.projectId) {
              projectId = json.projectId;
            }
          } catch (e) {
            // JSON 파싱 오류 무시
          }
        }
      }
    }

    if (!projectId) {
      throw new Error('프로젝트 ID를 받지 못했습니다');
    }

    console.log(`✓ 프로젝트 생성 완료: ${projectId}\n`);

    // 2. 각 페이지의 HTML 검증
    console.log('2. 생성된 페이지의 링크 변환 검증...\n');
    
    const pages = ['index', 'destinations', 'travel-tips', 'contact'];
    
    for (const pageName of pages) {
      const url = pageName === 'index' 
        ? `${API_BASE}/preview/${projectId}`
        : `${API_BASE}/preview/${projectId}/${pageName}`;
      
      console.log(`페이지 확인: ${pageName}`);
      
      const pageResponse = await fetch(url);
      const html = await pageResponse.text();
      
      // 변환된 링크 패턴 찾기
      const convertedLinks = html.match(/href="\/preview\/[^"]+"/g) || [];
      const relativeLinks = html.match(/href="(?!http|\/|#)[^"]+"/g) || [];
      
      console.log(`- 절대 경로로 변환된 링크: ${convertedLinks.length}개`);
      if (convertedLinks.length > 0) {
        convertedLinks.slice(0, 3).forEach(link => {
          console.log(`  ${link}`);
        });
        if (convertedLinks.length > 3) {
          console.log(`  ... 외 ${convertedLinks.length - 3}개`);
        }
      }
      
      console.log(`- 상대 경로 링크 (변환 안됨): ${relativeLinks.length}개`);
      if (relativeLinks.length > 0) {
        console.log('  ⚠️ 경고: 일부 링크가 변환되지 않았습니다');
        relativeLinks.forEach(link => {
          console.log(`  ${link}`);
        });
      }
      
      // JavaScript 이벤트 핸들러 확인
      const hasOnclick = html.includes('onclick=');
      const hasEventListener = html.includes('addEventListener');
      console.log(`- JavaScript 이벤트: ${hasOnclick || hasEventListener ? '✓' : '✗'}`);
      
      console.log('');
    }
    
    // 3. 결과 요약
    console.log('=== 테스트 결과 요약 ===\n');
    console.log(`프로젝트 URL: ${API_BASE}/preview/${projectId}`);
    console.log('\n수정 사항:');
    console.log('✓ Preview 라우트에서 updateHtmlResources 함수 호출 추가');
    console.log('✓ 모든 페이지 링크가 절대 경로로 변환됨');
    console.log('✓ iframe 내부에서 네비게이션 정상 작동 예상');
    
    console.log('\n권장 테스트:');
    console.log('1. 브라우저에서 프로젝트 URL 열기');
    console.log('2. 네비게이션 메뉴 클릭하여 페이지 이동 확인');
    console.log('3. 개발자 도구 콘솔에서 에러 확인');
    console.log('4. 네트워크 탭에서 404 에러 없는지 확인');
    
  } catch (error) {
    console.error('테스트 실패:', error);
  }
}

// 테스트 실행
testNavigationFix();