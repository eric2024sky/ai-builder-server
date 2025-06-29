import dotenv   from 'dotenv';
import express  from 'express';
import cors     from 'cors';
import mongoose from 'mongoose';
import fetch    from 'node-fetch';

// 0) 환경변수 로드 (.env 또는 Render 환경변수)
dotenv.config();

// 1) MongoDB 연결
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('🔗 MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// 2) 페이지 스키마 & 모델 (수정 히스토리 추가)
const PageSchema = new mongoose.Schema({
  prompt:         { type: String },
  html:           { type: String, required: true },
  created:        { type: Date,   default: Date.now },
  isModification: { type: Boolean, default: false },
  originalPrompt: { type: String },
  version:        { type: Number }, // 버전 구분용
  modifications:  [{ 
    request: String,
    html: String,
    timestamp: { type: Date, default: Date.now }
  }]
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

// 5) SSE 스트리밍 엔드포인트 (수정 기능 추가)
app.all('/api/stream', async (req, res) => {
  console.log('Stream request received:', req.method);
  console.log('Query params:', req.query);
  console.log('Body:', req.body);
  
  // GET/POST 메시지 & 수정 모드 파싱
  const { message, isModification, currentHtml } = req.method === 'GET'
    ? { 
        message: req.query.message, 
        isModification: req.query.isModification === 'true', 
        currentHtml: req.query.currentHtml || '' 
      }
    : req.body;

  console.log('Parsed params:', { 
    message: message ? 'exists' : 'missing', 
    isModification, 
    currentHtml: currentHtml ? 'exists' : 'none' 
  });

  if (!message) {
    res.write('data: {"error": "Message parameter is required"}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // SSE 헤더
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  try {
    // 수정 모드일 때는 현재 HTML을 포함한 프롬프트 구성
    let systemPrompt = `You are an AI that ONLY outputs pure HTML—no markdown, no extra explanation.

ABSOLUTE IMAGE POLICY - READ CAREFULLY:
- DO NOT include ANY images unless they are 100% relevant to the specific content
- Random stock photos of landscapes, buildings, or people are FORBIDDEN
- If you're making a Japan website, only use images if you have actual Japanese landmarks
- If you're making a food website, only use images if you have actual food photos
- If you cannot guarantee the image matches the content, DO NOT include any image
- Most websites look better with excellent typography and NO images than with irrelevant images

PREFERRED APPROACH:
- Focus on beautiful typography, colors, and layout
- Use CSS gradients, icons (emoji), and styling instead of images
- Create visual interest through design, not random photos
- Only add images when they genuinely serve the content purpose

REMEMBER: Content-first, images only when truly necessary and relevant.`;
    
    let userMessage = message;

    if (isModification && currentHtml) {
      systemPrompt = `You are an AI that modifies existing HTML based on user requests. 
IMPORTANT: Only output the complete modified HTML code, no explanations or markdown.

ABSOLUTE IMAGE POLICY:
- Remove any irrelevant or random images
- Only keep images that are 100% relevant to the specific content
- Prefer improving text content and styling over adding images
- If images don't serve a clear purpose, remove them entirely

Current HTML code:
${currentHtml}

Modify this HTML according to the user's request. Output only the complete modified HTML.`;
      userMessage = `Please modify the HTML according to this request: ${message}`;
    }

    console.log('Making API call to Anthropic...');

    // Anthropic API 호출 - 올바른 API 형식 사용
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-3-sonnet-20240229',
        stream: true,
        messages: [
          { role: 'user', content: `${systemPrompt}\n\n${userMessage}` }
        ],
        max_tokens: 2000,
        temperature: 0.1
      }),
    });

    console.log('API Response status:', resp.status);

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error('API Error:', errorText);
      throw new Error(`API responded with status: ${resp.status} - ${errorText}`);
    }

    res.write('data: {"type":"ping"}\n\n');
    
    // Node.js 환경에서 스트림 처리 - readable stream 사용
    let buffer = '';
    let chunkBuffer = '';
    let chunkTimer = null;
    
    // 청크를 모아서 전송하는 함수 (깜빡임 방지)
    const flushChunkBuffer = () => {
      if (chunkBuffer.trim()) {
        const chatCompletionFormat = {
          choices: [{
            delta: {
              content: chunkBuffer
            }
          }]
        };
        console.log('Sending content chunk:', chunkBuffer.substring(0, 50) + '...');
        res.write(`data: ${JSON.stringify(chatCompletionFormat)}\n\n`);
        chunkBuffer = '';
      }
    };
    
    resp.body.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      
      // 마지막 라인은 incomplete일 수 있으므로 buffer에 보관
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            // 마지막 버퍼 전송
            if (chunkTimer) clearTimeout(chunkTimer);
            flushChunkBuffer();
            
            console.log('Stream completed');
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              // 청크를 버퍼에 모음
              chunkBuffer += parsed.delta.text;
              
              // 더 큰 청크나 의미있는 단위로 전송
              if (chunkBuffer.length > 50 || chunkBuffer.includes('>') || chunkBuffer.includes('\n')) {
                if (chunkTimer) clearTimeout(chunkTimer);
                flushChunkBuffer();
              } else {
                // 타이머로 주기적으로 전송 (깜빡임 방지)
                if (chunkTimer) clearTimeout(chunkTimer);
                chunkTimer = setTimeout(flushChunkBuffer, 200); // 200ms마다 전송
              }
            }
          } catch (parseError) {
            console.log('Parse error for line:', line, parseError);
          }
        }
      }
    });

    resp.body.on('end', () => {
      // 마지막 버퍼 처리
      if (buffer && buffer.startsWith('data: ')) {
        const data = buffer.slice(6);
        if (data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              const chatCompletionFormat = {
                choices: [{
                  delta: {
                    content: parsed.delta.text
                  }
                }]
              };
              res.write(`data: ${JSON.stringify(chatCompletionFormat)}\n\n`);
            }
          } catch (parseError) {
            console.log('Parse error for final buffer:', buffer, parseError);
          }
        }
      }
      
      res.write('data: [DONE]\n\n');
      res.end();
    });

    resp.body.on('error', (error) => {
      console.error('Stream body error:', error);
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

  } catch (error) {
    console.error('Stream error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// 6) 생성된 HTML 저장 엔드포인트 (수정 히스토리 포함)
app.post('/api/save', async (req, res) => {
  try {
    const { prompt, html, isModification, originalPrompt } = req.body;
    
    // HTML 내용 검증
    if (!html || html.trim().length === 0) {
      console.log('Empty HTML content, skipping save');
      return res.status(400).json({ error: 'HTML 내용이 비어있습니다.' });
    }
    
    // 모든 버전을 별도 문서로 저장 (히스토리 보존)
    const doc = await Page.create({ 
      prompt, 
      html, 
      isModification,
      originalPrompt: originalPrompt || prompt,
      version: Date.now() // 버전 구분을 위한 타임스탬프
    });
    
    console.log(`Saved new document with ID: ${doc._id} (isModification: ${isModification})`);
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

// 8) 페이지 히스토리 조회 (선택적 기능)
app.get('/api/history/:id', async (req, res) => {
  try {
    const doc = await Page.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    
    return res.json({
      originalPrompt: doc.originalPrompt || doc.prompt,
      created: doc.created,
      modifications: doc.modifications,
      currentHtml: doc.html
    });
  } catch (err) {
    console.error('History error:', err);
    return res.status(500).json({ error: 'Error fetching history' });
  }
});

// 9) 포트 바인딩 (Render용 포트 지원)
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));