import { SignalContribution, DriftThresholds, EventRecord, PatientStatus } from '../types/domain';
import { addDays, inRange } from '../utils/time';

export interface BaselineMetrics {
  weeklyContacts: number;
  weeklyPortalMessages: number;
  weeklyMissedAppointments: number;
  weeklyRefillLate: number;
}

export interface PreviousScoreSnapshot {
  cdiTotal: number;
  status: PatientStatus;
  hasSevereTrigger: boolean;
}

export interface DriftComputationInput {
  weekStart: Date;
  events: EventRecord[];
  baselineEvents: EventRecord[];
  previousScore: PreviousScoreSnapshot | null;
  thresholds: DriftThresholds;
  manualStatus?: 'RED' | 'YELLOW' | null;
}

export interface DriftComputationResult {
  cdiTotal: number;
  utilization: number;
  behavioral: number;
  biometric: number;
  physicianModifier: number;
  status: PatientStatus;
  velocity: number;
  hasSevereTrigger: boolean;
  contributions: SignalContribution[];
}

const round = (value: number): number => Math.round(value * 10) / 10;

const eventCodeCategory = (code: string): string => {
  if (code.startsWith('E11') || code.startsWith('E10')) {
    return 'diabetes';
  }
  if (code.startsWith('I10') || code.startsWith('I11') || code.startsWith('I12') || code.startsWith('I16')) {
    return 'hypertension';
  }
  if (code.startsWith('F')) {
    return 'behavioral';
  }
  if (code.startsWith('R')) {
    return 'symptom';
  }
  return 'other';
};

const parseNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const computeBaseline = (baselineEvents: EventRecord[]): BaselineMetrics => {
  const totalWeeks = 13;
  const contacts = baselineEvents.filter((event) =>
    ['ClaimPosted', 'EncounterNoteSigned', 'ERVisit', 'HospitalAdmission'].includes(event.event_type)
  ).length;
  const portalMessages = baselineEvents.filter(
    (event) =>
      event.event_type === 'PortalMessageSent' && event.payload.direction === 'patient_to_clinic'
  ).length;
  const missedAppointments = baselineEvents.filter((event) => event.event_type === 'MissedAppointment').length;
  const refillLate = baselineEvents
    .filter((event) => event.event_type === 'MedRefillRequest')
    .reduce((sum, event) => {
      const daysLate = parseNumber(event.payload.days_late_from_expected_refill) ?? 0;
      return sum + Math.max(0, daysLate);
    }, 0);

  return {
    weeklyContacts: Math.max(0.3, contacts / totalWeeks),
    weeklyPortalMessages: Math.max(0.1, portalMessages / totalWeeks),
    weeklyMissedAppointments: Math.max(0, missedAppointments / totalWeeks),
    weeklyRefillLate: Math.max(0, refillLate / totalWeeks)
  };
};

const sumCapped = (value: number, cap: number): number => Math.max(0, Math.min(cap, value));

export const computeDriftForWeek = (input: DriftComputationInput): DriftComputationResult => {
  const weekEnd = addDays(input.weekStart, 7);
  const lastFourWeekStart = addDays(input.weekStart, -28);
  const lastTwelveWeekStart = addDays(input.weekStart, -84);

  const baseline = computeBaseline(input.baselineEvents);
  const weekEvents = input.events.filter((event) => {
    const at = new Date(event.simulated_at);
    return inRange(at, input.weekStart, weekEnd);
  });
  const trailingFourWeeks = input.events.filter((event) => {
    const at = new Date(event.simulated_at);
    return inRange(at, lastFourWeekStart, weekEnd);
  });
  const trailingTwelveWeeks = input.events.filter((event) => {
    const at = new Date(event.simulated_at);
    return inRange(at, lastTwelveWeekStart, weekEnd);
  });

  const contributions: SignalContribution[] = [];

  const addContribution = (
    bucket: SignalContribution['bucket'],
    signal: string,
    points: number,
    explanation: string,
    severe = false
  ): void => {
    if (points <= 0) {
      return;
    }
    contributions.push({
      bucket,
      signal,
      points: round(points),
      explanation,
      timestamp: weekEnd.toISOString(),
      severe
    });
  };

  const contactEvents = weekEvents.filter((event) =>
    ['ClaimPosted', 'EncounterNoteSigned', 'ERVisit', 'HospitalAdmission'].includes(event.event_type)
  );
  const contactCount = contactEvents.length;

  if (baseline.weeklyContacts > 0) {
    const inflationRatio = contactCount / baseline.weeklyContacts;
    if (inflationRatio > 1.2) {
      const points = sumCapped((inflationRatio - 1) * 24, 24);
      addContribution(
        'utilization',
        'contact_inflation',
        points,
        `Healthcare contacts rose to ${contactCount} this week from baseline ${baseline.weeklyContacts.toFixed(1)}.`
      );
    }

    if (inflationRatio < 0.45 && baseline.weeklyContacts >= 1.2) {
      const points = sumCapped((0.5 - inflationRatio) * 20, 10);
      addContribution(
        'utilization',
        'contact_suppression',
        points,
        `Healthcare contact cadence dropped below expected baseline this week.`
      );
    }
  }

  const erCount = weekEvents.filter((event) => event.event_type === 'ERVisit').length;
  const admissionCount = weekEvents.filter((event) => event.event_type === 'HospitalAdmission').length;
  if (erCount > 0) {
    addContribution(
      'utilization',
      'er_use',
      sumCapped(erCount * 12, 24),
      `${erCount} emergency visit${erCount > 1 ? 's' : ''} occurred this week.`,
      true
    );
  }
  if (admissionCount > 0) {
    addContribution(
      'utilization',
      'admissions',
      sumCapped(admissionCount * 18, 30),
      `${admissionCount} hospital admission${admissionCount > 1 ? 's' : ''} occurred this week.`,
      true
    );
  }

  if (contactEvents.length >= Math.max(3, baseline.weeklyContacts * 1.4)) {
    const allCodes = contactEvents.flatMap((event) => event.icd10_list);
    if (allCodes.length > 0) {
      const symptomCodes = allCodes.filter((code) => eventCodeCategory(code) === 'symptom').length;
      const categoryCounts = allCodes.reduce<Record<string, number>>((acc, code) => {
        const cat = eventCodeCategory(code);
        acc[cat] = (acc[cat] ?? 0) + 1;
        return acc;
      }, {});
      const dominant = Object.values(categoryCounts).sort((a, b) => b - a)[0] ?? 0;
      const symptomShare = symptomCodes / allCodes.length;
      const dominantShare = dominant / allCodes.length;
      if (symptomShare >= 0.5 && dominantShare < 0.7) {
        addContribution(
          'utilization',
          'uncategorized_utilization',
          8,
          'Visit volume increased with nonspecific symptom coding and no single diagnostic cluster.'
        );
      }
    }
  }

  const refillEvents = weekEvents.filter((event) => event.event_type === 'MedRefillRequest');
  const maxRefillGap = refillEvents.reduce((max, event) => {
    const daysLate = parseNumber(event.payload.days_late_from_expected_refill) ?? 0;
    return Math.max(max, daysLate);
  }, 0);
  if (maxRefillGap >= 5) {
    addContribution(
      'behavioral',
      'refill_gap',
      sumCapped(maxRefillGap * 1.2, 16),
      `Medication refill requests ran up to ${maxRefillGap} days late.`
    );
  }

  const missedAppointments = weekEvents.filter((event) => event.event_type === 'MissedAppointment').length;
  if (missedAppointments > 0) {
    addContribution(
      'behavioral',
      'missed_appointments',
      sumCapped(missedAppointments * 4.2, 12),
      `${missedAppointments} appointment${missedAppointments > 1 ? 's were' : ' was'} missed this week.`
    );
  }

  const portalMessages = weekEvents.filter(
    (event) =>
      event.event_type === 'PortalMessageSent' && event.payload.direction === 'patient_to_clinic'
  ).length;
  const portalRatio = portalMessages / baseline.weeklyPortalMessages;
  if (portalMessages >= 2 && portalRatio >= 1.8) {
    addContribution(
      'behavioral',
      'portal_spike',
      sumCapped(portalRatio * 2.8, 9),
      `Patient-to-clinic messaging rose to ${portalMessages} this week.`
    );
  }

  if (admissionCount > 0 || erCount >= 2) {
    const acutePoints = sumCapped(admissionCount * 14 + Math.max(0, erCount - 1) * 6, 22);
    addContribution(
      'behavioral',
      'acute_disruption',
      acutePoints,
      'Acute care disruption indicates near-term instability and follow-up burden.'
    );
  }

  const a1cLabs = trailingTwelveWeeks
    .filter((event) => event.event_type === 'LabResult' && event.payload.lab_name === 'A1c')
    .map((event) => ({
      date: new Date(event.simulated_at),
      value: parseNumber(event.payload.value)
    }))
    .filter((entry) => entry.value !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime()) as Array<{ date: Date; value: number }>;

  if (a1cLabs.length >= 2) {
    const latest = a1cLabs[a1cLabs.length - 1].value;
    const prior = a1cLabs[a1cLabs.length - 2].value;
    const rise = latest - prior;
    if (rise >= 0.4) {
      addContribution(
        'biometric',
        'a1c_rise',
        sumCapped(rise * 8, 10),
        `A1c increased from ${prior.toFixed(1)} to ${latest.toFixed(1)}.`
      );
    }
  }

  const bpReadings = trailingTwelveWeeks
    .filter(
      (event) =>
        event.event_type === 'VitalReading' &&
        parseNumber(event.payload.bp_systolic) !== null &&
        parseNumber(event.payload.bp_diastolic) !== null
    )
    .map((event) => ({
      systolic: parseNumber(event.payload.bp_systolic) as number,
      diastolic: parseNumber(event.payload.bp_diastolic) as number
    }));

  if (bpReadings.length >= 4) {
    const recent = bpReadings.slice(-2);
    const prior = bpReadings.slice(-4, -2);
    const recentAvg = recent.reduce((sum, entry) => sum + entry.systolic, 0) / recent.length;
    const priorAvg = prior.reduce((sum, entry) => sum + entry.systolic, 0) / prior.length;
    const bpRise = recentAvg - priorAvg;

    if (bpRise >= 8 || recentAvg >= 150) {
      addContribution(
        'biometric',
        'bp_trend',
        sumCapped(bpRise * 0.5 + (recentAvg >= 150 ? 3 : 0), 7),
        `Blood pressure trend rose to average systolic ${recentAvg.toFixed(0)}.`
      );
    }
  }

  const weightReadings = trailingTwelveWeeks
    .filter((event) => event.event_type === 'VitalReading' && parseNumber(event.payload.weight_kg) !== null)
    .map((event) => parseNumber(event.payload.weight_kg) as number);

  if (weightReadings.length >= 4) {
    const recentWeight = weightReadings.slice(-2).reduce((sum, value) => sum + value, 0) / 2;
    const priorWeight = weightReadings.slice(-4, -2).reduce((sum, value) => sum + value, 0) / 2;
    const pctChange = (recentWeight - priorWeight) / Math.max(1, priorWeight);
    if (pctChange >= 0.03) {
      addContribution(
        'biometric',
        'weight_trend',
        sumCapped(pctChange * 120, 4),
        `Weight trend increased by ${(pctChange * 100).toFixed(1)}% over recent weeks.`
      );
    }
  }

  const microalbuminLabs = trailingTwelveWeeks
    .filter((event) => event.event_type === 'LabResult' && event.payload.lab_name === 'microalbumin')
    .map((event) => parseNumber(event.payload.value))
    .filter((value): value is number => value !== null);

  if (microalbuminLabs.length > 0) {
    const latest = microalbuminLabs[microalbuminLabs.length - 1];
    if (latest >= 30) {
      addContribution(
        'biometric',
        'microalbumin_elevated',
        sumCapped((latest - 25) * 0.1, 6),
        `Microalbumin was elevated at ${latest.toFixed(0)} mg/g.`
      );
    }
  }

  const urgentEncounters = weekEvents.filter(
    (event) =>
      event.event_type === 'EncounterNoteSigned' &&
      typeof event.payload.encounter_type === 'string' &&
      event.payload.encounter_type === 'urgent'
  ).length;

  const refillDenied = weekEvents.filter(
    (event) => event.event_type === 'MedRefillRequest' && event.payload.status === 'denied'
  ).length;

  if (urgentEncounters + erCount + admissionCount >= 3) {
    const modifierPoints = admissionCount > 0 ? 10 : 8;
    addContribution(
      'physician',
      'clinical_concern_modifier',
      modifierPoints,
      'Acute contact intensity suggests higher short-term care management load.',
      erCount + admissionCount > 0
    );
  }

  if (refillDenied > 0) {
    addContribution(
      'physician',
      'refill_denial_modifier',
      Math.min(4, refillDenied * 2),
      'Refill denials add clinical follow-up complexity this week.'
    );
  }

  const utilization = round(
    sumCapped(
      contributions
        .filter((contribution) => contribution.bucket === 'utilization')
        .reduce((sum, contribution) => sum + contribution.points, 0),
      40
    )
  );

  const behavioral = round(
    sumCapped(
      contributions
        .filter((contribution) => contribution.bucket === 'behavioral')
        .reduce((sum, contribution) => sum + contribution.points, 0),
      30
    )
  );

  const biometric = round(
    sumCapped(
      contributions
        .filter((contribution) => contribution.bucket === 'biometric')
        .reduce((sum, contribution) => sum + contribution.points, 0),
      20
    )
  );

  const physicianModifier = round(
    sumCapped(
      contributions
        .filter((contribution) => contribution.bucket === 'physician')
        .reduce((sum, contribution) => sum + contribution.points, 0),
      10
    )
  );

  const rawCdi = round(sumCapped(utilization + behavioral + biometric + physicianModifier, 100));

  const previousCdi = input.previousScore?.cdiTotal ?? 0;
  const hasNewTriggers = contributions.length > 0;
  const severeThisWeek = contributions.some((contribution) => contribution.severe);

  let cdiTotal = rawCdi;

  if (!hasNewTriggers) {
    const decay = input.previousScore?.hasSevereTrigger ? 0.95 : 0.9;
    cdiTotal = round(previousCdi * decay);
  } else if (!severeThisWeek && input.previousScore?.hasSevereTrigger) {
    cdiTotal = round(Math.max(rawCdi, previousCdi * 0.95));
  }

  cdiTotal = sumCapped(cdiTotal, 100);

  const velocity = round(cdiTotal - previousCdi);
  let status: PatientStatus = 'GREEN';

  if (input.manualStatus === 'RED') {
    status = 'RED';
  } else if (cdiTotal >= input.thresholds.redCandidate) {
    status = 'RED_CANDIDATE';
  } else if (input.manualStatus === 'YELLOW') {
    status = 'YELLOW';
  } else if (cdiTotal >= input.thresholds.yellow) {
    const priorStatus = input.previousScore?.status;
    const velocityOverride = velocity >= 25 && severeThisWeek;

    if (velocityOverride) {
      status = 'YELLOW';
    } else if (priorStatus === 'YELLOW_OBSERVATION' || priorStatus === 'YELLOW') {
      status = 'YELLOW';
    } else {
      status = 'YELLOW_OBSERVATION';
    }
  }

  if (status === 'RED' && cdiTotal < input.thresholds.yellow) {
    status = 'YELLOW';
  }

  if (status === 'GREEN' && cdiTotal < 1) {
    cdiTotal = 0;
  }

  const topContributions = contributions.sort((a, b) => b.points - a.points).slice(0, 8);

  return {
    cdiTotal,
    utilization,
    behavioral,
    biometric,
    physicianModifier,
    status,
    velocity,
    hasSevereTrigger: severeThisWeek || Boolean(input.previousScore?.hasSevereTrigger && cdiTotal > 0),
    contributions: topContributions
  };
};
