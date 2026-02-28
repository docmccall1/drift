export type Role = 'admin' | 'physician' | 'patient';

export type EventType =
  | 'ClaimPosted'
  | 'EncounterNoteSigned'
  | 'ERVisit'
  | 'HospitalAdmission'
  | 'HospitalDischarge'
  | 'PortalMessageSent'
  | 'MedRefillRequest'
  | 'MissedAppointment'
  | 'LabResult'
  | 'VitalReading';

export type EncounterType = 'office' | 'urgent' | 'telehealth';

export type TaskStatus = 'open' | 'completed' | 'overdue';

export type PatientStatus =
  | 'GREEN'
  | 'YELLOW_OBSERVATION'
  | 'YELLOW'
  | 'RED_CANDIDATE'
  | 'RED';

export interface Provider {
  id: string;
  name: string;
  specialty: string;
}

export interface Patient {
  id: string;
  first_name: string;
  last_name: string;
  dob: string;
  provider_id: string;
  diabetes: number;
  hypertension: number;
  behavioral_health: number;
  baseline_start_date: string;
  archetype: string;
  manual_status: string | null;
  manual_status_expires_at: string | null;
}

export interface EventRecord {
  id: string;
  patient_id: string;
  provider_id: string | null;
  event_type: EventType;
  simulated_at: string;
  service_date: string | null;
  icd10_list: string[];
  paid_amount: number | null;
  payload: Record<string, unknown>;
}

export interface WeeklyScore {
  id: string;
  patient_id: string;
  week_start: string;
  cdi_total: number;
  utilization: number;
  behavioral: number;
  biometric: number;
  physician_modifier: number;
  status: PatientStatus;
  velocity: number;
  has_severe_trigger: number;
  top_signals: SignalContribution[];
}

export interface SignalContribution {
  bucket: 'utilization' | 'behavioral' | 'biometric' | 'physician';
  signal: string;
  points: number;
  explanation: string;
  timestamp: string;
  severe?: boolean;
}

export interface DriftThresholds {
  yellow: number;
  redCandidate: number;
}

export interface SimulationState {
  id: number;
  seed: number;
  mode: 'simulation' | 'live';
  speed_days_per_second: number;
  clock_status: 'stopped' | 'running' | 'paused';
  clock_time: string;
  start_time: string;
  end_time: string;
  last_real_update: number;
  last_processed_week: string;
}

export interface TaskRecord {
  id: string;
  patient_id: string;
  assigned_role: 'care_manager' | 'physician' | 'admin';
  assigned_user_id: string | null;
  task_type:
    | 'yellow_outreach'
    | 'red_review'
    | 'checkin_request'
    | 'outreach_note';
  source_week: string | null;
  due_at: string;
  created_at: string;
  completed_at: string | null;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high';
  notes: string | null;
}

export interface ActorContext {
  role: Role;
  actorId: string | null;
}

export interface AdapterEventPull {
  start: string;
  end: string;
}
