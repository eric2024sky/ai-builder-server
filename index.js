// ai-builder-server/index.js
// 수정 계획 수립 기능이 포함된 완전한 버전

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Anthropic from '@anthropic-ai/sdk';
import archiver from 'archiver';
import { Readable } from 'stream';
import logger, { logHistory } from './logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

// ES modules에서 __dirname 구현
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// 로깅 시스템은 logger.js에서 import됨

// ─── 미들웨어 설정 ──────────────────────────────────────
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 정적 파일 서빙 설정 - 이미지, CSS, JS 등의 리소스를 제공
app.use('/static', express.static('public'));
app.use('/images', express.static('public/images'));

app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// ─── MongoDB 연결 ───────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
  .then(() => logger.info('MongoDB 연결 성공'))
  .catch(err => logger.error('MongoDB 연결 실패', err));

// ─── 페이지 저장 스키마 ─────────
const PageSchema = new mongoose.Schema({
  prompt: String,
  html: String,
  originalHtml: String,
  createdAt: { type: Date, default: Date.now },
  isModification: { type: Boolean, default: false },
  originalPrompt: String,
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
  pageName: { type: String, default: 'index' },
  pageType: { type: String, enum: ['main', 'sub'], default: 'main' },
  sectionIndex: Number,
  totalSections: Number
});

// ─── 프로젝트 스키마 ─────────
const ProjectSchema = new mongoose.Schema({
  name: String,
  description: String,
  createdAt: { type: Date, default: Date.now },
  generationType: { type: String, enum: ['single', 'multi', 'long', 'hierarchical'] },
  pages: [{
    pageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Page' },
    pageName: String,
    isMainPage: { type: Boolean, default: false }
  }],
  plannedPages: [String],
  designSystem: {
    primaryColor: String,
    secondaryColor: String,
    fontFamily: String,
    headerStyle: String
  }
});

const Page = mongoose.model('Page', PageSchema);
const Project = mongoose.model('Project', ProjectSchema);

// ─── Anthropic 클라이언트 초기화 ───────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});





// ─── 2단계 Plan 기반 워크플로우 함수들 ─────────────

// JSON 추출 및 파싱 헬퍼 함수
const extractAndParseJSON = (text) => {
  // 다양한 형태의 JSON을 추출하고 파싱하는 강건한 함수
  
  // 1. 코드블록 내의 JSON 추출 시도
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      return parsed;
    } catch (e) {
      // 이 코드블록은 JSON이 아님, 계속 진행
    }
  }
  
  // 2. 중첩된 중괄호를 올바르게 처리하는 JSON 추출
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escapeNext = false;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    // 문자열 내부 처리
    if (!escapeNext && char === '"' && (i === 0 || text[i-1] !== '\\')) {
      inString = !inString;
    }
    
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    
    // 문자열 밖에서만 중괄호 카운트
    if (!inString) {
      if (char === '{') {
        if (depth === 0) {
          startIndex = i;
        }
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && startIndex !== -1) {
          // 완전한 JSON 객체를 찾음
          const jsonStr = text.substring(startIndex, i + 1);
          try {
            const parsed = JSON.parse(jsonStr);
            return parsed;
          } catch (e) {
            // 유효한 JSON이 아님, 계속 검색
            startIndex = -1;
          }
        }
      }
    }
  }
  
  // 3. 간단한 정규식 매칭 시도 (fallback)
  const simpleMatch = text.match(/\{[\s\S]*\}/);
  if (simpleMatch) {
    try {
      const parsed = JSON.parse(simpleMatch[0]);
      return parsed;
    } catch (e) {
      // 파싱 실패
    }
  }
  
  // 4. JSON 배열 추출 시도
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      return parsed;
    } catch (e) {
      // 파싱 실패
    }
  }
  
  // JSON을 찾을 수 없음
  throw new Error('응답에서 유효한 JSON을 추출할 수 없습니다. 응답 텍스트: ' + text.substring(0, 200) + '...');
};



// 1단계: 니즈 분석 plan 함수
const createNeedsAnalysisPlan = async (userRequest) => {
  // 수정 요청 구분 (프론트엔드에서 결합된 프롬프트 분리)
  let baseRequest = userRequest;
  let modificationRequest = null;
  
  const modificationMatch = userRequest.match(/(.+)\n\n다음 수정사항을 적용해주세요:\n(.+)/s);
  if (modificationMatch) {
    baseRequest = modificationMatch[1];
    modificationRequest = modificationMatch[2];
    logger.info('수정 요청 감지', { 
      baseRequest: baseRequest.substring(0, 50),
      modificationRequest: modificationRequest.substring(0, 50)
    });
  }
  
  const analysisPrompt = `
사용자의 웹사이트 요청을 분석하여 주요 기능, 디자인 언어, 컴포넌트 구성 방안을 수립해주세요.

${modificationRequest ? `원본 요청: "${baseRequest}"
수정 요청: "${modificationRequest}"
수정사항을 반영하여 분석해주세요.` : `사용자 요청: "${userRequest}"`}

다음 JSON 형식으로 응답해주세요:
{
  "projectName": "프로젝트명 (간단하고 명확하게)",
  "description": "프로젝트 설명 (1-2문장)",
  "features": [
    "주요 기능 1",
    "주요 기능 2",
    "..."
  ],
  "designSystem": {
    "colors": {
      "primary": "#색상코드",
      "secondary": "#색상코드", 
      "accent": "#색상코드",
      "background": "#색상코드",
      "text": "#색상코드"
    },
    "typography": {
      "headingFont": "폰트명",
      "bodyFont": "폰트명",
      "sizes": {
        "h1": "크기",
        "h2": "크기",
        "body": "크기"
      }
    },
    "spacing": {
      "unit": "8px",
      "scale": [0.5, 1, 1.5, 2, 3, 4, 6, 8]
    }
  },
  "components": [
    "Header",
    "Navigation", 
    "Hero",
    "..."
  ],
  "siteType": "landing|portfolio|ecommerce|blog|corporate|other",
  "complexity": "simple|medium|complex",
  "estimatedPages": 숫자
}

분석 기준:
- features: 사용자가 요청한 핵심 기능들을 추출
- designSystem: 요청에서 언급된 스타일이나 일반적인 사이트 타입에 맞는 디자인 시스템
- components: 기능 구현에 필요한 UI 컴포넌트 목록
- complexity: simple(단순 정보 전달), medium(인터랙션 포함), complex(복잡한 기능)`;

  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: analysisPrompt
      }]
    });

    const analysisText = response.content[0].text;
    logger.debug('니즈 분석 응답', analysisText);

    try {
      const analysis = extractAndParseJSON(analysisText);
      return {
        success: true,
        analysis
      };
    } catch (parseError) {
      logger.error('JSON 파싱 오류', { 
        error: parseError.message,
        responseText: analysisText.substring(0, 500) 
      });
      throw new Error(`니즈 분석 JSON 파싱 실패: ${parseError.message}`);
    }
  } catch (error) {
    logger.error('니즈 분석 오류', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// 2단계: 아키텍처 plan 함수
const createArchitecturePlan = async (needsAnalysis) => {
  const architecturePrompt = `
다음 니즈 분석을 기반으로 구체적인 웹사이트 아키텍처를 설계해주세요.

니즈 분석:
${JSON.stringify(needsAnalysis, null, 2)}

다음 JSON 형식으로 응답해주세요:
{
  "layout": {
    "type": "grid|flex|hybrid",
    "structure": "header-main-footer|sidebar-content|custom",
    "responsive": {
      "breakpoints": {
        "mobile": "768px",
        "tablet": "1024px", 
        "desktop": "1440px"
      }
    }
  },
  "commonComponents": [
    {
      "name": "Header",
      "description": "사이트 헤더",
      "props": {
        "logo": "텍스트 또는 이미지",
        "navigation": "메뉴 항목 배열"
      },
      "styles": {
        "position": "fixed|relative",
        "background": "색상",
        "height": "크기"
      }
    }
  ],
  "pages": [
    {
      "name": "index",
      "title": "홈페이지",
      "components": [
        {
          "type": "Hero",
          "props": {
            "title": "제목",
            "subtitle": "부제목",
            "cta": "버튼 텍스트"
          }
        }
      ],
      "layout": "vertical|grid|custom"
    }
  ],
  "componentHierarchy": {
    "global": ["Header", "Footer"],
    "pageSpecific": {
      "index": ["Hero", "Features", "Testimonials"]
    }
  },
  "generationStrategy": {
    "approach": "component-based",
    "order": ["global", "layout", "page-specific"],
    "reusePatterns": ["헤더 네비게이션", "푸터 링크"]
  }
}`;

  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: architecturePrompt
      }]
    });

    const architectureText = response.content[0].text;
    logger.debug('아키텍처 plan 응답', architectureText);

    try {
      const architecture = extractAndParseJSON(architectureText);
      return {
        success: true,
        architecture
      };
    } catch (parseError) {
      logger.error('JSON 파싱 오류', { 
        error: parseError.message,
        responseText: architectureText.substring(0, 500) 
      });
      throw new Error(`아키텍처 plan JSON 파싱 실패: ${parseError.message}`);
    }
  } catch (error) {
    logger.error('아키텍처 plan 오류', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// 2-1단계: 기본 아키텍처 구조만 생성
const createBaseArchitecture = async (needsAnalysis) => {
  const baseArchitecturePrompt = `
다음 니즈 분석을 기반으로 웹사이트의 기본 구조만 설계해주세요.

니즈 분석:
${JSON.stringify(needsAnalysis, null, 2)}

다음 JSON 형식으로 간단하게 응답해주세요:
{
  "layout": {
    "type": "grid|flex|hybrid",
    "structure": "header-main-footer|sidebar-content|custom"
  },
  "globalComponents": ["Header", "Footer", "Navigation"],
  "pageCount": 1,
  "mainFeatures": ["feature1", "feature2"]
}

주의: 세부사항은 제외하고 기본 구조만 포함해주세요.`;

  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      max_tokens: 1000, // 작은 토큰으로 충분
      messages: [{
        role: 'user',
        content: baseArchitecturePrompt
      }]
    });

    const baseArchitectureText = response.content[0].text;
    logger.debug('기본 아키텍처 응답', { length: baseArchitectureText.length });

    try {
      const baseArchitecture = extractAndParseJSON(baseArchitectureText);
      return {
        success: true,
        baseArchitecture
      };
    } catch (parseError) {
      logger.error('기본 아키텍처 JSON 파싱 오류', { 
        error: parseError.message,
        responseText: baseArchitectureText.substring(0, 300) 
      });
      throw new Error(`기본 아키텍처 JSON 파싱 실패: ${parseError.message}`);
    }
  } catch (error) {
    logger.error('기본 아키텍처 생성 오류', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// 2-2단계: 전역 컴포넌트 세부사항 생성
const createGlobalComponentDetails = async (baseArchitecture, needsAnalysis) => {
  const components = [];
  
  for (const componentName of baseArchitecture.globalComponents) {
    const componentPrompt = `
다음 전역 컴포넌트의 세부사항을 설계해주세요.

컴포넌트 이름: ${componentName}
사이트 유형: ${needsAnalysis.siteType}
디자인 시스템: ${JSON.stringify(needsAnalysis.designSystem, null, 2)}

다음 JSON 형식으로 응답해주세요:
{
  "name": "${componentName}",
  "description": "컴포넌트 설명",
  "props": {
    "속성명": "속성 설명"
  },
  "styles": {
    "주요스타일": "값"
  }
}`;

    try {
      const response = await anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: componentPrompt
        }]
      });

      const componentText = response.content[0].text;
      const component = extractAndParseJSON(componentText);
      components.push(component);
      
    } catch (error) {
      logger.error(`${componentName} 컴포넌트 생성 오류`, error);
      // 실패해도 기본 구조로 계속 진행
      components.push({
        name: componentName,
        description: `${componentName} 컴포넌트`,
        props: {},
        styles: {}
      });
    }
  }
  
  return components;
};

// 2-3단계: 페이지별 구조 설계
const createPageStructures = async (baseArchitecture, needsAnalysis) => {
  const pagePrompt = `
다음 웹사이트의 메인 페이지 구조를 설계해주세요.

사이트 정보:
- 프로젝트: ${needsAnalysis.projectName}
- 주요 기능: ${needsAnalysis.features.join(', ')}
- 레이아웃: ${baseArchitecture.layout.type}

다음 JSON 형식으로 응답해주세요:
{
  "name": "index",
  "title": "홈페이지",
  "components": [
    {
      "type": "컴포넌트타입",
      "props": {
        "속성": "값"
      }
    }
  ]
}

주의: 최대 5개의 핵심 컴포넌트만 포함해주세요.`;

  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: pagePrompt
      }]
    });

    const pageText = response.content[0].text;
    const page = extractAndParseJSON(pageText);
    
    return {
      success: true,
      pages: [page]
    };
  } catch (error) {
    logger.error('페이지 구조 생성 오류', error);
    // 기본 페이지 구조 반환
    return {
      success: true,
      pages: [{
        name: "index",
        title: "홈페이지",
        components: [
          { type: "Hero", props: { title: needsAnalysis.projectName } },
          { type: "Features", props: { features: needsAnalysis.features } }
        ]
      }]
    };
  }
};

// 개선된 아키텍처 plan 함수 - 계층적으로 생성
const createArchitecturePlanHierarchical = async (needsAnalysis, onProgress) => {
  try {
    // 2-1: 기본 구조
    if (onProgress) onProgress('architecturePhase', { phase: '기본 구조', current: 1, total: 3 });
    const baseResult = await createBaseArchitecture(needsAnalysis);
    if (!baseResult.success) {
      throw new Error('기본 아키텍처 생성 실패');
    }
    
    // 2-2: 전역 컴포넌트
    if (onProgress) onProgress('architecturePhase', { phase: '전역 컴포넌트', current: 2, total: 3 });
    const globalComponents = await createGlobalComponentDetails(baseResult.baseArchitecture, needsAnalysis);
    
    // 2-3: 페이지 구조
    if (onProgress) onProgress('architecturePhase', { phase: '페이지 구조', current: 3, total: 3 });
    const pagesResult = await createPageStructures(baseResult.baseArchitecture, needsAnalysis);
    
    // 최종 아키텍처 조합
    const architecture = {
      layout: {
        ...baseResult.baseArchitecture.layout,
        responsive: {
          breakpoints: {
            mobile: "768px",
            tablet: "1024px",
            desktop: "1440px"
          }
        }
      },
      commonComponents: globalComponents,
      pages: pagesResult.pages,
      componentHierarchy: {
        global: baseResult.baseArchitecture.globalComponents,
        pageSpecific: {
          index: pagesResult.pages[0].components.map(c => c.type)
        }
      },
      generationStrategy: {
        approach: "component-based",
        order: ["global", "layout", "page-specific"]
      }
    };
    
    return {
      success: true,
      architecture
    };
    
  } catch (error) {
    logger.error('계층적 아키텍처 생성 오류', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// 3단계: 컴포넌트 생성 및 조립 함수
const generateComponentHTML = async (component, designSystem) => {
  const componentPrompt = `
다음 컴포넌트의 HTML과 CSS를 생성해주세요.

컴포넌트 정보:
${JSON.stringify(component, null, 2)}

디자인 시스템:
${JSON.stringify(designSystem, null, 2)}

요구사항:
1. 시맨틱 HTML 사용
2. BEM 명명법을 따르는 CSS 클래스
3. 반응형 디자인 고려
4. 접근성(ARIA) 속성 포함

HTML만 반환해주세요 (스타일은 별도로 처리됩니다).`;

  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: componentPrompt
      }]
    });

    return response.content[0].text;
  } catch (error) {
    logger.error('컴포넌트 HTML 생성 오류', error);
    throw error;
  }
};

const generateComponentCSS = async (component, designSystem, html) => {
  const cssPrompt = `
다음 HTML에 대한 CSS를 생성해주세요.

HTML:
${html}

컴포넌트 정보:
${JSON.stringify(component, null, 2)}

디자인 시스템:
${JSON.stringify(designSystem, null, 2)}

요구사항:
1. CSS Variables 사용
2. 모바일 우선 반응형 디자인
3. 부드러운 애니메이션과 전환 효과
4. 모던하고 깔끔한 스타일

CSS만 반환해주세요.`;

  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: cssPrompt
      }]
    });

    return response.content[0].text;
  } catch (error) {
    logger.error('컴포넌트 CSS 생성 오류', error);
    throw error;
  }
};

const assembleFullHTML = async (needsAnalysis, architecturePlan, components) => {
  const assemblyPrompt = `
컴포넌트들을 조립하여 완전한 HTML 문서를 만들어주세요.

프로젝트 정보:
- 이름: ${needsAnalysis.projectName}
- 타입: ${needsAnalysis.siteType}

아키텍처:
${JSON.stringify(architecturePlan.layout, null, 2)}

생성된 컴포넌트들:
${JSON.stringify(components.map(c => ({ name: c.name, html: c.html })), null, 2)}

요구사항:
1. <!DOCTYPE html>로 시작하는 완전한 HTML5 문서
2. 모든 CSS는 <style> 태그 내에 포함
3. 메타 태그 포함 (viewport, charset, description)
4. 시맨틱 HTML 구조
5. 컴포넌트들을 아키텍처에 맞게 배치
6. Font Awesome 아이콘 사용: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">

이미지 사용 가이드:
- 일반 이미지: Lorem Picsum (https://picsum.photos/1200/600)
- 프로필/아바타: UI Avatars (https://ui-avatars.com/api/?name=Name&background=random)`}
- 아이콘: Font Awesome 클래스 사용 (예: <i class="fas fa-home"></i>)
- 로고: 인라인 SVG로 생성

CRITICAL: 
- CSS link는 Font Awesome만 허용
- 로컬 이미지 경로 (/images/...) 사용 금지
- CSS와 JavaScript는 HTML 내부에 포함

완전한 HTML 문서만 반환해주세요.`;

  try {
    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: assemblyPrompt
      }]
    });

    return response.content[0].text;
  } catch (error) {
    logger.error('HTML 조립 오류', error);
    throw error;
  }
};

// 2단계 plan 실행 함수
const executeTwoStagePlan = async (userRequest, onProgress) => {
  try {
    // 1단계: 니즈 분석
    onProgress('stage', { stage: 1, message: '니즈 분석 중...' });
    const needsResult = await createNeedsAnalysisPlan(userRequest);
    
    if (!needsResult.success) {
      throw new Error('니즈 분석 실패: ' + needsResult.error);
    }
    
    // 이미지 검색 결과를 니즈 분석에 추가
    needsResult.analysis.availableImages = imageResults;
    
    onProgress('needsAnalysis', needsResult.analysis);
    
    // 2단계: 아키텍처 plan (계층적으로 생성)
    onProgress('stage', { stage: 2, message: '아키텍처 설계 중...' });
    const architectureResult = await createArchitecturePlanHierarchical(needsResult.analysis, onProgress);
    
    if (!architectureResult.success) {
      throw new Error('아키텍처 설계 실패: ' + architectureResult.error);
    }
    
    onProgress('architecture', architectureResult.architecture);
    
    // 3단계: 컴포넌트 생성
    onProgress('stage', { stage: 3, message: '컴포넌트 생성 중...' });
    const components = [];
    const allComponents = [
      ...(architectureResult.architecture.commonComponents || []),
      ...(architectureResult.architecture.pages?.[0]?.components || [])
    ];
    
    for (let i = 0; i < allComponents.length; i++) {
      const component = allComponents[i];
      onProgress('component', { 
        current: i + 1, 
        total: allComponents.length,
        name: component.name || component.type
      });
      
      const html = await generateComponentHTML(component, needsResult.analysis.designSystem);
      const css = await generateComponentCSS(component, needsResult.analysis.designSystem, html);
      
      components.push({
        name: component.name || component.type,
        html,
        css
      });
    }
    
    // 4단계: 조립
    onProgress('stage', { stage: 4, message: 'HTML 조립 중...' });
    const fullHTML = await assembleFullHTML(
      needsResult.analysis,
      architectureResult.architecture,
      components
    );
    
    return {
      success: true,
      html: fullHTML,
      needsAnalysis: needsResult.analysis,
      architecture: architectureResult.architecture,
      components
    };
    
  } catch (error) {
    logger.error('2단계 plan 실행 오류', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// ─── 범용 생성 계획 수립 함수 ─────────────
const createGenerationPlan = async (prompt) => {
  const planningPrompt = `
Analyze the user's request and create an optimal website generation strategy.

User request: "${prompt}"

Please respond in the following JSON format:
{
  "type": "single|multi|long|hierarchical",
  "projectName": "Project name",
  "description": "Project description",
  "reason": "Reason for choosing this strategy",
  "estimatedTokens": estimated total tokens,
  "plan": {
    // For type 'single'
    "prompt": "Specific prompt for page generation",
    
    // For type 'multi'
    "pages": [
      {
        "pageName": "Page name (English, lowercase, no spaces, first page must be 'index')",
        "title": "Page title",
        "description": "Page description",
        "isMainPage": true/false,
        "prompt": "Specific prompt for generating this page"
      }
    ],
    
    // For type 'long'
    "sections": [
      {
        "sectionName": "Section name",
        "description": "Section description",
        "prompt": "Specific prompt for generating this section"
      }
    ],
    
    // For type 'hierarchical'
    "layers": [
      {
        "name": "Layer name",
        "description": "Layer description",
        "prompt": "Specific prompt for generating this layer"
      }
    ]
  }
}

Strategy selection criteria:
- single: Simple single page (landing page, portfolio, etc.)
- multi: When multiple pages are needed (company website, blog, etc.)
- long: When a very long single page is needed (documentation, tutorials, etc.)
- hierarchical: When complex features or design are needed

For multi-page:
1. First page's pageName must always be 'index'
2. Page names should be simple, lowercase, without spaces (e.g., 'about', 'contact', 'services')
3. Each page should have consistent navigation links to all other pages
4. Make sure the number of planned pages matches what the user requested

IMPORTANT: If user requests specific number of pages (e.g., "5 pages"), make sure to generate exactly that many pages.`;

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
    logger.debug('생성 계획 응답', planText);

    const jsonMatch = planText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const plan = JSON.parse(jsonMatch[0]);
      
      if (plan.type === 'multi' && plan.plan?.pages?.length > 0) {
        plan.plan.pages[0].pageName = 'index';
        plan.plan.pages[0].isMainPage = true;
        
        const allPageNames = plan.plan.pages.map(p => p.pageName);
        
        const designGuidelines = `

CRITICAL DESIGN REQUIREMENTS - YOU MUST FOLLOW THESE EXACTLY:

1. COLOR SCHEME (MUST BE IDENTICAL ON ALL PAGES):
   - Header background: #2c3e50 (dark blue-gray)
   - Header text: #ffffff (white)
   - Navigation links: #ffffff (white)
   - Active/hover navigation: #34495e (darker shade)
   - Body background: #f4f4f4 (light gray)
   - Main content background: #ffffff (white)
   - Text color: #333333 (dark gray)
   - Footer background: #2c3e50 (same as header)
   - Footer text: #ffffff (white)

2. LAYOUT STRUCTURE (MUST BE IDENTICAL ON ALL PAGES):
   - Header: Fixed height with padding: 20px
   - Navigation: Centered horizontally, links with padding: 10px 20px
   - Main content: max-width: 1200px, margin: 0 auto, padding: 40px 20px
   - Footer: padding: 20px, text-align: center

3. TYPOGRAPHY (MUST BE IDENTICAL ON ALL PAGES):
   - Font family: Arial, sans-serif
   - H1: font-size: 36px, margin-bottom: 30px
   - H2: font-size: 28px, margin-bottom: 20px
   - Paragraph: line-height: 1.6

4. NAVIGATION STRUCTURE:
   The navigation must include these exact links on EVERY page:
   - For the home/index page: Use the project root URL (without /index)
   - For other pages: Use page names without .html extension
   
   Example navigation links:
   ${allPageNames.map(name => {
     if (name === 'index') {
       return '<a href="./">Home</a>';
     } else {
       return `<a href="${name}">${name.charAt(0).toUpperCase() + name.slice(1)}</a>`;
     }
   }).join('\n   ')}

5. ACTIVE PAGE INDICATOR:
   - Add class="active" to the current page's navigation link
   - Active link should have different background color (#34495e)

6. HTML STRUCTURE (MUST BE CONSISTENT):
   <!DOCTYPE html>
   <html lang="en">
   <head>
     <meta charset="UTF-8">
     <meta name="viewport" content="width=device-width, initial-scale=1.0">
     <title>[Page Title]</title>
     <style>[EXACT SAME STYLES]</style>
   </head>
   <body>
     <header>
       <nav>
         <ul>
           [NAVIGATION LINKS]
         </ul>
       </nav>
     </header>
     <main>
       [PAGE CONTENT]
     </main>
     <footer>
       <p>&copy; 2023 [Project Name]. All rights reserved.</p>
     </footer>
   </body>
   </html>

IMPORTANT: 
- Do NOT use .html extension in navigation links
- For home/index page link, use "./" or just the project path
- Copy the EXACT CSS from the first page and use it on ALL other pages`;
        
        plan.plan.pages = plan.plan.pages.map((page, index) => {
          const navInstructions = allPageNames.map(name => {
            if (name === 'index') return 'Home link: "./"';
            return `${name.charAt(0).toUpperCase() + name.slice(1)} link: "${name}"`;
          }).join(', ');
          
          return {
            ...page,
            prompt: `${page.prompt}

NAVIGATION LINKS: ${navInstructions}
Current page: ${page.pageName} (mark as active)

${designGuidelines}

${index === 0 ? 
  'IMPORTANT: You are creating the FIRST page. The design you create here will be the template for ALL other pages.' : 
  'IMPORTANT: You MUST copy the EXACT design, colors, layout, and CSS from the index page. Only the main content should be different.'}`
          };
        });
        
        plan.plannedPages = allPageNames;
      }
      
      return plan;
    }
    
    throw new Error('유효한 JSON 계획을 생성하지 못했습니다');
  } catch (error) {
    logger.error('생성 계획 수립 오류', error);
    
    return {
      type: 'single',
      projectName: 'Website',
      description: prompt,
      reason: 'Default single page due to plan generation failure',
      estimatedTokens: 2000,
      plan: {
        prompt: prompt
      }
    };
  }
};

// ─── HTML 리소스 업데이트 함수 (링크 및 이미지 경로) ─────────────
const updateHtmlResources = (html, projectId, currentPageName, pages, plannedPages = null) => {
  try {
    if (!html || typeof html !== 'string') {
      logger.warn('유효하지 않은 HTML', { projectId, currentPageName });
      return html || '';
    }

    let updatedHtml = html;
    // 페이지 이름들을 소문자로 정규화하여 대소문자 구분 없이 비교
    const rawPageNames = plannedPages || pages.map(p => p.pageName || p.name);
    const allPageNames = rawPageNames.map(name => name ? name.toLowerCase() : '');
    const pageNameMap = {}; // 소문자 -> 원본 이름 매핑
    rawPageNames.forEach(name => {
      if (name) {
        pageNameMap[name.toLowerCase()] = name;
      }
    });
    
    logger.info('HTML 리소스 업데이트 시작', { 
      projectId,
      currentPageName,
      plannedPages: plannedPages,
      pagesFromProject: pages.map(p => p.pageName || p.name),
      allPageNames: allPageNames,
      allPageNamesCount: allPageNames.length,
      pageNameMap: pageNameMap
    });
    
    let updateCount = 0;
    
    // 변환 전 HTML에서 링크 추출 (디버깅용)
    const linksBefore = [];
    const linkPattern = /href=["']([^"']+)["']/gi;
    let linkMatch;
    while ((linkMatch = linkPattern.exec(html)) !== null) {
      linksBefore.push(linkMatch[1]);
    }
    logger.debug('변환 전 링크들', { 
      count: linksBefore.length,
      links: linksBefore.slice(0, 10) // 처음 10개만 표시
    });
    
    // 링크 처리
    const linkReplacements = [
      // /preview/{projectId}/index 형식의 잘못된 index 링크 처리
      { pattern: new RegExp(`href=["']/preview/${projectId}/index["']`, 'gi'), replacement: () => {
        updateCount++;
        logger.debug('잘못된 index 링크 수정', { 
          from: `/preview/${projectId}/index`,
          to: `/preview/${projectId}`
        });
        return `href="/preview/${projectId}"`;
      }},
      // .html 확장자가 있는 링크 처리 (이미 변환된 /preview/ 링크는 제외)
      { pattern: /href=["'](?!\/preview\/)([^"'#/]+)\.html["']/gi, replacement: (match, pageName) => {
        const pageNameLower = pageName.toLowerCase();
        logger.debug('HTML 링크 처리', { 
          match, 
          pageName,
          pageNameLower,
          isInPageList: allPageNames.includes(pageNameLower),
          allPageNames 
        });
        if (allPageNames.includes(pageNameLower)) {
          updateCount++;
          const originalPageName = pageNameMap[pageNameLower] || pageName;
          if (pageNameLower === 'index') {
            logger.debug('index.html -> 메인 페이지로 변환');
            return `href="/preview/${projectId}"`;
          }
          logger.debug(`${pageName}.html -> 하위 페이지로 변환: ${originalPageName}`);
          return `href="/preview/${projectId}/${originalPageName}"`;
        }
        return match;
      }},
      // 홈 링크 처리 (./ 또는 index) - 이미 변환된 링크는 제외
      { pattern: /href=["'](?!\/preview\/)(\.\/|index)["']/gi, replacement: (match) => {
        updateCount++;
        logger.debug('홈 링크 변환', { match });
        return `href="/preview/${projectId}"`;
      }},
      // 확장자 없는 페이지 이름 링크 처리 - 이미 변환된 /preview/ 링크와 절대 경로는 제외
      { pattern: /href=["'](?!\/preview\/|https?:\/\/|\/|#)([^"'#/]+)["']/gi, replacement: (match, pageName) => {
        // 추가 검증: 특수 문자나 이미 처리된 링크 제외
        const pageNameLower = pageName ? pageName.toLowerCase() : '';
        const shouldProcess = pageName && 
                             pageName.length > 0 &&
                             !pageName.includes('.') && 
                             !pageName.includes('/') &&
                             !pageName.includes(':') &&
                             allPageNames.includes(pageNameLower);
        
        logger.debug('확장자 없는 링크 처리', { 
          match, 
          pageName,
          pageNameLower,
          shouldProcess,
          isIndex: pageNameLower === 'index',
          isInPageList: allPageNames.includes(pageNameLower),
          pageNameLength: pageName.length
        });
        
        if (shouldProcess) {
          updateCount++;
          const originalPageName = pageNameMap[pageNameLower] || pageName;
          if (pageNameLower === 'index') {
            logger.debug('index -> 메인 페이지로 변환');
            return `href="/preview/${projectId}"`;
          }
          logger.debug(`${pageName} -> 하위 페이지로 변환: ${originalPageName}`);
          return `href="/preview/${projectId}/${originalPageName}"`;
        }
        return match;
      }}
    ];
    
    linkReplacements.forEach(({ pattern, replacement }) => {
      updatedHtml = updatedHtml.replace(pattern, replacement);
    });
    
    // onclick 이벤트가 있는 링크 처리
    updatedHtml = updatedHtml.replace(/onclick=["']location\.href=["']([^"']+)["']['"]?["']/gi, (match, url) => {
      // .html로 끝나는 경우
      if (url.endsWith('.html')) {
        const pageName = url.replace('.html', '');
        const pageNameLower = pageName.toLowerCase();
        if (allPageNames.includes(pageNameLower)) {
          updateCount++;
          const originalPageName = pageNameMap[pageNameLower] || pageName;
          if (pageNameLower === 'index') {
            logger.debug('onclick index.html -> 메인 페이지로 변환');
            return `onclick="location.href='/preview/${projectId}'"`;
          }
          logger.debug(`onclick ${pageName}.html -> 하위 페이지로 변환: ${originalPageName}`);
          return `onclick="location.href='/preview/${projectId}/${originalPageName}'"`;
        }
      }
      // 확장자 없는 페이지 이름
      else if (!url.startsWith('http') && !url.includes('.') && !url.includes('/')) {
        const urlLower = url.toLowerCase();
        if (allPageNames.includes(urlLower)) {
          updateCount++;
          const originalPageName = pageNameMap[urlLower] || url;
          if (urlLower === 'index') {
            logger.debug('onclick index -> 메인 페이지로 변환');
            return `onclick="location.href='/preview/${projectId}'"`;
          }
          logger.debug(`onclick ${url} -> 하위 페이지로 변환: ${originalPageName}`);
          return `onclick="location.href='/preview/${projectId}/${originalPageName}'"`;
        }
      }
      return match;
    });
    
    // JavaScript 네비게이션 함수 처리
    updatedHtml = updatedHtml.replace(/window\.location\.href\s*=\s*["']([^"']+)["']/gi, (match, url) => {
      if (url.endsWith('.html')) {
        const pageName = url.replace('.html', '');
        const pageNameLower = pageName.toLowerCase();
        if (allPageNames.includes(pageNameLower)) {
          updateCount++;
          const originalPageName = pageNameMap[pageNameLower] || pageName;
          if (pageNameLower === 'index') {
            logger.debug('window.location index.html -> 메인 페이지로 변환');
            return `window.location.href = '/preview/${projectId}'`;
          }
          logger.debug(`window.location ${pageName}.html -> 하위 페이지로 변환: ${originalPageName}`);
          return `window.location.href = '/preview/${projectId}/${originalPageName}'`;
        }
      }
      return match;
    });
    
    // 이미지 경로 처리
    const imageReplacements = [
      // 잘못된 로컬 이미지 경로를 Lorem Picsum으로 변환
      { pattern: /src=["'](\/images\/[^"']+)["']/gi, replacement: (match, imagePath) => {
        updateCount++;
        // 이미지 타입에 따라 적절한 크기 선택
        if (imagePath.includes('logo')) {
          return `src="https://picsum.photos/200/60"`;
        } else if (imagePath.includes('hero') || imagePath.includes('banner')) {
          return `src="https://picsum.photos/1200/600"`;
        } else if (imagePath.includes('user') || imagePath.includes('avatar') || imagePath.includes('profile')) {
          return `src="https://ui-avatars.com/api/?name=User&size=100&background=random"`;
        } else {
          return `src="https://picsum.photos/400/300"`;
        }
      }},
      // 상대 경로 images/도 Lorem Picsum으로 변환
      { pattern: /src=["'](?!https?:\/\/|data:|\/)(images\/[^"']+)["']/gi, replacement: (match, imagePath) => {
        updateCount++;
        return `src="https://picsum.photos/400/300"`;
      }}
    ];
    
    imageReplacements.forEach(({ pattern, replacement }) => {
      updatedHtml = updatedHtml.replace(pattern, replacement);
    });
    
    // 변환 후 HTML에서 링크 추출 (디버깅용)
    const linksAfter = [];
    const linkPatternAfter = /href=["']([^"']+)["']/gi;
    let linkMatchAfter;
    while ((linkMatchAfter = linkPatternAfter.exec(updatedHtml)) !== null) {
      linksAfter.push(linkMatchAfter[1]);
    }
    
    logger.info('HTML 리소스 업데이트 완료', { 
      projectId, 
      currentPageName,
      totalUpdates: updateCount,
      linksBefore: linksBefore.length,
      linksAfter: linksAfter.length,
      linksAfterSample: linksAfter.slice(0, 10) // 처음 10개만 표시
    });
    
    // 변경된 링크들 상세 로그
    if (updateCount > 0) {
      logger.debug('링크 변환 상세', {
        before: linksBefore.filter(link => !link.startsWith('/preview/')),
        after: linksAfter.filter(link => link.startsWith('/preview/'))
      });
    }
    
    return updatedHtml;
  } catch (error) {
    logger.error('HTML 리소스 업데이트 오류', error);
    return html;
  }
};

// 기존 함수명을 위한 별칭 (하위 호환성)
const updateHtmlLinks = updateHtmlResources;

// ─── 헬스체크 API ─────────────
app.get('/api/health', (req, res) => {
  const healthInfo = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    anthropic: !!process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing',
    model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307'
  };
  
  res.json(healthInfo);
});

// ─── 연결 테스트 API ─────────────
app.get('/api/test-connection', async (req, res) => {
  try {
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
    logger.error('연결 테스트 실패', error);
    res.status(500).json({
      success: false,
      error: error.message,
      anthropic: 'failed'
    });
  }
});

// ─── 로그 다운로드 API ─────────────
app.get('/api/logs/download', (req, res) => {
  try {
    const logContent = logHistory.map(log => {
      let logLine = `[${log.level}] ${log.timestamp} - ${log.message}`;
      if (log.data) {
        logLine += `\n  Data: ${JSON.stringify(log.data, null, 2)}`;
      }
      return logLine;
    }).join('\n\n');

    const filename = `ai-builder-logs-${new Date().toISOString().split('T')[0]}.txt`;
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(logContent);
    
    logger.info('로그 다운로드 완료', { logCount: logHistory.length });
  } catch (error) {
    logger.error('로그 다운로드 오류', error);
    res.status(500).json({ error: '로그 다운로드 중 오류가 발생했습니다.' });
  }
});

// ─── 로그 조회 API ─────────────
app.get('/api/logs', (req, res) => {
  const { level, limit = 100 } = req.query;
  
  let filteredLogs = logHistory;
  if (level) {
    filteredLogs = logHistory.filter(log => log.level === level.toUpperCase());
  }
  
  const logs = filteredLogs.slice(-limit);
  
  res.json({
    logs,
    total: filteredLogs.length,
    limit: parseInt(limit)
  });
});


// ─── 개선된 스트리밍 HTML 생성 API ─────────────
app.get('/api/stream', async (req, res) => {
  const { 
    message, 
    isModification = 'false', 
    currentHtml = '',
    planType = '',
    projectId = '',
    pageId = '',  // pageId 추가
    pageName = 'index',
    pageIndex = '0',
    totalPages = '1',
    sectionIndex = '0',
    totalSections = '1',
    layerIndex = '0',
    totalLayers = '1',
    modificationScope = '',
    targetPageName = '',
    modificationPlan = '',
    colorScheme = ''
  } = req.query;

  logger.info('스트림 요청', {
    message: message?.substring(0, 50),
    planType,
    projectId,
    pageId,  // pageId 추가
    pageName,
    isModification,
    modificationScope,
    targetPageName,
    hasColorScheme: !!colorScheme
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const sendEvent = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      logger.error('이벤트 전송 오류', error);
    }
  };

  const sendMessage = (content) => {
    try {
      res.write(`data: ${content}\n\n`);
    } catch (error) {
      logger.error('메시지 전송 오류', error);
    }
  };

  const sendPing = () => {
    sendEvent({ type: 'ping', timestamp: Date.now() });
  };

  const pingInterval = setInterval(sendPing, 10000);

  const cleanup = () => {
    clearInterval(pingInterval);
    if (!res.headersSent) {
      res.end();
    }
  };

  req.on('close', () => {
    logger.debug('클라이언트 연결 해제');
    cleanup();
  });

  try {
    // 수정 모드는 지원하지 않음 - 대신 재생성으로 처리
    // 프론트엔드에서 이미 결합된 프롬프트를 전송하므로 일반 생성처럼 처리

    // 2단계 Plan 방식으로 전환 (새 생성인 경우)
    if (!planType && isModification === 'false') {
      logger.info('2단계 Plan 워크플로우 시작');
      
      // 2단계 plan 실행 - 진행 상황을 스트리밍으로 전송
      let currentStage = 0;
      let needsAnalysis = null;
      let architecture = null;
      let components = [];
      let finalHTML = '';
      
      const progressHandler = (type, data) => {
        switch (type) {
          case 'stage':
            currentStage = data.stage;
            sendMessage(`[PLAN_PROGRESS]${JSON.stringify({ type: 'stage', data })}`);
            break;
          case 'needsAnalysis':
            needsAnalysis = data;
            sendMessage(`[PLAN_PROGRESS]${JSON.stringify({ type: 'needsAnalysis', data })}`);
            break;
          case 'architecture':
            architecture = data;
            sendMessage(`[PLAN_PROGRESS]${JSON.stringify({ type: 'architecture', data })}`);
            break;
          case 'component':
            sendMessage(`[PLAN_PROGRESS]${JSON.stringify({ type: 'component', data })}`);
            break;
        }
      };
      
      try {
        const result = await executeTwoStagePlan(message, progressHandler);
        
        if (result.success) {
          // HTML 스트리밍 전송
          finalHTML = result.html;
          const chunks = finalHTML.match(/.{1,100}/g) || [];
          
          for (const chunk of chunks) {
            sendEvent({
              choices: [{
                delta: {
                  content: chunk
                }
              }]
            });
          }
          
          // 완료 신호
          sendEvent({ 
            type: 'completion', 
            totalChars: finalHTML.length,
            success: true
          });
          
          sendMessage('[DONE]');
        } else {
          throw new Error(result.error);
        }
      } catch (error) {
        logger.error('2단계 plan 실행 오류', error);
        sendEvent({
          error: error.message || '2단계 plan 실행 중 오류가 발생했습니다',
          type: 'plan_error'
        });
        sendMessage('[DONE]');
      }
      
      cleanup();
      return;
    }

    let systemPrompt = '';
    let userPrompt = '';

    if (planType === 'multi') {
      const pageNum = parseInt(pageIndex) + 1;
      const totalNum = parseInt(totalPages);
      
      systemPrompt = `You are an expert web developer creating a multi-page website with CONSISTENT DESIGN.

Current progress: Page ${pageNum}/${totalNum} (${pageName})

CRITICAL REQUIREMENTS:
1. ALL pages must have IDENTICAL design, layout, colors, and CSS
2. Only the main content should differ between pages
3. Navigation must work correctly with all planned pages
4. Current page must be marked as active in navigation
5. Do NOT use .html extension in navigation links
6. For home/index page link, use "./" or relative path

IMAGES AND ICONS:
- Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
- Icon usage: <i class="fas fa-icon-name"></i>
- For images, you can use:
  - Lorem Picsum for general images: https://picsum.photos/[width]/[height]
  - UI Avatars for profiles: https://ui-avatars.com/api/?name=Name&background=random
  - Inline SVG for logos and simple graphics
  - Use descriptive alt text for all images
- DO NOT use local image paths (/images/...)

SELF-CONTAINED DOCUMENT:
- All CSS must be inline using <style> tags in the <head> section
- Only external link allowed: Font Awesome CSS
- Include all other resources within the HTML document

JAVASCRIPT INTERACTIVITY:
- Add JavaScript at the end of body with <script> tags
- Button clicks: Use onclick="functionName()" or addEventListener
- Form submissions: Add onsubmit="handleSubmit(event); return false;"
- Navigation links: Ensure href attributes work correctly
- Image sliders/carousels: Implement with JavaScript functions
- Interactive elements must have proper event handlers
- Smooth scrolling for anchor links
- All JavaScript functions must be defined

Response format: Generate only the complete HTML document.`;

      userPrompt = message;

    } else if (planType === 'long') {
      const sectionNum = parseInt(sectionIndex) + 1;
      const totalNum = parseInt(totalSections);
      
      systemPrompt = `You are an expert in creating long web pages section by section.

Current progress: ${sectionNum}/${totalNum} sections

Guidelines:
1. Focus on current section with high-quality HTML/CSS
2. Ensure smooth continuation from previous section
3. Provide connection points for next section
4. Respond with complete HTML document

Response format: Generate only the complete HTML document.`;

      userPrompt = currentHtml 
        ? `Continue with the next section based on previous content:\n\nRequest: ${message}\n\nPrevious HTML:\n${currentHtml.substring(0, 2000)}${currentHtml.length > 2000 ? '\n...(truncated)' : ''}`
        : message;

    } else if (planType === 'hierarchical') {
      const layerNum = parseInt(layerIndex) + 1;
      const totalNum = parseInt(totalLayers);
      
      systemPrompt = `You are an expert in creating websites hierarchically.

Current progress: ${layerNum}/${totalNum} layers

Guidelines:
1. Focus on current layer with high-quality HTML/CSS
2. Integrate naturally with previous layers
3. Provide extensible structure for next layers
4. Respond with complete HTML document

Response format: Generate only the complete HTML document.`;

      userPrompt = currentHtml 
        ? `Build upon the previous HTML with the following request:\n\nRequest: ${message}\n\nPrevious HTML:\n${currentHtml.substring(0, 2000)}${currentHtml.length > 2000 ? '\n...(truncated)' : ''}`
        : message;

    } else {
      // 단일 페이지 생성
      systemPrompt = `You are an excellent web developer creating production-ready websites.

Your task: ${message}

CRITICAL REQUIREMENTS:

1. DESIGN SYSTEM FIRST:
   - Establish a consistent color palette
   - Define typography hierarchy  
   - Create reusable CSS components
   - Use CSS variables for maintainability

2. MODERN, SEMANTIC HTML:
   - Use semantic tags (header, nav, main, section, article, footer)
   - Add meaningful classes and IDs
   - Ensure accessibility with proper ARIA labels
   - Include proper meta tags for SEO

3. RESPONSIVE & PROFESSIONAL:
   - Mobile-first responsive design
   - Modern CSS Grid and Flexbox layouts
   - Smooth animations and transitions
   - Professional visual design

4. COMPLETE STRUCTURE:
   - Full HTML document (DOCTYPE, html, head, body)
   - Organized CSS in <style> tags
   - Include all necessary content and functionality
   - Comments for major sections

5. IMAGES AND ICONS:
   - Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
   - Icon usage: <i class="fas fa-icon-name"></i>
   - General images: Lorem Picsum (https://picsum.photos/1200/600)
   - Profile/Avatar: UI Avatars (https://ui-avatars.com/api/?name=Name&background=random)
   - Logo: Create with inline SVG
   - DO NOT use local image paths (/images/...)

6. SELF-CONTAINED DOCUMENT:
   - All CSS must be inline using <style> tags in the <head> section
   - Only external link allowed: Font Awesome CSS
   - Include all other resources within the HTML document

7. JAVASCRIPT INTERACTIVITY:
   - Add JavaScript at the end of body with <script> tags
   - Button clicks: Use onclick="functionName()" or addEventListener
   - Form submissions: Add onsubmit="handleSubmit(event); return false;"
   - Navigation links: Use proper href attributes (e.g., href="#section", href="about.html")
   - Image sliders/carousels: Implement with JavaScript functions
   - Example patterns:
     * Button: <button onclick="showDetails()">Click Me</button>
     * Link: <a href="#features" onclick="smoothScroll(event)">Features</a>
     * Form: <form onsubmit="handleForm(event); return false;">
     * Slider: Implement prev/next functions with proper event handlers
   - Ensure all interactive elements have proper event handlers
   - Use event.preventDefault() when needed to prevent default behavior
   - Add smooth scrolling for anchor links
   - Make sure all JavaScript functions are defined

Response format: Generate only the complete HTML document.`;

      userPrompt = `Create a ${message}. Focus on creating a complete, production-ready website with excellent design and user experience.`;
    }

    let stream = null;
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries && !stream) {
      try {
        stream = await anthropic.messages.create({
          model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
          max_tokens: 4096,  // claude-3-haiku의 최대 토큰으로 설정
          system: systemPrompt,
          messages: [{
            role: 'user',
            content: userPrompt
          }],
          stream: true
        });
        break;
      } catch (error) {
        retryCount++;
        logger.error(`API 요청 실패 (시도 ${retryCount}/${maxRetries})`, error);
        
        if (retryCount < maxRetries) {
          logger.info(`${3 * retryCount}초 후 재시도...`);
          await new Promise(resolve => setTimeout(resolve, 3000 * retryCount));
        } else {
          throw error;
        }
      }
    }

    let accumulatedContent = '';
    let tokenCount = 0;
    
    sendEvent({ type: 'status', message: 'AI 응답 생성 시작...' });
    
    for await (const chunk of stream) {
      if (res.destroyed || !res.writable) {
        logger.debug('클라이언트 연결 끊어짐');
        break;
      }
      
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        const textPiece = chunk.delta.text;
        accumulatedContent += textPiece;
        tokenCount++;
        
        sendEvent({
          choices: [{
            delta: {
              content: textPiece
            }
          }]
        });
      }
      
      if (chunk.type === 'message_stop') {
        break;
      }
    }

    logger.info('스트리밍 완료', {
      chars: accumulatedContent.length,
      tokens: tokenCount
    });
    
    sendEvent({ 
      type: 'completion', 
      totalChars: accumulatedContent.length,
      totalTokens: tokenCount,
      success: true
    });
    
    sendMessage('[DONE]');
    cleanup();

  } catch (error) {
    logger.error('스트리밍 오류', error);
    
    sendEvent({
      error: error.message || '알 수 없는 오류가 발생했습니다',
      type: error.type || 'unknown_error'
    });
    
    cleanup();
    sendMessage('[DONE]');
  }
});

// ─── 페이지 저장 API ─────────────
app.post('/api/save', async (req, res) => {
  try {
    const { 
      prompt, 
      html, 
      isModification = false, 
      originalPrompt,
      projectId = null,
      pageName = 'index',
      pageType = 'main',
      projectName = null,
      projectDescription = null,
      generationType = 'single',
      sectionIndex = null,
      totalSections = null,
      plannedPages = []
    } = req.body;

    // HTML이 없는 경우 에러 반환
    if (!html) {
      logger.error('HTML이 없는 저장 요청');
      return res.status(400).json({ 
        error: 'HTML 콘텐츠가 필요합니다.'
      });
    }

    logger.info('페이지 저장 요청', {
      projectId,
      projectName,
      pageName,
      generationType,
      plannedPages,
      isModification,
      htmlLength: html?.length
    });

    let currentProjectId = projectId;
    let project = null;

    if (!currentProjectId && projectName) {
      const allPageNames = plannedPages || [];
      
      project = new Project({
        name: projectName,
        description: projectDescription || prompt,
        generationType,
        pages: [],
        plannedPages: allPageNames
      });
      await project.save();
      currentProjectId = project._id.toString();
      logger.info('새 프로젝트 생성', { 
        id: currentProjectId, 
        name: projectName,
        plannedPages: allPageNames 
      });
    } else if (currentProjectId) {
      if (!mongoose.Types.ObjectId.isValid(currentProjectId)) {
        logger.error('잘못된 프로젝트 ID', { projectId: currentProjectId });
        return res.status(400).json({ 
          success: false, 
          error: '잘못된 프로젝트 ID 형식입니다.' 
        });
      }
      
      project = await Project.findById(currentProjectId);
      if (!project) {
        logger.error('프로젝트를 찾을 수 없음', { projectId: currentProjectId });
        return res.status(404).json({ 
          success: false, 
          error: '프로젝트를 찾을 수 없습니다.' 
        });
      }
    }

    let finalHtml = html;
    let originalHtml = html;
    
    if (!html || html.trim().length < 50) {
      logger.warn('빈 HTML 감지, 기본 템플릿 사용', {
        pageName,
        htmlLength: html ? html.length : 0
      });
      
      const createDefaultHTML = (pageName) => {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${pageName} - ${projectName || 'Website'}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 0; }
        .error { padding: 50px; text-align: center; color: #dc3545; }
    </style>
</head>
<body>
    <div class="error">
        <h1>페이지 생성 오류</h1>
        <p>이 페이지는 생성 중 오류가 발생했습니다.</p>
    </div>
</body>
</html>`;
      };
      
      finalHtml = createDefaultHTML(pageName);
      originalHtml = finalHtml;
    }
    
    if (currentProjectId && generationType === 'multi' && project) {
      const allPages = [...project.pages];
      if (!allPages.find(p => p.pageName === pageName)) {
        allPages.push({ pageName, isMainPage: pageType === 'main' });
      }
      
      logger.info('멀티페이지 HTML 링크 업데이트', {
        projectId: currentProjectId,
        pageName,
        totalPages: allPages.length,
        pageNames: allPages.map(p => p.pageName),
        plannedPages: project.plannedPages
      });
      
      finalHtml = updateHtmlLinks(html, currentProjectId, pageName, allPages, project.plannedPages);
    }

    // 수정 히스토리 관리
    let existingPage = null;
    let modificationHistoryEntry = null;
    
    // 수정인 경우 기존 페이지 조회
    if (isModification && req.body.pageId) {
      try {
        existingPage = await Page.findById(req.body.pageId);
        if (existingPage) {
          
          // 수정 히스토리 준비
          modificationHistoryEntry = {
            request: prompt,
            plan: req.body.modificationPlan ? JSON.parse(req.body.modificationPlan) : null,
            changes: [],
            success: true
          };
          
        }
      } catch (error) {
        logger.error('기존 페이지 조회 오류', error);
      }
    }
    
    
    if (!isModification && finalHtml) {
      try {
        logger.info('전체 HTML 저장', {
          htmlSize: Math.round(finalHtml.length / 1000) + 'KB',
          prompt: prompt.substring(0, 100) + '...'
        });
        
      } catch (error) {
        logger.error('HTML 저장 오류', error);
      }
    }

    let savedPage;
    
    // 모든 페이지에 대해 HTML 리소스 업데이트 적용
    // 프로젝트 정보가 있으면 실제 페이지 정보 전달, 없으면 빈 배열 
    const projectPages = project ? project.pages : [];
    const projectPlannedPages = project ? project.plannedPages : [];
    finalHtml = updateHtmlResources(finalHtml, currentProjectId, pageName, projectPages, projectPlannedPages);
    
    if (isModification && existingPage) {
      // 기존 페이지 업데이트
      existingPage.html = finalHtml;
      existingPage.prompt = prompt;
      existingPage.isModification = true;
      
      // 수정 히스토리 추가
      if (modificationHistoryEntry) {
        if (!existingPage.modificationHistory) {
          existingPage.modificationHistory = [];
        }
        existingPage.modificationHistory.push(modificationHistoryEntry);
      }
      
      await existingPage.save();
      savedPage = existingPage;
      logger.info('기존 페이지 업데이트 성공', { 
        pageId: savedPage._id, 
        pageName,
        historyCount: savedPage.modificationHistory?.length || 0
      });
    } else {
      // 새 페이지 생성
      const page = new Page({
        prompt,
        html: finalHtml,
        originalHtml: originalHtml,
        isModification,
        originalPrompt: originalPrompt || prompt,
        projectId: currentProjectId ? new mongoose.Types.ObjectId(currentProjectId) : null,
        pageName,
        pageType,
        sectionIndex,
        totalSections
      });

      await page.save();
      savedPage = page;
      logger.info('새 페이지 저장 성공', { pageId: savedPage._id, pageName });
    }

    if (project) {
      const existingPageIndex = project.pages.findIndex(p => p.pageName === pageName);
      if (existingPageIndex >= 0) {
        project.pages[existingPageIndex].pageId = savedPage._id;
      } else {
        project.pages.push({
          pageId: savedPage._id,
          pageName: pageName,
          isMainPage: pageType === 'main'
        });
      }
      await project.save();
      logger.info('프로젝트 업데이트 완료', { projectId: project._id });
    }
    
    res.json({ 
      success: true, 
      id: savedPage._id.toString(),
      projectId: currentProjectId,
      pageName,
      generationType,
      isModification
    });

  } catch (error) {
    logger.error('페이지 저장 오류', error);
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// ─── 프로젝트 루트 미리보기 (index 페이지) ─────────────
app.get('/preview/:projectId', async (req, res) => {
  const { projectId } = req.params;
  
  logger.info('프로젝트 루트 페이지 요청 (index)', { projectId });
  
  try {
    // 먼저 단일 페이지인지 확인
    const page = await Page.findById(projectId);
    if (page) {
      // 단일 페이지인 경우
      const enhancedHtml = page.html.replace(
        '<head>',
        `<head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta name="generator" content="AI Web Builder">
          <meta name="created" content="${page.createdAt.toISOString()}">
        `
      );

      logger.info('단일 페이지 전송', {
        pageId: page._id,
        htmlLength: enhancedHtml.length,
        pageName: page.pageName
      });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.send(enhancedHtml);
      return;
    }
    
    // 프로젝트 조회
    const project = await Project.findById(projectId);
    if (!project) {
      logger.error('프로젝트를 찾을 수 없음', { projectId });
      return res.status(404).send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <style>
              body { font-family: Arial; text-align: center; padding: 50px; }
              h1 { color: #dc3545; }
              a { color: #007bff; text-decoration: none; }
            </style>
          </head>
          <body>
            <h1>404 - 프로젝트를 찾을 수 없습니다</h1>
            <p>프로젝트 ID: ${projectId}</p>
            <p><a href="/">홈으로 돌아가기</a></p>
          </body>
        </html>
      `);
    }

    // index 페이지 찾기
    const indexPageInfo = project.pages.find(p => p.pageName === 'index');
    if (!indexPageInfo) {
      logger.error('index 페이지를 찾을 수 없음', { projectId });
      return res.status(404).send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <style>
              body { font-family: Arial; text-align: center; padding: 50px; }
              h1 { color: #dc3545; }
            </style>
          </head>
          <body>
            <h1>404 - 메인 페이지를 찾을 수 없습니다</h1>
            <p>이 프로젝트에는 index 페이지가 없습니다.</p>
          </body>
        </html>
      `);
    }

    // index 페이지 데이터 조회
    const indexPage = await Page.findById(indexPageInfo.pageId);
    if (!indexPage) {
      logger.error('index 페이지 데이터를 찾을 수 없음', { 
        pageId: indexPageInfo.pageId
      });
      return res.status(404).send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <style>
              body { font-family: Arial; text-align: center; padding: 50px; }
              h1 { color: #dc3545; }
            </style>
          </head>
          <body>
            <h1>404 - 페이지 데이터를 찾을 수 없습니다</h1>
            <p>페이지가 손상되었거나 삭제되었습니다.</p>
          </body>
        </html>
      `);
    }

    // 미리보기용 HTML 생성
    let finalHtml = indexPage.html;
    
    // 링크 변환 - iframe 내부 네비게이션을 위해 필수
    const allPageNames = project.pages.map(p => p.pageName);
    finalHtml = updateHtmlResources(finalHtml, projectId, 'index', project.pages, allPageNames);
    
    // 메타데이터 추가
    finalHtml = finalHtml.replace(
      '<head>',
      `<head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="generator" content="AI Web Builder">
        <meta name="projectId" content="${projectId}">
        <meta name="projectName" content="${project.name}">
        <meta name="pageName" content="index">
      `
    );

    logger.info('index 페이지 전송 성공', { 
      projectId,
      htmlLength: finalHtml.length,
      hasLinks: finalHtml.includes('href=')
    });
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // CSP 헤더 추가 - 외부 이미지 소스 허용
    res.setHeader('Content-Security-Policy', 
      "default-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "img-src * data: https: blob:; " +
      "font-src * data: https:; " +
      "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net"
    );
    res.send(finalHtml);

  } catch (error) {
    logger.error('프로젝트 루트 미리보기 오류', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).send(`
      <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial; text-align: center; padding: 50px; }
            h1 { color: #dc3545; }
          </style>
        </head>
        <body>
          <h1>500 - 서버 오류</h1>
          <p>페이지를 불러오는 중 오류가 발생했습니다.</p>
        </body>
      </html>
    `);
  }
});

// ─── 멀티 페이지 미리보기 API ─────────────
app.get('/preview/:projectId/:pageName', async (req, res) => {
  try {
    const { projectId } = req.params;
    let { pageName } = req.params;
    
    if (pageName && pageName.endsWith('.html')) {
      pageName = pageName.slice(0, -5);
    }
    
    logger.info('멀티 페이지 미리보기 요청', { 
      projectId, 
      pageName
    });
    
    const project = await Project.findById(projectId);
    if (!project) {
      logger.error('프로젝트를 찾을 수 없음', { projectId });
      return res.status(404).send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <style>
              body { font-family: Arial; text-align: center; padding: 50px; }
              h1 { color: #dc3545; }
              a { color: #007bff; text-decoration: none; }
            </style>
          </head>
          <body>
            <h1>404 - 프로젝트를 찾을 수 없습니다</h1>
            <p>프로젝트 ID: ${projectId}</p>
            <p><a href="/">홈으로 돌아가기</a></p>
          </body>
        </html>
      `);
    }

    logger.debug('프로젝트 정보', {
      name: project.name,
      pageCount: project.pages.length,
      pages: project.pages.map(p => p.pageName),
      plannedPages: project.plannedPages
    });

    const pageInfo = project.pages.find(p => p.pageName === pageName || p.name === pageName);
    if (!pageInfo) {
      logger.error('페이지 정보를 찾을 수 없음', { 
        projectId, 
        pageName,
        availablePages: project.pages.map(p => p.pageName || p.name),
        pagesDetail: project.pages.map(p => ({
          pageName: p.pageName || p.name,
          pageId: p.pageId,
          hasPageId: !!p.pageId
        }))
      });
      const availablePages = project.pages.map(p => ({
        name: p.pageName,
        url: p.pageName === 'index' ? `/preview/${projectId}` : `/preview/${projectId}/${p.pageName}`
      }));
      
      return res.status(404).send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <style>
              body { 
                font-family: Arial; 
                padding: 50px; 
                max-width: 600px;
                margin: 0 auto;
                background-color: #f5f5f5;
              }
              .error-container {
                background: white;
                padding: 30px;
                border-radius: 10px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
              }
              h1 { 
                color: #dc3545; 
                margin-bottom: 20px;
              }
              .page-list { 
                margin: 20px 0; 
                padding: 20px; 
                background: #f8f9fa; 
                border-radius: 5px;
                border: 1px solid #dee2e6;
              }
              .page-list h3 {
                margin-top: 0;
                color: #343a40;
              }
              .page-item {
                margin: 10px 0;
                padding: 10px;
                background: white;
                border-radius: 3px;
                border: 1px solid #e9ecef;
              }
              a { 
                color: #007bff; 
                text-decoration: none;
                font-weight: bold;
              }
              a:hover {
                text-decoration: underline;
              }
              .back-link {
                display: inline-block;
                margin-top: 20px;
                padding: 10px 20px;
                background: #007bff;
                color: white;
                border-radius: 5px;
                text-decoration: none;
              }
              .back-link:hover {
                background: #0056b3;
                text-decoration: none;
              }
            </style>
          </head>
          <body>
            <div class="error-container">
              <h1>404 - 페이지를 찾을 수 없습니다</h1>
              <p><strong>'${pageName}'</strong> 페이지가 이 프로젝트에 존재하지 않습니다.</p>
              
              <div class="page-list">
                <h3>사용 가능한 페이지:</h3>
                ${availablePages.map(page => `
                  <div class="page-item">
                    <a href="${page.url}">${page.name === 'index' ? 'Home' : page.name}</a>
                  </div>
                `).join('') || '<p>페이지가 없습니다.</p>'}
              </div>
              
              <a href="/preview/${projectId}" class="back-link">
                홈으로 돌아가기
              </a>
            </div>
          </body>
        </html>
      `);
    }

    // pageId가 없는 경우 처리 (구 스키마 호환)
    if (!pageInfo.pageId) {
      logger.error('페이지 ID가 없음 - 구 스키마 데이터', { 
        projectId,
        pageName,
        pageInfo
      });
      // pageName으로 페이지 찾기 시도
      const page = await Page.findOne({ 
        projectId: project._id, 
        pageName: pageName 
      });
      if (page) {
        logger.info('pageName으로 페이지 찾기 성공', { pageName });
        // 페이지 처리 로직 계속...
        let finalHtml = page.html;
        const allPageNames = project.pages.map(p => p.pageName || p.name);
        finalHtml = updateHtmlResources(finalHtml, projectId, pageName, project.pages, allPageNames);
        
        finalHtml = finalHtml.replace(
          '<head>',
          `<head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta name="generator" content="AI Web Builder">
            <meta name="projectId" content="${projectId}">
            <meta name="projectName" content="${project.name}">
            <meta name="pageName" content="${pageName}">
          `
        );
        
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy', 
          "default-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
          "img-src * data: https: blob:; " +
          "font-src * data: https:; " +
          "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net"
        );
        return res.send(finalHtml);
      }
    }
    
    logger.debug('페이지 조회 시도', {
      pageId: pageInfo.pageId,
      pageIdType: typeof pageInfo.pageId,
      isValidObjectId: mongoose.Types.ObjectId.isValid(pageInfo.pageId)
    });
    
    const page = pageInfo.pageId ? await Page.findById(pageInfo.pageId) : null;
    if (!page) {
      logger.error('페이지 데이터를 찾을 수 없음', { 
        pageId: pageInfo.pageId,
        pageName,
        pageInfoFull: pageInfo
      });
      return res.status(404).send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <style>
              body { font-family: Arial; text-align: center; padding: 50px; }
              h1 { color: #dc3545; }
            </style>
          </head>
          <body>
            <h1>404 - 페이지 데이터를 찾을 수 없습니다</h1>
            <p>페이지가 손상되었거나 삭제되었습니다.</p>
          </body>
        </html>
      `);
    }

    let finalHtml = page.html;
    
    // 링크 변환 - iframe 내부 네비게이션을 위해 필수
    const allPageNames = project.pages.map(p => p.pageName);
    finalHtml = updateHtmlResources(finalHtml, projectId, pageName, project.pages, allPageNames);
    
    finalHtml = finalHtml.replace(
      '<head>',
      `<head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="generator" content="AI Web Builder">
        <meta name="projectId" content="${projectId}">
        <meta name="projectName" content="${project.name}">
        <meta name="pageName" content="${pageName}">
      `
    );

    logger.info('페이지 전송 성공', { 
      projectId, 
      pageName,
      htmlLength: finalHtml.length,
      hasLinks: finalHtml.includes('href=')
    });
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // CSP 헤더 추가 - 외부 이미지 소스 허용
    res.setHeader('Content-Security-Policy', 
      "default-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "img-src * data: https: blob:; " +
      "font-src * data: https:; " +
      "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net"
    );
    res.send(finalHtml);

  } catch (error) {
    logger.error('멀티 페이지 미리보기 오류', {
      error: error.message,
      stack: error.stack,
      projectId: req.params.projectId,
      pageName: req.params.pageName,
      errorType: error.constructor.name
    });
    res.status(500).send(`
      <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial; text-align: center; padding: 50px; }
            h1 { color: #dc3545; }
          </style>
        </head>
        <body>
          <h1>500 - 서버 오류</h1>
          <p>페이지를 불러오는 중 오류가 발생했습니다.</p>
        </body>
      </html>
    `);
  }
});

// ─── 단일 페이지 다운로드 API ─────────────
app.get('/api/download/:id', async (req, res) => {
  try {
    const page = await Page.findById(req.params.id);
    
    if (!page) {
      logger.warn('다운로드할 페이지를 찾을 수 없음', { pageId: req.params.id });
      return res.status(404).json({ error: '페이지를 찾을 수 없습니다.' });
    }

    const downloadHtml = page.originalHtml || page.html;

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="${page.pageName || 'index'}.html"`);
    res.send(downloadHtml);

    logger.info('단일 페이지 다운로드 완료', { pageId: page._id });

  } catch (error) {
    logger.error('다운로드 오류', error);
    res.status(500).json({ error: '다운로드 중 오류가 발생했습니다.' });
  }
});

// ─── 프로젝트 다운로드 API (ZIP) ─────────────
app.get('/api/download/project/:projectId', async (req, res) => {
  try {
    const project = await Project.findById(req.params.projectId);
    
    if (!project) {
      logger.warn('다운로드할 프로젝트를 찾을 수 없음', { projectId: req.params.projectId });
      return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
    }

    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    archive.on('error', (err) => {
      logger.error('ZIP 생성 오류', err);
      res.status(500).json({ error: 'ZIP 파일 생성 중 오류가 발생했습니다.' });
    });

    const sanitizedName = project.name.replace(/[<>:"/\\|?*]/g, '_');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 
      `attachment; filename="${encodeURIComponent(sanitizedName || 'website')}.zip"`
    );

    archive.pipe(res);

    for (const pageInfo of project.pages) {
      const page = await Page.findById(pageInfo.pageId);
      if (page) {
        let downloadHtml = page.originalHtml || page.html;
        
        project.pages.forEach(p => {
          if (p.pageName === 'index') {
            const indexPattern = new RegExp(`href="/preview/${req.params.projectId}"`, 'g');
            downloadHtml = downloadHtml.replace(indexPattern, `href="./"`);
          }
          
          const linkPattern = new RegExp(`href="/preview/${req.params.projectId}/${p.pageName}"`, 'g');
          downloadHtml = downloadHtml.replace(linkPattern, `href="${p.pageName}.html"`);
        });

        archive.append(downloadHtml, { name: `${pageInfo.pageName}.html` });
      }
    }

    const readmeContent = `# ${project.name}

${project.description}

## Pages
${project.pages.map(p => `- ${p.pageName}.html${p.isMainPage ? ' (Main)' : ''}`).join('\n')}

Generated by AI Web Builder on ${new Date().toISOString()}
`;
    archive.append(readmeContent, { name: 'README.md' });

    await archive.finalize();

    logger.info('프로젝트 다운로드 완료', { 
      projectId: project._id,
      pageCount: project.pages.length 
    });

  } catch (error) {
    logger.error('프로젝트 다운로드 오류', error);
    res.status(500).json({ error: '다운로드 중 오류가 발생했습니다.' });
  }
});

// ─── 페이지 정보 API ─────────────
app.get('/api/get-page/:projectId/:pageName', async (req, res) => {
  try {
    const { projectId, pageName } = req.params;
    
    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
    }
    
    const pageInfo = project.pages.find(p => p.pageName === pageName);
    if (!pageInfo) {
      return res.status(404).json({ error: '페이지를 찾을 수 없습니다.' });
   }
   
   const page = await Page.findById(pageInfo.pageId);
   if (!page) {
     return res.status(404).json({ error: '페이지 데이터를 찾을 수 없습니다.' });
   }
   
   res.json({
     success: true,
     html: page.html,
     pageName: page.pageName,
     projectId: projectId
   });
   
 } catch (error) {
   logger.error('페이지 정보 조회 오류', error);
   res.status(500).json({ error: '페이지 정보 조회 중 오류가 발생했습니다.' });
 }
});

// ─── 프로젝트 정보 API 추가 ─────────────
app.get('/api/project/:projectId', async (req, res) => {
 try {
   const { projectId } = req.params;
   
   const project = await Project.findById(projectId);
   if (!project) {
     return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
   }
   
   res.json({
     success: true,
     project: {
       id: project._id,
       name: project.name,
       description: project.description,
       generationType: project.generationType,
       pages: project.pages,
       plannedPages: project.plannedPages,
       createdAt: project.createdAt
     }
   });
   
 } catch (error) {
   logger.error('프로젝트 정보 조회 오류', error);
   res.status(500).json({ error: '프로젝트 정보 조회 중 오류가 발생했습니다.' });
 }
});

// ─── React 앱 catch-all 라우트 (반드시 모든 API 라우트 뒤에 위치) ───
// 프로덕션 환경에서 React 앱 서빙
if (process.env.NODE_ENV === 'production') {
  // React 앱 정적 파일 서빙
  const clientBuildPath = path.join(__dirname, '../ai-builder-client/dist');
  app.use(express.static(clientBuildPath));
  
  // /api와 /preview로 시작하지 않는 모든 경로를 React 앱으로 전달
  app.get('*', (req, res) => {
    // API나 preview 경로는 여기서 처리하지 않음
    if (req.path.startsWith('/api/') || req.path.startsWith('/preview/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    
    // React 앱의 index.html 반환
    res.sendFile('index.html', { root: clientBuildPath });
  });
}

// ─── 서버 시작 ──────────────────────────────────────────
const server = app.listen(PORT, () => {
  logger.info('서버 시작', {
    port: PORT,
    mongodb: process.env.MONGODB_URI ? '설정됨' : '설정 필요',
    anthropic: process.env.ANTHROPIC_API_KEY ? '설정됨' : '설정 필요',
    model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307'
  });
});

// 포트 충돌 에러 처리
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`포트 ${PORT}이 이미 사용 중입니다.`);
    console.error(`
❌ 포트 ${PORT}이 이미 사용 중입니다.

해결 방법:
1. 다른 터미널에서 실행 중인 서버를 확인하세요
2. 서버 관리 명령을 사용하세요:
   ./server-manager.sh stop    # 기존 서버 중지
   ./server-manager.sh start   # 새로 시작
   ./server-manager.sh status  # 상태 확인

또는 수동으로 종료:
   lsof -ti :${PORT} | xargs kill -9
`);
  } else {
    logger.error('서버 시작 오류', error);
  }
  process.exit(1);
});

// ─── 우아한 종료 처리 ───────────────────────────────────
process.on('SIGINT', async () => {
 logger.info('서버 종료 시작');
 await mongoose.connection.close();
 logger.info('MongoDB 연결 해제 완료');
 process.exit(0);
});