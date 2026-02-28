import Database from 'better-sqlite3';
import { config } from './config';

export const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export const initSchema = (): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      specialty TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      dob TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      diabetes INTEGER NOT NULL DEFAULT 0,
      hypertension INTEGER NOT NULL DEFAULT 0,
      behavioral_health INTEGER NOT NULL DEFAULT 0,
      baseline_start_date TEXT NOT NULL,
      archetype TEXT NOT NULL,
      manual_status TEXT,
      manual_status_expires_at TEXT,
      FOREIGN KEY (provider_id) REFERENCES providers(id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      provider_id TEXT,
      event_type TEXT NOT NULL,
      simulated_at TEXT NOT NULL,
      service_date TEXT,
      icd10_json TEXT NOT NULL,
      paid_amount REAL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY (patient_id) REFERENCES patients(id),
      FOREIGN KEY (provider_id) REFERENCES providers(id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_patient_time ON events(patient_id, simulated_at);
    CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, simulated_at);

    CREATE TABLE IF NOT EXISTS weekly_scores (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      cdi_total REAL NOT NULL,
      utilization REAL NOT NULL,
      behavioral REAL NOT NULL,
      biometric REAL NOT NULL,
      physician_modifier REAL NOT NULL,
      status TEXT NOT NULL,
      velocity REAL NOT NULL,
      has_severe_trigger INTEGER NOT NULL DEFAULT 0,
      top_signals_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(patient_id, week_start),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE INDEX IF NOT EXISTS idx_weekly_scores_week ON weekly_scores(week_start);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      assigned_role TEXT NOT NULL,
      assigned_user_id TEXT,
      task_type TEXT NOT NULL,
      source_week TEXT,
      due_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      notes TEXT,
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_at);

    CREATE TABLE IF NOT EXISTS mappings (
      id TEXT PRIMARY KEY,
      external_system TEXT NOT NULL,
      external_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      internal_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS simulation_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      seed INTEGER NOT NULL,
      mode TEXT NOT NULL,
      speed_days_per_second REAL NOT NULL,
      clock_status TEXT NOT NULL,
      clock_time TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      last_real_update INTEGER NOT NULL,
      last_processed_week TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS patient_sim_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_processed_month TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS finance_sim_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      risk_intensity TEXT NOT NULL DEFAULT 'low'
    );

    CREATE TABLE IF NOT EXISTS patient_sim_preferences (
      patient_id TEXT PRIMARY KEY,
      care_model TEXT NOT NULL DEFAULT 'traditional',
      funding_model TEXT NOT NULL DEFAULT 'fully_funded',
      primary_care_engagement TEXT NOT NULL DEFAULT 'medium',
      lifestyle_adherence TEXT NOT NULL DEFAULT 'medium',
      care_navigation_support INTEGER NOT NULL DEFAULT 0,
      friction_adjustment INTEGER NOT NULL DEFAULT 0,
      action_same_day_visit INTEGER NOT NULL DEFAULT 0,
      action_coaching_program INTEGER NOT NULL DEFAULT 0,
      action_medication_reminders INTEGER NOT NULL DEFAULT 1,
      action_preventive_outreach INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS patient_monthly_metrics (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      month_start TEXT NOT NULL,
      health_score REAL NOT NULL,
      access_score REAL NOT NULL,
      avoidable_events INTEGER NOT NULL,
      medication_adherence_proxy REAL NOT NULL,
      preventive_care_completion REAL NOT NULL,
      stress_sleep_proxy REAL NOT NULL,
      out_of_pocket_strain_index REAL NOT NULL,
      engagement_score REAL NOT NULL,
      risk_score REAL NOT NULL,
      stability_score REAL NOT NULL,
      monthly_claims_paid REAL NOT NULL,
      components_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(patient_id, month_start),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE INDEX IF NOT EXISTS idx_patient_monthly_metrics_month
      ON patient_monthly_metrics(month_start);

    CREATE TABLE IF NOT EXISTS patient_monthly_events (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      month_start TEXT NOT NULL,
      happened_at TEXT NOT NULL,
      event_key TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      kind TEXT NOT NULL,
      prevented INTEGER NOT NULL DEFAULT 0,
      source_event_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE INDEX IF NOT EXISTS idx_patient_monthly_events_patient_month
      ON patient_monthly_events(patient_id, month_start, happened_at);
  `);
};

export const clearSimulationData = (): void => {
  db.exec(`
    DELETE FROM tasks;
    DELETE FROM weekly_scores;
    DELETE FROM patient_monthly_events;
    DELETE FROM patient_monthly_metrics;
    DELETE FROM patient_sim_preferences;
    DELETE FROM patient_sim_state;
    DELETE FROM finance_sim_settings;
    DELETE FROM events;
    DELETE FROM patients;
    DELETE FROM providers;
    DELETE FROM mappings;
    DELETE FROM simulation_state;
  `);
};

// Ensure schema exists before services create prepared statements at import time.
initSchema();
