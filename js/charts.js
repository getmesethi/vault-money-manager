/* =========================================================
   charts.js — small hand-rolled inline-SVG charts.
   No external chart library needed; keeps the app fully
   self-contained/offline and CSP-simple.
   ========================================================= */
const Charts = (() => {

  function donut(items, opts) {
    opts = opts || {};
    const size = opts.size || 200;
    const stroke = opts.stroke || 26;
    const r = (size - stroke) / 2;
    const cx = size / 2, cy = size / 2;
    const circumference = 2 * Math.PI * r;
    const total = items.reduce((s, i) => s + i.value, 0);
    if (total <= 0) {
      return `<div class="empty-hint">No expenses yet in this period.</div>`;
    }
    let offset = 0;
    const colors = opts.colors || ['#4f5bd5','#d84f4f','#3573d4','#8b5fd1','#d9852f','#1f9d55','#c4477c','#5c7f1c'];
    let arcs = '';
    items.forEach((it, idx) => {
      const frac = it.value / total;
      const len = frac * circumference;
      const color = it.color || colors[idx % colors.length];
      arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
        stroke-dasharray="${len} ${circumference - len}" stroke-dashoffset="${-offset}"
        transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt">
        <animate attributeName="stroke-dasharray" from="0 ${circumference}" to="${len} ${circumference - len}" dur=".7s" fill="freeze"/>
        </circle>`;
      offset += len;
    });
    const svg = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="display:block;margin:0 auto;">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="${stroke}"/>
      ${arcs}
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="13" fill="var(--text-dim)" font-weight="700">TOTAL</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="16" fill="var(--text)" font-weight="800">${opts.centerLabel || ''}</text>
    </svg>`;
    const legend = `<div class="chart-legend">${items.map((it, idx) => {
      const color = it.color || colors[idx % colors.length];
      const pct = total ? Math.round(it.value / total * 100) : 0;
      return `<span><span class="dot" style="background:${color}"></span>${it.label} · ${pct}%</span>`;
    }).join('')}</div>`;
    return svg + legend;
  }

  function barCompare(series, opts) {
    opts = opts || {};
    if (!series.length) return `<div class="empty-hint">Not enough data yet.</div>`;
    const w = opts.width || 320, h = opts.height || 180;
    const padL = 8, padB = 22, padT = 10;
    const max = Math.max(1, ...series.flatMap(s => [s.income, s.expense]));
    const groupW = (w - padL) / series.length;
    const barW = Math.min(18, groupW / 3);
    let bars = '';
    series.forEach((s, i) => {
      const gx = padL + i * groupW + groupW / 2;
      const hIncome = (h - padB - padT) * (s.income / max);
      const hExpense = (h - padB - padT) * (s.expense / max);
      const yIncome = h - padB - hIncome;
      const yExpense = h - padB - hExpense;
      bars += `<rect x="${gx - barW - 2}" y="${yIncome}" width="${barW}" height="${hIncome}" rx="4" fill="var(--green)">
        <animate attributeName="height" from="0" to="${hIncome}" dur=".5s" fill="freeze"/>
        <animate attributeName="y" from="${h - padB}" to="${yIncome}" dur=".5s" fill="freeze"/></rect>`;
      bars += `<rect x="${gx + 2}" y="${yExpense}" width="${barW}" height="${hExpense}" rx="4" fill="var(--red)">
        <animate attributeName="height" from="0" to="${hExpense}" dur=".5s" fill="freeze"/>
        <animate attributeName="y" from="${h - padB}" to="${yExpense}" dur=".5s" fill="freeze"/></rect>`;
      bars += `<text x="${gx}" y="${h - 6}" text-anchor="middle" font-size="10.5" fill="var(--text-faint)">${s.label}</text>`;
    });
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="xMidYMid meet">${bars}</svg>
      <div class="chart-legend"><span><span class="dot" style="background:var(--green)"></span>Income</span><span><span class="dot" style="background:var(--red)"></span>Expense</span></div>`;
  }

  function lineTrend(series, opts) {
    opts = opts || {};
    if (!series.length) return `<div class="empty-hint">Not enough data yet.</div>`;
    const w = opts.width || 320, h = opts.height || 160;
    const padL = 10, padR = 10, padB = 22, padT = 14;
    const max = Math.max(1, ...series.map(s => s.expense));
    const stepX = (w - padL - padR) / Math.max(1, series.length - 1);
    const pts = series.map((s, i) => {
      const x = padL + i * stepX;
      const y = padT + (h - padT - padB) * (1 - s.expense / max);
      return [x, y];
    });
    const path = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const area = path + ` L${pts[pts.length - 1][0]},${h - padB} L${pts[0][0]},${h - padB} Z`;
    const dots = pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="var(--primary)"></circle>`).join('');
    const labels = series.map((s, i) => `<text x="${pts[i][0]}" y="${h - 6}" text-anchor="middle" font-size="10.5" fill="var(--text-faint)">${s.label}</text>`).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="xMidYMid meet">
      <path d="${area}" fill="var(--primary-dim)" opacity=".7"/>
      <path d="${path}" fill="none" stroke="var(--primary)" stroke-width="2.5">
        <animate attributeName="stroke-dasharray" from="0,2000" to="2000,0" dur=".6s" fill="freeze"/>
      </path>
      ${dots}${labels}
    </svg>`;
  }

  return { donut, barCompare, lineTrend };
})();
