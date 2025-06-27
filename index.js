import dotenv   from 'dotenv';
import express  from 'express';
import cors     from 'cors';
import mongoose from 'mongoose';
import OpenAI   from 'openai';

dotenv.config();

const CLIENT_ORIGIN = 'https://ai-builder-client.onrender.com';  
// ↑ 실제 배포된 클라이언트 URL을 적어 주세요.

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true,
})
.then(() => console.log('🔗 MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

const PageSchema = new mongoose.Schema({
  prompt:  { type: String },
  html:    { type: String, required: true },
  created: { type: Date,   default: Date.now },
});
const Page = mongoose.models.Page || mongoose.model('Page', PageSchema);

const app = express();

// ─── CORS 설정 ────────────────────────────────────────────
// 1) 클라이언트 도메인만 허용
app.use(cors({
  origin: CLIENT_ORIGIN,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,              // 필요 시 true
}));

app.use(express.json());

app.get('/', (_req, res) => {
  res.send('OK');
});

// ─── SSE 스트리밍 엔드포인트 ───────────────────────────────
app.options('/api/stream', (_req, res) => {
  // Preflight 요청에 204 응답
  res.sendStatus(204);
});

app.all('/api/stream', async (req, res) => {
  // **추가**: 만약 cors 미들웨어가 헤더를 못 붙였다면, 강제로 설정
  res.setHeader('Access-Control-Allow-Origin', CLIENT_ORIGIN);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const message = req.method === 'GET'
    ? req.query.message
    : req.body.message;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

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

  for await (const chunk of stream) {
    const text = chunk.choices[0].delta?.content;
    if (text) {
      res.write(`data: ${text}\n\n`);
      fullHtml += text;
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
});

// ─── 저장/미리보기 엔드포인트(변경 없음) ──────────────────────
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
