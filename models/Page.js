import mongoose from 'mongoose';

const PageSchema = new mongoose.Schema({
  html:    { type: String, required: true },
  prompt:  { type: String },
  created: { type: Date,   default: Date.now },
});

export default mongoose.models.Page || mongoose.model('Page', PageSchema);