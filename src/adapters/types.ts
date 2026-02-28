import { AdapterEventPull, EventRecord } from '../types/domain';

export interface ClinicalDataAdapter {
  mode: 'simulation' | 'live';
  fetchPortalMessages(params: AdapterEventPull): Promise<EventRecord[]>;
  fetchRefillRequests(params: AdapterEventPull): Promise<EventRecord[]>;
  fetchEncounterDiagnoses(params: AdapterEventPull): Promise<EventRecord[]>;
  fetchAppointments(params: AdapterEventPull): Promise<EventRecord[]>;
  fetchLabsAndVitals(params: AdapterEventPull): Promise<EventRecord[]>;
  fetchClaimsOrCharges(params: AdapterEventPull): Promise<EventRecord[]>;
}
