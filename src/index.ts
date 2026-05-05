import dns from 'dns';
dns.setServers(['8.8.8.8', '8.8.4.4']);

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import authRoutes from './routes/auth.js';
import paymentRoutes from './routes/payments.js';
import webhookRoutes from './routes/webhooks.js';

async function main() {
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) throw new Error('MONGODB_URI not set');

  await mongoose.connect(MONGODB_URI);
  console.log('[MongoDB] Connected');

  const app = express();
  const PORT = parseInt(process.env.PORT || '3001');

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/webhooks', webhookRoutes);

  // Health check
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n══════════════════════════════════════════`);
    console.log(`  NexusPay API — port ${PORT}`);
    console.log(`  Razorpay: ${process.env.RAZORPAY_KEY_ID}`);
    console.log(`══════════════════════════════════════════\n`);
  });
}

main().catch(err => {
  console.error('CRITICAL:', err);
  process.exit(1);
});
