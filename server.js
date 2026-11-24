import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { connectToMongoDB, disconnectFromMongoDB } from './config/db.js';
import { createPMVCollections } from './config/collections.js';
import { seedDemoData } from './lib/seed.js';
import { createAuthRouter } from './routes/auth.js';
import { createRepairsRouter } from './routes/repairs.js';
import { createExperimentRouter } from './routes/experiment.js';

// Carga las variables de .env sin imprimirlas ni sobrescribirlas.
const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '.env');
if (!process.env.MONGO_URI && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const PORT = Number(process.env.PORT) || 3000;

// CORS restringido a Angular local y a los dominios de producción vía variable
// de entorno ALLOWED_ORIGINS (lista separada por comas).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:4200')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
for (const local of ['http://localhost:4200', 'http://127.0.0.1:4200']) {
  if (!allowedOrigins.includes(local)) allowedOrigins.push(local);
}

const app = express();
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '256kb' }));

let db;
const getDb = () => db;

// ---------------------------------------------------------------------------
// Salud del servicio (público, sin datos sensibles)
// ---------------------------------------------------------------------------

app.get('/api/health', async (req, res) => {
  try {
    await db.command({ ping: 1 });
    res.json({
      status: 'ok',
      backend: 'disponible',
      mongodb: 'conectado',
      database: db.databaseName,
      experiment: 'E1',
      auth: 'sesión firmada de demostración',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      backend: 'disponible',
      mongodb: 'sin conexión',
      error: error.message,
    });
  }
});

// ---------------------------------------------------------------------------
// Rutas API
// ---------------------------------------------------------------------------

app.use('/api/auth', createAuthRouter(getDb));
app.use('/api', createRepairsRouter(getDb));       // /api/repairs* (autenticadas) + /api/public/repairs/:token
app.use('/api', createExperimentRouter(getDb));    // /api/experiment-records* + /api/experiment-incidents*

// ---------------------------------------------------------------------------
// Manejo de errores
// ---------------------------------------------------------------------------

app.use('/api', (req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.originalUrl}` });
});

// Error de JSON mal formado u otros errores de Express.
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'El cuerpo de la petición no es un JSON válido.' });
  }
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'El cuerpo de la petición excede el tamaño permitido.' });
  }
  console.error('Error interno:', error);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

async function start() {
  db = await connectToMongoDB();
  await createPMVCollections();
  const seed = await seedDemoData(db);
  if (seed.demoRepairsSeeded.length > 0) {
    console.log(`Datos ficticios de demostración creados en: ${seed.demoRepairsSeeded.join(', ')} (DEMO-001 a DEMO-003).`);
  }
  console.log(`Talleres demo listos: ${seed.workshops.join(', ')} · cuenta investigadora: "investigador" (ver README).`);

  app.listen(PORT, () => {
    console.log(`ReparaYa backend (PMV E1) escuchando en http://localhost:${PORT}`);
    console.log(`API disponible en http://localhost:${PORT}/api/health`);
  });
}

async function shutdown(signal) {
  console.log(`\nRecibida ${signal}, cerrando...`);
  await disconnectFromMongoDB();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

start().catch((error) => {
  console.error('No se pudo iniciar el backend:', error.message);
  process.exit(1);
});
