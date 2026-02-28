import path from 'path';
import express from 'express';
import { config } from './config';
import { initSchema, db } from './db';
import { resetAndSeedSimulation } from './simulation/seeder';
import { simulationClock } from './simulation/clock';
import { recalculateScoresThrough } from './services/scoringService';
import { apiRouter } from './api/routes';

const ensureSeeded = (): void => {
  const row = db.prepare(`SELECT COUNT(*) as count FROM simulation_state`).get() as { count: number };
  if (row.count === 0) {
    resetAndSeedSimulation(config.simulationSeed);
  }

  const state = db.prepare(`SELECT clock_time FROM simulation_state WHERE id = 1`).get() as
    | { clock_time: string }
    | undefined;

  if (state) {
    recalculateScoresThrough(new Date(state.clock_time));
  }
};

initSchema();
ensureSeeded();

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api', apiRouter);

const staticRoot = process.env.NODE_ENV === 'production'
  ? path.resolve(process.cwd(), 'dist/public')
  : path.resolve(process.cwd(), 'src/public');

app.use(express.static(staticRoot));

app.get('*', (_req, res) => {
  res.sendFile(path.join(staticRoot, 'index.html'));
});

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Drift 1.0 running at http://localhost:${config.port}`);
});

simulationClock.ensureStarted();
