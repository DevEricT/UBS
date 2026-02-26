import React, { useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area,
  ComposedChart
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

// parseDateStr → remplacé par parseSaxoDate

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

// ─── Parse date universel (DMY ou YMD, avec - ou /) ─────────────────────────
const parseSaxoDate = (d) => {
  if (!d) return null;
  const s = String(d).trim().replace(/\//g, "-");
  const p = s.split("-");
  if (p.length !== 3) return null;
  // YYYY-MM-DD
  if (p[0].length === 4) return new Date(`${p[0]}-${p[1].padStart(2,"0")}-${p[2].padStart(2,"0")}`);
  // DD-MM-YYYY
  return new Date(`${p[2]}-${p[1].padStart(2,"0")}-${p[0].padStart(2,"0")}`);
};

const toYMD_safe = (d) => {
  if (!d) return "";
  const s = String(d).trim().replace(/\//g, "-");
  const p = s.split("-");
  if (p.length !== 3) return "";
  if (p[0].length === 4) return p[0] + p[1].padStart(2,"0") + p[2].padStart(2,"0");
  return p[2] + p[1].padStart(2,"0") + p[0].padStart(2,"0");
};

function processXLSX(workbook, filterCompte = "ALL", dateStart = null, dateEnd = null) {
  // ── Détection automatique du broker par signature de fichier ──
  const sheetNames = workbook.SheetNames;
  const isSaxo = sheetNames.includes("Montants cumulés") && sheetNames.includes("B P");
  const isIBKR = sheetNames.some(s => s.toLowerCase().includes("activity"));
  const broker = isSaxo ? "Saxo Bank" : isIBKR ? "Interactive Brokers" : "Broker inconnu";

  const sheetMain = workbook.Sheets["Montants cumulés"] || workbook.Sheets[workbook.SheetNames[0]];
  const sheetPerf = workbook.Sheets["Performance"];
  const sheetBP   = workbook.Sheets["B P"];
  const sheetMvt  = workbook.Sheets["Mouvements d espèces"];

  const toRows = (sheet) => sheet ? XLSX.utils.sheet_to_json(sheet, { defval: null }) : [];

  const ymdStart = dateStart ? dateStart.replace(/-/g, "") : null;
  const ymdEnd   = dateEnd   ? dateEnd.replace(/-/g, "")   : null;
  const inRange  = (d) => {
    const ymd = toYMD_safe(d);
    if (!ymd) return false;
    if (ymdStart && ymd < ymdStart) return false;
    if (ymdEnd   && ymd > ymdEnd)   return false;
    return true;
  };

  const mainRows = toRows(sheetMain).filter(r => {
    if (!r["Date"]) return false;
    if (!inRange(r["Date"])) return false;
    if (filterCompte === "ALL") return true;
    return r["ID du compte de comptabilisation"] === filterCompte;
  });

  const positions = {};
  const months = {};
  const quarters = {};
  const years = {};
  const assetTypes = {}; // sym -> type d'actif
  let deposits = 0, withdrawals = 0, dividends = 0, interest = 0, cash = 0;
  let volumeNonEur = 0;
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
      // Credit = remboursement (positif dans le fichier), Commission = frais (négatif)
      const feeAmt = type === "Client Commission Credit" ? -Math.abs(amt) : Math.abs(amt);
      fees.commission += feeAmt; months[mk].fees += feeAmt; quarters[qk].fees += feeAmt; years[yk].fees += feeAmt;
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
      // Exchanges non-EUR : xnas, xnys (USD), xlon (GBP), etc.
      const EUR_EXCHANGES = ["xpar","xams","xbru","xlis","xmil","xetr","xhel","xsto","xcse","xosl","xwbo"];
      const symSuffix = sym.includes(":") ? sym.split(":")[1].toLowerCase() : "";
      const isNonEur = symSuffix && !EUR_EXCHANGES.includes(symSuffix);
      if (amt < 0) { p.buys += Math.abs(amt); months[mk].buys += Math.abs(amt); quarters[qk].buys += Math.abs(amt); years[yk].buys += Math.abs(amt); if (isNonEur) volumeNonEur += Math.abs(amt); }
      else { p.sells += amt; months[mk].sells += amt; quarters[qk].sells += amt; years[yk].sells += amt; if (isNonEur) volumeNonEur += amt; }
      p.realized = p.sells - p.buys;
      if (affecte === "oui") cash += amt;
      return;
    }
    if (affecte === "oui") cash += amt;
  });

  // TWR officiel Saxo
  const perfRows = toRows(sheetPerf);
  const perfSeries = perfRows
    .filter(r => r["Date"] && r["AccumulatedTimeWeightedTimeSeries"] != null && inRange(r["Date"]))
    .map(r => ({
      date: String(r["Date"]),
      twr: parseNum(r["AccumulatedTimeWeightedTimeSeries"]),
      valeur: parseNum(r["AccountValueTimeSeries"]),
      dailyPct: parseNum(r["% daily returns"]),
    }));
  const lastPerf = perfSeries[perfSeries.length - 1];
  const firstPerf = perfSeries[0];
  const twr = lastPerf ? lastPerf.twr : 0;
  const valeurTotale = lastPerf ? lastPerf.valeur : 0;

  // P&L net depuis onglet B/P
  const bpRows = toRows(sheetBP).filter(r => {
    if (!r["Date"]) return false;
    if (!inRange(r["Date"])) return false;
    if (filterCompte === "ALL") return true;
    return r["ID du compte de comptabilisation"] === filterCompte;
  });
  // Mouvements d'espèces : Cash Amount uniquement = dépôts/retraits réels
  const mvtRows = toRows(sheetMvt).filter(r => {
    if (!r["Date"]) return false;
    if (!inRange(r["Date"])) return false;
    if (filterCompte !== "ALL" && r["ID du compte de comptabilisation"] !== filterCompte) return false;
    return String(r["Nom du type de montant"]).trim() === "Cash Amount";
  });

  // Construire les cashflows pour IRR : { date (ISO), amount }
  // Convention IRR : dépôt = négatif (sortie investisseur), retrait = positif (entrée)
  const parseDateIRR = (d) => {
    const p = String(d).split("-");
    if (p.length === 3) return new Date(`${p[2]}-${p[1]}-${p[0]}`);
    return new Date(d);
  };
  const cashflows = mvtRows.map(r => ({
    date: parseDateIRR(r["Date"]),
    amount: -parseNum(r["Montant dans la devise du compte"]), // inversé : dépôt = sortie investisseur
  })).filter(c => !isNaN(c.date) && c.amount !== 0);

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
  const totalBuys  = Object.values(positions).reduce((s, p) => s + p.buys, 0);
  const totalSells = Object.values(positions).reduce((s, p) => s + p.sells, 0);
  const totalVolume = totalBuys + totalSells;
  const netDeposits = deposits - withdrawals;
  const netResult = dividends + interest + Object.values(positions).reduce((s, p) => s + (p.plNet ?? 0), 0) - totalFees;
  const perfPct = netDeposits > 0 ? (netResult / netDeposits) * 100 : 0;

  // ── CAGR : annualisation du TWR officiel Saxo ──────────────────────────
  let cagr = 0;
  if (firstPerf && lastPerf && firstPerf.date !== lastPerf.date) {
    const d1 = parseSaxoDate(firstPerf.date);
    const d2 = parseSaxoDate(lastPerf.date);
    const nbJours = (d2 - d1) / (1000 * 60 * 60 * 24);
    if (nbJours > 0 && twr > -100) {
      cagr = (Math.pow(1 + twr / 100, 365 / nbJours) - 1) * 100;
    }
  }

  // ── IRR (XIRR) : TRI pondéré par les dates ────────────────────────────
  // Ajouter la valeur finale comme dernier cashflow positif (récupération)
  let irr = null;
  if (cashflows.length > 0 && valeurTotale > 0) {
    const irrFlows = [
      ...cashflows,
      { date: lastPerf ? parseSaxoDate(lastPerf.date) : new Date(), amount: valeurTotale },
    ];
    const xirr = (flows, valTotal) => {
      const msPerYear = 365.25 * 24 * 3600 * 1000;
      const t0 = flows[0].date.getTime();
      const npv = (rate) => flows.reduce((s, f) => {
        const t = (f.date.getTime() - t0) / msPerYear;
        return s + f.amount / Math.pow(1 + rate, t);
      }, 0);
      const tol = Math.max(100, (valTotal || 1e6) * 1e-6);
      let r = 0.1;
      for (let i = 0; i < 100; i++) {
        const fn = npv(r);
        const fp = (npv(r + 1e-6) - fn) / 1e-6;
        if (Math.abs(fp) < 1e-12) break;
        const nr = r - fn / fp;
        if (Math.abs(nr - r) < 1e-8) { r = nr; break; }
        r = Math.max(-0.999, Math.min(10, nr));
      }
      if (Math.abs(npv(r)) < tol) return r * 100;
      // Bisection fallback
      let lo = -0.999, hi = 10;
      if (npv(lo) * npv(hi) > 0) return null;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (Math.abs(hi - lo) < 1e-8) { r = mid; break; }
        npv(lo) * npv(mid) <= 0 ? (hi = mid) : (lo = mid);
        r = mid;
      }
      return Math.abs(npv(r)) < tol ? r * 100 : null;
    };
    irr = xirr(irrFlows);
  }

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
    broker,
    dateRange: (() => {
      const allDates = toRows(sheetMain)
        .map(r => r["Date"] ? toYMD_safe(r["Date"]) : "")
        .filter(Boolean).sort();
      if (!allDates.length) return null;
      const toISO = (ymd) => ymd ? `${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}` : "";
      return { min: toISO(allDates[0]), max: toISO(allDates[allDates.length-1]) };
    })(),
    kpis: { deposits, withdrawals, netDeposits, dividends, interest, totalFees, fees, netResult, perfPct, cash, twr, valeurTotale, totalBuys, totalSells, totalVolume, volumeNonEur, cagr, irr },
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
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const ref = useRef(null);

  const handleEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setPos({
        top: rect.top + window.scrollY - 8,
        left: rect.left + rect.width / 2,
      });
    }
    setShow(true);
  };

  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", marginLeft: 5 }}>
      <span
        ref={ref}
        onMouseEnter={handleEnter}
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
          position: "fixed",
          top: pos.top - 4,
          left: pos.left,
          transform: "translate(-50%, -100%)",
          background: "#1e1b4b",
          border: "1px solid #4338ca", borderRadius: 6, padding: "7px 10px",
          color: "#e0e7ff", fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap",
          width: 230, zIndex: 99999, pointerEvents: "none",
          boxShadow: "0 4px 24px rgba(0,0,0,0.7)"
        }}>{text}</span>
      )}
    </span>
  );
}


function KpiCardSm({ label, value, color = "indigo", icon, tooltip }) {
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
    <div className={`bg-gradient-to-br ${colors[color] || colors.indigo} border rounded-xl p-3`}>
      <div className="flex items-center gap-1.5 mb-1">
        {icon && <span className="text-sm">{icon}</span>}
        <span className="text-xs font-semibold uppercase tracking-wider text-white/50 truncate">{label}</span>
        {tooltip && <InfoTooltip text={tooltip} />}
      </div>
      <div className="text-base font-bold text-white truncate">{value}</div>
    </div>
  );
}

// ─── PDF builder ──────────────────────────────────────────────────────────────

// HTML escape helper
const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function buildPDF(data, filterLabel) {
  const { kpis, positions, broker: pdfBroker } = data;
  const top5  = positions.slice(0, 5);
  const flop5 = [...positions].sort((a, b) => (a.plNet ?? a.realized) - (b.plNet ?? b.realized)).slice(0, 5);
  const posRow = (p) => {
    const pl = p.plNet ?? p.realized;
    return `<tr><td>${esc(p.sym)}</td><td>${esc(p.name).slice(0, 35)}</td>
      <td class="num">${fmtEur(p.buys)}</td><td class="num">${fmtEur(p.sells)}</td>
      <td class="num ${pl >= 0 ? "pos" : "neg"}">${fmtEur(pl)}</td></tr>`;
  };
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<title>Rapport ${pdfBroker} ${new Date().toLocaleDateString("fr-FR")}</title>
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
  <h1>📊 Rapport Portefeuille ${pdfBroker}</h1>
  <div class="sub">Généré le ${new Date().toLocaleDateString("fr-FR")} · ${filterLabel} · ${positions.length} positions</div>
  <h2>Performance Globale</h2>
  <div class="g4">
    <div class="card"><div class="card-l">Valeur Totale</div><div class="card-v">${fmtEur(kpis.valeurTotale)}</div></div>
    <div class="card"><div class="card-l">Capital Net</div><div class="card-v">${fmtEur(kpis.netDeposits)}</div></div>
    <div class="card"><div class="card-l">Résultat Net</div><div class="card-v ${kpis.netResult >= 0 ? "pos" : "neg"}">${fmtEur(kpis.netResult)}</div></div>
    <div class="card"><div class="card-l">TWR Officiel</div><div class="card-v ${kpis.twr >= 0 ? "pos" : "neg"}">${fmtPct(kpis.twr)}</div></div>
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
  <div class="footer">${pdfBroker} Analyzer · ${new Date().toLocaleString("fr-FR")}</div>
</div></body></html>`;
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id: "overview",    label: "📋 Vue d'ensemble" },
  { id: "performance", label: "📈 Performance" },
  { id: "annuel",      label: "📊 Vue Annuelle" },
  { id: "temporelle",  label: "📉 Analyse Temporelle" },
  { id: "periodes",    label: "📆 Périodes" },
  { id: "positions",   label: "💼 Positions" },
  { id: "trends",      label: "📅 Trends" },
  { id: "fees",        label: "💰 Frais" },
  { id: "portefeuille", label: "📋 Portefeuille" },
  { id: "notes",       label: "📖 Notes" },
];




// ─── Composant Analyse Temporelle ────────────────────────────────────────────

function TemporelleView({ data }) {
  const series = data.perfSeriesFull || [];

  // ── Calcul Drawdown ────────────────────────────────────────────────────────
  let peak = -Infinity;
  const serieWithDD = series.map(r => {
    if (r.twr > peak) peak = r.twr;
    const dd = peak > -Infinity ? r.twr - peak : 0;
    return { ...r, drawdown: dd };
  });

  // Formater dates pour affichage
  const parseDMY = parseSaxoDate;

  const chartData = serieWithDD.map(r => {
    const dt = parseDMY(r.date);
    return {
      date: r.date,
      label: dt.toLocaleDateString("fr-FR", { day:"2-digit", month:"short" }),
      twr: parseFloat(r.twr.toFixed(3)),
      drawdown: parseFloat(r.drawdown.toFixed(3)),
      valeur: r.valeur,
      daily: r.dailyPct ? parseFloat((r.dailyPct * 100).toFixed(3)) : 0,
    };
  });

  // ── Statistiques Drawdown ──────────────────────────────────────────────────
  const maxDD = Math.min(...serieWithDD.map(r => r.drawdown));
  const maxDDDate = serieWithDD.find(r => r.drawdown === maxDD)?.date || "";
  
  // Calculer les épisodes de drawdown
  const episodes = [];
  let inDD = false, ddStart = null, ddPeak = 0, ddDepth = 0;
  serieWithDD.forEach((r, i) => {
    if (r.drawdown < -0.01 && !inDD) {
      inDD = true; ddStart = r.date; ddPeak = 0; ddDepth = r.drawdown;
    } else if (r.drawdown < -0.01 && inDD) {
      if (r.drawdown < ddDepth) ddDepth = r.drawdown;
    } else if (r.drawdown >= -0.01 && inDD) {
      inDD = false;
      episodes.push({ start: ddStart, end: r.date, depth: ddDepth });
    }
  });
  if (inDD) episodes.push({ start: ddStart, end: serieWithDD[serieWithDD.length-1]?.date, depth: ddDepth });

  // ── Heatmap calendrier ─────────────────────────────────────────────────────
  // Regrouper par mois → semaines → jours
  const byDate = {};
  series.forEach(r => {
    const dt = parseDMY(r.date);
    const key = dt.toISOString().slice(0,10);
    byDate[key] = r.dailyPct ? r.dailyPct * 100 : 0;
  });

  // Construire la grille : tous les jours de la période
  const allDays = [];
  if (series.length > 0) {
    const d1 = parseDMY(series[0].date);
    const d2 = parseDMY(series[series.length-1].date);
    // Reculer au lundi de la semaine de d1
    const start = new Date(d1);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(d2);
    end.setDate(end.getDate() + (7 - ((end.getDay() + 6) % 7)) % 7);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
      const key = d.toISOString().slice(0,10);
      allDays.push({
        date: new Date(d),
        key,
        val: byDate[key] ?? null,
        weekday: (d.getDay() + 6) % 7, // 0=lundi
      });
    }
  }

  // Regrouper par semaines
  const weeks = [];
  for (let i = 0; i < allDays.length; i += 7) {
    weeks.push(allDays.slice(i, i+7));
  }

  // Regrouper par mois pour les labels
  const monthLabels = [];
  weeks.forEach((week, wi) => {
    const firstReal = week.find(d => d.val !== null);
    if (firstReal) {
      const m = firstReal.date.toLocaleDateString("fr-FR", { month: "short", year: "2-digit" });
      const prev = monthLabels[monthLabels.length-1];
      if (!prev || prev.label !== m) {
        monthLabels.push({ label: m, col: wi });
      }
    }
  });

  // Couleur heatmap
  const heatColor = (v) => {
    if (v === null) return "rgba(255,255,255,0.04)";
    if (v > 2)    return "#059669";
    if (v > 1)    return "#10b981";
    if (v > 0.3)  return "#34d399";
    if (v > 0)    return "#6ee7b7";
    if (v === 0)  return "rgba(255,255,255,0.08)";
    if (v > -0.3) return "#fca5a5";
    if (v > -1)   return "#f87171";
    if (v > -2)   return "#ef4444";
    return "#b91c1c";
  };

  // ── Statistiques rapides ──────────────────────────────────────────────────
  const dailyVals = series.map(r => r.dailyPct ? r.dailyPct * 100 : 0).filter(v => v !== 0);
  const posJours = dailyVals.filter(v => v > 0).length;
  const negJours = dailyVals.filter(v => v < 0).length;
  const bestDay  = dailyVals.length ? Math.max(...dailyVals) : 0;
  const worstDay = dailyVals.length ? Math.min(...dailyVals) : 0;
  const bestDayDate  = series.find(r => r.dailyPct && Math.abs(r.dailyPct*100 - bestDay)  < 0.001)?.date || "";
  const worstDayDate = series.find(r => r.dailyPct && Math.abs(r.dailyPct*100 - worstDay) < 0.001)?.date || "";

  const JOURS = ["L","M","M","J","V","S","D"];

  return (
    <div className="space-y-5">

      {/* ── KPIs rapides ── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCardSm label="Drawdown Max" value={maxDD.toFixed(2) + " %"} icon="📉" color="red"
          tooltip={"Pire perte depuis un sommet sur toute la période. Date : " + maxDDDate} />
        <KpiCardSm label="Épisodes DD" value={episodes.length} icon="⚠️" color="amber"
          tooltip="Nombre de périodes de drawdown (baisse continue depuis un sommet)." />
        <KpiCardSm label="Jours positifs" value={posJours + " / " + (posJours+negJours)} icon="✅" color="green"
          tooltip={"Jours avec rendement positif vs total jours tradés. Hit ratio : " + (posJours+negJours > 0 ? ((posJours/(posJours+negJours))*100).toFixed(1)+"%" : "N/A")} />
        <KpiCardSm label="Meilleur jour" value={"+" + bestDay.toFixed(2) + " %"} icon="🚀" color="green"
          tooltip={"Meilleure journée de la période : " + bestDayDate} />
        <KpiCardSm label="Pire jour" value={worstDay.toFixed(2) + " %"} icon="💥" color="red"
          tooltip={"Pire journée de la période : " + worstDayDate} />
      </div>

      {/* ── Graphique TWR + Drawdown ── */}
      <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
        <h3 className="text-white font-semibold mb-1 flex items-center text-sm uppercase tracking-widest">
          TWR Cumulé & Drawdown
          <InfoTooltip text="Courbe bleue = TWR cumulé officiel. Zone rouge = perte depuis le dernier sommet (drawdown). Plus la zone rouge est profonde et longue, plus le portefeuille a souffert." />
        </h3>
        <p className="text-white/40 text-xs mb-4">{chartData.length} points journaliers · axe gauche = TWR% · axe droit = Drawdown%</p>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={chartData} margin={{ left: 10, right: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="label" tick={{ fill:"#a5b4fc", fontSize:9 }} interval={Math.floor(chartData.length/10)} />
            <YAxis yAxisId="twr" tick={{ fill:"#a5b4fc", fontSize:10 }} tickFormatter={v => v.toFixed(1)+"%"} />
            <YAxis yAxisId="dd" orientation="right" tick={{ fill:"#fca5a5", fontSize:10 }} tickFormatter={v => v.toFixed(1)+"%"} />
            <Tooltip
              contentStyle={{ background:"#1e1b4b", border:"1px solid #4338ca", borderRadius:8, color:"#fff", fontSize:11 }}
              itemStyle={{ color:"#fff" }} labelStyle={{ color:"#fff" }}
              formatter={(v, name) => [v.toFixed(3)+"%", name]}
            />
            <Legend wrapperStyle={{ color:"#a5b4fc", fontSize:12 }} />
            <Area yAxisId="dd" type="monotone" dataKey="drawdown" name="Drawdown" fill="rgba(239,68,68,0.25)" stroke="#ef4444" strokeWidth={1} dot={false} />
            <Line yAxisId="twr" type="monotone" dataKey="twr" name="TWR%" stroke="#6366f1" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* ── Heatmap calendrier ── */}
      <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
        <h3 className="text-white font-semibold mb-1 flex items-center text-sm uppercase tracking-widest">
          Heatmap des Performances Journalières
          <InfoTooltip text="Chaque case = un jour de bourse. Vert = jour positif (plus foncé = plus fort), rouge = jour négatif. Gris = weekend/férié/pas de données." />
        </h3>
        <div className="mb-3 flex gap-3 items-center flex-wrap">
          {[["#b91c1c","< -2%"],["#ef4444","-1 à -2%"],["#f87171","-0.3 à -1%"],["#fca5a5","0 à -0.3%"],["#6ee7b7","0 à +0.3%"],["#34d399","+0.3 à +1%"],["#10b981","+1 à +2%"],["#059669","> +2%"]].map(([c,l]) => (
            <span key={l} className="flex items-center gap-1 text-xs text-white/60">
              <span style={{ width:10,height:10,background:c,borderRadius:2,display:"inline-block" }} />{l}
            </span>
          ))}
        </div>
        <div className="overflow-x-auto pb-2">
          <div style={{ display:"grid", gridTemplateColumns:`24px repeat(${weeks.length}, 14px)`, gap:2, alignItems:"start" }}>
            {/* Jours de la semaine */}
            <div />
            {weeks.map((_, wi) => {
              const ml = monthLabels.find(m => m.col === wi);
              return <div key={wi} style={{ fontSize:9, color:"#818cf8", textAlign:"center", height:14, lineHeight:"14px", whiteSpace:"nowrap", overflow:"visible" }}>{ml ? ml.label : ""}</div>;
            })}
            {/* Grille */}
            {JOURS.map((j, di) => (
              <React.Fragment key={di}>
                <div style={{ fontSize:9, color:"#a5b4fc", textAlign:"right", paddingRight:4, lineHeight:"14px", marginTop: di === 0 ? 2 : 0 }}>{di % 2 === 0 ? j : ""}</div>
                {weeks.map((week, wi) => {
                  const day = week[di];
                  if (!day) return <div key={wi} />;
                  const isWeekend = day.weekday >= 5;
                  return (
                    <div
                      key={wi}
                      title={`${day.key} : ${day.val !== null ? day.val.toFixed(3)+"%" : "—"}`}
                      style={{
                        width:13, height:13, borderRadius:2,
                        background: isWeekend ? "rgba(255,255,255,0.02)" : heatColor(day.val),
                        opacity: isWeekend ? 0.3 : 1,
                        cursor: day.val !== null ? "default" : "default",
                      }}
                    />
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* ── Épisodes de Drawdown ── */}
      {episodes.length > 0 && (
        <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
          <div className="p-4 border-b border-white/10 text-indigo-300 text-sm flex items-center gap-1">
            Épisodes de Drawdown
            <InfoTooltip text="Chaque ligne = une période de baisse continue depuis un sommet. Depth = profondeur maximale du drawdown pendant cet épisode." />
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-white/5">
                <th className="text-left text-indigo-300 py-3 px-4 text-xs uppercase">#</th>
                <th className="text-left text-indigo-300 py-3 px-4 text-xs uppercase">Début</th>
                <th className="text-left text-indigo-300 py-3 px-4 text-xs uppercase">Fin</th>
                <th className="text-right text-indigo-300 py-3 px-4 text-xs uppercase">Durée</th>
                <th className="text-right text-indigo-300 py-3 px-4 text-xs uppercase">Profondeur</th>
              </tr>
            </thead>
            <tbody>
              {episodes.sort((a,b) => a.depth - b.depth).slice(0,10).map((ep, i) => {
                const d1 = parseDMY(ep.start), d2 = parseDMY(ep.end);
                const dur = Math.round((d2-d1)/(1000*60*60*24));
                return (
                  <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    <td className="py-2.5 px-4 text-white/50">{i+1}</td>
                    <td className="py-2.5 px-4 text-white">{ep.start}</td>
                    <td className="py-2.5 px-4 text-white">{ep.end}</td>
                    <td className="py-2.5 px-4 text-right text-indigo-300">{dur}j</td>
                    <td className={`py-2.5 px-4 text-right font-bold ${ep.depth < -3 ? "text-red-400" : ep.depth < -1 ? "text-amber-400" : "text-yellow-300"}`}>
                      {ep.depth.toFixed(2)} %
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}



// ─── Composant PortefeuilleView ──────────────────────────────────────────────

function PortefeuilleView({ positionsData, parsePositionsCSV, posFileName, data }) {
  const [sortKey, setSortKey] = useState("valeur");
  const [sortDir, setSortDir] = useState("desc");

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const ASSET_COLORS = {
    'Actions':                      'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
    'Exchange Traded Fund (ETF)':   'bg-teal-500/20 text-teal-300 border-teal-500/30',
    'OPCVM':                        'bg-violet-500/20 text-violet-300 border-violet-500/30',
  };

  const COMPTE_COLORS = {
    'Compte-titres': 'bg-blue-500/20 text-blue-300 border-blue-500/30',
    'PEA':           'bg-green-500/20 text-green-300 border-green-500/30',
    'PEA-PME':       'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  };

  // Zone de drop si pas encore de fichier
  if (!positionsData) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-6">
        <div className="text-6xl">📋</div>
        <div className="text-center">
          <h3 className="text-white font-semibold text-lg mb-2">Fichier Positions manquant</h3>
          <p className="text-white/50 text-sm mb-1">Glissez le fichier <span className="font-mono text-indigo-300">Positions_*.csv</span> exporté depuis Saxo</p>
          <p className="text-white/30 text-xs">SaxoTrader → Positions → icône Export (coin supérieur droit)</p>
        </div>
        <label className="cursor-pointer px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold transition-all shadow-lg">
          📂 Charger le fichier Positions CSV
          <input type="file" accept=".csv" className="hidden" onChange={e => parsePositionsCSV(e.target.files[0])} />
        </label>
      </div>
    );
  }

  const { positions, totalValeur, totalLatent, byType, byCompte } = positionsData;

  // Tri
  const sorted = [...positions].sort((a, b) => {
    let va, vb;
    if      (sortKey === "name")    { va = a.name; vb = b.name; return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va); }
    else if (sortKey === "sym")     { va = a.sym;  vb = b.sym;  return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va); }
    else if (sortKey === "valeur")  { va = a.valeur;  vb = b.valeur; }
    else if (sortKey === "plNet")   { va = a.plNet;   vb = b.plNet; }
    else if (sortKey === "plPct")   { va = a.plPct;   vb = b.plPct; }
    else if (sortKey === "var1j")      { va = a.variation1j; vb = b.variation1j; }
    else if (sortKey === "qty")        { va = a.qty;        vb = b.qty; }
    else if (sortKey === "prixEntree") { va = a.prixEntree; vb = b.prixEntree; }
    else if (sortKey === "prixActuel") { va = a.prixActuel; vb = b.prixActuel; }
    else va = vb = 0;
    return sortDir === "asc" ? va - vb : vb - va;
  });

  const SortTh = ({ label, col, right=true }) => (
    <th onClick={() => handleSort(col)}
      className={`py-3 px-3 font-semibold cursor-pointer select-none text-xs uppercase tracking-wide transition-colors hover:text-white ${right ? "text-right" : "text-left"} ${sortKey === col ? "text-white" : "text-indigo-300"}`}>
      {label} {sortKey === col ? (sortDir === "desc" ? "↓" : "↑") : <span className="text-white/20">↕</span>}
    </th>
  );

  // Pie chart répartition
  const pieType = Object.entries(byType).map(([k, v]) => ({ name: k.replace('Exchange Traded Fund (ETF)','ETF'), value: Math.round(v.valeur) }));
  const pieCompte = Object.entries(byCompte).filter(([k]) => k && k !== '?').map(([k, v]) => ({ name: k, value: Math.round(v.valeur) }));
  const PIE_COLORS = ['#6366f1','#14b8a6','#8b5cf6','#f59e0b','#10b981','#3b82f6'];

  return (
    <div className="space-y-5">

      {/* Header snapshot */}
      <div className="flex items-center justify-between">
        <div className="text-white/40 text-xs font-mono">📋 {posFileName} — snapshot {new Date().toLocaleDateString('fr-FR')}</div>
        <label className="cursor-pointer text-xs text-indigo-400 hover:text-white transition-colors px-3 py-1.5 border border-white/15 rounded-lg">
          🔄 Changer de fichier
          <input type="file" accept=".csv" className="hidden" onChange={e => parsePositionsCSV(e.target.files[0])} />
        </label>
      </div>

      {/* KPIs snapshot */}
      <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
        <KpiCardSm label="Positions ouvertes" value={positions.length} icon="📊" color="indigo"
          tooltip="Nombre de lignes dans le fichier Positions CSV." />
        <KpiCardSm label="Valeur de marché" value={fmtEur(totalValeur)} icon="💼" color="indigo"
          tooltip="Valeur totale du portefeuille au prix de marché actuel." />
        <KpiCardSm label="P&L Latent" value={fmtEur(totalLatent)} icon="📍" color={totalLatent >= 0 ? "green" : "red"}
          tooltip="Plus/moins-value latente totale sur positions ouvertes (non réalisée)." />
        <KpiCardSm label="P&L Latent %" value={(totalValeur > 0 ? (totalLatent / (totalValeur - totalLatent) * 100) : 0).toFixed(2) + " %"} icon="%" color={totalLatent >= 0 ? "green" : "red"}
          tooltip="P&L latent / coût d'acquisition total." />
        {data && <KpiCardSm label="P&L Total" value={fmtEur(data.kpis.netResult + totalLatent)} icon="🏆" color={(data.kpis.netResult + totalLatent) >= 0 ? "green" : "red"}
          tooltip="P&L réalisé (historique) + P&L latent (positions ouvertes) = performance complète du portefeuille." />}
      </div>

      {/* Répartition */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Par type */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
          <h3 className="text-white font-semibold text-sm uppercase tracking-widest mb-4">Par type d'actif</h3>
          <div className="flex gap-4 items-center">
            <ResponsiveContainer width={130} height={130}>
              <PieChart>
                <Pie data={pieType} dataKey="value" innerRadius={35} outerRadius={60} paddingAngle={3}>
                  {pieType.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={v => fmtEur(v)} contentStyle={{ background:"#1e1b4b", border:"1px solid #4338ca", borderRadius:8, color:"#fff", fontSize:11 }} itemStyle={{color:"#fff"}} labelStyle={{color:"#fff"}} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex-1 space-y-2">
              {Object.entries(byType).map(([t, v], i) => (
                <div key={t} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span style={{ width:8, height:8, background:PIE_COLORS[i], borderRadius:2, display:'inline-block' }} />
                    <span className={`text-xs px-1.5 py-0.5 rounded-full border ${ASSET_COLORS[t] || 'bg-white/10 text-white/60 border-white/20'}`}>{t.replace('Exchange Traded Fund (ETF)','ETF')}</span>
                  </div>
                  <div className="text-right">
                    <div className="text-white text-xs font-semibold">{fmtEur(v.valeur)}</div>
                    <div className={`text-xs ${v.plNet >= 0 ? 'text-green-400/70' : 'text-red-400/70'}`}>{v.plNet >= 0 ? '+' : ''}{fmtEur(v.plNet)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Par compte */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
          <h3 className="text-white font-semibold text-sm uppercase tracking-widest mb-4">Par compte</h3>
          <div className="flex gap-4 items-center">
            <ResponsiveContainer width={130} height={130}>
              <PieChart>
                <Pie data={pieCompte} dataKey="value" innerRadius={35} outerRadius={60} paddingAngle={3}>
                  {pieCompte.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={v => fmtEur(v)} contentStyle={{ background:"#1e1b4b", border:"1px solid #4338ca", borderRadius:8, color:"#fff", fontSize:11 }} itemStyle={{color:"#fff"}} labelStyle={{color:"#fff"}} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex-1 space-y-2">
              {Object.entries(byCompte).filter(([k]) => k && k !== '?').map(([t, v], i) => (
                <div key={t} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span style={{ width:8, height:8, background:PIE_COLORS[i], borderRadius:2, display:'inline-block' }} />
                    <span className={`text-xs px-1.5 py-0.5 rounded-full border ${COMPTE_COLORS[t] || 'bg-white/10 text-white/60 border-white/20'}`}>{t}</span>
                  </div>
                  <div className="text-right">
                    <div className="text-white text-xs font-semibold">{fmtEur(v.valeur)}</div>
                    <div className="text-white/40 text-xs">{(v.valeur / totalValeur * 100).toFixed(1)} %</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Tableau positions */}
      <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <span className="text-white font-semibold text-sm uppercase tracking-widest">Positions Ouvertes</span>
          <span className="text-white/40 text-xs">{positions.length} lignes · snapshot temps réel</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-white/5">
                <SortTh label="Instrument" col="name" right={false} />
                <th className="text-left text-indigo-300 py-3 px-3 text-xs uppercase">Type</th>
                <th className="text-left text-indigo-300 py-3 px-3 text-xs uppercase">Compte</th>
                <SortTh label="Qté" col="qty" />
                <SortTh label="Px entrée" col="prixEntree" />
                <SortTh label="Px actuel" col="prixActuel" />
                <SortTh label="Valeur €" col="valeur" />
                <SortTh label="P&L €" col="plNet" />
                <SortTh label="P&L %" col="plPct" />
                <SortTh label="1J %" col="var1j" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((p, i) => (
                <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="py-2.5 px-3">
                    <div className="text-white text-xs font-semibold truncate max-w-xs">{p.name}</div>
                    <div className="text-white/40 text-xs font-mono">{p.sym}</div>
                  </td>
                  <td className="py-2.5 px-3">
                    <span className={`text-xs px-1.5 py-0.5 rounded-full border ${ASSET_COLORS[p.assetLabel] || 'bg-white/10 text-white/60 border-white/20'}`}>
                      {p.assetLabel === 'Exchange Traded Fund (ETF)' ? 'ETF' : p.assetLabel}
                    </span>
                  </td>
                  <td className="py-2.5 px-3">
                    <span className={`text-xs px-1.5 py-0.5 rounded-full border ${COMPTE_COLORS[p.compte] || 'bg-white/10 text-white/60 border-white/20'}`}>
                      {p.compte || '—'}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-right text-white/70 text-xs">{p.qty.toLocaleString('fr-FR')}</td>
                  <td className="py-2.5 px-3 text-right text-white/70 text-xs">{p.prixEntree.toLocaleString('fr-FR', {minimumFractionDigits:2, maximumFractionDigits:4})}</td>
                  <td className="py-2.5 px-3 text-right text-white text-xs font-semibold">{p.prixActuel.toLocaleString('fr-FR', {minimumFractionDigits:2, maximumFractionDigits:4})}</td>
                  <td className="py-2.5 px-3 text-right text-white text-xs font-bold">{fmtEur(p.valeur)}</td>
                  <td className={`py-2.5 px-3 text-right text-xs font-bold ${p.plNet >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtEur(p.plNet)}</td>
                  <td className={`py-2.5 px-3 text-right text-xs font-bold ${p.plPct >= 0 ? "text-green-400" : "text-red-400"}`}>{p.plPct >= 0 ? "+" : ""}{p.plPct.toFixed(2)} %</td>
                  <td className={`py-2.5 px-3 text-right text-xs ${p.variation1j >= 0 ? "text-green-400/70" : "text-red-400/70"}`}>{p.variation1j >= 0 ? "+" : ""}{p.variation1j.toFixed(2)} %</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-white/5 font-bold border-t border-white/20">
                <td className="py-3 px-3 text-white text-xs uppercase" colSpan={6}>Total</td>
                <td className="py-3 px-3 text-right text-white text-xs">{fmtEur(totalValeur)}</td>
                <td className={`py-3 px-3 text-right text-xs ${totalLatent >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtEur(totalLatent)}</td>
                <td className={`py-3 px-3 text-right text-xs ${totalLatent >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {(totalValeur > 0 ? (totalLatent / (totalValeur - totalLatent) * 100) : 0).toFixed(2)} %
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

    </div>
  );
}

// ─── Composant NotesView ─────────────────────────────────────────────────────

function NotesView({ data, dateStart, dateEnd, dateRange }) {
  const isPeriodFiltered = dateStart !== (dateRange?.min || "") || dateEnd !== (dateRange?.max || "");

  const Section = ({ title, children }) => (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
      <h3 className="text-white font-semibold text-sm uppercase tracking-widest border-b border-white/10 pb-3">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );

  const DEF_COLORS = {
    indigo: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
    teal:   "bg-teal-500/20 text-teal-300 border-teal-500/30",
    green:  "bg-green-500/20 text-green-300 border-green-500/30",
    amber:  "bg-amber-500/20 text-amber-300 border-amber-500/30",
    red:    "bg-red-500/20 text-red-300 border-red-500/30",
    violet: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  };
  const Def = ({ term, color = "indigo", children }) => (
    <div className="flex gap-3">
      <span className={`shrink-0 text-xs font-bold px-2 py-0.5 rounded-full h-fit mt-0.5 border min-w-fit ${DEF_COLORS[color] || DEF_COLORS.indigo}`}>{term}</span>
      <p className="text-white/60 text-sm leading-relaxed">{children}</p>
    </div>
  );

  return (
    <div className="space-y-5">

      {/* ── Filtre actif ── */}
      {isPeriodFiltered && (
        <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl p-5">
          <span className="text-amber-400 text-lg shrink-0">⚠️</span>
          <div>
            <div className="text-amber-300 font-semibold text-sm mb-1">Filtre de période actif : {dateStart} → {dateEnd}</div>
            <p className="text-amber-300/70 text-sm leading-relaxed">
              Tous les onglets sont recalculés sur cette sous-période. Les montants (P&L, frais, dividendes) reflètent uniquement les transactions de la période sélectionnée.
            </p>
            <p className="text-amber-300/70 text-sm leading-relaxed mt-2">
              <strong className="text-amber-300">Note TWR :</strong> le TWR affiché est la variation du TWR cumulé Saxo entre le premier et le dernier point de la période. Il peut différer du TWR que Saxo calculerait pour la même période isolée, car Saxo recalcule depuis zéro en tenant compte des flux internes à la période.
            </p>
          </div>
        </div>
      )}

      {/* ── Métriques de performance ── */}
      <Section title="📈 Métriques de Performance">
        <Def term="TWR" color="teal">
          <strong>Time-Weighted Return</strong> — Rendement pondéré dans le temps. Élimine l'effet des dépôts et retraits pour mesurer uniquement la performance de la gestion. C'est le standard CFA/GIPS utilisé par les gérants de fonds. Le chiffre affiché provient directement de l'onglet «Performance» du fichier {data.broker}.
        </Def>
        <Def term="CAGR" color="teal">
          <strong>Compound Annual Growth Rate</strong> — TWR annualisé sur la durée réelle du portefeuille. Formule : (1 + TWR)^(365/nbJours) - 1. Permet de comparer des portefeuilles sur des durées différentes et de se référencer à un indice annuel. Exemple : un TWR de +9,22% sur 14 mois donne un CAGR d'environ +7,8%/an.
        </Def>
        <Def term="IRR / TRI" color="green">
          <strong>Internal Rate of Return / Taux de Rendement Interne</strong> — Rendement réel du capital investi, tenant compte des dates exactes de chaque dépôt et retrait (XIRR). C'est la métrique patrimoniale par excellence : si tu avais placé tout le capital dès le premier jour, quel rendement annuel équivalent aurais-tu obtenu ? Calculé par Newton-Raphson sur les flux de l'onglet «Mouvements d'espèces».
        </Def>
        <Def term="MWR" color="green">
          <strong>Money-Weighted Return</strong> — Synonyme de l'IRR dans le contexte d'un portefeuille personnel. Contrairement au TWR, il est sensible aux dépôts/retraits : si tu déposes beaucoup juste avant une hausse, ton MWR sera meilleur que ton TWR.
        </Def>
        <Def term="Perf %" color="indigo">
          Rendement simple calculé dans l'app : Résultat Net / Capital Net Investi. Différent du TWR car il ne pondère pas dans le temps — il indique combien le capital a rapporté en proportion, sans tenir compte des dates des flux.
        </Def>
      </Section>

      {/* ── Métriques de risque ── */}
      <Section title="⚡ Métriques de Risque">
        <Def term="Volatilité" color="amber">
          Écart-type des rendements journaliers annualisé (× √252). Mesure l'amplitude des fluctuations quotidiennes. Interprétation : &lt;10% = faible (obligations), 10-20% = modérée (actions diversifiées), &gt;20% = élevée (titres concentrés). Source : colonne «% daily returns» de l'onglet Performance.
        </Def>
        <Def term="Sharpe" color="amber">
          (TWR annuel − taux sans risque 3%) / Volatilité. Mesure la rémunération du risque pris. &gt;1 = excellent (chaque unité de risque est bien payée), 0-1 = acceptable, &lt;0 = le portefeuille sous-performe le taux sans risque après ajustement du risque.
        </Def>
        <Def term="Drawdown" color="red">
          Perte maximale depuis un sommet de valorisation (peak-to-trough). Le drawdown max indique la pire perte subie si on avait acheté au plus haut et vendu au plus bas. Calculé sur la série TWR journalière. Un drawdown qui se prolonge indique une difficulté à récupérer les pertes.
        </Def>
        <Def term="Hit ratio" color="indigo">
          Proportion de jours de bourse avec un rendement positif. Un hit ratio &gt;55% avec un ratio gain/perte &gt;1 est caractéristique d'une gestion efficace. Visible dans l'onglet Analyse Temporelle.
        </Def>
      </Section>

      {/* ── Frais et fiscalité ── */}
      <Section title="💰 Frais & Fiscalité">
        <Def term="Commission" color="amber">
          Frais de courtage prélevés par {data.broker} sur chaque ordre exécuté. Apparaît dans la colonne «Nom du type de montant» du fichier.
        </Def>
        <Def term="FFT" color="amber">
          <strong>French Financial Transaction Tax</strong> — Taxe sur les Transactions Financières française prélevée uniquement à l'achat sur les actions françaises dont la capitalisation dépasse 1 milliard d'euros. Taux légal : 0,3% du montant de la transaction.
        </Def>
        <Def term="Exchange Fee" color="amber">
          Frais de bourse facturés par les marchés non-EUR (NYSE, NASDAQ). Dans le fichier, identifiable via le suffixe du symbole : :xnas (NASDAQ), :xnys (NYSE) = bourses USD soumises à Exchange Fee. Les bourses européennes (:xpar, :xetr, :xmil...) n'en génèrent pas.
        </Def>
        <Def term="Withholding Tax" color="amber">
          Retenue à la source sur les dividendes étrangers, prélevée par le pays d'origine avant versement. Partiellement récupérable via les conventions fiscales franco-étrangères.
        </Def>
        <Def term="Social Tax" color="amber">
          Prélèvements sociaux (17,2%) appliqués sur les revenus de capitaux mobiliers en France.
        </Def>
        <Def term="Client Interest" color="teal">
          Intérêts créditeurs versés par {data.broker} sur les liquidités du compte.
        </Def>
      </Section>

      {/* ── Structure du fichier ── */}
      <Section title="📁 Structure du Fichier {data.broker}">
        <Def term="Montants cumulés" color="indigo">
          Onglet principal : toutes les transactions journalières (achats, ventes, frais, dividendes, dépôts). Source des KPIs agrégés, des positions et des périodes.
        </Def>
        <Def term="B P" color="indigo">
          <strong>Bénéfices et Pertes</strong> — Onglet des P&L réalisés par position et par jour. Source du P&L Net affiché dans Positions et Performance. Contient uniquement les cessions réalisées, pas les positions encore ouvertes.
        </Def>
        <Def term="Performance" color="indigo">
          Série temporelle journalière : TWR cumulé, valeur du portefeuille, % daily returns. Source du graphique TWR, de la heatmap et du calcul de volatilité.
        </Def>
        <Def term="Mouvements d'espèces" color="indigo">
          Flux de trésorerie : Cash Amount = dépôts/retraits. Source du calcul de l'IRR (XIRR).
        </Def>
      </Section>

      {/* ── Types d'actifs ── */}
      <Section title="🏷️ Types d'Actifs & Exchanges">
        <Def term="Stock" color="indigo">Actions — instruments de type action cotés sur un marché réglementé.</Def>
        <Def term="ETF" color="teal">Exchange Traded Fund — fonds indiciel coté en bourse, répliquant un indice ou un panier d'actifs.</Def>
        <Def term="OPCVM / MutualFund" color="violet">Organisme de Placement Collectif en Valeurs Mobilières — fonds géré activement, valorisé à une VL quotidienne. Dans Saxo : type «MutualFund», transaction «Mutual Funds Traded Value».</Def>
        <Def term=":xpar" color="indigo">Euronext Paris</Def>
        <Def term=":xams" color="indigo">Euronext Amsterdam</Def>
        <Def term=":xetr" color="indigo">Xetra (Deutsche Börse, Francfort)</Def>
        <Def term=":xmil" color="indigo">Borsa Italiana (Milan)</Def>
        <Def term=":xnas" color="amber">NASDAQ (New York) — bourse USD, soumise à Exchange Fee</Def>
        <Def term=":xnys" color="amber">NYSE (New York) — bourse USD, soumise à Exchange Fee</Def>
      </Section>

    </div>
  );
}

// ─── Composant PositionsTable avec tri ───────────────────────────────────────

const ASSET_BADGE = {
  Stock:      { label: "Action",  cls: "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30" },
  Etf:        { label: "ETF",     cls: "bg-teal-500/20 text-teal-300 border border-teal-500/30" },
  MutualFund: { label: "OPCVM",   cls: "bg-violet-500/20 text-violet-300 border border-violet-500/30" },
};

function PositionsTable({ positions }) {
  const [sortKey, setSortKey] = useState("pl");
  const [sortDir, setSortDir] = useState("desc");

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir(d => d === "desc" ? "asc" : "desc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sorted = [...positions].sort((a, b) => {
    const plA = a.plNet ?? a.realized;
    const plB = b.plNet ?? b.realized;
    let va, vb;
    if (sortKey === "pl")     { va = plA; vb = plB; }
    else if (sortKey === "plpct") { va = a.buys > 0 ? plA / a.buys : 0; vb = b.buys > 0 ? plB / b.buys : 0; }
    else if (sortKey === "buys")  { va = a.buys; vb = b.buys; }
    else if (sortKey === "sells") { va = a.sells; vb = b.sells; }
    else if (sortKey === "trades"){ va = a.trades; vb = b.trades; }
    else if (sortKey === "sym")   { va = a.sym; vb = b.sym; return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va); }
    else if (sortKey === "type")  { va = a.assetType || "Stock"; vb = b.assetType || "Stock"; return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va); }
    else { va = plA; vb = plB; }
    return sortDir === "asc" ? va - vb : vb - va;
  });

  const SortTh = ({ label, colKey, align = "right", tooltip }) => {
    const active = sortKey === colKey;
    const arrow = active ? (sortDir === "desc" ? " ↓" : " ↑") : " ↕";
    return (
      <th
        onClick={() => handleSort(colKey)}
        className={`py-3 px-4 font-semibold cursor-pointer select-none transition-colors hover:text-white text-xs uppercase tracking-wide ${align === "left" ? "text-left" : "text-right"} ${active ? "text-white" : "text-indigo-300"}`}
        style={{ userSelect: "none" }}
      >
        <span className="flex items-center gap-1 justify-end">
          {tooltip && <InfoTooltip text={tooltip} />}
          {label}
          <span className={`text-xs ${active ? "text-indigo-400" : "text-white/20"}`}>{arrow}</span>
        </span>
      </th>
    );
  };

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
      <div className="p-4 border-b border-white/10 text-indigo-300 text-sm flex items-center gap-1">
        {positions.length} positions
        <InfoTooltip text="P&L Net = gains/pertes réalisés (source onglet B/P). Cliquez sur un en-tête de colonne pour trier. Cliquez à nouveau pour inverser." />
        <span className="ml-2 text-white/30 text-xs">· cliquez sur un en-tête pour trier</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-white/5">
              <th onClick={() => handleSort("sym")} className={`text-left py-3 px-4 font-semibold cursor-pointer select-none transition-colors hover:text-white text-xs uppercase tracking-wide ${sortKey === "sym" ? "text-white" : "text-indigo-300"}`}>
                Symbole {sortKey === "sym" ? (sortDir === "desc" ? "↓" : "↑") : <span className="text-white/20">↕</span>}
              </th>
              <th onClick={() => handleSort("type")} className={`text-left py-3 px-4 font-semibold cursor-pointer select-none transition-colors hover:text-white text-xs uppercase tracking-wide ${sortKey === "type" ? "text-white" : "text-indigo-300"}`}>
                Type {sortKey === "type" ? (sortDir === "desc" ? "↓" : "↑") : <span className="text-white/20">↕</span>}
              </th>
              <th className="text-left text-indigo-300 py-3 px-4 font-semibold text-xs uppercase tracking-wide">Nom</th>
              <SortTh label="Achats"   colKey="buys"   tooltip="Montant total investi (achats nets). Cliquez pour trier." />
              <SortTh label="Ventes"   colKey="sells"  tooltip="Montant total encaissé sur les cessions." />
              <SortTh label="P&L Net"  colKey="pl"     tooltip="Bénéfice ou perte réalisé. Source onglet B/P du fichier." />
              <SortTh label="P&L %"    colKey="plpct"  tooltip="P&L Net / Achats × 100. Rendement réalisé sur le capital investi dans ce titre." />
              <SortTh label="Trades"   colKey="trades" tooltip="Nombre d'opérations (achats + ventes) exécutées sur ce titre." />
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => {
              const pl = p.plNet ?? p.realized;
              return (
                <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="py-2.5 px-4 text-white font-mono font-semibold">{p.sym}</td>
                  <td className="py-2.5 px-4">
                    {(() => { const b = ASSET_BADGE[p.assetType] || ASSET_BADGE.Stock; return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${b.cls}`}>{b.label}</span>; })()}
                  </td>
                  <td className="py-2.5 px-4 text-indigo-200 max-w-xs truncate">{p.name}</td>
                  <td className="py-2.5 px-4 text-right text-white">{fmtEur(p.buys)}</td>
                  <td className="py-2.5 px-4 text-right text-white">{fmtEur(p.sells)}</td>
                  <td className={`py-2.5 px-4 text-right font-semibold ${pl >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtEur2(pl)}</td>
                  <td className={`py-2.5 px-4 text-right font-semibold ${pl >= 0 ? "text-green-400" : "text-red-400"}`}>{p.buys > 0 ? fmtPct(pl / p.buys * 100) : "—"}</td>
                  <td className="py-2.5 px-4 text-right text-indigo-300">{p.trades}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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

  // Rendements journaliers pour volatilité (valeurs en fraction ex: -0.004 = -0.4%)
  const dailyReturns = yearSeries
    .map(r => r.dailyPct || 0)
    .filter(v => v !== 0);

  // Volatilité annualisée = écart-type des rendements journaliers * sqrt(252)
  // Les dailyPct sont en fraction → on multiplie par 100 pour avoir des %
  let volatility = 0;
  if (dailyReturns.length > 1) {
    const returns_pct = dailyReturns.map(r => r * 100);
    const mean = returns_pct.reduce((a, b) => a + b, 0) / returns_pct.length;
    const variance = returns_pct.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (returns_pct.length - 1);
    volatility = Math.sqrt(variance) * Math.sqrt(252);
  }

  // Ratio Sharpe (taux sans risque ~3% annualisé)
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

  // CAGR annuel (pour 1 an = TWR, pour partiel = annualisé)
  let cagrYear = 0;
  if (yearSeries.length >= 2) {
    const d1 = parseSaxoDate(yearSeries[0].date);
    const d2 = parseSaxoDate(yearSeries[yearSeries.length-1].date);
    const nbJ = (d2 - d1) / (1000*60*60*24);
    if (nbJ > 0) cagrYear = (Math.pow(1 + twrAnnuel/100, 365/nbJ) - 1) * 100;
  } else {
    cagrYear = twrAnnuel;
  }

  return {
    year,
    ...yData,
    twrAnnuel,
    cagrYear,
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
  const lastYear = availableYears[availableYears.length - 1] || "";
  const prevYear = availableYears.length > 1 ? availableYears[availableYears.length - 2] : "";
  const [yearA, setYearA] = useState(lastYear);
  const [yearB, setYearB] = useState(prevYear);
  const [compareMode, setCompareMode] = useState(false);

  // Synchroniser yearA/yearB quand les années disponibles changent (filtre période)
  const validYearA = availableYears.includes(yearA) ? yearA : lastYear;
  const validYearB = availableYears.includes(yearB) ? yearB : prevYear;

  const statsA = validYearA ? buildYearStats(validYearA, data) : null;
  const statsB = compareMode && validYearB ? buildYearStats(validYearB, data) : null;

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

  if (!availableYears.length) return (
    <div className="text-white/40 text-center py-10">Aucune donnée disponible pour la période sélectionnée.</div>
  );

  if (!statsA) return (
    <div className="text-white/40 text-center py-10">Données insuffisantes pour afficher l'année {validYearA}. Essayez une période plus large.</div>
  );

  return (
    <div className="space-y-5">
      {/* Sélecteurs */}
      <div className="flex flex-wrap items-center gap-4 bg-white/5 border border-white/10 rounded-2xl p-4">
        <div className="flex items-center gap-2">
          <span className="text-indigo-300 text-sm font-semibold">Année</span>
          <select value={validYearA} onChange={e => setYearA(e.target.value)}
            style={{ background: "#1e1b4b", color: "white" }} className="px-3 py-2 rounded-xl text-sm text-white border border-white/20 focus:outline-none focus:border-indigo-400">
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
            <select value={validYearB} onChange={e => setYearB(e.target.value)}
              style={{ background: "#1e1b4b", color: "white" }} className="px-3 py-2 rounded-xl text-sm text-white border border-white/20 focus:outline-none focus:border-indigo-400">
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
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatBlock label="TWR" valueA={statsA.twrAnnuel} valueB={statsB?.twrAnnuel} format="pct"
              tooltip="Time-Weighted Return annuel : variation du TWR cumulé entre le 1er et dernier jour de l’annee. Mesure la performance pure indépendamment des flux." />
            <StatBlock label="P&L Réalisé" valueA={statsA.pl} valueB={statsB?.pl}
              tooltip="Bénéfices et pertes réalisés sur les cessions de la période (source onglet B/P)." />
            <StatBlock label="Résultat Net" valueA={statsA.resultat} valueB={statsB?.resultat}
              tooltip="P&L réalisé + dividendes + intérêts – frais totaux de l’annee." />
            <StatBlock label="Capital Investi" valueA={statsA.deposits} valueB={statsB?.deposits}
              tooltip="Total des dépôts entrants sur l’annee." />
          </div>

          <div className="grid grid-cols-3 md:grid-cols-4 gap-3">
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
              <InfoTooltip text="Variation mensuelle du TWR cumule. Barre verte = mois positif, rouge = negatif. Activer Comparer pour superposer une autre annee." />


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
                    {statsB && <td className={`py-3 px-4 text-right text-base ${statsB && (statsA.twrAnnuel - statsB.twrAnnuel) >= 0 ? "text-green-400" : "text-red-400"}`}>{statsB ? fmtPct(statsA.twrAnnuel - statsB.twrAnnuel) : "—"}</td>}
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

export default function PortfolioAnalyzer() {
  const [workbook, setWorkbook] = useState(null);
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(false);
  const [tab, setTab]           = useState("overview");
  const [error, setError]       = useState(null);
  const [filterCompte, setFilterCompte] = useState("ALL");
  const [dateStart, setDateStart]       = useState("");
  const [dateEnd,   setDateEnd]         = useState("");
  const [fileName, setFileName] = useState("");
  const [positionsData, setPositionsData] = useState(null);
  const [posFileName, setPosFileName] = useState("");

  // Parser du fichier Positions CSV Saxo
  const parsePositionsCSV = useCallback((file) => {
    if (!file) return;
    setPosFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        // Parser CSV robuste : gère les champs entre guillemets avec newlines intégrés
        const parseCSV = (str) => {
          const result = [];
          let row = [], cur = '', inQ = false, i = 0;
          while (i < str.length) {
            const ch = str[i];
            if (ch === '"') {
              if (inQ && str[i+1] === '"') { cur += '"'; i += 2; continue; } // guillemet échappé
              inQ = !inQ;
            } else if (ch === ',' && !inQ) {
              row.push(cur.replace(/^"|"$/g,'').trim()); cur = ''; i++; continue;
            } else if ((ch === '\n' || (ch === '\r' && str[i+1] === '\n')) && !inQ) {
              if (ch === '\r') i++;
              row.push(cur.replace(/^"|"$/g,'').trim()); cur = '';
              if (row.some(c => c !== '')) result.push(row);
              row = []; i++; continue;
            }
            cur += ch; i++;
          }
          if (cur || row.length) { row.push(cur.replace(/^"|"$/g,'').trim()); if (row.some(c => c !== '')) result.push(row); }
          return result;
        };

        const allRows = parseCSV(text);
        if (allRows.length < 2) return;
        const headers = allRows[0];
        const rows = [];
        for (let i = 1; i < allRows.length; i++) {
          const vals = allRows[i];
          if (vals.length < 5) continue;
          const row = {};
          headers.forEach((h, j) => row[h] = (vals[j] || '').replace(/\n/g,'').trim());
          rows.push(row);
        }

        const parseFR = (s) => {
          if (!s) return 0;
          return parseFloat(String(s).replace(/\s/g,'').replace(',','.')) || 0;
        };
        const parsePct = (s) => {
          if (!s) return 0;
          return parseFloat(String(s).replace('%','').replace(',','.')) || 0;
        };

        const TYPE_MAP = {
          'Actions': 'Stock',
          'Exchange Traded Fund (ETF)': 'Etf',
          'OPCVM': 'MutualFund',
          'ETF': 'Etf',
        };

        const positions = rows
          .filter(r => r['Symbole'] && r['Instruments'])
          .map(r => ({
            sym:        r['Symbole'].trim(),
            name:       r['Instruments'].trim(),
            isin:       r['ISIN'] || '',
            assetType:  TYPE_MAP[r["Type d'actif"]] || r["Type d'actif"] || 'Stock',
            assetLabel: r["Type d'actif"] || 'Stock',
            compte:     r['Compte'] || '',
            qty:        parseFR(r['Quantité']),
            prixEntree: parseFR(r['Prix entrée']),
            prixActuel: parseFR(r['Prix actuel']),
            valeur:     parseFR(r['Valeur actuelle (EUR)']),
            exposition: parseFR(r['Exposition (EUR)']),
            plNet:      parseFR(r['+/- Nette (EUR)']),
            plPct:      parsePct(r['+/- (%)']),
            devise:     r['Devise'] || 'EUR',
            variation1j: parsePct(r['% 1J']),
          }));

        const totalValeur  = positions.reduce((s,p) => s + p.valeur, 0);
        const totalLatent  = positions.reduce((s,p) => s + p.plNet, 0);
        const byType = {};
        const byCompte = {};
        positions.forEach(p => {
          if (!byType[p.assetLabel])   byType[p.assetLabel]   = { n:0, valeur:0, plNet:0 };
          if (!byCompte[p.compte||'?']) byCompte[p.compte||'?'] = { n:0, valeur:0, plNet:0 };
          byType[p.assetLabel].n++;   byType[p.assetLabel].valeur   += p.valeur; byType[p.assetLabel].plNet += p.plNet;
          byCompte[p.compte||'?'].n++; byCompte[p.compte||'?'].valeur += p.valeur; byCompte[p.compte||'?'].plNet += p.plNet;
        });

        setPositionsData({ positions, totalValeur, totalLatent, byType, byCompte, snapshot: file.name });
      } catch(err) {
        console.error('Erreur Positions CSV:', err);
      }
    };
    reader.readAsText(file, 'utf-8');
  }, []);

  const handleFile = useCallback((file) => {
    if (!file) return;
    setLoading(true); setError(null); setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        setWorkbook(wb);
        const processed = processXLSX(wb, "ALL");
        setData(processed);
        setFilterCompte("ALL");
        // Initialiser les bornes de date depuis le fichier
        if (processed.dateRange) {
          setDateStart(processed.dateRange.min);
          setDateEnd(processed.dateRange.max);
        }
      } catch (err) {
        setError("Erreur lecture : " + err.message);
      }
      setLoading(false);
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const handleFilterChange = (compte) => {
    setFilterCompte(compte);
    if (workbook) setData(processXLSX(workbook, compte, dateStart || null, dateEnd || null));
  };
  const handleDateFilter = (ds, de) => {
    if (workbook) setData(processXLSX(workbook, filterCompte, ds || null, de || null));
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
      ["Valeur Totale (officiel broker)", kpis.valeurTotale],
      ["Capital Net Investi", kpis.netDeposits],
      ["Résultat Net", kpis.netResult.toFixed(2)],
      ["TWR Officiel", kpis.twr.toFixed(4) + "%"],
      ["Dépôts", kpis.deposits], ["Retraits", kpis.withdrawals],
      ["Dividendes", kpis.dividends], ["Intérêts", kpis.interest],
      ["Commissions", kpis.fees.commission], ["Taxes FFT", kpis.fees.tax],
      ["Exchange Fees", kpis.fees.exchange], ["Autres frais", kpis.fees.other],
      ["Cash", kpis.cash], [],
      ["Symbole", "Nom", "Achats", "Ventes", "P&L Net"],
      ...positions.map((p) => [p.sym, p.name, p.buys.toFixed(2), p.sells.toFixed(2), (p.plNet ?? p.realized).toFixed(2)]),
    ];
    const csvQ = (v) => {
      const s = String(v ?? "");
      return s.includes(";") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g,'""')}"` : s;
    };
    const blob = new Blob(["\uFEFF" + rows.map(r => r.map(csvQ).join(";")).join("\n")], { type: "text/csv;charset=utf-8;" });
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
            <h1 className="text-3xl font-bold text-white tracking-tight">📊 {data?.broker || "Portfolio"} Analyzer</h1>
            {fileName && <p className="text-indigo-400 text-xs mt-1">{fileName}</p>}
          </div>
          {data && (
            <div className="flex gap-2 flex-wrap items-center">
              <select value={filterCompte} onChange={(e) => handleFilterChange(e.target.value)}
                style={{ background: "#1e1b4b", color: "white" }}
                className="px-3 py-2 rounded-xl text-sm text-white border border-white/20 focus:outline-none focus:border-indigo-400">
                <option style={{ background: "#1e1b4b" }} value="ALL">Tous les comptes</option>
                {data.comptes.map((c) => <option style={{ background: "#1e1b4b" }} key={c} value={c}>{COMPTES_LABELS[c] || c}</option>)}
              </select>

              {/* ── Filtre période ── */}
              <div className="flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-xl px-3 py-1.5 flex-wrap">
                <span className="text-white/40 text-xs">📅</span>

                {/* Menu preset */}
                {(() => {
                  const rangeMin = data.dateRange?.min || "";
                  const rangeMax = data.dateRange?.max || "";
                  const availYears = [...new Set([rangeMin, rangeMax].map(d => d.slice(0,4)))].sort();
                  const allYears = [];
                  const y0 = parseInt(rangeMin.slice(0,4));
                  const y1 = parseInt(rangeMax.slice(0,4));
                  for (let y = y0; y <= y1; y++) allYears.push(y);

                  const presets = [
                    { label: "Tout", ds: rangeMin, de: rangeMax },
                    ...allYears.map(y => ({ label: String(y), ds: `${y}-01-01`, de: `${y}-12-31` })),
                    ...allYears.flatMap(y => [
                      { label: `T1 ${y}`, ds: `${y}-01-01`, de: `${y}-03-31` },
                      { label: `T2 ${y}`, ds: `${y}-04-01`, de: `${y}-06-30` },
                      { label: `T3 ${y}`, ds: `${y}-07-01`, de: `${y}-09-30` },
                      { label: `T4 ${y}`, ds: `${y}-10-01`, de: `${y}-12-31` },
                    ]),
                    { label: "6 mois", ds: (() => { const d = new Date(rangeMax); d.setMonth(d.getMonth()-6); return d.toISOString().slice(0,10); })(), de: rangeMax },
                    { label: "3 mois", ds: (() => { const d = new Date(rangeMax); d.setMonth(d.getMonth()-3); return d.toISOString().slice(0,10); })(), de: rangeMax },
                    { label: "1 mois", ds: (() => { const d = new Date(rangeMax); d.setMonth(d.getMonth()-1); return d.toISOString().slice(0,10); })(), de: rangeMax },
                  ];

                  const currentPreset = presets.find(p => p.ds === dateStart && p.de === dateEnd);

                  return (
                    <select
                      value={currentPreset?.label || ""}
                      onChange={e => {
                        const p = presets.find(x => x.label === e.target.value);
                        if (!p) return;
                        const ds = p.ds < rangeMin ? rangeMin : p.ds;
                        const de = p.de > rangeMax ? rangeMax : p.de;
                        setDateStart(ds); setDateEnd(de);
                        handleDateFilter(ds, de);
                      }}
                      style={{ background: "#1e1b4b", color: "white", colorScheme: "dark" }}
                      className="text-xs border border-white/20 rounded-lg px-2 py-1 outline-none focus:border-indigo-400"
                    >
                      <option value="" style={{ background: "#1e1b4b" }}>Période…</option>
                      {presets.map(p => (
                        <option key={p.label} value={p.label} style={{ background: "#1e1b4b" }}>{p.label}</option>
                      ))}
                    </select>
                  );
                })()}

                <input
                  type="date"
                  value={dateStart}
                  onChange={e => { setDateStart(e.target.value); handleDateFilter(e.target.value, dateEnd); }}
                  style={{ background: "transparent", colorScheme: "dark" }}
                  className="text-white text-xs border-none outline-none w-28"
                />
                <span className="text-white/30 text-xs">→</span>
                <input
                  type="date"
                  value={dateEnd}
                  onChange={e => { setDateEnd(e.target.value); handleDateFilter(dateStart, e.target.value); }}
                  style={{ background: "transparent", colorScheme: "dark" }}
                  className="text-white text-xs border-none outline-none w-28"
                />
                {(dateStart !== (data.dateRange?.min || "") || dateEnd !== (data.dateRange?.max || "")) && (
                  <button
                    onClick={() => {
                      const min = data.dateRange?.min || "";
                      const max = data.dateRange?.max || "";
                      setDateStart(min); setDateEnd(max);
                      handleDateFilter(min, max);
                    }}
                    className="text-indigo-400 text-xs hover:text-white transition-colors ml-1"
                    title="Réinitialiser la période"
                  >✕</button>
                )}
              </div>


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
              <p className="text-white text-xl font-semibold mb-2">Glissez votre fichier d'export ici</p>
              <p className="text-indigo-300 text-sm mb-1">ou cliquez pour sélectionner</p>
              <p className="text-indigo-500 text-xs font-mono mt-2">AggregatedAmounts_*.xlsx · Saxo Bank</p>
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
                <div className="grid grid-cols-3 md:grid-cols-4 gap-3">
                  <KpiCard label="Valeur Totale" value={fmtEur(data.kpis.valeurTotale)} icon="💎" color="violet" tooltip="Valeur totale du portefeuille au dernier jour calculé par (onglet Performance du fichier)." />
                  <KpiCard label="Capital Net Investi" value={fmtEur(data.kpis.netDeposits)} icon="💶" color="indigo" tooltip="Dépôts cumulés moins les retraits. Représente le capital réellement engagé depuis l’ouverture du compte." />
                  <KpiCard label="Résultat Net" value={fmtEur(data.kpis.netResult)} sub={fmtPct(data.kpis.perfPct)} icon="📈" color={data.kpis.netResult >= 0 ? "green" : "red"} tooltip="P&L réalisé + dividendes + intérêts – frais totaux. Le % est calculé sur le capital net investi." />
                  <KpiCard label="TWR Officiel" value={fmtPct(data.kpis.twr)} icon="🎯" color={data.kpis.twr >= 0 ? "teal" : "red"} tooltip="Time-Weighted Return : mesure la performance pure des investissements indépendamment des entrées/sorties de capital. Chiffre officiel Saxo." />
                  <KpiCard label="CAGR (annualisé)" value={fmtPct(data.kpis.cagr)} icon="📐" color={data.kpis.cagr >= 0 ? "teal" : "red"} tooltip="Compound Annual Growth Rate : TWR annualisé sur la durée réelle. Formule : (1 + TWR)^(365/nbJours) - 1. Permet de comparer des périodes de durées différentes." />
                  <KpiCard label="IRR / TRI" value={data.kpis.irr != null ? fmtPct(data.kpis.irr) : "N/A"} icon="💹" color={data.kpis.irr != null && data.kpis.irr >= 0 ? "green" : "red"} tooltip="Internal Rate of Return (Taux de Rendement Interne) : rendement réel du capital investi tenant compte des dates exactes de chaque dépôt/retrait. Métrique clé en gestion patrimoniale." />
                </div>
                <div className="grid grid-cols-3 md:grid-cols-4 gap-3">
                  <KpiCard label="Dépôts" value={fmtEur(data.kpis.deposits)} icon="⬆️" color="indigo" tooltip="Total des virements entrants (Cash Amount positifs) sur la période analysée." />
                  <KpiCard label="Retraits" value={fmtEur(data.kpis.withdrawals)} icon="⬇️" color="pink" tooltip="Total des virements sortants sur la période analysée." />
                  <KpiCard label="Dividendes" value={fmtEur(data.kpis.dividends)} icon="🌱" color="green" tooltip="Dividendes en espèces versés par les actions détenues (Corporate Actions - Cash Dividends)." />
                  <KpiCard label="Intérêts" value={fmtEur(data.kpis.interest)} icon="⚡" color="teal" tooltip="Intérêts créditeurs reçus sur les liquidités du compte (Client Interest)." />
                </div>
                <div className="grid grid-cols-3 md:grid-cols-4 gap-3">
                  <KpiCard label="Frais Totaux" value={"-" + fmtEur(data.kpis.totalFees)} icon="🏦" color="amber" tooltip="Somme de toutes les charges : commissions, taxe FFT, frais de change, taxes sociales." />
                  <KpiCard label="Commissions" value={"-" + fmtEur(data.kpis.fees.commission)} sub={data.kpis.totalVolume > 0 ? (data.kpis.fees.commission / data.kpis.totalVolume * 100).toFixed(3) + " % du volume traité" : ""} icon="📋" color="amber" tooltip="Frais de courtage (Commission) sur chaque ordre. % = commissions / (achats + ventes) : taux effectif moyen sur le volume total traité." />
                  <KpiCard label="Taxes FFT" value={"-" + fmtEur(data.kpis.fees.tax)} icon="🏛️" color="amber" tooltip="Taxe sur les Transactions Financières française (0,3%) applicable aux achats d’actions françaises de plus de 1 milliard de capitalisation." />
                  <KpiCard label="Frais / Volume" value={data.kpis.totalVolume > 0 ? ((data.kpis.totalFees / data.kpis.totalVolume) * 100).toFixed(3) + " %" : "N/A"} sub={data.kpis.netDeposits > 0 ? ((data.kpis.totalFees / data.kpis.netDeposits) * 100).toFixed(3) + " % du capital" : ""} icon="⚖️" color="amber" tooltip="Frais totaux / (achats + ventes) = coût effectif moyen sur le volume total traité. Sous en-tête : frais / capital net investi." />
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
                <div className="grid grid-cols-3 gap-3">
                  <KpiCard label={`TWR (${data.broker})`} value={fmtPct(data.kpis.twr)} icon="🎯" color="teal" sub="Time-Weighted Return" tooltip="Rendement pondéré dans le temps : élimine l’effet des dépôts/retraits pour mesurer la pure performance de la gestion. Standard CFA/GIPS." />
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
                      <h3 className="text-white font-semibold mb-4 flex items-center">TWR Cumulé (officiel)<InfoTooltip text="Time-Weighted Return cumulé depuis le début de la période. Mesure la performance de la gestion indépendamment des flux de trésorerie. Source : onglet ’Performance’ du fichier Saxo." /></h3>
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
                    <h3 className="text-white font-semibold mb-4 flex items-center">🏆 Top 10 P&L<InfoTooltip text="10 positions ayant généré le plus grand gain réalisé sur la période. P&L = Prix de vente – Prix d’achat (hors frais), source onglet B/P." /></h3>
                    <div className="space-y-2">
                      {data.positions.slice(0, 10).map((p, i) => {
                        const pl = p.plNet ?? p.realized;
                        const plpct = p.buys > 0 ? (pl / p.buys * 100) : null;
                        return (
                          <div key={i} className="flex items-center justify-between py-1.5 border-b border-white/5 gap-2">
                            <span className="text-xs text-white/40 w-4 shrink-0">{i+1}</span>
                            <div className="flex-1 min-w-0">
                              <div className="text-indigo-200 font-mono text-xs font-semibold truncate">{p.sym}</div>
                              <div className="text-white/40 text-xs truncate">{p.name}</div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className={`font-semibold text-sm ${pl >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtEur(pl)}</div>
                              {plpct != null && <div className={`text-xs ${pl >= 0 ? "text-green-400/70" : "text-red-400/70"}`}>+{plpct.toFixed(1)} %</div>}
                            </div>
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
                        const plpct = p.buys > 0 ? (pl / p.buys * 100) : null;
                        return (
                          <div key={i} className="flex items-center justify-between py-1.5 border-b border-white/5 gap-2">
                            <span className="text-xs text-white/40 w-4 shrink-0">{i+1}</span>
                            <div className="flex-1 min-w-0">
                              <div className="text-indigo-200 font-mono text-xs font-semibold truncate">{p.sym}</div>
                              <div className="text-white/40 text-xs truncate">{p.name}</div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className={`font-semibold text-sm ${pl >= 0 ? "text-green-400" : "text-red-400"}`}>{fmtEur(pl)}</div>
                              {plpct != null && <div className={`text-xs ${pl >= 0 ? "text-green-400/70" : "text-red-400/70"}`}>{pl >= 0 ? "+" : ""}{plpct.toFixed(1)} %</div>}
                            </div>
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

            {/* Analyse Temporelle */}
            {tab === "temporelle" && (
              <TemporelleView data={data} />
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
                          {["Année","Dépôts","Achats","Ventes","P&L Net","P&L %","Frais","Frais %","Dividendes","Résultat","Perf %"].map(h => (
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
                              <td className={`py-3 px-4 text-right font-semibold ${y.pl >= 0 ? "text-green-400" : "text-red-400"}`}>{(y.buys + y.sells) > 0 ? fmtPct(y.pl / (y.buys + y.sells) * 100) : "—"}</td>
                              <td className="py-3 px-4 text-right text-amber-400">{y.fees > 0 ? "-" + fmtEur(y.fees) : "—"}</td>
                              <td className="py-3 px-4 text-right text-amber-400">{(y.buys + y.sells) > 0 && y.fees > 0 ? (y.fees / (y.buys + y.sells) * 100).toFixed(3) + " %" : "—"}</td>
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
                          {["Trimestre","Dépôts","Achats","Ventes","P&L Net","P&L %","Frais","Frais %","Dividendes","Résultat","Perf %"].map(h => (
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
                              <td className={`py-2.5 px-4 text-right font-semibold ${q.pl >= 0 ? "text-green-400" : "text-red-400"}`}>{(q.buys + q.sells) > 0 ? fmtPct(q.pl / (q.buys + q.sells) * 100) : "—"}</td>
                              <td className="py-2.5 px-4 text-right text-amber-400">{q.fees > 0 ? "-" + fmtEur(q.fees) : "—"}</td>
                              <td className="py-2.5 px-4 text-right text-amber-400">{(q.buys + q.sells) > 0 && q.fees > 0 ? (q.fees / (q.buys + q.sells) * 100).toFixed(3) + " %" : "—"}</td>
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
              <PositionsTable positions={data.positions} />
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
                <div className="grid grid-cols-3 md:grid-cols-4 gap-3">
                  <KpiCard label="Total Frais" value={"-"+fmtEur(data.kpis.totalFees)} icon="💸" color="red" tooltip="Somme de toutes les charges prélevées : courtage, FFT, frais de change, taxes sociales et retenues à la source." />
                  <KpiCard label="Commissions" value={"-"+fmtEur(data.kpis.fees.commission)} sub={data.kpis.totalVolume > 0 ? (data.kpis.fees.commission / data.kpis.totalVolume * 100).toFixed(3) + " % du volume traité" : ""} icon="🏦" color="amber" tooltip="Frais de courtage (Commission) sur chaque ordre. % = commissions / (achats + ventes) : taux effectif moyen sur le volume total traité." />
                  <KpiCard label="Taxes FFT" value={"-"+fmtEur(data.kpis.fees.tax)} icon="🏛️" color="amber" tooltip="French Financial Transaction Tax (0,3%) sur les achats d’actions françaises de plus de 1 Md€ de capitalisation." />
                  <KpiCard label="Exchange + Autres" value={"-"+fmtEur(data.kpis.fees.exchange + data.kpis.fees.other)} sub={data.kpis.volumeNonEur > 0 ? (data.kpis.fees.exchange / data.kpis.volumeNonEur * 100).toFixed(3) + " % vol. hors EUR" : "—"} icon="🔄" color="amber" tooltip="Exchange Fee rapporté au volume traité en devises étrangères (hors EUR) uniquement. Social Tax, Withholding Tax et Advanced Income Tax inclus dans le total." />
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
                <div className="grid grid-cols-3 gap-3">
                  <KpiCard label="Frais / Volume total"
                    value={data.kpis.totalVolume > 0 ? ((data.kpis.totalFees / data.kpis.totalVolume) * 100).toFixed(3) + " %" : "N/A"}
                    icon="📊" color="amber"
                    tooltip="Frais totaux / (achats + ventes) : coût effectif moyen de transaction sur le volume total traité." />
                  <KpiCard label="Frais / Capital investi"
                    value={data.kpis.netDeposits > 0 ? ((data.kpis.totalFees / data.kpis.netDeposits) * 100).toFixed(3) + " %" : "N/A"}
                    icon="⚖️" color="amber"
                    tooltip="Frais totaux / capital net investi (dépôts - retraits). Mesure le poids des frais par rapport au capital engagé." />
                  <KpiCard label="Frais / Résultat brut"
                    value={(data.kpis.netResult + data.kpis.totalFees) > 0 ? ((data.kpis.totalFees / (data.kpis.netResult + data.kpis.totalFees)) * 100).toFixed(1) + " %" : "N/A"}
                    icon="🎯" color={(data.kpis.netResult + data.kpis.totalFees) > 0 && (data.kpis.totalFees / (data.kpis.netResult + data.kpis.totalFees)) < 0.2 ? "green" : "red"}
                    tooltip="Frais / (P&L brut avant frais). Mesure la part des gains capturés par les frais. En dessous de 20% = efficace. Au-dessus de 50% = les frais consomment une grande partie de la performance." />
                </div>
              </div>
            )}
            {/* Portefeuille */}
            {tab === "portefeuille" && (
              <PortefeuilleView positionsData={positionsData} parsePositionsCSV={parsePositionsCSV} posFileName={posFileName} data={data} />
            )}

            {/* Notes */}
            {tab === "notes" && (
              <NotesView data={data} dateStart={dateStart} dateEnd={dateEnd} dateRange={data.dateRange} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

