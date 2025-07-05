import mongoose from 'mongoose';
import Log from '../models/Log.js';

class DBLogger {
  constructor() {
    this.logQueue = [];
    this.flushInterval = null;
    this.isConnected = false;
    this.logLevel = process.env.LOG_LEVEL || 'INFO';
    this.levelPriority = {
      'ERROR': 0,
      'WARN': 1,
      'INFO': 2,
      'DEBUG': 3
    };
    
    // 배치 플러시 인터벌 설정 (5초)
    this.startFlushInterval();
  }

  async ensureLogCollection() {
    try {
      const db = mongoose.connection.db;
      if (!db) {
        console.error('Database not connected');
        return false;
      }

      const collName = process.env.LOG_COLLECTION || 'logs';
      const collections = await db.listCollections({ name: collName }).toArray();
      
      if (collections.length === 0) {
        await db.createCollection(collName);
        console.log(`Created new log collection: ${collName}`);
      }
      
      this.isConnected = true;
      return true;
    } catch (error) {
      console.error('Failed to ensure log collection:', error);
      return false;
    }
  }

  shouldLog(level) {
    return this.levelPriority[level] <= this.levelPriority[this.logLevel];
  }

  extractCallerInfo() {
    const stack = new Error().stack;
    const stackLines = stack.split('\n');
    
    // 스택에서 실제 호출자 찾기 (logger 관련 라인 제외)
    for (let i = 3; i < stackLines.length; i++) {
      const line = stackLines[i];
      if (!line.includes('dbLogger.js') && !line.includes('logger.js')) {
        const match = line.match(/at\s+(?:async\s+)?([^\s]+)\s+\((.+):(\d+):(\d+)\)/);
        if (match) {
          const functionName = match[1];
          const filePath = match[2];
          const moduleName = filePath.split('/').pop().replace('.js', '');
          return { module: moduleName, function: functionName };
        }
      }
    }
    return { module: 'unknown', function: 'unknown' };
  }

  async log(level, message, data = null, context = {}) {
    if (!this.shouldLog(level)) return;

    const callerInfo = this.extractCallerInfo();
    
    const logEntry = {
      timestamp: new Date(),
      level,
      source: 'SERVER',
      environment: process.env.NODE_ENV || 'development',
      module: context.module || callerInfo.module,
      function: context.function || callerInfo.function,
      message,
      data: data || null,
      ...context
    };

    // 콘솔에도 출력
    const consoleMessage = `[${level}] ${logEntry.timestamp.toISOString()} - ${logEntry.module}::${logEntry.function} - ${message}`;
    if (level === 'ERROR') {
      console.error(consoleMessage, data || '');
    } else if (level === 'WARN') {
      console.warn(consoleMessage, data || '');
    } else {
      console.log(consoleMessage, data || '');
    }

    // DB 저장을 위해 큐에 추가
    this.logQueue.push(logEntry);
    
    // 에러 레벨은 즉시 플러시
    if (level === 'ERROR') {
      await this.flush();
    }
  }

  async flush() {
    if (this.logQueue.length === 0 || !this.isConnected) return;

    const logsToFlush = [...this.logQueue];
    this.logQueue = [];

    try {
      await Log.insertMany(logsToFlush, { ordered: false });
    } catch (error) {
      console.error('Failed to flush logs to database:', error);
      // 실패한 로그는 다시 큐에 추가
      this.logQueue.unshift(...logsToFlush);
    }
  }

  startFlushInterval() {
    this.flushInterval = setInterval(() => {
      this.flush();
    }, 5000);
  }

  stopFlushInterval() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  // 편의 메서드들
  async info(message, data = null, context = {}) {
    await this.log('INFO', message, data, context);
  }

  async error(message, error = null, context = {}) {
    const errorData = error ? {
      name: error.name,
      message: error.message,
      stack: error.stack
    } : null;
    
    await this.log('ERROR', message, error, {
      ...context,
      error: errorData
    });
  }

  async warn(message, data = null, context = {}) {
    await this.log('WARN', message, data, context);
  }

  async debug(message, data = null, context = {}) {
    await this.log('DEBUG', message, data, context);
  }

  // HTTP 요청 로깅
  async logRequest(req, res, duration) {
    const logData = {
      request: {
        method: req.method,
        url: req.originalUrl,
        headers: req.headers,
        body: req.body,
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.get('user-agent')
      },
      response: {
        statusCode: res.statusCode,
        duration: duration
      },
      user: {
        sessionId: req.sessionID || req.headers['x-session-id'],
        projectId: req.params.projectId || req.body?.projectId
      }
    };

    const level = res.statusCode >= 400 ? 'ERROR' : 'INFO';
    await this.log(level, `${req.method} ${req.originalUrl} - ${res.statusCode}`, null, logData);
  }

  // 클라이언트 로그 처리
  async logClientEntry(clientLog) {
    const logEntry = {
      ...clientLog,
      source: 'CLIENT',
      timestamp: new Date(clientLog.timestamp || Date.now())
    };

    await this.log(logEntry.level, logEntry.message, logEntry.data, {
      module: logEntry.module,
      function: logEntry.function,
      error: logEntry.error,
      user: logEntry.user,
      metadata: logEntry.metadata
    });
  }

  // 종료 시 남은 로그 플러시
  async shutdown() {
    this.stopFlushInterval();
    await this.flush();
  }
}

// 싱글톤 인스턴스
const dbLogger = new DBLogger();

// 기존 logger와의 호환성을 위한 wrapper
const logger = {
  info: (message, data) => dbLogger.info(message, data),
  error: (message, error) => dbLogger.error(message, error),
  warn: (message, data) => dbLogger.warn(message, data),
  debug: (message, data) => dbLogger.debug(message, data)
};

export { dbLogger as default, logger };