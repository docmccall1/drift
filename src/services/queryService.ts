import { db } from '../db';
import { PatientStatus, SignalContribution } from '../types/domain';
import { addDays } from '../utils/time';
import { getPatientPreferences } from './patientHealthService';

interface ScoreRow {
  patient_id: string;
  week_start: string;
  cdi_total: number;
  utilization: number;
  behavioral: number;
  biometric: number;
  physician_modifier: number;
  status: PatientStatus;
  velocity: number;
  top_signals_json: string;
}

interface JoinedScoreRow extends ScoreRow {
  first_name: string;
  last_name: string;
  provider_id: string;
  diabetes: number;
  hypertension: number;
  behavioral_health: number;
  manual_status: string | null;
}

const getLatestWeeks = (): { latest: string | null; previous: string | null } => {
  const rows = db
    .prepare(`SELECT DISTINCT week_start FROM weekly_scores ORDER BY week_start DESC LIMIT 2`)
    .all() as Array<{ week_start: string }>;

  return {
    latest: rows[0]?.week_start ?? null,
    previous: rows[1]?.week_start ?? null
  };
};

const parseSignals = (json: string): SignalContribution[] => {
  try {
    return JSON.parse(json) as SignalContribution[];
  } catch {
    return [];
  }
};

const normalizeForPatient = (status: PatientStatus): 'GREEN' | 'YELLOW' | 'RED' => {
  if (status === 'RED') {
    return 'RED';
  }
  if (status === 'YELLOW') {
    return 'YELLOW';
  }
  if (status === 'RED_CANDIDATE') {
    return 'YELLOW';
  }
  return 'GREEN';
};

const recommendedAction = (status: PatientStatus): string => {
  if (status === 'RED' || status === 'RED_CANDIDATE') {
    return 'Immediate care manager review and physician touchpoint within 24h.';
  }
  if (status === 'YELLOW') {
    return 'Outreach within 48-72h and reinforce treatment cadence.';
  }
  if (status === 'YELLOW_OBSERVATION') {
    return 'Monitor for one-week confirmation window and prep outreach.';
  }
  return 'Routine cadence; continue monitoring.';
};

export const getSimulationSnapshot = (): {
  clock_time: string;
  start_time: string;
  end_time: string;
  speed_days_per_second: number;
  clock_status: string;
  seed: number;
} => {
  return db
    .prepare(
      `SELECT clock_time, start_time, end_time, speed_days_per_second, clock_status, seed
       FROM simulation_state
       WHERE id = 1`
    )
    .get() as {
    clock_time: string;
    start_time: string;
    end_time: string;
    speed_days_per_second: number;
    clock_status: string;
    seed: number;
  };
};

export const getRoleOptions = (): {
  providers: Array<{ id: string; name: string }>;
  patients: Array<{ id: string; label: string; provider_id: string }>;
} => {
  const providers = db
    .prepare(`SELECT id, name FROM providers ORDER BY id`)
    .all() as Array<{ id: string; name: string }>;

  const patients = db
    .prepare(`SELECT id, first_name, last_name, provider_id FROM patients ORDER BY id`)
    .all() as Array<{
    id: string;
    first_name: string;
    last_name: string;
    provider_id: string;
  }>;

  return {
    providers,
    patients: patients.map((patient) => ({
      id: patient.id,
      provider_id: patient.provider_id,
      label: `${patient.first_name} ${patient.last_name}`
    }))
  };
};

const getJoinedScoresForWeek = (weekStart: string): JoinedScoreRow[] => {
  return db
    .prepare(
      `SELECT
         ws.patient_id,
         ws.week_start,
         ws.cdi_total,
         ws.utilization,
         ws.behavioral,
         ws.biometric,
         ws.physician_modifier,
         ws.status,
         ws.velocity,
         ws.top_signals_json,
         p.first_name,
         p.last_name,
         p.provider_id,
         p.diabetes,
         p.hypertension,
         p.behavioral_health,
         p.manual_status
       FROM weekly_scores ws
       JOIN patients p ON p.id = ws.patient_id
       WHERE ws.week_start = ?`
    )
    .all(weekStart) as JoinedScoreRow[];
};

export const getAdminDashboard = (filter: 'all' | 'diabetes' | 'hypertension' | 'uncategorized'): {
  summary: {
    stabilityIndex: number;
    averageCdi: number;
    deltaFromPriorWeek: number;
    counts: Record<'GREEN' | 'YELLOW' | 'RED' | 'RED_CANDIDATE', number>;
  };
  trends: Array<{ week_start: string; average_cdi: number; green: number; yellow: number; red: number; red_candidate: number }>;
  workload: { due: number; overdue: number; completed: number };
  drivers: Array<{ signal: string; count: number }>;
  acceptance: {
    yellowOrHigherPctInFirstTwoMonths: number;
    redCandidatePctInFirstTwoMonths: number;
    yellowReturnedToGreenCount: number;
  };
} => {
  const { latest, previous } = getLatestWeeks();
  if (!latest) {
    return {
      summary: {
        stabilityIndex: 100,
        averageCdi: 0,
        deltaFromPriorWeek: 0,
        counts: {
          GREEN: 0,
          YELLOW: 0,
          RED: 0,
          RED_CANDIDATE: 0
        }
      },
      trends: [],
      workload: { due: 0, overdue: 0, completed: 0 },
      drivers: [],
      acceptance: {
        yellowOrHigherPctInFirstTwoMonths: 0,
        redCandidatePctInFirstTwoMonths: 0,
        yellowReturnedToGreenCount: 0
      }
    };
  }

  const filtered = (rows: JoinedScoreRow[]): JoinedScoreRow[] => {
    if (filter === 'all') {
      return rows;
    }
    if (filter === 'diabetes') {
      return rows.filter((row) => row.diabetes === 1);
    }
    if (filter === 'hypertension') {
      return rows.filter((row) => row.hypertension === 1);
    }
    return rows.filter((row) =>
      parseSignals(row.top_signals_json).some((signal) => signal.signal === 'uncategorized_utilization')
    );
  };

  const latestRows = filtered(getJoinedScoresForWeek(latest));
  const previousRows = previous ? filtered(getJoinedScoresForWeek(previous)) : [];

  const counts = {
    GREEN: 0,
    YELLOW: 0,
    RED: 0,
    RED_CANDIDATE: 0
  };

  for (const row of latestRows) {
    if (row.status === 'RED_CANDIDATE') {
      counts.RED_CANDIDATE += 1;
      continue;
    }
    if (row.status === 'RED') {
      counts.RED += 1;
      continue;
    }
    if (row.status === 'YELLOW') {
      counts.YELLOW += 1;
      continue;
    }
    counts.GREEN += 1;
  }

  const avgLatest = latestRows.length
    ? latestRows.reduce((sum, row) => sum + row.cdi_total, 0) / latestRows.length
    : 0;
  const avgPrevious = previousRows.length
    ? previousRows.reduce((sum, row) => sum + row.cdi_total, 0) / previousRows.length
    : 0;

  const delta = avgLatest - avgPrevious;
  const stabilityIndex = Math.max(0, Math.min(100, 100 - avgLatest - delta * 1.5));

  const trendWeeks = db
    .prepare(`SELECT DISTINCT week_start FROM weekly_scores ORDER BY week_start DESC LIMIT 12`)
    .all() as Array<{ week_start: string }>;

  const trends = trendWeeks
    .map((week) => {
      const rows = filtered(getJoinedScoresForWeek(week.week_start));
      const average_cdi = rows.length
        ? rows.reduce((sum, row) => sum + row.cdi_total, 0) / rows.length
        : 0;
      const stats = {
        week_start: week.week_start,
        average_cdi: Number(average_cdi.toFixed(1)),
        green: rows.filter((row) => row.status === 'GREEN' || row.status === 'YELLOW_OBSERVATION').length,
        yellow: rows.filter((row) => row.status === 'YELLOW').length,
        red: rows.filter((row) => row.status === 'RED').length,
        red_candidate: rows.filter((row) => row.status === 'RED_CANDIDATE').length
      };
      return stats;
    })
    .reverse();

  const workloadRows = db
    .prepare(`SELECT status, COUNT(*) as count FROM tasks GROUP BY status`)
    .all() as Array<{ status: string; count: number }>;

  const workload = {
    due: workloadRows.find((row) => row.status === 'open')?.count ?? 0,
    overdue: workloadRows.find((row) => row.status === 'overdue')?.count ?? 0,
    completed: workloadRows.find((row) => row.status === 'completed')?.count ?? 0
  };

  const driverMap = new Map<string, number>();
  for (const row of latestRows) {
    const signals = parseSignals(row.top_signals_json);
    for (const signal of signals) {
      driverMap.set(signal.signal, (driverMap.get(signal.signal) ?? 0) + 1);
    }
  }
  const drivers = Array.from(driverMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([signal, count]) => ({ signal, count }));

  const twoMonthsAfterStart = (() => {
    const sim = getSimulationSnapshot();
    return addDays(new Date(sim.start_time), 60).toISOString();
  })();

  const firstTwoMonthsRows = db
    .prepare(
      `SELECT DISTINCT patient_id, status
       FROM weekly_scores
       WHERE week_start <= ?`
    )
    .all(twoMonthsAfterStart) as Array<{ patient_id: string; status: PatientStatus }>;

  const byPatient = new Map<string, Set<PatientStatus>>();
  for (const row of firstTwoMonthsRows) {
    if (!byPatient.has(row.patient_id)) {
      byPatient.set(row.patient_id, new Set());
    }
    byPatient.get(row.patient_id)?.add(row.status);
  }

  const population = db.prepare(`SELECT COUNT(*) as count FROM patients`).get() as { count: number };

  let yellowOrHigher = 0;
  let redCandidate = 0;
  for (const statuses of byPatient.values()) {
    if (
      statuses.has('YELLOW') ||
      statuses.has('YELLOW_OBSERVATION') ||
      statuses.has('RED_CANDIDATE') ||
      statuses.has('RED')
    ) {
      yellowOrHigher += 1;
    }
    if (statuses.has('RED_CANDIDATE') || statuses.has('RED')) {
      redCandidate += 1;
    }
  }

  const yellowToGreenCount = db
    .prepare(
      `WITH transitions AS (
         SELECT
           patient_id,
           week_start,
           status,
           LAG(status) OVER (PARTITION BY patient_id ORDER BY week_start) AS prior_status
         FROM weekly_scores
       )
       SELECT COUNT(*) as count
       FROM transitions
       WHERE status = 'GREEN'
         AND prior_status IN ('YELLOW', 'YELLOW_OBSERVATION')`
    )
    .get() as { count: number };

  return {
    summary: {
      stabilityIndex: Number(stabilityIndex.toFixed(1)),
      averageCdi: Number(avgLatest.toFixed(1)),
      deltaFromPriorWeek: Number(delta.toFixed(1)),
      counts
    },
    trends,
    workload,
    drivers,
    acceptance: {
      yellowOrHigherPctInFirstTwoMonths: Number(((yellowOrHigher / population.count) * 100).toFixed(1)),
      redCandidatePctInFirstTwoMonths: Number(((redCandidate / population.count) * 100).toFixed(1)),
      yellowReturnedToGreenCount: yellowToGreenCount.count
    }
  };
};

export const getPhysicianPanel = (providerId: string): {
  panel: Array<{
    patient_id: string;
    name: string;
    status: PatientStatus;
    cdi: number;
    velocity: number;
    diabetes: boolean;
    hypertension: boolean;
    behavioralHealth: boolean;
    topDrivers: SignalContribution[];
    recommendedAction: string;
  }>;
  newlyYellowThisWeek: Array<{ patient_id: string; name: string; cdi: number }>;
  redCandidatesAwaitingReview: Array<{ patient_id: string; name: string; cdi: number; task_id: string }>;
} => {
  const { latest, previous } = getLatestWeeks();
  if (!latest) {
    return {
      panel: [],
      newlyYellowThisWeek: [],
      redCandidatesAwaitingReview: []
    };
  }

  const rows = getJoinedScoresForWeek(latest).filter((row) => row.provider_id === providerId);

  const previousStatuses = new Map<string, PatientStatus>();
  if (previous) {
    for (const row of getJoinedScoresForWeek(previous).filter((item) => item.provider_id === providerId)) {
      previousStatuses.set(row.patient_id, row.status);
    }
  }

  const panel = rows
    .map((row) => ({
      patient_id: row.patient_id,
      name: `${row.first_name} ${row.last_name}`,
      status: row.status,
      cdi: Number(row.cdi_total.toFixed(1)),
      velocity: Number(row.velocity.toFixed(1)),
      diabetes: row.diabetes === 1,
      hypertension: row.hypertension === 1,
      behavioralHealth: row.behavioral_health === 1,
      topDrivers: parseSignals(row.top_signals_json).slice(0, 3),
      recommendedAction: recommendedAction(row.status)
    }))
    .sort((a, b) => b.cdi - a.cdi);

  const newlyYellowThisWeek = panel
    .filter((item) => item.status === 'YELLOW')
    .filter((item) => {
      const prior = previousStatuses.get(item.patient_id);
      return prior !== 'YELLOW' && prior !== 'RED';
    })
    .map((item) => ({ patient_id: item.patient_id, name: item.name, cdi: item.cdi }));

  const redReviewTasks = db
    .prepare(
      `SELECT t.id as task_id, t.patient_id, p.first_name, p.last_name, ws.cdi_total
       FROM tasks t
       JOIN patients p ON p.id = t.patient_id
       JOIN weekly_scores ws ON ws.patient_id = t.patient_id
       WHERE t.task_type = 'red_review'
         AND t.status IN ('open', 'overdue')
         AND p.provider_id = ?
         AND ws.week_start = ?`
    )
    .all(providerId, latest) as Array<{
    task_id: string;
    patient_id: string;
    first_name: string;
    last_name: string;
    cdi_total: number;
  }>;

  const redCandidatesAwaitingReview = redReviewTasks.map((row) => ({
    patient_id: row.patient_id,
    name: `${row.first_name} ${row.last_name}`,
    cdi: Number(row.cdi_total.toFixed(1)),
    task_id: row.task_id
  }));

  return {
    panel,
    newlyYellowThisWeek,
    redCandidatesAwaitingReview
  };
};

const pickMessageByDeterministicHash = (key: string, options: string[]): string => {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return options[h % options.length];
};

const buildEncouragementMessage = (
  patientId: string,
  monthStart: string,
  slope3: number,
  preventionDelta: number,
  avoidableDelta: number,
  enabledActionCount: number
): string => {
  if (slope3 >= 2.2) {
    return pickMessageByDeterministicHash(`${patientId}:${monthStart}:up:${enabledActionCount}`, [
      'Momentum is building, keep the streak going.',
      'More consistent check-ins are paying off.',
      'Your steady habits are moving health in a better direction.'
    ]);
  }

  if (avoidableDelta < 0) {
    return pickMessageByDeterministicHash(`${patientId}:${monthStart}:avoid:${enabledActionCount}`, [
      'Fewer avoidable events this month, that is a real win.',
      'Lower disruption is showing up in your trend.',
      'You reduced avoidable events, and that momentum matters.'
    ]);
  }

  if (preventionDelta > 1.5) {
    return pickMessageByDeterministicHash(`${patientId}:${monthStart}:prevent:${enabledActionCount}`, [
      'Preventive momentum is improving, keep leaning in.',
      'Your checkup consistency is strengthening your trend.',
      'These preventive steps are helping your long-term stability.'
    ]);
  }

  if (slope3 <= -2.2) {
    return pickMessageByDeterministicHash(`${patientId}:${monthStart}:down:${enabledActionCount}`, [
      'Small steps this month can shift your trend back up.',
      'A simple reset in routines can quickly improve momentum.',
      'You can turn this around with steady check-ins and support.'
    ]);
  }

  return pickMessageByDeterministicHash(`${patientId}:${monthStart}:steady:${enabledActionCount}`, [
    'Your trend is steady, keep building momentum.',
    'Consistency is your advantage right now.',
    'Steady progress counts, keep your current rhythm.'
  ]);
};

interface CareManagerRecommendation {
  id: string;
  title: string;
  whyNow: string;
  evidenceBasis: string;
  priority: 'high' | 'medium';
  rnNextSteps: string[];
}

const buildCareManagerRecommendations = (input: {
  patientId: string;
  diabetes: number;
  hypertension: number;
  behavioralHealth: number;
  monthly: Array<{
    medication_adherence_proxy: number;
    preventive_care_completion: number;
    stress_sleep_proxy: number;
    out_of_pocket_strain_index: number;
    avoidable_events: number;
  }>;
}): CareManagerRecommendation[] => {
  const latest = input.monthly[input.monthly.length - 1];
  if (!latest) {
    return [];
  }

  const lastA1c = db
    .prepare(
      `SELECT CAST(json_extract(payload_json, '$.value') AS REAL) as value
       FROM events
       WHERE patient_id = ?
         AND event_type = 'LabResult'
         AND json_extract(payload_json, '$.lab_name') = 'A1c'
       ORDER BY simulated_at DESC
       LIMIT 1`
    )
    .get(input.patientId) as { value: number | null } | undefined;

  const recentBp = db
    .prepare(
      `SELECT
         AVG(CAST(json_extract(payload_json, '$.bp_systolic') AS REAL)) as sys,
         AVG(CAST(json_extract(payload_json, '$.bp_diastolic') AS REAL)) as dia
       FROM (
         SELECT payload_json
         FROM events
         WHERE patient_id = ?
           AND event_type = 'VitalReading'
           AND json_type(payload_json, '$.bp_systolic') IS NOT NULL
         ORDER BY simulated_at DESC
         LIMIT 3
       )`
    )
    .get(input.patientId) as { sys: number | null; dia: number | null };

  const recs: CareManagerRecommendation[] = [];

  if (input.diabetes === 1 && ((lastA1c?.value ?? 0) >= 8.5 || latest.medication_adherence_proxy < 75)) {
    recs.push({
      id: 'dm-control',
      title: 'Diabetes control support workflow',
      whyNow: `A1c and/or adherence trend suggests elevated near-term risk (A1c ${lastA1c?.value ?? 'n/a'}).`,
      evidenceBasis: 'ADA Standards of Care: prioritize medication adherence, self-management support, and close follow-up for elevated A1c.',
      priority: 'high',
      rnNextSteps: [
        'Complete RN medication reconciliation and identify affordability/refill barriers.',
        'Schedule diabetes-focused check-in within 7 days and document teach-back.',
        'Coordinate lab recheck plan and escalate to PCP for therapy review when needed.'
      ]
    });
  }

  if (input.hypertension === 1 && ((recentBp.sys ?? 0) >= 140 || (recentBp.dia ?? 0) >= 90)) {
    recs.push({
      id: 'htn-followup',
      title: 'Hypertension follow-up protocol',
      whyNow: `Recent blood pressure trend remains above goal (${Math.round(recentBp.sys ?? 0)}/${Math.round(
        recentBp.dia ?? 0
      )}).`,
      evidenceBasis: 'ACC/AHA hypertension guidance: confirm elevated readings, reinforce adherence, and arrange timely follow-up.',
      priority: 'high',
      rnNextSteps: [
        'Arrange home BP check process and verify cuff technique.',
        'Perform side-effect and adherence check; document findings for PCP.',
        'Book RN or PCP follow-up within 1-2 weeks.'
      ]
    });
  }

  if (latest.preventive_care_completion < 55) {
    recs.push({
      id: 'preventive-gap',
      title: 'Preventive care gap closure',
      whyNow: 'Preventive completion is below target this month.',
      evidenceBasis: 'USPSTF-aligned preventive outreach improves timely screening completion and downstream outcomes.',
      priority: 'medium',
      rnNextSteps: [
        'Run preventive gap outreach call/text workflow.',
        'Offer scheduling support and remove access barriers.',
        'Document completion plan and set reminder follow-up.'
      ]
    });
  }

  if (latest.avoidable_events >= 2) {
    recs.push({
      id: 'avoidable-event-review',
      title: 'Post-event care navigation plan',
      whyNow: 'Avoidable acute events increased this month.',
      evidenceBasis: 'Care transition and navigation programs reduce repeated avoidable acute utilization.',
      priority: 'high',
      rnNextSteps: [
        'Complete post-event RN review within 72 hours.',
        'Confirm PCP follow-up and reinforce same-day access pathways.',
        'Activate care navigation support for next 30 days.'
      ]
    });
  }

  if (latest.out_of_pocket_strain_index >= 70) {
    recs.push({
      id: 'cost-barrier',
      title: 'Cost-barrier mitigation outreach',
      whyNow: 'Financial strain index is high and may undermine adherence.',
      evidenceBasis: 'Financial barrier screening and medication-cost support improve adherence continuity.',
      priority: 'medium',
      rnNextSteps: [
        'Screen for cost-related nonadherence and document barrier type.',
        'Escalate to benefits/pharmacy support for lower-cost options.',
        'Set a 2-week adherence checkback.'
      ]
    });
  }

  if (input.behavioralHealth === 1 && latest.stress_sleep_proxy < 45) {
    recs.push({
      id: 'behavioral-support',
      title: 'Behavioral health supportive follow-up',
      whyNow: 'Stress/sleep proxy suggests reduced coping reserve.',
      evidenceBasis: 'Collaborative care and early behavioral support improve engagement and chronic-condition control.',
      priority: 'medium',
      rnNextSteps: [
        'Perform RN symptom check and safety screen per protocol.',
        'Offer behavioral health referral and warm handoff when accepted.',
        'Schedule check-in in 7-14 days.'
      ]
    });
  }

  return recs.slice(0, 5);
};

export const getPatientView = (patientId: string): {
  patient: { id: string; name: string };
  current: {
    status: 'GREEN' | 'YELLOW' | 'RED';
    rawStatus: PatientStatus | null;
    cdi: number;
    explanation: string;
    suggestedActions: string[];
    inReview: boolean;
  };
  trajectory: Array<{ week_start: string; cdi: number; status: 'GREEN' | 'YELLOW' | 'RED' }>;
  health: {
    disclaimer: string;
    hero: {
      statusMessage: string;
      slope3Months: number;
      trendDelta: number;
      encouragement: string;
    };
    monthly: Array<{
      month_start: string;
      health_score: number;
      access_score: number;
      avoidable_events: number;
      medication_adherence_proxy: number;
      preventive_care_completion: number;
      stress_sleep_proxy: number;
      out_of_pocket_strain_index: number;
      engagement_score: number;
      risk_score: number;
      stability_score: number;
      monthly_claims_paid: number;
      components: Record<string, unknown>;
    }>;
    rings: {
      access: { value: number; delta: number };
      prevention: { value: number; delta: number };
      stability: { value: number; delta: number };
    };
    events: Array<{
      id: string;
      month_start: string;
      happened_at: string;
      event_key: string;
      title: string;
      detail: string;
      kind: string;
      prevented: boolean;
    }>;
    whatChanged: Array<{ label: string; delta: number; direction: 'up' | 'down' | 'flat' }>;
    preferences: {
      care_model: string;
      funding_model: string;
      primary_care_engagement: string;
      lifestyle_adherence: string;
      care_navigation_support: boolean;
      friction_adjustment: number;
      action_same_day_visit: boolean;
      action_coaching_program: boolean;
      action_medication_reminders: boolean;
      action_preventive_outreach: boolean;
    } | null;
    healthToSpend: {
      estimatedAvoidableCostDelta: number;
      avoidableEventsDelta: number;
      claimsTrendDelta: number;
    };
    careManagerRecommendations: Array<{
      id: string;
      title: string;
      whyNow: string;
      evidenceBasis: string;
      priority: 'high' | 'medium';
      rnNextSteps: string[];
    }>;
  };
} => {
  const patient = db
    .prepare(`SELECT id, first_name, last_name FROM patients WHERE id = ?`)
    .get(patientId) as
    | { id: string; first_name: string; last_name: string; diabetes: number; hypertension: number; behavioral_health: number }
    | undefined;

  if (!patient) {
    throw new Error('Patient not found');
  }

  const rows = db
    .prepare(
      `SELECT week_start, cdi_total, status, top_signals_json
       FROM weekly_scores
       WHERE patient_id = ?
       ORDER BY week_start DESC
       LIMIT 12`
    )
    .all(patientId) as Array<{ week_start: string; cdi_total: number; status: PatientStatus; top_signals_json: string }>;

  const latest = rows[0];

  const explanation = (() => {
    if (!latest) {
      return 'Your stability indicator is building from early utilization and follow-up patterns.';
    }

    const signals = parseSignals(latest.top_signals_json);
    if (signals.length === 0) {
      return 'Your healthcare activity looks steady this week.';
    }

    const top = signals[0];
    const dictionary: Record<string, string> = {
      contact_inflation: 'Your care contacts were higher than your usual pattern recently.',
      contact_suppression: 'Your regular care cadence has been lighter than usual recently.',
      refill_gap: 'Medication timing looks a bit off from your usual routine.',
      missed_appointments: 'A missed appointment changed your recent stability trend.',
      portal_spike: 'You reached out to your care team more often this week.',
      a1c_rise: 'Recent diabetes labs moved higher than your prior trend.',
      bp_trend: 'Blood pressure readings have been trending up recently.',
      uncategorized_utilization: 'Recent visits increased for general symptoms, so your team is checking in earlier.'
    };

    return dictionary[top.signal] || 'A recent change in care patterns moved your stability trend.';
  })();

  const suggestedActions = (() => {
    if (!latest) {
      return ['Keep your regular care cadence and medication schedule.'];
    }

    const status = normalizeForPatient(latest.status);
    if (status === 'RED') {
      return [
        'Expect a fast outreach from your care team.',
        'Request a same-week check-in if symptoms feel worse.'
      ];
    }
    if (status === 'YELLOW') {
      return ['Review medications and refill timing.', 'Schedule a check-in with your clinic this week.'];
    }
    return ['Continue your current routine.', 'Use the check-in button anytime you want support.'];
  })();

  const monthlyRows = db
    .prepare(
      `SELECT
         month_start,
         health_score,
         access_score,
         avoidable_events,
         medication_adherence_proxy,
         preventive_care_completion,
         stress_sleep_proxy,
         out_of_pocket_strain_index,
         engagement_score,
         risk_score,
         stability_score,
         monthly_claims_paid,
         components_json
       FROM patient_monthly_metrics
       WHERE patient_id = ?
       ORDER BY month_start DESC
       LIMIT 8`
    )
    .all(patientId) as Array<{
    month_start: string;
    health_score: number;
    access_score: number;
    avoidable_events: number;
    medication_adherence_proxy: number;
    preventive_care_completion: number;
    stress_sleep_proxy: number;
    out_of_pocket_strain_index: number;
    engagement_score: number;
    risk_score: number;
    stability_score: number;
    monthly_claims_paid: number;
    components_json: string;
  }>;

  const monthly = monthlyRows
    .map((row) => ({
      ...row,
      components: JSON.parse(row.components_json) as Record<string, unknown>
    }))
    .reverse();

  const latestMonth = monthly[monthly.length - 1];
  const priorMonth = monthly[monthly.length - 2];
  const thirdMonth = monthly[monthly.length - 3];

  const slope3Months =
    latestMonth && thirdMonth ? (latestMonth.health_score - thirdMonth.health_score) / 2 : 0;
  const trendDelta = latestMonth && priorMonth ? latestMonth.health_score - priorMonth.health_score : 0;

  const heroStatusMessage =
    slope3Months >= 1.5
      ? 'Your health is trending in the right direction.'
      : slope3Months <= -1.5
        ? 'Your health trend is slipping, small steps can turn it around.'
        : 'Your health is stable, keep building momentum.';

  const enabledActionCount = (() => {
    const pref = getPatientPreferences(patientId);
    if (!pref) return 0;
    return [
      pref.action_same_day_visit,
      pref.action_coaching_program,
      pref.action_medication_reminders,
      pref.action_preventive_outreach,
      pref.care_navigation_support
    ].filter((value) => value === 1).length;
  })();

  const preventionDelta = latestMonth && priorMonth
    ? latestMonth.preventive_care_completion - priorMonth.preventive_care_completion
    : 0;
  const avoidableDelta = latestMonth && priorMonth ? latestMonth.avoidable_events - priorMonth.avoidable_events : 0;

  const encouragement = latestMonth
    ? buildEncouragementMessage(
        patientId,
        latestMonth.month_start,
        slope3Months,
        preventionDelta,
        avoidableDelta,
        enabledActionCount
      )
    : 'Simulation is warming up. Your next few months will show trend momentum.';

  const ringAccessDelta = latestMonth && priorMonth ? latestMonth.access_score - priorMonth.access_score : 0;
  const ringPreventionDelta = latestMonth && priorMonth
    ? latestMonth.preventive_care_completion - priorMonth.preventive_care_completion
    : 0;
  const ringStabilityDelta = latestMonth && priorMonth ? latestMonth.stability_score - priorMonth.stability_score : 0;

  const healthEvents = db
    .prepare(
      `SELECT id, month_start, happened_at, event_key, title, detail, kind, prevented
       FROM patient_monthly_events
       WHERE patient_id = ?
       ORDER BY happened_at DESC
       LIMIT 10`
    )
    .all(patientId) as Array<{
    id: string;
    month_start: string;
    happened_at: string;
    event_key: string;
    title: string;
    detail: string;
    kind: string;
    prevented: number;
  }>;

  const whatChanged: Array<{ label: string; delta: number; direction: 'up' | 'down' | 'flat' }> = latestMonth && priorMonth
    ? [
        {
          label: 'More primary care touchpoints this month',
          delta: Number((latestMonth.access_score - priorMonth.access_score).toFixed(1)),
          direction:
            latestMonth.access_score - priorMonth.access_score > 0.2
              ? 'up'
              : latestMonth.access_score - priorMonth.access_score < -0.2
                ? 'down'
                : 'flat'
        },
        {
          label: 'Lower avoidable event rate',
          delta: Number((priorMonth.avoidable_events - latestMonth.avoidable_events).toFixed(1)),
          direction:
            latestMonth.avoidable_events < priorMonth.avoidable_events
              ? 'up'
              : latestMonth.avoidable_events > priorMonth.avoidable_events
                ? 'down'
                : 'flat'
        },
        {
          label: 'Higher preventive completion',
          delta: Number((latestMonth.preventive_care_completion - priorMonth.preventive_care_completion).toFixed(1)),
          direction:
            latestMonth.preventive_care_completion - priorMonth.preventive_care_completion > 0.2
              ? 'up'
              : latestMonth.preventive_care_completion - priorMonth.preventive_care_completion < -0.2
                ? 'down'
                : 'flat'
        },
        {
          label: 'Lower out of pocket strain',
          delta: Number((priorMonth.out_of_pocket_strain_index - latestMonth.out_of_pocket_strain_index).toFixed(1)),
          direction:
            latestMonth.out_of_pocket_strain_index < priorMonth.out_of_pocket_strain_index
              ? 'up'
              : latestMonth.out_of_pocket_strain_index > priorMonth.out_of_pocket_strain_index
                ? 'down'
                : 'flat'
        }
      ]
    : [];

  const preferences = getPatientPreferences(patientId);

  return {
    patient: {
      id: patient.id,
      name: `${patient.first_name} ${patient.last_name}`
    },
    current: {
      status: latest ? normalizeForPatient(latest.status) : 'GREEN',
      rawStatus: latest?.status ?? null,
      cdi: latest ? Number(latest.cdi_total.toFixed(1)) : 0,
      explanation,
      suggestedActions,
      inReview: latest?.status === 'RED_CANDIDATE'
    },
    trajectory: rows
      .map((row) => ({
        week_start: row.week_start,
        cdi: Number(row.cdi_total.toFixed(1)),
        status: normalizeForPatient(row.status)
      }))
      .reverse(),
    health: {
      disclaimer: 'These are simulated trends for demonstration and planning. Not medical advice.',
      hero: {
        statusMessage: heroStatusMessage,
        slope3Months: Number(slope3Months.toFixed(2)),
        trendDelta: Number(trendDelta.toFixed(1)),
        encouragement
      },
      monthly: monthly.map((row) => ({
        month_start: row.month_start,
        health_score: Number(row.health_score.toFixed(1)),
        access_score: Number(row.access_score.toFixed(1)),
        avoidable_events: row.avoidable_events,
        medication_adherence_proxy: Number(row.medication_adherence_proxy.toFixed(1)),
        preventive_care_completion: Number(row.preventive_care_completion.toFixed(1)),
        stress_sleep_proxy: Number(row.stress_sleep_proxy.toFixed(1)),
        out_of_pocket_strain_index: Number(row.out_of_pocket_strain_index.toFixed(1)),
        engagement_score: Number(row.engagement_score.toFixed(1)),
        risk_score: Number(row.risk_score.toFixed(1)),
        stability_score: Number(row.stability_score.toFixed(1)),
        monthly_claims_paid: Number(row.monthly_claims_paid.toFixed(2)),
        components: row.components
      })),
      rings: {
        access: { value: latestMonth ? latestMonth.access_score : 0, delta: Number(ringAccessDelta.toFixed(1)) },
        prevention: {
          value: latestMonth ? latestMonth.preventive_care_completion : 0,
          delta: Number(ringPreventionDelta.toFixed(1))
        },
        stability: {
          value: latestMonth ? latestMonth.stability_score : 0,
          delta: Number(ringStabilityDelta.toFixed(1))
        }
      },
      events: healthEvents.map((event) => ({
        ...event,
        prevented: event.prevented === 1
      })),
      whatChanged,
      preferences: preferences
        ? {
            care_model: preferences.care_model,
            funding_model: preferences.funding_model,
            primary_care_engagement: preferences.primary_care_engagement,
            lifestyle_adherence: preferences.lifestyle_adherence,
            care_navigation_support: preferences.care_navigation_support === 1,
            friction_adjustment: preferences.friction_adjustment,
            action_same_day_visit: preferences.action_same_day_visit === 1,
            action_coaching_program: preferences.action_coaching_program === 1,
            action_medication_reminders: preferences.action_medication_reminders === 1,
            action_preventive_outreach: preferences.action_preventive_outreach === 1
          }
        : null,
      healthToSpend: {
        estimatedAvoidableCostDelta: latestMonth && priorMonth
          ? Number(((priorMonth.avoidable_events - latestMonth.avoidable_events) * 1100).toFixed(0))
          : 0,
        avoidableEventsDelta: latestMonth && priorMonth ? priorMonth.avoidable_events - latestMonth.avoidable_events : 0,
        claimsTrendDelta: latestMonth && priorMonth
          ? Number((priorMonth.monthly_claims_paid - latestMonth.monthly_claims_paid).toFixed(2))
          : 0
      },
      careManagerRecommendations: buildCareManagerRecommendations({
        patientId: patient.id,
        diabetes: patient.diabetes,
        hypertension: patient.hypertension,
        behavioralHealth: patient.behavioral_health,
        monthly
      })
    }
  };
};

export const getPatientById = (patientId: string): {
  id: string;
  provider_id: string;
} | null => {
  const row = db
    .prepare(`SELECT id, provider_id FROM patients WHERE id = ?`)
    .get(patientId) as { id: string; provider_id: string } | undefined;

  return row ?? null;
};

export const getPatientScoresForExplainability = (
  patientId: string,
  limit = 8
): Array<{
  week_start: string;
  cdi_total: number;
  status: PatientStatus;
  signals: SignalContribution[];
}> => {
  const rows = db
    .prepare(
      `SELECT week_start, cdi_total, status, top_signals_json
       FROM weekly_scores
       WHERE patient_id = ?
       ORDER BY week_start DESC
       LIMIT ?`
    )
    .all(patientId, limit) as Array<{ week_start: string; cdi_total: number; status: PatientStatus; top_signals_json: string }>;

  return rows.map((row) => ({
    week_start: row.week_start,
    cdi_total: Number(row.cdi_total.toFixed(1)),
    status: row.status,
    signals: parseSignals(row.top_signals_json)
  }));
};

export const getEventExportRows = (until: string): Array<{
  id: string;
  patient_id: string;
  provider_id: string | null;
  event_type: string;
  simulated_at: string;
  service_date: string | null;
  icd10_list: string;
  paid_amount: number | null;
  payload_json: string;
}> => {
  const rows = db
    .prepare(
      `SELECT id, patient_id, provider_id, event_type, simulated_at, service_date, icd10_json, paid_amount, payload_json
       FROM events
       WHERE simulated_at <= ?
       ORDER BY simulated_at ASC`
    )
    .all(until) as Array<{
    id: string;
    patient_id: string;
    provider_id: string | null;
    event_type: string;
    simulated_at: string;
    service_date: string | null;
    icd10_json: string;
    paid_amount: number | null;
    payload_json: string;
  }>;

  return rows.map((row) => ({
    ...row,
    icd10_list: row.icd10_json
  }));
};
