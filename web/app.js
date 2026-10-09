import { installUpdates } from '/pwa-update.js';
/* BP Digitizer — local-first PWA.
   Readings live in IndexedDB, OCR runs locally, and encrypted backups are
   exported as files chosen by the user. Nothing is uploaded. */
'use strict';

const BUILD = '__BUILD_VERSION__';

import * as db from './db.js';
import * as bp from './bp.js';
import { TAGS, ZONE_KEY } from './bp.js';
import { exportPdf, exportPdfFile } from './pdf.js';
import { recencyColor, recencyGradient, recencyAt } from './palette.js';
import { t, plural, load as loadLocale, setLocale, locale, LOCALES, fmtDate } from './i18n.js';
import { createBackup, readBackup, backupFilename } from './backup.js';
import { createHearthReader } from './hearth/reader.js';
import { MAX_AUDITS, auditStage, prepareAuditImage, readingValues, readingsDiffer,
         serializableAudits, summarizeAudits } from './ocr-audit.js';
import { icon } from './icons.js';
import { generateInsights } from './insights.js';
import { collapseBursts } from './aggregate.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ZONE_COLOR = {
  NORMAL: 'var(--z-normal)', ELEVATED: 'var(--z-elevated)',
  STAGE_1: 'var(--z-s1)', STAGE_2: 'var(--z-s2)', HYPERTENSIVE_CRISIS: 'var(--z-crisis)',
};
const RISK_KEY = {
  LOW: 'cv_risk_low', MODERATE: 'cv_risk_moderate',
  HIGH: 'cv_risk_high', VERY_HIGH: 'cv_risk_very_high',
};
const RISK_COLOR = {
  LOW: 'var(--z-normal)', MODERATE: 'var(--z-elevated)',
  HIGH: 'var(--z-s2)', VERY_HIGH: 'var(--z-crisis)',
};
const RANGES = [
  { d: 7, key: 'chart_range_7d' }, { d: 30, key: 'chart_range_30d' },
  { d: 90, key: 'chart_range_90d' }, { d: 0, key: 'chart_range_all' },
];

const state = {
  view: 'dashboard', readings: [], profile: {}, rangeDays: 30,
  mode: 'trend', editing: null, entrySource: 'manual', selectedTags: new Set(),
  entryAuditId: null, entryAuditPending: false, ocrAuditEnabled: false,
  entryOcrConfirmationRequired: false, entryOcrConfirmed: false,
};
const OCR_AUDIT_ENABLED = 'ocrAuditEnabled';
let ocrAuditUrls = [];

/* Hiding also releases the FAB column, which is lifted while a toast is up. */
const hideToast = () => {
  $('toast').hidden = true;
  document.documentElement.style.removeProperty('--snack');
};

const toast = (msg, action) => {
  const el = $('toast');
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => { hideToast(); action.action(); });
    el.appendChild(b);
  }
  el.hidden = false;
  // Material lifts the FAB above a snackbar rather than letting it cover one.
  // Measured rather than assumed: the bar is one line or two depending on the
  // message and the locale, and an Undo the user cannot reach is no Undo.
  document.documentElement.style.setProperty('--snack', `${el.offsetHeight + 12}px`);
  clearTimeout(toast._t);
  // An undoable action gets longer to be acted on, as a snackbar would.
  toast._t = setTimeout(hideToast, action ? 6000 : 2600);
};

/* Hold a row to retag it -- the Android bottom sheet, as a sheet. */
function openTagEditor(id) {
  const row = state.readings.find((r) => r.id === id);
  if (!row) return;
  const chosen = new Set(db.normalizeTags(row.tags).split(',').filter(Boolean));
  const sheet = $('sheet');
  const draw = () => {
    sheet.innerHTML = `
      <div class="sheet-card">
        <h3>${esc(t('edit_tags_title'))}</h3>
        <div class="chips wrap">${TAGS.map((k) =>
          `<button class="chip" aria-pressed="${chosen.has(k)}" data-tag="${k}">${
            chosen.has(k) ? icon('check', 18) : ''}${esc(t(k))}</button>`).join('')}</div>
        <button class="btn" id="sheet-save">${esc(t('action_save'))}</button>
      </div>`;
    sheet.querySelectorAll('[data-tag]').forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.tag;
        chosen.has(k) ? chosen.delete(k) : chosen.add(k);
        draw();
      }));
    $('sheet-save').addEventListener('click', async () => {
      await db.updateReading({ ...row, tags: [...chosen].join(',') });
      closeOverlay(dismiss);
      dismiss();
      refresh();
    });
  };
  const dismiss = () => { sheet.hidden = true; sheet.onclick = null; };
  draw();
  sheet.hidden = false;
  sheet.onclick = (e) => { if (e.target === sheet) { closeOverlay(dismiss); dismiss(); } };
  openOverlay(dismiss);
}

/* ------------------------------------------------------------- routing -- */

/* A standalone PWA opens on a single history entry, so the platform Back
   gesture leaves the app rather than backing out of whatever is on screen.
   Every screen and every overlay therefore adds an entry of its own, and
   popstate unwinds them in the order they were opened.

   Dismissers for anything currently covering the app, innermost last. Back
   closes one of these before it touches a screen. */
const overlays = [];
let unwinding = false;

function openOverlay(dismiss) {
  overlays.push(dismiss);
  history.pushState({ bp: 'overlay' }, '');
}

/* Called when an overlay is closed by its own controls, so its history entry
   goes with it -- otherwise Back would have to be pressed once for the entry
   nobody can see and again for the screen behind it. */
function closeOverlay(dismiss) {
  const i = overlays.lastIndexOf(dismiss);
  if (i === -1) return;                 // popstate already unwound it
  overlays.splice(i, 1);
  unwinding = true;
  history.back();
}

/* How many entries we have pushed for screens, so returning to the dashboard
   unwinds all of them in one go rather than assuming a depth of one. */
let viewDepth = 0;

window.addEventListener('popstate', (e) => {
  // Our own history.back() from closeOverlay; the work is already done.
  if (unwinding) { unwinding = false; return; }
  if (overlays.length) { overlays.pop()(); return; }
  const st = e.state;
  const view = st && st.bp === 'view' ? st.view : 'dashboard';
  viewDepth = view === 'dashboard' ? 0 : Math.max(0, viewDepth - 1);
  show(view, { pop: true });
});

function show(view, opts = {}) {
  if (state.view === 'add' && view !== 'add' && state.entryAuditPending) {
    void discardEntryAudit('discarded');
  }
  if (state.view === 'settings' && view !== 'settings') clearOcrAuditUrls();
  if (!opts.pop && view !== state.view) {
    // The dashboard is the entry the app opened on, so it never adds one of
    // its own -- going there means dropping whatever was pushed on top.
    if (view === 'dashboard') {
      if (viewDepth > 0) { const n = viewDepth; viewDepth = 0; history.go(-n); }
    } else {
      history.pushState({ bp: 'view', view }, '');
      viewDepth += 1;
    }
  }
  state.view = view;
  for (const v of ['dashboard', 'add', 'profile', 'settings', 'help']) {
    $(`view-${v}`).hidden = v !== view;
  }
  document.querySelector('.fabs').hidden = view !== 'dashboard';
  document.querySelector('.action-bar').hidden = view !== 'add';
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------ dashboard -- */
async function refresh() {
  state.readings = await db.allReadings();
  state.profile = (await db.getKV('profile')) || {};
  renderInsights();
  renderRisk();
  renderChips();
  drawChart();
  renderHistory();
}

/* ------------------------------------------------------------- insights -- */
/* Mirrors InsightsCard: title, divider, tone-dotted rows, collapsed to three
   with a show-more toggle. */
function renderInsights() {
  const card = $('insights-card');
  const all = generateInsights(state.readings);
  if (!all.length) { card.hidden = true; return; }

  const COLLAPSED = 3;
  const visible = state.insightsOpen ? all : all.slice(0, COLLAPSED);
  const line = (i) => {
    // TAG_HIGHER / TAG_LOWER carry a tag key in args[0]; resolve it to a label.
    const args = i.kind.startsWith('insight_tag') ? [t(i.args[0]), i.args[1]] : i.args;
    return `<div class="ins-row"><span class="ins-dot ${i.tone}"></span>
              <span>${esc(t(i.kind, ...args))}</span></div>`;
  };
  card.hidden = false;
  card.innerHTML = `
    <h3>${esc(t('insights_card_title'))}</h3>
    <hr>
    ${visible.map(line).join('')}
    ${all.length > COLLAPSED ? `<div style="text-align:right">
       <button class="text-btn" id="ins-more">${esc(state.insightsOpen
         ? t('insights_show_less') : t('insights_show_more', all.length - COLLAPSED))}</button>
     </div>` : ''}`;
  const more = $('ins-more');
  if (more) more.addEventListener('click', () => {
    state.insightsOpen = !state.insightsOpen;
    renderInsights();
  });
}

function renderRisk() {
  const card = $('risk-card');
  const latest = state.readings[0];
  if (!latest) { card.hidden = true; return; }
  const a = bp.assess(latest.systolic, latest.diastolic, state.profile);
  const complete = !!state.profile.birthYear;
  card.hidden = false;
  card.innerHTML = `
    <div class="card-head">
      <h3>${esc(t('risk_card_title'))}</h3>
      <button class="text-btn" id="risk-profile">${esc(t(complete
        ? 'risk_card_edit_profile' : 'risk_card_setup_profile'))}</button>
    </div>
    <hr>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span class="badge" style="background:${RISK_COLOR[a.risk]}">${
        esc(t('risk_card_risk_badge', t(RISK_KEY[a.risk])))}</span>
      <span style="font-size:.875rem;color:var(--on-surface-variant)">${
        esc(t(ZONE_KEY[a.category]))}</span>
    </div>
    ${a.bmi != null ? `<p class="muted" style="margin:6px 0 0">${
      esc(t('risk_card_bmi', a.bmi.toFixed(1), t(bmiKey(a.bmiCategory))))}</p>` : ''}
    ${complete ? '' : `<p class="muted" style="margin:8px 0 0;font-style:italic">${
      esc(t('risk_card_incomplete_profile'))}</p>`}`;
  $('risk-profile').addEventListener('click', () => { renderProfile(); show('profile'); });
}

const bmiKey = (c) => ({ UNDERWEIGHT: 'bmi_underweight', NORMAL: 'bmi_normal',
  OVERWEIGHT: 'bmi_overweight', OBESE: 'bmi_obese' }[c] || 'bmi_normal');

function renderChips() {
  const sel = (on) => (on ? icon('check', 18) : '');
  $('range-chips').innerHTML = RANGES.map((r) => {
    const on = r.d === state.rangeDays;
    return `<button class="chip" aria-pressed="${on}" data-d="${r.d}">${sel(on)}${esc(t(r.key))}</button>`;
  }).join('') + `<span class="chip-spacer"></span>
    <button class="chip" aria-pressed="${!!state.smooth}" id="chip-smooth">${
      sel(!!state.smooth)}${esc(t('dashboard_smooth_bursts'))}</button>`;
  $('chip-smooth').addEventListener('click', () => {
    state.smooth = !state.smooth;
    db.setKV('smoothBursts', state.smooth);
    renderChips(); drawChart();
  });
  $('mode-chips').innerHTML = ['trend', 'scatter'].map((m) => {
    const on = m === state.mode;
    return `<button aria-pressed="${on}" data-m="${m}">${sel(on)}${
      esc(t(m === 'trend' ? 'chart_view_trend' : 'chart_view_scatter'))}</button>`;
  }).join('');
  $('range-chips').querySelectorAll('[data-d]').forEach((b) =>
    b.addEventListener('click', () => {
      state.rangeDays = Number(b.dataset.d);
      db.setKV('rangeDays', state.rangeDays);
      renderChips(); drawChart(); renderHistory();
    }));
  $('mode-chips').querySelectorAll('[data-m]').forEach((b) =>
    b.addEventListener('click', () => {
      state.mode = b.dataset.m;
      db.setKV('chartMode', state.mode);
      renderChips(); drawChart();
    }));
}

const inRange = () => {
  if (!state.rangeDays) return state.readings;
  const since = Date.now() - state.rangeDays * 864e5;
  return state.readings.filter((r) => r.timestamp >= since);
};

function renderHistory() {
  const rows = inRange();
  const empty = $('history-empty');
  empty.hidden = rows.length > 0;
  empty.textContent = t('dashboard_empty');

  // Mirrors ReadingRow: timestamp, the reading itself, haemodynamics, then the
  // category badge on the right, with notes and tags underneath.
  $('history').innerHTML = rows.map((r) => {
    const pulse = r.pulse ? t('dashboard_reading_pulse_format', r.pulse) : '';
    const tags = db.normalizeTags(r.tags).split(',').filter(Boolean).map((x) => t(x)).join(' · ');
    // The row slides over this layer, uncovering whichever trash icon is on
    // the side it came from -- SwipeToDismissBox's backgroundContent.
    return `<div class="swipe">
        <div class="swipe-bg" aria-hidden="true">${icon('delete', 22)}${icon('delete', 22)}</div>
        <div class="row" data-id="${r.id}">
        <div class="row-main">
          <div class="row-time">${esc(fmtDate(r.timestamp))}</div>
          <div class="row-bp">${r.systolic}/${r.diastolic}${esc(pulse)}</div>
          <div class="row-hemo">${esc(t('reading_hemodynamics_format',
            bp.meanArterialPressure(r.systolic, r.diastolic),
            bp.pulsePressure(r.systolic, r.diastolic)))}</div>
          ${r.notes ? `<div class="row-notes">${esc(r.notes)}</div>` : ''}
          ${tags ? `<div class="row-tags">${esc(tags)}</div>` : ''}
        </div>
        <span class="badge" style="background:${ZONE_COLOR[r.category]}">${
          esc(t(ZONE_KEY[r.category]))}</span>
        </div>
      </div>`;
  }).join('');

  $('history').querySelectorAll('.row').forEach(attachRowGestures);
}

/* Swipe a row aside to delete, hold it to edit its tags -- the two gestures
   SwipeToDismissBox and detectTapGestures give the Android list. */
/* 56px is the positionalThreshold the Android SwipeToDismissBox uses. */
const SWIPE_THRESHOLD = 56;

function attachRowGestures(el) {
  const id = Number(el.dataset.id);
  const wrap = el.parentElement;
  let startX = 0, dx = 0, dragging = false, held = false, timer = null, pointer = null;

  const reset = () => {
    el.style.transition = 'transform .18s';
    el.style.transform = '';
    wrap.classList.remove('armed');
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    startX = e.clientX; dx = 0; dragging = true; held = false;
    pointer = e.pointerId;
    // Rows are short, so a swipe leaves one vertically almost immediately.
    // Capturing keeps the move and up events coming here until it ends.
    try { el.setPointerCapture(pointer); } catch { /* mouse on an old engine */ }
    el.style.transition = '';
    timer = setTimeout(() => { held = true; openTagEditor(id); }, 500);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    if (Math.abs(dx) > 8) clearTimeout(timer);
    el.style.transform = `translateX(${dx}px)`;
    // Past the threshold the icon goes full strength, so releasing is a
    // decision rather than a surprise.
    wrap.classList.toggle('armed', Math.abs(dx) >= SWIPE_THRESHOLD);
  });
  const release = () => {
    if (pointer != null && el.hasPointerCapture?.(pointer)) el.releasePointerCapture(pointer);
    pointer = null;
  };
  const end = async () => {
    if (!dragging) return;
    dragging = false; clearTimeout(timer); release();
    if (Math.abs(dx) >= SWIPE_THRESHOLD) {
      el.style.transition = 'transform .18s, opacity .18s';
      el.style.transform = `translateX(${dx > 0 ? '100%' : '-100%'})`;
      el.style.opacity = '0';
      await deleteWithUndo(id);
    } else {
      reset();
      if (!held && Math.abs(dx) < 8) { openEntry(state.readings.find((r) => r.id === id)); }
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => {
    dragging = false; clearTimeout(timer); release(); reset();
  });
}

/* Delete now, restore from the toast -- the Android snackbar behaviour. */
async function deleteWithUndo(id) {
  const row = state.readings.find((r) => r.id === id);
  if (!row) return;
  await db.deleteReading(id);
  await refresh();
  toast(t('dashboard_snack_deleted'), {
    label: t('dashboard_snack_undo'),
    action: async () => { await db.updateReading({ ...row }); refresh(); },
  });
}

/* ---------------------------------------------------------------- chart -- */
function chartGeometry(svg) {
  const w = Math.max(280, Math.round(svg.clientWidth || 700));
  const h = Math.round(Math.min(320, Math.max(210, w * 0.55)));
  return { W: w, H: h, PAD: { l: 34, r: 10, t: 12, b: 26 },
           ticks: w < 380 ? 2 : w < 560 ? 3 : 5 };
}

function drawChart() {
  const svg = $('chart');
  const { W, H, PAD, ticks } = chartGeometry(svg);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  let rows = inRange().slice().sort((a, b) => a.timestamp - b.timestamp);
  if (state.smooth) rows = collapseBursts(rows);
  if (!rows.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="axis">${
      esc(t('chart_no_readings'))}</text>`;
    $('legend').innerHTML = '';
    return;
  }
  (state.mode === 'scatter' ? drawScatter : drawTrend)(svg, rows, W, H, PAD, ticks);
}

/* Y-axis bounds, the same rule as BPTrendChart:
     under a day of span (or a lone reading) → the fixed 40-180 frame, so a
       3 mmHg wobble cannot fill the viewport;
     a day or more → pad by 5 and snap outward to the nearest 10, so the chart
       fills the viewport with the range actually recorded. */
function trendBounds(rows) {
  const span = rows[rows.length - 1].timestamp - rows[0].timestamp;
  if (rows.length < 2 || span < 864e5) return [40, 180];
  const lo = Math.min(...rows.map((r) => Math.min(r.systolic, r.diastolic)));
  const hi = Math.max(...rows.map((r) => Math.max(r.systolic, r.diastolic)));
  return [Math.floor((lo - 5) / 10) * 10, Math.ceil((hi + 5) / 10) * 10];
}

function drawTrend(svg, rows, W, H, PAD, ticks) {
  const xs = rows.map((r) => r.timestamp);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const [yMin, yMax] = trendBounds(rows);
  const X = (v) => PAD.l + ((v - x0) / ((x1 - x0) || 1)) * (W - PAD.l - PAD.r);
  const Y = (v) => H - PAD.b - ((v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);

  let grid = '', labels = '';
  for (const v of niceTicks(yMin, yMax)) {
    grid += `<line class="grid" x1="${PAD.l}" y1="${Y(v).toFixed(1)}" x2="${W - PAD.r}" y2="${Y(v).toFixed(1)}"/>`;
    labels += `<text class="axis" x="4" y="${(Y(v) + 4).toFixed(1)}">${v}</text>`;
  }
  // 120 / 80 reference lines, drawn only when they fall inside the plot.
  for (const v of [120, 80]) {
    if (v < yMin || v > yMax) continue;
    grid += `<line class="refline" x1="${PAD.l}" y1="${Y(v).toFixed(1)}" x2="${W - PAD.r}" y2="${Y(v).toFixed(1)}"/>`;
  }
  for (let i = 0; i <= ticks; i++) {
    const ts = x0 + (i / ticks) * (x1 - x0);
    const anchor = i === 0 ? 'start' : i === ticks ? 'end' : 'middle';
    const short = (x1 - x0) < 864e5;
    labels += `<text class="axis" x="${X(ts).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${
      esc(fmtDate(ts, short ? { hour: '2-digit', minute: '2-digit' }
                             : { day: 'numeric', month: 'short' }))}</text>`;
  }
  const path = (key, colour) => `<path class="serie" stroke="${colour}" d="${
    rows.map((r, i) => `${i ? 'L' : 'M'}${X(r.timestamp).toFixed(1)},${Y(r[key]).toFixed(1)}`).join('')}"/>`;

  svg.innerHTML = grid + path('systolic', 'var(--accent)') + path('diastolic', 'var(--dia)')
    + labels + `<line id="cursor" class="cursor" x1="0" y1="${PAD.t}" x2="0" y2="${H - PAD.b}" style="display:none"/>`;
  $('legend').innerHTML =
    `<span><i style="background:var(--accent)"></i>${esc(t('validation_label_sys'))}</span>`
    + `<span><i style="background:var(--dia)"></i>${esc(t('validation_label_dia'))}</span>`;
  attachCursor(svg, rows, X);
}

/* Axis bounds, ported from BPScatter3DChart: tight to the data with a little
   breathing room, so each range chip gets a plot its own readings fill. A
   fixed 40-140 x 70-220 frame -- which is what this used to draw -- squeezes a
   normal person's readings into one corner and hides the spread that is the
   whole point of the scatter. */
function axisBounds(lo, hi) {
  const pad = Math.max(2, (hi - lo) * 0.06);
  return [lo - pad, hi + pad];
}

/* Round tick values inside [lo, hi] with a 1/2/5 x 10^n step, aiming for about
   four intervals. Also BPScatter3DChart's, so the two apps label alike. */
function niceTicks(lo, hi) {
  if (hi - lo <= 0) return [lo];
  const rough = (hi - lo) / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const n = rough / pow;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * pow;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 0.01; v += step) out.push(Math.round(v));
  return out;
}

function drawScatter(svg, rows, W, H, PAD) {
  const sys = rows.map((r) => r.systolic);
  const dia = rows.map((r) => r.diastolic);
  const [yMin, yMax] = axisBounds(Math.min(...sys), Math.max(...sys));
  const [xMin, xMax] = axisBounds(Math.min(...dia), Math.max(...dia));
  const X = (v) => PAD.l + ((v - xMin) / (xMax - xMin)) * (W - PAD.l - PAD.r);   // diastolic
  const Y = (v) => H - PAD.b - ((v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b); // systolic
  let grid = '', labels = '';
  for (const v of niceTicks(yMin, yMax)) {
    grid += `<line class="grid" x1="${PAD.l}" y1="${Y(v).toFixed(1)}" x2="${W - PAD.r}" y2="${Y(v).toFixed(1)}"/>`;
    labels += `<text class="axis" x="4" y="${(Y(v) + 4).toFixed(1)}">${v}</text>`;
  }
  for (const v of niceTicks(xMin, xMax)) {
    labels += `<text class="axis" x="${X(v).toFixed(1)}" y="${H - 6}" text-anchor="middle">${v}</text>`;
  }
  // The 120/80 guides are only drawn when they fall inside the plot; with the
  // axes now tracking the data they can sit outside it.
  if (120 >= yMin && 120 <= yMax) {
    grid += `<line class="refline" x1="${PAD.l}" y1="${Y(120).toFixed(1)}" x2="${W - PAD.r}" y2="${Y(120).toFixed(1)}"/>`;
  }
  if (80 >= xMin && 80 <= xMax) {
    grid += `<line class="refline" x1="${X(80).toFixed(1)}" y1="${PAD.t}" x2="${X(80).toFixed(1)}" y2="${H - PAD.b}"/>`;
  }
  // Colour carries time here, not severity: where a dot sits relative to the
  // 120/80 guides already says how high it is, so spending colour on severity
  // too would say the same thing twice and waste the only free channel left.
  const tMin = Math.min(...rows.map((r) => r.timestamp));
  const tMax = Math.max(...rows.map((r) => r.timestamp));
  const dots = rows.map((r) =>
    `<circle cx="${X(r.diastolic).toFixed(1)}" cy="${Y(r.systolic).toFixed(1)}" r="4.5"
       fill="${recencyColor(recencyAt(r.timestamp, tMin, tMax))}" opacity=".8" data-id="${r.id}"><title>${
       r.systolic}/${r.diastolic} — ${esc(fmtDate(r.timestamp))}</title></circle>`).join('');
  svg.innerHTML = grid + dots + labels;
  $('legend').innerHTML =
    `<span><i style="background:${recencyGradient()};width:34px;height:8px;border-radius:2px"></i>${
      esc(t('scatter_colour_time'))}</span>`;
}

function attachCursor(svg, rows, X) {
  const cursor = svg.querySelector('#cursor');
  const readout = $('readout');
  const at = (evt) => {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const cx = ((evt.touches ? evt.touches[0].clientX : evt.clientX) - r.left) / r.width * vb.width;
    let best = 0, bd = Infinity;
    rows.forEach((row, i) => {
      const d = Math.abs(X(row.timestamp) - cx);
      if (d < bd) { bd = d; best = i; }
    });
    const p = rows[best];
    cursor.setAttribute('x1', X(p.timestamp)); cursor.setAttribute('x2', X(p.timestamp));
    cursor.style.display = '';
    readout.hidden = false;
    readout.innerHTML = `${esc(fmtDate(p.timestamp))}<br><b>${p.systolic}/${p.diastolic}</b>`
      + (p.pulse ? ` · ${p.pulse} bpm` : '');
  };
  const hide = () => { cursor.style.display = 'none'; readout.hidden = true; };
  svg.onpointermove = at; svg.onpointerdown = at; svg.onpointerleave = hide;
  svg.ontouchmove = at; svg.ontouchend = hide;
}

let resizeTimer = null;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.view === 'dashboard') drawChart(); }, 150);
});

/* ---------------------------------------------------------------- entry -- */
function syncPreview() {
  const s = Number($('in-sys').value), d = Number($('in-dia').value);
  const p = Number($('in-pulse').value);
  // Do not fight the user mid-typing: only mirror into a field they are not in.
  for (const [id, v] of [['val-sys', s], ['val-dia', d], ['val-pulse', p]]) {
    const box = $(id);
    if (document.activeElement !== box) box.value = v;
  }
  $('preview-sys').textContent = s; $('preview-dia').textContent = d;
  const cat = bp.categorize(s, d);
  const badge = $('preview-cat');
  badge.textContent = t(ZONE_KEY[cat]);
  badge.style.color = ZONE_COLOR[cat];
  $('preview-sys').style.color = ZONE_COLOR[cat];
  $('hemo').textContent =
    `MAP ${bp.meanArterialPressure(s, d)} · ${t('hemo_pulse_pressure')} ${bp.pulsePressure(s, d)}`;
}

async function openEntry(existing, source = 'manual', auditId = null) {
  state.editing = existing || null;
  state.entrySource = existing?.source || source;
  state.entryAuditId = existing ? null : auditId;
  state.entryAuditPending = Boolean(auditId);
  state.selectedTags = new Set(db.normalizeTags(existing?.tags).split(',').filter(Boolean));
  // Sliders start from the last reading, as in the app: the next measurement
  // is far more likely to be near the previous one than near 120/80.
  const seed = existing || (await db.lastReading()) || { systolic: 120, diastolic: 80, pulse: 70 };
  $('in-sys').value = seed.systolic; $('in-dia').value = seed.diastolic;
  $('in-pulse').value = seed.pulse || 70;
  const when = new Date(existing?.timestamp ?? Date.now());
  when.setMinutes(when.getMinutes() - when.getTimezoneOffset());
  $('in-when').value = when.toISOString().slice(0, 16);
  $('in-notes').value = existing?.notes || '';
  renderTagPicker();
  syncPreview();
  $('add-error').hidden = true;      // a fresh entry carries no scan failure
  setOcrConfirmation(!existing && source === 'ocr');
  show('add');
}

function setOcrConfirmation(required, confirmed = false) {
  state.entryOcrConfirmationRequired = Boolean(required);
  state.entryOcrConfirmed = Boolean(required && confirmed);
  $('ocr-confirm').hidden = !required;
  $('view-add').classList.toggle('ocr-confirm-required', Boolean(required));
  $('ocr-confirm-check').checked = state.entryOcrConfirmed;
  $('btn-save').disabled = Boolean(required && !state.entryOcrConfirmed);
}

function invalidateOcrConfirmation() {
  if (!state.entryOcrConfirmationRequired || !state.entryOcrConfirmed) return;
  setOcrConfirmation(true, false);
}

function renderTagPicker() {
  $('tag-picker').innerHTML = TAGS.map((k) =>
    `<button type="button" class="chip${state.selectedTags.has(k) ? ' on' : ''}" data-tag="${k}">${
      esc(t(k))}</button>`).join('');
  $('tag-picker').querySelectorAll('[data-tag]').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.tag;
      state.selectedTags.has(k) ? state.selectedTags.delete(k) : state.selectedTags.add(k);
      renderTagPicker();
    }));
}

async function saveReading() {
  if (state.entryOcrConfirmationRequired && !state.entryOcrConfirmed) {
    toast(t('capture_confirm_required'));
    return;
  }
  const systolic = Number($('in-sys').value);
  const diastolic = Number($('in-dia').value);
  if (diastolic >= systolic) { toast(t('validation_error_sys_dia')); return; }
  const row = {
    timestamp: $('in-when').value ? new Date($('in-when').value).getTime() : Date.now(),
    systolic, diastolic,
    pulse: Number($('in-pulse').value) || null,
    category: bp.categorize(systolic, diastolic),
    notes: $('in-notes').value.trim() || null,
    tags: [...state.selectedTags].join(','),
    source: state.editing?.source || state.entrySource || 'manual',
  };
  const readingId = state.editing
    ? await db.updateReading({ ...state.editing, ...row })
    : await db.addReading(row);
  await completeEntryAudit(row, readingId);
  toast(t('validation_save'));
  state.editing = null;
  show('dashboard');
  refresh();
}

/* An evaluation record follows one scan until the first Save or until its
   entry screen is abandoned. Later edits are ordinary reading edits: the
   signal we want is whether the OCR suggestion was accepted as shown. */
async function discardEntryAudit(decision = 'discarded') {
  const id = state.entryAuditId;
  if (!id || !state.entryAuditPending) return;
  state.entryAuditPending = false;
  state.entryAuditId = null;
  try {
    await db.updateOcrAudit(id, { decision, decidedAt: Date.now() });
  } catch (error) {
    console.warn('Could not close OCR evaluation record', error);
  }
}

async function completeEntryAudit(row, readingId) {
  const id = state.entryAuditId;
  if (!id || !state.entryAuditPending) return;
  state.entryAuditPending = false;
  state.entryAuditId = null;
  try {
    const audit = await db.getOcrAudit(id);
    const finalReading = readingValues(row);
    await db.updateOcrAudit(id, {
      decision: 'saved',
      adjusted: readingsDiffer(audit?.rawReading, finalReading),
      finalReading,
      readingId,
      decidedAt: Date.now(),
    });
  } catch (error) {
    console.warn('Could not complete OCR evaluation record', error);
  }
}

/* -------------------------------------------------------------- profile -- */
function renderProfile() {
  const p = state.profile || {};
  const sel = (v, o) => v === o ? ' selected' : '';
  $('profile-form').innerHTML = `
    <div class="row2">
      <div class="field"><label>${esc(t('profile_birth_year_label'))}</label>
        <input type="number" id="p-year" min="1900" max="${new Date().getFullYear()}"
               value="${p.birthYear || ''}"></div>
      <div class="field"><label>${esc(t('profile_sex_label'))}</label>
        <select id="p-sex">
          <option value=""${sel(p.sex, undefined)}>—</option>
          <option value="MALE"${sel(p.sex, 'MALE')}>${esc(t('sex_male'))}</option>
          <option value="FEMALE"${sel(p.sex, 'FEMALE')}>${esc(t('sex_female'))}</option>
          <option value="OTHER"${sel(p.sex, 'OTHER')}>${esc(t('sex_prefer_not_to_say'))}</option>
        </select></div>
    </div>
    <div class="row2">
      <div class="field"><label>${esc(t('profile_weight_label'))}</label>
        <input type="number" id="p-weight" step="0.1" value="${p.weightKg || ''}"></div>
      <div class="field"><label>${esc(t('profile_height_label'))}</label>
        <input type="number" id="p-height" step="1" value="${p.heightCm || ''}"></div>
    </div>
    <p class="muted" id="p-bmi"></p>
    <div class="field"><label>${esc(t('profile_activity_level_label'))}</label>
      <select id="p-activity">
        ${['SEDENTARY', 'LIGHTLY_ACTIVE', 'MODERATELY_ACTIVE', 'VERY_ACTIVE'].map((a) =>
          `<option value="${a}"${sel(p.activity, a)}>${esc(t('activity_desc_' + a.toLowerCase()))}</option>`).join('')}
      </select></div>
    <label class="field"><input type="checkbox" id="p-smoker" style="width:auto"${
      p.smoker ? ' checked' : ''}> ${esc(t('profile_smoker_label'))}</label>
    <label class="field"><input type="checkbox" id="p-diabetes" style="width:auto"${
      p.diabetes ? ' checked' : ''}> ${esc(t('profile_diabetes_label'))}</label>
    <div class="actions"><button class="btn" id="p-save">${esc(t('action_save'))}</button></div>`;

  const showBmi = () => {
    const v = bp.bmi(Number($('p-weight').value), Number($('p-height').value));
    $('p-bmi').textContent = v ? t('risk_card_bmi', v.toFixed(1), t(bmiKey(bp.bmiCategory(v)))) : '';
  };
  $('p-weight').addEventListener('input', showBmi);
  $('p-height').addEventListener('input', showBmi);
  showBmi();

  $('p-save').addEventListener('click', async () => {
    await db.setKV('profile', {
      birthYear: Number($('p-year').value) || null,
      sex: $('p-sex').value || null,
      weightKg: Number($('p-weight').value) || null,
      heightCm: Number($('p-height').value) || null,
      activity: $('p-activity').value,
      smoker: $('p-smoker').checked,
      diabetes: $('p-diabetes').checked,
    });
    toast(t('action_save'));
    show('dashboard');
    refresh();
  });
}

/* ------------------------------------------------------- export / import -- */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

async function exportJson() {
  const rows = await db.allReadings();
  download(`bp-${stamp()}.json`, JSON.stringify({
    app: 'bp-digitizer', version: 1, exported: new Date().toISOString(),
    profile: await db.getKV('profile'), readings: rows,
  }, null, 1), 'application/json');
}

async function exportCsv() {
  const rows = await db.allReadings();
  const head = ['timestamp', 'iso', 'systolic', 'diastolic', 'pulse', 'category', 'tags', 'notes'];
  const body = rows.map((r) => [
    r.timestamp, new Date(r.timestamp).toISOString(), r.systolic, r.diastolic,
    r.pulse ?? '', r.category, db.normalizeTags(r.tags).replace(/,/g, ' '),
    (r.notes || '').replace(/"/g, '""'),
  ].map((v) => (/[",\n]/.test(String(v)) ? `"${v}"` : v)).join(','));
  download(`bp-${stamp()}.csv`, [head.join(','), ...body].join('\n'), 'text/csv');
}

/* The report is rendered by the browser's print pipeline rather than written
   as PDF bytes here -- see pdf.js for why. */
async function exportPdfReport() {
  const rows = await db.allReadings();
  if (!rows.length) { toast(t('dashboard_snack_import_none')); return; }
  await exportPdf(rows, { smooth: !!state.smooth });
}

/* The same report as a file, for when the print dialog is the friction. Costs
   selectable text and a few megabytes -- see pdf.js for why that trade exists
   rather than a bundled font. */
async function exportPdfDownload() {
  const rows = await db.allReadings();
  if (!rows.length) { toast(t('dashboard_snack_import_none')); return; }
  toast(t('dashboard_export_pdf_building'));
  try {
    await exportPdfFile(rows, { smooth: !!state.smooth });
  } catch (e) {
    toast(e.message);
  }
}

async function importFile(file) {
  try {
    const text = await file.text();
    let rows;
    if (file.name.endsWith('.csv')) {
      const [head, ...lines] = text.trim().split(/\r?\n/);
      const cols = head.split(',');
      rows = lines.map((l) => {
        const v = l.split(',');
        const o = Object.fromEntries(cols.map((c, i) => [c.trim(), v[i]]));
        return {
          timestamp: Number(o.timestamp) || Date.parse(o.iso),
          systolic: Number(o.systolic), diastolic: Number(o.diastolic),
          pulse: Number(o.pulse) || null,
          category: o.category || bp.categorize(Number(o.systolic), Number(o.diastolic)),
          tags: db.normalizeTags(o.tags), notes: o.notes || null,
        };
      });
    } else {
      const data = JSON.parse(text);
      rows = data.readings || data;
      if (data.profile && !state.profile.birthYear) await db.setKV('profile', data.profile);
    }
    rows = rows
      .filter((r) => r.timestamp && r.systolic && r.diastolic)
      .map((r) => ({ ...r, tags: db.normalizeTags(r.tags) }));
    if (!rows.length) { toast(t('dashboard_snack_import_none')); return; }
    const { added, skipped } = await db.importReadings(rows);
    toast(added ? t('dashboard_snack_imported', added) + (skipped ? ` (${skipped}?)` : '')
                : t('dashboard_snack_import_none'));
    refresh();
  } catch (e) {
    toast(t('dashboard_snack_import_failed'));
  }
}

/* ------------------------------------------------------------- settings -- */
function renderSettings() {
  // Language, export and import all live in the app bar; carrying second
  // copies here meant two file inputs for one job and a button to remember in
  // two places every time the export menu changed.
  $('settings-body').innerHTML = `
    <h2 style="margin:0 0 8px">${esc(t('settings_backup_now'))}</h2>
    <div id="s-backup-device"></div>
    <h2 style="margin:22px 0 8px">${esc(t('settings_ocr_log_title'))}</h2>
    <div id="s-ocr-audit"></div>
    <h2 style="margin:22px 0 8px">${esc(t('settings_danger_zone'))}</h2>
    <button class="link" id="s-wipe" style="color:var(--z-crisis)">${
      esc(t('settings_delete_all'))}</button>`;

  renderBackupSection();
  void renderOcrAuditSection();
  const ver = $('s-version');
  if (ver) {
    ver.textContent = `build ${BUILD}`;
    ver.onclick = async () => {
      ver.textContent = 'checking…';
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.update()));
        for (const k of await caches.keys()) await caches.delete(k);
        location.reload();
      } catch { ver.textContent = `build ${BUILD}`; }
    };
  }
  $('s-wipe').addEventListener('click', async () => {
    if (!confirm(t('settings_delete_all_confirm'))) return;
    await db.wipe();
    toast(t('settings_deleted_all'));
    show('dashboard'); refresh();
  });
}

function clearOcrAuditUrls() {
  ocrAuditUrls.forEach((url) => URL.revokeObjectURL(url));
  ocrAuditUrls = [];
}

const auditReadingLabel = (reading) => {
  const value = readingValues(reading);
  return value ? `${value.sys}/${value.dia}${value.pulse == null ? '' : ` · ${value.pulse}`}`
    : t('settings_ocr_log_no_reading');
};

const auditDecisionLabel = (row) => {
  if (row.decision === 'saved') return t(row.adjusted
    ? 'settings_ocr_log_adjusted' : 'settings_ocr_log_unchanged');
  if (row.decision === 'error') return t('settings_ocr_log_error');
  return t('settings_ocr_log_not_saved');
};

const formatBytes = (bytes) => {
  if (!bytes) return '0 KB';
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

async function renderOcrAuditSection() {
  const box = $('s-ocr-audit');
  if (!box) return;
  const rows = await db.allOcrAudits();
  if ($('s-ocr-audit') !== box || state.view !== 'settings') return;
  clearOcrAuditUrls();
  const summary = summarizeAudits(rows);
  const bytes = rows.reduce((sum, row) => sum + (row.image?.size || 0), 0);
  const visible = rows.slice(0, 20);
  const fieldSummary = (field) => `${summary.fields[field].correct}/${summary.fields[field].total}`;
  const stageSummary = ['full', 'portrait', 'adaptive', 'rectified', 'unreadable', 'error']
    .filter((stage) => summary.stages[stage])
    .map((stage) => `${t(`settings_ocr_stage_${stage}`)} ${summary.stages[stage]}`).join(' · ');
  box.innerHTML = `
    <label class="audit-toggle"><input type="checkbox" id="s-ocr-audit-enabled"${
      state.ocrAuditEnabled ? ' checked' : ''}> <span>${esc(t('settings_ocr_log_enable'))}</span></label>
    <p class="muted">${esc(t('settings_ocr_log_body', MAX_AUDITS))}</p>
    ${rows.length ? `<p class="muted">${esc(t('settings_ocr_log_summary',
      summary.total, summary.unchanged, summary.adjusted, summary.notSaved, formatBytes(bytes)))}</p>`
      : `<p class="muted">${esc(t('settings_ocr_log_empty'))}</p>`}
    ${summary.compared ? `<p class="muted">${esc(t('settings_ocr_log_accuracy',
      summary.exact, summary.compared, fieldSummary('sys'), fieldSummary('dia'), fieldSummary('pulse')))}</p>` : ''}
    ${stageSummary ? `<p class="muted">${esc(t('settings_ocr_log_stages', stageSummary))}</p>` : ''}
    <div class="actions audit-actions">
      <button class="link" id="s-ocr-audit-export"${rows.length ? '' : ' disabled'}>${
        esc(t('settings_ocr_log_export'))}</button>
      <button class="link danger-link" id="s-ocr-audit-delete"${rows.length ? '' : ' disabled'}>${
        esc(t('settings_ocr_log_delete'))}</button>
    </div>
    <div class="audit-list">${visible.map((row) => {
      let imageUrl = '';
      if (row.image) {
        imageUrl = URL.createObjectURL(row.image);
        ocrAuditUrls.push(imageUrl);
      }
      return `<details class="audit-entry">
        <summary><span>${esc(fmtDate(row.createdAt))}</span><b>${esc(auditDecisionLabel(row))}</b></summary>
        <div class="audit-detail">
          ${imageUrl ? `<img src="${esc(imageUrl)}" alt="${esc(t('settings_ocr_log_picture'))}">` : ''}
          <div><b>${esc(t('settings_ocr_log_raw'))}</b> ${esc(auditReadingLabel(row.rawReading))}</div>
          <div><b>${esc(t('settings_ocr_log_final'))}</b> ${esc(auditReadingLabel(row.finalReading))}</div>
          <div>${esc(t(`settings_ocr_stage_${auditStage(row)}`))} · ${
            esc(row.ocrStatus || row.decision)} · ${esc(formatBytes(row.image?.size || 0))}</div>
        </div>
      </details>`;
    }).join('')}</div>
    ${rows.length > visible.length ? `<p class="muted">${esc(t('settings_ocr_log_showing',
      visible.length, rows.length))}</p>` : ''}`;

  $('s-ocr-audit-enabled').addEventListener('change', async (event) => {
    state.ocrAuditEnabled = event.target.checked;
    await db.setKV(OCR_AUDIT_ENABLED, state.ocrAuditEnabled);
    if (state.ocrAuditEnabled) navigator.storage?.persist?.().catch(() => {});
  });
  $('s-ocr-audit-export').addEventListener('click', exportOcrAuditLog);
  $('s-ocr-audit-delete').addEventListener('click', async () => {
    if (!confirm(t('settings_ocr_log_delete_confirm'))) return;
    await db.clearOcrAudits();
    toast(t('settings_ocr_log_deleted'));
    await renderOcrAuditSection();
  });
}

async function exportOcrAuditLog() {
  if (!confirm(t('settings_ocr_log_export_confirm'))) return;
  try {
    const entries = await serializableAudits(await db.allOcrAudits());
    download(`bp-ocr-evaluation-${stamp()}.json`, JSON.stringify({
      app: 'bp-digitizer', kind: 'ocr-evaluation-log', version: 1,
      build: BUILD, exportedAt: new Date().toISOString(), entries,
    }, null, 1), 'application/json');
  } catch (error) {
    console.warn('Could not export OCR evaluation log', error);
    toast(t('settings_ocr_log_failed'));
  }
}

/* Nudge towards installing, wherever that is actionable.

   Chrome fires beforeinstallprompt when the app is installable and not
   already installed, and hands over an event that can be replayed on a real
   tap -- so that branch gets a button that does the thing. Safari fires
   nothing and has no API, so iOS gets the manual gesture spelled out instead.
   A browser that can neither install nor be instructed is told nothing.

   The offer returns every launch while the app is still not installed: the
   offline shell, local OCR and durable standalone storage all benefit from
   installation. Dismissal is per session, so it can be pushed
   aside for now without being answered once and for all. */
const INSTALL_DISMISSED = 'bp.install.dismissed';
let installPrompt = null;
let onInstallPrompt = null;

/* Registered at module scope, not from boot: Chrome fires this around load,
   which is before an async boot has finished awaiting its locale and its
   database. A listener attached later simply never hears it. */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();            // keep the event for a tap of our own
  installPrompt = e;
  if (onInstallPrompt) onInstallPrompt();
});

function setupInstallBanner() {
  const bar = $('install-banner');
  if (!bar) return;
  const hide = () => { bar.hidden = true; };
  if (isInstalled() || sessionStorage.getItem(INSTALL_DISMISSED) === '1') return;

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const show = () => {
    // Nothing to say on a desktop browser that will not install and cannot be
    // told how; the banner appears only where it leads somewhere.
    if (!installPrompt && !isIOS) return;
    $('install-text').textContent =
      `${t('install_banner_body')}${installPrompt ? '' : ` ${t('install_banner_ios')}`}`;
    $('install-go').textContent = t('install_banner_action');
    $('install-go').hidden = !installPrompt;
    bar.hidden = false;
  };

  onInstallPrompt = show;        // in case the event arrives after this runs
  // Chrome stops firing beforeinstallprompt once installed, so this tab is the
  // only one that needs telling. Session-scoped like the manual dismissal:
  // Safari reports neither event, so nothing here can be a permanent answer.
  window.addEventListener('appinstalled', () => {
    sessionStorage.setItem(INSTALL_DISMISSED, '1');
    hide();
  });

  $('install-go').addEventListener('click', async () => {
    if (!installPrompt) return;
    const e = installPrompt;
    installPrompt = null;        // a prompt event may only be used once
    hide();
    try { await e.prompt(); } catch { /* dismissed by the browser */ }
  });
  $('install-close').addEventListener('click', () => {
    sessionStorage.setItem(INSTALL_DISMISSED, '1');
    hide();
  });

  show();                        // iOS has no event to wait for
}

/* Used only to avoid offering installation to an already installed app. */
const isInstalled = () =>
  window.matchMedia('(display-mode: standalone)').matches
  || window.matchMedia('(display-mode: fullscreen)').matches
  || navigator.standalone === true;                       // iOS Safari

/* prompt() renders the passphrase in clear text on screen and in the platform
   dialog's own history, which is the wrong place for the one secret that can
   decrypt a backup file. This is the same bottom sheet the rest of the
   app uses, with a masked field and a reveal toggle -- blind typing is worse
   than no masking when a typo produces a backup nobody can open.
   Resolves to the passphrase, or null if dismissed. */
function askPassphrase({ title, message, autocomplete }) {
  return new Promise((resolve) => {
    const sheet = $('sheet');
    let done = false;
    // Back dismisses without a value; the buttons go through close().
    const dismiss = () => {
      if (done) return;
      done = true;
      sheet.hidden = true;
      sheet.onclick = null;
      resolve(null);
    };
    const close = (value) => {
      if (done) return;
      closeOverlay(dismiss);
      done = true;
      sheet.hidden = true;
      sheet.onclick = null;
      resolve(value);
    };
    sheet.innerHTML = `
      <div class="sheet-card">
        <h3>${esc(title)}</h3>
        <p class="muted" style="margin:0">${esc(message)}</p>
        <div class="pass">
          <input type="password" id="pass-input" autocomplete="${autocomplete}"
                 autocapitalize="off" autocorrect="off" spellcheck="false">
          <button class="icon-btn" id="pass-eye" type="button" aria-pressed="false"
                  title="${esc(t('settings_passphrase_show'))}"
                  aria-label="${esc(t('settings_passphrase_show'))}">${icon('eye', 20)}</button>
        </div>
        <div class="actions">
          <button class="link" id="pass-cancel">${esc(t('action_cancel'))}</button>
          <button class="btn" id="pass-ok">${esc(t('action_ok'))}</button>
        </div>
      </div>`;
    sheet.hidden = false;
    sheet.onclick = (e) => { if (e.target === sheet) close(null); };
    openOverlay(dismiss);

    const input = $('pass-input');
    const eye = $('pass-eye');
    eye.addEventListener('click', () => {
      const shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      eye.setAttribute('aria-pressed', String(!shown));
      eye.innerHTML = icon(shown ? 'eye' : 'eye-off', 20);
      input.focus();
    });
    const submit = () => close(input.value || null);
    $('pass-ok').addEventListener('click', submit);
    $('pass-cancel').addEventListener('click', () => close(null));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    input.focus();
  });
}

/* Browser storage is the live copy; a separately downloaded encrypted file is
   the recovery copy if the browser or installed app is cleared. */
function renderDataNote() {
  const el = $('foot');
  if (!el) return;
  el.innerHTML = `<span class="note-ico">${icon('share', 16)}</span>${
    esc(t('settings_local_only_note'))}`;
}

/* ------------------------------------------------ on-device backup ------- */
const BACKUP_META = 'deviceBackupInfo';
const MAX_BACKUP_FILE = 20 * 1024 * 1024;

async function renderBackupSection() {
  const box = $('s-backup-device');
  if (!box) return;
  const info = await db.getKV(BACKUP_META);
  if ($('s-backup-device') !== box) return;
  box.innerHTML = `
    <p class="muted">${esc(t('settings_local_only_note'))}</p>
    <div class="actions" style="flex-wrap:wrap;margin-top:10px">
      <button class="btn" id="s-backup">${esc(t('settings_backup_now'))}</button>
      <button class="link" id="s-restore">${esc(t('settings_restore'))}</button>
    </div>
    <p class="muted" id="s-backup-info" style="margin-top:8px">${esc(info
      ? t('settings_backup_exists', info.readings ?? '?', fmtDate(info.createdAt))
      : t('settings_backup_none'))}</p>`;

  $('s-backup').addEventListener('click', createDeviceBackup);
  $('s-restore').addEventListener('click', () => $('backup-file').click());
}

async function createDeviceBackup() {
  const pass = await askPassphrase({
    title: t('settings_backup_now'), message: t('settings_backup_passphrase'),
    autocomplete: 'new-password',
  });
  if (!pass) return;
  try {
    const readings = await db.allReadings();
    const text = await createBackup(pass, {
      readings, profile: await db.getKV('profile'),
      exportedAt: new Date().toISOString(),
    });
    download(backupFilename(), text, 'application/json');
    await db.setKV(BACKUP_META, { readings: readings.length, createdAt: Date.now() });
    toast(t('settings_backup_done'));
    if ($('s-backup-device')) await renderBackupSection();
    renderDataNote();
  } catch {
    toast(t('dashboard_snack_export_failed'));
  }
}

async function restoreDeviceBackup(file) {
  if (!file || file.size > MAX_BACKUP_FILE) {
    toast(t('dashboard_snack_import_failed'));
    return;
  }
  const pass = await askPassphrase({
    title: t('settings_restore'), message: t('settings_restore_passphrase'),
    autocomplete: 'current-password',
  });
  if (!pass) return;
  try {
    const data = await readBackup(pass, await file.text());
    const { added } = await db.importReadings(data.readings);
    if (data.profile) await db.setKV('profile', data.profile);
    toast(t('dashboard_snack_imported', added));
    await refresh();
    if ($('s-backup-device')) await renderBackupSection();
  } catch (error) {
    toast(error.code === 'wrong-passphrase'
      ? t('settings_restore_wrong') : t('dashboard_snack_import_failed'));
  }
}

function updateScanButton() {
  const fab = $('fab-scan');
  if (!fab) return;
  fab.hidden = false;
  fab.title = t('dashboard_cd_scan');
  fab.setAttribute('aria-label', t('dashboard_cd_scan'));
}

let ocrReaderPromise = null;

function getOcrReader() {
  if (!ocrReaderPromise) {
    ocrReaderPromise = createHearthReader(`/hearth/inference-worker.js?v=${BUILD}`)
      .catch((error) => {
        ocrReaderPromise = null;
        throw error;
      });
  }
  return ocrReaderPromise;
}

function resetOcrReader() {
  const pending = ocrReaderPromise;
  ocrReaderPromise = null;
  pending?.then((reader) => reader.dispose()).catch(() => {});
}

/* The local worker reports only completion, so the progress bar stops short of
   100%. Cancel terminates the worker and its in-flight inference; the next scan
   creates a fresh reader. */
const OCR_STATUS = ['capture_status_sending', 'capture_status_reading',
                    'capture_status_extracting', 'capture_status_almost'];
const OCR_STATUS_AT = [2000, 5000, 8000];
const OCR_FILL_MS = 8000;

async function scanPhoto(file) {
  if (state.entryAuditPending) await discardEntryAudit('retaken');
  const auditEnabled = state.ocrAuditEnabled;
  const auditImage = auditEnabled
    ? prepareAuditImage(file).catch((error) => {
      console.warn('Could not prepare OCR evaluation picture', error);
      return null;
    })
    : null;
  const box = $('scanning');
  const bar = box.querySelector('.scan-bar i');
  const url = URL.createObjectURL(file);
  $('scan-shot').src = url;
  $('scan-status').textContent = t(OCR_STATUS[0]);
  $('scan-cancel').textContent = t('action_cancel');

  bar.style.transition = 'none';
  bar.style.width = '0%';
  box.hidden = false;
  requestAnimationFrame(() => {
    bar.style.transition = `width ${OCR_FILL_MS}ms linear`;
    bar.style.width = '80%';
  });

  const timers = OCR_STATUS_AT.map((delay, i) =>
    setTimeout(() => { $('scan-status').textContent = t(OCR_STATUS[i + 1]); }, delay));
  let cancelled = false, finished = false;
  const guard = (event) => { event.preventDefault(); event.returnValue = ''; };
  let finish = () => {};
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    resetOcrReader();
    finish();
  };
  finish = () => {
    if (finished) return;
    finished = true;
    closeOverlay(cancel);
    timers.forEach(clearTimeout);
    window.removeEventListener('beforeunload', guard);
    $('scan-cancel').removeEventListener('click', cancel);
    box.hidden = true;
    $('scan-shot').removeAttribute('src');
    URL.revokeObjectURL(url);
  };

  $('scan-cancel').addEventListener('click', cancel);
  openOverlay(cancel);
  window.addEventListener('beforeunload', guard);

  try {
    const output = await (await getOcrReader()).read(file);
    const { result } = output;
    if (cancelled) return;
    finish();
    const auditId = await recordOcrAudit(file, auditImage, output);
    if (!result.reading) {
      await openEntry(null, 'manual', auditId);
      $('add-error-text').textContent = t('capture_error_unreadable');
      $('add-retake').textContent = t('validation_retake');
      $('add-error').hidden = false;
      return;
    }
    await openEntry(null, 'ocr', auditId);
    $('in-sys').value = result.reading.sys;
    $('in-dia').value = result.reading.dia;
    $('in-pulse').value = result.reading.pulse;
    syncPreview();
    if (result.status === 'review') {
      $('add-error-text').textContent = t('capture_check_values');
      $('add-retake').textContent = t('validation_retake');
      $('add-error').hidden = false;
    }
  } catch (error) {
    finish();
    if (!cancelled) {
      await recordOcrAudit(file, auditImage, null, error);
      toast(error.message);
    }
  }
}

async function recordOcrAudit(file, imagePromise, output, error = null) {
  if (!imagePromise) return null;
  try {
    const prepared = await imagePromise;
    const result = output?.result || null;
    const id = await db.addOcrAudit({
      createdAt: Date.now(),
      build: BUILD,
      original: {
        name: file.name || null,
        type: file.type || null,
        size: file.size ?? null,
        lastModified: file.lastModified || null,
      },
      image: prepared?.image || null,
      imageWidth: prepared?.width || output?.imageSize?.width || null,
      imageHeight: prepared?.height || output?.imageSize?.height || null,
      imageBytes: prepared?.image?.size || null,
      elapsedMs: output?.elapsedMs ?? null,
      inputWidth: output?.imageSize?.width ?? null,
      inputHeight: output?.imageSize?.height ?? null,
      ocrStatus: result?.status || (error ? 'error' : null),
      rawResult: result,
      rawReading: readingValues(result?.reading),
      decision: error ? 'error' : 'pending',
      adjusted: null,
      finalReading: null,
      readingId: null,
      decidedAt: error ? Date.now() : null,
      error: error ? String(error.message || error) : null,
    });
    await db.pruneOcrAudits(MAX_AUDITS);
    return id;
  } catch (auditError) {
    console.warn('Could not store OCR evaluation record', auditError);
    toast(t('settings_ocr_log_failed'));
    return null;
  }
}

/* ---------------------------------------------------------------- boot --- */
/* Dashboard actions: profile, import, export, help, language and settings. */
function renderAppbar() {
  const box = $('appbar-actions');
  const btn = (id, name, key, extra = '') =>
    `<button class="icon-btn" id="${id}" title="${esc(t(key))}" aria-label="${
      esc(t(key))}">${icon(name, 24)}${extra}</button>`;
  box.innerHTML = `
    ${btn('ab-profile', 'person', 'dashboard_cd_profile')}
    ${btn('ab-import', 'download', 'dashboard_cd_import')}
    <span class="menu-wrap">
      ${btn('ab-export', 'share', 'dashboard_cd_export')}
      <div class="menu" id="menu-export" hidden>
        <button id="mx-json">${icon('download', 20)}${esc(t('dashboard_export_json'))}</button>
        <button id="mx-csv">${icon('download', 20)}${esc(t('dashboard_export_csv'))}</button>
        <button id="mx-pdf">${icon('share', 20)}${esc(t('dashboard_export_pdf'))}</button>
        <button id="mx-pdf-file">${icon('download', 20)}${esc(t('dashboard_export_pdf_file'))}</button>
      </div>
    </span>
    ${btn('ab-help', 'help', 'dashboard_cd_help')}
    <span class="menu-wrap">
      ${btn('ab-lang', 'language', 'dashboard_cd_language')}
      <div class="menu" id="menu-lang" hidden>${LOCALES.map((l) =>
        `<button data-loc="${l}">${l === locale() ? icon('check', 20) : '<span style="width:20px"></span>'}${
          esc(new Intl.DisplayNames([l], { type: 'language' }).of(l))}</button>`).join('')}</div>
    </span>
    ${btn('ab-settings', 'settings', 'settings_title')}`;

  const toggle = (id) => {
    const m = $(id);
    const wasOpen = !m.hidden;
    document.querySelectorAll('.menu').forEach((x) => { x.hidden = true; });
    m.hidden = wasOpen;
  };
  $('ab-profile').addEventListener('click', () => { renderProfile(); show('profile'); });
  $('ab-import').addEventListener('click', () => $('s-file-global').click());
  $('ab-export').addEventListener('click', () => toggle('menu-export'));
  $('mx-json').addEventListener('click', () => { $('menu-export').hidden = true; exportJson(); });
  $('mx-csv').addEventListener('click', () => { $('menu-export').hidden = true; exportCsv(); });
  $('mx-pdf').addEventListener('click', () => { $('menu-export').hidden = true; exportPdfReport(); });
  $('mx-pdf-file').addEventListener('click', () => { $('menu-export').hidden = true; exportPdfDownload(); });
  $('ab-help').addEventListener('click', showHelp);
  $('ab-lang').addEventListener('click', () => toggle('menu-lang'));
  $('menu-lang').querySelectorAll('[data-loc]').forEach((b) =>
    b.addEventListener('click', async () => {
      await setLocale(b.dataset.loc);
      applyStatic(); renderAppbar(); renderSettings(); refresh(); updateScanButton();
    }));
  $('ab-settings').addEventListener('click', () => { renderSettings(); show('settings'); });
  $('hero-title')?.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

/* HELP_SECTIONS from HelpScreen.kt, same order and the same icons, minus the
   Health Connect entry, which has no counterpart on the web. Sections with no
   icon keep the space, so every title starts on the same line. */
const HELP_TOPICS = [
  ['camera', 'camera'], ['manual', 'edit'], ['trends', null], ['history', null],
  ['profile', 'person'], ['risk', null], ['hemo', null],
  ['export', 'share'], ['import', 'download'], ['insights', 'lightbulb'],
];

/* One card per topic, collapsed until asked for -- eleven topics printed in
   full is a wall of text nobody reads. */
function showHelp() {
  const list = $('help-list');
  list.innerHTML = HELP_TOPICS
    .filter(([k]) => t(`help_${k}_title`) !== `help_${k}_title`)
    .map(([k, ico]) => `
      <div class="help-card" data-k="${k}">
        <button class="help-head" type="button" aria-expanded="false"
                aria-controls="help-b-${k}" id="help-h-${k}">
          <span class="help-ico">${ico ? icon(ico, 22) : ''}</span>
          <span class="help-title">${esc(t(`help_${k}_title`))}</span>
          <span class="help-chev">${icon('chevron', 22)}</span>
        </button>
        <div class="help-body" id="help-b-${k}" role="region" aria-labelledby="help-h-${k}">
          <div><p>${esc(t(`help_${k}_body`))}</p></div>
        </div>
      </div>`).join('');

  list.onclick = (e) => {
    const head = e.target.closest('.help-head');
    if (!head) return;
    const card = head.closest('.help-card');
    const open = card.classList.toggle('open');
    head.setAttribute('aria-expanded', String(open));
  };
  show('help');
}

function applyStatic() {
  $('hero-title').textContent = t('app_name');
  $('add-title').textContent = t('validation_save');
  $('profile-title').textContent = t('profile_title');
  $('settings-title').textContent = t('settings_title');
  $('help-title').textContent = t('help_title');
  $('lbl-sys').textContent = t('validation_subtitle_sys');
  $('lbl-dia').textContent = t('validation_subtitle_dia');
  $('lbl-pulse').textContent = t('validation_subtitle_pul');
  $('lbl-when').textContent = t('validation_timestamp');
  $('lbl-notes').textContent = t('validation_notes_label');
  $('btn-save').textContent = t('action_save');
  $('ocr-confirm-text').textContent = t('capture_confirm_values');
  $('btn-cancel').textContent = t('action_cancel');
  renderDataNote();
  document.title = t('app_name');
}

/* The Android stepper: a tap moves one unit, a hold repeats and accelerates.
   Constants are ValidationScreen's -- 400ms before repeat, 120ms between the
   first steps, shaving 8ms each time down to a 30ms floor. */
const HOLD_DELAY_MS = 400, INITIAL_INTERVAL = 120, MIN_INTERVAL_MS = 30, ACCEL_STEP_MS = 8;

function wireStepper(btn) {
  const target = $(btn.dataset.for);
  const delta = Number(btn.dataset.step);
  let holdTimer = null, repeatTimer = null, interval = INITIAL_INTERVAL;

  const bump = () => {
    const lo = Number(target.min), hi = Number(target.max);
    const next = Math.min(hi, Math.max(lo, Number(target.value) + delta));
    if (next === Number(target.value)) return stop();
    target.value = next;
    invalidateOcrConfirmation();
    syncPreview();
  };
  const tick = () => {
    bump();
    interval = Math.max(MIN_INTERVAL_MS, interval - ACCEL_STEP_MS);
    repeatTimer = setTimeout(tick, interval);
  };
  function stop() {
    clearTimeout(holdTimer); clearTimeout(repeatTimer);
    holdTimer = repeatTimer = null; interval = INITIAL_INTERVAL;
  }

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();                    // no focus ring, no text selection
    btn.setPointerCapture?.(e.pointerId);
    bump();                                // a tap is always exactly one step
    holdTimer = setTimeout(tick, HOLD_DELAY_MS);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    btn.addEventListener(ev, stop);
  }
}

function wire() {
  $('fab-add').innerHTML = icon('edit');
  $('fab-add').title = t('dashboard_cd_add_manually');
  $('fab-scan').innerHTML = icon('camera');
  $('fab-scan').title = t('dashboard_cd_scan');
  $('fab-add').addEventListener('click', () => openEntry(null));
  $('fab-scan').addEventListener('click', () => $('scan-file').click());
  $('s-file-global').addEventListener('change', (e) => {
    if (e.target.files[0]) importFile(e.target.files[0]);
    e.target.value = '';
  });
  $('backup-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await restoreDeviceBackup(file);
  });
  // A tap outside any open menu closes it, as a DropdownMenu scrim would.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) {
      document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
    }
  });
  $('btn-add-back').addEventListener('click', () => show('dashboard'));
  $('add-retake').addEventListener('click', () => $('scan-file').click());
  $('btn-cancel').addEventListener('click', () => show('dashboard'));
  $('btn-profile-back').addEventListener('click', () => show('dashboard'));
  $('btn-settings-back').addEventListener('click', () => show('dashboard'));
  $('btn-help-back').addEventListener('click', () => show('dashboard'));
  $('btn-save').addEventListener('click', saveReading);
  $('ocr-confirm-check').addEventListener('change', (event) => {
    setOcrConfirmation(true, event.target.checked);
  });
  $('scan-file').addEventListener('change', (e) => {
    if (e.target.files[0]) scanPhoto(e.target.files[0]);
    e.target.value = '';
  });
  for (const id of ['in-sys', 'in-dia', 'in-pulse']) {
    $(id).addEventListener('input', () => { invalidateOcrConfirmation(); syncPreview(); });
  }
  document.querySelectorAll('.step').forEach(wireStepper);
  // Keep the save bar above the soft keyboard. Sticky positions against the
  // layout viewport, which does not shrink when a keyboard opens, so the
  // difference has to be measured and applied as padding.
  const vv = window.visualViewport;
  if (vv) {
    const track = () => {
      const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', `${Math.round(hidden)}px`);
    };
    vv.addEventListener('resize', track);
    vv.addEventListener('scroll', track);
    track();
  }
  // Typing a value is the third way in, for when neither dragging nor
  // stepping is quick enough -- 210 is a long way from 120 either way.
  for (const [box, slider] of [['val-sys', 'in-sys'], ['val-dia', 'in-dia'],
                               ['val-pulse', 'in-pulse']]) {
    $(box).addEventListener('input', () => {
      const n = Number($(box).value);
      if (!Number.isFinite(n) || $(box).value === '') return;   // mid-edit
      const lo = Number($(slider).min), hi = Number($(slider).max);
      $(slider).value = Math.min(hi, Math.max(lo, n));
      invalidateOcrConfirmation();
      syncPreview();
    });
    // Clamp only on blur, so typing "9" on the way to "95" is not rewritten.
    $(box).addEventListener('blur', () => { $(box).value = $(slider).value; });
  }
}

async function boot() {
  await loadLocale();
  state.ocrAuditEnabled = (await db.getKV(OCR_AUDIT_ENABLED)) === true;
  applyStatic();
  wire();
  updateScanButton();
  renderAppbar();
  setupInstallBanner();
  // Warm the local models without delaying the dashboard or database.
  getOcrReader().catch(() => {});
  state.rangeDays = (await db.getKV('rangeDays')) ?? 30;
  state.mode = (await db.getKV('chartMode')) || 'trend';
  // Defaults on, matching DashboardViewModel's smoothBursts = true.
  state.smooth = (await db.getKV('smoothBursts')) ?? true;
  await refresh();
  show('dashboard');
  installUpdates({
    appName: 'wBP Digitizer',
    toast: (message) => toast(message)
  });
}
boot();
