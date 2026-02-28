import { randomUUID } from 'crypto';
import { db } from '../db';
import { config } from '../config';
import { computeDriftForWeek, PreviousScoreSnapshot } from '../drift/engine';
import { DriftThresholds, EventRecord, Patient, PatientStatus } from '../types/domain';
import { addDays, startOfWeek } from '../utils/time';
import { recalculatePatientHealthThrough } from './patientHealthService';

interface PatientRow extends Patient {}

interface WeeklyScoreRow {
  cdi_total: number;
  status: PatientStatus;
  has_severe_trigger: number;
}

const thresholds: DriftThresholds = {
  yellow: config.yellowThreshold,
  redCandidate: config.redCandidateThreshold
};

const getPatients = (): PatientRow[] => {
  return db.prepare(`SELECT * FROM patients ORDER BY id`).all() as PatientRow[];
};

const getSimulationState = (): { start_time: string; last_processed_week: string } => {
  const state = db
    .prepare(`SELECT start_time, last_processed_week FROM simulation_state WHERE id = 1`)
    .get() as { start_time: string; last_processed_week: string } | undefined;

  if (!state) {
    throw new Error('Simulation state missing');
  }

  return state;
};

const parseEventRow = (row: {
  id: string;
  patient_id: string;
  provider_id: string | null;
  event_type: EventRecord['event_type'];
  simulated_at: string;
  service_date: string | null;
  icd10_json: string;
  paid_amount: number | null;
  payload_json: string;
}): EventRecord => ({
  id: row.id,
  patient_id: row.patient_id,
  provider_id: row.provider_id,
  event_type: row.event_type,
  simulated_at: row.simulated_at,
  service_date: row.service_date,
  icd10_list: JSON.parse(row.icd10_json),
  paid_amount: row.paid_amount,
  payload: JSON.parse(row.payload_json)
});

const getEventsForPatientRange = (patientId: string, startIso: string, endIso: string): EventRecord[] => {
  const rows = db
    .prepare(
      `SELECT id, patient_id, provider_id, event_type, simulated_at, service_date, icd10_json, paid_amount, payload_json
       FROM events
       WHERE patient_id = ?
         AND simulated_at >= ?
         AND simulated_at < ?
       ORDER BY simulated_at ASC`
    )
    .all(patientId, startIso, endIso) as Array<{
    id: string;
    patient_id: string;
    provider_id: string | null;
    event_type: EventRecord['event_type'];
    simulated_at: string;
    service_date: string | null;
    icd10_json: string;
    paid_amount: number | null;
    payload_json: string;
  }>;

  return rows.map(parseEventRow);
};

const getPreviousScore = (patientId: string, weekStartIso: string): PreviousScoreSnapshot | null => {
  const row = db
    .prepare(
      `SELECT cdi_total, status, has_severe_trigger
       FROM weekly_scores
       WHERE patient_id = ? AND week_start < ?
       ORDER BY week_start DESC
       LIMIT 1`
    )
    .get(patientId, weekStartIso) as WeeklyScoreRow | undefined;

  if (!row) {
    return null;
  }

  return {
    cdiTotal: row.cdi_total,
    status: row.status,
    hasSevereTrigger: row.has_severe_trigger === 1
  };
};

const upsertWeeklyScore = db.prepare(
  `INSERT INTO weekly_scores (
     id,
     patient_id,
     week_start,
     cdi_total,
     utilization,
     behavioral,
     biometric,
     physician_modifier,
     status,
     velocity,
     has_severe_trigger,
     top_signals_json,
     created_at
   ) VALUES (
     @id,
     @patient_id,
     @week_start,
     @cdi_total,
     @utilization,
     @behavioral,
     @biometric,
     @physician_modifier,
     @status,
     @velocity,
     @has_severe_trigger,
     @top_signals_json,
     @created_at
   )
   ON CONFLICT(patient_id, week_start)
   DO UPDATE SET
     cdi_total = excluded.cdi_total,
     utilization = excluded.utilization,
     behavioral = excluded.behavioral,
     biometric = excluded.biometric,
     physician_modifier = excluded.physician_modifier,
     status = excluded.status,
     velocity = excluded.velocity,
     has_severe_trigger = excluded.has_severe_trigger,
     top_signals_json = excluded.top_signals_json,
     created_at = excluded.created_at`
);

const hasTaskForWeek = db.prepare(
  `SELECT 1
   FROM tasks
   WHERE patient_id = ?
     AND task_type = ?
     AND source_week = ?
   LIMIT 1`
);

const insertTask = db.prepare(
  `INSERT INTO tasks (
     id,
     patient_id,
     assigned_role,
     assigned_user_id,
     task_type,
     source_week,
     due_at,
     created_at,
     completed_at,
     status,
     priority,
     notes
   ) VALUES (
     @id,
     @patient_id,
     @assigned_role,
     @assigned_user_id,
     @task_type,
     @source_week,
     @due_at,
     @created_at,
     NULL,
     'open',
     @priority,
     @notes
   )`
);

const maybeCreateTask = (
  patientId: string,
  taskType: 'yellow_outreach' | 'red_review',
  sourceWeek: string,
  now: Date
): void => {
  const exists = hasTaskForWeek.get(patientId, taskType, sourceWeek);
  if (exists) {
    return;
  }

  const dueHours = taskType === 'red_review' ? 24 : 72;

  insertTask.run({
    id: randomUUID(),
    patient_id: patientId,
    assigned_role: taskType === 'red_review' ? 'admin' : 'care_manager',
    assigned_user_id: null,
    task_type: taskType,
    source_week: sourceWeek,
    due_at: new Date(now.getTime() + dueHours * 60 * 60 * 1000).toISOString(),
    created_at: now.toISOString(),
    priority: taskType === 'red_review' ? 'high' : 'medium',
    notes:
      taskType === 'red_review'
        ? 'Red Candidate review required within 24 hours.'
        : 'Yellow outreach due in 48-72 hours.'
  });
};

const resolveManualStatus = (patient: PatientRow, atDate: Date): 'RED' | 'YELLOW' | null => {
  if (!patient.manual_status || !patient.manual_status_expires_at) {
    return null;
  }

  const expiry = new Date(patient.manual_status_expires_at);
  if (expiry <= atDate) {
    db.prepare(
      `UPDATE patients SET manual_status = NULL, manual_status_expires_at = NULL WHERE id = ?`
    ).run(patient.id);
    return null;
  }

  if (patient.manual_status === 'RED' || patient.manual_status === 'YELLOW') {
    return patient.manual_status;
  }

  return null;
};

const markOverdueTasks = (now: Date): void => {
  db.prepare(
    `UPDATE tasks
     SET status = 'overdue'
     WHERE status = 'open' AND due_at < ?`
  ).run(now.toISOString());
};

const setLastProcessedWeek = db.prepare(
  `UPDATE simulation_state SET last_processed_week = ?, last_real_update = ? WHERE id = 1`
);

export const recalculateScoresThrough = (currentTime: Date): void => {
  const state = getSimulationState();

  const start = new Date(state.start_time);
  let lastProcessedWeek = new Date(state.last_processed_week);
  const currentWeekStart = startOfWeek(currentTime);

  if (Number.isNaN(lastProcessedWeek.getTime())) {
    lastProcessedWeek = addDays(startOfWeek(start), -7);
  }

  if (lastProcessedWeek >= currentWeekStart) {
    markOverdueTasks(currentTime);
    recalculatePatientHealthThrough(currentTime);
    return;
  }

  const patients = getPatients();

  const runTransaction = db.transaction(() => {
    while (lastProcessedWeek < currentWeekStart) {
      const weekStart = addDays(startOfWeek(lastProcessedWeek), 7);
      const weekStartIso = weekStart.toISOString();
      const baselineStart = addDays(start, -90);
      const weekEnd = addDays(weekStart, 7);

      for (const patient of patients) {
        const events = getEventsForPatientRange(patient.id, baselineStart.toISOString(), weekEnd.toISOString());
        const baselineEvents = events.filter((event) => {
          const at = new Date(event.simulated_at);
          return at >= baselineStart && at < start;
        });

        const previous = getPreviousScore(patient.id, weekStartIso);
        const manualStatus = resolveManualStatus(patient, weekStart);

        const result = computeDriftForWeek({
          weekStart,
          events,
          baselineEvents,
          previousScore: previous,
          thresholds,
          manualStatus
        });

        upsertWeeklyScore.run({
          id: randomUUID(),
          patient_id: patient.id,
          week_start: weekStartIso,
          cdi_total: result.cdiTotal,
          utilization: result.utilization,
          behavioral: result.behavioral,
          biometric: result.biometric,
          physician_modifier: result.physicianModifier,
          status: result.status,
          velocity: result.velocity,
          has_severe_trigger: result.hasSevereTrigger ? 1 : 0,
          top_signals_json: JSON.stringify(result.contributions),
          created_at: new Date().toISOString()
        });

        const previousStatus = previous?.status;
        if (result.status === 'YELLOW' && previousStatus !== 'YELLOW' && previousStatus !== 'RED') {
          maybeCreateTask(patient.id, 'yellow_outreach', weekStartIso, currentTime);
        }

        if (result.status === 'RED_CANDIDATE' && previousStatus !== 'RED_CANDIDATE' && previousStatus !== 'RED') {
          maybeCreateTask(patient.id, 'red_review', weekStartIso, currentTime);
        }
      }

      lastProcessedWeek = weekStart;
      setLastProcessedWeek.run(lastProcessedWeek.toISOString(), Date.now());
    }
  });

  runTransaction();
  markOverdueTasks(currentTime);
  recalculatePatientHealthThrough(currentTime);
};

export const getCurrentScoresByPatient = (): Array<{
  patient_id: string;
  cdi_total: number;
  status: PatientStatus;
  utilization: number;
  behavioral: number;
  biometric: number;
  physician_modifier: number;
  velocity: number;
  top_signals_json: string;
  week_start: string;
}> => {
  const latestWeek = db
    .prepare(`SELECT MAX(week_start) as latest_week FROM weekly_scores`)
    .get() as { latest_week: string | null };

  if (!latestWeek.latest_week) {
    return [];
  }

  return db
    .prepare(
      `SELECT patient_id, cdi_total, status, utilization, behavioral, biometric, physician_modifier, velocity, top_signals_json, week_start
       FROM weekly_scores
       WHERE week_start = ?`
    )
    .all(latestWeek.latest_week) as Array<{
    patient_id: string;
    cdi_total: number;
    status: PatientStatus;
    utilization: number;
    behavioral: number;
    biometric: number;
    physician_modifier: number;
    velocity: number;
    top_signals_json: string;
    week_start: string;
  }>;
};
