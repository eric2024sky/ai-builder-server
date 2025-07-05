// 버튼 클릭 및 네비게이션 테스트 스크립트

const fetch = require('node-fetch');
const fs = require('fs').promises;

const API_BASE = 'http://localhost:4000';

async function testButtonAndNavigation() {
  console.log('=== 버튼 클릭 및 네비게이션 테스트 시작 ===\n');

  try {
    // 테스트 프롬프트: 일본 여행 사이트 (버튼과 네비게이션 포함)
    const prompt = `Create a Japan travel website with:
    - Navigation menu with Home, Regions, Attractions, About pages
    - Image slider with previous/next buttons
    - Interactive region cards with "Learn More" buttons
    - Contact form with submit button
    - Smooth scroll navigation for anchor links
    - Make it visually appealing with images and proper layout`;

    console.log('1. 멀티페이지 사이트 생성 중...');
    console.log('프롬프트:', prompt);
    
    // SSE 스트림으로 생성 요청
    const response = await fetch(`${API_BASE}/api/stream?message=${encodeURIComponent(prompt)}&generationType=multi&totalPages=4&pageNames=index,regions,attractions,about`);
    
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
            if (json.type === 'plan_complete') {
              console.log('✓ 생성 계획 완료');
            } else if (json.type === 'page_complete') {
              console.log(`✓ 페이지 생성 완료: ${json.pageName}`);
              if (json.projectId) {
                projectId = json.projectId;
              }
            } else if (json.type === 'generation_complete') {
              console.log('✓ 전체 생성 완료');
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

    console.log(`\n2. 생성된 프로젝트 ID: ${projectId}`);
    console.log(`   미리보기 URL: ${API_BASE}/preview/${projectId}`);

    // 생성된 HTML 검증
    console.log('\n3. 생성된 HTML 검증 중...');
    
    const indexPage = await fetch(`${API_BASE}/api/get-page/${projectId}/index`);
    const indexHtml = await indexPage.text();
    
    // JavaScript 이벤트 핸들러 검증
    const hasOnclick = indexHtml.includes('onclick=');
    const hasAddEventListener = indexHtml.includes('addEventListener');
    const hasScriptTag = indexHtml.includes('<script>');
    const hasButtonElements = indexHtml.includes('<button');
    const hasFormElements = indexHtml.includes('<form');
    
    console.log('\n검증 결과:');
    console.log(`- <script> 태그 존재: ${hasScriptTag ? '✓' : '✗'}`);
    console.log(`- 버튼 요소 존재: ${hasButtonElements ? '✓' : '✗'}`);
    console.log(`- onclick 이벤트 핸들러: ${hasOnclick ? '✓' : '✗'}`);
    console.log(`- addEventListener 사용: ${hasAddEventListener ? '✓' : '✗'}`);
    console.log(`- 폼 요소 존재: ${hasFormElements ? '✓' : '✗'}`);
    
    // 네비게이션 링크 검증
    const navLinks = indexHtml.match(/href="\/preview\/[^"]+"/g) || [];
    console.log(`\n- 네비게이션 링크 수: ${navLinks.length}`);
    if (navLinks.length > 0) {
      console.log('  발견된 링크:');
      navLinks.forEach(link => console.log(`  ${link}`));
    }
    
    // 이미지 소스 검증
    const imageSources = indexHtml.match(/src="https:\/\/[^"]+"/g) || [];
    console.log(`\n- 외부 이미지 수: ${imageSources.length}`);
    
    // 샘플 HTML 저장 (디버깅용)
    await fs.writeFile('test-output-interactive.html', indexHtml);
    console.log('\n샘플 HTML이 test-output-interactive.html로 저장되었습니다.');
    
    console.log('\n=== 테스트 완료 ===');
    console.log('\n권장사항:');
    console.log('1. 브라우저에서 미리보기 URL을 열어보세요');
    console.log('2. 버튼 클릭이 작동하는지 확인하세요');
    console.log('3. 네비게이션 링크가 작동하는지 확인하세요');
    console.log('4. 개발자 도구 콘솔에서 에러가 있는지 확인하세요');
    
  } catch (error) {
    console.error('테스트 실패:', error);
  }
}

// 테스트 실행
testButtonAndNavigation();