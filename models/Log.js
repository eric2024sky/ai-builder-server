import mongoose from 'mongoose';

const LogSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now, index: true },
  level: { 
    type: String, 
    enum: ['ERROR', 'WARN', 'INFO', 'DEBUG'], 
    required: true,
    index: true 
  },
  source: { 
    type: String, 
    enum: ['SERVER', 'CLIENT'], 
    required: true,
    index: true 
  },
  environment: { 
    type: String, 
    default: process.env.NODE_ENV || 'development',
    index: true 
  },
  module: { type: String, index: true },
  function: { type: String },
  message: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed },
  
  error: {
    name: String,
    message: String,
    stack: String
  },
  
  request: {
    method: String,
    url: String,
    headers: mongoose.Schema.Types.Mixed,
    body: mongoose.Schema.Types.Mixed,
    ip: String,
    userAgent: String
  },
  
  response: {
    statusCode: Number,
    duration: Number,
    body: mongoose.Schema.Types.Mixed
  },
  
  user: {
    sessionId: String,
    projectId: String
  },
  
  metadata: { type: mongoose.Schema.Types.Mixed }
}, {
  timestamps: true
});

// TTL 인덱스 - 30일 후 자동 삭제
LogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// 복합 인덱스 - 효율적인 조회를 위해
LogSchema.index({ level: 1, timestamp: -1 });
LogSchema.index({ source: 1, timestamp: -1 });
LogSchema.index({ 'user.sessionId': 1, timestamp: -1 });
LogSchema.index({ 'user.projectId': 1, timestamp: -1 });

export default mongoose.models.Log || mongoose.model('Log', LogSchema);