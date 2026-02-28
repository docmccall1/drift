const DAY_MS = 24 * 60 * 60 * 1000;

export const dayMs = DAY_MS;

export const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

export const atUtcMidnight = (isoDate: string): Date => {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

export const addDays = (date: Date, days: number): Date => {
  return new Date(date.getTime() + days * DAY_MS);
};

export const addHours = (date: Date, hours: number): Date => {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
};

export const addMinutes = (date: Date, minutes: number): Date => {
  return new Date(date.getTime() + minutes * 60 * 1000);
};

export const clampDate = (value: Date, min: Date, max: Date): Date => {
  if (value < min) {
    return new Date(min);
  }
  if (value > max) {
    return new Date(max);
  }
  return value;
};

export const startOfWeek = (date: Date): Date => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d;
};

export const weeksBetween = (older: Date, newer: Date): number => {
  return Math.max(0, Math.floor((startOfWeek(newer).getTime() - startOfWeek(older).getTime()) / (7 * DAY_MS)));
};

export const parseIsoDateTime = (iso: string): Date => new Date(iso);

export const inRange = (value: Date, start: Date, end: Date): boolean => {
  return value >= start && value < end;
};

export const formatWeekLabel = (date: Date): string => {
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
};
