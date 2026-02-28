import { randomUUID } from 'crypto';
import { config } from '../config';
import { clearSimulationData, db } from '../db';
import { generateSyntheticDataset } from './generator';
import { addDays, startOfWeek } from '../utils/time';

interface SeedResult {
  seed: number;
  timelineStart: string;
  timelineEnd: string;
  baselineStart: string;
  population: number;
  eventCount: number;
}

const POPULATION = 500;

export const resetAndSeedSimulation = (seed: number, riskIntensity: 'low' | 'typical' | 'high' = 'low'): SeedResult => {
  clearSimulationData();

  const dataset = generateSyntheticDataset({
    seed,
    timelineStartDate: config.simulationStartDate,
    months: config.simulationMonths,
    population: POPULATION,
    riskIntensity
  });

  const insertProvider = db.prepare(
    `INSERT INTO providers (id, name, specialty) VALUES (@id, @name, @specialty)`
  );

  const insertPatient = db.prepare(
    `INSERT INTO patients (
      id,
      first_name,
      last_name,
      dob,
      provider_id,
      diabetes,
      hypertension,
      behavioral_health,
      baseline_start_date,
      archetype,
      manual_status,
      manual_status_expires_at
    ) VALUES (
      @id,
      @first_name,
      @last_name,
      @dob,
      @provider_id,
      @diabetes,
      @hypertension,
      @behavioral_health,
      @baseline_start_date,
      @archetype,
      @manual_status,
      @manual_status_expires_at
    )`
  );

  const insertEvent = db.prepare(
    `INSERT INTO events (
      id,
      patient_id,
      provider_id,
      event_type,
      simulated_at,
      service_date,
      icd10_json,
      paid_amount,
      payload_json
    ) VALUES (
      @id,
      @patient_id,
      @provider_id,
      @event_type,
      @simulated_at,
      @service_date,
      @icd10_json,
      @paid_amount,
      @payload_json
    )`
  );

  const insertMapping = db.prepare(
    `INSERT INTO mappings (id, external_system, external_id, entity_type, internal_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const setState = db.prepare(
    `INSERT INTO simulation_state (
      id,
      seed,
      mode,
      speed_days_per_second,
      clock_status,
      clock_time,
      start_time,
      end_time,
      last_real_update,
      last_processed_week
    ) VALUES (
      1,
      @seed,
      @mode,
      @speed_days_per_second,
      @clock_status,
      @clock_time,
      @start_time,
      @end_time,
      @last_real_update,
      @last_processed_week
    )`
  );

  const setPatientSimState = db.prepare(
    `INSERT INTO patient_sim_state (id, last_processed_month)
     VALUES (1, ?)`
  );

  const setFinanceSettings = db.prepare(
    `INSERT INTO finance_sim_settings (id, risk_intensity)
     VALUES (1, ?)`
  );

  const nowMs = Date.now();

  db.transaction(() => {
    for (const provider of dataset.providers) {
      insertProvider.run(provider);
      insertMapping.run(
        randomUUID(),
        'ecw',
        `ECW-PROV-${provider.id}`,
        'provider',
        provider.id,
        new Date().toISOString()
      );
    }

    for (const patient of dataset.patients) {
      insertPatient.run(patient);
      insertMapping.run(
        randomUUID(),
        'ecw',
        `ECW-PAT-${patient.id}`,
        'patient',
        patient.id,
        new Date().toISOString()
      );
    }

    for (const event of dataset.events) {
      insertEvent.run({
        ...event,
        icd10_json: JSON.stringify(event.icd10_list),
        payload_json: JSON.stringify(event.payload)
      });
    }

    const weekBefore = addDays(startOfWeek(dataset.timelineStart), -7);

    setState.run({
      seed,
      mode: config.adapterMode,
      speed_days_per_second: config.defaultDaysPerSecond,
      clock_status: 'stopped',
      clock_time: dataset.timelineStart.toISOString(),
      start_time: dataset.timelineStart.toISOString(),
      end_time: dataset.timelineEnd.toISOString(),
      last_real_update: nowMs,
      last_processed_week: weekBefore.toISOString()
    });

    const monthBeforeStart = new Date(
      Date.UTC(dataset.timelineStart.getUTCFullYear(), dataset.timelineStart.getUTCMonth() - 1, 1)
    );
    setPatientSimState.run(monthBeforeStart.toISOString());
    setFinanceSettings.run(riskIntensity);
  })();

  return {
    seed,
    timelineStart: dataset.timelineStart.toISOString(),
    timelineEnd: dataset.timelineEnd.toISOString(),
    baselineStart: dataset.baselineStart.toISOString(),
    population: dataset.patients.length,
    eventCount: dataset.events.length
  };
};
