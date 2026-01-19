import Fastify from 'fastify';
import cors from '@fastify/cors';
import 'dotenv/config';
import { eventsRoutes } from './routes/events';
import { authRoutes } from './routes/auth';
import { telemetryRoutes } from './routes/telemetry';
import { initDb } from './initDb';

const app = Fastify({ logger: true, trustProxy: true });

app.register(cors);
app.register(eventsRoutes);
app.register(authRoutes);
app.register(telemetryRoutes);

const PORT = Number(process.env.PORT) || 3000;

const start = async () => {
  try {
    await initDb();
    app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 GenerateUI backend running on port ${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
