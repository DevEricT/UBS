// ═══════════════════════════════════════════════════════════════════════════
// UBS Portfolio Analyzer — v2.0
// Multi-fichiers, multi-dates : snapshots mensuels → courbe de performance
// Charte UBS : rouge #EC0000 / fond noir / blanc
// ═══════════════════════════════════════════════════════════════════════════
import React, { useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import {
  LineChart, BarChart, AreaChart, PieChart,
  Line, Bar, Area, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

// ─── Constantes ───────────────────────────────────────────────────────────
const UBS_RED   = "#EC0000";
const BG        = "#080808";
const CARD_BG   = "#0D0D0D";

const CLASSE_COLORS = {
  "Gestion libre":               "#EC0000",
  "Fonds €":                     "#3B82F6",
  "Obligations":                 "#10B981",
  "Gestion dédiée":              "#F59E0B",
  "Hedge funds & private markets":"#8B5CF6",
  "Actions":                     "#F97316",
  "Liquidités":                  "#6B7280",
  "Liquidites":                  "#6B7280",
};
const CLASSE_ORDER = ["Gestion libre","Fonds €","Obligations","Gestion dédiée","Hedge funds & private markets","Actions","Liquidités"];

// ─── Helpers ──────────────────────────────────────────────────────────────
const fmtEur  = (v, dec=0) => v == null ? "—" : Number(v).toLocaleString("fr-FR",{style:"currency",currency:"EUR",maximumFractionDigits:dec});
const fmtPct  = (v) => v == null ? "—" : `${v>=0?"+":""}${Number(v).toFixed(2)} %`;
const fmtNum  = (v) => v == null ? "—" : Number(v).toLocaleString("fr-FR",{maximumFractionDigits:2});

const parseNum = (v) => {
  if (v == null || v === "") return 0;
  const n = parseFloat(String(v).replace(/[\s']/g,"").replace(",","."));
  return isNaN(n) ? 0 : n;
};

// Extraire date YYYYMMDD depuis nom de fichier
const extractDateFromName = (name) => {
  const m = name.match(/(\d{8})/);
  return m ? m[1] : null;
};

// YYYYMMDD → "janv. 2026" et "2026-01-31"
const ymdToLabel = (ymd) => {
  if (!ymd || ymd.length !== 8) return ymd;
  const d = new Date(`${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}`);
  return d.toLocaleDateString("fr-FR",{month:"short",year:"numeric"});
};
const ymdToISO = (ymd) => ymd ? `${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}` : "";

// ─── Parser XLS via SheetJS ───────────────────────────────────────────────
const parsePositionsXLS = (buffer, filename) => {
  const wb = XLSX.read(buffer, { type:"array" });
  const dateStr = extractDateFromName(filename);
  const positions = [];

  for (const sheetName of wb.SheetNames) {
    const sh = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sh, { header:1, defval:"" });
    
    // Trouver la ligne header
    let headerIdx = -1;
    for (let r = 0; r < rows.length; r++) {
      if (String(rows[r][0]).trim() === "Quantité") { headerIdx = r; break; }
    }
    if (headerIdx === -1) continue;

    // Parser chaque ligne de données
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const montantEur = parseNum(row[8]);
      if (!montantEur || montantEur <= 0) continue;
      if (!row[2] || String(row[2]).trim() === "") continue; // Pas d'ISIN = ligne vide

      positions.push({
        date: dateStr,
        classe: sheetName,
        qte: parseNum(row[0]),
        nom: String(row[1] || "").trim(),
        isin: String(row[2] || "").trim(),
        devise: String(row[3] || "").trim(),
        pxAchat: parseNum(row[4]),
        pxMarche: parseNum(row[5]),
        dateVal: String(row[6] || "").trim(),
        montantDevise: parseNum(row[7]),
        montantEur,
        plEur: parseNum(row[10]),
        plDevise: parseNum(row[11]),
        plPct: parseNum(row[12]),
        poids: parseNum(row[13]),
      });
    }
  }

  return { date: dateStr, filename, positions };
};

// ─── Calcul snapshots consolidés ─────────────────────────────────────────
const buildSnapshots = (allParsed) => {
  // Grouper par date
  const byDate = {};
  for (const parsed of allParsed) {
    if (!parsed.date) continue;
    if (!byDate[parsed.date]) byDate[parsed.date] = [];
    byDate[parsed.date].push(...parsed.positions);
  }

  // Trier par date
  const dates = Object.keys(byDate).sort();

  const snapshots = dates.map(date => {
    const positions = byDate[date];
    const total = positions.reduce((s,p) => s + p.montantEur, 0);
    const plTotal = positions.reduce((s,p) => s + (p.plEur || 0), 0);

    // Par classe
    const byClasse = {};
    for (const p of positions) {
      const c = p.classe;
      if (!byClasse[c]) byClasse[c] = { montant: 0, pl: 0, positions: [] };
      byClasse[c].montant += p.montantEur;
      byClasse[c].pl += (p.plEur || 0);
      byClasse[c].positions.push(p);
    }

    return { date, label: ymdToLabel(date), iso: ymdToISO(date), total, plTotal, byClasse, positions };
  });

  // Calculer performance relative (TWR approx entre snapshots)
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i-1].total;
    const curr = snapshots[i].total;
    snapshots[i].perfMois = prev > 0 ? ((curr - prev) / prev) * 100 : 0;
    snapshots[i].variation = curr - prev;
  }
  if (snapshots.length > 0) {
    snapshots[0].perfMois = 0;
    snapshots[0].variation = 0;
  }

  // TWR cumulé depuis le premier snapshot
  if (snapshots.length > 0) {
    const base = snapshots[0].total;
    for (const s of snapshots) {
      s.perfCumulee = base > 0 ? ((s.total - base) / base) * 100 : 0;
    }
  }

  return snapshots;
};

// ─── Données graphique timeline ───────────────────────────────────────────
const buildChartData = (snapshots) => {
  return snapshots.map(s => {
    const point = {
      date: s.label,
      total: Math.round(s.total),
      pl: Math.round(s.plTotal),
      perf: s.perfMois ? parseFloat(s.perfMois.toFixed(2)) : 0,
      perfCum: s.perfCumulee ? parseFloat(s.perfCumulee.toFixed(2)) : 0,
    };
    for (const [c, d] of Object.entries(s.byClasse)) {
      point[c] = Math.round(d.montant);
    }
    return point;
  });
};

// ═══════════════════════════════════════════════════════════════════════════
// COMPOSANTS UI
// ═══════════════════════════════════════════════════════════════════════════

function UBSLogo({ size=32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="4" fill={UBS_RED}/>
      <rect x="6"  y="10" width="4" height="12" fill="white"/>
      <rect x="14" y="10" width="4" height="12" fill="white"/>
      <rect x="22" y="10" width="4" height="12" fill="white"/>
    </svg>
  );
}

function KpiCard({ label, value, sub, positive, negative, tooltip }) {
  const [show, setShow] = useState(false);
  const ref = useRef(null);
  const borderColor = positive ? "#10b981" : negative ? UBS_RED : "#333";
  return (
    <div className="relative" style={{ background:CARD_BG, border:"1px solid #1A1A1A", borderLeft:`3px solid ${borderColor}`, borderRadius:8, padding:"14px 16px" }}>
      <div style={{ color:"#666", fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:4 }}>{label}</div>
      <div style={{ color: positive?"#10b981": negative?UBS_RED:"white", fontSize:20, fontWeight:700 }}>{value}</div>
      {sub && <div style={{ color:"#444", fontSize:11, marginTop:3 }}>{sub}</div>}
      {tooltip && <button ref={ref} onClick={()=>setShow(s=>!s)} style={{ position:"absolute",top:8,right:8,color:"#444",fontSize:11,background:"none",border:"none",cursor:"pointer" }}>ⓘ</button>}
      {show && (
        <div style={{ position:"fixed",top:(ref.current?.getBoundingClientRect().bottom||0)+6,left:ref.current?.getBoundingClientRect().left||0,zIndex:9999,width:240,background:"#1A1A1A",border:"1px solid #333",borderRadius:8,padding:12,fontSize:12,color:"#ccc",lineHeight:1.5 }}>
          {tooltip}
          <button onClick={()=>setShow(false)} style={{ position:"absolute",top:6,right:8,background:"none",border:"none",color:"#666",cursor:"pointer" }}>✕</button>
        </div>
      )}
    </div>
  );
}

function Section({ title, children, noPad }) {
  return (
    <div style={{ background:CARD_BG, border:"1px solid #1A1A1A", borderRadius:12, overflow:"hidden", marginBottom:12 }}>
      <div style={{ padding:"10px 18px", borderBottom:"1px solid #161616" }}>
        <span style={{ color:"#555", fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em" }}>{title}</span>
      </div>
      <div style={noPad ? {} : { padding:18 }}>{children}</div>
    </div>
  );
}

// ─── Custom Tooltip pour Recharts ─────────────────────────────────────────
const CustomTooltip = ({ active, payload, label, formatter }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:"#111",border:"1px solid #222",borderRadius:8,padding:"10px 14px",fontSize:12,color:"white",minWidth:160 }}>
      <div style={{ color:"#888",marginBottom:6,fontWeight:700 }}>{label}</div>
      {payload.map((p,i) => (
        <div key={i} style={{ display:"flex",justifyContent:"space-between",gap:16,color:p.color,marginBottom:2 }}>
          <span style={{ color:"#888",fontSize:11 }}>{p.name}</span>
          <span style={{ fontWeight:700 }}>{formatter ? formatter(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
};

// ─── Vue d'ensemble ───────────────────────────────────────────────────────
function OverviewTab({ snapshots }) {
  const last = snapshots[snapshots.length - 1];
  const first = snapshots[0];
  const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
  const chartData = buildChartData(snapshots);
  const classes = [...new Set(snapshots.flatMap(s => Object.keys(s.byClasse)))].sort((a,b) => {
    const oa = CLASSE_ORDER.indexOf(a), ob = CLASSE_ORDER.indexOf(b);
    return (oa===-1?99:oa) - (ob===-1?99:ob);
  });

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
      {/* KPIs snapshot le plus récent */}
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:10 }}>
        <KpiCard label="Valorisation totale" value={fmtEur(last.total)} sub={last.label} tooltip="Somme de toutes les positions au dernier snapshot disponible." />
        <KpiCard label="P&L latent" value={fmtEur(last.plTotal)} positive={last.plTotal>0} negative={last.plTotal<0} tooltip="Plus ou moins-values latentes sur les positions avec prix d'achat connu." />
        {prev && <KpiCard label="Variation 1 mois" value={fmtEur(last.variation)} sub={fmtPct(last.perfMois)} positive={last.variation>0} negative={last.variation<0} />}
        {first && snapshots.length > 1 && <KpiCard label={`Perf. depuis ${first.label}`} value={fmtPct(last.perfCumulee)} positive={last.perfCumulee>0} negative={last.perfCumulee<0} tooltip="Performance cumulée depuis le premier snapshot chargé. Approximation — ne tient pas compte des flux de trésorerie." />}
        <KpiCard label="Positions" value={last.positions.length} sub={`${snapshots.length} snapshot${snapshots.length>1?"s":""} chargé${snapshots.length>1?"s":""}`} />
      </div>

      {/* Courbe valorisation totale */}
      {snapshots.length > 1 && (
        <Section title="Valorisation totale dans le temps">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData} margin={{ left:10,right:10 }}>
              <defs>
                <linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={UBS_RED} stopOpacity={0.3}/>
                  <stop offset="95%" stopColor={UBS_RED} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161616" />
              <XAxis dataKey="date" tick={{ fill:"#555",fontSize:10 }} />
              <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v => `${(v/1e6).toFixed(1)}M€`} width={60} />
              <Tooltip content={<CustomTooltip formatter={v => fmtEur(v)} />} />
              <Area type="monotone" dataKey="total" name="Total" stroke={UBS_RED} strokeWidth={2} fill="url(#gradTotal)" dot={{ r:3,fill:UBS_RED }} />
            </AreaChart>
          </ResponsiveContainer>
        </Section>
      )}

      {/* Répartition par classe — empilement */}
      {snapshots.length > 1 && (
        <Section title="Répartition par classe d'actif">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} margin={{ left:10,right:10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#161616" />
              <XAxis dataKey="date" tick={{ fill:"#555",fontSize:10 }} />
              <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v => `${(v/1e6).toFixed(1)}M€`} width={60} />
              <Tooltip content={<CustomTooltip formatter={v => fmtEur(v)} />} />
              <Legend wrapperStyle={{ fontSize:10,color:"#666" }} />
              {classes.map(c => (
                <Bar key={c} dataKey={c} stackId="a" fill={CLASSE_COLORS[c]||"#666"} name={c} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </Section>
      )}

      {/* Répartition du dernier snapshot — Pie */}
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
        <Section title={`Répartition au ${last.label}`}>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={Object.entries(last.byClasse).map(([c,d]) => ({ name:c, value:Math.round(d.montant) }))}
                cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="value" nameKey="name">
                {Object.entries(last.byClasse).map(([c],i) => (
                  <Cell key={i} fill={CLASSE_COLORS[c]||"#666"} />
                ))}
              </Pie>
              <Tooltip formatter={v => fmtEur(v)} contentStyle={{ background:"#111",border:"1px solid #222",borderRadius:8,fontSize:11 }} />
            </PieChart>
          </ResponsiveContainer>
          {/* Légende */}
          <div style={{ marginTop:8 }}>
            {Object.entries(last.byClasse).sort((a,b)=>b[1].montant-a[1].montant).map(([c,d]) => (
              <div key={c} style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4 }}>
                <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                  <div style={{ width:8,height:8,borderRadius:"50%",background:CLASSE_COLORS[c]||"#666",flexShrink:0 }}/>
                  <span style={{ color:"#888",fontSize:11 }}>{c}</span>
                </div>
                <div style={{ textAlign:"right" }}>
                  <span style={{ color:"white",fontSize:11,fontWeight:700 }}>{fmtEur(d.montant)}</span>
                  <span style={{ color:"#555",fontSize:10,marginLeft:6 }}>{((d.montant/last.total)*100).toFixed(1)}%</span>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* P&L latent par classe */}
        <Section title="P&L latent par classe">
          {Object.entries(last.byClasse)
            .filter(([,d]) => d.pl !== 0)
            .sort((a,b) => b[1].pl - a[1].pl)
            .map(([c,d]) => (
            <div key={c} style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10 }}>
              <div style={{ display:"flex",alignItems:"center",gap:6,flex:1 }}>
                <div style={{ width:6,height:6,borderRadius:"50%",background:CLASSE_COLORS[c]||"#666",flexShrink:0 }}/>
                <span style={{ color:"#888",fontSize:11 }}>{c}</span>
              </div>
              <div style={{ textAlign:"right" }}>
                <span style={{ color:d.pl>=0?"#10b981":UBS_RED,fontSize:12,fontWeight:700 }}>{fmtEur(d.pl)}</span>
                {d.montant > 0 && <span style={{ color:"#444",fontSize:10,marginLeft:6 }}>{fmtPct((d.pl/d.montant)*100)}</span>}
              </div>
            </div>
          ))}
          {Object.values(last.byClasse).every(d => d.pl === 0) && (
            <div style={{ color:"#444",fontSize:12,textAlign:"center",padding:"20px 0" }}>
              P&L non disponible (prix d'achat à 0 dans le fichier)
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

// ─── Vue Positions ────────────────────────────────────────────────────────
function PositionsTab({ snapshots }) {
  const last = snapshots[snapshots.length - 1];
  const [sortKey, setSortKey] = useState("montantEur");
  const [sortDir, setSortDir] = useState("desc");
  const [filterClasse, setFilterClasse] = useState("ALL");
  const classes = [...new Set(last.positions.map(p => p.classe))].sort();

  const positions = [...last.positions]
    .filter(p => filterClasse === "ALL" || p.classe === filterClasse)
    .sort((a,b) => {
      const va = a[sortKey]??0, vb = b[sortKey]??0;
      return sortDir==="desc" ? vb-va : va-vb;
    });

  const total = positions.reduce((s,p) => s+p.montantEur, 0);
  const totalPl = positions.reduce((s,p) => s+(p.plEur||0), 0);

  const SortTh = ({ label, col, left }) => (
    <th onClick={() => { if(sortKey===col)setSortDir(d=>d==="desc"?"asc":"desc"); else{setSortKey(col);setSortDir("desc");} }}
      style={{ padding:"9px 12px",textAlign:left?"left":"right",fontSize:10,fontWeight:700,textTransform:"uppercase",
        letterSpacing:"0.07em",cursor:"pointer",userSelect:"none",whiteSpace:"nowrap",
        color:sortKey===col?UBS_RED:"#555" }}>
      {label} {sortKey===col?(sortDir==="desc"?"↓":"↑"):<span style={{color:"#333"}}>↕</span>}
    </th>
  );

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
      {/* Filtres */}
      <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
        <button onClick={()=>setFilterClasse("ALL")} style={{ padding:"5px 14px",borderRadius:5,border:"none",cursor:"pointer",fontSize:11,fontWeight:700,background:filterClasse==="ALL"?UBS_RED:"#1A1A1A",color:filterClasse==="ALL"?"white":"#666" }}>Tout</button>
        {classes.map(c => (
          <button key={c} onClick={()=>setFilterClasse(c)} style={{ padding:"5px 14px",borderRadius:5,border:"none",cursor:"pointer",fontSize:11,fontWeight:700,background:filterClasse===c?(CLASSE_COLORS[c]||UBS_RED):"#1A1A1A",color:filterClasse===c?"white":"#666" }}>{c}</button>
        ))}
      </div>

      <Section title={`${positions.length} positions — ${last.label}`} noPad>
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
            <thead>
              <tr style={{ borderBottom:"1px solid #1A1A1A",background:"#0A0A0A" }}>
                <SortTh label="Nom" col="nom" left />
                <SortTh label="Classe" col="classe" left />
                <SortTh label="ISIN" col="isin" left />
                <SortTh label="Devise" col="devise" />
                <SortTh label="Px achat" col="pxAchat" />
                <SortTh label="Px marché" col="pxMarche" />
                <SortTh label="Montant EUR" col="montantEur" />
                <SortTh label="P&L EUR" col="plEur" />
                <SortTh label="P&L %" col="plPct" />
                <SortTh label="Poids %" col="poids" />
              </tr>
            </thead>
            <tbody>
              {positions.map((p,i) => (
                <tr key={i} style={{ borderBottom:"1px solid #0F0F0F" }}
                  onMouseEnter={e=>e.currentTarget.style.background="#0F0F0F"}
                  onMouseLeave={e=>e.currentTarget.style.background=""}>
                  <td style={{ padding:"9px 12px",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                    <span style={{ color:"white",fontWeight:600,fontSize:11 }}>{p.nom}</span>
                  </td>
                  <td style={{ padding:"9px 12px",whiteSpace:"nowrap" }}>
                    <span style={{ fontSize:10,padding:"2px 6px",borderRadius:3,background:(CLASSE_COLORS[p.classe]||"#666")+"22",color:CLASSE_COLORS[p.classe]||"#666",fontWeight:700 }}>{p.classe}</span>
                  </td>
                  <td style={{ padding:"9px 12px",fontFamily:"monospace",fontSize:10,color:"#555" }}>{p.isin}</td>
                  <td style={{ padding:"9px 12px",textAlign:"right",color:"#666",fontSize:11 }}>{p.devise}</td>
                  <td style={{ padding:"9px 12px",textAlign:"right",color:"#555",fontSize:11 }}>{p.pxAchat ? fmtNum(p.pxAchat) : "—"}</td>
                  <td style={{ padding:"9px 12px",textAlign:"right",color:"#888",fontSize:11 }}>{fmtNum(p.pxMarche)}</td>
                  <td style={{ padding:"9px 12px",textAlign:"right",color:"white",fontWeight:700,fontSize:12 }}>{fmtEur(p.montantEur)}</td>
                  <td style={{ padding:"9px 12px",textAlign:"right",fontWeight:700,color:p.plEur>0?"#10b981":p.plEur<0?UBS_RED:"#444" }}>{p.plEur ? fmtEur(p.plEur) : "—"}</td>
                  <td style={{ padding:"9px 12px",textAlign:"right",color:p.plPct>0?"#10b981":p.plPct<0?UBS_RED:"#444",fontSize:11 }}>{p.plPct ? fmtPct(p.plPct) : "—"}</td>
                  <td style={{ padding:"9px 12px",textAlign:"right",color:"#555",fontSize:11 }}>{p.poids ? `${parseFloat(p.poids).toFixed(1)}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop:"1px solid #333",background:"#0A0A0A" }}>
                <td colSpan={6} style={{ padding:"9px 12px",color:"#555",fontSize:11,fontWeight:700 }}>TOTAL ({positions.length})</td>
                <td style={{ padding:"9px 12px",textAlign:"right",color:"white",fontWeight:700 }}>{fmtEur(total)}</td>
                <td style={{ padding:"9px 12px",textAlign:"right",fontWeight:700,color:totalPl>0?"#10b981":totalPl<0?UBS_RED:"#444" }}>{totalPl ? fmtEur(totalPl) : "—"}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      </Section>
    </div>
  );
}

// ─── Vue Performance ──────────────────────────────────────────────────────
function PerformanceTab({ snapshots }) {
  if (snapshots.length < 2) return (
    <div style={{ textAlign:"center",color:"#555",padding:80,fontSize:14 }}>
      Chargez au moins 2 snapshots pour voir la performance dans le temps.
    </div>
  );

  const chartData = buildChartData(snapshots);

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
      {/* Performance mensuelle */}
      <Section title="Variation mensuelle (€)">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData.slice(1)} margin={{ left:10,right:10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#161616" />
            <XAxis dataKey="date" tick={{ fill:"#555",fontSize:10 }} />
            <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v => `${v>=0?"+":""}${(v/1000).toFixed(0)}k€`} width={70} />
            <Tooltip content={<CustomTooltip formatter={v => fmtEur(v)} />} />
            <Bar dataKey="total" name="Variation" radius={[3,3,0,0]}>
              {chartData.slice(1).map((e,i) => <Cell key={i} fill={e.perf>=0?UBS_RED:"#444"} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Section>

      {/* Performance % cumulée */}
      <Section title="Performance cumulée (%)">
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={chartData} margin={{ left:10,right:10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#161616" />
            <XAxis dataKey="date" tick={{ fill:"#555",fontSize:10 }} />
            <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v => `${v>=0?"+":""}${v.toFixed(1)}%`} width={55} />
            <Tooltip content={<CustomTooltip formatter={v => fmtPct(v)} />} />
            <Line type="monotone" dataKey="perfCum" name="Perf. cumulée" stroke={UBS_RED} strokeWidth={2} dot={{ r:3,fill:UBS_RED }} />
          </LineChart>
        </ResponsiveContainer>
      </Section>

      {/* Tableau des snapshots */}
      <Section title="Tableau récapitulatif" noPad>
        <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
          <thead>
            <tr style={{ borderBottom:"1px solid #1A1A1A",background:"#0A0A0A" }}>
              {["Date","Valorisation","Variation €","Variation %","P&L Latent","Perf. cumulée"].map((h,i) => (
                <th key={h} style={{ padding:"9px 14px",textAlign:i===0?"left":"right",fontSize:10,fontWeight:700,textTransform:"uppercase",color:"#555",letterSpacing:"0.07em" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...snapshots].reverse().map((s,i) => (
              <tr key={i} style={{ borderBottom:"1px solid #0F0F0F" }}
                onMouseEnter={e=>e.currentTarget.style.background="#0F0F0F"}
                onMouseLeave={e=>e.currentTarget.style.background=""}>
                <td style={{ padding:"9px 14px",color:"white",fontWeight:600 }}>{s.label}</td>
                <td style={{ padding:"9px 14px",textAlign:"right",color:"white",fontWeight:700 }}>{fmtEur(s.total)}</td>
                <td style={{ padding:"9px 14px",textAlign:"right",color:s.variation>0?"#10b981":s.variation<0?UBS_RED:"#555",fontWeight:600 }}>{s.variation ? fmtEur(s.variation) : "—"}</td>
                <td style={{ padding:"9px 14px",textAlign:"right",color:s.perfMois>0?"#10b981":s.perfMois<0?UBS_RED:"#555" }}>{s.perfMois ? fmtPct(s.perfMois) : "—"}</td>
                <td style={{ padding:"9px 14px",textAlign:"right",color:s.plTotal>0?"#10b981":s.plTotal<0?UBS_RED:"#444" }}>{fmtEur(s.plTotal)}</td>
                <td style={{ padding:"9px 14px",textAlign:"right",color:s.perfCumulee>0?"#10b981":s.perfCumulee<0?UBS_RED:"#555",fontWeight:600 }}>{s.perfCumulee !== undefined ? fmtPct(s.perfCumulee) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

// ─── Vue Évolution positions ──────────────────────────────────────────────
function EvolutionTab({ snapshots }) {
  if (snapshots.length < 2) return (
    <div style={{ textAlign:"center",color:"#555",padding:80,fontSize:14 }}>
      Chargez au moins 2 snapshots pour voir l'évolution des positions.
    </div>
  );

  // Trouver les ISINs présents dans plusieurs snapshots
  const isinMap = {};
  for (const s of snapshots) {
    for (const p of s.positions) {
      if (!isinMap[p.isin]) isinMap[p.isin] = { nom:p.nom, isin:p.isin, classe:p.classe, series:[] };
      isinMap[p.isin].series.push({ date:s.label, montantEur:p.montantEur, plEur:p.plEur, plPct:p.plPct, pxMarche:p.pxMarche });
    }
  }

  // Trier par montant dernier snapshot
  const lastISINs = Object.values(isinMap)
    .map(d => ({ ...d, lastVal: d.series[d.series.length-1]?.montantEur || 0 }))
    .sort((a,b) => b.lastVal - a.lastVal);

  const [selected, setSelected] = useState(null);
  const sel = selected ? isinMap[selected] : null;

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
      {/* Graphique ligne pour la position sélectionnée */}
      {sel && (
        <Section title={`Évolution — ${sel.nom}`}>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={sel.series} margin={{ left:10,right:10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#161616" />
              <XAxis dataKey="date" tick={{ fill:"#555",fontSize:10 }} />
              <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v => fmtEur(v)} width={90} />
              <Tooltip content={<CustomTooltip formatter={v => fmtEur(v)} />} />
              <Line type="monotone" dataKey="montantEur" name="Valorisation" stroke={CLASSE_COLORS[sel.classe]||UBS_RED} strokeWidth={2} dot={{ r:3 }} />
            </LineChart>
          </ResponsiveContainer>
        </Section>
      )}

      {/* Liste des positions */}
      <Section title={`${lastISINs.length} positions — Cliquer pour voir l'évolution`} noPad>
        <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
          <thead>
            <tr style={{ borderBottom:"1px solid #1A1A1A",background:"#0A0A0A" }}>
              {["Nom","ISIN","Classe","Dernier montant"].map((h,i) => (
                <th key={h} style={{ padding:"9px 12px",textAlign:i<3?"left":"right",fontSize:10,fontWeight:700,textTransform:"uppercase",color:"#555",letterSpacing:"0.07em" }}>{h}</th>
              ))}
              {snapshots.map(s => (
                <th key={s.date} style={{ padding:"9px 12px",textAlign:"right",fontSize:10,fontWeight:700,color:"#444",letterSpacing:"0.06em" }}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lastISINs.map((d,i) => (
              <tr key={i} style={{ borderBottom:"1px solid #0F0F0F",cursor:"pointer",background:selected===d.isin?"#1A0000":"" }}
                onClick={() => setSelected(selected===d.isin ? null : d.isin)}
                onMouseEnter={e=>{ if(selected!==d.isin) e.currentTarget.style.background="#0F0F0F"; }}
                onMouseLeave={e=>{ if(selected!==d.isin) e.currentTarget.style.background=""; }}>
                <td style={{ padding:"8px 12px",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"white",fontWeight:600,fontSize:11 }}>{d.nom}</td>
                <td style={{ padding:"8px 12px",fontFamily:"monospace",fontSize:10,color:"#444" }}>{d.isin}</td>
                <td style={{ padding:"8px 12px" }}>
                  <span style={{ fontSize:10,padding:"2px 5px",borderRadius:3,background:(CLASSE_COLORS[d.classe]||"#666")+"22",color:CLASSE_COLORS[d.classe]||"#666",fontWeight:700 }}>{d.classe}</span>
                </td>
                <td style={{ padding:"8px 12px",textAlign:"right",color:"white",fontWeight:700 }}>{fmtEur(d.lastVal)}</td>
                {snapshots.map(s => {
                  const pt = d.series.find(x => x.date === s.label);
                  return (
                    <td key={s.date} style={{ padding:"8px 12px",textAlign:"right",color:pt?"#888":"#333",fontSize:11 }}>
                      {pt ? fmtEur(pt.montantEur) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// APP PRINCIPALE
// ═══════════════════════════════════════════════════════════════════════════
const TABS = [
  { id:"overview",    label:"Vue d'ensemble" },
  { id:"positions",   label:"Positions" },
  { id:"performance", label:"Performance" },
  { id:"evolution",   label:"Évolution" },
];

export default function UBSAnalyzer() {
  const [allParsed, setAllParsed] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [tab, setTab] = useState("overview");
  const [loading, setLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dropRef = useRef(null);

  const addFiles = useCallback(async (files) => {
    setLoading(true);
    const newParsed = [];
    for (const file of files) {
      if (!file.name.match(/\.(xls|xlsx)$/i)) continue;
      try {
        const buf = await file.arrayBuffer();
        const parsed = parsePositionsXLS(new Uint8Array(buf), file.name);
        if (parsed.positions.length > 0) newParsed.push(parsed);
      } catch(e) { console.warn("Erreur", file.name, e); }
    }
    setAllParsed(prev => {
      const merged = [...prev, ...newParsed];
      const snaps = buildSnapshots(merged);
      setSnapshots(snaps);
      return merged;
    });
    setLoading(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault(); setIsDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  }, [addFiles]);

  const reset = () => { setAllParsed([]); setSnapshots([]); setTab("overview"); };

  // ── Écran d'accueil ────────────────────────────────────────────────────
  if (!snapshots.length) return (
    <div style={{ minHeight:"100vh",background:BG,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24 }}>
      <div style={{ marginBottom:48,textAlign:"center" }}>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:14,marginBottom:12 }}>
          <UBSLogo size={48} />
          <div style={{ textAlign:"left" }}>
            <div style={{ fontSize:26,fontWeight:800,color:"white",letterSpacing:"-0.02em" }}>Portfolio Analyzer</div>
            <div style={{ fontSize:13,color:"#444",marginTop:2 }}>UBS · Snapshots mensuels · Multi-fichiers</div>
          </div>
        </div>
        <div style={{ width:56,height:3,background:UBS_RED,margin:"0 auto" }} />
      </div>

      <div ref={dropRef}
        onDrop={handleDrop}
        onDragOver={e=>{ e.preventDefault();setIsDragging(true); }}
        onDragLeave={()=>setIsDragging(false)}
        style={{ width:"100%",maxWidth:520,border:`2px dashed ${isDragging?UBS_RED:"#222"}`,borderRadius:12,padding:"48px 32px",textAlign:"center",
          background:isDragging?"#1A0000":CARD_BG,transition:"all .2s" }}>
        <div style={{ fontSize:44,marginBottom:14 }}>📁</div>
        <div style={{ fontSize:17,fontWeight:700,color:"white",marginBottom:6 }}>Glissez vos fichiers UBS ici</div>
        <div style={{ fontSize:12,color:"#555",marginBottom:6 }}>Tous les mois en une fois — position principale + _1_ + _2_ + _3_</div>
        <div style={{ fontSize:11,color:"#333",fontFamily:"monospace",marginBottom:24 }}>
          Position_de_portefeuille20251221.xls<br/>
          Position_de_portefeuille20260226__2_.xls<br/>
          Synthèse_de_portefeuille…xls (optionnel)
        </div>
        <label style={{ cursor:"pointer" }}>
          <span style={{ display:"inline-block",padding:"10px 28px",background:UBS_RED,color:"white",borderRadius:6,fontSize:13,fontWeight:700 }}
            onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
            Choisir les fichiers
          </span>
          <input type="file" accept=".xlsx,.xls" multiple style={{ display:"none" }} onChange={e=>addFiles(Array.from(e.target.files))} />
        </label>
      </div>

      {loading && <div style={{ marginTop:20,color:"#555",fontSize:13 }}>Chargement en cours…</div>}
    </div>
  );

  const last = snapshots[snapshots.length - 1];

  // ── App principale ─────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:"100vh",background:BG,color:"white" }}>
      <div style={{ position:"sticky",top:0,zIndex:40,background:"#050505",borderBottom:"1px solid #1A1A1A" }}>
        <div style={{ height:2,background:UBS_RED }} />
        <div style={{ maxWidth:1280,margin:"0 auto",padding:"10px 20px",display:"flex",flexWrap:"wrap",alignItems:"center",gap:10 }}>
          <div style={{ display:"flex",alignItems:"center",gap:10,marginRight:12 }}>
            <UBSLogo size={26} />
            <div>
              <div style={{ fontSize:13,fontWeight:800,color:"white" }}>UBS Portfolio Analyzer</div>
              <div style={{ fontSize:10,color:"#444" }}>{snapshots.length} snapshot{snapshots.length>1?"s":""} · {last.positions.length} positions · {last.label}</div>
            </div>
          </div>

          {/* Badge par date chargée */}
          <div style={{ display:"flex",gap:4,flexWrap:"wrap" }}>
            {snapshots.map(s => (
              <span key={s.date} style={{ fontSize:10,padding:"2px 8px",borderRadius:4,background:"#1A0000",color:UBS_RED,border:`1px solid ${UBS_RED}33`,fontFamily:"monospace" }}>
                {s.label}
              </span>
            ))}
          </div>

          {/* Ajouter des fichiers */}
          <label style={{ marginLeft:"auto",cursor:"pointer" }}>
            <span style={{ display:"inline-block",padding:"5px 14px",background:"#1A1A1A",border:"1px solid #333",color:"#888",borderRadius:6,fontSize:12,fontWeight:700,cursor:"pointer" }}
              onMouseEnter={e=>e.currentTarget.style.color="white"} onMouseLeave={e=>e.currentTarget.style.color="#888"}>
              + Ajouter des fichiers
            </span>
            <input type="file" accept=".xlsx,.xls" multiple style={{ display:"none" }} onChange={e=>addFiles(Array.from(e.target.files))} />
          </label>
          <button onClick={reset} style={{ padding:"5px 12px",background:"none",border:"1px solid #1A1A1A",color:"#555",borderRadius:6,fontSize:12,cursor:"pointer" }}>
            ✕ Réinitialiser
          </button>
        </div>

        {/* Onglets */}
        <div style={{ maxWidth:1280,margin:"0 auto",padding:"0 20px",display:"flex",gap:2 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              padding:"8px 18px",border:"none",borderBottom:tab===t.id?`2px solid ${UBS_RED}`:"2px solid transparent",
              background:"none",color:tab===t.id?"white":"#555",fontWeight:tab===t.id?700:400,
              fontSize:13,cursor:"pointer",transition:"color .15s",marginBottom:-1 }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ maxWidth:1280,margin:"0 auto",padding:"20px 20px" }}>
        {tab==="overview"    && <OverviewTab snapshots={snapshots} />}
        {tab==="positions"   && <PositionsTab snapshots={snapshots} />}
        {tab==="performance" && <PerformanceTab snapshots={snapshots} />}
        {tab==="evolution"   && <EvolutionTab snapshots={snapshots} />}
      </div>
    </div>
  );
}
