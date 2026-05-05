import mongoose, { Schema, Document } from 'mongoose';

export interface IWebhookLog extends Document {
  paymentId: string;
  source: string;
  eventType: string;
  payload: Record<string, any>;
  result: 'PROCESSED' | 'IGNORED' | 'CONFLICT';
  createdAt: Date;
}

const WebhookLogSchema = new Schema<IWebhookLog>({
  paymentId: { type: String, required: true, index: true },
  source: { type: String, default: 'razorpay' },
  eventType: { type: String, required: true },
  payload: { type: Schema.Types.Mixed, required: true },
  result: { type: String, enum: ['PROCESSED', 'IGNORED', 'CONFLICT'], required: true },
}, { timestamps: true, toJSON: { virtuals: true, versionKey: false } });

export const WebhookLog = mongoose.model<IWebhookLog>('WebhookLog', WebhookLogSchema);
