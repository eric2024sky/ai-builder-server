// ai-builder-server/index.js

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// ─── 미들웨어 설정 ──────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── MongoDB 연결 ───────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB 연결 성공'))
  .catch(err => console.error('❌ MongoDB 연결 실패:', err));

// ─── 페이지 저장 스키마 ─────────────────────────────────
const PageSchema = new mongoose.Schema({
  prompt: String,
  html: String,
  createdAt: { type: Date, default: Date.now },
  isModification: { type: Boolean, default: false },
  originalPrompt: String,
  isHierarchical: { type: Boolean, default: false },
  hierarchicalData: {
    totalLayers: Number,
    layers: [{
      name: String,
      description: String,
      prompt: String,
      html: String
    }]
  }
});

const Page = mongoose.model('Page', PageSchema);

// ─── Anthropic 클라이언트 초기화 ───────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── 계층적 생성 전략 판단 함수 ────────────────────────
const shouldUseHierarchicalGeneration = (prompt) => {
  const complexityKeywords = [
    '복잡한', '대규모', '많은 페이지', '섹션이 많은', '상세한',
    '완전한', '전체', '포트폴리오', '쇼핑몰', 'e-commerce',
    '블로그', '회사 홈페이지', '랜딩페이지', '다중 페이지',
    '관리자', 'dashboard', '대시보드', '시스템'
  ];
  
  const lengthThreshold = 100; // 프롬프트 길이 기준
  const hasComplexityKeywords = complexityKeywords.some(keyword => 
    prompt.toLowerCase().includes(keyword.toLowerCase())
  );
  
  return hasComplexityKeywords || prompt.length > lengthThreshold;
};

// ─── 계층적 생성 계획 생성 함수 ────────────────────────
const generateHierarchicalPlan = async (prompt) => {
  const planningPrompt = `
사용자의 요청: "${prompt}"

이 요청을 분석하여 효율적인 계층적 생성 계획을 수립해주세요.

다음 JSON 형태로 응답해주세요:
{
  "needsHierarchical": true/false,
  "reason": "계층적 생성이 필요한 이유 또는 불필요한 이유",
  "layers": [
    {
      "name": "레이어 이름",
      "description": "이 레이어에서 수행할 작업",
      "prompt": "이 레이어 생성을 위한 구체적인 프롬프트"
    }
  ]
}

계층 분할 원칙:
1. 기본 구조 (HTML 골격, 기본 CSS)
2. 주요 컴포넌트 (헤더, 네비게이션, 메인 섹션)
3. 세부 컨텐츠 (상세 내용, 이미지, 텍스트)
4. 고급 기능 (인터랙션, 애니메이션, 반응형)
5. 최적화 및 폴리싱

각 레이어는 토큰 제한(4000토큰)을 고려하여 적절한 크기로 나누세요.
간단한 요청의 경우 needsHierarchical을 false로 설정하세요.
`;

  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: planningPrompt
      }]
    });

    const planText = response.content[0].text;
    console.log('계층적 계획 응답:', planText);

    // JSON 추출 및 파싱
    const jsonMatch = planText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const plan = JSON.parse(jsonMatch[0]);
      return plan;
    }
    
    throw new Error('유효한 JSON 계획을 생성하지 못했습니다');
  } catch (error) {
    console.error('계층적 계획 생성 오류:', error);
    return { needsHierarchical: false, reason: '계획 생성 실패' };
  }
};

// ─── 토큰 사용량 최적화 함수 ──────────────────────────
const optimizePromptForTokens = (prompt, isModification = false, previousHtml = '') => {
  // 수정 요청의 경우 이전 HTML을 요약하여 토큰 절약
  if (isModification && previousHtml) {
    const htmlSummary = summarizeHtml(previousHtml);
    return {
      optimizedPrompt: prompt,
      context: `이전 HTML 요약: ${htmlSummary}`,
      estimatedTokens: calculateTokenEstimate(prompt + htmlSummary)
    };
  }
  
  return {
    optimizedPrompt: prompt,
    context: '',
    estimatedTokens: calculateTokenEstimate(prompt)
  };
};

// ─── HTML 요약 함수 ─────────────────────────────────────
const summarizeHtml = (html) => {
  try {
    // HTML에서 주요 구조만 추출
    const structureSummary = html
      .replace(/<style[\s\S]*?<\/style>/gi, '[CSS스타일]')
      .replace(/<script[\s\S]*?<\/script>/gi, '[JavaScript]')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s+/g, ' ')
      .substring(0, 500); // 최대 500자로 제한
    
    return structureSummary + (html.length > 500 ? '...' : '');
  } catch (error) {
    return '이전 HTML 구조 요약 실패';
  }
};

// ─── 토큰 추정 함수 ─────────────────────────────────────
const calculateTokenEstimate = (text) => {
  // 대략적인 토큰 추정 (1토큰 ≈ 4자)
  return Math.ceil(text.length / 4);
};

// ─── 헬스체크 및 상태 확인 API ─────────────────────────
app.get('/api/health', (req, res) => {
  const healthInfo = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    anthropic: !!process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing',
    model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
    memoryUsage: process.memoryUsage(),
    activeConnections: 0 // TODO: 실제 연결 수 추적
  };
  
  res.json(healthInfo);
});

// ─── 연결 테스트 API ───────────────────────────────────
app.get('/api/test-connection', async (req, res) => {
  try {
    // Anthropic API 테스트
    const testResponse = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hello' }]
    });
    
    res.json({
      success: true,
      anthropic: 'working',
      model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      testResponse: testResponse.content[0].text
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      anthropic: 'failed'
    });
  }
});

// ─── 스트리밍 HTML 생성 API ─────────────────────────────
app.get('/api/stream', async (req, res) => {
  const { 
    message, 
    isModification = 'false', 
    currentHtml = '',
    isHierarchical = 'false',
    layerIndex = '0',
    totalLayers = '1'
  } = req.query;

  console.log('스트림 요청:', {
    message,
    isModification: isModification === 'true',
    hasCurrentHtml: !!currentHtml,
    isHierarchical: isHierarchical === 'true',
    layerIndex: parseInt(layerIndex),
    totalLayers: parseInt(totalLayers)
  });

  // ─── SSE 헤더 설정 ──────────────────────────────────
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  const sendEvent = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      console.error('Event send error:', error);
    }
  };

  const sendMessage = (content) => {
    try {
      res.write(`data: ${content}\n\n`);
    } catch (error) {
      console.error('Message send error:', error);
    }
  };

  const sendPing = () => {
    sendEvent({ type: 'ping', timestamp: Date.now() });
  };

  // ─── 주기적 ping 전송 (연결 유지) ──────────────────────
  const pingInterval = setInterval(sendPing, 10000); // 10초마다

  // ─── 연결 정리 함수 ────────────────────────────────────
  const cleanup = () => {
    clearInterval(pingInterval);
    if (!res.headersSent) {
      res.end();
    }
  };

  // ─── 클라이언트 연결 해제 감지 ─────────────────────────
  req.on('close', () => {
    console.log('클라이언트 연결 해제');
    cleanup();
  });

  req.on('aborted', () => {
    console.log('요청 중단됨');
    cleanup();
  });

  try {
    // ─── 계층적 생성이 아닌 경우 계획 단계 ─────────────
    if (isHierarchical === 'false' && isModification === 'false') {
      // 계층적 생성 필요성 판단
      if (shouldUseHierarchicalGeneration(message)) {
        console.log('계층적 생성 필요성 감지, 계획 생성 중...');
        
        const hierarchicalPlan = await generateHierarchicalPlan(message);
        
        if (hierarchicalPlan.needsHierarchical && hierarchicalPlan.layers?.length > 1) {
          console.log('계층적 생성 계획:', hierarchicalPlan);
          
          // 계층적 생성 계획을 클라이언트에 전송
          sendMessage(`[HIERARCHICAL_PLAN]${JSON.stringify(hierarchicalPlan)}`);
          sendMessage('[DONE]');
          return;
        }
      }
    }

    // ─── 프롬프트 최적화 ────────────────────────────────
    const optimized = optimizePromptForTokens(
      message, 
      isModification === 'true', 
      currentHtml
    );

    console.log(`토큰 추정량: ${optimized.estimatedTokens}`);

    // ─── AI 프롬프트 구성 ───────────────────────────────
    let systemPrompt = '';
    let userPrompt = '';

    if (isHierarchical === 'true') {
      // 계층적 생성 모드
      const layerNum = parseInt(layerIndex) + 1;
      const totalNum = parseInt(totalLayers);
      
      systemPrompt = `당신은 웹사이트를 계층적으로 생성하는 전문가입니다.

현재 진행 상황: ${layerNum}/${totalNum} 레이어
이전 HTML 컨텍스트: ${currentHtml ? '제공됨' : '없음'}

지침:
1. 현재 레이어에 집중하여 완성도 높은 HTML/CSS 생성
2. 이전 레이어와 자연스럽게 통합되도록 구성
3. 다음 레이어를 위한 확장 가능한 구조 제공
4. 토큰 제한을 고려하여 효율적으로 생성
5. 완전한 HTML 문서 형태로 응답

응답 형식: 완전한 HTML 문서만 생성하세요. 설명이나 주석은 최소화하세요.`;

      userPrompt = currentHtml 
        ? `이전 HTML을 기반으로 다음 요청을 수행해주세요:

요청: ${optimized.optimizedPrompt}

기존 HTML:
${currentHtml.substring(0, 2000)}${currentHtml.length > 2000 ? '\n...(truncated)' : ''}

위 HTML을 확장하고 개선하여 완전한 HTML 문서를 생성해주세요.`
        : optimized.optimizedPrompt;

    } else if (isModification === 'true') {
      // 수정 모드
      systemPrompt = `당신은 HTML/CSS 수정 전문가입니다. 기존 코드를 분석하고 요청된 수정사항을 정확히 적용하세요.

지침:
1. 기존 HTML 구조와 스타일을 최대한 보존
2. 요청된 수정사항만 정확히 적용
3. 수정 후에도 완전히 작동하는 HTML 문서 유지
4. 불필요한 변경 최소화

응답 형식: 수정된 완전한 HTML 문서만 제공하세요.`;

      userPrompt = `다음 HTML을 수정해주세요:

수정 요청: ${optimized.optimizedPrompt}

${optimized.context}

기존 HTML:
${currentHtml.substring(0, 3000)}${currentHtml.length > 3000 ? '\n...(truncated)' : ''}

위의 수정 요청에 따라 HTML을 수정하여 완전한 문서로 제공해주세요.`;

    } else {
      // 새 생성 모드
      systemPrompt = `당신은 뛰어난 웹 개발자입니다. 사용자의 요청에 따라 완전하고 아름다운 HTML/CSS 웹페이지를 생성하세요.

지침:
1. 완전한 HTML 문서 (DOCTYPE, html, head, body 포함)
2. 내장 CSS 스타일 사용 (external 파일 금지)
3. 반응형 디자인 적용
4. 모던하고 깔끔한 디자인
5. 접근성 고려 (alt 텍스트, semantic HTML)
6. 실제 운영 가능한 수준의 완성도

응답 형식: HTML 코드만 제공하고, 설명은 최소화하세요.`;

      userPrompt = optimized.optimizedPrompt;
    }

    // ─── Anthropic API 스트리밍 요청 ────────────────────
    const stream = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: userPrompt
      }],
      stream: true
    });

    // ─── 스트리밍 데이터 처리 ───────────────────────────
    let accumulatedContent = '';
    let tokenCount = 0;
    let lastSendTime = Date.now();
    
    // 초기 상태 전송
    sendEvent({ type: 'status', message: 'AI 응답 생성 시작...' });
    
    for await (const chunk of stream) {
      // 연결 상태 확인
      if (res.destroyed || !res.writable) {
        console.log('클라이언트 연결 끊어짐, 스트림 중단');
        break;
      }
      
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        const textPiece = chunk.delta.text;
        accumulatedContent += textPiece;
        tokenCount++;
        
        // 클라이언트에 직접 텍스트 스트리밍 전송 (OpenAI 형식)
        sendEvent({
          choices: [{
            delta: {
              content: textPiece
            }
          }]
        });
        
        // 주기적 상태 업데이트 (3초마다)
        const now = Date.now();
        if (now - lastSendTime > 3000) {
          sendEvent({ 
            type: 'progress', 
            chars: accumulatedContent.length,
            tokens: tokenCount,
            timestamp: now
          });
          lastSendTime = now;
        }
      }
      
      // 스트림 완료 감지
      if (chunk.type === 'message_stop') {
        break;
      }
    }

    // ─── 스트림 완료 처리 ───────────────────────────────
    console.log(`스트리밍 완료 - 총 ${accumulatedContent.length}자, ${tokenCount}토큰 생성`);
    
    // 완료 상태 전송
    sendEvent({ 
      type: 'completion', 
      totalChars: accumulatedContent.length,
      totalTokens: tokenCount,
      success: true
    });
    
    // 스트림 종료 신호
    sendMessage('[DONE]');
    
    // 정리
    cleanup();

  } catch (error) {
    console.error('스트리밍 오류:', error);
    
    // 오류 세부 정보 포함
    const errorDetails = {
      error: error.message || '알 수 없는 오류가 발생했습니다',
      type: error.type || 'unknown_error',
      timestamp: new Date().toISOString(),
      requestInfo: {
        message: message?.substring(0, 100),
        isModification: isModification === 'true',
        isHierarchical: isHierarchical === 'true'
      }
    };
    
    sendEvent(errorDetails);
    cleanup();
    sendMessage('[DONE]');
  }
});

// ─── 페이지 저장 API ────────────────────────────────────
app.post('/api/save', async (req, res) => {
  try {
    const { 
      prompt, 
      html, 
      isModification = false, 
      originalPrompt,
      isHierarchical = false,
      hierarchicalData = null
    } = req.body;

    const page = new Page({
      prompt,
      html,
      isModification,
      originalPrompt: originalPrompt || prompt,
      isHierarchical,
      hierarchicalData
    });

    await page.save();
    
    console.log(`페이지 저장 완료: ${page._id}`);
    res.json({ 
      success: true, 
      id: page._id,
      isHierarchical,
      layerCount: hierarchicalData?.totalLayers || 1
    });

  } catch (error) {
    console.error('페이지 저장 오류:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ─── 페이지 미리보기 API ────────────────────────────────
app.get('/preview/:id', async (req, res) => {
  try {
    const page = await Page.findById(req.params.id);
    
    if (!page) {
      return res.status(404).send(`
        <html>
          <body style="font-family: Arial; text-align: center; padding: 50px;">
            <h1>404 - 페이지를 찾을 수 없습니다</h1>
            <p>요청하신 페이지가 존재하지 않습니다.</p>
          </body>
        </html>
      `);
    }

    // HTML에 메타데이터 추가
    const enhancedHtml = page.html.replace(
      '<head>',
      `<head>
        <meta name="generator" content="AI Web Builder">
        <meta name="created" content="${page.createdAt.toISOString()}">
        <meta name="hierarchical" content="${page.isHierarchical}">
        ${page.isHierarchical ? `<meta name="layers" content="${page.hierarchicalData?.totalLayers || 1}">` : ''}
      `
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(enhancedHtml);

  } catch (error) {
    console.error('미리보기 오류:', error);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1>500 - 서버 오류</h1>
          <p>페이지를 불러오는 중 오류가 발생했습니다.</p>
        </body>
      </html>
    `);
  }
});

// ─── 페이지 목록 API (선택사항) ──────────────────────────
app.get('/api/pages', async (req, res) => {
  try {
    const { page = 1, limit = 20, hierarchical } = req.query;
    
    const query = {};
    if (hierarchical !== undefined) {
      query.isHierarchical = hierarchical === 'true';
    }

    const pages = await Page.find(query)
      .select('prompt createdAt isModification isHierarchical hierarchicalData._id')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Page.countDocuments(query);

    res.json({
      success: true,
      pages,
      pagination: {
        current: parseInt(page),
        total: Math.ceil(total / limit),
        hasNext: page * limit < total
      }
    });

  } catch (error) {
    console.error('페이지 목록 조회 오류:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ─── 서버 시작 ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 서버가 포트 ${PORT}에서 실행 중입니다`);
  console.log(`📊 MongoDB: ${process.env.MONGODB_URI ? '연결됨' : '설정 필요'}`);
  console.log(`🤖 Anthropic API: ${process.env.ANTHROPIC_API_KEY ? '설정됨' : '설정 필요'}`);
  console.log(`🧠 사용 모델: ${process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307'}`);
  
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY가 설정되지 않았습니다!');
  }
});

// ─── 우아한 종료 처리 ───────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n🛑 서버 종료 중...');
  await mongoose.connection.close();
  console.log('✅ MongoDB 연결 해제 완료');
  process.exit(0);
});