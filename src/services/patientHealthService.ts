import { randomUUID } from 'crypto';
import { db } from '../db';

type Level = 'low' | 'medium' | 'high';
type CareModel = 'traditional' | 'dpc';
type FundingModel = 'fully_funded' | 'self_funded';

interface PatientRow {
  id: string;
  diabetes: number;
  hypertension: number;
  behavioral_health: number;
  archetype: string;
}

interface PreferenceRow {
  patient_id: string;
  care_model: CareModel;
  funding_model: FundingModel;
  primary_care_engagement: Level;
  lifestyle_adherence: Level;
  care_navigation_support: number;
  friction_adjustment: number;
  action_same_day_visit: number;
  action_coaching_program: number;
  action_medication_reminders: number;
  action_preventive_outreach: number;
  updated_at: string;
}

interface EventRow {
  id: string;
  patient_id: string;
  event_type: string;
  simulated_at: string;
  paid_amount: number | null;
  payload_json: string;
}

interface MetricRow {
  patient_id: string;
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
}

interface PatientEventFeedItem {
  id: string;
  happened_at: string;
  event_key: string;
  title: string;
  detail: string;
  kind: 'positive' | 'neutral' | 'attention';
  prevented: number;
  source_event_id: string | null;
  payload_json: string;
}

export interface PatientPreferenceUpdateInput {
  care_model?: CareModel;
  funding_model?: FundingModel;
  primary_care_engagement?: Level;
  lifestyle_adherence?: Level;
  care_navigation_support?: boolean;
  friction_adjustment?: number;
  action_same_day_visit?: boolean;
  action_coaching_program?: boolean;
  action_medication_reminders?: boolean;
  action_preventive_outreach?: boolean;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const monthStartUtc = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

const addUtcMonths = (date: Date, months: number): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));

const toBool = (value: number): boolean => value === 1;

const levelScore = (level: Level): number => {
  if (level === 'low') return -1;
  if (level === 'high') return 1;
  return 0;
};

const hashInt = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const deterministicNoise = (
  seed: number,
  patientId: string,
  monthStartIso: string,
  tag: string,
  min: number,
  max: number
): number => {
  const h = hashInt(`${seed}:${patientId}:${monthStartIso}:${tag}`);
  const ratio = h / 0xffffffff;
  return min + ratio * (max - min);
};

const ensurePreferencesForPopulation = (nowIso: string): void => {
  db.prepare(
    `INSERT INTO patient_sim_preferences (
      patient_id,
      care_model,
      funding_model,
      primary_care_engagement,
      lifestyle_adherence,
      care_navigation_support,
      friction_adjustment,
      action_same_day_visit,
      action_coaching_program,
      action_medication_reminders,
      action_preventive_outreach,
      updated_at
    )
    SELECT
      p.id,
      'traditional',
      'fully_funded',
      CASE
        WHEN p.archetype IN ('suppression', 'severe_spike') THEN 'low'
        WHEN p.archetype = 'stable' THEN 'high'
        ELSE 'medium'
      END,
      CASE
        WHEN p.archetype IN ('suppression', 'biometric_decline') THEN 'low'
        ELSE 'medium'
      END,
      CASE WHEN p.archetype = 'stable' THEN 1 ELSE 0 END,
      0,
      0,
      0,
      1,
      1,
      ?
    FROM patients p
    WHERE NOT EXISTS (
      SELECT 1
      FROM patient_sim_preferences pref
      WHERE pref.patient_id = p.id
    )`
  ).run(nowIso);
};

const insertOrUpdatePatientSimState = (lastProcessedMonth: string): void => {
  db.prepare(
    `INSERT INTO patient_sim_state (id, last_processed_month)
     VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_processed_month = excluded.last_processed_month`
  ).run(lastProcessedMonth);
};

const getPatientSimState = (): { last_processed_month: string } | null => {
  const row = db
    .prepare(`SELECT last_processed_month FROM patient_sim_state WHERE id = 1`)
    .get() as { last_processed_month: string } | undefined;
  return row ?? null;
};

const getSeedAndStart = (): { seed: number; start_time: string } => {
  return db
    .prepare(`SELECT seed, start_time FROM simulation_state WHERE id = 1`)
    .get() as { seed: number; start_time: string };
};

const getPatients = (): PatientRow[] => {
  return db
    .prepare(`SELECT id, diabetes, hypertension, behavioral_health, archetype FROM patients ORDER BY id`)
    .all() as PatientRow[];
};

const getPreferenceMap = (): Map<string, PreferenceRow> => {
  const rows = db
    .prepare(
      `SELECT
         patient_id,
         care_model,
         funding_model,
         primary_care_engagement,
         lifestyle_adherence,
         care_navigation_support,
         friction_adjustment,
         action_same_day_visit,
         action_coaching_program,
         action_medication_reminders,
         action_preventive_outreach,
         updated_at
       FROM patient_sim_preferences`
    )
    .all() as PreferenceRow[];

  const map = new Map<string, PreferenceRow>();
  for (const row of rows) {
    map.set(row.patient_id, row);
  }
  return map;
};

const getEventsForMonth = (startIso: string, endIso: string): Map<string, EventRow[]> => {
  const rows = db
    .prepare(
      `SELECT id, patient_id, event_type, simulated_at, paid_amount, payload_json
       FROM events
       WHERE simulated_at >= ?
         AND simulated_at < ?
       ORDER BY simulated_at ASC`
    )
    .all(startIso, endIso) as EventRow[];

  const grouped = new Map<string, EventRow[]>();
  for (const row of rows) {
    if (!grouped.has(row.patient_id)) {
      grouped.set(row.patient_id, []);
    }
    grouped.get(row.patient_id)?.push(row);
  }
  return grouped;
};

const getPreviousMetricMap = (previousMonthIso: string): Map<string, MetricRow> => {
  const rows = db
    .prepare(
      `SELECT
         patient_id,
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
         monthly_claims_paid
       FROM patient_monthly_metrics
       WHERE month_start = ?`
    )
    .all(previousMonthIso) as MetricRow[];

  const map = new Map<string, MetricRow>();
  for (const row of rows) {
    map.set(row.patient_id, row);
  }
  return map;
};

const upsertMonthlyMetric = db.prepare(
  `INSERT INTO patient_monthly_metrics (
    id,
    patient_id,
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
    components_json,
    created_at
  ) VALUES (
    @id,
    @patient_id,
    @month_start,
    @health_score,
    @access_score,
    @avoidable_events,
    @medication_adherence_proxy,
    @preventive_care_completion,
    @stress_sleep_proxy,
    @out_of_pocket_strain_index,
    @engagement_score,
    @risk_score,
    @stability_score,
    @monthly_claims_paid,
    @components_json,
    @created_at
  )
  ON CONFLICT(patient_id, month_start)
  DO UPDATE SET
    health_score = excluded.health_score,
    access_score = excluded.access_score,
    avoidable_events = excluded.avoidable_events,
    medication_adherence_proxy = excluded.medication_adherence_proxy,
    preventive_care_completion = excluded.preventive_care_completion,
    stress_sleep_proxy = excluded.stress_sleep_proxy,
    out_of_pocket_strain_index = excluded.out_of_pocket_strain_index,
    engagement_score = excluded.engagement_score,
    risk_score = excluded.risk_score,
    stability_score = excluded.stability_score,
    monthly_claims_paid = excluded.monthly_claims_paid,
    components_json = excluded.components_json,
    created_at = excluded.created_at`
);

const deleteMonthlyEvents = db.prepare(
  `DELETE FROM patient_monthly_events WHERE patient_id = ? AND month_start = ?`
);

const insertMonthlyEvent = db.prepare(
  `INSERT INTO patient_monthly_events (
    id,
    patient_id,
    month_start,
    happened_at,
    event_key,
    title,
    detail,
    kind,
    prevented,
    source_event_id,
    payload_json,
    created_at
  ) VALUES (
    @id,
    @patient_id,
    @month_start,
    @happened_at,
    @event_key,
    @title,
    @detail,
    @kind,
    @prevented,
    @source_event_id,
    @payload_json,
    @created_at
  )`
);

const makeFeed = (
  patientId: string,
  monthStartIso: string,
  monthEndIso: string,
  monthEvents: EventRow[],
  metrics: {
    primaryTouchpoints: number;
    preventiveTouchpoints: number;
    refillCount: number;
    rawAvoidableEvents: number;
    avoidableEvents: number;
    navigationActive: boolean;
    sameDayEnabled: boolean;
    monthlyClaimsPaid: number;
    catastrophicCount: number;
  }
): PatientEventFeedItem[] => {
  const items: PatientEventFeedItem[] = [];
  const findFirst = (eventType: string): EventRow | undefined =>
    monthEvents.find((row) => row.event_type === eventType);

  if (metrics.primaryTouchpoints > 0) {
    const source = findFirst('EncounterNoteSigned');
    items.push({
      id: randomUUID(),
      happened_at: source?.simulated_at ?? monthStartIso,
      event_key: 'primary-care-touchpoint',
      title: 'Primary care visit completed',
      detail: 'Regular check-ins are helping your health momentum stay steady.',
      kind: 'positive',
      prevented: 0,
      source_event_id: source?.id ?? null,
      payload_json: JSON.stringify({ source: source?.event_type || 'modeled' })
    });
  }

  if (metrics.preventiveTouchpoints > 0) {
    const source = findFirst('LabResult');
    items.push({
      id: randomUUID(),
      happened_at: source?.simulated_at ?? monthEndIso,
      event_key: 'preventive-completion',
      title: 'Preventive screening completed',
      detail: 'Consistent preventive care is building long-term stability.',
      kind: 'positive',
      prevented: 0,
      source_event_id: source?.id ?? null,
      payload_json: JSON.stringify({ source: source?.event_type || 'modeled' })
    });
  }

  if (metrics.sameDayEnabled && metrics.avoidableEvents < metrics.rawAvoidableEvents) {
    items.push({
      id: randomUUID(),
      happened_at: monthEndIso,
      event_key: 'same-day-avoidance',
      title: 'Avoided ER visit with same-day access',
      detail: 'Faster access likely prevented a higher-intensity visit this month.',
      kind: 'positive',
      prevented: 1,
      source_event_id: null,
      payload_json: JSON.stringify({ preventedEvents: metrics.rawAvoidableEvents - metrics.avoidableEvents })
    });
  }

  if (metrics.refillCount > 0) {
    const source = findFirst('MedRefillRequest');
    items.push({
      id: randomUUID(),
      happened_at: source?.simulated_at ?? monthEndIso,
      event_key: 'med-refill',
      title: 'Medication refill on time',
      detail: 'Medication consistency is supporting healthier trend movement.',
      kind: 'positive',
      prevented: 0,
      source_event_id: source?.id ?? null,
      payload_json: JSON.stringify({ source: source?.event_type || 'modeled' })
    });
  }

  if (metrics.navigationActive && metrics.monthlyClaimsPaid > 0) {
    items.push({
      id: randomUUID(),
      happened_at: monthEndIso,
      event_key: 'navigation-support',
      title: 'Care navigation redirected imaging',
      detail: 'Support tools helped reduce unnecessary duplication this month.',
      kind: 'positive',
      prevented: 1,
      source_event_id: null,
      payload_json: JSON.stringify({ navigation: true })
    });
  }

  if (metrics.avoidableEvents > 1) {
    const source = findFirst('ERVisit') ?? findFirst('HospitalAdmission');
    items.push({
      id: randomUUID(),
      happened_at: source?.simulated_at ?? monthEndIso,
      event_key: 'avoidable-bump',
      title: 'Higher avoidable events this month',
      detail: 'Small habit and access adjustments can quickly improve next month.',
      kind: 'attention',
      prevented: 0,
      source_event_id: source?.id ?? null,
      payload_json: JSON.stringify({ avoidableEvents: metrics.avoidableEvents })
    });
  }

  if (metrics.catastrophicCount > 0) {
    items.push({
      id: randomUUID(),
      happened_at: monthEndIso,
      event_key: 'unexpected-health-event',
      title: 'Unexpected health event',
      detail: 'An unexpected health event occurred. Support steps can help restore momentum.',
      kind: 'attention',
      prevented: 0,
      source_event_id: null,
      payload_json: JSON.stringify({ catastrophicCount: metrics.catastrophicCount })
    });
  }

  return items
    .sort((a, b) => (a.happened_at < b.happened_at ? 1 : -1))
    .slice(0, 6);
};

const computeMonthlyMetrics = (
  seed: number,
  patient: PatientRow,
  pref: PreferenceRow,
  monthStartIso: string,
  monthEndIso: string,
  monthEvents: EventRow[],
  previous: MetricRow | undefined
): { row: Omit<MetricRow, 'patient_id'> & { components_json: string }; feed: PatientEventFeedItem[] } => {
  const levelPrimary = levelScore(pref.primary_care_engagement);
  const levelLifestyle = levelScore(pref.lifestyle_adherence);
  const careNavigation = toBool(pref.care_navigation_support);
  const sameDay = toBool(pref.action_same_day_visit);
  const coaching = toBool(pref.action_coaching_program);
  const reminders = toBool(pref.action_medication_reminders);
  const outreach = toBool(pref.action_preventive_outreach);
  const isDpc = pref.care_model === 'dpc';
  const isSelfFunded = pref.funding_model === 'self_funded';

  const claims = monthEvents.filter((row) => row.event_type === 'ClaimPosted');
  const monthlyClaimsPaid = claims.reduce((sum, row) => sum + (row.paid_amount ?? 0), 0);

  const primaryTouchpoints = monthEvents.filter((row) => row.event_type === 'EncounterNoteSigned').length;
  const preventiveTouchpoints = monthEvents.filter((row) => {
    if (row.event_type === 'LabResult') {
      const payload = JSON.parse(row.payload_json) as { panel?: string };
      return payload.panel === 'a1c' || payload.panel === 'microalbumin';
    }
    if (row.event_type === 'EncounterNoteSigned') {
      const payload = JSON.parse(row.payload_json) as { appointment_type?: string };
      return payload.appointment_type === 'annual_visit';
    }
    return false;
  }).length;

  const refillCount = monthEvents.filter((row) => row.event_type === 'MedRefillRequest').length;
  const portalCount = monthEvents.filter((row) => row.event_type === 'PortalMessageSent').length;
  const missedCount = monthEvents.filter((row) => row.event_type === 'MissedAppointment').length;
  const erCount = monthEvents.filter((row) => row.event_type === 'ERVisit').length;
  const admissionCount = monthEvents.filter((row) => row.event_type === 'HospitalAdmission').length;
  const urgentClaimCount = claims.filter((row) => {
    const payload = JSON.parse(row.payload_json) as { claim_type?: string };
    return payload.claim_type === 'urgent' || payload.claim_type === 'inpatient';
  }).length;
  const catastrophicCount = claims.filter((row) => {
    const payload = JSON.parse(row.payload_json) as { claim_type?: string };
    return payload.claim_type === 'catastrophic';
  }).length;

  const redundantImaging = Math.max(0, Math.floor(claims.length / 7) - 1);
  const rawAvoidableEvents = erCount + admissionCount + urgentClaimCount + redundantImaging;

  let friction = 44 + pref.friction_adjustment;
  if (isDpc) friction -= 14;
  if (isSelfFunded) friction += 6;
  if (careNavigation) friction -= 5;
  if (sameDay) friction -= 2;
  friction = clamp(friction, 0, 100);

  const engagementNoise = deterministicNoise(seed, patient.id, monthStartIso, 'engagement', -3.5, 3.5);
  const accessNoise = deterministicNoise(seed, patient.id, monthStartIso, 'access', -3.2, 3.2);
  const adherenceNoise = deterministicNoise(seed, patient.id, monthStartIso, 'adherence', -2.8, 2.8);
  const preventiveNoise = deterministicNoise(seed, patient.id, monthStartIso, 'prevention', -3.4, 3.4);
  const strainNoise = deterministicNoise(seed, patient.id, monthStartIso, 'strain', -2.6, 2.6);
  const stressNoise = deterministicNoise(seed, patient.id, monthStartIso, 'stress', -3.5, 3.5);
  const healthNoise = deterministicNoise(seed, patient.id, monthStartIso, 'health', -2.5, 2.5);

  let engagementScore =
    52 +
    levelPrimary * 14 +
    levelLifestyle * 10 +
    (careNavigation ? 8 : 0) +
    (coaching ? 8 : 0) +
    (reminders ? 5 : 0) +
    (outreach ? 4 : 0) +
    (isDpc ? 8 : 0) +
    portalCount * 1.5 -
    missedCount * 4 -
    friction * 0.2 +
    engagementNoise;
  engagementScore = clamp(engagementScore, 0, 100);

  let accessScore =
    48 +
    primaryTouchpoints * 7 +
    (isDpc ? 16 : 0) +
    (careNavigation ? 5 : 0) +
    (sameDay ? 10 : 0) +
    levelPrimary * 8 -
    friction * 0.35 -
    missedCount * 3 +
    accessNoise;
  accessScore = clamp(accessScore, 0, 100);

  let outOfPocketStrainIndex =
    25 +
    friction * 0.45 +
    Math.min(35, monthlyClaimsPaid / 700) +
    (isSelfFunded ? 6 : -3) +
    strainNoise -
    (isDpc ? 4 : 0);
  outOfPocketStrainIndex = clamp(outOfPocketStrainIndex, 0, 100);

  let medicationAdherenceProxy =
    58 +
    refillCount * 9 +
    (reminders ? 9 : 0) +
    (coaching ? 7 : 0) +
    levelLifestyle * 8 +
    engagementScore * 0.12 -
    outOfPocketStrainIndex * 0.38 -
    missedCount * 2 +
    adherenceNoise;
  medicationAdherenceProxy = clamp(medicationAdherenceProxy, 0, 100);

  let preventiveCareCompletion =
    36 +
    preventiveTouchpoints * 15 +
    (outreach ? 14 : 0) +
    accessScore * 0.22 +
    engagementScore * 0.12 -
    outOfPocketStrainIndex * 0.25 +
    preventiveNoise;
  preventiveCareCompletion = clamp(preventiveCareCompletion, 0, 100);

  let avoidableFactor =
    1 -
    (accessScore - 50) / 240 -
    (engagementScore - 50) / 300 +
    Math.max(0, outOfPocketStrainIndex - 55) / 170;
  if (isDpc) avoidableFactor -= 0.16;
  if (careNavigation) avoidableFactor -= 0.12;
  if (sameDay) avoidableFactor -= 0.09;
  avoidableFactor = clamp(avoidableFactor, 0.35, 1.65);

  const avoidableEvents = Math.max(0, Math.round(rawAvoidableEvents * avoidableFactor));

  let stressSleepProxy =
    54 +
    levelLifestyle * 11 +
    (coaching ? 8 : 0) +
    engagementScore * 0.16 -
    avoidableEvents * 5 -
    missedCount * 4 -
    outOfPocketStrainIndex * 0.12 +
    stressNoise;
  stressSleepProxy = clamp(stressSleepProxy, 0, 100);

  let chronicControlProxy =
    46 +
    medicationAdherenceProxy * 0.28 +
    preventiveCareCompletion * 0.26 +
    accessScore * 0.16 -
    avoidableEvents * 5 -
    outOfPocketStrainIndex * 0.1 +
    (patient.diabetes ? -2 : 0) +
    (patient.hypertension ? -1 : 0) +
    (patient.behavioral_health ? -1 : 0);
  chronicControlProxy = clamp(chronicControlProxy, 0, 100);

  let healthScore =
    accessScore * 0.28 +
    chronicControlProxy * 0.32 +
    clamp(100 - avoidableEvents * 14, 0, 100) * 0.18 +
    medicationAdherenceProxy * 0.12 +
    preventiveCareCompletion * 0.08 +
    healthNoise;
  healthScore = clamp(healthScore, 0, 100);

  if (outOfPocketStrainIndex > 70) {
    const excess = outOfPocketStrainIndex - 70;
    medicationAdherenceProxy = clamp(medicationAdherenceProxy - excess * 0.45, 0, 100);
    preventiveCareCompletion = clamp(preventiveCareCompletion - excess * 0.36, 0, 100);
    healthScore = clamp(healthScore - excess * 0.34, 0, 100);
  }

  if (previous) {
    if (healthScore > previous.health_score + 8) {
      healthScore = previous.health_score + 8;
    }
    if (healthScore < previous.health_score - 10) {
      healthScore = previous.health_score - 10;
    }

    if (previous.health_score > 74 && healthScore > previous.health_score) {
      healthScore -= deterministicNoise(seed, patient.id, monthStartIso, 'plateau', 0.4, 2.1);
    }
  }

  healthScore = clamp(healthScore, 0, 100);

  const riskScore = clamp(
    100 -
      (chronicControlProxy * 0.35 +
        accessScore * 0.2 +
        medicationAdherenceProxy * 0.15 +
        preventiveCareCompletion * 0.15 +
        stressSleepProxy * 0.15) +
      avoidableEvents * 3 +
      outOfPocketStrainIndex * 0.2,
    0,
    100
  );

  const stabilityScore = clamp(healthScore - riskScore * 0.22 + 18, 0, 100);

  const components = {
    month_start: monthStartIso,
    month_end: monthEndIso,
    chronic_control_proxy: Number(chronicControlProxy.toFixed(1)),
    raw_avoidable_events: rawAvoidableEvents,
    primary_touchpoints: primaryTouchpoints,
    preventive_touchpoints: preventiveTouchpoints,
    refill_count: refillCount,
    missed_appointments: missedCount,
    portal_messages: portalCount,
    friction_level: Number(friction.toFixed(1)),
    care_model: pref.care_model,
    funding_model: pref.funding_model,
    levers: {
      primary_care_engagement: pref.primary_care_engagement,
      lifestyle_adherence: pref.lifestyle_adherence,
      care_navigation_support: careNavigation,
      action_same_day_visit: sameDay,
      action_coaching_program: coaching,
      action_medication_reminders: reminders,
      action_preventive_outreach: outreach
    }
  };

  return {
    row: {
      health_score: Number(healthScore.toFixed(1)),
      access_score: Number(accessScore.toFixed(1)),
      avoidable_events: avoidableEvents,
      medication_adherence_proxy: Number(medicationAdherenceProxy.toFixed(1)),
      preventive_care_completion: Number(preventiveCareCompletion.toFixed(1)),
      stress_sleep_proxy: Number(stressSleepProxy.toFixed(1)),
      out_of_pocket_strain_index: Number(outOfPocketStrainIndex.toFixed(1)),
      engagement_score: Number(engagementScore.toFixed(1)),
      risk_score: Number(riskScore.toFixed(1)),
      stability_score: Number(stabilityScore.toFixed(1)),
      monthly_claims_paid: Number(monthlyClaimsPaid.toFixed(2)),
      components_json: JSON.stringify(components)
    },
    feed: makeFeed(patient.id, monthStartIso, monthEndIso, monthEvents, {
      primaryTouchpoints,
      preventiveTouchpoints,
      refillCount,
      rawAvoidableEvents,
      avoidableEvents,
      navigationActive: careNavigation,
      sameDayEnabled: sameDay,
      monthlyClaimsPaid,
      catastrophicCount
    })
  };
};

const runMonth = (seed: number, monthStart: Date, monthEnd: Date, nowIso: string): void => {
  const monthStartIso = monthStart.toISOString();
  const monthEndIso = monthEnd.toISOString();
  const previousMonthIso = addUtcMonths(monthStart, -1).toISOString();

  const patients = getPatients();
  const prefs = getPreferenceMap();
  const eventsByPatient = getEventsForMonth(monthStartIso, monthEndIso);
  const previousByPatient = getPreviousMetricMap(previousMonthIso);

  for (const patient of patients) {
    const pref = prefs.get(patient.id);
    if (!pref) {
      continue;
    }

    const monthEvents = eventsByPatient.get(patient.id) ?? [];
    const previous = previousByPatient.get(patient.id);
    const computed = computeMonthlyMetrics(seed, patient, pref, monthStartIso, monthEndIso, monthEvents, previous);

    upsertMonthlyMetric.run({
      id: randomUUID(),
      patient_id: patient.id,
      month_start: monthStartIso,
      ...computed.row,
      created_at: nowIso
    });

    deleteMonthlyEvents.run(patient.id, monthStartIso);
    for (const event of computed.feed) {
      insertMonthlyEvent.run({
        ...event,
        patient_id: patient.id,
        month_start: monthStartIso,
        created_at: nowIso
      });
    }
  }
};

export const recalculatePatientHealthThrough = (currentTime: Date): void => {
  const nowIso = new Date().toISOString();
  ensurePreferencesForPopulation(nowIso);

  const state = getSeedAndStart();
  const seed = state.seed;
  const simStartMonth = monthStartUtc(new Date(state.start_time));
  const currentMonth = monthStartUtc(currentTime);
  const previousMonth = addUtcMonths(currentMonth, -1);

  const simState = getPatientSimState();
  if (!simState) {
    insertOrUpdatePatientSimState(addUtcMonths(simStartMonth, -1).toISOString());
  }

  const latestState = getPatientSimState();
  if (!latestState) {
    return;
  }

  let cursor = monthStartUtc(new Date(latestState.last_processed_month));
  const tx = db.transaction(() => {
    while (cursor < previousMonth) {
      const target = addUtcMonths(cursor, 1);
      const targetEnd = addUtcMonths(target, 1);
      runMonth(seed, target, targetEnd, nowIso);
      insertOrUpdatePatientSimState(target.toISOString());
      cursor = target;
    }

    const currentMonthEnd = currentTime > currentMonth ? currentTime : addUtcMonths(currentMonth, 1);
    runMonth(seed, currentMonth, currentMonthEnd, nowIso);
  });

  tx();
};

export const getPatientPreferences = (patientId: string): PreferenceRow | null => {
  const row = db
    .prepare(
      `SELECT
         patient_id,
         care_model,
         funding_model,
         primary_care_engagement,
         lifestyle_adherence,
         care_navigation_support,
         friction_adjustment,
         action_same_day_visit,
         action_coaching_program,
         action_medication_reminders,
         action_preventive_outreach,
         updated_at
       FROM patient_sim_preferences
       WHERE patient_id = ?`
    )
    .get(patientId) as PreferenceRow | undefined;

  return row ?? null;
};

export const updatePatientPreferences = (
  patientId: string,
  input: PatientPreferenceUpdateInput,
  now: Date
): PreferenceRow => {
  const existing = getPatientPreferences(patientId);
  if (!existing) {
    throw new Error('Patient preferences not found.');
  }

  if (input.care_model && input.care_model !== 'traditional' && input.care_model !== 'dpc') {
    throw new Error('care_model must be traditional or dpc.');
  }
  if (input.funding_model && input.funding_model !== 'fully_funded' && input.funding_model !== 'self_funded') {
    throw new Error('funding_model must be fully_funded or self_funded.');
  }
  if (
    input.primary_care_engagement &&
    input.primary_care_engagement !== 'low' &&
    input.primary_care_engagement !== 'medium' &&
    input.primary_care_engagement !== 'high'
  ) {
    throw new Error('primary_care_engagement must be low, medium, or high.');
  }
  if (
    input.lifestyle_adherence &&
    input.lifestyle_adherence !== 'low' &&
    input.lifestyle_adherence !== 'medium' &&
    input.lifestyle_adherence !== 'high'
  ) {
    throw new Error('lifestyle_adherence must be low, medium, or high.');
  }

  const frictionAdjustment =
    input.friction_adjustment === undefined
      ? existing.friction_adjustment
      : clamp(Math.round(input.friction_adjustment), -35, 35);

  db.prepare(
    `UPDATE patient_sim_preferences
     SET
       care_model = ?,
       funding_model = ?,
       primary_care_engagement = ?,
       lifestyle_adherence = ?,
       care_navigation_support = ?,
       friction_adjustment = ?,
       action_same_day_visit = ?,
       action_coaching_program = ?,
       action_medication_reminders = ?,
       action_preventive_outreach = ?,
       updated_at = ?
     WHERE patient_id = ?`
  ).run(
    input.care_model ?? existing.care_model,
    input.funding_model ?? existing.funding_model,
    input.primary_care_engagement ?? existing.primary_care_engagement,
    input.lifestyle_adherence ?? existing.lifestyle_adherence,
    input.care_navigation_support === undefined
      ? existing.care_navigation_support
      : input.care_navigation_support
        ? 1
        : 0,
    frictionAdjustment,
    input.action_same_day_visit === undefined ? existing.action_same_day_visit : input.action_same_day_visit ? 1 : 0,
    input.action_coaching_program === undefined
      ? existing.action_coaching_program
      : input.action_coaching_program
        ? 1
        : 0,
    input.action_medication_reminders === undefined
      ? existing.action_medication_reminders
      : input.action_medication_reminders
        ? 1
        : 0,
    input.action_preventive_outreach === undefined
      ? existing.action_preventive_outreach
      : input.action_preventive_outreach
        ? 1
        : 0,
    now.toISOString(),
    patientId
  );

  const updated = getPatientPreferences(patientId);
  if (!updated) {
    throw new Error('Patient preferences not found after update.');
  }

  return updated;
};
