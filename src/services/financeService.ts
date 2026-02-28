import { db } from '../db';

export type SpendModel = 'fully_funded' | 'self_funded' | 'dpc';
export type RiskIntensity = 'low' | 'typical' | 'high';

interface FinanceInput {
  model: SpendModel;
  compareModel: SpendModel;
  baselineModel: SpendModel;
  windowMonths: number;
}

interface MonthlyBase {
  month: string;
  gross_claims: number;
  stop_loss_reimbursed: number;
  catastrophic_events: Array<{
    simulated_at: string;
    amount: number;
    stop_loss_reimbursed: boolean;
    reimbursement_amount: number;
  }>;
}

interface MonthlySpendRow {
  month: string;
  employer_spend: number;
  all_in_spend: number;
  employee_oop: number;
  paid_claims: number;
  admin_margin: number;
  stop_loss_premium: number;
  stop_loss_reimbursed: number;
  dpc_fees: number;
  catastrophic_events: MonthlyBase['catastrophic_events'];
}

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

const dollars = (value: number): number => Number(value.toFixed(2));

const monthStart = (isoDateTime: string): string => `${isoDateTime.slice(0, 7)}-01`;

const getRiskIntensity = (): RiskIntensity => {
  const row = db
    .prepare(`SELECT risk_intensity FROM finance_sim_settings WHERE id = 1`)
    .get() as { risk_intensity: RiskIntensity } | undefined;
  return row?.risk_intensity || 'low';
};

const getAsOfClockTime = (): string => {
  const row = db
    .prepare(`SELECT clock_time FROM simulation_state WHERE id = 1`)
    .get() as { clock_time: string };
  return row.clock_time;
};

export const setRiskIntensity = (intensity: RiskIntensity): RiskIntensity => {
  if (intensity !== 'low' && intensity !== 'typical' && intensity !== 'high') {
    throw new Error('risk_intensity must be low, typical, or high.');
  }
  db.prepare(
    `INSERT INTO finance_sim_settings (id, risk_intensity)
     VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET risk_intensity = excluded.risk_intensity`
  ).run(intensity);
  return intensity;
};

const getRecentMonths = (windowMonths: number, asOfIso: string): string[] => {
  const rows = db
    .prepare(
      `SELECT DISTINCT substr(simulated_at, 1, 7) as month_key
       FROM events
       WHERE event_type = 'ClaimPosted'
         AND simulated_at <= ?
       ORDER BY month_key DESC
       LIMIT ?`
    )
    .all(asOfIso, Math.max(1, windowMonths)) as Array<{ month_key: string }>;

  return rows.map((row) => `${row.month_key}-01`).reverse();
};

const getMonthlyBase = (months: string[], asOfIso: string): MonthlyBase[] => {
  const byMonth = new Map<string, MonthlyBase>();
  for (const month of months) {
    byMonth.set(month, {
      month,
      gross_claims: 0,
      stop_loss_reimbursed: 0,
      catastrophic_events: []
    });
  }

  if (months.length === 0) {
    return [];
  }

  const start = months[0];
  const endMonth = new Date(Date.UTC(Number(months[months.length - 1].slice(0, 4)), Number(months[months.length - 1].slice(5, 7)), 1));
  const end = endMonth.toISOString().slice(0, 10);

  const rows = db
    .prepare(
      `SELECT simulated_at, paid_amount, payload_json
       FROM events
       WHERE event_type = 'ClaimPosted'
         AND simulated_at >= ?
         AND simulated_at < date(?, '+1 month')
         AND simulated_at <= ?
       ORDER BY simulated_at ASC`
    )
    .all(start, end, asOfIso) as Array<{ simulated_at: string; paid_amount: number | null; payload_json: string }>;

  for (const row of rows) {
    const month = monthStart(row.simulated_at);
    const bucket = byMonth.get(month);
    if (!bucket) continue;
    const paid = row.paid_amount ?? 0;
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const claimType = String(payload.claim_type || '');

    if (claimType === 'stop_loss_reimbursement') {
      bucket.stop_loss_reimbursed += Math.abs(paid);
      continue;
    }

    bucket.gross_claims += Math.max(0, paid);

    if (claimType === 'catastrophic') {
      bucket.catastrophic_events.push({
        simulated_at: row.simulated_at,
        amount: Math.max(0, paid),
        stop_loss_reimbursed: Boolean(payload.stop_loss_reimbursed),
        reimbursement_amount: Number(payload.reimbursement_amount || 0)
      });
    }
  }

  return months.map((month) => byMonth.get(month) as MonthlyBase);
};

const applyModel = (base: MonthlyBase, model: SpendModel, coveredLives = 500): MonthlySpendRow => {
  const pmpmAdmin = model === 'fully_funded' ? 11 : model === 'self_funded' ? 22 : 16;
  const adminFixed = coveredLives * pmpmAdmin;
  const stopLossPremium = model === 'self_funded' ? coveredLives * 19 : 0;
  const dpcFees = model === 'dpc' ? coveredLives * 78 : 0;
  const modelClaimsFactor = model === 'dpc' ? 0.87 : 1;
  const grossClaims = base.gross_claims * modelClaimsFactor;
  const employeeOopRate = model === 'fully_funded' ? 0.15 : model === 'self_funded' ? 0.11 : 0.08;
  const employeeOop = grossClaims * employeeOopRate;
  const adminMargin = model === 'fully_funded' ? grossClaims * 0.17 : adminFixed + grossClaims * 0.025;
  const reimbursed = model === 'self_funded' ? base.stop_loss_reimbursed : 0;
  const employerSpend = grossClaims + adminMargin + stopLossPremium + dpcFees - reimbursed;

  return {
    month: base.month,
    employer_spend: dollars(employerSpend),
    all_in_spend: dollars(employerSpend + employeeOop),
    employee_oop: dollars(employeeOop),
    paid_claims: dollars(grossClaims),
    admin_margin: dollars(adminMargin),
    stop_loss_premium: dollars(stopLossPremium),
    stop_loss_reimbursed: dollars(reimbursed),
    dpc_fees: dollars(dpcFees),
    catastrophic_events: base.catastrophic_events
  };
};

const sum = (rows: MonthlySpendRow[], key: keyof MonthlySpendRow): number =>
  rows.reduce((acc, row) => acc + (typeof row[key] === 'number' ? (row[key] as number) : 0), 0);

const stdDev = (values: number[]): number => {
  if (values.length === 0) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

export const getFinanceDashboard = (input: FinanceInput): {
  meta: {
    baselineModel: SpendModel;
    selectedModel: SpendModel;
    compareModel: SpendModel;
    riskIntensity: RiskIntensity;
    windowMonths: number;
    asOfClockTime: string;
  };
  atGlance: {
    totalSpendEmployer: number;
    totalSpendAllIn: number;
    employeeOutOfPocket: number;
    netSaveVsBaseline: number;
    pmpmSpend: number;
    volatilityMonthlyStdDev: number;
    deltaVsBaseline: number;
  };
  compare: {
    selectedVsCompareEmployerSave: number;
    selectedVsCompareAllInSave: number;
  };
  monthly: {
    selected: MonthlySpendRow[];
    baseline: MonthlySpendRow[];
    compare: MonthlySpendRow[];
    bankSeries: Array<{
      month: string;
      avoided_saved: number;
      spend_delta_vs_baseline: number;
      bank_value: number;
    }>;
    catastrophicMarkers: Array<{
      month: string;
      simulated_at: string;
      amount: number;
      stop_loss_reimbursed: boolean;
      reimbursement_amount: number;
    }>;
  };
} => {
  const windowMonths = clamp(Math.round(input.windowMonths || 36), 3, 60);
  const asOfClockTime = getAsOfClockTime();
  const months = getRecentMonths(windowMonths, asOfClockTime);
  const base = getMonthlyBase(months, asOfClockTime);

  const selected = base.map((row) => applyModel(row, input.model));
  const baseline = base.map((row) => applyModel(row, input.baselineModel));
  const compare = base.map((row) => applyModel(row, input.compareModel));

  const totalSpendEmployer = sum(selected, 'employer_spend');
  const totalSpendAllIn = sum(selected, 'all_in_spend');
  const employeeOutOfPocket = sum(selected, 'employee_oop');
  const baselineEmployer = sum(baseline, 'employer_spend');
  const compareEmployer = sum(compare, 'employer_spend');
  const compareAllIn = sum(compare, 'all_in_spend');
  const pmpmSpend = months.length ? totalSpendEmployer / (months.length * 500) : 0;
  const volatility = stdDev(selected.map((row) => row.paid_claims));

  const catastrophicMarkers = selected.flatMap((row) =>
    row.catastrophic_events.map((evt) => ({
      month: row.month,
      simulated_at: evt.simulated_at,
      amount: evt.amount,
      stop_loss_reimbursed: evt.stop_loss_reimbursed,
      reimbursement_amount: evt.reimbursement_amount
    }))
  );

  let bankValue = 3_500_000;
  const bankSeries = selected.map((row, idx) => {
    const baseRow = baseline[idx];
    const avoidedSaved = Math.max(0, baseRow.paid_claims - row.paid_claims);
    const spendDelta = row.employer_spend - baseRow.employer_spend;

    if (spendDelta > 0) {
      bankValue -= spendDelta;
    } else {
      // When spend is lower, bank value stabilizes or recovers gradually.
      bankValue += Math.min(65_000, Math.abs(spendDelta) * 0.42 + avoidedSaved * 0.35);
    }
    bankValue = Math.max(0, bankValue);

    return {
      month: row.month,
      avoided_saved: dollars(avoidedSaved),
      spend_delta_vs_baseline: dollars(spendDelta),
      bank_value: dollars(bankValue)
    };
  });

  return {
    meta: {
      baselineModel: input.baselineModel,
      selectedModel: input.model,
      compareModel: input.compareModel,
      riskIntensity: getRiskIntensity(),
      windowMonths,
      asOfClockTime
    },
    atGlance: {
      totalSpendEmployer: dollars(totalSpendEmployer),
      totalSpendAllIn: dollars(totalSpendAllIn),
      employeeOutOfPocket: dollars(employeeOutOfPocket),
      netSaveVsBaseline: dollars(baselineEmployer - totalSpendEmployer),
      pmpmSpend: dollars(pmpmSpend),
      volatilityMonthlyStdDev: dollars(volatility),
      deltaVsBaseline: dollars(totalSpendEmployer - baselineEmployer)
    },
    compare: {
      selectedVsCompareEmployerSave: dollars(compareEmployer - totalSpendEmployer),
      selectedVsCompareAllInSave: dollars(compareAllIn - totalSpendAllIn)
    },
    monthly: {
      selected,
      baseline,
      compare,
      bankSeries,
      catastrophicMarkers
    }
  };
};
