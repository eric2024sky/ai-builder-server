// Express 라우트 우선순위 테스트를 위한 미니 서버

const express = require('express');
const app = express();

// 로깅 미들웨어
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// 1. 정적 파일 서빙
app.use('/static', express.static('public'));

// 2. Preview 라우트 (우선순위 높음)
app.get('/preview/:projectId', (req, res) => {
  console.log('✅ Preview route (index) matched');
  res.send(`<h1>Preview Index Page: ${req.params.projectId}</h1>`);
});

app.get('/preview/:projectId/:pageName', (req, res) => {
  console.log('✅ Preview route (page) matched');
  res.send(`<h1>Preview Page: ${req.params.projectId}/${req.params.pageName}</h1>`);
});

// 3. API 라우트
app.get('/api/test', (req, res) => {
  res.json({ message: 'API route' });
});

// 4. Catch-all 라우트
app.get('*', (req, res) => {
  console.log('❌ Catch-all route matched');
  res.send('<h1>Catch-all route (React App would be served here)</h1>');
});

const PORT = 3333;
app.listen(PORT, () => {
  console.log(`테스트 서버가 포트 ${PORT}에서 실행 중입니다.`);
  console.log('\n테스트 URL:');
  console.log(`- http://localhost:${PORT}/preview/test-id`);
  console.log(`- http://localhost:${PORT}/preview/test-id/about`);
  console.log(`- http://localhost:${PORT}/api/test`);
  console.log(`- http://localhost:${PORT}/random-path`);
});