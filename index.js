import dotenv   from 'dotenv';
import express  from 'express';
import cors     from 'cors';
import mongoose from 'mongoose';
import OpenAI   from 'openai';
import { Anthropic } from '@anthropic-ai/sdk';
import fetch    from 'node-fetch';

// 0) 환경변수 로드 (.env 또는 Render 환경변수)
dotenv.config();

// 1) MongoDB 연결
mongoose.connect(process.env.MONGODB_URI, {
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

// ─── CORS: 다중 Origin 허용 ─────────────────────────────────
const ALLOWED_ORIGINS = [
  'http://localhost:5173',                   // 로컬 클라이언트
  'http://localhost:4000',                   // 로컬 서버
  'https://ai-builder-client.onrender.com',  // 배포된 클라이언트
];

app.use(cors({
  origin: (incomingOrigin, callback) => {
    if (!incomingOrigin || ALLOWED_ORIGINS.includes(incomingOrigin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
}));
app.options('*', cors());

// JSON 바디 파서
app.use(express.json());

// 4) Health-check 엔드포인트
app.get('/', (_req, res) => res.send('OK'));

// 5) SSE 스트리밍 엔드포인트
app.all('/api/stream', async (req, res) => {
  // GET/POST 메시지 & 모델 파싱
  const message     = req.method === 'GET'
    ? req.query.message
    : req.body.message;
  const chosenModel = req.query.model || 'gpt';

  // SSE 헤더
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  // 1) ChatGPT 분기 (OpenAI)
  if (chosenModel === 'gpt') {
    const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const stream = await ai.chat.completions.create({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [
        { role: 'system', content: 'HTML 코드만 순수하게 출력하십시오.' },
        { role: 'user',   content: message }
      ],
    });
    res.write(': ping\n\n');
    res.flush?.();
    for await (const chunk of stream) {
      const txt = chunk.choices[0].delta?.content;
      if (txt) {
        res.write(`data: ${txt}\n\n`);
        res.flush?.();
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // 2) Anthropic 분기
  const anModel = process.env.ANTHROPIC_MODEL;
  const completionModels = [
    'claude-opus-4-20250514',
    'claude-sonnet-4-20250514',
  ];

  // 2-1) Completions API 지원 모델
  if (completionModels.includes(anModel)) {
    const anth = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const stream = await anth.completions.create({
      model: anModel,
      stream: true,
      prompt: `HTML만 순수하게 출력하세요. User: ${message}`,
      max_tokens_to_sample: 1000,
      temperature: 0.0,
    });
    res.write(': ping\n\n');
    res.flush?.();
    for await (const chunk of stream) {
      const txt = chunk.completion || '';
      if (txt) {
        res.write(`data: ${txt}\n\n`);
        res.flush?.();
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // 2-2) Messages API 전용 모델
  const resp = await fetch('https://api.anthropic.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Accept':       'text/event-stream',
      'Content-Type': 'application/json',
      'X-API-Key':    process.env.ANTHROPIC_API_KEY,
    },
    body: JSON.stringify({
      model: anModel,
      stream: true,
      messages: [
        { role: 'system', content:
            'You are an AI that ONLY outputs pure HTML—no markdown, no extra explanation.' },
        { role: 'user',   content: message }
      ],
      max_tokens_to_sample: 1000,
      temperature: 0.0
    }),
  });
  res.write(': ping\n\n');
  res.flush?.();
  resp.body.pipe(res, { end: false });
  resp.body.on('end', () => {
    res.write('data: [DONE]\n\n');
    res.end();
  });
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

// 8) 포트 바인딩 (Render용 포트 지원)
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
