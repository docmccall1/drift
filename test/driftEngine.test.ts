import { describe, expect, it } from 'vitest';
import { computeDriftForWeek } from '../src/drift/engine';
import { EventRecord } from '../src/types/domain';

const makeEvent = (
  overrides: Partial<EventRecord> & Pick<EventRecord, 'event_type' | 'simulated_at'>
): EventRecord => ({
  id: overrides.id || Math.random().toString(36).slice(2),
  patient_id: overrides.patient_id || 'pat-1',
  provider_id: overrides.provider_id || 'prov-1',
  event_type: overrides.event_type,
  simulated_at: overrides.simulated_at,
  service_date: overrides.service_date || overrides.simulated_at.slice(0, 10),
  icd10_list: overrides.icd10_list || [],
  paid_amount: overrides.paid_amount ?? null,
  payload: overrides.payload || {}
});

const weekStart = new Date('2025-03-03T00:00:00.000Z');

const baselineEvents = Array.from({ length: 26 }).map((_, index) =>
  makeEvent({
    event_type: 'EncounterNoteSigned',
    simulated_at: new Date(Date.UTC(2024, 11, 1 + index * 3)).toISOString(),
    icd10_list: ['I10'],
    payload: { encounter_type: 'office' }
  })
);

describe('computeDriftForWeek', () => {
  it('uses yellow observation then confirms yellow next week', () => {
    const weekOneEvents = [
      ...baselineEvents,
      ...Array.from({ length: 11 }).map((_, idx) =>
        makeEvent({
          event_type: 'EncounterNoteSigned',
          simulated_at: new Date(weekStart.getTime() + idx * 12 * 60 * 60 * 1000).toISOString(),
          icd10_list: ['R53.83'],
          payload: { encounter_type: 'urgent' }
        })
      ),
      ...Array.from({ length: 3 }).map((_, idx) =>
        makeEvent({
          event_type: 'PortalMessageSent',
          simulated_at: new Date(weekStart.getTime() + idx * 8 * 60 * 60 * 1000).toISOString(),
          payload: { direction: 'patient_to_clinic', message_topic: 'new symptom', word_count: 90 }
        })
      ),
      makeEvent({
        event_type: 'MedRefillRequest',
        simulated_at: new Date(weekStart.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        payload: { medication_class: 'metformin', status: 'requested', days_late_from_expected_refill: 9 }
      })
    ];

    const weekOne = computeDriftForWeek({
      weekStart,
      events: weekOneEvents,
      baselineEvents,
      previousScore: {
        cdiTotal: 18,
        status: 'GREEN',
        hasSevereTrigger: false
      },
      thresholds: {
        yellow: 30,
        redCandidate: 60
      }
    });

    expect(weekOne.cdiTotal).toBeGreaterThanOrEqual(30);
    expect(weekOne.status).toBe('YELLOW_OBSERVATION');

    const weekTwoStart = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const weekTwoEvents = [
      ...baselineEvents,
      ...weekOneEvents.filter((event) => new Date(event.simulated_at) >= weekStart),
      ...Array.from({ length: 9 }).map((_, idx) =>
        makeEvent({
          event_type: 'EncounterNoteSigned',
          simulated_at: new Date(weekTwoStart.getTime() + idx * 9 * 60 * 60 * 1000).toISOString(),
          icd10_list: ['R07.9'],
          payload: { encounter_type: 'urgent' }
        })
      ),
      ...Array.from({ length: 3 }).map((_, idx) =>
        makeEvent({
          event_type: 'PortalMessageSent',
          simulated_at: new Date(weekTwoStart.getTime() + idx * 7 * 60 * 60 * 1000).toISOString(),
          payload: { direction: 'patient_to_clinic', message_topic: 'follow-up timing', word_count: 100 }
        })
      )
    ];

    const weekTwo = computeDriftForWeek({
      weekStart: weekTwoStart,
      events: weekTwoEvents,
      baselineEvents,
      previousScore: {
        cdiTotal: weekOne.cdiTotal,
        status: weekOne.status,
        hasSevereTrigger: weekOne.hasSevereTrigger
      },
      thresholds: {
        yellow: 30,
        redCandidate: 60
      }
    });

    expect(weekTwo.cdiTotal).toBeGreaterThanOrEqual(30);
    expect(weekTwo.status).toBe('YELLOW');
  });

  it('allows velocity override to yellow when severe trigger occurs', () => {
    const events = [
      ...baselineEvents,
      ...Array.from({ length: 6 }).map((_, idx) =>
        makeEvent({
          event_type: 'EncounterNoteSigned',
          simulated_at: new Date(weekStart.getTime() + idx * 6 * 60 * 60 * 1000).toISOString(),
          icd10_list: ['R53.83'],
          payload: { encounter_type: 'urgent' }
        })
      ),
      makeEvent({
        event_type: 'ERVisit',
        simulated_at: '2025-03-04T10:00:00.000Z',
        icd10_list: ['R06.02'],
        payload: { chief_complaint: 'shortness of breath' }
      }),
      makeEvent({
        event_type: 'HospitalAdmission',
        simulated_at: '2025-03-04T12:00:00.000Z',
        icd10_list: ['R06.02'],
        payload: { admission_type: 'emergent' }
      })
    ];

    const result = computeDriftForWeek({
      weekStart,
      events,
      baselineEvents,
      previousScore: {
        cdiTotal: 5,
        status: 'GREEN',
        hasSevereTrigger: false
      },
      thresholds: {
        yellow: 30,
        redCandidate: 60
      }
    });

    expect(result.velocity).toBeGreaterThanOrEqual(25);
    expect(result.status === 'YELLOW' || result.status === 'RED_CANDIDATE').toBeTruthy();
  });

  it('applies 10% decay without new triggers', () => {
    const result = computeDriftForWeek({
      weekStart,
      events: [],
      baselineEvents: [],
      previousScore: {
        cdiTotal: 50,
        status: 'YELLOW',
        hasSevereTrigger: false
      },
      thresholds: {
        yellow: 30,
        redCandidate: 60
      }
    });

    expect(result.cdiTotal).toBe(45);
    expect(result.status).toBe('YELLOW');
  });

  it('uses slower decay when severe trigger was active', () => {
    const result = computeDriftForWeek({
      weekStart,
      events: [],
      baselineEvents: [],
      previousScore: {
        cdiTotal: 40,
        status: 'YELLOW',
        hasSevereTrigger: true
      },
      thresholds: {
        yellow: 30,
        redCandidate: 60
      }
    });

    expect(result.cdiTotal).toBe(38);
  });
});
