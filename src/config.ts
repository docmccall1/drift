import path from 'path';

const DEFAULT_PORT = 4010;
const DEFAULT_DB_FILE = path.resolve(process.cwd(), 'drift.sqlite');

const parseNumber = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: parseNumber(process.env.PORT, DEFAULT_PORT),
  dbFile: process.env.DB_FILE || DEFAULT_DB_FILE,
  adapterMode: (process.env.ADAPTER_MODE || 'simulation') as 'simulation' | 'live',
  liveConnectorType: (process.env.LIVE_CONNECTOR_TYPE || 'fhir') as 'fhir' | 'vendor',
  ecwBaseUrl: process.env.ECW_BASE_URL || '',
  ecwClientId: process.env.ECW_CLIENT_ID || '',
  ecwClientSecret: process.env.ECW_CLIENT_SECRET || '',
  ecwTenant: process.env.ECW_TENANT || '',
  simulationSeed: parseNumber(process.env.SIM_SEED, 42),
  simulationStartDate: process.env.SIM_START_DATE || '2025-01-01',
  simulationMonths: parseNumber(process.env.SIM_MONTHS, 36),
  defaultDaysPerSecond: parseNumber(process.env.SIM_DAYS_PER_SECOND, 0.44),
  yellowThreshold: parseNumber(process.env.YELLOW_THRESHOLD, 30),
  redCandidateThreshold: parseNumber(process.env.RED_CANDIDATE_THRESHOLD, 60)
};
