"use strict";

const state = { data: null, year: "all", noteFilter: "all", showAllSessions: false, charts: {} };
const SESSIONS_PAGE = 15;

const eur = new Intl.NumberFormat("fr-BE", { style: "currency", currency: "EUR" });
const num = (v, d = 0) => new Intl.NumberFormat("fr-BE", { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const kwhFmt = (v) => `${num(v, v >= 100 ? 0 : 1)} kWh`;
const rateFmt = (v) => `${num(v, 4)} €/kWh`;
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MONTHS_LONG = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];

const $ = (sel) => document.querySelector(sel);

function parseDate(s) {
  // API dates are local wall-clock times without a zone.
  const [d, t = "00:00"] = s.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  return new Date(y, m - 1, day, hh, mm);
}
const dayKey = (s) => s.slice(0, 10);
const monthKey = (s) => s.slice(0, 7);
const fmtDay = (s) => { const d = parseDate(s); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const fmtDateTime = (s) => { const d = parseDate(s); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const fmtMonth = (key) => { const [y, m] = key.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };
const shortNumber = (n) => { const m = n.match(/-(\d+)$/); return m ? `n° ${m[1]}` : n; };
function fmtDuration(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h === 0) return m === 0 ? `${s} s` : `${m} min`;
  return `${h} h ${String(m).padStart(2, "0")}`;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const ICONS = {
  pdf: '<svg viewBox="0 0 16 16"><path d="M4 1h5l4 4v10H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Zm5 1v4h4M6 9h5v1H6V9Zm0 2h5v1H6v-1Z" fill-rule="evenodd"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M6 1h4l1 1h3v2H2V2h3l1-1ZM3 5h10l-1 10H4L3 5Zm3 2v6h1V7H6Zm3 0v6h1V7H9Z"/></svg>',
};

/* ---------- Data ---------- */

async function load() {
  const res = await fetch("api/dashboard");
  state.data = await res.json();
  render();
}

function filtered() {
  const { notes, sessions } = state.data;
  if (state.year === "all") return { notes, sessions };
  return {
    notes: notes.filter((n) => n.note_date.startsWith(state.year)),
    sessions: sessions.filter((s) => s.start.startsWith(state.year)),
  };
}

/* ---------- Render ---------- */

function render() {
  const has = state.data.notes.length > 0;
  $("#empty").hidden = has;
  $("#content").hidden = !has;
  $("#export-btn").hidden = !has;
  if (!has) {
    disposeCharts();
    return;
  }
  const years = [...new Set(state.data.sessions.map((s) => s.start.slice(0, 4)))].sort();
  if (state.year !== "all" && !years.includes(state.year)) state.year = "all";
  renderFilters(years);
  const view = filtered();
  renderHeadline(view);
  renderFacts(view);
  renderCharts(view);
  renderNotes(view.notes);
  renderSessions(view.sessions);
}

function renderFilters(years) {
  const el = $("#filters");
  if (years.length < 2) { el.innerHTML = ""; return; }
  el.innerHTML = ["all", ...years].map((y) =>
    `<button class="chip" data-year="${y}" aria-pressed="${state.year === y}">${y === "all" ? "Toute la période" : y}</button>`).join("");
  el.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { state.year = b.dataset.year; render(); }));
}

function renderHeadline({ sessions }) {
  const total = sum(sessions, (s) => s.amount);
  const kwh = sum(sessions, (s) => s.kwh);
  const prefix = state.year === "all" ? "" : `En ${state.year}, `;
  $("#headline").innerHTML =
    `${prefix}Mobiflow t'a remboursé <strong>${esc(eur.format(total))}</strong> pour ` +
    `<strong class="unit">${esc(num(kwh, 0))} kWh</strong> chargés à la maison.`;
}

function renderFacts({ sessions }) {
  const byMonth = {};
  for (const s of sessions) byMonth[monthKey(s.start)] = (byMonth[monthKey(s.start)] ?? 0) + s.amount;
  const months = Object.keys(byMonth);
  const perMonth = months.length ? sum(sessions, (s) => s.amount) / months.length : 0;
  const best = months.sort((a, b) => byMonth[b] - byMonth[a])[0];
  const allSessions = state.data.sessions;
  const currentRate = allSessions.length ? allSessions[allSessions.length - 1].rate : 0;
  const firstRate = allSessions.length ? allSessions[0].rate : 0;
  const rateDelta = firstRate ? (currentRate / firstRate - 1) * 100 : 0;

  const facts = [
    ["Meilleur mois", best ? `${esc(eur.format(byMonth[best]))}<small>${MONTHS_LONG[Number(best.slice(5)) - 1]} ${best.slice(0, 4)}</small>` : "–"],
    ["Par mois en moyenne", `${esc(eur.format(perMonth))}<small>sur ${months.length} mois</small>`],
    ["Tarif actuel", `${esc(num(currentRate, 4))} €<small>${rateDelta ? `${rateDelta > 0 ? "+" : ""}${num(rateDelta, 1)} %` : "par kWh"}</small>`],
  ];
  $("#facts").innerHTML = `<dl style="display:contents">${facts.map(([k, v]) => `<div class="fact"><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
}

/* ---------- Charts ---------- */

function chart(id) {
  if (!state.charts[id]) state.charts[id] = echarts.init(document.getElementById(id), null, { renderer: "svg" });
  return state.charts[id];
}
function disposeCharts() {
  Object.values(state.charts).forEach((c) => c.dispose());
  state.charts = {};
}

function theme() {
  return {
    ink: css("--ink"), ink2: css("--ink-2"), muted: css("--muted"), grid: css("--grid"), axis: css("--axis"),
    surface: css("--surface"), s1: css("--series-1"),
    seq: [css("--seq-0"), css("--seq-1"), css("--seq-2"), css("--seq-3"), css("--seq-4")], font: css("--font"),
  };
}

function base(t) {
  return {
    textStyle: { fontFamily: t.font, color: t.ink2 },
    animationDuration: 500,
    tooltip: {
      backgroundColor: t.surface, borderColor: t.axis, borderWidth: 1, padding: [8, 12],
      textStyle: { color: t.ink, fontFamily: t.font, fontSize: 13 },
      extraCssText: "border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.14);",
    },
  };
}
const axisCommon = (t) => ({
  axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false },
  axisLabel: { color: t.muted, fontSize: 12 }, splitLine: { lineStyle: { color: t.grid } },
});
const tipRow = (label, value) => `<div style="display:flex;justify-content:space-between;gap:16px"><span style="opacity:.7">${label}</span><b style="font-variant-numeric:tabular-nums">${value}</b></div>`;

function renderCharts(view) {
  const t = theme();
  renderCalendar(view.sessions, t);
  renderMonthly(view.sessions, t);
  renderCumul(view.notes, t);
}

function renderCalendar(sessions, t) {
  const el = document.getElementById("chart-calendar");
  const byDay = {};
  for (const s of sessions) {
    const k = dayKey(s.start);
    byDay[k] ??= { kwh: 0, amount: 0, n: 0 };
    byDay[k].kwh += s.kwh; byDay[k].amount += s.amount; byDay[k].n += 1;
  }
  const keys = Object.keys(byDay).sort();
  if (!keys.length) { chart("chart-calendar").clear(); return; }
  const years = [...new Set(keys.map((k) => k.slice(0, 4)))];
  const ranges = years.map((y) => {
    const ks = keys.filter((k) => k.startsWith(y));
    const first = ks[0].slice(0, 7) + "-01";
    const [ly, lm] = ks[ks.length - 1].slice(0, 7).split("-").map(Number);
    const last = new Date(ly, lm, 0);
    return [first, `${ly}-${String(lm).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`];
  });
  const width = el.clientWidth || 800;
  const weeks = Math.max(...ranges.map(([a, b]) => (parseDate(b) - parseDate(a)) / 864e5 / 7 + 2));
  const cell = Math.max(12, Math.min(48, Math.floor((width - 50) / weeks)));
  const calWidth = cell * weeks;
  const left = Math.max(40, Math.round((width - calWidth) / 2));
  const rowH = cell * 7 + 44;
  el.style.height = `${rowH * years.length + 40}px`;
  const c = chart("chart-calendar");
  c.resize();
  const max = Math.max(...Object.values(byDay).map((d) => d.kwh));

  c.setOption({
    ...base(t),
    tooltip: {
      ...base(t).tooltip,
      formatter: (p) => {
        const d = byDay[p.value[0]];
        const head = `<div style="font-weight:650;margin-bottom:4px">${fmtDay(p.value[0])}</div>`;
        if (!d) return `${head}<span style="opacity:.7">Pas de charge</span>`;
        return head + tipRow("Énergie", kwhFmt(d.kwh)) + tipRow("Montant", eur.format(d.amount)) + tipRow("Sessions", d.n);
      },
    },
    visualMap: {
      min: 0, max: Math.ceil(max), type: "continuous", orient: "horizontal", left, bottom: 0,
      itemWidth: 10, itemHeight: 140, calculable: false, text: [`${num(Math.ceil(max))} kWh`, "0"],
      textStyle: { color: t.muted, fontSize: 11 }, inRange: { color: t.seq.slice(1) },
    },
    calendar: ranges.map((range, i) => ({
      range, top: 24 + i * rowH, left, cellSize: cell, orient: "horizontal",
      itemStyle: { color: t.seq[0], borderColor: t.surface, borderWidth: Math.max(2, Math.round(cell / 10)) },
      splitLine: { show: false },
      dayLabel: { firstDay: 1, nameMap: ["D", "L", "M", "M", "J", "V", "S"], color: t.muted, fontSize: 11 },
      monthLabel: { nameMap: MONTHS_LONG.map((m) => m[0].toUpperCase() + m.slice(1)), color: t.ink2, fontSize: 12, fontWeight: 600 },
      yearLabel: { show: years.length > 1, color: t.muted, fontSize: 13 },
    })),
    series: ranges.map((range, i) => {
      const data = [];
      for (let d = parseDate(range[0]); d <= parseDate(range[1]); d.setDate(d.getDate() + 1)) {
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (byDay[k]) data.push([k, +byDay[k].kwh.toFixed(2)]);
      }
      return { type: "heatmap", coordinateSystem: "calendar", calendarIndex: i, data, itemStyle: { borderRadius: 4, borderColor: t.surface, borderWidth: 2 } };
    }),
  }, true);
}

function monthsBetween(a, b) {
  const out = [];
  let [y, m] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  while (y < by || (y === by && m <= bm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

function renderMonthly(sessions, t) {
  const agg = {};
  for (const s of sessions) {
    const k = monthKey(s.start);
    agg[k] ??= { amount: 0, kwh: 0, n: 0 };
    agg[k].amount += s.amount; agg[k].kwh += s.kwh; agg[k].n += 1;
  }
  const keys = Object.keys(agg).sort();
  const months = keys.length ? monthsBetween(keys[0], keys[keys.length - 1]) : [];
  const avg = months.length ? sum(sessions, (s) => s.amount) / months.length : 0;
  chart("chart-monthly").setOption({
    ...base(t),
    grid: { left: 8, right: 8, top: 24, bottom: 4, containLabel: true },
    tooltip: {
      ...base(t).tooltip, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: t.grid, opacity: 0.5 } },
      formatter: (ps) => {
        const k = months[ps[0].dataIndex], a = agg[k] ?? { amount: 0, kwh: 0, n: 0 };
        return `<div style="font-weight:650;margin-bottom:4px">${fmtMonth(k)}</div>` + tipRow("Montant", eur.format(a.amount)) +
          tipRow("Énergie", kwhFmt(a.kwh)) + tipRow("Sessions", a.n);
      },
    },
    xAxis: { type: "category", data: months.map(fmtMonth), ...axisCommon(t), splitLine: { show: false } },
    yAxis: { type: "value", ...axisCommon(t), axisLine: { show: false }, axisLabel: { color: t.muted, formatter: (v) => `${v} €` } },
    series: [{
      type: "bar", name: "Montant", data: months.map((k) => +(agg[k]?.amount ?? 0).toFixed(2)),
      barMaxWidth: 40, itemStyle: { color: t.s1, borderRadius: [4, 4, 0, 0] },
      label: { show: months.length <= 8, position: "top", color: t.ink2, fontSize: 12, formatter: (p) => eur.format(p.value) },
      markLine: months.length > 1 ? {
        silent: true, symbol: "none", lineStyle: { color: t.muted, type: "dashed", width: 1 },
        label: { position: "insideEndTop", color: t.muted, fontSize: 11, formatter: `moyenne ${eur.format(avg)}` },
        data: [{ yAxis: +avg.toFixed(2) }],
      } : undefined,
    }],
  }, true);
}

function renderCumul(notes, t) {
  let acc = 0;
  const points = [...notes].sort((a, b) => a.note_date.localeCompare(b.note_date))
    .map((n) => [n.note_date, +(acc += n.total).toFixed(2), n]);
  chart("chart-cumul").setOption({
    ...base(t),
    grid: { left: 8, right: 64, top: 16, bottom: 4, containLabel: true },
    tooltip: {
      ...base(t).tooltip, trigger: "item",
      formatter: (p) => {
        const n = p.data[2];
        return `<div style="font-weight:650;margin-bottom:4px">Fiche ${esc(shortNumber(n.number))}</div>` +
          tipRow("Émise le", fmtDay(p.data[0])) + tipRow("Montant", eur.format(n.total)) + tipRow("Cumul", eur.format(p.data[1]));
      },
    },
    xAxis: {
      type: "time", minInterval: 28 * 864e5, ...axisCommon(t), splitLine: { show: false },
      axisLabel: { color: t.muted, hideOverlap: true, formatter: (v) => { const d = new Date(v); return d.getDate() === 1 ? MONTHS[d.getMonth()] : ""; } },
    },
    yAxis: { type: "value", ...axisCommon(t), axisLine: { show: false }, axisLabel: { color: t.muted, formatter: (v) => `${v} €` } },
    series: [{
      name: "Cumul", type: "line", step: "end", data: points, symbolSize: 8,
      lineStyle: { width: 2, color: t.s1 }, itemStyle: { color: t.s1, borderColor: t.surface, borderWidth: 2 },
      endLabel: { show: true, color: t.s1, fontSize: 12, fontWeight: 600, formatter: (p) => eur.format(p.value[1]) },
      areaStyle: { color: t.s1, opacity: 0.08 },
    }],
  }, true);
}

/* ---------- Tables ---------- */

function renderNotes(notes) {
  const rows = [...notes].sort((a, b) => b.note_date.localeCompare(a.note_date)).map((n) => {
    return `<tr>
      <td><b>${esc(shortNumber(n.number))}</b> <span class="muted">${esc(n.number)}</span></td>
      <td>${fmtDay(n.note_date)}</td>
      <td class="muted">${fmtDay(n.due_date)}</td>
      <td class="num">${n.session_count}</td>
      <td class="num">${num(n.kwh, 2)}</td>
      <td class="num"><b>${esc(eur.format(n.total))}</b></td>
      <td><div class="row-actions">
        <a class="icon-btn" href="api/notes/${encodeURIComponent(n.number)}/pdf" target="_blank" title="Ouvrir le PDF" aria-label="Ouvrir le PDF">${ICONS.pdf}</a>
        <button class="icon-btn" data-delete="${esc(n.number)}" title="Supprimer la fiche" aria-label="Supprimer la fiche ${esc(n.number)}">${ICONS.trash}</button>
      </div></td>
    </tr>`;
  });
  const tbody = $("#notes-table tbody");
  tbody.innerHTML = rows.join("");
  tbody.querySelectorAll("[data-delete]").forEach((btn) => btn.addEventListener("click", async () => {
    if (!confirm(`Supprimer la fiche ${btn.dataset.delete} et ses sessions ?`)) return;
    const res = await fetch(`api/notes/${encodeURIComponent(btn.dataset.delete)}`, { method: "DELETE" });
    if (!res.ok) return toast("La fiche n'a pas été supprimée.", true);
    toast(`Fiche ${shortNumber(btn.dataset.delete)} supprimée.`);
    load();
  }));
}

function renderSessions(sessions) {
  const select = $("#sessions-filter");
  const numbers = [...new Set(sessions.map((s) => s.note_number))].sort().reverse();
  if (state.noteFilter !== "all" && !numbers.includes(state.noteFilter)) state.noteFilter = "all";
  select.innerHTML = `<option value="all">Toutes les fiches</option>` +
    numbers.map((n) => `<option value="${esc(n)}" ${n === state.noteFilter ? "selected" : ""}>Fiche ${esc(shortNumber(n))}</option>`).join("");
  select.onchange = () => { state.noteFilter = select.value; state.showAllSessions = false; renderSessions(filtered().sessions); };

  const shown = sessions.filter((s) => state.noteFilter === "all" || s.note_number === state.noteFilter).slice().reverse();
  $("#sessions-caption").textContent = `${shown.length} session${shown.length > 1 ? "s" : ""}, ${kwhFmt(sum(shown, (s) => s.kwh))}, ${eur.format(sum(shown, (s) => s.amount))}`;
  const visible = state.showAllSessions ? shown : shown.slice(0, SESSIONS_PAGE);
  const more = $("#sessions-more");
  more.innerHTML = shown.length > SESSIONS_PAGE
    ? `<button class="btn ghost">${state.showAllSessions ? "Afficher moins" : `Afficher les ${shown.length} sessions`}</button>` : "";
  more.querySelector("button")?.addEventListener("click", () => { state.showAllSessions = !state.showAllSessions; renderSessions(filtered().sessions); });
  $("#sessions-table tbody").innerHTML = visible.map((s) => {
    let badge = `<span class="badge good">OK</span>`;
    if (s.status === "covered") badge = `<span class="badge info" title="Ligne affichée à ${esc(eur.format(s.reimbursement))}, incluse au total de la fiche">Corrigée par le total</span>`;
    if (s.status === "unpaid") badge = `<span class="badge critical">Manque ${esc(eur.format(s.gap))}</span>`;
    if (s.duplicate) badge += ` <span class="badge warning">Sur plusieurs fiches</span>`;
    return `<tr>
      <td>${fmtDateTime(s.start)}</td>
      <td class="muted">${fmtDateTime(s.end)}</td>
      <td class="num">${fmtDuration(s.duration_s)}</td>
      <td class="num">${num(s.kwh, 2)}</td>
      <td class="num muted">${num(s.rate, 4)}</td>
      <td class="num"><b>${esc(eur.format(s.amount))}</b></td>
      <td>${badge}</td>
    </tr>`;
  }).join("");
}

/* ---------- Upload ---------- */

function toast(msg, error = false) {
  const el = document.createElement("div");
  el.className = `toast${error ? " error" : ""}`;
  el.textContent = msg;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), error ? 7000 : 4000);
}

async function upload(fileList) {
  const files = [...fileList].filter((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
  if (!files.length) return toast("Aucun PDF dans la sélection. Dépose les fiches Mobiflow au format PDF.", true);
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  let results;
  try {
    const res = await fetch("api/upload", { method: "POST", body: form });
    if (!res.ok) throw new Error(res.statusText);
    results = await res.json();
  } catch (e) {
    return toast(`L'envoi a échoué : ${e.message}`, true);
  }
  const ok = results.filter((r) => r.ok);
  const added = ok.filter((r) => !r.replaced), replaced = ok.filter((r) => r.replaced);
  if (added.length) toast(`${added.length} fiche${added.length > 1 ? "s ajoutées" : " ajoutée"} (${eur.format(sum(added, (r) => r.total))}).`);
  if (replaced.length) toast(`${replaced.length} fiche${replaced.length > 1 ? "s déjà présentes mises" : " déjà présente mise"} à jour.`);
  results.filter((r) => !r.ok).forEach((r) => toast(`${r.filename} n'a pas été lu : ce n'est pas une fiche Mobiflow reconnue.`, true));
  await load();
}

function setupUpload() {
  const onPick = (e) => { upload(e.target.files); e.target.value = ""; };
  $("#file-input").addEventListener("change", onPick);
  document.querySelectorAll(".file-input-alt").forEach((i) => i.addEventListener("change", onPick));

  const overlay = $("#drop-overlay");
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.hidden = false; });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; overlay.hidden = true;
    upload(e.dataTransfer.files);
  });
}

/* ---------- Boot ---------- */

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.data?.notes.length) return;
    Object.values(state.charts).forEach((c) => c.resize());
    renderCalendar(filtered().sessions, theme());
  }, 120);
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (state.data) render(); });

setupUpload();
load().catch(() => toast("Impossible de charger les données. Le serveur répond-il ?", true));
