import { db } from '../db';
import { resetAndSeedSimulation } from './seeder';
import { recalculateScoresThrough } from '../services/scoringService';
import { addDays, clampDate, dayMs, startOfWeek } from '../utils/time';
import { config } from '../config';
import { SimulationState } from '../types/domain';

interface ClockStateRow extends SimulationState {}

const getStateRow = (): ClockStateRow => {
  const state = db.prepare(`SELECT * FROM simulation_state WHERE id = 1`).get() as ClockStateRow | undefined;
  if (!state) {
    throw new Error('Simulation state not initialized');
  }
  return state;
};

const updateState = (partial: Partial<ClockStateRow>): void => {
  const keys = Object.keys(partial);
  if (keys.length === 0) {
    return;
  }
  const assignments = keys.map((key) => `${key} = @${key}`).join(', ');
  db.prepare(`UPDATE simulation_state SET ${assignments} WHERE id = 1`).run(partial);
};

export class SimulationClock {
  private timer: NodeJS.Timeout | null = null;

  ensureStarted(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Simulation tick failed:', error);
      }
    }, 1000);
  }

  tick(): void {
    const state = getStateRow();
    if (state.clock_status !== 'running') {
      return;
    }

    const now = Date.now();
    const elapsedMs = Math.max(0, now - state.last_real_update);
    const currentClock = new Date(state.clock_time);
    const start = new Date(state.start_time);
    const end = new Date(state.end_time);

    const advancedMs = elapsedMs * state.speed_days_per_second * dayMs / 1000;
    const nextClock = clampDate(new Date(currentClock.getTime() + advancedMs), start, end);

    const nextStatus = nextClock >= end ? 'paused' : 'running';

    updateState({
      clock_time: nextClock.toISOString(),
      clock_status: nextStatus,
      last_real_update: now
    });

    recalculateScoresThrough(nextClock);
  }

  getState(): ClockStateRow {
    return getStateRow();
  }

  start(): ClockStateRow {
    const state = getStateRow();
    const start = new Date(state.start_time);
    const weekBefore = addDays(startOfWeek(start), -7);

    updateState({
      clock_status: 'running',
      clock_time: start.toISOString(),
      last_real_update: Date.now(),
      last_processed_week: weekBefore.toISOString()
    });

    recalculateScoresThrough(start);
    return getStateRow();
  }

  pause(): ClockStateRow {
    updateState({
      clock_status: 'paused',
      last_real_update: Date.now()
    });
    return getStateRow();
  }

  resume(): ClockStateRow {
    const state = getStateRow();
    if (state.clock_status === 'running') {
      return state;
    }

    updateState({
      clock_status: 'running',
      last_real_update: Date.now()
    });
    return getStateRow();
  }

  setSpeed(daysPerSecond: number): ClockStateRow {
    updateState({
      speed_days_per_second: Math.max(0.02, Math.min(4, daysPerSecond)),
      last_real_update: Date.now()
    });
    return getStateRow();
  }

  jumpToDate(isoDateOrDateTime: string): ClockStateRow {
    const state = getStateRow();
    const start = new Date(state.start_time);
    const end = new Date(state.end_time);
    const target = clampDate(new Date(isoDateOrDateTime), start, end);

    updateState({
      clock_time: target.toISOString(),
      last_real_update: Date.now()
    });

    recalculateScoresThrough(target);
    return getStateRow();
  }

  resetSeed(seed = config.simulationSeed, riskIntensity: 'low' | 'typical' | 'high' = 'low'): ClockStateRow {
    resetAndSeedSimulation(seed, riskIntensity);
    const state = getStateRow();
    const start = new Date(state.start_time);
    const weekBefore = addDays(startOfWeek(start), -7);
    updateState({
      clock_status: 'stopped',
      speed_days_per_second: config.defaultDaysPerSecond,
      clock_time: state.start_time,
      last_real_update: Date.now(),
      last_processed_week: weekBefore.toISOString()
    });

    recalculateScoresThrough(start);
    return getStateRow();
  }
}

export const simulationClock = new SimulationClock();
