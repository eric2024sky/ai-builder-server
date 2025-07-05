import mongoose from 'mongoose';

const PageSchema = new mongoose.Schema({
  html:    { type: String, required: true },
  prompt:  { type: String },
  created: { type: Date,   default: Date.now },
  
  // Base44 대화 이력
  conversationHistory: [{
    role: { type: String, enum: ['system', 'user', 'assistant'] },
    content: String,
    timestamp: { type: Date, default: Date.now }
  }],
  
  // 생성 계획 정보
  generationPlan: {
    complexity: { type: String, enum: ['simple', 'medium', 'complex', 'enterprise'] },
    totalLayers: Number,
    currentLayer: Number,
    strategy: String
  },
  
  // 재생성 히스토리
  regenerationHistory: [{
    timestamp: { type: Date, default: Date.now },
    request: String,
    previousHtml: String,
    newHtml: String,
    success: Boolean
  }]
});

export default mongoose.models.Page || mongoose.model('Page', PageSchema);