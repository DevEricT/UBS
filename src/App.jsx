import { useState, useCallback } from "react";
import * as XLSX from "xlsx";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area
} from "recharts";

// ─── Formatters ──────────────────────────────────────────────────────────────

const fmtEur = (v) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v ?? 0);

const fmtEur2 = (v) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v ?? 0);

const fmtPct = (v) => (v >= 0 ? "+" : "") + (v ?? 0).toFixed(2) + " %";

const parseNum = (v) => {
  if (v == null || v === "" || v === " ") return 0;
  const n = parseFloat(String(v).replace(",", "."));
  return isNaN(n) ? 0 : n;
};

const monthKey = (dateStr) => {
  if (!dateStr) return "??";
  const p = String(dateStr).split("-");
  if (p.length === 3) return `${p[1]}/${p[2]}`;
  return String(dateStr).slice(0, 7);
};

const quarterKey = (dateStr) => {
  if (!dateStr) return "??";
  const p = String(dateStr).split("-");
  if (p.length === 3) {
    const q = Math.ceil(Number(p[1]) / 3);
    return `Q${q} ${p[2]}`;
  }
  return dateStr;
};

const yearKey = (dateStr) => {
  if (!dateStr) return "??";
  const p = String(dateStr).split("-");
  return p.length === 3 ? p[2] : dateStr.slice(0, 4);
};

const COLORS = ["#6366f1", "#ec4899", "#14b8a6", "#f59e0b", "#3b82f6", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#f97316"];

const COMPTES_LABELS = {
  "78800/128275EUR": "Compte Principal EUR",
  "78800/114395PEA": "PEA",
  "78800/103879PME": "PEA-PME",
  "78800/153504EUR": "Compte EUR 2",
  "78800/167815EUR": "Compte EUR 3",
};

// ─── Processor ───────────────────────────────────────────────────────────────

function processXLSX(workbook, filterCompte = "ALL") {
  const sheetMain = workbook.Sheets["Montants cumulés"] || workbook.Sheets[workbook.SheetNames[0]];
  const sheetPerf = workbook.Sheets["Performance"];
  const sheetBP   = workbook.Sheets["B P"];

  const toRows = (sheet) => sheet ? XLSX.utils.sheet_to_json(sheet, { defval: null }) : [];

  const mainRows = toRows(sheetMain).filter(r => {
    if (!r["Date"]) return false;
    if (filterCompte === "ALL") return true;
    return r["ID du compte de comptabilisation"] === filterCompte;
  });

  const positions = {};
  const months = {};
  const quarters = {};
  const years = {};
  const assetTypes = {}; // sym -> type d'actif
  let deposits = 0, withdrawals = 0, dividends = 0, interest = 0, cash = 0;
  let fees = { commission: 0, tax: 0, exchange: 0, other: 0 };

  mainRows.forEach((row) => {
    const date = String(row["Date"] || "").trim();
    const mk = monthKey(date);
    const type = String(row["Nom du type de montant"] || "").trim();
    const sym = String(row["Symbole"] || "").trim();
    const name = String(row["Nom instrument"] || sym || "").trim();
    const amt = parseNum(row["Montant dans la devise du compte"]);
    const affecte = String(row["Affecte le solde"] || "").trim().toLowerCase();

    if (!months[mk]) months[mk] = { month: mk, deposits: 0, buys: 0, sells: 0, fees: 0, dividends: 0, interest: 0 };
    const qk = quarterKey(date);
    const yk = yearKey(date);
    if (!quarters[qk]) quarters[qk] = { period: qk, deposits: 0, buys: 0, sells: 0, fees: 0, dividends: 0, interest: 0, pl: 0 };
    if (!years[yk]) years[yk] = { period: yk, deposits: 0, buys: 0, sells: 0, fees: 0, dividends: 0, interest: 0, pl: 0 };

    if (type === "Cash Amount") {
      if (amt > 0) { deposits += amt; months[mk].deposits += amt; quarters[qk].deposits += amt; years[yk].deposits += amt; }
      else { withdrawals += Math.abs(amt); }
      if (affecte === "oui") cash += amt;
      return;
    }
    if (type === "Client Interest") {
      interest += amt; months[mk].interest += amt; quarters[qk].interest += amt; years[yk].interest += amt;
      if (affecte === "oui") cash += amt;
      return;
    }
    if (type === "Corporate Actions - Cash Dividends") {
      dividends += amt; months[mk].dividends += amt; quarters[qk].dividends += amt; years[yk].dividends += amt;
      if (affecte === "oui") cash += amt;
      return;
    }
    if (type === "Commission" || type === "Client Commission Credit") {
      fees.commission += Math.abs(amt); months[mk].fees += Math.abs(amt); quarters[qk].fees += Math.abs(amt); years[yk].fees += Math.abs(amt);
      if (affecte === "oui") cash += amt;
      return;
    }
    if (type === "French Financial Transaction Tax") {
      fees.tax += Math.abs(amt); months[mk].fees += Math.abs(amt); quarters[qk].fees += Math.abs(amt); years[yk].fees += Math.abs(amt);
      if (affecte === "oui") cash += amt;
      return;
    }
    if (type === "Exchange Fee" || type === "External product costs") {
      fees.exchange += Math.abs(amt); months[mk].fees += Math.abs(amt); quarters[qk].fees += Math.abs(amt); years[yk].fees += Math.abs(amt);
      if (affecte === "oui") cash += amt;
      return;
    }
    if (type.includes("Social Tax") || type.includes("Withholding Tax") || type.includes("Advanced Income Tax")) {
      fees.other += Math.abs(amt); months[mk].fees += Math.abs(amt); quarters[qk].fees += Math.abs(amt); years[yk].fees += Math.abs(amt);
      if (affecte === "oui") cash += amt;
      return;
    }
    if ((type === "Share Amount" || type === "Mutual Funds Traded Value") && sym) {
      const assetType = String(row["Type d'actif"] || "Stock").trim();
      if (!positions[sym]) positions[sym] = { sym, name, buys: 0, sells: 0, realized: 0, trades: 0, assetType };
      if (!assetTypes[sym]) assetTypes[sym] = assetType;
      const p = positions[sym];
      p.trades++;
      if (amt < 0) { p.buys += Math.abs(amt); months[mk].buys += Math.abs(amt); quarters[qk].buys += Math.abs(amt); years[yk].buys += Math.abs(amt); }
      else { p.sells += amt; months[mk].sells += amt; quarters[qk].sells += amt; years[yk].sells += amt; }
      p.realized = p.sells - p.buys;
      if (affecte === "oui") cash += amt;
      return;
    }
    if (affecte === "oui") cash += amt;
  });

  // TWR officiel Saxo
  const perfRows = toRows(sheetPerf);
  const perfSeries = perfRows
    .filter(r => r["Date"] && r["AccumulatedTimeWeightedTimeSeries"] != null)
    .map(r => ({
      date: String(r["Date"]),
      twr: parseNum(r["AccumulatedTimeWeightedTimeSeries"]),
      valeur: parseNum(r["AccountValueTimeSeries"]),
    }));
  const lastPerf = perfSeries[perfSeries.length - 1];
  const twr = lastPerf ? lastPerf.twr : 0;
  const valeurTotale = lastPerf ? lastPerf.valeur : 0;

  // P&L net depuis onglet B/P
  const bpRows = toRows(sheetBP).filter(r => {
    if (!r["Date"]) return false;
    if (filterCompte === "ALL") return true;
    return r["ID du compte de comptabilisation"] === filterCompte;
  });
  const plMap = {};
  const ventilation = { Stock: { pl: 0, buys: 0, sells: 0, fees: 0, label: "Actions" }, Etf: { pl: 0, buys: 0, sells: 0, fees: 0, label: "ETFs" }, MutualFund: { pl: 0, buys: 0, sells: 0, fees: 0, label: "OPCVM" } };
  bpRows.forEach(r => {
    const s = String(r["Symbole"] || "").trim();
    if (!s) return;
    const at = String(r["Type d'actif"] || assetTypes[s] || "Stock").trim();
    if (!plMap[s]) plMap[s] = { sym: s, name: String(r["Nom instrument"] || s), pl: 0, assetType: at };
    plMap[s].pl += parseNum(r["Montant dans la devise du compte"]);
    if (!assetTypes[s]) assetTypes[s] = at;
    // Ventilation par catégorie
    if (!ventilation[at]) ventilation[at] = { pl: 0, buys: 0, sells: 0, fees: 0, label: at };
    ventilation[at].pl += parseNum(r["Montant dans la devise du compte"]);
    // P&L par période
    const d = String(r["Date"] || "").trim();
    const qk2 = quarterKey(d);
    const yk2 = yearKey(d);
    if (quarters[qk2]) quarters[qk2].pl += parseNum(r["Montant dans la devise du compte"]);
    if (years[yk2]) years[yk2].pl += parseNum(r["Montant dans la devise du compte"]);
  });
  // Ventilation buys/sells depuis positions
  Object.values(positions).forEach(p => {
    const at = p.assetType || assetTypes[p.sym] || "Stock";
    if (!ventilation[at]) ventilation[at] = { pl: 0, buys: 0, sells: 0, fees: 0, label: at };
    ventilation[at].buys += p.buys;
    ventilation[at].sells += p.sells;
  });
  Object.values(plMap).forEach(({ sym, name, pl }) => {
    if (!positions[sym]) positions[sym] = { sym, name, buys: 0, sells: 0, realized: 0, trades: 0 };
    positions[sym].plNet = pl;
  });

  const totalFees = fees.commission + fees.tax + fees.exchange + fees.other;
  const netDeposits = deposits - withdrawals;
  const netResult = dividends + interest + Object.values(positions).reduce((s, p) => s + (p.plNet ?? p.realized), 0) - totalFees;
  const perfPct = netDeposits > 0 ? (netResult / netDeposits) * 100 : 0;

  const sortedMonths = Object.values(months).sort((a, b) => {
    const [am, ay] = a.month.split("/");
    const [bm, by] = b.month.split("/");
    return ay !== by ? Number(ay) - Number(by) : Number(am) - Number(bm);
  });

  const allRows = XLSX.utils.sheet_to_json(sheetMain, { defval: null });
  const comptes = [...new Set(allRows.map(r => r["ID du compte de comptabilisation"]).filter(Boolean))].sort();

  // Trier quarters et years
  const sortPeriod = (arr, isQuarter) => arr.sort((a, b) => {
    if (isQuarter) {
      const [qa, ya] = [a.period.split(" ")[0], a.period.split(" ")[1]];
      const [qb, yb] = [b.period.split(" ")[0], b.period.split(" ")[1]];
      return ya !== yb ? Number(ya) - Number(yb) : Number(qa[1]) - Number(qb[1]);
    }
    return Number(a.period) - Number(b.period);
  });

  const ventilationArr = Object.values(ventilation).filter(v => v.pl !== 0 || v.buys > 0);

  return {
    kpis: { deposits, withdrawals, netDeposits, dividends, interest, totalFees, fees, netResult, perfPct, cash, twr, valeurTotale },
    positions: Object.values(positions).sort((a, b) => (b.plNet ?? b.realized) - (a.plNet ?? a.realized)),
    months: sortedMonths,
    quarters: sortPeriod(Object.values(quarters), true),
    years: sortPeriod(Object.values(years), false),
    perfSeries: perfSeries.filter((_, i) => i % 3 === 0),
    perfSeriesFull: perfSeries,
    ventilation: ventilationArr,
    comptes,
  };
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color = "indigo", icon, tooltip }) {
  const colors = {
    indigo: "from-indigo-500/20 to-indigo-900/10 border-indigo-500/30",
    pink:   "from-pink-500/20 to-pink-900/10 border-pink-500/30",
    teal:   "from-teal-500/20 to-teal-900/10 border-teal-500/30",
    amber:  "from-amber-500/20 to-amber-900/10 border-amber-500/30",
    green:  "from-green-500/20 to-green-900/10 border-green-500/30",
    red:    "from-red-500/20 to-red-900/10 border-red-500/30",
    violet: "from-violet-500/20 to-violet-900/10 border-violet-500/30",
  };
  return (
    <div className={`bg-gradient-to-br ${colors[color] || colors.indigo} border rounded-2xl p-5`}>
      <div className="flex items-center gap-2 mb-1">
        {icon && <span className="text-base">{icon}</span>}
        <span className="text-xs font-semibold uppercase tracking-widest text-white/50">{label}</span>
        {tooltip && <InfoTooltip text={tooltip} />}
      </div>
      <div className="text-xl font-bold text-white mt-1 truncate">{value}</div>
      {sub && <div className="text-sm text-white/50 mt-1">{sub}</div>}
    </div>
  );
}


// ─── InfoTooltip ──────────────────────────────────────────────────────────────

function InfoTooltip({ text }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", marginLeft: 5 }}>
      <span
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 14, height: 14, borderRadius: "50%", background: "rgba(255,255,255,0.15)",
          color: "rgba(255,255,255,0.6)", fontSize: 9, fontWeight: 700,
          cursor: "help", flexShrink: 0, lineHeight: 1
        }}
      >?</span>
      {show && (
        <span style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%",
          transform: "translateX(-50%)", background: "#1e1b4b",
          border: "1px solid #4338ca", borderRadius: 6, padding: "7px 10px",
          color: "#e0e7ff", fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap",
          width: 220, zIndex: 9999, pointerEvents: "none",
          boxShadow: "0 4px 20px rgba(0,0,0,0.5)"
        }}>{text}</span>
      )}
    </span>
  );
}

// ─── PDF builder ──────────────────────────────────────────────────────────────

function buildPDF(data, filterLabel) {
  const { kpis, positions } = data;
  const top5  = positions.slice(0, 5);
  const flop5 = [...positions].sort((a, b) => (a.plNet ?? a.realized) - (b.plNet ?? b.realized)).slice(0, 5);
  const posRow = (p) => {
    const pl = p.plNet ?? p.realized;
    return `<tr><td>${p.sym}</td><td>${p.name.slice(0, 35)}</td>
      <td class="num">${fmtEur(p.buys)}</td><td class="num">${fmtEur(p.sells)}</td>
      <td class="num ${pl >= 0 ? "pos" : "neg"}">${fmtEur(pl)}</td></tr>`;
  };
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<title>Rapport Saxo ${new Date().toLocaleDateString("fr-FR")}</title>
<style>
  @page{margin:18mm}*{box-sizing:border-box}
  body{font-family:'Segoe UI',sans-serif;background:#f8fafc;color:#1e293b;margin:0;padding:20px}
  .page{background:white;border-radius:12px;padding:36px;max-width:960px;margin:0 auto;box-shadow:0 4px 20px rgba(0,0,0,.08)}
  h1{color:#4f46e5;font-size:26px;margin:0 0 4px}.sub{color:#64748b;font-size:12px;margin-bottom:28px}
  h2{font-size:15px;color:#4f46e5;border-bottom:2px solid #e0e7ff;padding-bottom:5px;margin:28px 0 14px}
  .g4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
  .g3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
  .card{background:#f1f5f9;border-radius:8px;padding:14px}
  .card-l{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
  .card-v{font-size:18px;font-weight:700}.pos{color:#16a34a}.neg{color:#dc2626}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:#4f46e5;color:white;padding:9px 10px;text-align:left;font-weight:600}
  td{padding:7px 10px;border-bottom:1px solid #f1f5f9}tr:nth-child(even) td{background:#f8fafc}
  .num{text-align:right}.footer{text-align:center;color:#94a3b8;font-size:10px;margin-top:36px}
</style></head><body><div class="page">
  <h1>📊 Rapport Portefeuille Saxo</h1>
  <div class="sub">Généré le ${new Date().toLocaleDateString("fr-FR")} · ${filterLabel} · ${positions.length} positions</div>
  <h2>Performance Globale</h2>
  <div class="g4">
    <div class="card"><div class="card-l">Valeur Totale</div><div class="card-v">${fmtEur(kpis.valeurTotale)}</div></div>
    <div class="card"><div class="card-l">Capital Net</div><div class="card-v">${fmtEur(kpis.netDeposits)}</div></div>
    <div class="card"><div class="card-l">Résultat Net</div><div class="card-v ${kpis.netResult >= 0 ? "pos" : "neg"}">${fmtEur(kpis.netResult)}</div></div>
    <div class="card"><div class="card-l">TWR Saxo</div><div class="card-v ${kpis.twr >= 0 ? "pos" : "neg"}">${fmtPct(kpis.twr)}</div></div>
  </div>
  <div class="g4">
    <div class="card"><div class="card-l">Dépôts</div><div class="card-v">${fmtEur(kpis.deposits)}</div></div>
    <div class="card"><div class="card-l">Dividendes</div><div class="card-v">${fmtEur(kpis.dividends)}</div></div>
    <div class="card"><div class="card-l">Intérêts</div><div class="card-v">${fmtEur(kpis.interest)}</div></div>
    <div class="card"><div class="card-l">Frais Totaux</div><div class="card-v neg">-${fmtEur(kpis.totalFees)}</div></div>
  </div>
  <h2>Frais Détaillés</h2>
  <div class="g3">
    <div class="card"><div class="card-l">Commissions</div><div class="card-v neg">-${fmtEur(kpis.fees.commission)}</div></div>
    <div class="card"><div class="card-l">Taxes FFT</div><div class="card-v neg">-${fmtEur(kpis.fees.tax)}</div></div>
    <div class="card"><div class="card-l">Exchange + Autres</div><div class="card-v neg">-${fmtEur(kpis.fees.exchange + kpis.fees.other)}</div></div>
  </div>
  <h2>Top 5 Positions</h2>
  <table><thead><tr><th>Symbole</th><th>Nom</th><th class="num">Achats</th><th class="num">Ventes</th><th class="num">P&L Net</th></tr></thead>
  <tbody>${top5.map(posRow).join("")}</tbody></table>
  <h2>Flop 5 Positions</h2>
  <table><thead><tr><th>Symbole</th><th>Nom</th><th class="num">Achats</th><th class="num">Ventes</th><th class="num">P&L Net</th></tr></thead>
  <tbody>${flop5.map(posRow).join("")}</tbody></table>
  <h2>Toutes les Positions (${positions.length})</h2>
  <table><thead><tr><th>Symbole</th><th>Nom</th><th class="num">Achats</th><th class="num">Ventes</th><th class="num">P&L Net</th></tr></thead>
  <tbody>${positions.map(posRow).join("")}</tbody></table>
  <div class="footer">Saxo Analyzer · ${new Date().toLocaleString("fr-FR")}</div>
</div></body></html>`;
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id: "overview",    label: "📋 Vue d'ensemble" },
  { id: "performance", label: "📈 Performance" },
  { id: "annuel",      label: "📊 Vue Annuelle" },
  { id: "periodes",    label: "📆 Périodes" },
  { id: "positions",   label: "💼 Positions" },
  { id: "trends",      label: "📅 Trends" },
  { id: "fees",        label: "💰 Frais" },
];


// ─── Helpers calculs annuels ──────────────────────────────────────────────────

function buildYearStats(year, data) {
  const yData = data.years.find(y => y.period === String(year));
  if (!yData) return null;

  // TWR annuel depuis perfSeriesFull
  const yearSeries = (data.perfSeriesFull || []).filter(r => {
    const p = String(r.date).split("-");
    return p.length === 3 && p[2] === String(year);
  });

  // Calcul TWR annuel : dernier twr - premier twr de l'année
  let twrAnnuel = 0;
  if (yearSeries.length >= 2) {
    const first = yearSeries[0].twr;
    const last  = yearSeries[yearSeries.length - 1].twr;
    twrAnnuel = last - first;
  } else if (yearSeries.length === 1) {
    twrAnnuel = yearSeries[0].twr;
  }

  // Rendements journaliers pour volatilité
  const dailyReturns = yearSeries
    .map(r => r.dailyPct || 0)
    .filter(v => v !== 0);

  // Volatilité = écart-type * sqrt(252)
  let volatility = 0;
  if (dailyReturns.length > 1) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (dailyReturns.length - 1);
    volatility = Math.sqrt(variance) * Math.sqrt(252);
  }

  // Ratio Sharpe (taux sans risque ~3%)
  const sharpe = volatility > 0 ? ((twrAnnuel - 3) / volatility) : 0;

  // Drawdown max
  let maxDrawdown = 0;
  let peak = -Infinity;
  yearSeries.forEach(r => {
    if (r.valeur > peak) peak = r.valeur;
    const dd = peak > 0 ? ((r.valeur - peak) / peak) * 100 : 0;
    if (dd < maxDrawdown) maxDrawdown = dd;
  });

  // Meilleur / pire mois
  const monthlyTWR = {};
  yearSeries.forEach(r => {
    const p = String(r.date).split("-");
    if (p.length === 3) {
      const mk = `${p[1]}/${p[2]}`;
      monthlyTWR[mk] = r.twr;
    }
  });
  const monthKeys = Object.keys(monthlyTWR).sort((a,b) => {
    const [am, ay] = a.split("/"); const [bm, by] = b.split("/");
    return ay !== by ? Number(ay) - Number(by) : Number(am) - Number(bm);
  });
  const monthlyPerf = [];
  for (let i = 1; i < monthKeys.length; i++) {
    const prev = monthlyTWR[monthKeys[i-1]];
    const curr = monthlyTWR[monthKeys[i]];
    monthlyPerf.push({ month: monthKeys[i], perf: curr - prev });
  }
  if (monthlyPerf.length === 0 && monthKeys.length === 1) {
    monthlyPerf.push({ month: monthKeys[0], perf: monthlyTWR[monthKeys[0]] });
  }
  const bestMonth  = monthlyPerf.length ? monthlyPerf.reduce((a,b) => a.perf > b.perf ? a : b) : null;
  const worstMonth = monthlyPerf.length ? monthlyPerf.reduce((a,b) => a.perf < b.perf ? a : b) : null;

  // Série mensuelle pour graphique
  const monthNames = { "01":"Jan","02":"Fév","03":"Mar","04":"Avr","05":"Mai","06":"Juin","07":"Juil","08":"Aoû","09":"Sep","10":"Oct","11":"Nov","12":"Déc" };
  const monthlySerie = monthlyPerf.map(m => ({
    label: monthNames[m.month.split("/")[0]] || m.month,
    perf: parseFloat(m.perf.toFixed(3)),
    month: m.month,
  }));

  return {
    year,
    ...yData,
    twrAnnuel,
    volatility,
    sharpe,
    maxDrawdown,
    bestMonth,
    worstMonth,
    monthlySerie,
    yearSeries,
    resultat: yData.pl + yData.dividends + yData.interest - yData.fees,
  };
}

// ─── Composant Vue Annuelle ───────────────────────────────────────────────────

function AnnualView({ data }) {
  const availableYears = data.years.map(y => y.period).sort();
  const [yearA, setYearA] = useState(availableYears[availableYears.length - 1] || "");
  const [yearB, setYearB] = useState(availableYears.length > 1 ? availableYears[availableYears.length - 2] : "");
  const [compareMode, setCompareMode] = useState(false);

  const statsA = yearA ? buildYearStats(yearA, data) : null;
  const statsB = compareMode && yearB ? buildYearStats(yearB, data) : null;

  const MONTHS = ["Jan","Fév","Mar","Avr","Mai","Juin","Juil","Aoû","Sep","Oct","Nov","Déc"];

  // Construire série comparative (index mois 1-12)
  const buildCompSerie = (stats) => {
    if (!stats) return [];
    const map = {};
    stats.monthlySerie.forEach(m => {
      const mNum = parseInt(m.month.split("/")[0]);
      map[mNum] = m.perf;
    });
    return Array.from({length: 12}, (_, i) => ({
      month: MONTHS[i],
      perf: map[i+1] ?? null,
    }));
  };

  const serieA = buildCompSerie(statsA);
  const serieB = buildCompSerie(statsB);

  // Merger pour graphique comparatif
  const mergedSerie = MONTHS.map((m, i) => ({
    month: m,
    [yearA]: serieA[i]?.perf ?? null,
    ...(statsB ? { [yearB]: serieB[i]?.perf ?? null } : {}),
  }));

  const StatBlock = ({ label, valueA, valueB, format = "eur", tooltip }) => {
    const fmt = (v) => {
      if (v == null) return "—";
      if (format === "pct") return fmtPct(v);
      if (format === "pct2") return v.toFixed(2) + " %";
      if (format === "ratio") return v.toFixed(2);
      return fmtEur(v);
    };
    const colorClass = (v, fmt) => {
      if (v == null) return "text-white";
      if (fmt === "ratio") return v >= 1 ? "text-green-400" : v >= 0 ? "text-amber-400" : "text-red-400";
      return v >= 0 ? "text-green-400" : "text-red-400";
    };
    return (
      <div className="bg-white/5 border border-white/10 rounded-xl p-4">
        <div className="flex items-center gap-1 mb-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-white/50">{label}</span>
          {tooltip && <InfoTooltip text={tooltip} />}
        </div>
        <div className={`text-lg font-bold ${colorClass(valueA, format)}`}>{fmt(valueA)}</div>
        {statsB && (
          <div className={`text-sm font-semibold mt-1 ${colorClass(valueB, format)}`}>
            <span className="text-white/30 mr-1">{yearB}:</span>{fmt(valueB)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      {/* Sélecteurs */}
      <div className="flex flex-wrap items-center gap-4 bg-white/5 border border-white/10 rounded-2xl p-4">
        <div className="flex items-center gap-2">
          <span className="text-indigo-300 text-sm font-semibold">Année</span>
          <select value={yearA} onChange={e => setYearA(e.target.value)}
            className="px-3 py-2 rounded-xl text-sm bg-white/10 text-white border border-white/20 focus:outline-none focus:border-indigo-400">
            {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <button
          onClick={() => setCompareMode(!compareMode)}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${compareMode ? "bg-indigo-600 text-white" : "bg-white/10 text-indigo-300 border border-white/20"}`}>
          ⚖️ Comparer
        </button>
        {compareMode && (
          <div className="flex items-center gap-2">
            <span className="text-indigo-300 text-sm font-semibold">vs</span>
            <select value={yearB} onChange={e => setYearB(e.target.value)}
              className="px-3 py-2 rounded-xl text-sm bg-white/10 text-white border border-white/20 focus:outline-none focus:border-indigo-400">
              {availableYears.filter(y => y !== yearA).map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        )}
        {statsA && (
          <div className="ml-auto text-indigo-300 text-xs">
            {statsA.monthlySerie.length} mois de données
          </div>
        )}
      </div>

      {statsA && (
        <>
          {/* KPIs principaux */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatBlock label="TWR" valueA={statsA.twrAnnuel} valueB={statsB?.twrAnnuel} format="pct"
              tooltip="Time-Weighted Return annuel : variation du TWR cumulé Saxo entre le 1er et dernier jour de l’annee. Mesure la performance pure indépendamment des flux." />
            <StatBlock label="P&L Réalisé" valueA={statsA.pl} valueB={statsB?.pl}
              tooltip="Bénéfices et pertes réalisés sur les cessions de la période (source onglet B/P Saxo)." />
            <StatBlock label="Résultat Net" valueA={statsA.resultat} valueB={statsB?.resultat}
              tooltip="P&L réalisé + dividendes + intérêts – frais totaux de l’annee." />
            <StatBlock label="Capital Investi" valueA={statsA.deposits} valueB={statsB?.deposits}
              tooltip="Total des dépôts entrants sur l’annee." />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatBlock label="Volatilité Annualisée" valueA={statsA.volatility} valueB={statsB?.volatility} format="pct2"
              tooltip="Écart-type des rendements journaliers × √252. | Mesure l\’amplitude des fluctuations. < 10% = faible, 10-20% = modérée, > 20% = élevée." />
            <StatBlock label="Ratio Sharpe" valueA={statsA.sharpe} valueB={statsB?.sharpe} format="ratio"
              tooltip="(TWR – taux sans risque 3%) / Volatilité. | > 1 = excellente rémunération du risque | 0-1 = acceptable | < 0 = sous-performant vs sans risque" />
            <StatBlock label="Drawdown Max" valueA={statsA.maxDrawdown} valueB={statsB?.maxDrawdown} format="pct2"
              tooltip="Perte maximale depuis un pic de valorisation. Indicateur du risque de perte en capital." />
            <StatBlock label="Frais" valueA={-statsA.fees} valueB={statsB ? -statsB.fees : null}
              tooltip="Total des frais prélevés sur l’annee (commissions + FFT + autres)." />
          </div>

          {/* Meilleur / pire mois */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="bg-white/5 border border-white/10 rounded-xl p-4 flex items-center gap-4">
              <span className="text-2xl">🏆</span>
              <div>
                <div className="text-xs text-white/50 uppercase tracking-widest mb-1 flex items-center gap-1">
                  Meilleur mois {yearA} <InfoTooltip text="Mois avec la progression de TWR la plus forte de l’annee." />
                </div>
                <span className="text-white font-bold">{statsA.bestMonth?.month || "—"}</span>
                <span className="text-green-400 font-bold ml-3">{statsA.bestMonth ? fmtPct(statsA.bestMonth.perf) : "—"}</span>
                {statsB?.bestMonth && <div className="text-sm mt-1 text-white/50">{yearB}: <span className="text-green-400">{statsB.bestMonth.month} {fmtPct(statsB.bestMonth.perf)}</span></div>}
              </div>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-xl p-4 flex items-center gap-4">
              <span className="text-2xl">📉</span>
              <div>
                <div className="text-xs text-white/50 uppercase tracking-widest mb-1 flex items-center gap-1">
                  Pire mois {yearA} <InfoTooltip text="Mois avec la plus forte baisse de TWR de l’annee. Signal d’alerte sur les périodes de stress." />
                </div>
                <span className="text-white font-bold">{statsA.worstMonth?.month || "—"}</span>
                <span className="text-red-400 font-bold ml-3">{statsA.worstMonth ? fmtPct(statsA.worstMonth.perf) : "—"}</span>
                {statsB?.worstMonth && <div className="text-sm mt-1 text-white/50">{yearB}: <span className="text-red-400">{statsB.worstMonth.month} {fmtPct(statsB.worstMonth.perf)}</span></div>}
              </div>
            </div>
          </div>

          {/* Graphique TWR mensuel comparatif */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <h3 className="text-white font-semibold mb-4 flex items-center text-sm uppercase tracking-widest">
              Performance Mensuelle (TWR Δ%)
              <InfoTooltip text={"Variation mensuelle du TWR cumulé Saxo.
Barre verte = mois positif, rouge = mois négatif.
" + (statsB ? `Comparaison ${yearA} vs ${yearB}.` : "Activer 'Comparer' pour superposer une autre année.")} />
            </h3>
            {compareMode && statsB ? (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={mergedSerie} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
                  <XAxis dataKey="month" tick={{ fill: "#a5b4fc", fontSize: 11 }} />
                  <YAxis tick={{ fill: "#a5b4fc", fontSize: 11 }} tickFormatter={(v) => v != null ? v.toFixed(1)+"%" : ""} />
                  <Tooltip formatter={(v) => v != null ? fmtPct(v) : "—"} contentStyle={{ background: "#1e1b4b", border: "1px solid #4338ca", borderRadius: 8, color: "#fff" }} itemStyle={{ color: "#fff" }} labelStyle={{ color: "#fff" }} />
                  <Legend wrapperStyle={{ color: "#a5b4fc" }} />
                  <Bar dataKey={yearA} name={String(yearA)} radius={[3,3,0,0]}>
                    {mergedSerie.map((entry, i) => <Cell key={i} fill={(entry[yearA] ?? 0) >= 0 ? "#10b981" : "#ef4444"} />)}
                  </Bar>
                  <Bar dataKey={yearB} name={String(yearB)} radius={[3,3,0,0]} fill="#6366f1" opacity={0.7}>
                    {mergedSerie.map((entry, i) => <Cell key={i} fill={(entry[yearB] ?? 0) >= 0 ? "#6366f1" : "#ec4899"} opacity={0.75} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={statsA.monthlySerie}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
                  <XAxis dataKey="label" tick={{ fill: "#a5b4fc", fontSize: 11 }} />
                  <YAxis tick={{ fill: "#a5b4fc", fontSize: 11 }} tickFormatter={(v) => v.toFixed(1)+"%"} />
                  <Tooltip formatter={(v) => fmtPct(v)} contentStyle={{ background: "#1e1b4b", border: "1px solid #4338ca", borderRadius: 8, color: "#fff" }} itemStyle={{ color: "#fff" }} labelStyle={{ color: "#fff" }} />
                  <Bar dataKey="perf" name="TWR mensuel" radius={[3,3,0,0]}>
                    {statsA.monthlySerie.map((entry, i) => <Cell key={i} fill={entry.perf >= 0 ? "#10b981" : "#ef4444"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Tableau mensuel détaillé */}
          <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
            <div className="p-4 border-b border-white/10 text-indigo-300 text-sm flex items-center gap-1">
              Détail mensuel {yearA}{statsB ? ` vs ${yearB}` : ""}
              <InfoTooltip text="Variation de TWR mois par mois. Un mois sans donnée (—) signifie absence de transactions ou de données de performance dans le fichier." />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-white/5">
                    <th className="text-left text-indigo-300 py-3 px-4 font-semibold text-xs uppercase">Mois</th>
                    <th className="text-right text-indigo-300 py-3 px-4 font-semibold text-xs uppercase">TWR {yearA}</th>
                    {statsB && <th className="text-right text-indigo-300 py-3 px-4 font-semibold text-xs uppercase">TWR {yearB}</th>}
                    {statsB && <th className="text-right text-indigo-300 py-3 px-4 font-semibold text-xs uppercase">Écart</th>}
                  </tr>
                </thead>
                <tbody>
                  {MONTHS.map((m, i) => {
                    const a = serieA[i]?.perf;
                    const b = serieB[i]?.perf;
                    const diff = a != null && b != null ? a - b : null;
                    return (
                      <tr key={m} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                        <td className="py-2.5 px-4 text-white font-semibold">{m}</td>
                        <td className={`py-2.5 px-4 text-right font-semibold ${a == null ? "text-white/30" : a >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {a != null ? fmtPct(a) : "—"}
                        </td>
                        {statsB && <td className={`py-2.5 px-4 text-right font-semibold ${b == null ? "text-white/30" : b >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {b != null ? fmtPct(b) : "—"}
                        </td>}
                        {statsB && <td className={`py-2.5 px-4 text-right font-bold ${diff == null ? "text-white/30" : diff >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {diff != null ? fmtPct(diff) : "—"}
                        </td>}
                      </tr>
                    );
                  })}
                  {/* Ligne total */}
                  <tr className="bg-white/10 font-bold">
                    <td className="py-3 px-4 text-white">Total</td>
                    <td className={`py-3 px-4 text-right text-base ${statsA.twrAnnuel >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtPct(statsA.twrAnnuel)}</td>
                    {statsB && <td className={`py-3 px-4 text-right text-base ${statsB.twrAnnuel >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtPct(statsB.twrAnnuel)}</td>}
                    {statsB && <td className={`py-3 px-4 text-right text-base ${(statsA.twrAnnuel - statsB.twrAnnuel) >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtPct(statsA.twrAnnuel - statsB.twrAnnuel)}</td>}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function SaxoAnalyzer() {
  const [workbook, setWorkbook] = useState(null);
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(false);
  const [tab, setTab]           = useState("overview");
  const [error, setError]       = useState(null);
  const [filterCompte, setFilterCompte] = useState("ALL");
  const [fileName, setFileName] = useState("");

  const handleFile = useCallback((file) => {
    if (!file) return;
    setLoading(true); setError(null); setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        setWorkbook(wb);
        setData(processXLSX(wb, "ALL"));
        setFilterCompte("ALL");
      } catch (err) {
        setError("Erreur lecture : " + err.message);
      }
      setLoading(false);
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const handleFilterChange = (compte) => {
    setFilterCompte(compte);
    if (workbook) setData(processXLSX(workbook, compte));
  };

  const exportPDF = () => {
    if (!data) return;
    const label = filterCompte === "ALL" ? "Tous les comptes" : (COMPTES_LABELS[filterCompte] || filterCompte);
    const w = window.open("", "_blank");
    w.document.write(buildPDF(data, label));
    w.document.close();
    setTimeout(() => w.print(), 600);
  };

  const exportCSV = () => {
    if (!data) return;
    const { kpis, positions } = data;
    const rows = [
      ["KPI", "Valeur"],
      ["Valeur Totale Saxo", kpis.valeurTotale],
      ["Capital Net Investi", kpis.netDeposits],
      ["Résultat Net", kpis.netResult.toFixed(2)],
      ["TWR Saxo", kpis.twr.toFixed(4) + "%"],
      ["Dépôts", kpis.deposits], ["Retraits", kpis.withdrawals],
      ["Dividendes", kpis.dividends], ["Intérêts", kpis.interest],
      ["Commissions", kpis.fees.commission], ["Taxes FFT", kpis.fees.tax],
      ["Exchange Fees", kpis.fees.exchange], ["Autres frais", kpis.fees.other],
      ["Cash", kpis.cash], [],
      ["Symbole", "Nom", "Achats", "Ventes", "P&L Net"],
      ...positions.map((p) => [p.sym, p.name, p.buys.toFixed(2), p.sells.toFixed(2), (p.plNet ?? p.realized).toFixed(2)]),
    ];
    const blob = new Blob(["\uFEFF" + rows.map(r => r.join(";")).join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `saxo_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg, #0a0a1a 0%, #1a1040 50%, #0a1a2a 100%)" }} className="p-5">
      <div className="max-w-7xl mx-auto">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-7">
          <div>
            <h1 className="text-3xl font-bold text-white tracking-tight">📊 Saxo Analyzer</h1>
            {fileName && <p className="text-indigo-400 text-xs mt-1">{fileName}</p>}
          </div>
          {data && (
            <div className="flex gap-2 flex-wrap items-center">
              <select value={filterCompte} onChange={(e) => handleFilterChange(e.target.value)}
                className="px-3 py-2 rounded-xl text-sm bg-white/10 text-white border border-white/20 focus:outline-none focus:border-indigo-400">
                <option value="ALL">Tous les comptes</option>
                {data.comptes.map((c) => <option key={c} value={c}>{COMPTES_LABELS[c] || c}</option>)}
              </select>
              <button onClick={exportCSV} className="px-4 py-2 rounded-xl text-sm font-semibold text-white border border-white/20 hover:bg-white/10 transition-all">⬇️ CSV</button>
              <button onClick={exportPDF} className="px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-all shadow-lg">📄 PDF</button>
              <button onClick={() => { setData(null); setWorkbook(null); setFileName(""); }} className="px-3 py-2 rounded-xl text-xs text-white/40 hover:text-white/70 hover:bg-white/5 transition-all">🔄</button>
            </div>
          )}
        </div>

        {/* Upload */}
        {!data && !loading && (
          <label className="block cursor-pointer">
            <div className="border-2 border-dashed border-indigo-500/40 rounded-3xl p-16 text-center hover:border-indigo-400 transition-all hover:bg-white/5"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}>
              <div className="text-6xl mb-4">📂</div>
              <p className="text-white text-xl font-semibold mb-2">Glissez votre fichier XLSX Saxo ici</p>
              <p className="text-indigo-300 text-sm mb-1">ou cliquez pour sélectionner</p>
              <p className="text-indigo-500 text-xs font-mono mt-2">AggregatedAmounts_XXXXXXXX_YYYY-MM-DD_YYYY-MM-DD.xlsx</p>
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => handleFile(e.target.files[0])} />
            </div>
          </label>
        )}

        {loading && <div className="text-center py-24 text-indigo-300 text-xl animate-pulse">⏳ Analyse en cours…</div>}
        {error   && <div className="bg-red-900/30 border border-red-500/50 rounded-2xl p-6 text-red-300 text-center">❌ {error}</div>}

        {data && !loading && (
          <>
            {/* Tabs */}
            <div className="flex gap-2 flex-wrap mb-5 bg-white/5 rounded-2xl p-1.5 border border-white/10">
              {TABS.map((t) => (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className={`px-4 py-2 rounded-xl font-semibold text-sm transition-all whitespace-nowrap ${tab === t.id ? "bg-indigo-600 text-white shadow-lg" : "text-indigo-200 hover:bg-white/10"}`}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* Overview */}
            {tab === "overview" && (
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <KpiCard label="Valeur Totale" value={fmtEur(data.kpis.valeurTotale)} icon="💎" color="violet" tooltip="Valeur totale du portefeuille au dernier jour calculé par Saxo (onglet Performance du fichier)." />
                  <KpiCard label="Capital Net Investi" value={fmtEur(data.kpis.netDeposits)} icon="💶" color="indigo" tooltip="Dépôts cumulés moins les retraits. Représente le capital réellement engagé depuis l’ouverture du compte." />
                  <KpiCard label="Résultat Net" value={fmtEur(data.kpis.netResult)} sub={fmtPct(data.kpis.perfPct)} icon="📈" color={data.kpis.netResult >= 0 ? "green" : "red"} tooltip="P&L réalisé + dividendes + intérêts – frais totaux. Le % est calculé sur le capital net investi." />
                  <KpiCard label="TWR Saxo" value={fmtPct(data.kpis.twr)} icon="🎯" color={data.kpis.twr >= 0 ? "teal" : "red"} tooltip="Time-Weighted Return : mesure la performance pure des investissements indépendamment des entrées/sorties de capital. Chiffre officiel Saxo." />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <KpiCard label="Dépôts" value={fmtEur(data.kpis.deposits)} icon="⬆️" color="indigo" tooltip="Total des virements entrants (Cash Amount positifs) sur la période analysée." />
                  <KpiCard label="Retraits" value={fmtEur(data.kpis.withdrawals)} icon="⬇️" color="pink" tooltip="Total des virements sortants sur la période analysée." />
                  <KpiCard label="Dividendes" value={fmtEur(data.kpis.dividends)} icon="🌱" color="green" tooltip="Dividendes en espèces versés par les actions détenues (Corporate Actions - Cash Dividends)." />
                  <KpiCard label="Intérêts" value={fmtEur(data.kpis.interest)} icon="⚡" color="teal" tooltip="Intérêts créditeurs reçus sur les liquidités du compte (Client Interest)." />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <KpiCard label="Frais Totaux" value={"-" + fmtEur(data.kpis.totalFees)} icon="🏦" color="amber" tooltip="Somme de toutes les charges : commissions, taxe FFT, frais de change, taxes sociales." />
                  <KpiCard label="Commissions" value={"-" + fmtEur(data.kpis.fees.commission)} icon="📋" color="amber" tooltip="Frais de courtage facturés par Saxo sur chaque ordre exécuté." />
                  <KpiCard label="Taxes FFT" value={"-" + fmtEur(data.kpis.fees.tax)} icon="🏛️" color="amber" tooltip="Taxe sur les Transactions Financières française (0,3%) applicable aux achats d’actions françaises de plus de 1 milliard de capitalisation." />
                  <KpiCard label="Ratio frais/capital" value={data.kpis.netDeposits > 0 ? ((data.kpis.totalFees / data.kpis.netDeposits) * 100).toFixed(2) + " %" : "N/A"} icon="⚖️" color="amber" tooltip="Frais totaux divisés par le capital net investi. Indicateur du coût de gestion du portefeuille." />
                </div>
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h3 className="text-white font-semibold mb-4 flex items-center">Répartition des Frais<InfoTooltip text="Ventilation des frais par nature : courtage (commissions), taxe FFT, frais d’échange de devises, et autres (taxes sociales, retenues)." /></h3>
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie data={[
                        { name: "Commissions", value: Math.round(data.kpis.fees.commission) },
                        { name: "Taxes FFT", value: Math.round(data.kpis.fees.tax) },
                        { name: "Exchange", value: Math.round(data.kpis.fees.exchange) },
                        { name: "Autres", value: Math.round(data.kpis.fees.other) },
                      ].filter(d => d.value > 0)} cx="50%" cy="50%" outerRadius={85} dataKey="value"
                        label={({ name, percent }) => percent > 0.03 ? `${name} ${(percent * 100).toFixed(0)}%` : ""}>
                        {[0,1,2,3].map((i) => <Cell key={i} fill={COLORS[i]} />)}
                      </Pie>
                      <Tooltip formatter={(v) => fmtEur(v)} contentStyle={{ background: "#1e1b4b", border: "1px solid #4338ca", borderRadius: 8, color: "#fff" }} itemStyle={{ color: "#fff" }} labelStyle={{ color: "#fff" }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Performance */}
            {tab === "performance" && (
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <KpiCard label="TWR (Saxo officiel)" value={fmtPct(data.kpis.twr)} icon="🎯" color="teal" sub="Time-Weighted Return" tooltip="Rendement pondéré dans le temps : élimine l’effet des dépôts/retraits pour mesurer la pure performance de la gestion. Standard CFA/GIPS." />
                  <KpiCard label="Valeur Portefeuille" value={fmtEur(data.kpis.valeurTotale)} icon="💎" color="violet" tooltip="Valeur de marché totale du portefeuille au dernier jour disponible dans le fichier." />
                  <KpiCard label="Résultat Net" value={fmtEur(data.kpis.netResult)} icon="📊" color={data.kpis.netResult >= 0 ? "green" : "red"} tooltip="P&L réalisé (onglet B/P Saxo) + dividendes + intérêts – frais totaux." />
                </div>
                {/* Ventilation B/P par catégorie */}
                {data.ventilation && data.ventilation.length > 0 && (
                  <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                    <h3 className="text-white font-semibold mb-5 text-sm uppercase tracking-widest flex items-center">Ventilation B/P par Catégorie<InfoTooltip text="B/P = Bénéfices et Pertes réalisés. Décomposition du résultat par type d’instrument : Actions (Stock), ETFs, OPCVM (Mutual Funds). Source : onglet ’B P’ du fichier Saxo." /></h3>
                    <div className="overflow-x-auto mb-5">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-white/5">
                            {["Catégorie","Achats","Ventes","P&L Net","% du total"].map(h => (
                              <th key={h} className={`py-3 px-4 font-semibold text-indigo-300 text-xs uppercase tracking-wide ${h === "Catégorie" ? "text-left" : "text-right"}`}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {data.ventilation.map((v, i) => {
                            const totalPL = data.ventilation.reduce((s, x) => s + x.pl, 0);
                            const pct = totalPL !== 0 ? (v.pl / Math.abs(totalPL)) * 100 : 0;
                            return (
                              <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                                <td className="py-3 px-4 text-white font-semibold flex items-center gap-2">
                                  <span className="inline-block w-2 h-2 rounded-full" style={{background: COLORS[i]}}></span>
                                  {v.label}
                                </td>
                                <td className="py-3 px-4 text-right text-white">{fmtEur(v.buys)}</td>
                                <td className="py-3 px-4 text-right text-white">{fmtEur(v.sells)}</td>
                                <td className={`py-3 px-4 text-right font-bold ${v.pl >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtEur(v.pl)}</td>
                                <td className={`py-3 px-4 text-right font-semibold ${v.pl >= 0 ? "text-green-400" : "text-red-400"}`}>{pct.toFixed(1)} %</td>
                              </tr>
                            );
                          })}
                          <tr className="bg-white/5 font-bold">
                            <td className="py-3 px-4 text-white">Total</td>
                            <td className="py-3 px-4 text-right text-white">{fmtEur(data.ventilation.reduce((s,v)=>s+v.buys,0))}</td>
                            <td className="py-3 px-4 text-right text-white">{fmtEur(data.ventilation.reduce((s,v)=>s+v.sells,0))}</td>
                            <td className={`py-3 px-4 text-right font-bold text-base ${data.ventilation.reduce((s,v)=>s+v.pl,0) >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtEur(data.ventilation.reduce((s,v)=>s+v.pl,0))}</td>
                            <td className="py-3 px-4 text-right text-indigo-300">100 %</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={data.ventilation} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
                        <XAxis type="number" tick={{ fill: "#a5b4fc", fontSize: 11 }} tickFormatter={(v) => (v/1000).toFixed(0)+"k"} />
                        <YAxis type="category" dataKey="label" tick={{ fill: "#a5b4fc", fontSize: 12 }} width={70} />
                        <Tooltip formatter={(v) => fmtEur(v)} contentStyle={{ background: "#1e1b4b", border: "1px solid #4338ca", borderRadius: 8, color: "#fff" }} itemStyle={{ color: "#fff" }} labelStyle={{ color: "#fff" }} />
                        <Bar dataKey="pl" name="P&L Net" radius={[0,4,4,0]}>
                          {data.ventilation.map((entry, index) => (
                            <Cell key={index} fill={entry.pl >= 0 ? "#10b981" : "#ef4444"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {data.perfSeries.length > 0 && (
                  <>
                    <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                      <h3 className="text-white font-semibold mb-4 flex items-center">TWR Cumulé<InfoTooltip text="Time-Weighted Return cumulé depuis le début de la période. Mesure la performance de la gestion indépendamment des flux de trésorerie. Source : onglet ’Performance’ du fichier Saxo." /></h3>
                      <ResponsiveContainer width="100%" height={260}>
                        <AreaChart data={data.perfSeries}>
                          <defs>
                            <linearGradient id="twrGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                              <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
                          <XAxis dataKey="date" tick={{ fill: "#a5b4fc", fontSize: 10 }} tickCount={8} />
                          <YAxis tick={{ fill: "#a5b4fc", fontSize: 10 }} tickFormatter={(v) => v.toFixed(1) + "%"} />
                          <Tooltip formatter={(v) => v.toFixed(3) + "%"} contentStyle={{ background: "#1e1b4b", border: "1px solid #4338ca", borderRadius: 8, color: "#fff" }} itemStyle={{ color: "#fff" }} labelStyle={{ color: "#fff" }} />
                          <Area type="monotone" dataKey="twr" name="TWR %" stroke="#6366f1" strokeWidth={2} fill="url(#twrGrad)" dot={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                      <h3 className="text-white font-semibold mb-4 flex items-center">Valeur du Portefeuille<InfoTooltip text="Valeur totale du compte jour par jour incluant liquidités et positions ouvertes valorisées au prix de marché. Source : onglet ’Performance’ du fichier Saxo." /></h3>
                      <ResponsiveContainer width="100%" height={230}>
                        <AreaChart data={data.perfSeries}>
                          <defs>
                            <linearGradient id="valGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.4} />
                              <stop offset="95%" stopColor="#14b8a6" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
                          <XAxis dataKey="date" tick={{ fill: "#a5b4fc", fontSize: 10 }} tickCount={8} />
                          <YAxis tick={{ fill: "#a5b4fc", fontSize: 10 }} tickFormatter={(v) => (v / 1000).toFixed(0) + "k"} />
                          <Tooltip formatter={(v) => fmtEur(v)} contentStyle={{ background: "#1e1b4b", border: "1px solid #4338ca", borderRadius: 8, color: "#fff" }} itemStyle={{ color: "#fff" }} labelStyle={{ color: "#fff" }} />
                          <Area type="monotone" dataKey="valeur" name="Valeur €" stroke="#14b8a6" strokeWidth={2} fill="url(#valGrad)" dot={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                    <h3 className="text-white font-semibold mb-4 flex items-center">🏆 Top 10 P&L<InfoTooltip text="10 positions ayant généré le plus grand gain réalisé sur la période. P&L = Prix de vente – Prix d’achat (hors frais), source onglet B/P Saxo." /></h3>
                    <div className="space-y-2">
                      {data.positions.slice(0, 10).map((p, i) => {
                        const pl = p.plNet ?? p.realized;
                        return (
                          <div key={i} className="flex justify-between items-center py-1.5 border-b border-white/5">
                            <span className="text-indigo-200 font-mono text-sm">{p.sym}</span>
                            <span className={`font-semibold text-sm ${pl >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtEur(pl)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                    <h3 className="text-white font-semibold mb-4 flex items-center">📉 Flop 10 P&L<InfoTooltip text="10 positions ayant généré la plus grande perte réalisée. Utile pour analyser les arbitrages défavorables et les stop-loss." /></h3>
                    <div className="space-y-2">
                      {[...data.positions].sort((a, b) => (a.plNet ?? a.realized) - (b.plNet ?? b.realized)).slice(0, 10).map((p, i) => {
                        const pl = p.plNet ?? p.realized;
                        return (
                          <div key={i} className="flex justify-between items-center py-1.5 border-b border-white/5">
                            <span className="text-indigo-200 font-mono text-sm">{p.sym}</span>
                            <span className={`font-semibold text-sm ${pl >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtEur(pl)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Vue Annuelle */}
            {tab === "annuel" && (
              <AnnualView data={data} />
            )}

            {/* Périodes */}
            {tab === "periodes" && (
              <div className="space-y-6">
                {/* Sélecteur vue */}
                <div className="flex gap-3 mb-2">
                  <span className="text-indigo-300 text-sm self-center">Afficher par :</span>
                </div>

                {/* Par année */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h3 className="text-white font-semibold mb-5 text-sm uppercase tracking-widest flex items-center">Performance Annuelle<InfoTooltip text="Résultat = P&L réalisé + dividendes + intérêts – frais de l’annee. | Perf % = Résultat / Dépôts de l’année (rendement simple sur capital investi dans la période)." /></h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-white/5">
                          {["Année","Dépôts","Achats","Ventes","P&L Net","Frais","Dividendes","Résultat","Perf %"].map(h => (
                            <th key={h} className={`py-3 px-4 font-semibold text-indigo-300 text-xs uppercase tracking-wide ${h === "Année" ? "text-left" : "text-right"}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.years.map((y, i) => {
                          const resultat = y.pl + y.dividends + y.interest - y.fees;
                          return (
                            <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                              <td className="py-3 px-4 text-white font-bold text-base">{y.period}</td>
                              <td className="py-3 px-4 text-right text-indigo-200">{fmtEur(y.deposits)}</td>
                              <td className="py-3 px-4 text-right text-white">{fmtEur(y.buys)}</td>
                              <td className="py-3 px-4 text-right text-white">{fmtEur(y.sells)}</td>
                              <td className={`py-3 px-4 text-right font-semibold ${y.pl >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtEur(y.pl)}</td>
                              <td className="py-3 px-4 text-right text-amber-400">{y.fees > 0 ? "-" + fmtEur(y.fees) : "—"}</td>
                              <td className="py-3 px-4 text-right text-teal-400">{y.dividends > 0 ? fmtEur(y.dividends + y.interest) : "—"}</td>
                              <td className={`py-3 px-4 text-right font-bold text-base ${resultat >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtEur(resultat)}</td>
                              <td className={`py-3 px-4 text-right font-bold text-base ${resultat >= 0 ? "text-green-400" : "text-red-400"}`}>{y.deposits > 0 ? fmtPct(resultat / y.deposits * 100) : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Graphique annuel P&L */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h3 className="text-white font-semibold mb-4 text-sm uppercase tracking-widest">P&L Net par Année</h3>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={data.years}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
                      <XAxis dataKey="period" tick={{ fill: "#a5b4fc", fontSize: 12 }} />
                      <YAxis tick={{ fill: "#a5b4fc", fontSize: 11 }} tickFormatter={(v) => (v/1000).toFixed(0)+"k"} />
                      <Tooltip formatter={(v) => fmtEur(v)} contentStyle={{ background: "#1e1b4b", border: "1px solid #4338ca", borderRadius: 8, color: "#fff" }} itemStyle={{ color: "#fff" }} labelStyle={{ color: "#fff" }} />
                      <Legend wrapperStyle={{ color: "#a5b4fc" }} />
                      <Bar dataKey="pl" name="P&L Net" radius={[4,4,0,0]}>
                        {data.years.map((entry, index) => (
                          <Cell key={index} fill={entry.pl >= 0 ? "#10b981" : "#ef4444"} />
                        ))}
                      </Bar>
                      <Bar dataKey="fees" name="Frais" radius={[4,4,0,0]} fill="#f59e0b" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Par trimestre */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h3 className="text-white font-semibold mb-5 text-sm uppercase tracking-widest flex items-center">Performance Trimestrielle<InfoTooltip text="Découpage en 4 trimestres : Q1 (janv-mars), Q2 (avr-juin), Q3 (juil-sept), Q4 (oct-déc). | Permet d’identifier les saisonnalités et les périodes de sur/sous-performance." /></h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-white/5">
                          {["Trimestre","Dépôts","Achats","Ventes","P&L Net","Frais","Dividendes","Résultat","Perf %"].map(h => (
                            <th key={h} className={`py-3 px-4 font-semibold text-indigo-300 text-xs uppercase tracking-wide ${h === "Trimestre" ? "text-left" : "text-right"}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.quarters.map((q, i) => {
                          const resultat = q.pl + q.dividends + q.interest - q.fees;
                          return (
                            <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                              <td className="py-2.5 px-4 text-white font-bold">{q.period}</td>
                              <td className="py-2.5 px-4 text-right text-indigo-200">{fmtEur(q.deposits)}</td>
                              <td className="py-2.5 px-4 text-right text-white">{fmtEur(q.buys)}</td>
                              <td className="py-2.5 px-4 text-right text-white">{fmtEur(q.sells)}</td>
                              <td className={`py-2.5 px-4 text-right font-semibold ${q.pl >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtEur(q.pl)}</td>
                              <td className="py-2.5 px-4 text-right text-amber-400">{q.fees > 0 ? "-" + fmtEur(q.fees) : "—"}</td>
                              <td className="py-2.5 px-4 text-right text-teal-400">{q.dividends > 0 ? fmtEur(q.dividends + q.interest) : "—"}</td>
                              <td className={`py-2.5 px-4 text-right font-bold ${resultat >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtEur(resultat)}</td>
                              <td className={`py-2.5 px-4 text-right font-bold ${resultat >= 0 ? "text-green-400" : "text-red-400"}`}>{q.deposits > 0 ? fmtPct(resultat / q.deposits * 100) : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Graphique trimestriel */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h3 className="text-white font-semibold mb-4 text-sm uppercase tracking-widest">P&L Net par Trimestre</h3>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={data.quarters}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
                      <XAxis dataKey="period" tick={{ fill: "#a5b4fc", fontSize: 10 }} />
                      <YAxis tick={{ fill: "#a5b4fc", fontSize: 11 }} tickFormatter={(v) => (v/1000).toFixed(0)+"k"} />
                      <Tooltip formatter={(v) => fmtEur(v)} contentStyle={{ background: "#1e1b4b", border: "1px solid #4338ca", borderRadius: 8, color: "#fff" }} itemStyle={{ color: "#fff" }} labelStyle={{ color: "#fff" }} />
                      <Legend wrapperStyle={{ color: "#a5b4fc" }} />
                      <Bar dataKey="pl" name="P&L Net" radius={[4,4,0,0]}>
                        {data.quarters.map((entry, index) => (
                          <Cell key={index} fill={entry.pl >= 0 ? "#10b981" : "#ef4444"} />
                        ))}
                      </Bar>
                      <Bar dataKey="deposits" name="Dépôts" radius={[4,4,0,0]} fill="#14b8a6" />
                      <Bar dataKey="fees" name="Frais" radius={[4,4,0,0]} fill="#f59e0b" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Positions */}
            {tab === "positions" && (
              <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
                <div className="p-4 border-b border-white/10 text-indigo-300 text-sm flex items-center gap-1">{data.positions.length} positions · triées par P&L Net réalisé<InfoTooltip text="P&L Net = somme des gains/pertes journaliers réalisés par position (source onglet ’B P’ de Saxo). Les positions avec P&L = 0 sont des positions encore ouvertes ou des instruments sans cession." /></div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-white/5">
                        <th className="text-left text-indigo-300 py-3 px-4 font-semibold">Symbole</th>
                        <th className="text-left text-indigo-300 py-3 px-4 font-semibold">Nom</th>
                        <th className="text-right text-indigo-300 py-3 px-4 font-semibold">Achats</th>
                        <th className="text-right text-indigo-300 py-3 px-4 font-semibold">Ventes</th>
                        <th className="text-right text-indigo-300 py-3 px-4 font-semibold">P&L Net</th>
                        <th className="text-right text-indigo-300 py-3 px-4 font-semibold">Trades</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.positions.map((p, i) => {
                        const pl = p.plNet ?? p.realized;
                        return (
                          <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                            <td className="py-2.5 px-4 text-white font-mono font-semibold">{p.sym}</td>
                            <td className="py-2.5 px-4 text-indigo-200 max-w-xs truncate">{p.name}</td>
                            <td className="py-2.5 px-4 text-right text-white">{fmtEur(p.buys)}</td>
                            <td className="py-2.5 px-4 text-right text-white">{fmtEur(p.sells)}</td>
                            <td className={`py-2.5 px-4 text-right font-semibold ${pl >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtEur2(pl)}</td>
                            <td className="py-2.5 px-4 text-right text-indigo-300">{p.trades}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Trends */}
            {tab === "trends" && (
              <div className="space-y-5">
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h3 className="text-white font-semibold mb-4 flex items-center">Dépôts Mensuels<InfoTooltip text="Virements entrants mensuels (Cash Amount positifs). Permet de visualiser la stratégie d’apport progressif en capital (DCA ou versements ponctuels)." /></h3>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={data.months}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
                      <XAxis dataKey="month" tick={{ fill: "#a5b4fc", fontSize: 11 }} />
                      <YAxis tick={{ fill: "#a5b4fc", fontSize: 11 }} tickFormatter={(v) => (v/1000).toFixed(0)+"k"} />
                      <Tooltip formatter={(v) => fmtEur(v)} contentStyle={{ background: "#1e1b4b", border: "1px solid #4338ca", borderRadius: 8, color: "#fff" }} itemStyle={{ color: "#fff" }} labelStyle={{ color: "#fff" }} />
                      <Bar dataKey="deposits" name="Dépôts" fill="#6366f1" radius={[4,4,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h3 className="text-white font-semibold mb-4 flex items-center">Achats vs Ventes Mensuels<InfoTooltip text="Volume mensuel d’achats (Share Amount négatif = sortie de cash) et de ventes (Share Amount positif = entrée de cash). Un mois avec ventes >> achats peut indiquer un désengagement ou une prise de profit." /></h3>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={data.months}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
                      <XAxis dataKey="month" tick={{ fill: "#a5b4fc", fontSize: 11 }} />
                      <YAxis tick={{ fill: "#a5b4fc", fontSize: 11 }} tickFormatter={(v) => (v/1000).toFixed(0)+"k"} />
                      <Tooltip formatter={(v) => fmtEur(v)} contentStyle={{ background: "#1e1b4b", border: "1px solid #4338ca", borderRadius: 8, color: "#fff" }} itemStyle={{ color: "#fff" }} labelStyle={{ color: "#fff" }} />
                      <Legend wrapperStyle={{ color: "#a5b4fc" }} />
                      <Bar dataKey="buys" name="Achats" fill="#ec4899" radius={[4,4,0,0]} />
                      <Bar dataKey="sells" name="Ventes" fill="#14b8a6" radius={[4,4,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h3 className="text-white font-semibold mb-4 flex items-center">Frais & Dividendes Mensuels<InfoTooltip text="Suivi mensuel des frais (coût de l’activité) et des revenus passifs (dividendes + intérêts). Idéal pour évaluer si les revenus couvrent les coûts de transaction." /></h3>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={data.months}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
                      <XAxis dataKey="month" tick={{ fill: "#a5b4fc", fontSize: 11 }} />
                      <YAxis tick={{ fill: "#a5b4fc", fontSize: 11 }} tickFormatter={(v) => v.toFixed(0)+"€"} />
                      <Tooltip formatter={(v) => fmtEur(v)} contentStyle={{ background: "#1e1b4b", border: "1px solid #4338ca", borderRadius: 8, color: "#fff" }} itemStyle={{ color: "#fff" }} labelStyle={{ color: "#fff" }} />
                      <Legend wrapperStyle={{ color: "#a5b4fc" }} />
                      <Line type="monotone" dataKey="fees" name="Frais" stroke="#f59e0b" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="dividends" name="Dividendes" stroke="#10b981" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="interest" name="Intérêts" stroke="#06b6d4" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Fees */}
            {tab === "fees" && (
              <div className="space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <KpiCard label="Total Frais" value={"-"+fmtEur(data.kpis.totalFees)} icon="💸" color="red" tooltip="Somme de toutes les charges prélevées : courtage, FFT, frais de change, taxes sociales et retenues à la source." />
                  <KpiCard label="Commissions" value={"-"+fmtEur(data.kpis.fees.commission)} icon="🏦" color="amber" tooltip="Frais de courtage Saxo sur les ordres exécutés. Typiquement 0,10% min 4€ sur actions européennes." />
                  <KpiCard label="Taxes FFT" value={"-"+fmtEur(data.kpis.fees.tax)} icon="🏛️" color="amber" tooltip="French Financial Transaction Tax (0,3%) sur les achats d’actions françaises de plus de 1 Md€ de capitalisation." />
                  <KpiCard label="Exchange + Autres" value={"-"+fmtEur(data.kpis.fees.exchange + data.kpis.fees.other)} icon="🔄" color="amber" tooltip="Frais de bourse (Exchange Fee), coûts externes (External product costs), taxes sociales et retenues à la source sur dividendes étrangers." />
                </div>
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h3 className="text-white font-semibold mb-4 flex items-center">Frais Mensuels<InfoTooltip text="Évolution mensuelle du total des frais prélevés. Un pic peut indiquer un mois d’activité intense ou un achat de fonds avec droits d’entrée." /></h3>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={data.months}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
                      <XAxis dataKey="month" tick={{ fill: "#a5b4fc", fontSize: 11 }} />
                      <YAxis tick={{ fill: "#a5b4fc", fontSize: 11 }} tickFormatter={(v) => v.toFixed(0)+"€"} />
                      <Tooltip formatter={(v) => fmtEur(v)} contentStyle={{ background: "#1e1b4b", border: "1px solid #4338ca", borderRadius: 8, color: "#fff" }} itemStyle={{ color: "#fff" }} labelStyle={{ color: "#fff" }} />
                      <Bar dataKey="fees" name="Frais" fill="#f59e0b" radius={[4,4,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-2xl p-4 text-center space-x-6 flex items-center justify-center flex-wrap gap-3">
                  <span className="text-indigo-300 text-sm">Ratio frais / capital : </span>
                  <span className="text-white font-bold">
                    {data.kpis.netDeposits > 0 ? ((data.kpis.totalFees / data.kpis.netDeposits) * 100).toFixed(3) + " %" : "N/A"}
                  </span>
                  <span className="text-indigo-300 text-sm ml-6">Frais / résultat brut : </span>
                  <span className="text-white font-bold">
                    {(data.kpis.netResult + data.kpis.totalFees) > 0
                      ? ((data.kpis.totalFees / (data.kpis.netResult + data.kpis.totalFees)) * 100).toFixed(1) + " %"
                      : "N/A"}
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
