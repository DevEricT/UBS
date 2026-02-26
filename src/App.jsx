// ═══════════════════════════════════════════════════════════════════════════
// UBS Portfolio Analyzer — v1.1
// Charte UBS : rouge #EC0000 / blanc / noir
// ═══════════════════════════════════════════════════════════════════════════
import React, { useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import {
  LineChart, BarChart, PieChart, ComposedChart,
  Line, Bar, Area, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

// ─── Palette UBS ──────────────────────────────────────────────────────────
// #EC0000 = UBS Red officiel
// #1A0000 = rouge très sombre (background)
// #2D0000 = rouge sombre (cards)
// #FFFFFF = blanc pur (texte principal)

// ─── Helpers date universels ──────────────────────────────────────────────
const parseSaxoDate = (d) => {
  if (!d) return null;
  if (typeof d === "number") {
    const date = XLSX.SSF.parse_date_code(d);
    if (date) return new Date(date.y, date.m - 1, date.d);
  }
  const s = String(d).trim().replace(/\//g, "-");
  const p = s.split("-");
  if (p.length !== 3) return null;
  const iso = p[0].length === 4
    ? `${p[0]}-${p[1].padStart(2,"0")}-${p[2].padStart(2,"0")}`
    : `${p[2]}-${p[1].padStart(2,"0")}-${p[0].padStart(2,"0")}`;
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? null : dt;
};

const toYMD = (d) => {
  if (!d) return "";
  if (typeof d === "number") {
    const date = XLSX.SSF.parse_date_code(d);
    if (date) return `${date.y}${String(date.m).padStart(2,"0")}${String(date.d).padStart(2,"0")}`;
  }
  const s = String(d).trim().replace(/\//g, "-");
  const p = s.split("-");
  if (p.length !== 3) return "";
  if (p[0].length === 4) return p[0] + p[1].padStart(2,"0") + p[2].padStart(2,"0");
  return p[2] + p[1].padStart(2,"0") + p[0].padStart(2,"0");
};

const monthKey  = (d) => { const y = toYMD(d); return y ? `${y.slice(4,6)}/${y.slice(0,4)}` : "??"; };
const yearKey   = (d) => { const y = toYMD(d); return y ? y.slice(0,4) : "??"; };
const quarterKey= (d) => { const y = toYMD(d); if (!y) return "??"; return `Q${Math.ceil(Number(y.slice(4,6))/3)} ${y.slice(0,4)}`; };

// ─── Formatters ───────────────────────────────────────────────────────────
const fmtEur  = (v) => (v == null ? "—" : Number(v).toLocaleString("fr-FR", { style:"currency", currency:"EUR", maximumFractionDigits:0 }));
const fmtChf  = (v) => (v == null ? "—" : Number(v).toLocaleString("fr-CH", { style:"currency", currency:"CHF", maximumFractionDigits:0 }));
const fmtPct  = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(2)} %`);
const parseNum= (v) => { if (v == null || v === "") return 0; return parseFloat(String(v).replace(/[\s']/g,"").replace(",",".")) || 0; };

// ─── Détection de format UBS ──────────────────────────────────────────────
const detectUBSFormat = (workbook) => {
  const sheets = workbook.SheetNames.map(n => n.toLowerCase());
  if (sheets.some(s => s.includes("transaction")) && sheets.some(s => s.includes("position"))) return "KEY4_EXCEL";
  if (sheets.some(s => s.includes("portfolio") || s.includes("portefeuille"))) return "ADVISOR_EXCEL";
  if (workbook.SheetNames.length === 1) return "SIMPLE_CSV";
  return "UNKNOWN";
};

const findCol = (row, candidates) => {
  const keys = Object.keys(row || {});
  for (const c of candidates) {
    const found = keys.find(k => k.trim().toLowerCase() === c.toLowerCase());
    if (found) return found;
  }
  for (const c of candidates) {
    const found = keys.find(k => k.toLowerCase().includes(c.toLowerCase()));
    if (found) return found;
  }
  return null;
};

const UBS_COLS = {
  date:     ["Date", "Date de valeur", "Booking date", "Date comptable", "Datum"],
  desc:     ["Description", "Libellé", "Text", "Bezeichnung"],
  amount:   ["Montant", "Amount", "Betrag", "CHF", "EUR", "Montant en CHF"],
  currency: ["Devise", "Currency", "Währung"],
  type:     ["Type", "Category", "Catégorie", "Typ"],
  symbol:   ["Titre", "Security", "ISIN", "Valeur", "Wertpapier"],
  account:  ["Compte", "Account", "Konto", "Numéro de compte"],
};

// ─── Processeur UBS ───────────────────────────────────────────────────────
const processUBS = (workbook, filterCompte = "ALL", dateStart = null, dateEnd = null) => {
  const format = detectUBSFormat(workbook);
  const findSheet = (pred) => {
    const name = workbook.SheetNames.find(n => pred(String(n).toLowerCase()));
    return name ? workbook.Sheets[name] : null;
  };
  const toRows = (sheet) => sheet ? XLSX.utils.sheet_to_json(sheet, { defval: null }) : [];
  const ymdStart = dateStart ? dateStart.replace(/-/g,"") : null;
  const ymdEnd   = dateEnd   ? dateEnd.replace(/-/g,"")   : null;
  const inRange  = (d) => {
    const ymd = toYMD(d);
    if (!ymd) return false;
    if (ymdStart && ymd < ymdStart) return false;
    if (ymdEnd   && ymd > ymdEnd)   return false;
    return true;
  };

  const sheetTxn = format === "SIMPLE_CSV"
    ? workbook.Sheets[workbook.SheetNames[0]]
    : findSheet(n => n.includes("transaction") || n.includes("mouvement") || n.includes("opérat"));
  const sheetPos = findSheet(n => n.includes("position") || n.includes("portefeuille") || n.includes("portfolio"));

  const allTxns = toRows(sheetTxn);
  if (!allTxns.length) return buildEmptyResult(format, workbook.SheetNames);

  const sampleRow = allTxns.find(r => Object.values(r).some(v => v != null)) || allTxns[0];
  const COL = {
    date:    findCol(sampleRow, UBS_COLS.date)    || "Date",
    desc:    findCol(sampleRow, UBS_COLS.desc)    || "Description",
    amount:  findCol(sampleRow, UBS_COLS.amount)  || "Montant",
    currency:findCol(sampleRow, UBS_COLS.currency)|| "Devise",
    type:    findCol(sampleRow, UBS_COLS.type)    || "Type",
    symbol:  findCol(sampleRow, UBS_COLS.symbol)  || "Titre",
    account: findCol(sampleRow, UBS_COLS.account) || "Compte",
  };

  const comptes = [...new Set(allTxns.map(r => r[COL.account]).filter(Boolean))].sort();

  const txns = allTxns.filter(r => {
    if (!r[COL.date]) return false;
    if (!inRange(r[COL.date])) return false;
    if (filterCompte !== "ALL" && r[COL.account] !== filterCompte) return false;
    return true;
  });

  let deposits = 0, withdrawals = 0, dividends = 0, interest = 0;
  let fees = { commission: 0, tax: 0, other: 0 };
  let rebates = { commission: 0 };
  const positions = {};
  const months = {}, quarters = {}, years = {};

  const ensurePeriod = (mk, qk, yk) => {
    if (!months[mk])   months[mk]   = { period:mk, deposits:0, withdrawals:0, pl:0, fees:0, dividends:0 };
    if (!quarters[qk]) quarters[qk] = { period:qk, deposits:0, pl:0, fees:0, dividends:0 };
    if (!years[yk])    years[yk]    = { period:yk, deposits:0, pl:0, fees:0, dividends:0 };
  };

  txns.forEach(row => {
    const date = row[COL.date];
    const amt  = parseNum(row[COL.amount]);
    const desc = String(row[COL.desc] || row[COL.type] || "").trim();
    const sym  = String(row[COL.symbol] || "").trim();
    const mk = monthKey(date), qk = quarterKey(date), yk = yearKey(date);
    ensurePeriod(mk, qk, yk);
    const d = desc.toLowerCase();

    if (d.includes("virement") || d.includes("dépôt") || d.includes("versement") || d.includes("credit transfer") || d.includes("wire") || d.includes("einzahlung") || d.includes("gutschrift")) {
      if (amt > 0) { deposits += amt; months[mk].deposits += amt; years[yk].deposits += amt; }
      else { withdrawals += Math.abs(amt); months[mk].withdrawals += Math.abs(amt); }
    } else if (d.includes("dividende") || d.includes("dividend") || d.includes("coupon")) {
      dividends += amt; months[mk].dividends += amt; years[yk].dividends += amt;
    } else if (d.includes("intérêt") || d.includes("interest") || d.includes("zins")) {
      interest += amt;
    } else if (d.includes("commission") || d.includes("courtage") || d.includes("brokerage") || d.includes("frais de gest") || (d.includes("frais") && !d.includes("timbr"))) {
      if (amt < 0) { fees.commission += Math.abs(amt); months[mk].fees += Math.abs(amt); years[yk].fees += Math.abs(amt); }
      else { rebates.commission += amt; }
    } else if (d.includes("taxe") || d.includes("impôt") || d.includes("tax") || d.includes("timbr") || d.includes("droit de timbre")) {
      fees.tax += Math.abs(amt); months[mk].fees += Math.abs(amt); years[yk].fees += Math.abs(amt);
    } else if (sym || d.includes("achat") || d.includes("vente") || d.includes("buy") || d.includes("sell")) {
      const key = sym || desc.slice(0,20);
      if (!positions[key]) positions[key] = { sym: key, name: desc, buys:0, sells:0, dividends:0, trades:0 };
      positions[key].trades++;
      if (amt < 0) positions[key].buys += Math.abs(amt);
      else positions[key].sells += amt;
      positions[key].realized = positions[key].sells - positions[key].buys;
      months[mk].pl += amt; years[yk].pl += amt;
    }
  });

  const totalFees = fees.commission + fees.tax + fees.other - (rebates.commission || 0);
  const netResult = dividends + interest + Object.values(positions).reduce((s,p) => s + (p.realized ?? 0), 0) - totalFees;
  const netDeposits = deposits - withdrawals;

  let valeurTotale = 0;
  const posRows = toRows(sheetPos);
  if (posRows.length > 0) {
    const sp = posRows[0];
    const valCol = findCol(sp, ["Valeur", "Value", "Valorisation", "Market value", "Montant", "Wert", "Cours actuel"]);
    if (valCol) valeurTotale = posRows.reduce((s, r) => s + parseNum(r[valCol]), 0);
  }

  const allDates = allTxns.map(r => r[COL.date] ? toYMD(r[COL.date]) : "").filter(Boolean).sort();
  const dateRange = allDates.length ? {
    min: `${allDates[0].slice(0,4)}-${allDates[0].slice(4,6)}-${allDates[0].slice(6,8)}`,
    max: `${allDates.at(-1).slice(0,4)}-${allDates.at(-1).slice(4,6)}-${allDates.at(-1).slice(6,8)}`,
  } : null;

  const sortPeriod = (arr, isQ) => arr.sort((a,b) => {
    if (isQ) { const [qa,ya] = a.period.split(" "); const [qb,yb] = b.period.split(" "); return ya!==yb?Number(ya)-Number(yb):qa.localeCompare(qb); }
    return a.period.localeCompare(b.period);
  });

  return {
    broker:"UBS", format, colMapping: COL, sheetNames: workbook.SheetNames,
    kpis: { deposits, withdrawals, netDeposits, dividends, interest, fees, rebates, totalFees, netResult, valeurTotale, perfPct: netDeposits > 0 ? (netResult/netDeposits)*100 : 0 },
    positions: Object.values(positions).sort((a,b) => (b.realized??0)-(a.realized??0)),
    months: sortPeriod(Object.values(months), false),
    quarters: sortPeriod(Object.values(quarters), true),
    years: sortPeriod(Object.values(years), false),
    comptes, dateRange,
  };
};

const buildEmptyResult = (format, sheetNames=[]) => ({
  broker:"UBS", format, sheetNames,
  kpis:{ deposits:0,withdrawals:0,netDeposits:0,dividends:0,interest:0,fees:{commission:0,tax:0,other:0},rebates:{commission:0},totalFees:0,netResult:0,valeurTotale:0,perfPct:0 },
  positions:[], months:[], quarters:[], years:[], comptes:[], dateRange:null,
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPOSANTS UI — Charte UBS (rouge #EC0000 / fond sombre / blanc)
// ═══════════════════════════════════════════════════════════════════════════

// Logo UBS stylisé (3 touches = marque UBS)
function UBSLogo({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="4" fill="#EC0000"/>
      <rect x="6"  y="10" width="4" height="12" fill="white"/>
      <rect x="14" y="10" width="4" height="12" fill="white"/>
      <rect x="22" y="10" width="4" height="12" fill="white"/>
    </svg>
  );
}

// KPI Card — style UBS : bord gauche rouge, fond très sombre
function KpiCard({ label, value, sub, icon, positive, negative, tooltip }) {
  const [show, setShow] = useState(false);
  const ref = useRef(null);
  const borderColor = positive ? "#10b981" : negative ? "#EC0000" : "#EC0000";
  return (
    <div className="relative" style={{ background:"#0D0D0D", border:"1px solid #222", borderLeft:`3px solid ${borderColor}`, borderRadius:8, padding:"14px 16px" }}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div style={{ color:"#888", fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:4 }}>
            {label}
          </div>
          <div style={{ color: positive ? "#10b981" : negative ? "#EC0000" : "white", fontSize:20, fontWeight:700, lineHeight:1.2 }}>
            {value}
          </div>
          {sub && <div style={{ color:"#555", fontSize:11, marginTop:4 }}>{sub}</div>}
        </div>
        {icon && <span style={{ fontSize:20, opacity:0.6 }}>{icon}</span>}
      </div>
      {tooltip && (
        <button ref={ref} onClick={() => setShow(s=>!s)}
          style={{ position:"absolute", top:8, right:8, color:"#555", fontSize:11, background:"none", border:"none", cursor:"pointer" }}>ⓘ</button>
      )}
      {show && (
        <div style={{ position:"fixed", top:(ref.current?.getBoundingClientRect().bottom||0)+6, left:Math.min(ref.current?.getBoundingClientRect().left||0, window.innerWidth-280), zIndex:9999, width:260, background:"#1A1A1A", border:"1px solid #333", borderRadius:8, padding:12, fontSize:12, color:"#ccc", lineHeight:1.5 }}>
          {tooltip}
          <button onClick={()=>setShow(false)} style={{ position:"absolute", top:6, right:8, background:"none", border:"none", color:"#666", cursor:"pointer", fontSize:12 }}>✕</button>
        </div>
      )}
    </div>
  );
}

// Section card
function Section({ title, children, action }) {
  return (
    <div style={{ background:"#0D0D0D", border:"1px solid #222", borderRadius:12, overflow:"hidden", marginBottom:16 }}>
      <div style={{ padding:"12px 20px", borderBottom:"1px solid #1A1A1A", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <span style={{ color:"#888", fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em" }}>{title}</span>
        {action}
      </div>
      <div style={{ padding:20 }}>{children}</div>
    </div>
  );
}

// ─── Vue d'ensemble ───────────────────────────────────────────────────────
function OverviewTab({ data }) {
  const { kpis } = data;
  const pl = kpis.netResult;
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>

      {/* KPIs principaux */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))", gap:10 }}>
        <KpiCard label="Valeur Portefeuille" value={fmtEur(kpis.valeurTotale)} icon="💼" tooltip="Valorisation totale selon la feuille Positions (si disponible)." />
        <KpiCard label="Capital Net Investi" value={fmtEur(kpis.netDeposits)} icon="💰" tooltip="Dépôts moins retraits." />
        <KpiCard label="Résultat Net" value={fmtEur(pl)} icon={pl>=0?"📈":"📉"} positive={pl>0} negative={pl<0} tooltip="Dividendes + Intérêts + P&L réalisé − Frais nets." />
        <KpiCard label="ROI Simple" value={fmtPct(kpis.perfPct)} positive={kpis.perfPct>0} negative={kpis.perfPct<0} tooltip="Résultat Net / Capital Net Investi. Indicateur non pondéré par le temps." />
      </div>

      {/* Flux */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(160px, 1fr))", gap:10 }}>
        <KpiCard label="Dépôts" value={fmtEur(kpis.deposits)} icon="⬇️" />
        <KpiCard label="Retraits" value={fmtEur(kpis.withdrawals)} icon="⬆️" />
        <KpiCard label="Dividendes" value={fmtEur(kpis.dividends)} icon="🏅" positive={kpis.dividends>0} />
        <KpiCard label="Intérêts" value={fmtEur(kpis.interest)} icon="💹" positive={kpis.interest>0} />
        <KpiCard label="Commissions" value={"-"+fmtEur(kpis.fees.commission)} icon="🏦" negative />
        <KpiCard label="Taxes" value={"-"+fmtEur(kpis.fees.tax)} icon="🏛️" negative />
        <KpiCard label="Frais Nets" value={"-"+fmtEur(kpis.totalFees)} icon="💸" negative tooltip="Commissions + Taxes − Remboursements de commissions." />
        {kpis.rebates?.commission > 0 && <KpiCard label="Crédits comm." value={"+"+fmtEur(kpis.rebates.commission)} icon="↩️" positive tooltip="Remboursements de commissions reçus — déjà déduits des Frais Nets." />}
      </div>

      {/* Graphique P&L par année */}
      {data.years.length > 0 && (
        <Section title="P&L par année">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data.years} margin={{ left:10, right:10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1A1A" />
              <XAxis dataKey="period" tick={{ fill:"#666", fontSize:11 }} />
              <YAxis tick={{ fill:"#666", fontSize:11 }} tickFormatter={v => fmtEur(v)} width={90} />
              <Tooltip formatter={v => fmtEur(v)} contentStyle={{ background:"#111", border:"1px solid #333", borderRadius:8, color:"#fff", fontSize:12 }} />
              <Bar dataKey="pl" name="P&L" radius={[3,3,0,0]}>
                {data.years.map((e,i) => <Cell key={i} fill={e.pl>=0?"#EC0000":"#666"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Section>
      )}

      {/* Infos fichier */}
      <Section title="Fichier chargé">
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(160px,1fr))", gap:12 }}>
          {[
            { label:"Broker", val: data.broker },
            { label:"Format détecté", val: data.format },
            { label:"Période", val: data.dateRange ? `${data.dateRange.min} → ${data.dateRange.max}` : "—" },
            { label:"Feuilles", val: (data.sheetNames||[]).join(", ") || "—" },
          ].map(({label,val}) => (
            <div key={label}>
              <div style={{ color:"#555", fontSize:10, textTransform:"uppercase", fontWeight:700, marginBottom:4 }}>{label}</div>
              <div style={{ color:"#ccc", fontSize:12, fontFamily:"monospace" }}>{val}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* Mapping colonnes */}
      {data.colMapping && (
        <div style={{ background:"#120800", border:"1px solid #EC000044", borderRadius:12, padding:16 }}>
          <div style={{ color:"#EC0000", fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:10 }}>
            ⚠️ Mapping colonnes détecté — à vérifier
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(140px,1fr))", gap:8 }}>
            {Object.entries(data.colMapping).map(([k,v]) => (
              <div key={k} style={{ fontFamily:"monospace", fontSize:11 }}>
                <span style={{ color:"#666" }}>{k}: </span>
                <span style={{ color: v ? "#EC0000" : "#444" }}>{v || "non trouvé"}</span>
              </div>
            ))}
          </div>
          <div style={{ color:"#666", fontSize:11, marginTop:8 }}>Si des colonnes sont incorrectes, uploadez un vrai export UBS pour recalibrer.</div>
        </div>
      )}
    </div>
  );
}

// ─── Positions ────────────────────────────────────────────────────────────
function PositionsTab({ data }) {
  const [sortKey, setSortKey] = useState("realized");
  const [sortDir, setSortDir] = useState("desc");
  const positions = [...data.positions].sort((a,b) => {
    const va = a[sortKey]??0, vb = b[sortKey]??0;
    return sortDir==="desc" ? vb-va : va-vb;
  });
  const th = (label, col) => (
    <th onClick={() => { if (sortKey===col) setSortDir(d=>d==="desc"?"asc":"desc"); else {setSortKey(col);setSortDir("desc");} }}
      style={{ padding:"10px 14px", textAlign:"right", fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em",
        color: sortKey===col ? "#EC0000" : "#555", cursor:"pointer", whiteSpace:"nowrap", userSelect:"none" }}>
      {label} {sortKey===col ? (sortDir==="desc"?"↓":"↑") : "↕"}
    </th>
  );
  if (!positions.length) return <div style={{ textAlign:"center", color:"#555", padding:60 }}>Aucune position détectée dans le fichier.</div>;
  return (
    <Section title={`${positions.length} positions`}>
      <div style={{ overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
          <thead>
            <tr style={{ borderBottom:"1px solid #1A1A1A" }}>
              <th style={{ padding:"10px 14px", textAlign:"left", fontSize:10, fontWeight:700, textTransform:"uppercase", color:"#555", letterSpacing:"0.08em" }}>Titre</th>
              {th("Achats","buys")} {th("Ventes","sells")} {th("P&L Réalisé","realized")} {th("Dividendes","dividends")} {th("Trades","trades")}
            </tr>
          </thead>
          <tbody>
            {positions.map((p,i) => (
              <tr key={i} style={{ borderBottom:"1px solid #111" }} onMouseEnter={e=>e.currentTarget.style.background="#111"} onMouseLeave={e=>e.currentTarget.style.background=""}>
                <td style={{ padding:"10px 14px" }}>
                  <div style={{ color:"white", fontWeight:600, fontSize:12 }}>{p.sym}</div>
                  <div style={{ color:"#555", fontSize:11, maxWidth:240, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.name}</div>
                </td>
                <td style={{ padding:"10px 14px", textAlign:"right", color:"#888" }}>{fmtEur(p.buys)}</td>
                <td style={{ padding:"10px 14px", textAlign:"right", color:"#888" }}>{fmtEur(p.sells)}</td>
                <td style={{ padding:"10px 14px", textAlign:"right", fontWeight:700, color:(p.realized??0)>=0?"#EC0000":"#888" }}>{fmtEur(p.realized)}</td>
                <td style={{ padding:"10px 14px", textAlign:"right", color:"#10b981" }}>{fmtEur(p.dividends)}</td>
                <td style={{ padding:"10px 14px", textAlign:"right", color:"#555" }}>{p.trades}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop:"1px solid #333" }}>
              <td style={{ padding:"10px 14px", color:"#666", fontSize:11, fontWeight:700 }}>TOTAL</td>
              <td style={{ padding:"10px 14px", textAlign:"right", color:"#888" }}>{fmtEur(positions.reduce((s,p)=>s+p.buys,0))}</td>
              <td style={{ padding:"10px 14px", textAlign:"right", color:"#888" }}>{fmtEur(positions.reduce((s,p)=>s+p.sells,0))}</td>
              <td style={{ padding:"10px 14px", textAlign:"right", fontWeight:700, color:"#EC0000" }}>{fmtEur(positions.reduce((s,p)=>s+(p.realized??0),0))}</td>
              <td style={{ padding:"10px 14px", textAlign:"right", color:"#10b981" }}>{fmtEur(positions.reduce((s,p)=>s+(p.dividends||0),0))}</td>
              <td style={{ padding:"10px 14px", textAlign:"right", color:"#555" }}>{positions.reduce((s,p)=>s+p.trades,0)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Section>
  );
}

// ─── Périodes ─────────────────────────────────────────────────────────────
function PeriodesTab({ data }) {
  const [view, setView] = useState("years");
  const rows = view==="years" ? data.years : view==="quarters" ? data.quarters : data.months;
  const maxPl = Math.max(...rows.map(r => Math.abs(r.pl||0)), 1);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <div style={{ display:"flex", gap:6 }}>
        {["years","quarters","months"].map(v => (
          <button key={v} onClick={() => setView(v)} style={{
            padding:"7px 18px", borderRadius:6, border:"none", cursor:"pointer", fontSize:12, fontWeight:700, transition:"all .2s",
            background: view===v ? "#EC0000" : "#1A1A1A", color: view===v ? "white" : "#666" }}>
            {v==="years"?"Années":v==="quarters"?"Trimestres":"Mois"}
          </button>
        ))}
      </div>
      {!rows.length ? (
        <div style={{ textAlign:"center", color:"#555", padding:60 }}>Aucune donnée.</div>
      ) : (
        <Section title={`${rows.length} périodes`}>
          {/* Graphique barres */}
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={rows} margin={{ left:10, right:10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1A1A" />
              <XAxis dataKey="period" tick={{ fill:"#555", fontSize:10 }} />
              <YAxis tick={{ fill:"#555", fontSize:10 }} tickFormatter={v => fmtEur(v)} width={80} />
              <Tooltip formatter={v => fmtEur(v)} contentStyle={{ background:"#111", border:"1px solid #333", borderRadius:8, color:"#fff", fontSize:11 }} />
              <Bar dataKey="pl" name="P&L" radius={[2,2,0,0]}>
                {rows.map((e,i) => <Cell key={i} fill={e.pl>=0?"#EC0000":"#444"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {/* Tableau */}
          <div style={{ overflowX:"auto", marginTop:12 }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
              <thead>
                <tr style={{ borderBottom:"1px solid #1A1A1A" }}>
                  {["Période","Dépôts","P&L","Dividendes","Frais"].map((h,i) => (
                    <th key={h} style={{ padding:"8px 14px", textAlign: i===0?"left":"right", fontSize:10, fontWeight:700, textTransform:"uppercase", color:"#555", letterSpacing:"0.08em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r,i) => (
                  <tr key={i} style={{ borderBottom:"1px solid #111" }} onMouseEnter={e=>e.currentTarget.style.background="#111"} onMouseLeave={e=>e.currentTarget.style.background=""}>
                    <td style={{ padding:"8px 14px", color:"white", fontWeight:600, fontFamily:"monospace", fontSize:12 }}>{r.period}</td>
                    <td style={{ padding:"8px 14px", textAlign:"right", color:"#888" }}>{fmtEur(r.deposits)}</td>
                    <td style={{ padding:"8px 14px", textAlign:"right", fontWeight:700, color:(r.pl||0)>=0?"#EC0000":"#888" }}>{fmtEur(r.pl)}</td>
                    <td style={{ padding:"8px 14px", textAlign:"right", color:"#10b981" }}>{fmtEur(r.dividends)}</td>
                    <td style={{ padding:"8px 14px", textAlign:"right", color:"#666" }}>{fmtEur(r.fees)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}

// ─── Config ───────────────────────────────────────────────────────────────
function ConfigTab({ data }) {
  const formats = [
    { id:"KEY4_EXCEL",    label:"UBS Key4 / E-banking",    desc:"Feuilles Transactions + Positions. Colonnes : Date, Description, Montant, Devise, Type, Titre, Compte.", done:true },
    { id:"SIMPLE_CSV",   label:"CSV Transactions simple",  desc:"Mono-feuille avec historique des transactions UBS.", done:true },
    { id:"ADVISOR_EXCEL",label:"UBS Conseiller / Advisor", desc:"Format export conseiller avec feuilles Portfolio/Cash/Movements.", done:false },
  ];
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <Section title="Formats supportés">
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {formats.map(f => (
            <div key={f.id} style={{ display:"flex", gap:12, padding:12, borderRadius:8, border:`1px solid ${f.id===data.format?"#EC000066":f.done?"#222":"#1A1A1A"}`, background: f.id===data.format?"#1A0000":"transparent" }}>
              <span style={{ fontSize:16 }}>{f.id===data.format?"🔴":f.done?"⬜":"🔜"}</span>
              <div>
                <div style={{ color: f.id===data.format?"#EC0000":"#ccc", fontWeight:700, fontSize:12 }}>
                  {f.label} <span style={{ color:"#444", fontFamily:"monospace", fontSize:10, fontWeight:400 }}>({f.id})</span>
                  {f.id===data.format && <span style={{ marginLeft:8, color:"#EC0000", fontSize:10 }}>← ACTIF</span>}
                </div>
                <div style={{ color:"#555", fontSize:11, marginTop:3 }}>{f.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {data.format === "UNKNOWN" && (
        <div style={{ background:"#120000", border:"1px solid #EC000044", borderRadius:12, padding:16 }}>
          <div style={{ color:"#EC0000", fontSize:12, fontWeight:700, marginBottom:10 }}>Format non reconnu — Feuilles détectées :</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            {(data.sheetNames||[]).map(n => (
              <span key={n} style={{ background:"#1A1A1A", border:"1px solid #333", borderRadius:4, padding:"3px 8px", fontFamily:"monospace", fontSize:11, color:"#ccc" }}>{n}</span>
            ))}
          </div>
          <div style={{ color:"#666", fontSize:11, marginTop:8 }}>Transmettez ces noms pour qu'un adapter spécifique soit ajouté.</div>
        </div>
      )}

      <Section title="Comment ajouter un format">
        <div style={{ color:"#666", fontSize:12, lineHeight:1.7 }}>
          <p style={{ marginBottom:6 }}>1. Uploader le fichier UBS → le format est auto-détecté.</p>
          <p style={{ marginBottom:6 }}>2. Si <code style={{ color:"#EC0000", background:"#1A0000", padding:"1px 6px", borderRadius:4 }}>UNKNOWN</code> → noter les noms de feuilles affichés ci-dessus.</p>
          <p style={{ marginBottom:6 }}>3. Transmettre les noms de colonnes du mapping détecté (onglet Vue d'ensemble).</p>
          <p>4. Un adapter est ajouté dans <code style={{ color:"#EC0000", background:"#1A0000", padding:"1px 6px", borderRadius:4 }}>parseKey4()</code> ou un nouveau bloc.</p>
        </div>
      </Section>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// APP PRINCIPALE
// ═══════════════════════════════════════════════════════════════════════════
const TABS = [
  { id:"overview",  label:"Vue d'ensemble" },
  { id:"positions", label:"Positions" },
  { id:"periodes",  label:"Périodes" },
  { id:"config",    label:"⚙️ Config" },
];

const BG = "#080808";
const CARD_BG = "#0D0D0D";
const UBS_RED = "#EC0000";

export default function UBSAnalyzer() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [tab, setTab]         = useState("overview");
  const [fileName, setFileName] = useState("");
  const [filterCompte, setFilterCompte] = useState("ALL");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd]     = useState("");
  const [workbook, setWorkbook]   = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const dropRef = useRef(null);

  const processFile = useCallback((wb, compte, ds, de) => {
    try {
      const result = processUBS(wb, compte, ds || null, de || null);
      setData(result); setError(null);
    } catch(e) { setError("Erreur traitement : " + e.message); }
  }, []);

  const handleFile = useCallback((file) => {
    if (!file) return;
    setLoading(true); setError(null); setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type:"array", cellDates:true });
        setWorkbook(wb); processFile(wb, "ALL", "", "");
      } catch(err) { setError("Erreur lecture : " + err.message); }
      finally { setLoading(false); }
    };
    reader.readAsArrayBuffer(file);
  }, [processFile]);

  // ── Écran d'accueil ────────────────────────────────────────────────────
  if (!data) return (
    <div style={{ minHeight:"100vh", background:BG, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:24 }}>
      {/* Header UBS */}
      <div style={{ marginBottom:48, textAlign:"center" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:14, marginBottom:12 }}>
          <UBSLogo size={48} />
          <div style={{ textAlign:"left" }}>
            <div style={{ fontSize:28, fontWeight:800, color:"white", letterSpacing:"-0.02em" }}>Portfolio Analyzer</div>
            <div style={{ fontSize:13, color:"#555", marginTop:2 }}>UBS · Asset Management · Multi-format</div>
          </div>
        </div>
        {/* Ligne rouge signature UBS */}
        <div style={{ width:64, height:3, background:UBS_RED, margin:"0 auto" }} />
      </div>

      {/* Zone de drop */}
      <div ref={dropRef}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files[0]); }}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        style={{
          width:"100%", maxWidth:480, border:`2px dashed ${isDragging?UBS_RED:"#2A2A2A"}`,
          borderRadius:12, padding:"52px 32px", textAlign:"center", cursor:"pointer",
          background: isDragging ? "#1A0000" : "#0D0D0D",
          transition:"all .2s"
        }}>
        <div style={{ fontSize:48, marginBottom:16 }}>📁</div>
        <div style={{ fontSize:18, fontWeight:700, color:"white", marginBottom:6 }}>Glissez votre export UBS ici</div>
        <div style={{ fontSize:13, color:"#555", marginBottom:20 }}>ou cliquez pour sélectionner</div>
        <div style={{ fontSize:11, color:"#333", fontFamily:"monospace", marginBottom:24 }}>
          Excel (.xlsx) · CSV (.csv)<br/>UBS Key4 · E-banking · Conseiller
        </div>
        <label style={{ cursor:"pointer" }}>
          <span style={{ display:"inline-block", padding:"10px 28px", background:UBS_RED, color:"white", borderRadius:6, fontSize:13, fontWeight:700, transition:"opacity .2s" }}
            onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
            Choisir un fichier
          </span>
          <input type="file" accept=".xlsx,.xls,.csv" style={{ display:"none" }} onChange={e=>handleFile(e.target.files[0])} />
        </label>
      </div>

      {loading && <div style={{ marginTop:20, color:"#555", fontSize:13 }}>Analyse en cours…</div>}
      {error && (
        <div style={{ marginTop:16, padding:"12px 20px", background:"#1A0000", border:"1px solid #EC000044", borderRadius:8, color:UBS_RED, fontSize:13 }}>
          ❌ {error}
        </div>
      )}
    </div>
  );

  // ── App principale ─────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:"100vh", background:BG, color:"white" }}>

      {/* Header sticky */}
      <div style={{ position:"sticky", top:0, zIndex:40, background:"#050505", borderBottom:`1px solid #1A1A1A` }}>

        {/* Barre rouge UBS signature (2px) */}
        <div style={{ height:2, background:UBS_RED }} />

        {/* Header principal */}
        <div style={{ maxWidth:1200, margin:"0 auto", padding:"10px 20px", display:"flex", flexWrap:"wrap", alignItems:"center", gap:12 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginRight:12 }}>
            <UBSLogo size={28} />
            <div>
              <div style={{ fontSize:13, fontWeight:800, color:"white" }}>UBS Portfolio Analyzer</div>
              <div style={{ fontSize:10, color:"#444", fontFamily:"monospace" }}>{fileName}</div>
            </div>
          </div>

          {/* Filtre compte */}
          {data.comptes?.length > 0 && (
            <select value={filterCompte}
              onChange={e=>{ setFilterCompte(e.target.value); if(workbook) processFile(workbook,e.target.value,dateStart,dateEnd); }}
              style={{ background:"#111", color:"#ccc", border:"1px solid #2A2A2A", borderRadius:6, padding:"5px 10px", fontSize:12, outline:"none" }}>
              <option value="ALL">Tous les comptes</option>
              {data.comptes.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          )}

          {/* Filtre date */}
          <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:12 }}>
            {["dateStart","dateEnd"].map((field,i) => (
              <input key={field} type="date" value={field==="dateStart"?dateStart:dateEnd}
                onChange={e=>field==="dateStart"?setDateStart(e.target.value):setDateEnd(e.target.value)}
                style={{ background:"#111", color:"#ccc", border:"1px solid #2A2A2A", borderRadius:6, padding:"5px 8px", fontSize:11, outline:"none" }} />
            ))}
            <button onClick={()=>{ if(workbook) processFile(workbook,filterCompte,dateStart,dateEnd); }}
              style={{ padding:"5px 14px", background:UBS_RED, color:"white", border:"none", borderRadius:6, fontSize:12, fontWeight:700, cursor:"pointer" }}>
              Appliquer
            </button>
            {(dateStart||dateEnd) && (
              <button onClick={()=>{ setDateStart("");setDateEnd("");if(workbook)processFile(workbook,filterCompte,"",""); }}
                style={{ background:"none", border:"none", color:"#555", cursor:"pointer", fontSize:13 }}>✕</button>
            )}
          </div>

          <button onClick={()=>{ setData(null);setWorkbook(null);setFileName("");setFilterCompte("ALL");setDateStart("");setDateEnd(""); }}
            style={{ marginLeft:"auto", padding:"5px 12px", background:"#111", border:"1px solid #2A2A2A", color:"#666", borderRadius:6, fontSize:12, cursor:"pointer" }}>
            ← Changer
          </button>
        </div>

        {/* Onglets */}
        <div style={{ maxWidth:1200, margin:"0 auto", padding:"0 20px", display:"flex", gap:2, alignItems:"center" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              padding:"8px 18px", border:"none", borderBottom: tab===t.id ? `2px solid ${UBS_RED}` : "2px solid transparent",
              background:"none", color: tab===t.id ? "white" : "#555", fontWeight: tab===t.id ? 700 : 400,
              fontSize:13, cursor:"pointer", transition:"color .2s"
            }}>
              {t.label}
            </button>
          ))}
          <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:6, paddingBottom:2 }}>
            <span style={{ fontSize:10, fontFamily:"monospace", padding:"2px 8px", borderRadius:4, background: data.format==="UNKNOWN"?"#1A0000":"#0A1A0A", color: data.format==="UNKNOWN"?UBS_RED:"#10b981", border:`1px solid ${data.format==="UNKNOWN"?"#EC000044":"#10b98133"}` }}>
              {data.format}
            </span>
          </div>
        </div>
      </div>

      {/* Contenu */}
      <div style={{ maxWidth:1200, margin:"0 auto", padding:"24px 20px" }}>
        {tab==="overview"  && <OverviewTab data={data} />}
        {tab==="positions" && <PositionsTab data={data} />}
        {tab==="periodes"  && <PeriodesTab data={data} />}
        {tab==="config"    && <ConfigTab data={data} />}
      </div>
    </div>
  );
}
