// 로깅 시스템
const logHistory = [];
const MAX_LOG_HISTORY = 1000;

const logger = {
  info: (message, data = null) => {
    const logEntry = {
      level: 'INFO',
      timestamp: new Date().toISOString(),
      message,
      data: data || null
    };
    console.log(`[INFO] ${logEntry.timestamp} - ${message}`, data || '');
    logHistory.push(logEntry);
    if (logHistory.length > MAX_LOG_HISTORY) {
      logHistory.shift();
    }
  },
  error: (message, error = null) => {
    const logEntry = {
      level: 'ERROR',
      timestamp: new Date().toISOString(),
      message,
      data: error || null
    };
    console.error(`[ERROR] ${logEntry.timestamp} - ${message}`, error || '');
    logHistory.push(logEntry);
    if (logHistory.length > MAX_LOG_HISTORY) {
      logHistory.shift();
    }
  },
  debug: (message, data = null) => {
    if (process.env.DEBUG === 'true') {
      const logEntry = {
        level: 'DEBUG',
        timestamp: new Date().toISOString(),
        message,
        data: data || null
      };
      console.log(`[DEBUG] ${logEntry.timestamp} - ${message}`, data || '');
      logHistory.push(logEntry);
      if (logHistory.length > MAX_LOG_HISTORY) {
        logHistory.shift();
      }
    }
  },
  warn: (message, data = null) => {
    const logEntry = {
      level: 'WARN',
      timestamp: new Date().toISOString(),
      message,
      data: data || null
    };
    console.warn(`[WARN] ${logEntry.timestamp} - ${message}`, data || '');
    logHistory.push(logEntry);
    if (logHistory.length > MAX_LOG_HISTORY) {
      logHistory.shift();
    }
  }
};

export { logger as default, logHistory };