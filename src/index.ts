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
  const app = express();
  const PORT = parseInt(process.env.PORT || '3001', 10);

  // Start listening immediately (don't wait for DB to fail startup)
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n══════════════════════════════════════════`);
    console.log(`  NexusPay API — port ${PORT}`);
    console.log(`══════════════════════════════════════════\n`);
  });

  // Handle listen errors
  server.on('error', (err) => {
    console.error('Server error:', err);
    process.exit(1);
  });

  // Configure middleware and routes
  const allowedOrigins = [
    'https://payment-processing-system-frontend.pages.dev',
    'http://localhost:3000',
    'http://localhost:5173',
  ];

  app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json());

  // Health check endpoint (doesn't require DB)
  app.get('/api/health', (_req, res) => {
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    res.json({ status: 'ok', uptime: process.uptime(), db: dbStatus });
  });

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/webhooks', webhookRoutes);

  // Connect to MongoDB (don't block server startup)
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    console.error('[MongoDB] MONGODB_URI not set');
  } else {
    try {
      await mongoose.connect(MONGODB_URI);
      console.log('[MongoDB] Connected');
      console.log(`[Razorpay] Key: ${process.env.RAZORPAY_KEY_ID}`);
    } catch (err) {
      console.error('[MongoDB] Connection failed:', err);
      // Continue running even if DB fails initially (for readiness probes)
    }
  }
}

main().catch(err => {
  console.error('CRITICAL:', err);
  process.exit(1);
});
