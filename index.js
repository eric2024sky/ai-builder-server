import dotenv   from 'dotenv';
import express  from 'express';
import cors     from 'cors';
import mongoose from 'mongoose';
import OpenAI   from 'openai';

// 0) 환경변수 로드 (.env 또는 Render 환경변수)
dotenv.config();

// 0.1) CORS 허용 대상 (로컬 테스트용/배포용)
const CLIENT_ORIGIN = process.env.CLIENT_URL || 'http://localhost:5173';

// 1) MongoDB 연결
mongoose.connect(process.env.MONGODB_URI, {
  // useNewUrlParser/useUnifiedTopology 옵션은 MongoDB 드라이버 4.x 에선 더 이상 필요치 않으나
  // 경고 없이 사용하려면 아래 두 줄을 제거해도 됩니다.
  useNewUrlParser:    true,
  useUnifiedTopology: true,
})
  .then(() => console.log('🔗 MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// 2) 페이지 스키마 & 모델
const PageSchema = new mongoose.Schema({
  prompt:  { type: String },
  html:    { type: String, required: true },
  created: { type: Date,   default: Date.now },
});
const Page = mongoose.models.Page || mongoose.model('Page', PageSchema);

// 3) Express 앱 생성
const app = express();

// ─── 전역 CORS 설정 ────────────────────────────────────────
app.use(cors({
  origin: CLIENT_ORIGIN,            // 허용할 프론트엔드 도메인
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,                // 쿠키/인증이 필요하면 true
}));
// 모든 엔드포인트에 대해 Preflight(OPTIONS) 요청 허용
app.options('*', cors({
  origin: CLIENT_ORIGIN,
  methods: ['GET','POST','OPTIONS'],
}));

// JSON 바디 파서
app.use(express.json());

// 4) Health-check 엔드포인트
app.get('/', (_req, res) => {
  res.send('OK');
});

// 5) SSE 스트리밍 엔드포인트
app.all('/api/stream', async (req, res) => {
  // 만약 cors 미들웨어가 누락됐다면, 강제로 헤더 추가
  res.setHeader('Access-Control-Allow-Origin', CLIENT_ORIGIN);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // GET/POST 둘 다 지원
  const message = req.method === 'GET'
    ? req.query.message
    : req.body.message;

  // SSE 헤더
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  // OpenAI 스트림 요청
  const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const systemPrompt = [
    '당신은 “실행 가능한 HTML 문서”만 순수하게 출력해야 합니다.',
    '어떠한 부연 설명도, 마크다운 설명도, 리스트도 하지 마세요.',
    '출력 예시: <html><head>…</head><body>…</body></html>',
  ].join(' ');

  let fullHtml = '';
  const stream = await ai.chat.completions.create({
    model:  'gpt-4o-mini',
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: message }
    ],
  });

  // 조각 단위로 내려보내기
  for await (const chunk of stream) {
    const text = chunk.choices[0].delta?.content;
    if (text) {
      res.write(`data: ${text}\n\n`);
      fullHtml += text;
    }
  }

  // 스트림 완료 신호
  res.write('data: [DONE]\n\n');
  res.end();
});

// 6) 생성된 HTML 저장 엔드포인트
app.post('/api/save', async (req, res) => {
  try {
    const { prompt, html } = req.body;
    const doc = await Page.create({ prompt, html });
    return res.json({ id: doc._id.toString() });
  } catch (err) {
    console.error('Save error:', err);
    return res.status(500).json({ error: '저장 실패' });
  }
});

// 7) 저장된 HTML 미리보기
app.get('/preview/:id', async (req, res) => {
  try {
    const doc = await Page.findById(req.params.id);
    if (!doc) return res.status(404).send('Not found');
    return res.send(doc.html);
  } catch (err) {
    console.error('Preview error:', err);
    return res.status(500).send('Error');
  }
});

// 8) 포트 바인딩 (Render용 PORT 지원)
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
