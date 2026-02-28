const appState = {
  role: 'admin',
  actorId: 'admin-sim',
  roleOptions: null,
  adminFilter: 'all',
  selectedPhysicianPatient: null,
  patientHealthOverlay: false,
  previousHealthSeries: [],
  finance: {
    model: 'fully_funded',
    compareModel: 'self_funded',
    baselineModel: 'fully_funded',
    windowMonths: 36,
    scaleMode: 'shared',
    interventionEnabled: false,
    interventionStrength: 'moderate',
    exactData: false,
    lockedRange: { min: 0, max: 500000 },
    pinnedMonth: null
  }
};

const $ = (id) => document.getElementById(id);

const roleButtons = Array.from(document.querySelectorAll('.role-btn'));
const viewMap = {
  admin: $('view-admin'),
  physician: $('view-physician'),
  patient: $('view-patient')
};

const statusClass = (status) => `status-${status || 'GREEN'}`;

const formatDateTime = (iso) => new Date(iso).toLocaleString();

const formatMoneyExact = (value) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);

const formatMoneyShort = (value) => {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${value < 0 ? '-' : ''}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${value < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${value < 0 ? '-' : ''}$${(abs / 1_000).toFixed(0)}K`;
  return `${value < 0 ? '-' : ''}$${Math.round(abs)}`;
};

const withExactTitle = (shortValue, exactValue) => `<span title="${formatMoneyExact(exactValue)} (hover to reveal exact)">${shortValue}</span>`;

const apiFetch = async (path, options = {}) => {
  const headers = {
    'Content-Type': 'application/json',
    'x-role': options.role || appState.role,
    'x-actor-id': options.actorId || appState.actorId || ''
  };

  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed ${response.status}`);
  }

  if (response.headers.get('content-type')?.includes('text/csv')) {
    return response.text();
  }

  return response.json();
};

const setRole = (role) => {
  appState.role = role;
  if (role === 'admin') {
    appState.actorId = 'admin-sim';
  }
  if (role !== 'patient') {
    appState.previousHealthSeries = [];
  }

  for (const button of roleButtons) {
    button.classList.toggle('active', button.dataset.role === role);
  }

  Object.entries(viewMap).forEach(([key, node]) => {
    node.classList.toggle('active', key === role);
  });

  populateActorSelector();
  refreshActiveView();
};

const populateActorSelector = () => {
  const select = $('actor-select');
  select.innerHTML = '';

  if (!appState.roleOptions) {
    return;
  }

  if (appState.role === 'admin') {
    const option = document.createElement('option');
    option.value = 'admin-sim';
    option.textContent = 'Simulation Admin';
    select.append(option);
    select.value = 'admin-sim';
    appState.actorId = 'admin-sim';
    return;
  }

  if (appState.role === 'physician') {
    for (const provider of appState.roleOptions.providers) {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = `${provider.name} (${provider.id})`;
      select.append(option);
    }
  }

  if (appState.role === 'patient') {
    for (const patient of appState.roleOptions.patients) {
      const option = document.createElement('option');
      option.value = patient.id;
      option.textContent = `${patient.label} (${patient.id})`;
      select.append(option);
    }
  }

  if (select.options.length > 0) {
    if (!Array.from(select.options).some((opt) => opt.value === appState.actorId)) {
      appState.actorId = select.options[0].value;
    }
    select.value = appState.actorId;
  }
};

const drawLines = (canvas, series, labels) => {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  const pad = { left: 48, right: 24, top: 18, bottom: 28 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  ctx.strokeStyle = '#d7e4e8';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i += 1) {
    const y = pad.top + (plotH / 5) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();

    const val = Math.round(100 - (i * 100) / 5);
    ctx.fillStyle = '#5f7780';
    ctx.font = '11px "Avenir Next"';
    ctx.fillText(`${val}`, 8, y + 3);
  }

  const xStep = labels.length > 1 ? plotW / (labels.length - 1) : plotW;

  series.forEach((line) => {
    ctx.beginPath();
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 2;

    line.values.forEach((value, index) => {
      const x = pad.left + xStep * index;
      const y = pad.top + plotH - (Math.max(0, Math.min(100, value)) / 100) * plotH;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();
  });

  ctx.fillStyle = '#5f7780';
  ctx.font = '11px "Avenir Next"';
  labels.forEach((label, index) => {
    const x = pad.left + xStep * index;
    if (index % 2 === 0 || labels.length < 8) {
      ctx.fillText(label.slice(5, 10), x - 12, height - 8);
    }
  });
};

const drawSmoothHealthTrend = (canvas, values, labels) => {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const pad = { left: 44, right: 16, top: 20, bottom: 30 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xStep = values.length > 1 ? plotW / (values.length - 1) : plotW;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const from = appState.previousHealthSeries.length === values.length
    ? appState.previousHealthSeries
    : values.map(() => values[0] ?? 0);

  const drawFrame = (frameValues) => {
    ctx.clearRect(0, 0, width, height);
    const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
    gradient.addColorStop(0, 'rgba(31, 143, 104, 0.18)');
    gradient.addColorStop(1, 'rgba(31, 143, 104, 0.01)');

    ctx.strokeStyle = '#dcebe4';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const y = pad.top + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();
    }

    const points = frameValues.map((value, idx) => ({
      x: pad.left + xStep * idx,
      y: pad.top + plotH - (Math.max(0, Math.min(100, value)) / 100) * plotH
    }));

    ctx.beginPath();
    points.forEach((point, idx) => {
      if (idx === 0) {
        ctx.moveTo(point.x, point.y);
        return;
      }
      const prev = points[idx - 1];
      const cx = (prev.x + point.x) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, cx, (prev.y + point.y) / 2);
    });
    const last = points[points.length - 1];
    if (last) {
      ctx.lineTo(last.x, last.y);
      ctx.lineTo(last.x, height - pad.bottom);
      ctx.lineTo(points[0].x, height - pad.bottom);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    ctx.beginPath();
    points.forEach((point, idx) => {
      if (idx === 0) {
        ctx.moveTo(point.x, point.y);
        return;
      }
      const prev = points[idx - 1];
      const cx = (prev.x + point.x) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, cx, (prev.y + point.y) / 2);
    });
    if (last) ctx.lineTo(last.x, last.y);
    ctx.strokeStyle = '#1f8f68';
    ctx.lineWidth = 3;
    ctx.stroke();

    if (last) {
      ctx.beginPath();
      ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#1f8f68';
      ctx.fill();
    }

    ctx.fillStyle = '#5f7780';
    ctx.font = '11px "Avenir Next"';
    labels.forEach((label, idx) => {
      if (idx % 2 !== 0 && labels.length > 6) return;
      const x = pad.left + xStep * idx;
      ctx.fillText(label.slice(5, 7) + '/' + label.slice(8, 10), x - 12, height - 9);
    });
  };

  if (reducedMotion) {
    drawFrame(values);
    appState.previousHealthSeries = values.slice();
    return;
  }

  const startAt = performance.now();
  const duration = 420;
  const tick = (now) => {
    const t = Math.min(1, (now - startAt) / duration);
    const eased = 1 - (1 - t) ** 3;
    const frameValues = values.map((value, idx) => from[idx] + (value - from[idx]) * eased);
    drawFrame(frameValues);
    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      appState.previousHealthSeries = values.slice();
    }
  };
  requestAnimationFrame(tick);
};

const drawFinanceChart = (canvas, config) => {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const pad = { left: 58, right: 20, top: 20, bottom: 30 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const labels = config.labels;
  const xStep = labels.length > 1 ? plotW / (labels.length - 1) : plotW;

  let minY = config.minY;
  let maxY = config.maxY;
  if (config.scaleMode === 'locked') {
    minY = appState.finance.lockedRange.min;
    maxY = appState.finance.lockedRange.max;
  }
  if (maxY <= minY) {
    maxY = minY + 1;
  }

  const yFor = (value) => pad.top + plotH - ((value - minY) / (maxY - minY)) * plotH;
  const xForIdx = (idx) => pad.left + xStep * idx;

  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = '#d7e4e8';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i += 1) {
    const y = pad.top + (plotH / 5) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    const val = maxY - ((maxY - minY) * i) / 5;
    ctx.fillStyle = '#5f7780';
    ctx.font = '11px "Avenir Next"';
    const yLabel = config.yFormatter ? config.yFormatter(val) : formatMoneyShort(val);
    ctx.fillText(yLabel, 4, y + 4);
  }

  config.series.forEach((line) => {
    ctx.beginPath();
    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.width || 2;
    line.values.forEach((value, idx) => {
      const x = xForIdx(idx);
      const y = yFor(value);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  config.markers.forEach((marker) => {
    const idx = labels.indexOf(marker.month);
    if (idx < 0) return;
    const x = xForIdx(idx);
    ctx.strokeStyle = 'rgba(189, 69, 47, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, height - pad.bottom);
    ctx.stroke();
    ctx.fillStyle = '#be3f2d';
    ctx.font = '10px "Avenir Next"';
    ctx.fillText('Catastrophic event', x + 3, pad.top + 11);
  });

  ctx.fillStyle = '#5f7780';
  ctx.font = '11px "Avenir Next"';
  labels.forEach((label, idx) => {
    if (idx % 2 !== 0 && labels.length > 12) return;
    const x = xForIdx(idx);
    ctx.fillText(label.slice(5, 7) + '/' + label.slice(2, 4), x - 12, height - 8);
  });

  const pointer = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const idx = Math.max(0, Math.min(labels.length - 1, Math.round((x - pad.left) / xStep)));
    if (!Number.isFinite(idx)) return;
    const month = labels[idx];
    const values = config.series.map((line) => `${line.label}: ${formatMoneyExact(line.values[idx] || 0)}`).join(' · ');
    $('finance-pinned-tooltip').textContent = `${month}: ${values}`;
    if (appState.finance.exactData && event.type === 'click') {
      appState.finance.pinnedMonth = month;
    }
  };

  canvas.onmousemove = config.exactMode ? pointer : null;
  canvas.onclick = config.exactMode ? pointer : null;
};

const drawBankChart = (canvas, labels, bankSeries, exactMode) => {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const pad = { left: 58, right: 20, top: 18, bottom: 30 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xStep = labels.length > 1 ? plotW / (labels.length - 1) : plotW;
  const bankValues = bankSeries.map((row) => row.bank_value);
  const minY = Math.min(...bankValues) * 0.95;
  const maxY = Math.max(...bankValues) * 1.05;
  const yFor = (v) => pad.top + plotH - ((v - minY) / Math.max(1, maxY - minY)) * plotH;

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#d7e4e8';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    const val = maxY - ((maxY - minY) * i) / 4;
    ctx.fillStyle = '#5f7780';
    ctx.font = '11px "Avenir Next"';
    ctx.fillText(formatMoneyShort(val), 4, y + 3);
  }

  // Bars for avoided saved dollars by month.
  const maxAvoided = Math.max(1, ...bankSeries.map((row) => row.avoided_saved));
  bankSeries.forEach((row, idx) => {
    const x = pad.left + xStep * idx;
    const barH = (row.avoided_saved / maxAvoided) * 40;
    ctx.fillStyle = 'rgba(31, 143, 104, 0.22)';
    ctx.fillRect(x - 6, height - pad.bottom - barH, 12, barH);
  });

  ctx.beginPath();
  ctx.strokeStyle = '#003a70';
  ctx.lineWidth = 2.8;
  bankSeries.forEach((row, idx) => {
    const x = pad.left + xStep * idx;
    const y = yFor(row.bank_value);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = '#5f7780';
  ctx.font = '11px "Avenir Next"';
  labels.forEach((label, idx) => {
    if (idx % 2 !== 0 && labels.length > 12) return;
    const x = pad.left + xStep * idx;
    ctx.fillText(label.slice(5, 7) + '/' + label.slice(2, 4), x - 12, height - 8);
  });

  if (exactMode) {
    canvas.onmousemove = (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const idx = Math.max(0, Math.min(labels.length - 1, Math.round((x - pad.left) / xStep)));
      const row = bankSeries[idx];
      if (!row) return;
      $('finance-pinned-tooltip').textContent =
        `${row.month}: bank ${formatMoneyExact(row.bank_value)} · avoided saved ${formatMoneyExact(row.avoided_saved)} · spend delta ${formatMoneyExact(row.spend_delta_vs_baseline)}`;
    };
  } else {
    canvas.onmousemove = null;
  }
};

const renderFinance = async () => {
  $('finance-model').value = appState.finance.model;
  $('finance-compare-model').value = appState.finance.compareModel;
  $('finance-baseline-model').value = appState.finance.baselineModel;
  $('finance-window-months').value = String(appState.finance.windowMonths);
  $('finance-scale-mode').value = appState.finance.scaleMode;
  $('intervention-toggle').checked = appState.finance.interventionEnabled;
  $('intervention-strength').value = appState.finance.interventionStrength;
  $('exact-data-toggle').checked = appState.finance.exactData;

  const payload = await apiFetch(
    `/finance/dashboard?model=${encodeURIComponent(appState.finance.model)}&compareModel=${encodeURIComponent(
      appState.finance.compareModel
    )}&baselineModel=${encodeURIComponent(appState.finance.baselineModel)}&windowMonths=${encodeURIComponent(
      appState.finance.windowMonths
    )}`
  );

  $('finance-at-glance').innerHTML = [
    ['Total Spend (Employer)', payload.atGlance.totalSpendEmployer, payload.atGlance.deltaVsBaseline],
    ['Total Spend (All in)', payload.atGlance.totalSpendAllIn, null],
    ['Employee Out of Pocket', payload.atGlance.employeeOutOfPocket, null],
    ['Net Save vs Baseline', payload.atGlance.netSaveVsBaseline, payload.atGlance.netSaveVsBaseline],
    ['PMPM Spend', payload.atGlance.pmpmSpend, null],
    ['Volatility (Std Dev)', payload.atGlance.volatilityMonthlyStdDev, null]
  ]
    .map(([label, value, delta]) => {
      const badge = delta === null
        ? ''
        : `<div class="money-badge ${delta >= 0 ? 'good' : 'bad'}">${delta >= 0 ? '+' : '-'}${formatMoneyShort(
            Math.abs(delta)
          )} vs ${payload.meta.baselineModel}</div>`;
      return `<div class="kpi"><div class="muted">${label}</div><div class="value">${withExactTitle(
        formatMoneyShort(value),
        value
      )}</div>${badge}</div>`;
    })
    .join('');

  const labels = payload.monthly.selected.map((row) => row.month);
  $('risk-intensity').value = payload.meta.riskIntensity;
  const selectedMonthly = payload.monthly.selected.map((row) => row.employer_spend);
  const baselineMonthly = payload.monthly.baseline.map((row) => row.employer_spend);
  const compareMonthly = payload.monthly.compare.map((row) => row.employer_spend);
  const interventionSeries = (() => {
    const out = selectedMonthly.slice();
    if (!appState.finance.interventionEnabled || out.length < 4) return out;
    const slope = out[out.length - 1] - out[Math.max(0, out.length - 4)];
    if (slope <= 0) return out;
    const reduction = appState.finance.interventionStrength === 'aggressive'
      ? 0.22
      : appState.finance.interventionStrength === 'light'
        ? 0.1
        : 0.16;
    const startIdx = Math.max(1, out.length - 6);
    for (let i = startIdx; i < out.length; i += 1) {
      const progress = (i - startIdx + 1) / (out.length - startIdx + 1);
      out[i] = out[i] * (1 - reduction * progress);
    }
    return out;
  })();
  const cum = (arr) => arr.reduce((acc, v) => [...acc, (acc[acc.length - 1] || 0) + v], []);
  const selectedCum = cum(selectedMonthly);
  const baselineCum = cum(baselineMonthly);
  const compareCum = cum(compareMonthly);
  const interventionCum = cum(interventionSeries);

  const monthlyAllValues = [...selectedMonthly, ...baselineMonthly, ...compareMonthly, ...interventionSeries];
  const cumAllValues = [...selectedCum, ...baselineCum, ...compareCum, ...interventionCum];
  const sharedMonthlyMin = Math.min(...monthlyAllValues) * 0.95;
  const sharedMonthlyMax = Math.max(...monthlyAllValues) * 1.05;
  const sharedCumMin = Math.min(...cumAllValues) * 0.98;
  const sharedCumMax = Math.max(...cumAllValues) * 1.02;

  drawFinanceChart($('finance-cumulative-chart'), {
    labels,
    minY: sharedCumMin,
    maxY: sharedCumMax,
    scaleMode: 'shared',
    exactMode: appState.finance.exactData,
    yFormatter: formatMoneyShort,
    markers: payload.monthly.catastrophicMarkers,
    series: [
      { label: 'Selected', color: '#1f8f68', width: 3, values: selectedCum },
      { label: 'Baseline', color: '#7e8f96', width: 2, values: baselineCum },
      { label: 'Compare', color: '#be3f2d', width: 2, values: compareCum },
      ...(appState.finance.interventionEnabled ? [{ label: 'Intervention path', color: '#0b6aa8', width: 2, values: interventionCum }] : [])
    ]
  });

  const monthlyMin = appState.finance.scaleMode === 'series'
    ? Math.min(...selectedMonthly) * 0.95
    : sharedMonthlyMin;
  const monthlyMax = appState.finance.scaleMode === 'series'
    ? Math.max(...selectedMonthly) * 1.05
    : sharedMonthlyMax;

  drawFinanceChart($('finance-monthly-chart'), {
    labels,
    minY: monthlyMin,
    maxY: monthlyMax,
    scaleMode: appState.finance.scaleMode,
    exactMode: appState.finance.exactData,
    yFormatter: formatMoneyShort,
    markers: payload.monthly.catastrophicMarkers,
    series: [
      { label: 'Selected monthly', color: '#1f8f68', width: 3, values: selectedMonthly },
      { label: 'Baseline monthly', color: '#7e8f96', width: 2, values: baselineMonthly },
      { label: 'Compare monthly', color: '#be3f2d', width: 2, values: compareMonthly },
      ...(appState.finance.interventionEnabled ? [{ label: 'Intervention monthly', color: '#0b6aa8', width: 2, values: interventionSeries }] : [])
    ]
  });

  drawBankChart(
    $('finance-bank-chart'),
    labels,
    payload.monthly.bankSeries,
    appState.finance.exactData
  );

  $('finance-legend').innerHTML = `
    <span class="legend-item"><span class="legend-swatch" style="background:#1f8f68;"></span>Selected cumulative spend</span>
    <span class="legend-item"><span class="legend-swatch" style="background:#7e8f96;"></span>Baseline cumulative spend</span>
    <span class="legend-item"><span class="legend-swatch" style="background:#be3f2d;"></span>Compare cumulative spend</span>
    ${appState.finance.interventionEnabled ? '<span class="legend-item"><span class="legend-swatch" style="background:#0b6aa8;"></span>Early intervention projection</span>' : ''}
  `;
  $('finance-monthly-legend').innerHTML = `
    <span class="legend-item"><span class="legend-swatch" style="background:#1f8f68;"></span>Selected monthly spend</span>
    <span class="legend-item"><span class="legend-swatch" style="background:#7e8f96;"></span>Baseline monthly spend</span>
    <span class="legend-item"><span class="legend-swatch" style="background:#be3f2d;"></span>Compare monthly spend</span>
    ${appState.finance.interventionEnabled ? '<span class="legend-item"><span class="legend-swatch" style="background:#0b6aa8;"></span>Intervention monthly path</span>' : ''}
  `;
  $('finance-bank-legend').innerHTML = `
    <span class="legend-item"><span class="legend-swatch" style="background:#003a70;"></span>Bank value (stability reserve)</span>
    <span class="legend-item"><span class="legend-swatch" style="background:rgba(31,143,104,0.45);"></span>Avoided events saved dollars</span>
  `;

  const tbody = $('finance-exact-table').querySelector('tbody');
  tbody.innerHTML = payload.monthly.selected
    .map((row) => {
      const cls = row.month === appState.finance.pinnedMonth ? ' style="background:#f4fbf8;"' : '';
      return `<tr${cls}>
        <td>${row.month.slice(0, 7)}</td>
        <td>${formatMoneyExact(row.employer_spend)}</td>
        <td>${formatMoneyExact(row.all_in_spend)}</td>
        <td>${formatMoneyExact(row.employee_oop)}</td>
        <td>${formatMoneyExact(row.paid_claims)}</td>
        <td>${formatMoneyExact(row.admin_margin)}</td>
        <td>${formatMoneyExact(row.stop_loss_premium)}</td>
        <td>${formatMoneyExact(row.stop_loss_reimbursed)}</td>
        <td>${formatMoneyExact(row.dpc_fees)}</td>
      </tr>`;
    })
    .join('');
  $('finance-exact-table-wrap').style.display = appState.finance.exactData ? 'block' : 'none';
};

const refreshClockCard = async () => {
  const { simulation } = await apiFetch('/simulation/state', { role: 'admin', actorId: 'admin-sim' });
  $('sim-time').textContent = formatDateTime(simulation.clock_time);
  $('sim-status').textContent = simulation.clock_status;
  $('sim-speed').textContent = `${simulation.speed_days_per_second.toFixed(2)} d/s`;
  $('speed-slider').value = simulation.speed_days_per_second;
  $('speed-value').textContent = simulation.speed_days_per_second.toFixed(2);

  const jumpDate = $('jump-date');
  jumpDate.min = simulation.start_time.slice(0, 10);
  jumpDate.max = simulation.end_time.slice(0, 10);
};

const renderAdmin = async () => {
  await renderFinance();

  const [dashboard, tasksPayload] = await Promise.all([
    apiFetch(`/admin/dashboard?filter=${encodeURIComponent(appState.adminFilter)}`),
    apiFetch('/admin/tasks')
  ]);

  const summary = dashboard.summary;
  const kpis = [
    ['Stability Index', summary.stabilityIndex.toFixed(1)],
    ['Average CDI', summary.averageCdi.toFixed(1)],
    ['Delta vs Prior Week', summary.deltaFromPriorWeek.toFixed(1)],
    ['Green', summary.counts.GREEN],
    ['Yellow', summary.counts.YELLOW],
    ['Red Candidate', summary.counts.RED_CANDIDATE],
    ['Red', summary.counts.RED]
  ];

  $('admin-kpis').innerHTML = kpis
    .map(
      ([label, value]) =>
        `<div class="kpi"><div class="muted">${label}</div><div class="value">${value}</div></div>`
    )
    .join('');

  const workload = dashboard.workload;
  $('admin-workload').innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="muted">Due</div><div class="value">${workload.due}</div></div>
      <div class="kpi"><div class="muted">Overdue</div><div class="value">${workload.overdue}</div></div>
      <div class="kpi"><div class="muted">Completed</div><div class="value">${workload.completed}</div></div>
    </div>
  `;

  $('admin-acceptance').innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="muted">Yellow >= once (2 months)</div><div class="value">${dashboard.acceptance.yellowOrHigherPctInFirstTwoMonths}%</div></div>
      <div class="kpi"><div class="muted">Red Candidate >= once (2 months)</div><div class="value">${dashboard.acceptance.redCandidatePctInFirstTwoMonths}%</div></div>
      <div class="kpi"><div class="muted">Yellow -> Green returns</div><div class="value">${dashboard.acceptance.yellowReturnedToGreenCount}</div></div>
    </div>
  `;

  const driverList = $('driver-list');
  driverList.innerHTML = dashboard.drivers
    .map((driver) => `<li><strong>${driver.signal}</strong> (${driver.count})</li>`)
    .join('');

  const tasks = tasksPayload.tasks.slice(0, 25);
  $('task-list').innerHTML = tasks
    .map((task) => {
      const reviewButton =
        task.task_type === 'red_review' && task.status !== 'completed'
          ? `<button data-review-task="${task.id}" data-decision="confirm_red">Confirm Red</button>
             <button data-review-task="${task.id}" data-decision="downgrade_yellow">Downgrade to Yellow</button>`
          : '';

      return `
        <div class="kpi" style="margin-bottom:0.4rem;">
          <div><strong>${task.task_type}</strong> (${task.status})</div>
          <div class="muted">${task.patient_id} · due ${new Date(task.due_at).toLocaleString()}</div>
          <div style="display:flex; gap:0.4rem; margin-top:0.4rem; flex-wrap:wrap;">${reviewButton}</div>
        </div>
      `;
    })
    .join('');

  $('task-list').querySelectorAll('button[data-review-task]').forEach((button) => {
    button.addEventListener('click', async () => {
      const taskId = button.getAttribute('data-review-task');
      const decision = button.getAttribute('data-decision');
      if (!taskId || !decision) return;
      try {
        await apiFetch(`/admin/tasks/${taskId}/review`, {
          method: 'POST',
          body: { decision }
        });
        await refreshActiveView();
      } catch (error) {
        alert(error.message);
      }
    });
  });

  const labels = dashboard.trends.map((entry) => entry.week_start.slice(0, 10));
  const avgCdi = dashboard.trends.map((entry) => entry.average_cdi);
  const burden = dashboard.trends.map((entry) => {
    const total = entry.green + entry.yellow + entry.red + entry.red_candidate;
    if (!total) return 0;
    return ((entry.yellow + entry.red + entry.red_candidate) / total) * 100;
  });

  drawFinanceChart($('admin-trend'), {
    labels,
    minY: 0,
    maxY: 100,
    scaleMode: 'shared',
    exactMode: false,
    yFormatter: (v) => `${Math.round(v)}`,
    markers: [],
    series: [
      { label: 'Average CDI (0-100)', color: '#118a9a', width: 3, values: avgCdi },
      { label: 'Population burden %', color: '#f57f17', width: 2, values: burden }
    ]
  });
  $('population-legend').innerHTML = `
    <span class="legend-item"><span class="legend-swatch" style="background:#118a9a;"></span>Average CDI (0-100)</span>
    <span class="legend-item"><span class="legend-swatch" style="background:#f57f17;"></span>Population burden %</span>
  `;
};

const renderPhysician = async () => {
  const payload = await apiFetch('/physician/panel');
  const tbody = $('physician-table').querySelector('tbody');
  tbody.innerHTML = '';

  payload.panel.forEach((item) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item.name}</td>
      <td><span class="status-pill ${statusClass(item.status)}">${item.status}</span></td>
      <td>${item.cdi.toFixed(1)}</td>
      <td>${item.velocity >= 0 ? '+' : ''}${item.velocity.toFixed(1)}</td>
      <td>${item.topDrivers.map((d) => d.signal).join(', ') || 'steady'}</td>
      <td>
        <button data-note-patient="${item.patient_id}">Note Stub</button>
      </td>
    `;

    row.addEventListener('click', async (event) => {
      if (event.target.closest('button')) {
        return;
      }
      appState.selectedPhysicianPatient = item.patient_id;
      await loadExplainability(item.patient_id);
    });

    tbody.appendChild(row);
  });

  tbody.querySelectorAll('button[data-note-patient]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const patientId = button.getAttribute('data-note-patient');
      if (!patientId) return;
      try {
        await apiFetch(`/physician/patient/${patientId}/note-stub`, { method: 'POST' });
        alert('Outreach note stub created.');
      } catch (error) {
        alert(error.message);
      }
    });
  });

  $('physician-stats').innerHTML = `
    <div class="kpi"><div class="muted">Panel Size</div><div class="value">${payload.panel.length}</div></div>
    <div class="kpi"><div class="muted">New Yellow</div><div class="value">${payload.newlyYellowThisWeek.length}</div></div>
    <div class="kpi"><div class="muted">Red Candidate Queue</div><div class="value">${payload.redCandidatesAwaitingReview.length}</div></div>
  `;

  $('new-yellow').innerHTML = payload.newlyYellowThisWeek
    .map((entry) => `<li>${entry.name} · CDI ${entry.cdi.toFixed(1)}</li>`)
    .join('');

  $('red-await').innerHTML = payload.redCandidatesAwaitingReview
    .map((entry) => `<li>${entry.name} · CDI ${entry.cdi.toFixed(1)} · Task ${entry.task_id.slice(0, 8)}</li>`)
    .join('');

  if (!appState.selectedPhysicianPatient && payload.panel.length > 0) {
    appState.selectedPhysicianPatient = payload.panel[0].patient_id;
  }

  if (appState.selectedPhysicianPatient) {
    await loadExplainability(appState.selectedPhysicianPatient);
  }
};

const loadExplainability = async (patientId) => {
  try {
    const payload = await apiFetch(`/physician/patient/${patientId}/explainability`);
    const container = $('explainability');

    container.innerHTML = payload.history
      .map((week) => {
        const signals = week.signals
          .slice(0, 4)
          .map((signal) => `<li>${signal.signal}: +${signal.points} (${signal.explanation})</li>`)
          .join('');

        return `
          <div class="kpi" style="margin-bottom:0.5rem;">
            <div><strong>${week.week_start.slice(0, 10)}</strong> · CDI ${week.cdi_total.toFixed(1)} · ${week.status}</div>
            <ul>${signals || '<li>No active drivers this week.</li>'}</ul>
          </div>
        `;
      })
      .join('');
  } catch (error) {
    $('explainability').innerHTML = `<p class="muted">${error.message}</p>`;
  }
};

const renderPatient = async () => {
  const payload = await apiFetch('/patient/me');
  $('patient-name').textContent = payload.patient.name;

  const status = payload.current.status;
  const pill = $('patient-status');
  const slope = payload.health.hero.slope3Months;
  const tone = slope >= 1.5 ? 'status-GREEN' : slope <= -1.5 ? 'status-RED' : 'status-NEUTRAL';
  pill.className = `status-pill ${tone}`;
  pill.textContent = `${slope >= 1.5 ? 'Improving' : slope <= -1.5 ? 'Needs support' : 'Stable'} · ${payload.current.cdi.toFixed(1)}`;

  $('patient-hero-message').textContent = payload.health.hero.statusMessage;
  $('patient-encouragement').textContent = payload.health.hero.encouragement;
  $('patient-review-note').textContent = payload.current.inReview
    ? 'Your care team is actively reviewing your trend now.'
    : '';

  $('patient-disclaimer').textContent = payload.health.disclaimer;

  const months = payload.health.monthly;
  drawSmoothHealthTrend(
    $('patient-health-trend'),
    months.map((entry) => entry.health_score),
    months.map((entry) => entry.month_start.slice(0, 10))
  );

  const setRing = (id, valueId, value, delta) => {
    const node = $(id);
    node.style.setProperty('--value', String(Math.max(0, Math.min(100, value))));
    $(valueId).textContent = `${value.toFixed(0)}`;
    node.classList.remove('improved');
    if (delta > 0.2) {
      node.classList.add('improved');
      setTimeout(() => node.classList.remove('improved'), 1100);
    }
  };

  setRing('ring-access', 'ring-access-value', payload.health.rings.access.value, payload.health.rings.access.delta);
  setRing(
    'ring-prevention',
    'ring-prevention-value',
    payload.health.rings.prevention.value,
    payload.health.rings.prevention.delta
  );
  setRing(
    'ring-stability',
    'ring-stability-value',
    payload.health.rings.stability.value,
    payload.health.rings.stability.delta
  );

  $('patient-events-feed').innerHTML = payload.health.events
    .map(
      (event, idx) => `
      <li class="event-${event.kind}" style="animation-delay:${idx * 45}ms">
        <strong>${event.title}</strong>
        <div class="muted">${event.detail}</div>
        <div class="muted">${new Date(event.happened_at).toLocaleDateString()}</div>
      </li>
    `
    )
    .join('');

  $('patient-what-changed').innerHTML = payload.health.whatChanged
    .map(
      (item) => `
      <div class="kpi">
        <div class="muted">${item.label}</div>
        <div class="delta ${item.direction}">
          ${item.direction === 'down' ? '' : '+'}${item.delta.toFixed(1)}
        </div>
      </div>
    `
    )
    .join('');

  $('patient-rn-recommendations').innerHTML = (payload.health.careManagerRecommendations || [])
    .map(
      (rec) => `
      <div class="kpi" style="margin-bottom:0.5rem;">
        <div><strong>${rec.title}</strong> <span class="money-badge ${rec.priority === 'high' ? 'bad' : 'good'}">${rec.priority}</span></div>
        <div class="muted">${rec.whyNow}</div>
        <div class="muted" style="font-size:0.78rem; margin-top:0.2rem;">${rec.evidenceBasis}</div>
        <ul style="margin-top:0.3rem;">
          ${rec.rnNextSteps.map((step) => `<li>${step}</li>`).join('')}
        </ul>
      </div>
    `
    )
    .join('') || '<p class="muted">No threshold-triggered RN actions this month.</p>';

  const pref = payload.health.preferences || {
    care_model: 'traditional',
    funding_model: 'fully_funded',
    primary_care_engagement: 'medium',
    lifestyle_adherence: 'medium',
    care_navigation_support: false,
    friction_adjustment: 0,
    action_same_day_visit: false,
    action_coaching_program: false,
    action_medication_reminders: true,
    action_preventive_outreach: true
  };

  $('patient-actions-panel').innerHTML = `
    <div class="actions-grid">
      <div class="action-row">
        <span>Care model</span>
        <select data-pref="care_model">
          <option value="traditional" ${pref.care_model === 'traditional' ? 'selected' : ''}>Traditional</option>
          <option value="dpc" ${pref.care_model === 'dpc' ? 'selected' : ''}>DPC</option>
        </select>
      </div>
      <div class="action-row">
        <span>Funding model</span>
        <select data-pref="funding_model">
          <option value="fully_funded" ${pref.funding_model === 'fully_funded' ? 'selected' : ''}>Fully funded</option>
          <option value="self_funded" ${pref.funding_model === 'self_funded' ? 'selected' : ''}>Self funded</option>
        </select>
      </div>
      <div class="action-row">
        <span>Primary care engagement</span>
        <select data-pref="primary_care_engagement">
          <option value="low" ${pref.primary_care_engagement === 'low' ? 'selected' : ''}>Low</option>
          <option value="medium" ${pref.primary_care_engagement === 'medium' ? 'selected' : ''}>Medium</option>
          <option value="high" ${pref.primary_care_engagement === 'high' ? 'selected' : ''}>High</option>
        </select>
      </div>
      <div class="action-row">
        <span>Lifestyle adherence</span>
        <select data-pref="lifestyle_adherence">
          <option value="low" ${pref.lifestyle_adherence === 'low' ? 'selected' : ''}>Low</option>
          <option value="medium" ${pref.lifestyle_adherence === 'medium' ? 'selected' : ''}>Medium</option>
          <option value="high" ${pref.lifestyle_adherence === 'high' ? 'selected' : ''}>High</option>
        </select>
      </div>
      <div class="action-row">
        <span>Care navigation support</span>
        <input type="checkbox" data-pref="care_navigation_support" ${pref.care_navigation_support ? 'checked' : ''} />
      </div>
      <div class="action-row">
        <span>Schedule same-day visit</span>
        <input type="checkbox" data-pref="action_same_day_visit" ${pref.action_same_day_visit ? 'checked' : ''} />
      </div>
      <div class="action-row">
        <span>Join a coaching program</span>
        <input type="checkbox" data-pref="action_coaching_program" ${pref.action_coaching_program ? 'checked' : ''} />
      </div>
      <div class="action-row">
        <span>Medication reminders on</span>
        <input type="checkbox" data-pref="action_medication_reminders" ${pref.action_medication_reminders ? 'checked' : ''} />
      </div>
      <div class="action-row">
        <span>Preventive outreach on</span>
        <input type="checkbox" data-pref="action_preventive_outreach" ${pref.action_preventive_outreach ? 'checked' : ''} />
      </div>
      <div class="action-row">
        <span>Friction level</span>
        <input
          type="range"
          min="-35"
          max="35"
          step="1"
          value="${pref.friction_adjustment}"
          data-pref="friction_adjustment"
        />
      </div>
    </div>
  `;

  const applyPreferencePatch = async (patch) => {
    const response = await apiFetch('/patient/me/preferences', {
      method: 'POST',
      body: patch
    });
    if (response?.view) {
      await renderPatient();
    }
  };

  $('patient-actions-panel').querySelectorAll('[data-pref]').forEach((node) => {
    const key = node.getAttribute('data-pref');
    if (!key) return;
    node.addEventListener('change', async () => {
      if (node.type === 'checkbox') {
        await applyPreferencePatch({ [key]: node.checked });
        return;
      }
      if (node.type === 'range') {
        await applyPreferencePatch({ [key]: Number(node.value) });
        return;
      }
      await applyPreferencePatch({ [key]: node.value });
    });
  });

  $('patient-costs-drawer').innerHTML = `
    <div class="kpi-grid">
      <div class="kpi">
        <div class="muted">Out of pocket strain index</div>
        <div class="value">${months.length ? months[months.length - 1].out_of_pocket_strain_index.toFixed(1) : '-'}</div>
      </div>
      <div class="kpi">
        <div class="muted">Monthly claims trend</div>
        <div class="value">${payload.health.healthToSpend.claimsTrendDelta.toFixed(2)}</div>
      </div>
      <div class="kpi">
        <div class="muted">Avoidable events delta</div>
        <div class="value">${payload.health.healthToSpend.avoidableEventsDelta.toFixed(1)}</div>
      </div>
      <div class="kpi">
        <div class="muted">Estimated avoidable spend shift</div>
        <div class="value">$${payload.health.healthToSpend.estimatedAvoidableCostDelta.toFixed(0)}</div>
      </div>
    </div>
  `;

  const overlay = $('health-spend-overlay');
  const overlayToggle = $('health-spend-toggle');
  overlayToggle.checked = appState.patientHealthOverlay;
  overlayToggle.onchange = () => {
    appState.patientHealthOverlay = overlayToggle.checked;
    overlay.classList.toggle('active', appState.patientHealthOverlay);
  };
  overlay.innerHTML = `
    <div class="overlay-rail">
      <div class="overlay-node">Better access + prevention habits</div>
      <div class="overlay-arrow">↓</div>
      <div class="overlay-node">Fewer avoidable events</div>
      <div class="overlay-arrow">↓</div>
      <div class="overlay-node">Lower disruption and downstream claims</div>
    </div>
  `;
  overlay.classList.toggle('active', appState.patientHealthOverlay);
};

const refreshActiveView = async () => {
  await refreshClockCard();

  if (appState.role === 'admin') {
    await renderAdmin();
  }

  if (appState.role === 'physician') {
    await renderPhysician();
  }

  if (appState.role === 'patient') {
    await renderPatient();
  }
};

const initControls = () => {
  roleButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setRole(button.dataset.role);
    });
  });

  $('actor-select').addEventListener('change', async (event) => {
    appState.actorId = event.target.value;
    appState.selectedPhysicianPatient = null;
    appState.previousHealthSeries = [];
    await refreshActiveView();
  });

  document.querySelectorAll('.filter-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      document.querySelectorAll('.filter-btn').forEach((node) => node.classList.remove('active'));
      button.classList.add('active');
      appState.adminFilter = button.dataset.filter;
      await renderAdmin();
    });
  });

  $('btn-start').addEventListener('click', async () => {
    await apiFetch('/simulation/start', { method: 'POST' });
    await refreshActiveView();
  });

  $('btn-pause').addEventListener('click', async () => {
    await apiFetch('/simulation/pause', { method: 'POST' });
    await refreshActiveView();
  });

  $('btn-resume').addEventListener('click', async () => {
    await apiFetch('/simulation/resume', { method: 'POST' });
    await refreshActiveView();
  });

  $('btn-reset').addEventListener('click', async () => {
    const seed = Number(prompt('Reset seed value', '42'));
    await apiFetch('/simulation/reset', {
      method: 'POST',
      body: { seed: Number.isFinite(seed) ? seed : 42 }
    });
    await refreshActiveView();
  });

  $('speed-slider').addEventListener('input', async (event) => {
    const value = Number(event.target.value);
    $('speed-value').textContent = value.toFixed(2);
    await apiFetch('/simulation/speed', {
      method: 'POST',
      body: { daysPerSecond: value }
    });
  });

  $('btn-jump').addEventListener('click', async () => {
    const isoDate = $('jump-date').value;
    if (!isoDate) {
      return;
    }

    await apiFetch('/simulation/jump', {
      method: 'POST',
      body: { isoDate }
    });

    await refreshActiveView();
  });

  $('btn-export').addEventListener('click', async () => {
    const csv = await apiFetch('/simulation/export.csv', { role: 'admin', actorId: 'admin-sim' });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'drift-events.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  $('btn-checkin').addEventListener('click', async () => {
    await apiFetch('/patient/me/request-checkin', {
      method: 'POST',
      body: { createPortalMessage: true }
    });
    alert('Check-in request submitted.');
    await refreshActiveView();
  });

  const refreshFinanceOnly = async () => {
    if (appState.role === 'admin') {
      await renderFinance();
    }
  };

  $('finance-model').addEventListener('change', async (event) => {
    appState.finance.model = event.target.value;
    await refreshFinanceOnly();
  });
  $('finance-compare-model').addEventListener('change', async (event) => {
    appState.finance.compareModel = event.target.value;
    await refreshFinanceOnly();
  });
  $('finance-baseline-model').addEventListener('change', async (event) => {
    appState.finance.baselineModel = event.target.value;
    await refreshFinanceOnly();
  });
  $('finance-window-months').addEventListener('change', async (event) => {
    appState.finance.windowMonths = Number(event.target.value);
    await refreshFinanceOnly();
  });
  $('finance-scale-mode').addEventListener('change', async (event) => {
    appState.finance.scaleMode = event.target.value;
    if (appState.finance.scaleMode === 'locked') {
      const min = Number(prompt('Locked Y min (dollars)', String(appState.finance.lockedRange.min)));
      const max = Number(prompt('Locked Y max (dollars)', String(appState.finance.lockedRange.max)));
      if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
        appState.finance.lockedRange = { min, max };
      }
    }
    await refreshFinanceOnly();
  });
  $('intervention-toggle').addEventListener('change', async (event) => {
    appState.finance.interventionEnabled = event.target.checked;
    await refreshFinanceOnly();
  });
  $('intervention-strength').addEventListener('change', async (event) => {
    appState.finance.interventionStrength = event.target.value;
    await refreshFinanceOnly();
  });
  $('exact-data-toggle').addEventListener('change', async (event) => {
    appState.finance.exactData = event.target.checked;
    await refreshFinanceOnly();
  });
  $('risk-intensity').addEventListener('change', async (event) => {
    await apiFetch('/simulation/risk', {
      method: 'POST',
      body: { riskIntensity: event.target.value }
    });
    await refreshActiveView();
  });
};

const bootstrap = async () => {
  try {
    const meta = await apiFetch('/meta/options', { role: 'admin', actorId: 'admin-sim' });
    appState.roleOptions = meta.roleOptions;
    appState.actorId = 'admin-sim';
    populateActorSelector();
    initControls();
    await refreshActiveView();

    setInterval(async () => {
      try {
        await refreshClockCard();
        if (appState.role === 'admin') {
          await renderFinance();
        } else {
          await refreshActiveView();
        }
      } catch (_error) {
        // best-effort refresh only
      }
    }, 5000);
  } catch (error) {
    alert(error.message);
  }
};

bootstrap();
