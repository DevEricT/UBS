// ═══════════════════════════════════════════════════════════════════════════
// UBS Portfolio Analyzer — v4.0
// Source unique : SYNTHESE_PLACEMENTS_TOTAL_UBS_*.xlsx (fichier maître)
// TWR et flux lus directement depuis le fichier — zéro heuristique
// Charte UBS : rouge #EC0000 / fond noir / blanc
// ═══════════════════════════════════════════════════════════════════════════
import React, { useState, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import {
  AreaChart, BarChart, LineChart, ComposedChart, PieChart,
  Area, Bar, Line, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

// ─── Palette ──────────────────────────────────────────────────────────────
const UBS_RED = "#EC0000";
const BG      = "#080808";
const CARD_BG = "#0D0D0D";

const COMPTES = {
  CTO:  { id:"CTO",  label:"CTO Titres",             color:"#EC0000" },
  SOGE: { id:"SOGE", label:"AV SOGELIFE",             color:"#3B82F6" },
  UBS:  { id:"UBS",  label:"AV UBS Multicollection",  color:"#10B981" },
  CNP:  { id:"CNP",  label:"AV CNP Luxembourg",       color:"#F59E0B" },
  LIQ:  { id:"LIQ",  label:"Liquidités",              color:"#6B7280" },
};
const COMPTES_PERF = [COMPTES.CTO, COMPTES.SOGE, COMPTES.UBS, COMPTES.CNP];
const COMPTES_ALL  = Object.values(COMPTES);

// ─── Helpers ──────────────────────────────────────────────────────────────
const fmtEur  = (v,dec=0) => v==null?"—":Number(v).toLocaleString("fr-FR",{style:"currency",currency:"EUR",maximumFractionDigits:dec});
const fmtPct  = (v,dec=2) => v==null?"—":`${v>=0?"+":""}${Number(v).toFixed(dec)}%`;
const parseN  = (v) => { const n=parseFloat(String(v??0).replace(/[\s']/g,"").replace(",",".")); return isNaN(n)?0:n; };

// Date Excel sérialisée → JS Date ou null
const excelDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") {
    const d = new Date(Math.round((v - 25569) * 864e5));
    return isNaN(d) ? null : d;
  }
  if (typeof v === "string") {
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  return null;
};
const dateLabel = (d) => {
  if (!d) return "?";
  const dt = excelDate(d) || (d instanceof Date ? d : null);
  if (!dt) return String(d).slice(0,10);
  return dt.toLocaleDateString("fr-FR",{day:"2-digit",month:"short",year:"numeric"});
};
const dateYear  = (d) => { const dt=excelDate(d); return dt ? String(dt.getFullYear()) : "?"; };
const dateISO   = (d) => { const dt=excelDate(d); return dt ? dt.toISOString().slice(0,10) : ""; };

// ═══════════════════════════════════════════════════════════════════════════
// PARSER — lit le fichier XLSX maître
// ═══════════════════════════════════════════════════════════════════════════
const parseMasterFile = (buffer) => {
  const wb = XLSX.read(buffer, { type:"array", cellDates:true });

  // ── 1. Feuille "Client 5015495" — valorisations par date ──────────────
  const shC = wb.Sheets["Client 5015495"];
  if (!shC) throw new Error('Feuille "Client 5015495" introuvable');
  const rowsC = XLSX.utils.sheet_to_json(shC, { header:1, defval:null, raw:false });

  // Ligne 1 = dates (colonnes E=index 4 à fin)
  const dateRow = rowsC[0] || [];
  const snapshots = [];

  for (let ci = 4; ci < dateRow.length; ci++) {
    const rawDate = dateRow[ci];
    if (!rawDate) continue;
    const dt = excelDate(rawDate);
    if (!dt) continue;

    const getVal = (rowIdx) => parseN(rowsC[rowIdx]?.[ci]);

    const snap = {
      date:     dt,
      label:    dateLabel(dt),
      year:     dateYear(dt),
      iso:      dateISO(dt),
      colIdx:   ci,
      total:    getVal(1),   // ligne 2 = GRAND TOTAL
      liq:      getVal(24),  // ligne 25 = Total Liquidités
      CTO:      getVal(44),  // ligne 45 = CTO 5030465
      SOGE:     getVal(45),  // ligne 46 = SOGELIFE
      UBS:      getVal(46),  // ligne 47 = UBS Multi
      CNP:      getVal(47),  // ligne 48 = CNP Lux
      entree:   0,
      sortie:   0,
      flux:     0,
      perfMois: null,
    };
    snapshots.push(snap);
  }

  // ── 2. Feuille "Dashboard" — flux et performance réelle ───────────────
  const shD = wb.Sheets["Dashboard"];
  if (shD) {
    const rowsD = XLSX.utils.sheet_to_json(shD, { header:1, defval:null, raw:false });
    const dashDateRow = rowsD[1] || []; // ligne 2 = dates (col D = index 3)

    // Construire un map ISO → valeurs flux + perf
    const fluxByISO = {};
    for (let ci = 3; ci < dashDateRow.length; ci++) {
      const rawDate = dashDateRow[ci];
      if (!rawDate || String(rawDate).toLowerCase().includes("ytodate")) continue;
      const dt = excelDate(rawDate);
      if (!dt) continue;
      const iso = dt.toISOString().slice(0,10);
      fluxByISO[iso] = {
        entree:   parseN(rowsD[15]?.[ci]), // ligne 16 = ENTRÉES
        sortie:   parseN(rowsD[16]?.[ci]), // ligne 17 = SORTIES
        perfMois: rowsD[18]?.[ci],         // ligne 19 = PERF RÉELLE PAR MOIS
      };
    }

    // Appliquer aux snapshots
    for (const s of snapshots) {
      const fx = fluxByISO[s.iso];
      if (fx) {
        s.entree   = fx.entree || 0;
        s.sortie   = fx.sortie || 0;
        s.flux     = (fx.entree||0) - (fx.sortie||0);
        const p = parseN(fx.perfMois);
        s.perfMois = (!isNaN(p) && (fx.perfMois !== null && fx.perfMois !== "")) ? p * 100 : null;
      }
    }
  }

  // ── 3. Feuilles TWR 2024 / TWR 2025 ───────────────────────────────────
  const twrByISO = {}; // iso → { twr (ratio), value (€) }
  for (const shName of ["TWR 2024","TWR 2025"]) {
    const sh = wb.Sheets[shName];
    if (!sh) continue;
    const rows = XLSX.utils.sheet_to_json(sh, { header:1, defval:null, raw:false });
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const dt = excelDate(row[0]);
      if (!dt) continue;
      const iso = dt.toISOString().slice(0,10);
      const twr = parseN(row[5] ?? row[6]); // col F = TWR ratio (TWR 2024), col G = TWR (TWR 2025)
      // TWR 2024 : col 5=Valeur finale, col 6=TWR — TWR 2025 : col 5=ValFinale, col 6=TWR
      const twrRatio = parseN(shName==="TWR 2024" ? row[5] : row[6]);
      const twrValue = parseN(shName==="TWR 2024" ? row[6] : row[7]);
      if (twrRatio !== 0 || twrValue !== 0) twrByISO[iso] = { twr: twrRatio, value: twrValue };
    }
    // YTD
    const lastRow = rows.find(r => r && (r[4]==="YTD" || r[5]==="YTD"));
    if (lastRow) {
      const ytdVal = parseN(lastRow[6] ?? lastRow[5]);
      // On stocke le YTD sous une clé spéciale
      twrByISO[`YTD_${shName.slice(-4)}`] = ytdVal;
    }
  }

  // Calculer TWR cumulé sur toute la timeline
  let twrCumul = 1.0;
  for (const s of snapshots) {
    const fx = twrByISO[s.iso];
    if (fx) {
      twrCumul *= (1 + fx.twr);
      s.twrMois  = fx.twr * 100;
    }
    s.twrCumul = (twrCumul - 1) * 100;
  }
  if (snapshots.length) { snapshots[0].twrMois = 0; snapshots[0].twrCumul = 0; }

  // YTD par an
  const twrYTD = {
    "2024": twrByISO["YTD_2024"] || null,
    "2025": twrByISO["YTD_2025"] || null,
  };

  return { snapshots, twrYTD };
};

// ─── Perf annuelle depuis les snapshots ───────────────────────────────────
const buildAnnualPerf = (snapshots) => {
  const byYear = {};
  for (const s of snapshots) {
    if (!byYear[s.year]) byYear[s.year] = [];
    byYear[s.year].push(s);
  }
  return Object.keys(byYear).sort().map(year => {
    const pts = byYear[year];
    const first = pts[0], last = pts[pts.length-1];
    const entrees = pts.reduce((s,p)=>s+p.entree,0);
    const sorties = pts.reduce((s,p)=>s+p.sortie,0);
    // TWR chaîné sur l'année
    let twr = 1.0;
    for (const p of pts) { if (p.twrMois != null) twr *= (1 + p.twrMois/100); }

    const comptePerf = {};
    for (const c of COMPTES_PERF) {
      const vD = first[c.id]||0, vF = last[c.id]||0;
      comptePerf[c.id] = { debut:vD, fin:vF, variation:vF-vD,
        pct: vD>0?((vF-vD)/vD)*100:null };
    }
    return { year, debut:first.total, fin:last.total,
      variation:last.total-first.total, entrees, sorties,
      twrAnnuel:(twr-1)*100, snapshots:pts.length, comptePerf };
  });
};

// ═══════════════════════════════════════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════════════════════════════════════
const SK = "ubs-v4";
const storeSave = async (d) => { try { await window.storage.set(SK, JSON.stringify(d)); } catch(e){} };
const storeLoad = async () => { try { const r=await window.storage.get(SK); return r?.value?JSON.parse(r.value):null; } catch(e){return null;} };
const storeClear = async () => { try { await window.storage.delete(SK); } catch(e){} };

// ═══════════════════════════════════════════════════════════════════════════
// COMPOSANTS UI
// ═══════════════════════════════════════════════════════════════════════════

function UBSLogo({ size=32 }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
    <rect width="32" height="32" rx="4" fill={UBS_RED}/>
    <rect x="6"  y="10" width="4" height="12" fill="white"/>
    <rect x="14" y="10" width="4" height="12" fill="white"/>
    <rect x="22" y="10" width="4" height="12" fill="white"/>
  </svg>;
}

function KpiCard({ label, value, sub, positive, negative, color, tooltip }) {
  const [show,setShow]=useState(false); const ref=useRef(null);
  const bc = color||(positive?"#10b981":negative?UBS_RED:"#2A2A2A");
  const vc = color||(positive?"#10b981":negative?UBS_RED:"white");
  return (
    <div style={{ position:"relative",background:CARD_BG,border:"1px solid #1A1A1A",borderLeft:`3px solid ${bc}`,borderRadius:8,padding:"14px 16px" }}>
      <div style={{ color:"#555",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:4 }}>{label}</div>
      <div style={{ color:vc,fontSize:20,fontWeight:700,lineHeight:1.2 }}>{value}</div>
      {sub&&<div style={{ color:"#444",fontSize:11,marginTop:3 }}>{sub}</div>}
      {tooltip&&<button ref={ref} onClick={()=>setShow(s=>!s)} style={{ position:"absolute",top:8,right:8,color:"#444",fontSize:11,background:"none",border:"none",cursor:"pointer" }}>ⓘ</button>}
      {show&&<div style={{ position:"fixed",top:(ref.current?.getBoundingClientRect().bottom||0)+6,left:ref.current?.getBoundingClientRect().left||0,zIndex:9999,width:260,background:"#1A1A1A",border:"1px solid #333",borderRadius:8,padding:12,fontSize:12,color:"#ccc",lineHeight:1.5 }}>
        {tooltip}<button onClick={()=>setShow(false)} style={{ position:"absolute",top:6,right:8,background:"none",border:"none",color:"#555",cursor:"pointer" }}>✕</button>
      </div>}
    </div>
  );
}

function Section({ title, children, noPad, action }) {
  return (
    <div style={{ background:CARD_BG,border:"1px solid #1A1A1A",borderRadius:12,overflow:"hidden",marginBottom:12 }}>
      <div style={{ padding:"10px 18px",borderBottom:"1px solid #161616",display:"flex",alignItems:"center",justifyContent:"space-between" }}>
        <span style={{ color:"#555",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em" }}>{title}</span>
        {action&&<span style={{ fontSize:11,color:"#444" }}>{action}</span>}
      </div>
      <div style={noPad?{}:{padding:18}}>{children}</div>
    </div>
  );
}

const TT = ({ active, payload, label, fmt }) => {
  if (!active||!payload?.length) return null;
  const data = payload[0]?.payload||{};
  return (
    <div style={{ background:"#111",border:"1px solid #222",borderRadius:8,padding:"10px 14px",fontSize:12,minWidth:200 }}>
      <div style={{ color:"#888",marginBottom:6,fontWeight:700 }}>{label}</div>
      {payload.map((p,i)=><div key={i} style={{ display:"flex",justifyContent:"space-between",gap:16,marginBottom:2 }}>
        <span style={{ color:"#666",fontSize:11 }}>{p.name}</span>
        <span style={{ fontWeight:700,color:p.color||"white" }}>{fmt?fmt(p.value):p.value}</span>
      </div>)}
      {(data.entree>0||data.sortie>0)&&<div style={{ borderTop:"1px solid #222",marginTop:6,paddingTop:6 }}>
        {data.entree>0&&<div style={{ display:"flex",justifyContent:"space-between",gap:16 }}>
          <span style={{ color:"#10b981",fontSize:11 }}>⬆ Apport</span>
          <span style={{ fontWeight:700,color:"#10b981" }}>{fmtEur(data.entree)}</span>
        </div>}
        {data.sortie>0&&<div style={{ display:"flex",justifyContent:"space-between",gap:16,marginTop:2 }}>
          <span style={{ color:"#F59E0B",fontSize:11 }}>⬇ Retrait</span>
          <span style={{ fontWeight:700,color:"#F59E0B" }}>{fmtEur(data.sortie)}</span>
        </div>}
      </div>}
    </div>
  );
};

// ─── Onglet Vue d'ensemble ────────────────────────────────────────────────
function GlobalTab({ snapshots, annualPerf, twrYTD }) {
  if (!snapshots.length) return null;
  const last = snapshots[snapshots.length-1];
  const first = snapshots[0];

  const chartData = snapshots.map(s => ({
    label: s.label, total: Math.round(s.total),
    CTO: Math.round(s.CTO), SOGE: Math.round(s.SOGE),
    UBS: Math.round(s.UBS), CNP: Math.round(s.CNP),
    LIQ: Math.round(s.liq||0),
    twrCumul: parseFloat((s.twrCumul||0).toFixed(2)),
    perfMois: s.perfMois != null ? parseFloat(s.perfMois.toFixed(2)) : null,
    entree: s.entree, sortie: s.sortie,
  }));

  // Perf mensuelle — barres
  const perfData = snapshots.slice(1).filter(s=>s.perfMois!=null).map(s=>({
    label: s.label,
    perf: parseFloat(s.perfMois.toFixed(2)),
    entree: s.entree, sortie: s.sortie,
  }));

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:12 }}>

      {/* KPIs */}
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:10 }}>
        <KpiCard label="Actif net total" value={fmtEur(last.total)} sub={last.label}/>
        <KpiCard label="TWR cumulé" value={fmtPct(last.twrCumul)} positive={last.twrCumul>0} negative={last.twrCumul<0}
          sub={`${first.label} → ${last.label}`}
          tooltip="Time-Weighted Return cumulé. Calculé depuis les feuilles TWR 2024/2025 de votre fichier. Exclut l'effet des apports et retraits — mesure uniquement la performance des gérants."/>
        {twrYTD["2024"]!=null&&<KpiCard label="TWR 2024" value={fmtPct(twrYTD["2024"]*100)} positive={twrYTD["2024"]>0} negative={twrYTD["2024"]<0} color="#8B5CF6"/>}
        {twrYTD["2025"]!=null&&<KpiCard label="TWR 2025" value={fmtPct(twrYTD["2025"]*100)} positive={twrYTD["2025"]>0} negative={twrYTD["2025"]<0} color="#8B5CF6"/>}
        <KpiCard label="Variation brute" value={fmtEur(last.total-first.total)} sub="Dont flux entrants/sortants"/>
        <KpiCard label="Snapshots" value={snapshots.length} sub={`${annualPerf.length} années`}/>
      </div>

      {/* Valorisation totale — pastilles flux */}
      <Section title="Valorisation totale" action="🟢 apport  🟡 retrait">
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={chartData} margin={{ left:10,right:10,top:10 }}>
            <defs><linearGradient id="gT" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={UBS_RED} stopOpacity={0.2}/>
              <stop offset="95%" stopColor={UBS_RED} stopOpacity={0}/>
            </linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#161616"/>
            <XAxis dataKey="label" tick={{ fill:"#555",fontSize:10 }} interval="preserveStartEnd"/>
            <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v=>`${(v/1e6).toFixed(2)}M€`} width={70}/>
            <Tooltip content={<TT fmt={fmtEur}/>}/>
            <Area type="monotone" dataKey="total" name="Total" stroke={UBS_RED} strokeWidth={2.5}
              fill="url(#gT)" dot={(props)=>{
                const { cx,cy,payload } = props;
                if (payload.entree>0) return <circle key={props.key} cx={cx} cy={cy} r={6} fill="#10b981" stroke="#050505" strokeWidth={2}/>;
                if (payload.sortie>0) return <circle key={props.key} cx={cx} cy={cy} r={6} fill="#F59E0B" stroke="#050505" strokeWidth={2}/>;
                return <circle key={props.key} cx={cx} cy={cy} r={2} fill={UBS_RED} stroke="none"/>;
              }} activeDot={{ r:5,fill:UBS_RED }}/>
          </AreaChart>
        </ResponsiveContainer>
      </Section>

      {/* Répartition par compte empilée */}
      <Section title="Répartition par compte dans le temps">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} margin={{ left:10,right:10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#161616"/>
            <XAxis dataKey="label" tick={{ fill:"#555",fontSize:10 }} interval="preserveStartEnd"/>
            <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v=>`${(v/1e6).toFixed(1)}M€`} width={65}/>
            <Tooltip content={<TT fmt={fmtEur}/>}/>
            <Legend wrapperStyle={{ fontSize:11,color:"#666",paddingTop:8 }}/>
            {COMPTES_ALL.map(c=><Bar key={c.id} dataKey={c.id} name={c.label} stackId="a" fill={c.color}/>)}
          </BarChart>
        </ResponsiveContainer>
      </Section>

      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
        {/* TWR cumulé */}
        <Section title="TWR cumulé (%)">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData} margin={{ left:5,right:10,top:5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#161616"/>
              <XAxis dataKey="label" tick={{ fill:"#555",fontSize:9 }} interval="preserveStartEnd"/>
              <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v=>`${v>=0?"+":""}${v.toFixed(1)}%`} width={55}/>
              <Tooltip content={<TT fmt={v=>fmtPct(v)}/>}/>
              <ReferenceLine y={0} stroke="#333"/>
              <Line type="monotone" dataKey="twrCumul" name="TWR cumulé" stroke="#8B5CF6" strokeWidth={2} dot={false} activeDot={{ r:4 }}/>
            </LineChart>
          </ResponsiveContainer>
        </Section>

        {/* Performance mensuelle réelle */}
        <Section title="Performance mensuelle réelle (%)">
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={perfData} margin={{ left:5,right:10,top:5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#161616"/>
              <XAxis dataKey="label" tick={{ fill:"#555",fontSize:9 }} interval="preserveStartEnd"/>
              <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v=>`${v>=0?"+":""}${v.toFixed(1)}%`} width={50}/>
              <Tooltip content={<TT fmt={v=>fmtPct(v)}/>}/>
              <ReferenceLine y={0} stroke="#333"/>
              <Bar dataKey="perf" name="Perf. mois" radius={[2,2,0,0]}>
                {perfData.map((e,i)=><Cell key={i} fill={e.perf>=0?UBS_RED:"#444"}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Section>
      </div>

      {/* Tableau performance annuelle */}
      {annualPerf.length>0&&<Section title="Performance annuelle" noPad>
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
            <thead><tr style={{ borderBottom:"1px solid #1A1A1A",background:"#0A0A0A" }}>
              {["Année","Début","Fin","TWR Annuel","Variation €","Apports","Retraits","Pts",...COMPTES_PERF.map(c=>c.label)].map((h,i)=>(
                <th key={h} style={{ padding:"9px 14px",textAlign:i<1?"left":"right",fontSize:10,fontWeight:700,textTransform:"uppercase",color:"#555",letterSpacing:"0.07em",whiteSpace:"nowrap" }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {[...annualPerf].reverse().map((a,i)=>(
                <tr key={i} style={{ borderBottom:"1px solid #0F0F0F" }}
                  onMouseEnter={e=>e.currentTarget.style.background="#0F0F0F"}
                  onMouseLeave={e=>e.currentTarget.style.background=""}>
                  <td style={{ padding:"9px 14px",color:"white",fontWeight:700,fontFamily:"monospace" }}>{a.year}</td>
                  <td style={{ padding:"9px 14px",textAlign:"right",color:"#555",fontSize:11 }}>{fmtEur(a.debut)}</td>
                  <td style={{ padding:"9px 14px",textAlign:"right",color:"#888" }}>{fmtEur(a.fin)}</td>
                  <td style={{ padding:"9px 14px",textAlign:"right",fontWeight:800,fontSize:14,color:a.twrAnnuel>0?"#8B5CF6":a.twrAnnuel<0?"#F59E0B":"#444" }}>{fmtPct(a.twrAnnuel)}</td>
                  <td style={{ padding:"9px 14px",textAlign:"right",color:a.variation>=0?"#10b981":UBS_RED,fontWeight:600 }}>{fmtEur(a.variation)}</td>
                  <td style={{ padding:"9px 14px",textAlign:"right",color:"#10b981",fontSize:11 }}>{a.entrees?fmtEur(a.entrees):"—"}</td>
                  <td style={{ padding:"9px 14px",textAlign:"right",color:"#F59E0B",fontSize:11 }}>{a.sorties?fmtEur(a.sorties):"—"}</td>
                  <td style={{ padding:"9px 14px",textAlign:"right",color:"#555" }}>{a.snapshots}</td>
                  {COMPTES_PERF.map(c=>{ const cp=a.comptePerf[c.id]; return (
                    <td key={c.id} style={{ padding:"9px 14px",textAlign:"right",fontSize:11,color:cp?.pct>0?"#10b981":cp?.pct<0?UBS_RED:"#444" }}>
                      {cp?.pct!=null?fmtPct(cp.pct,1):"—"}
                    </td>
                  );})}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>}
    </div>
  );
}

// ─── Onglet Par compte ────────────────────────────────────────────────────
function CompteTab({ snapshots }) {
  const [selId, setSelId] = useState("CTO");
  const c = COMPTES[selId] || COMPTES.CTO;

  const pts = snapshots
    .map(s => ({ label:s.label, total:s[selId]||0, entree:s.entree, sortie:s.sortie, twrMois:s.twrMois, perfMois:s.perfMois }))
    .filter(p => p.total > 0);

  // TWR cumulé pour ce compte (approximation — même TWR que global car pas de TWR par compte dans le fichier)
  let cumul = 1.0;
  const ptsWithCumul = pts.map((p,i) => {
    if (i>0 && p.twrMois!=null) cumul *= (1+p.twrMois/100);
    return { ...p, twrCumul: (cumul-1)*100 };
  });

  const last = ptsWithCumul[ptsWithCumul.length-1];
  const first = ptsWithCumul[0];

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
      <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
        {COMPTES_PERF.map(ct=>(
          <button key={ct.id} onClick={()=>setSelId(ct.id)} style={{
            padding:"7px 18px",borderRadius:6,border:`1px solid ${selId===ct.id?ct.color:"#222"}`,
            background:selId===ct.id?ct.color+"22":"transparent",
            color:selId===ct.id?ct.color:"#555",fontSize:12,fontWeight:700,cursor:"pointer" }}>
            {ct.label}
          </button>
        ))}
      </div>

      {!pts.length ? <div style={{ textAlign:"center",color:"#444",padding:60 }}>Pas de données pour ce compte.</div> : <>
        <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(165px,1fr))",gap:10 }}>
          <KpiCard label="Valorisation" value={fmtEur(last?.total)} sub={last?.label} color={c.color}/>
          {ptsWithCumul.length>1&&<KpiCard label="Variation totale" value={fmtEur((last?.total||0)-(first?.total||0))} sub={`depuis ${first?.label}`}/>}
          {last?.perfMois!=null&&<KpiCard label="Dernière perf. mois" value={fmtPct(last.perfMois)} positive={last.perfMois>0} negative={last.perfMois<0}/>}
          <KpiCard label="Snapshots" value={pts.length}/>
        </div>

        <Section title={`Valorisation ${c.label}`}>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={ptsWithCumul} margin={{ left:10,right:10,top:5 }}>
              <defs><linearGradient id={`g${selId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={c.color} stopOpacity={0.25}/>
                <stop offset="95%" stopColor={c.color} stopOpacity={0}/>
              </linearGradient></defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161616"/>
              <XAxis dataKey="label" tick={{ fill:"#555",fontSize:10 }} interval="preserveStartEnd"/>
              <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v=>`${(v/1e6).toFixed(2)}M€`} width={70}/>
              <Tooltip content={<TT fmt={fmtEur}/>}/>
              <Area type="monotone" dataKey="total" name={c.label} stroke={c.color} strokeWidth={2.5}
                fill={`url(#g${selId})`} dot={false} activeDot={{ r:4,fill:c.color }}/>
            </AreaChart>
          </ResponsiveContainer>
        </Section>

        {/* Tableau détail */}
        <Section title="Détail par snapshot" noPad>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
              <thead><tr style={{ borderBottom:"1px solid #1A1A1A",background:"#0A0A0A" }}>
                {["Date","Valorisation","Variation €","Perf. mois","Apport","Retrait"].map((h,i)=>(
                  <th key={h} style={{ padding:"8px 14px",textAlign:i<1?"left":"right",fontSize:10,fontWeight:700,textTransform:"uppercase",color:"#555",letterSpacing:"0.07em",whiteSpace:"nowrap" }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {[...ptsWithCumul].reverse().map((p,i,arr)=>{
                  const prev = arr[i+1];
                  const varEur = prev ? p.total-prev.total : null;
                  return (
                    <tr key={i} style={{ borderBottom:"1px solid #0F0F0F" }}
                      onMouseEnter={e=>e.currentTarget.style.background="#0F0F0F"}
                      onMouseLeave={e=>e.currentTarget.style.background=""}>
                      <td style={{ padding:"8px 14px",color:"white",fontWeight:600 }}>{p.label}</td>
                      <td style={{ padding:"8px 14px",textAlign:"right",color:"white",fontWeight:700 }}>{fmtEur(p.total)}</td>
                      <td style={{ padding:"8px 14px",textAlign:"right",color:varEur>0?"#10b981":varEur<0?UBS_RED:"#444",fontWeight:600 }}>{varEur!=null?fmtEur(varEur):"—"}</td>
                      <td style={{ padding:"8px 14px",textAlign:"right",color:p.perfMois>0?"#10b981":p.perfMois<0?UBS_RED:"#444" }}>{p.perfMois!=null?fmtPct(p.perfMois):"—"}</td>
                      <td style={{ padding:"8px 14px",textAlign:"right",color:"#10b981",fontSize:11 }}>{p.entree?fmtEur(p.entree):"—"}</td>
                      <td style={{ padding:"8px 14px",textAlign:"right",color:"#F59E0B",fontSize:11 }}>{p.sortie?fmtEur(p.sortie):"—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      </>}
    </div>
  );
}

// ─── Onglet Flux ──────────────────────────────────────────────────────────
function FluxTab({ snapshots }) {
  const fluxData = snapshots.filter(s=>s.entree>0||s.sortie>0).map(s=>({
    label: s.label, year: s.year,
    entree: s.entree, sortie: s.sortie,
    flux: s.flux,
    total: Math.round(s.total),
  }));

  const totalEntrees = snapshots.reduce((s,p)=>s+p.entree,0);
  const totalSorties = snapshots.reduce((s,p)=>s+p.sortie,0);
  const premierTotal = snapshots[0]?.total||0;
  const dernierTotal = snapshots[snapshots.length-1]?.total||0;
  const gainPerte = dernierTotal - premierTotal - (totalEntrees - totalSorties);

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(165px,1fr))",gap:10 }}>
        <KpiCard label="Total apports" value={fmtEur(totalEntrees)} positive={true}
          tooltip="Somme de tous les apports détectés dans le fichier Dashboard."/>
        <KpiCard label="Total retraits" value={fmtEur(totalSorties)} negative={true}
          tooltip="Somme de tous les retraits détectés dans le fichier Dashboard."/>
        <KpiCard label="Flux net" value={fmtEur(totalEntrees-totalSorties)}
          positive={totalEntrees>totalSorties} negative={totalEntrees<totalSorties}
          tooltip="Apports − Retraits. Flux net de capital sur toute la période."/>
        <KpiCard label="Gain/Perte réel" value={fmtEur(gainPerte)}
          positive={gainPerte>0} negative={gainPerte<0}
          tooltip="Variation totale du portefeuille moins les flux nets. = Ce que les marchés ont réellement produit."/>
      </div>

      <Section title="Flux de capitaux — apports et retraits">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={fluxData} margin={{ left:10,right:10,top:5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#161616"/>
            <XAxis dataKey="label" tick={{ fill:"#555",fontSize:10 }}/>
            <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v=>`${(v/1e6).toFixed(1)}M€`} width={65}/>
            <Tooltip contentStyle={{ background:"#111",border:"1px solid #222",borderRadius:8,fontSize:12 }} formatter={v=>fmtEur(v)}/>
            <Legend wrapperStyle={{ fontSize:11,color:"#666" }}/>
            <Bar dataKey="entree" name="Apport" fill="#10b981" radius={[3,3,0,0]}/>
            <Bar dataKey="sortie" name="Retrait" fill="#F59E0B" radius={[3,3,0,0]}/>
          </BarChart>
        </ResponsiveContainer>
      </Section>

      <Section title="Détail des opérations" noPad>
        <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
          <thead><tr style={{ borderBottom:"1px solid #1A1A1A",background:"#0A0A0A" }}>
            {["Date","Type","Montant","Actif net après"].map((h,i)=>(
              <th key={h} style={{ padding:"9px 14px",textAlign:i<2?"left":"right",fontSize:10,fontWeight:700,textTransform:"uppercase",color:"#555",letterSpacing:"0.07em" }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {[...fluxData].reverse().map((f,i)=>[
              f.entree>0&&<tr key={`e${i}`} style={{ borderBottom:"1px solid #0F0F0F" }}>
                <td style={{ padding:"9px 14px",color:"white",fontWeight:600 }}>{f.label}</td>
                <td style={{ padding:"9px 14px" }}><span style={{ background:"#10b98133",color:"#10b981",padding:"2px 8px",borderRadius:4,fontSize:11,fontWeight:700 }}>⬆ APPORT</span></td>
                <td style={{ padding:"9px 14px",textAlign:"right",color:"#10b981",fontWeight:700,fontSize:14 }}>{fmtEur(f.entree)}</td>
                <td style={{ padding:"9px 14px",textAlign:"right",color:"#888" }}>{fmtEur(f.total)}</td>
              </tr>,
              f.sortie>0&&<tr key={`s${i}`} style={{ borderBottom:"1px solid #0F0F0F" }}>
                <td style={{ padding:"9px 14px",color:"white",fontWeight:600 }}>{f.label}</td>
                <td style={{ padding:"9px 14px" }}><span style={{ background:"#F59E0B33",color:"#F59E0B",padding:"2px 8px",borderRadius:4,fontSize:11,fontWeight:700 }}>⬇ RETRAIT</span></td>
                <td style={{ padding:"9px 14px",textAlign:"right",color:"#F59E0B",fontWeight:700,fontSize:14 }}>{fmtEur(f.sortie)}</td>
                <td style={{ padding:"9px 14px",textAlign:"right",color:"#888" }}>{fmtEur(f.total)}</td>
              </tr>,
            ])}
          </tbody>
          <tfoot><tr style={{ borderTop:"1px solid #333",background:"#0A0A0A" }}>
            <td colSpan={2} style={{ padding:"9px 14px",color:"#555",fontWeight:700,fontSize:11 }}>TOTAL</td>
            <td style={{ padding:"9px 14px",textAlign:"right" }}>
              <span style={{ color:"#10b981",fontWeight:700 }}>{fmtEur(totalEntrees)}</span>
              <span style={{ color:"#555",margin:"0 8px" }}>/</span>
              <span style={{ color:"#F59E0B",fontWeight:700 }}>{fmtEur(totalSorties)}</span>
            </td>
            <td/>
          </tr></tfoot>
        </table>
      </Section>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// APP PRINCIPALE
// ═══════════════════════════════════════════════════════════════════════════
const TABS = [
  { id:"global",  label:"🌍 Vue d'ensemble" },
  { id:"compte",  label:"🏦 Par compte" },
  { id:"flux",    label:"💶 Flux" },
];

export default function App() {
  const [data, setData]             = useState(null);  // { snapshots, twrYTD }
  const [tab, setTab]               = useState("global");
  const [loading, setLoading]       = useState(false);
  const [storageLoading, setStorageLoading] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [fileName, setFileName]     = useState("");
  const [error, setError]           = useState(null);
  const dropRef = useRef(null);

  // Données dérivées
  const snapshots  = data?.snapshots || [];
  const twrYTD     = data?.twrYTD || {};
  const annualPerf = buildAnnualPerf(snapshots);

  useEffect(()=>{
    (async()=>{
      const saved = await storeLoad();
      if (saved) { setData(saved.data); setFileName(saved.fileName||""); }
      setStorageLoading(false);
    })();
  },[]);

  const loadFile = useCallback(async (file) => {
    if (!file) return;
    setLoading(true); setError(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const parsed = parseMasterFile(buf);
      setData(parsed);
      setFileName(file.name);
      await storeSave({ data: parsed, fileName: file.name });
    } catch(e) {
      setError(`Erreur de lecture : ${e.message}`);
      console.error(e);
    }
    setLoading(false);
  }, []);

  const handleDrop = useCallback((e)=>{
    e.preventDefault(); setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f?.name.match(/\.(xlsx|xls)$/i)) loadFile(f);
  },[loadFile]);

  const reset = async () => { await storeClear(); setData(null); setFileName(""); setError(null); };

  if (storageLoading) return (
    <div style={{ minHeight:"100vh",background:BG,display:"flex",alignItems:"center",justifyContent:"center" }}>
      <div style={{ textAlign:"center" }}><UBSLogo size={40}/><div style={{ color:"#444",fontSize:12,marginTop:12 }}>Chargement…</div></div>
    </div>
  );

  // ── Écran d'accueil ───────────────────────────────────────────────────
  if (!data) return (
    <div style={{ minHeight:"100vh",background:BG,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24 }}>
      <div style={{ marginBottom:40,textAlign:"center" }}>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:14,marginBottom:12 }}>
          <UBSLogo size={48}/>
          <div style={{ textAlign:"left" }}>
            <div style={{ fontSize:26,fontWeight:800,color:"white",letterSpacing:"-0.02em" }}>Portfolio Analyzer</div>
            <div style={{ fontSize:13,color:"#444",marginTop:2 }}>UBS · TWR réel · Flux intégrés</div>
          </div>
        </div>
        <div style={{ width:56,height:3,background:UBS_RED,margin:"0 auto 24px" }}/>
        <div style={{ maxWidth:480,margin:"0 auto",background:CARD_BG,border:`1px solid ${UBS_RED}33`,borderRadius:10,padding:18,textAlign:"left" }}>
          <div style={{ color:UBS_RED,fontWeight:700,fontSize:12,marginBottom:8 }}>📊 Fichier attendu</div>
          <div style={{ color:"#888",fontSize:12,lineHeight:1.7 }}>
            <code style={{ color:"white",background:"#161616",padding:"2px 6px",borderRadius:3 }}>SYNTHESE_PLACEMENTS_TOTAL_UBS_*.xlsx</code>
            <br/>Votre fichier maître avec les feuilles :<br/>
            <span style={{ color:"#555" }}>• Client 5015495 — valorisations par compte et par date<br/>
            • Dashboard — apports, retraits, perf. réelle par mois<br/>
            • TWR 2024 / TWR 2025 — calculs TWR déjà effectués</span>
          </div>
        </div>
      </div>

      <div ref={dropRef} onDrop={handleDrop}
        onDragOver={e=>{e.preventDefault();setIsDragging(true);}}
        onDragLeave={()=>setIsDragging(false)}
        style={{ width:"100%",maxWidth:480,border:`2px dashed ${isDragging?UBS_RED:"#222"}`,borderRadius:12,padding:"44px 32px",textAlign:"center",background:isDragging?"#1A0000":CARD_BG,transition:"all .2s" }}>
        <div style={{ fontSize:40,marginBottom:12 }}>📁</div>
        <div style={{ fontSize:16,fontWeight:700,color:"white",marginBottom:6 }}>Glissez votre fichier XLSX ici</div>
        <div style={{ fontSize:12,color:"#555",marginBottom:20 }}>Un seul fichier suffit — tout est dedans</div>
        {error&&<div style={{ background:"#1A0000",border:`1px solid ${UBS_RED}`,borderRadius:6,padding:"8px 12px",marginBottom:14,fontSize:12,color:UBS_RED }}>{error}</div>}
        <label style={{ cursor:"pointer" }}>
          <span style={{ display:"inline-block",padding:"10px 28px",background:UBS_RED,color:"white",borderRadius:6,fontSize:13,fontWeight:700 }}
            onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
            Choisir le fichier
          </span>
          <input type="file" accept=".xlsx,.xls" style={{ display:"none" }} onChange={e=>loadFile(e.target.files[0])}/>
        </label>
      </div>
      {loading&&<div style={{ marginTop:20,color:"#555",fontSize:13 }}>Analyse en cours…</div>}
    </div>
  );

  const last = snapshots[snapshots.length-1];
  const first = snapshots[0];

  return (
    <div style={{ minHeight:"100vh",background:BG,color:"white" }}>
      <div style={{ position:"sticky",top:0,zIndex:40,background:"#050505",borderBottom:"1px solid #1A1A1A" }}>
        <div style={{ height:2,background:UBS_RED }}/>
        <div style={{ maxWidth:1280,margin:"0 auto",padding:"10px 20px",display:"flex",flexWrap:"wrap",alignItems:"center",gap:10 }}>
          <div style={{ display:"flex",alignItems:"center",gap:10,marginRight:8 }}>
            <UBSLogo size={26}/>
            <div>
              <div style={{ fontSize:13,fontWeight:800,color:"white" }}>UBS Portfolio Analyzer</div>
              <div style={{ fontSize:10,color:"#444",fontFamily:"monospace" }}>{fileName} · {snapshots.length} snapshots · {first?.label} → {last?.label}</div>
            </div>
          </div>
          <div style={{ display:"flex",gap:4,flexWrap:"wrap" }}>
            {Object.entries(twrYTD).filter(([,v])=>v!=null).map(([yr,v])=>(
              <span key={yr} style={{ fontSize:10,padding:"2px 8px",borderRadius:4,background:"#1A001A",color:"#8B5CF6",border:"1px solid #8B5CF633",fontWeight:700 }}>
                TWR {yr}: {fmtPct(v*100)}
              </span>
            ))}
          </div>
          <div style={{ marginLeft:"auto",display:"flex",gap:8 }}>
            <label style={{ cursor:"pointer" }}>
              <span style={{ display:"inline-block",padding:"5px 14px",background:"#1A1A1A",border:"1px solid #333",color:"#888",borderRadius:6,fontSize:12,fontWeight:700 }}
                onMouseEnter={e=>e.currentTarget.style.color="white"} onMouseLeave={e=>e.currentTarget.style.color="#888"}>
                Mettre à jour
              </span>
              <input type="file" accept=".xlsx,.xls" style={{ display:"none" }} onChange={e=>loadFile(e.target.files[0])}/>
            </label>
            <button onClick={reset} style={{ padding:"5px 12px",background:"none",border:"1px solid #1A1A1A",color:"#555",borderRadius:6,fontSize:12,cursor:"pointer" }}>✕</button>
          </div>
        </div>
        <div style={{ maxWidth:1280,margin:"0 auto",padding:"0 20px",display:"flex",gap:2 }}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              padding:"8px 18px",border:"none",borderBottom:tab===t.id?`2px solid ${UBS_RED}`:"2px solid transparent",
              background:"none",color:tab===t.id?"white":"#555",fontWeight:tab===t.id?700:400,
              fontSize:13,cursor:"pointer",marginBottom:-1 }}>
              {t.label}
            </button>
          ))}
          {loading&&<span style={{ color:"#555",fontSize:11,padding:"10px 12px" }}>⏳</span>}
        </div>
      </div>

      <div style={{ maxWidth:1280,margin:"0 auto",padding:"20px" }}>
        {tab==="global" &&<GlobalTab snapshots={snapshots} annualPerf={annualPerf} twrYTD={twrYTD}/>}
        {tab==="compte" &&<CompteTab snapshots={snapshots}/>}
        {tab==="flux"   &&<FluxTab snapshots={snapshots}/>}
      </div>
    </div>
  );
}
