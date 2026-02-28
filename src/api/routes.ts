import { NextFunction, Request, Response, Router } from 'express';
import { actorMiddleware, requireRole } from './auth';
import { simulationClock } from '../simulation/clock';
import {
  getAdminDashboard,
  getEventExportRows,
  getPatientById,
  getPatientScoresForExplainability,
  getPatientView,
  getPhysicianPanel,
  getRoleOptions,
  getSimulationSnapshot
} from '../services/queryService';
import {
  recalculatePatientHealthThrough,
  updatePatientPreferences
} from '../services/patientHealthService';
import {
  appendPortalCheckInMessage,
  completeTask,
  createCheckInTask,
  createPhysicianOutreachNoteTask,
  listTasks,
  reviewRedCandidateTask
} from '../services/taskService';
import { recalculateScoresThrough } from '../services/scoringService';
import { getClinicalAdapter } from '../adapters';
import { getFinanceDashboard, setRiskIntensity } from '../services/financeService';

const buildCsv = (rows: Array<Record<string, unknown>>): string => {
  if (rows.length === 0) {
    return '';
  }

  const headers = Object.keys(rows[0]);
  const escape = (value: unknown): string => {
    const text = value === null || value === undefined ? '' : String(value);
    if (text.includes(',') || text.includes('"') || text.includes('\n')) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escape(row[header])).join(','));
  }

  return lines.join('\n');
};

export const apiRouter = Router();

apiRouter.use(actorMiddleware);
apiRouter.use((_req, _res, next) => {
  simulationClock.tick();
  next();
});

apiRouter.get('/meta/options', (_req, res) => {
  res.json({
    roleOptions: getRoleOptions(),
    simulation: getSimulationSnapshot()
  });
});

apiRouter.get('/simulation/state', (_req, res) => {
  const state = simulationClock.getState();
  recalculateScoresThrough(new Date(state.clock_time));
  res.json({
    simulation: state,
    snapshot: getSimulationSnapshot()
  });
});

apiRouter.post('/simulation/start', requireRole('admin'), (_req, res) => {
  const state = simulationClock.start();
  res.json({ simulation: state });
});

apiRouter.post('/simulation/pause', requireRole('admin'), (_req, res) => {
  const state = simulationClock.pause();
  res.json({ simulation: state });
});

apiRouter.post('/simulation/resume', requireRole('admin'), (_req, res) => {
  const state = simulationClock.resume();
  res.json({ simulation: state });
});

apiRouter.post('/simulation/speed', requireRole('admin'), (req, res) => {
  const value = Number(req.body.daysPerSecond);
  if (!Number.isFinite(value)) {
    res.status(400).json({ error: 'daysPerSecond must be numeric.' });
    return;
  }
  const state = simulationClock.setSpeed(value);
  res.json({ simulation: state });
});

apiRouter.post('/simulation/jump', requireRole('admin'), (req, res) => {
  const value = `${req.body.isoDate || ''}`;
  if (!value) {
    res.status(400).json({ error: 'isoDate is required.' });
    return;
  }
  const state = simulationClock.jumpToDate(value);
  res.json({ simulation: state });
});

apiRouter.post('/simulation/reset', requireRole('admin'), (req, res) => {
  const seed = Number(req.body.seed);
  const intensity = `${req.body.riskIntensity || 'low'}` as 'low' | 'typical' | 'high';
  const state = simulationClock.resetSeed(Number.isFinite(seed) ? seed : undefined, intensity);
  res.json({ simulation: state });
});

apiRouter.post('/simulation/risk', requireRole('admin'), (req, res) => {
  const intensity = `${req.body.riskIntensity || ''}` as 'low' | 'typical' | 'high';
  const saved = setRiskIntensity(intensity);
  const current = getSimulationSnapshot();
  const state = simulationClock.resetSeed(current.seed, saved);
  res.json({ simulation: state, riskIntensity: saved });
});

apiRouter.get('/simulation/export.csv', requireRole('admin'), (_req, res) => {
  const state = simulationClock.getState();
  const rows = getEventExportRows(state.clock_time);

  const csv = buildCsv(
    rows.map((row) => ({
      id: row.id,
      patient_id: row.patient_id,
      provider_id: row.provider_id,
      event_type: row.event_type,
      simulated_at: row.simulated_at,
      service_date: row.service_date,
      icd10_list: row.icd10_list,
      paid_amount: row.paid_amount,
      payload_json: row.payload_json
    }))
  );

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="drift-events.csv"');
  res.send(csv);
});

apiRouter.get('/admin/dashboard', requireRole('admin'), (req, res) => {
  const filter = `${req.query.filter || 'all'}` as 'all' | 'diabetes' | 'hypertension' | 'uncategorized';
  res.json(getAdminDashboard(filter));
});

apiRouter.get('/finance/dashboard', requireRole('admin'), (req, res) => {
  const model = `${req.query.model || 'fully_funded'}` as 'fully_funded' | 'self_funded' | 'dpc';
  const compareModel = `${req.query.compareModel || 'self_funded'}` as 'fully_funded' | 'self_funded' | 'dpc';
  const baselineModel = `${req.query.baselineModel || 'fully_funded'}` as 'fully_funded' | 'self_funded' | 'dpc';
  const windowMonths = Number(req.query.windowMonths || 36);
  res.json(getFinanceDashboard({ model, compareModel, baselineModel, windowMonths }));
});

apiRouter.get('/admin/tasks', requireRole('admin'), (_req, res) => {
  res.json({ tasks: listTasks() });
});

apiRouter.post('/admin/tasks/:id/review', requireRole('admin'), (req, res) => {
  const actorId = req.actor?.actorId || 'admin-sim';
  const decision = `${req.body.decision || ''}`;
  if (decision !== 'confirm_red' && decision !== 'downgrade_yellow') {
    res.status(400).json({ error: 'decision must be confirm_red or downgrade_yellow.' });
    return;
  }

  reviewRedCandidateTask(req.params.id, decision, actorId, new Date());

  const sim = getSimulationSnapshot();
  recalculateScoresThrough(new Date(sim.clock_time));
  res.json({ ok: true });
});

apiRouter.post('/admin/tasks/:id/complete', requireRole('admin'), (req, res) => {
  const notes = req.body.notes ? String(req.body.notes) : null;
  completeTask(req.params.id, notes, new Date());
  res.json({ ok: true });
});

apiRouter.get('/physician/panel', requireRole('physician'), (req, res) => {
  const providerId = req.actor?.actorId;
  if (!providerId) {
    res.status(400).json({ error: 'x-actor-id provider id required for physician.' });
    return;
  }

  res.json(getPhysicianPanel(providerId));
});

apiRouter.get('/physician/patient/:id/explainability', requireRole('physician'), (req, res) => {
  const providerId = req.actor?.actorId;
  if (!providerId) {
    res.status(400).json({ error: 'x-actor-id provider id required for physician.' });
    return;
  }

  const patient = getPatientById(req.params.id);
  if (!patient || patient.provider_id !== providerId) {
    res.status(403).json({ error: 'Physician can only access panel patients.' });
    return;
  }

  res.json({ patientId: patient.id, history: getPatientScoresForExplainability(patient.id, 12) });
});

apiRouter.post('/physician/patient/:id/note-stub', requireRole('physician'), (req, res) => {
  const providerId = req.actor?.actorId;
  if (!providerId) {
    res.status(400).json({ error: 'x-actor-id provider id required for physician.' });
    return;
  }

  const patient = getPatientById(req.params.id);
  if (!patient || patient.provider_id !== providerId) {
    res.status(403).json({ error: 'Physician can only access panel patients.' });
    return;
  }

  const task = createPhysicianOutreachNoteTask(patient.id, providerId, new Date());
  res.json({ task });
});

apiRouter.get('/patient/me', requireRole('patient'), (req, res) => {
  const patientId = req.actor?.actorId;
  if (!patientId) {
    res.status(400).json({ error: 'x-actor-id patient id required for patient role.' });
    return;
  }

  try {
    recalculatePatientHealthThrough(new Date(getSimulationSnapshot().clock_time));
    const payload = getPatientView(patientId);
    res.json(payload);
  } catch (error) {
    res.status(404).json({ error: (error as Error).message });
  }
});

apiRouter.post('/patient/me/preferences', requireRole('patient'), (req, res) => {
  const patientId = req.actor?.actorId;
  if (!patientId) {
    res.status(400).json({ error: 'x-actor-id patient id required for patient role.' });
    return;
  }

  try {
    const updated = updatePatientPreferences(patientId, req.body ?? {}, new Date());
    recalculatePatientHealthThrough(new Date(getSimulationSnapshot().clock_time));
    const payload = getPatientView(patientId);
    res.json({ preferences: updated, view: payload });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

apiRouter.post('/patient/me/request-checkin', requireRole('patient'), (req, res) => {
  const patientId = req.actor?.actorId;
  if (!patientId) {
    res.status(400).json({ error: 'x-actor-id patient id required for patient role.' });
    return;
  }

  const task = createCheckInTask(patientId, new Date());
  if (req.body?.createPortalMessage !== false) {
    appendPortalCheckInMessage(patientId, new Date());
  }

  res.json({ task, message: 'Check-in request sent.' });
});

apiRouter.get('/integration/pulls', requireRole('admin'), async (req, res) => {
  const start = req.query.start?.toString();
  const end = req.query.end?.toString();

  if (!start || !end) {
    res.status(400).json({ error: 'start and end query parameters are required.' });
    return;
  }

  const adapter = getClinicalAdapter();

  const [portalMessages, refillRequests, encounters, appointments, labsVitals, claims] = await Promise.all([
    adapter.fetchPortalMessages({ start, end }),
    adapter.fetchRefillRequests({ start, end }),
    adapter.fetchEncounterDiagnoses({ start, end }),
    adapter.fetchAppointments({ start, end }),
    adapter.fetchLabsAndVitals({ start, end }),
    adapter.fetchClaimsOrCharges({ start, end })
  ]);

  res.json({
    adapterMode: adapter.mode,
    range: { start, end },
    counts: {
      portalMessages: portalMessages.length,
      refillRequests: refillRequests.length,
      encounters: encounters.length,
      appointments: appointments.length,
      labsVitals: labsVitals.length,
      claims: claims.length
    }
  });
});

apiRouter.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  res.status(500).json({ error: message });
});
