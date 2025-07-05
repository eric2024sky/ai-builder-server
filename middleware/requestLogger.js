import dbLogger from '../services/dbLogger.js';

const requestLogger = (req, res, next) => {
  const startTime = Date.now();
  
  // 원본 send 메서드 저장
  const originalSend = res.send;
  const originalJson = res.json;
  
  // 응답 본문 캡처를 위한 래퍼
  const captureResponse = (body) => {
    res.locals.responseBody = body;
    return body;
  };
  
  res.send = function(body) {
    captureResponse(body);
    originalSend.call(this, body);
  };
  
  res.json = function(body) {
    captureResponse(body);
    originalJson.call(this, body);
  };
  
  // 응답 완료 시 로깅
  res.on('finish', async () => {
    const duration = Date.now() - startTime;
    
    // 정적 파일이나 헬스체크는 로깅 제외
    const skipPaths = ['/static', '/images', '/favicon.ico', '/health'];
    if (skipPaths.some(path => req.originalUrl.startsWith(path))) {
      return;
    }
    
    await dbLogger.logRequest(req, res, duration);
  });
  
  next();
};

// 에러 로깅 미들웨어
const errorLogger = (err, req, res, next) => {
  dbLogger.error('Unhandled error in request', err, {
    request: {
      method: req.method,
      url: req.originalUrl,
      headers: req.headers,
      body: req.body,
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent')
    },
    user: {
      sessionId: req.sessionID || req.headers['x-session-id'],
      projectId: req.params.projectId || req.body?.projectId
    }
  });
  
  next(err);
};

export { requestLogger, errorLogger };