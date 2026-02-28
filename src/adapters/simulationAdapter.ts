import { db } from '../db';
import { AdapterEventPull, EventRecord } from '../types/domain';
import { ClinicalDataAdapter } from './types';

const parseRows = (rows: Array<{
  id: string;
  patient_id: string;
  provider_id: string | null;
  event_type: EventRecord['event_type'];
  simulated_at: string;
  service_date: string | null;
  icd10_json: string;
  paid_amount: number | null;
  payload_json: string;
}>): EventRecord[] => {
  return rows.map((row) => ({
    id: row.id,
    patient_id: row.patient_id,
    provider_id: row.provider_id,
    event_type: row.event_type,
    simulated_at: row.simulated_at,
    service_date: row.service_date,
    icd10_list: JSON.parse(row.icd10_json),
    paid_amount: row.paid_amount,
    payload: JSON.parse(row.payload_json)
  }));
};

const fetchByTypes = (types: string[], params: AdapterEventPull): EventRecord[] => {
  const placeholders = types.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, patient_id, provider_id, event_type, simulated_at, service_date, icd10_json, paid_amount, payload_json
       FROM events
       WHERE event_type IN (${placeholders})
         AND simulated_at >= ?
         AND simulated_at < ?
       ORDER BY simulated_at ASC`
    )
    .all(...types, params.start, params.end) as Array<{
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

  return parseRows(rows);
};

export class SimulationAdapter implements ClinicalDataAdapter {
  mode: 'simulation' = 'simulation';

  async fetchPortalMessages(params: AdapterEventPull): Promise<EventRecord[]> {
    return fetchByTypes(['PortalMessageSent'], params);
  }

  async fetchRefillRequests(params: AdapterEventPull): Promise<EventRecord[]> {
    return fetchByTypes(['MedRefillRequest'], params);
  }

  async fetchEncounterDiagnoses(params: AdapterEventPull): Promise<EventRecord[]> {
    return fetchByTypes(['EncounterNoteSigned', 'ERVisit', 'HospitalAdmission'], params);
  }

  async fetchAppointments(params: AdapterEventPull): Promise<EventRecord[]> {
    return fetchByTypes(['MissedAppointment'], params);
  }

  async fetchLabsAndVitals(params: AdapterEventPull): Promise<EventRecord[]> {
    return fetchByTypes(['LabResult', 'VitalReading'], params);
  }

  async fetchClaimsOrCharges(params: AdapterEventPull): Promise<EventRecord[]> {
    return fetchByTypes(['ClaimPosted'], params);
  }
}
