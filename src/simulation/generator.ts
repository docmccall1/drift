import { addDays, addHours, addMinutes, atUtcMidnight, toIsoDate } from '../utils/time';
import { SeededRandom } from './rng';
import { icd10Library } from './icd10';
import { EventRecord, Patient, Provider } from '../types/domain';

interface GeneratorOptions {
  seed: number;
  timelineStartDate: string;
  months: number;
  population: number;
  riskIntensity?: 'low' | 'typical' | 'high';
}

interface GeneratedDataset {
  providers: Provider[];
  patients: Patient[];
  events: EventRecord[];
  timelineStart: Date;
  timelineEnd: Date;
  baselineStart: Date;
}

type Archetype =
  | 'stable'
  | 'mild_drift'
  | 'severe_spike'
  | 'suppression'
  | 'biometric_decline';

interface PatientProfile {
  archetype: Archetype;
  driftStartDay: number;
  driftEndDay: number;
  severeWindowEndDay: number;
}

const FIRST_NAMES = [
  'Alex',
  'Jordan',
  'Casey',
  'Taylor',
  'Morgan',
  'Riley',
  'Avery',
  'Quinn',
  'Parker',
  'Jamie',
  'Skyler',
  'Dakota',
  'Emerson',
  'Reese',
  'Cameron',
  'Harper',
  'Elliot',
  'Rowan'
];

const LAST_NAMES = [
  'Brooks',
  'Patel',
  'Johnson',
  'Nguyen',
  'Lopez',
  'Kim',
  'Adams',
  'Foster',
  'Murphy',
  'Morris',
  'Shah',
  'Turner',
  'Rivera',
  'Perry',
  'Howard',
  'Russell',
  'Diaz',
  'Campbell'
];

const PROVIDER_NAMES = [
  'Dr. Li',
  'Dr. Patel',
  'Dr. Rivera',
  'Dr. Owens',
  'Dr. Shah',
  'Dr. Turner',
  'Dr. Nguyen',
  'Dr. Baxter',
  'Dr. Chen',
  'Dr. Adams'
];

const MESSAGE_TOPICS = [
  'medication question',
  'new symptom',
  'follow-up timing',
  'lab clarification',
  'care plan support'
] as const;

const MED_CLASSES = ['statin', 'insulin', 'metformin', 'ace_inhibitor', 'beta_blocker'] as const;

const APPOINTMENT_TYPES = ['office_followup', 'annual_visit', 'telehealth', 'lab_visit'] as const;

const chooseArchetype = (rng: SeededRandom): Archetype => {
  const r = rng.next();
  if (r < 0.52) {
    return 'stable';
  }
  if (r < 0.74) {
    return 'mild_drift';
  }
  if (r < 0.92) {
    return 'severe_spike';
  }
  if (r < 0.97) {
    return 'suppression';
  }
  return 'biometric_decline';
};

const chooseIcd10 = (
  rng: SeededRandom,
  diabetes: boolean,
  hypertension: boolean,
  behavioral: boolean,
  uncategorizedBias = false
): string[] => {
  const icd: string[] = [];
  if (uncategorizedBias) {
    icd.push(rng.pick(icd10Library.symptoms));
    if (rng.maybe(0.35)) {
      icd.push(rng.pick(icd10Library.routine));
    }
    return icd;
  }
  if (diabetes && rng.maybe(0.75)) {
    icd.push(rng.pick(icd10Library.diabetes));
  }
  if (hypertension && rng.maybe(0.7)) {
    icd.push(rng.pick(icd10Library.hypertension));
  }
  if (behavioral && rng.maybe(0.5)) {
    icd.push(rng.pick(icd10Library.behavioral));
  }
  if (icd.length === 0 || rng.maybe(0.25)) {
    icd.push(rng.pick(icd10Library.symptoms));
  }
  return icd.slice(0, 3);
};

const createDob = (rng: SeededRandom): string => {
  const year = rng.int(1960, 2003);
  const month = rng.int(1, 12);
  const day = rng.int(1, 28);
  return `${year}-${`${month}`.padStart(2, '0')}-${`${day}`.padStart(2, '0')}`;
};

const dayWithTime = (rng: SeededRandom, dayDate: Date): Date => {
  return addMinutes(addHours(dayDate, rng.int(7, 19)), rng.int(0, 59));
};

const makeProfile = (rng: SeededRandom, archetype: Archetype): PatientProfile => {
  if (archetype === 'stable') {
    return {
      archetype,
      driftStartDay: 999,
      driftEndDay: 999,
      severeWindowEndDay: 999
    };
  }

  const driftStartDay = rng.int(8, 45);

  if (archetype === 'mild_drift') {
    return {
      archetype,
      driftStartDay,
      driftEndDay: driftStartDay + rng.int(21, 45),
      severeWindowEndDay: driftStartDay + 20
    };
  }

  if (archetype === 'severe_spike') {
    return {
      archetype,
      driftStartDay,
      driftEndDay: driftStartDay + rng.int(14, 30),
      severeWindowEndDay: driftStartDay + rng.int(8, 16)
    };
  }

  if (archetype === 'suppression') {
    return {
      archetype,
      driftStartDay,
      driftEndDay: driftStartDay + rng.int(35, 70),
      severeWindowEndDay: driftStartDay + 10
    };
  }

  return {
    archetype,
    driftStartDay,
    driftEndDay: driftStartDay + rng.int(35, 70),
    severeWindowEndDay: driftStartDay + 12
  };
};

export const generateSyntheticDataset = (options: GeneratorOptions): GeneratedDataset => {
  const rng = new SeededRandom(options.seed);
  const timelineStart = atUtcMidnight(options.timelineStartDate);
  const timelineEnd = new Date(Date.UTC(timelineStart.getUTCFullYear(), timelineStart.getUTCMonth() + options.months, timelineStart.getUTCDate()));
  const baselineStart = addDays(timelineStart, -90);

  const providers: Provider[] = PROVIDER_NAMES.map((name, index) => ({
    id: `prov-${index + 1}`,
    name,
    specialty: index % 2 === 0 ? 'Family Medicine' : 'Internal Medicine'
  }));

  const patients: Patient[] = [];
  const patientProfiles = new Map<string, PatientProfile>();

  for (let i = 0; i < options.population; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const provider = providers[i % providers.length];
    const archetype = chooseArchetype(rng);
    const id = `pat-${`${i + 1}`.padStart(4, '0')}`;

    patients.push({
      id,
      first_name: first,
      last_name: `${last}-${(i % 13) + 1}`,
      dob: createDob(rng),
      provider_id: provider.id,
      diabetes: 0,
      hypertension: 0,
      behavioral_health: 0,
      baseline_start_date: toIsoDate(baselineStart),
      archetype,
      manual_status: null,
      manual_status_expires_at: null
    });

    patientProfiles.set(id, makeProfile(rng, archetype));
  }

  const patientIds = patients.map((patient) => patient.id);
  rng.shuffle(patientIds);

  const diabetesCount = rng.int(40, 60);
  const hypertensionCount = rng.int(100, 150);
  const behavioralCount = rng.int(45, 85);

  const diabetesSet = new Set(patientIds.slice(0, diabetesCount));
  const hypertensionSet = new Set(patientIds.slice(diabetesCount / 2, diabetesCount / 2 + hypertensionCount));
  const behavioralSet = new Set(patientIds.slice(diabetesCount + 20, diabetesCount + 20 + behavioralCount));

  patients.forEach((patient) => {
    if (diabetesSet.has(patient.id)) {
      patient.diabetes = 1;
    }
    if (hypertensionSet.has(patient.id) || (patient.diabetes === 1 && rng.maybe(0.5))) {
      patient.hypertension = 1;
    }
    if (behavioralSet.has(patient.id)) {
      patient.behavioral_health = 1;
    }
  });

  const events: EventRecord[] = [];
  let eventCounter = 1;

  const pushEvent = (event: Omit<EventRecord, 'id'>): void => {
    events.push({
      id: `evt-${`${eventCounter}`.padStart(8, '0')}`,
      ...event
    });
    eventCounter += 1;
  };

  const maybeClaimForService = (
    patient: Patient,
    date: Date,
    icd10: string[],
    claimType: 'outpatient' | 'professional' | 'urgent' | 'inpatient' | 'pharmacy'
  ): void => {
    const delay = rng.int(3, 15);
    const postedAt = addHours(addDays(date, delay), rng.int(8, 18));
    if (postedAt >= timelineEnd) {
      return;
    }

    const place =
      claimType === 'inpatient'
        ? 'inpatient'
        : claimType === 'urgent'
          ? 'er'
          : claimType === 'pharmacy'
            ? 'pharmacy'
            : rng.pick(['office', 'telehealth']);

    const paidAmount =
      claimType === 'inpatient'
        ? rng.int(9000, 28000)
        : claimType === 'urgent'
          ? rng.int(900, 4200)
          : claimType === 'pharmacy'
            ? rng.int(35, 300)
            : rng.int(120, 900);

    pushEvent({
      patient_id: patient.id,
      provider_id: patient.provider_id,
      event_type: 'ClaimPosted',
      simulated_at: postedAt.toISOString(),
      service_date: toIsoDate(date),
      icd10_list: icd10,
      paid_amount: paidAmount,
      payload: {
        claim_type: claimType,
        place_of_service: place,
        icd10_list: icd10
      }
    });
  };

  const poissonCount = (lambda: number): number => {
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k += 1;
      p *= rng.next();
    } while (p > l);
    return Math.max(0, k - 1);
  };

  const catastrophicParams = (() => {
    const intensity = options.riskIntensity || 'low';
    if (intensity === 'high') {
      return { eventsOver36Months: 10.5, tailAlpha: 1.6, min: 110000, max: 1200000 };
    }
    if (intensity === 'typical') {
      return { eventsOver36Months: 6.8, tailAlpha: 1.85, min: 95000, max: 900000 };
    }
    return { eventsOver36Months: 4.2, tailAlpha: 2.1, min: 85000, max: 700000 };
  })();

  for (const patient of patients) {
    const profile = patientProfiles.get(patient.id);
    if (!profile) {
      continue;
    }

    let date = new Date(baselineStart);
    let dayOffset = -90;

    let nextRefill = rng.int(18, 32);
    let nextA1c = rng.int(28, 48);
    let nextMicroalbumin = rng.int(55, 92);
    let nextBp = rng.int(20, 35);
    let nextWeight = rng.int(26, 45);

    let a1c = patient.diabetes ? rng.int(62, 78) / 10 : 5.8;
    let systolic = patient.hypertension ? rng.int(128, 148) : rng.int(112, 128);
    let diastolic = patient.hypertension ? rng.int(80, 96) : rng.int(70, 84);
    let weight = rng.int(62, 114);

    while (date < timelineEnd) {
      const isBaseline = dayOffset < 0;
      const inDrift = !isBaseline && dayOffset >= profile.driftStartDay && dayOffset <= profile.driftEndDay;
      const inSevereWindow = inDrift && dayOffset <= profile.severeWindowEndDay;

      let contactProb = patient.diabetes || patient.hypertension ? 0.012 : 0.007;
      let portalProb = 0.0018;
      let missedApptProb = 0.0008;
      let uncategorizedBias = false;
      let refillLateBias = 0;
      let severeProb = 0;

      if (!isBaseline && profile.archetype === 'mild_drift' && inDrift) {
        contactProb += 0.028;
        portalProb += 0.025;
        missedApptProb += 0.011;
        uncategorizedBias = true;
        refillLateBias = rng.int(4, 12);
      }

      if (!isBaseline && profile.archetype === 'severe_spike' && inDrift) {
        contactProb += 0.04;
        portalProb += 0.018;
        severeProb = inSevereWindow ? 0.05 : 0.025;
        missedApptProb += 0.01;
        refillLateBias = rng.int(8, 18);
      }

      if (!isBaseline && profile.archetype === 'suppression' && inDrift) {
        contactProb *= 0.25;
        portalProb += 0.006;
        missedApptProb += 0.02;
        refillLateBias = rng.int(10, 25);
      }

      if (!isBaseline && profile.archetype === 'biometric_decline' && inDrift) {
        contactProb += 0.015;
        portalProb += 0.007;
        missedApptProb += 0.005;
        refillLateBias = rng.int(4, 12);
      }

      if (rng.maybe(contactProb)) {
        const encounterType: 'office' | 'urgent' | 'telehealth' = rng.maybe(0.16)
          ? 'telehealth'
          : rng.maybe(inDrift ? 0.28 : 0.12)
            ? 'urgent'
            : 'office';

        const icd10 = chooseIcd10(
          rng,
          patient.diabetes === 1,
          patient.hypertension === 1,
          patient.behavioral_health === 1,
          uncategorizedBias
        );

        const eventTime = dayWithTime(rng, date);

        pushEvent({
          patient_id: patient.id,
          provider_id: patient.provider_id,
          event_type: 'EncounterNoteSigned',
          simulated_at: eventTime.toISOString(),
          service_date: toIsoDate(date),
          icd10_list: icd10,
          paid_amount: null,
          payload: {
            encounter_type: encounterType,
            icd10_list: icd10,
            provider_id: patient.provider_id
          }
        });

        maybeClaimForService(
          patient,
          date,
          icd10,
          encounterType === 'urgent' ? 'urgent' : 'professional'
        );
      }

      if (severeProb > 0 && rng.maybe(severeProb)) {
        const erTime = dayWithTime(rng, date);
        const erIcd10 = chooseIcd10(
          rng,
          patient.diabetes === 1,
          patient.hypertension === 1,
          patient.behavioral_health === 1,
          true
        );

        pushEvent({
          patient_id: patient.id,
          provider_id: patient.provider_id,
          event_type: 'ERVisit',
          simulated_at: erTime.toISOString(),
          service_date: toIsoDate(date),
          icd10_list: erIcd10,
          paid_amount: null,
          payload: {
            chief_complaint: rng.pick(['dizziness', 'fatigue', 'chest discomfort', 'shortness of breath'])
          }
        });
        maybeClaimForService(patient, date, erIcd10, 'urgent');

        if (rng.maybe(0.58)) {
          const admitDate = addHours(erTime, rng.int(1, 9));
          pushEvent({
            patient_id: patient.id,
            provider_id: patient.provider_id,
            event_type: 'HospitalAdmission',
            simulated_at: admitDate.toISOString(),
            service_date: toIsoDate(date),
            icd10_list: erIcd10,
            paid_amount: null,
            payload: {
              admission_type: 'emergent'
            }
          });

          maybeClaimForService(patient, date, erIcd10, 'inpatient');

          const losDays = rng.int(2, 6);
          const dischargeDate = addHours(addDays(admitDate, losDays), rng.int(9, 15));
          if (dischargeDate < timelineEnd) {
            pushEvent({
              patient_id: patient.id,
              provider_id: patient.provider_id,
              event_type: 'HospitalDischarge',
              simulated_at: dischargeDate.toISOString(),
              service_date: toIsoDate(addDays(date, losDays)),
              icd10_list: erIcd10,
              paid_amount: null,
              payload: {
                disposition: rng.pick(['home', 'home_with_services', 'skilled_nursing'])
              }
            });
          }
        }
      }

      if (rng.maybe(portalProb)) {
        pushEvent({
          patient_id: patient.id,
          provider_id: patient.provider_id,
          event_type: 'PortalMessageSent',
          simulated_at: dayWithTime(rng, date).toISOString(),
          service_date: null,
          icd10_list: [],
          paid_amount: null,
          payload: {
            direction: rng.maybe(0.72) ? 'patient_to_clinic' : 'clinic_to_patient',
            message_topic: rng.pick(MESSAGE_TOPICS),
            word_count: rng.int(12, 180)
          }
        });
      }

      if (rng.maybe(missedApptProb)) {
        pushEvent({
          patient_id: patient.id,
          provider_id: patient.provider_id,
          event_type: 'MissedAppointment',
          simulated_at: dayWithTime(rng, date).toISOString(),
          service_date: toIsoDate(date),
          icd10_list: [],
          paid_amount: null,
          payload: {
            appointment_type: rng.pick(APPOINTMENT_TYPES)
          }
        });
      }

      nextRefill -= 1;
      if (nextRefill <= 0 && (patient.diabetes === 1 || patient.hypertension === 1)) {
        const lateDays = inDrift ? refillLateBias : rng.int(0, 3);
        const status = lateDays > 12 ? (rng.maybe(0.2) ? 'denied' : 'requested') : 'approved';

        pushEvent({
          patient_id: patient.id,
          provider_id: patient.provider_id,
          event_type: 'MedRefillRequest',
          simulated_at: dayWithTime(rng, date).toISOString(),
          service_date: toIsoDate(date),
          icd10_list: [],
          paid_amount: null,
          payload: {
            medication_class: rng.pick(MED_CLASSES),
            status,
            days_late_from_expected_refill: lateDays
          }
        });

        maybeClaimForService(patient, date, chooseIcd10(rng, patient.diabetes === 1, patient.hypertension === 1, false), 'pharmacy');

        nextRefill = 30 + rng.int(-4, 6);
      }

      nextA1c -= 1;
      if (patient.diabetes === 1 && nextA1c <= 0) {
        if (profile.archetype === 'biometric_decline' && inDrift) {
          a1c += rng.int(1, 5) / 10;
        } else if (profile.archetype === 'mild_drift' && inDrift) {
          a1c += rng.int(0, 3) / 10;
        } else {
          a1c += rng.int(-2, 2) / 10;
        }
        a1c = Math.max(5.5, Math.min(11.2, a1c));

        pushEvent({
          patient_id: patient.id,
          provider_id: patient.provider_id,
          event_type: 'LabResult',
          simulated_at: dayWithTime(rng, date).toISOString(),
          service_date: toIsoDate(date),
          icd10_list: chooseIcd10(rng, true, patient.hypertension === 1, false),
          paid_amount: null,
          payload: {
            lab_name: 'A1c',
            value: Number(a1c.toFixed(1)),
            units: '%'
          }
        });

        nextA1c = rng.int(35, 56);
      }

      nextMicroalbumin -= 1;
      if (patient.diabetes === 1 && nextMicroalbumin <= 0) {
        const value = profile.archetype === 'biometric_decline' && inDrift ? rng.int(38, 120) : rng.int(8, 36);
        pushEvent({
          patient_id: patient.id,
          provider_id: patient.provider_id,
          event_type: 'LabResult',
          simulated_at: dayWithTime(rng, date).toISOString(),
          service_date: toIsoDate(date),
          icd10_list: chooseIcd10(rng, true, patient.hypertension === 1, false),
          paid_amount: null,
          payload: {
            lab_name: 'microalbumin',
            value,
            units: 'mg/g'
          }
        });
        nextMicroalbumin = rng.int(70, 110);
      }

      nextBp -= 1;
      if (patient.hypertension === 1 && nextBp <= 0) {
        if (inDrift && (profile.archetype === 'biometric_decline' || profile.archetype === 'severe_spike')) {
          systolic += rng.int(2, 8);
          diastolic += rng.int(1, 5);
        } else {
          systolic += rng.int(-3, 3);
          diastolic += rng.int(-2, 2);
        }

        systolic = Math.max(108, Math.min(182, systolic));
        diastolic = Math.max(64, Math.min(112, diastolic));

        pushEvent({
          patient_id: patient.id,
          provider_id: patient.provider_id,
          event_type: 'VitalReading',
          simulated_at: dayWithTime(rng, date).toISOString(),
          service_date: toIsoDate(date),
          icd10_list: chooseIcd10(rng, patient.diabetes === 1, true, false),
          paid_amount: null,
          payload: {
            bp_systolic: systolic,
            bp_diastolic: diastolic
          }
        });

        nextBp = rng.int(24, 42);
      }

      nextWeight -= 1;
      if (nextWeight <= 0) {
        if (inDrift && profile.archetype === 'biometric_decline') {
          weight += rng.int(1, 3);
        } else {
          weight += rng.int(-1, 1);
        }
        weight = Math.max(52, Math.min(148, weight));

        pushEvent({
          patient_id: patient.id,
          provider_id: patient.provider_id,
          event_type: 'VitalReading',
          simulated_at: dayWithTime(rng, date).toISOString(),
          service_date: toIsoDate(date),
          icd10_list: chooseIcd10(rng, patient.diabetes === 1, patient.hypertension === 1, false),
          paid_amount: null,
          payload: {
            weight_kg: weight
          }
        });

        nextWeight = rng.int(30, 52);
      }

      dayOffset += 1;
      date = addDays(date, 1);
    }
  }

  const monthsTotal = Math.max(1, options.months);
  const monthlyLambda = catastrophicParams.eventsOver36Months / 36;
  const catastrophicAttachment = 100000;
  const reimbCoverage = 0.88;

  for (let monthIdx = 0; monthIdx < monthsTotal; monthIdx += 1) {
    const monthStart = new Date(
      Date.UTC(timelineStart.getUTCFullYear(), timelineStart.getUTCMonth() + monthIdx, 1)
    );
    const monthEnd = new Date(
      Date.UTC(timelineStart.getUTCFullYear(), timelineStart.getUTCMonth() + monthIdx + 1, 1)
    );
    const count = poissonCount(monthlyLambda);
    for (let i = 0; i < count; i += 1) {
      const patient = rng.pick(patients);
      const daySpan = Math.max(1, Math.floor((monthEnd.getTime() - monthStart.getTime()) / (24 * 60 * 60 * 1000)));
      const evtDate = addDays(monthStart, rng.int(0, daySpan - 1));
      const icd10 = chooseIcd10(rng, patient.diabetes === 1, patient.hypertension === 1, patient.behavioral_health === 1, true);

      const u = Math.max(0.000001, rng.next());
      const raw = catastrophicParams.min / Math.pow(u, catastrophicParams.tailAlpha);
      const catastrophicAmount = Math.min(catastrophicParams.max, Math.round(raw / 100) * 100);
      const stopLossReimbursed = catastrophicAmount > catastrophicAttachment;
      const reimbursedAmount = stopLossReimbursed
        ? Math.round((catastrophicAmount - catastrophicAttachment) * reimbCoverage)
        : 0;

      const encounterAt = dayWithTime(rng, evtDate);
      pushEvent({
        patient_id: patient.id,
        provider_id: patient.provider_id,
        event_type: 'ERVisit',
        simulated_at: encounterAt.toISOString(),
        service_date: toIsoDate(evtDate),
        icd10_list: icd10,
        paid_amount: null,
        payload: {
          chief_complaint: 'high acuity unexpected event',
          catastrophic: true
        }
      });

      pushEvent({
        patient_id: patient.id,
        provider_id: patient.provider_id,
        event_type: 'ClaimPosted',
        simulated_at: addDays(encounterAt, rng.int(4, 16)).toISOString(),
        service_date: toIsoDate(evtDate),
        icd10_list: icd10,
        paid_amount: catastrophicAmount,
        payload: {
          claim_type: 'catastrophic',
          place_of_service: 'inpatient',
          catastrophic: true,
          stop_loss_reimbursed: stopLossReimbursed,
          attachment_point: catastrophicAttachment
        }
      });

      if (stopLossReimbursed) {
        const reimbAt = addDays(encounterAt, rng.int(24, 75));
        if (reimbAt < timelineEnd) {
          pushEvent({
            patient_id: patient.id,
            provider_id: patient.provider_id,
            event_type: 'ClaimPosted',
            simulated_at: reimbAt.toISOString(),
            service_date: toIsoDate(reimbAt),
            icd10_list: [],
            paid_amount: -reimbursedAmount,
            payload: {
              claim_type: 'stop_loss_reimbursement',
              catastrophic_source_paid: catastrophicAmount,
              reimbursement_amount: reimbursedAmount
            }
          });
        }
      }
    }
  }

  events.sort((a, b) => a.simulated_at.localeCompare(b.simulated_at));

  return {
    providers,
    patients,
    events,
    timelineStart,
    timelineEnd,
    baselineStart
  };
};
