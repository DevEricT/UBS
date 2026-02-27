// ═══════════════════════════════════════════════════════════════════════════
// UBS Portfolio Analyzer — v3.0
// Architecture : Synthèse (historique long) + Positions (drill-down produits)
// Comptes : CTO 5030465 · AV SOGELIFE · AV UBS Multicollection · AV CNP Lux
// Charte UBS : rouge #EC0000 / fond noir / blanc
// ═══════════════════════════════════════════════════════════════════════════
import React, { useState, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import {
  LineChart, BarChart, AreaChart,
  Line, Bar, Area, Pie, PieChart, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from "recharts";

// ─── Palette & constantes ─────────────────────────────────────────────────
const UBS_RED = "#EC0000";
const BG      = "#080808";
const CARD_BG = "#0D0D0D";

// Comptes connus — mapping stable : suffixe _1_=SOGE, _2_=UBS, _3_=CNP, sans suffixe=CTO
const COMPTES = {
  CTO:  { id:"CTO",  num:"5030465",   label:"CTO Titres",            color:"#EC0000", suffix:null  },
  SOGE: { id:"SOGE", num:"0005588109",label:"AV SOGELIFE",           color:"#3B82F6", suffix:"_1_" },
  UBS:  { id:"UBS",  num:"121000627", label:"AV UBS Multicollection",color:"#10B981", suffix:"_2_" },
  CNP:  { id:"CNP",  num:"OLV000306", label:"AV CNP Luxembourg",     color:"#F59E0B", suffix:"_3_" },
};
const COMPTES_LIST = Object.values(COMPTES);
const COMPTE_BY_NUM = Object.fromEntries(COMPTES_LIST.map(c => [c.num, c]));
const COMPTE_BY_SUFFIX = { "_1_":COMPTES.SOGE, "_2_":COMPTES.UBS, "_3_":COMPTES.CNP };

const CLASSE_COLORS = {
  "Gestion libre":"#EC0000","Fonds €":"#3B82F6","Obligations":"#10B981",
  "Gestion dédiée":"#F59E0B","Hedge funds & private markets":"#8B5CF6",
  "Actions":"#F97316","Liquidités":"#6B7280","Liquidites":"#6B7280",
};

// ─── Helpers ──────────────────────────────────────────────────────────────
const fmtEur = (v,dec=0) => v==null?"—":Number(v).toLocaleString("fr-FR",{style:"currency",currency:"EUR",maximumFractionDigits:dec});
const fmtPct = (v) => v==null?"—":`${v>=0?"+":""}${Number(v).toFixed(2)} %`;
const fmtNum = (v) => v==null?"—":Number(v).toLocaleString("fr-FR",{maximumFractionDigits:2});
const parseNum = (v) => { if(!v&&v!==0) return 0; const n=parseFloat(String(v).replace(/[\s']/g,"").replace(",",".")); return isNaN(n)?0:n; };
const extractDate = (name) => { const m=name.match(/(\d{8})/); return m?m[1]:null; };
const ymdToLabel = (ymd) => { if(!ymd||ymd.length!==8) return ymd||""; const d=new Date(`${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}`); return d.toLocaleDateString("fr-FR",{month:"short",year:"numeric"}); };
const ymdYear = (ymd) => ymd?.slice(0,4)||"";
const detectSuffix = (name) => { const m=name.match(/(__\d_)/); return m?m[1]:null; };

// ═══════════════════════════════════════════════════════════════════════════
// PARSERS
// ═══════════════════════════════════════════════════════════════════════════

const parseSynthese = (buffer, filename) => {
  const date = extractDate(filename);
  if (!date) return null;
  const wb = XLSX.read(buffer, { type:"array" });
  const sh = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sh, { header:1, defval:"" });

  const comptes = { CTO:0, SOGE:0, UBS:0, CNP:0 };
  let liquidites = 0;
  let inInvest=false, inLiquid=false;

  for (const row of rows) {
    const c0 = String(row[0]||"").trim();
    if (c0.startsWith("Liquidités pour"))    { inLiquid=true;  inInvest=false; continue; }
    if (c0.startsWith("Investissement pour")){ inLiquid=false; inInvest=true;  continue; }
    if (c0.startsWith("Engagements pour"))   { inInvest=false; inLiquid=false; break; }

    if (inLiquid) {
      const valEur = parseNum(row[3]);
      if (valEur>0) liquidites += valEur;
    }
    if (inInvest) {
      const num = String(row[0]||"").trim();
      const valEur = parseNum(row[5]);
      if (!num || valEur<=0) continue;
      const compte = COMPTE_BY_NUM[num];
      if (compte) comptes[compte.id] = valEur;
    }
  }
  const total = Object.values(comptes).reduce((s,v)=>s+v,0) + liquidites;
  return { date, filename, type:"synthese", comptes, liquidites, total };
};

const parsePositions = (buffer, filename) => {
  const date = extractDate(filename);
  if (!date) return null;
  const suffix = detectSuffix(filename);
  const compte = suffix ? COMPTE_BY_SUFFIX[suffix] : COMPTES.CTO;
  if (!compte) return null;

  const wb = XLSX.read(buffer, { type:"array" });
  const positions = [];

  for (const sheetName of wb.SheetNames) {
    const sh = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sh, { header:1, defval:"" });
    let headerIdx=-1;
    for (let r=0;r<rows.length;r++) { if (String(rows[r][0]).trim()==="Quantité") { headerIdx=r; break; } }
    if (headerIdx===-1) continue;

    for (let r=headerIdx+1;r<rows.length;r++) {
      const row = rows[r];
      const montantEur = parseNum(row[8]);
      if (montantEur<=0) continue;
      const isin = String(row[2]||"").trim();
      if (!isin) continue;
      positions.push({
        date, compteId:compte.id, classe:sheetName,
        qte:parseNum(row[0]), nom:String(row[1]||"").trim(), isin,
        devise:String(row[3]||"").trim(),
        pxAchat:parseNum(row[4]), pxMarche:parseNum(row[5]),
        dateVal:String(row[6]||"").trim(),
        montantDevise:parseNum(row[7]), montantEur,
        plEur:parseNum(row[10]), plDevise:parseNum(row[11]),
        plPct:parseNum(row[12]), poids:parseNum(row[13]),
      });
    }
  }
  return { date, filename, type:"positions", compteId:compte.id, compte, positions };
};

// ═══════════════════════════════════════════════════════════════════════════
// CALCULS
// ═══════════════════════════════════════════════════════════════════════════

const buildTimeline = (syntheses) => {
  const byDate = {};
  for (const s of syntheses) byDate[s.date] = s;
  const dates = Object.keys(byDate).sort();
  const points = dates.map(date => {
    const s = byDate[date];
    return { date, label:ymdToLabel(date), year:ymdYear(date), total:s.total, liquidites:s.liquidites,
      ...Object.fromEntries(COMPTES_LIST.map(c=>[c.id, s.comptes[c.id]||0])) };
  });
  for (let i=1;i<points.length;i++) {
    const prev=points[i-1].total, curr=points[i].total;
    points[i].variation = curr-prev;
    points[i].perfMois  = prev>0?((curr-prev)/prev)*100:0;
  }
  if (points.length) { points[0].variation=0; points[0].perfMois=0; }
  if (points.length) { const base=points[0].total; for (const p of points) p.perfCum=base>0?((p.total-base)/base)*100:0; }
  return points;
};

const buildAnnualPerf = (timeline) => {
  const byYear = {};
  for (const p of timeline) { if (!byYear[p.year]) byYear[p.year]=[]; byYear[p.year].push(p); }
  return Object.keys(byYear).sort().map(year => {
    const pts=byYear[year], first=pts[0], last=pts[pts.length-1];
    const comptePerf = {};
    for (const c of COMPTES_LIST) {
      const vD=first[c.id]||0, vF=last[c.id]||0;
      comptePerf[c.id] = { debut:vD, fin:vF, variation:vF-vD, pct:vD>0?((vF-vD)/vD)*100:null };
    }
    return { year, debut:first.total, fin:last.total, variation:last.total-first.total,
      pct:first.total>0?((last.total-first.total)/first.total)*100:null, snapshots:pts.length, comptePerf };
  });
};

const buildCompteTimeline = (timeline, compteId) =>
  timeline.map(p=>({ date:p.date, label:p.label, year:p.year, total:p[compteId]||0 }))
  .filter(p=>p.total>0)
  .map((p,i,arr) => ({ ...p, variation:i>0?p.total-arr[i-1].total:0,
    perfMois:i>0&&arr[i-1].total>0?((p.total-arr[i-1].total)/arr[i-1].total)*100:0,
    perfCum:arr[0].total>0?((p.total-arr[0].total)/arr[0].total)*100:0 }));

// ═══════════════════════════════════════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════════════════════════════════════
const STORAGE_KEY = "ubs-v3-data";
const saveToStorage = async (data) => { try { await window.storage.set(STORAGE_KEY, JSON.stringify(data)); } catch(e){} };
const loadFromStorage = async () => { try { const r=await window.storage.get(STORAGE_KEY); return r?.value?JSON.parse(r.value):[]; } catch(e){ return []; } };
const clearStorage = async () => { try { await window.storage.delete(STORAGE_KEY); } catch(e){} };

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

function KpiCard({ label, value, sub, positive, negative, tooltip, color }) {
  const [show,setShow]=useState(false); const ref=useRef(null);
  const borderColor = color||(positive?"#10b981":negative?UBS_RED:"#2A2A2A");
  const valueColor  = color||(positive?"#10b981":negative?UBS_RED:"white");
  return (
    <div style={{ position:"relative",background:CARD_BG,border:"1px solid #1A1A1A",borderLeft:`3px solid ${borderColor}`,borderRadius:8,padding:"14px 16px" }}>
      <div style={{ color:"#555",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:4 }}>{label}</div>
      <div style={{ color:valueColor,fontSize:20,fontWeight:700,lineHeight:1.2 }}>{value}</div>
      {sub && <div style={{ color:"#444",fontSize:11,marginTop:3 }}>{sub}</div>}
      {tooltip && <button ref={ref} onClick={()=>setShow(s=>!s)} style={{ position:"absolute",top:8,right:8,color:"#444",fontSize:11,background:"none",border:"none",cursor:"pointer" }}>ⓘ</button>}
      {show && <div style={{ position:"fixed",top:(ref.current?.getBoundingClientRect().bottom||0)+6,left:ref.current?.getBoundingClientRect().left||0,zIndex:9999,width:240,background:"#1A1A1A",border:"1px solid #333",borderRadius:8,padding:12,fontSize:12,color:"#ccc",lineHeight:1.5 }}>
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
        {action}
      </div>
      <div style={noPad?{}:{padding:18}}>{children}</div>
    </div>
  );
}

const TT = ({ active, payload, label, fmt }) => {
  if (!active||!payload?.length) return null;
  return <div style={{ background:"#111",border:"1px solid #222",borderRadius:8,padding:"10px 14px",fontSize:12,minWidth:160 }}>
    <div style={{ color:"#888",marginBottom:6,fontWeight:700 }}>{label}</div>
    {payload.map((p,i)=><div key={i} style={{ display:"flex",justifyContent:"space-between",gap:16,marginBottom:2 }}>
      <span style={{ color:"#666",fontSize:11 }}>{p.name}</span>
      <span style={{ fontWeight:700,color:p.color||"white" }}>{fmt?fmt(p.value):p.value}</span>
    </div>)}
  </div>;
};

function Empty({ msg }) {
  return <div style={{ textAlign:"center",color:"#444",padding:"60px 20px",fontSize:13,lineHeight:1.8 }}>{msg}</div>;
}

// ─── Onglet Global ────────────────────────────────────────────────────────
function GlobalTab({ timeline, annualPerf }) {
  if (!timeline.length) return <Empty msg="Chargez des fichiers Synthèse pour voir la performance globale."/>;
  const last=timeline[timeline.length-1], first=timeline[0];
  return (
    <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
      <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(165px,1fr))",gap:10 }}>
        <KpiCard label="Total portefeuille" value={fmtEur(last.total)} sub={last.label}/>
        <KpiCard label={`Perf. depuis ${first.label}`} value={fmtPct(last.perfCum)} positive={last.perfCum>0} negative={last.perfCum<0}
          tooltip="Performance cumulée non pondérée par les flux. Basée sur la variation de valorisation totale."/>
        {last.variation!==0 && <KpiCard label="Variation dernier mois" value={fmtEur(last.variation)} sub={fmtPct(last.perfMois)} positive={last.variation>0} negative={last.variation<0}/>}
        <KpiCard label="Historique" value={`${timeline.length} mois`} sub={`${first.label} → ${last.label}`}/>
      </div>

      <Section title="Valorisation totale">
        <ResponsiveContainer width="100%" height={230}>
          <AreaChart data={timeline} margin={{ left:10,right:10,top:5 }}>
            <defs><linearGradient id="gTotal" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={UBS_RED} stopOpacity={0.25}/>
              <stop offset="95%" stopColor={UBS_RED} stopOpacity={0}/>
            </linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#161616"/>
            <XAxis dataKey="label" tick={{ fill:"#555",fontSize:10 }} interval="preserveStartEnd"/>
            <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v=>`${(v/1e6).toFixed(1)}M€`} width={60}/>
            <Tooltip content={<TT fmt={fmtEur}/>}/>
            <Area type="monotone" dataKey="total" name="Total" stroke={UBS_RED} strokeWidth={2.5} fill="url(#gTotal)" dot={false} activeDot={{ r:4,fill:UBS_RED }}/>
          </AreaChart>
        </ResponsiveContainer>
      </Section>

      <Section title="Répartition par compte dans le temps">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={timeline} margin={{ left:10,right:10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#161616"/>
            <XAxis dataKey="label" tick={{ fill:"#555",fontSize:10 }} interval="preserveStartEnd"/>
            <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v=>`${(v/1e6).toFixed(1)}M€`} width={60}/>
            <Tooltip content={<TT fmt={fmtEur}/>}/>
            <Legend wrapperStyle={{ fontSize:10,color:"#666" }}/>
            {COMPTES_LIST.map(c=><Bar key={c.id} dataKey={c.id} name={c.label} stackId="a" fill={c.color}/>)}
          </BarChart>
        </ResponsiveContainer>
      </Section>

      {timeline.length>1 && <Section title="Performance cumulée (%)">
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={timeline} margin={{ left:10,right:10,top:5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#161616"/>
            <XAxis dataKey="label" tick={{ fill:"#555",fontSize:10 }} interval="preserveStartEnd"/>
            <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v=>`${v>=0?"+":""}${v.toFixed(1)}%`} width={55}/>
            <Tooltip content={<TT fmt={fmtPct}/>}/>
            <ReferenceLine y={0} stroke="#333"/>
            <Line type="monotone" dataKey="perfCum" name="Perf. cumulée" stroke={UBS_RED} strokeWidth={2} dot={false} activeDot={{ r:4,fill:UBS_RED }}/>
          </LineChart>
        </ResponsiveContainer>
      </Section>}

      {annualPerf.length>0 && <Section title="Performance annuelle" noPad>
        <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
          <thead><tr style={{ borderBottom:"1px solid #1A1A1A",background:"#0A0A0A" }}>
            {["Année","Début","Fin","Variation €","Variation %","Mois",...COMPTES_LIST.map(c=>c.label)].map((h,i)=>(
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
                <td style={{ padding:"9px 14px",textAlign:"right",fontWeight:700,color:a.variation>=0?"#10b981":UBS_RED }}>{fmtEur(a.variation)}</td>
                <td style={{ padding:"9px 14px",textAlign:"right",fontWeight:700,color:a.pct>=0?"#10b981":UBS_RED }}>{a.pct!=null?fmtPct(a.pct):"—"}</td>
                <td style={{ padding:"9px 14px",textAlign:"right",color:"#555" }}>{a.snapshots}</td>
                {COMPTES_LIST.map(c=>{ const cp=a.comptePerf[c.id]; return (
                  <td key={c.id} style={{ padding:"9px 14px",textAlign:"right",fontSize:11,color:cp?.pct>0?"#10b981":cp?.pct<0?UBS_RED:"#444" }}>
                    {cp?.pct!=null?fmtPct(cp.pct):"—"}
                  </td>
                );})}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>}
    </div>
  );
}

// ─── Onglet Par compte ────────────────────────────────────────────────────
function CompteTab({ timeline, positionsByDate }) {
  const [selectedId, setSelectedId] = useState("CTO");
  const compte = COMPTES[selectedId];
  const ctimeline = buildCompteTimeline(timeline, selectedId);
  const last=ctimeline[ctimeline.length-1], first=ctimeline[0];

  const posDates = Object.keys(positionsByDate[selectedId]||{}).sort();
  const lastPosDate = posDates[posDates.length-1];
  const lastPositions = lastPosDate ? positionsByDate[selectedId][lastPosDate] : [];
  const classes = [...new Set(lastPositions.map(p=>p.classe))];
  const grandTotal = lastPositions.reduce((s,p)=>s+p.montantEur,0);
  const grandPL = lastPositions.reduce((s,p)=>s+(p.plEur||0),0);

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
      <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
        {COMPTES_LIST.map(c=>(
          <button key={c.id} onClick={()=>setSelectedId(c.id)} style={{
            padding:"7px 18px",borderRadius:6,border:`1px solid ${selectedId===c.id?c.color:"#222"}`,
            background:selectedId===c.id?c.color+"22":"transparent",
            color:selectedId===c.id?c.color:"#555",fontSize:12,fontWeight:700,cursor:"pointer",transition:"all .15s" }}>
            {c.label}
          </button>
        ))}
      </div>

      {!ctimeline.length ? <Empty msg={`Pas de données Synthèse pour ${compte.label}.`}/> : <>
        <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:10 }}>
          <KpiCard label="Valorisation" value={fmtEur(last?.total)} sub={last?.label} color={compte.color}/>
          {ctimeline.length>1 && <KpiCard label="Perf. totale" value={fmtPct(last?.perfCum)} positive={last?.perfCum>0} negative={last?.perfCum<0} sub={`depuis ${first?.label}`}/>}
          {last?.variation!==0 && <KpiCard label="Dernier mois" value={fmtEur(last?.variation)} sub={fmtPct(last?.perfMois)} positive={last?.variation>0} negative={last?.variation<0}/>}
          <KpiCard label="Snapshots" value={ctimeline.length} sub={posDates.length>0?`${posDates.length} dates positions`:"Pas de détail positions"}/>
        </div>

        <Section title={`Valorisation ${compte.label}`}>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={ctimeline} margin={{ left:10,right:10,top:5 }}>
              <defs><linearGradient id={`g${selectedId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={compte.color} stopOpacity={0.25}/>
                <stop offset="95%" stopColor={compte.color} stopOpacity={0}/>
              </linearGradient></defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#161616"/>
              <XAxis dataKey="label" tick={{ fill:"#555",fontSize:10 }} interval="preserveStartEnd"/>
              <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v=>`${(v/1e6).toFixed(2)}M€`} width={70}/>
              <Tooltip content={<TT fmt={fmtEur}/>}/>
              <Area type="monotone" dataKey="total" name={compte.label} stroke={compte.color} strokeWidth={2.5} fill={`url(#g${selectedId})`} dot={false} activeDot={{ r:4,fill:compte.color }}/>
            </AreaChart>
          </ResponsiveContainer>
        </Section>

        {lastPositions.length>0 ? <>
          <Section title={`Positions — ${ymdToLabel(lastPosDate)} — ${lastPositions.length} lignes`} noPad>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
                <thead><tr style={{ borderBottom:"1px solid #1A1A1A",background:"#0A0A0A" }}>
                  {["Nom","Classe","ISIN","Devise","Px achat","Px marché","Montant EUR","P&L EUR","P&L %","Poids %"].map((h,i)=>(
                    <th key={h} style={{ padding:"8px 12px",textAlign:i<3?"left":"right",fontSize:10,fontWeight:700,textTransform:"uppercase",color:"#555",letterSpacing:"0.07em",whiteSpace:"nowrap" }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {[...lastPositions].sort((a,b)=>b.montantEur-a.montantEur).map((p,i)=>(
                    <tr key={i} style={{ borderBottom:"1px solid #0F0F0F" }}
                      onMouseEnter={e=>e.currentTarget.style.background="#0F0F0F"}
                      onMouseLeave={e=>e.currentTarget.style.background=""}>
                      <td style={{ padding:"8px 12px",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"white",fontWeight:600,fontSize:11 }}>{p.nom}</td>
                      <td style={{ padding:"8px 12px" }}>
                        <span style={{ fontSize:10,padding:"2px 5px",borderRadius:3,background:(CLASSE_COLORS[p.classe]||"#666")+"22",color:CLASSE_COLORS[p.classe]||"#666",fontWeight:700,whiteSpace:"nowrap" }}>{p.classe}</span>
                      </td>
                      <td style={{ padding:"8px 12px",fontFamily:"monospace",fontSize:10,color:"#444" }}>{p.isin}</td>
                      <td style={{ padding:"8px 12px",textAlign:"right",color:"#555",fontSize:11 }}>{p.devise}</td>
                      <td style={{ padding:"8px 12px",textAlign:"right",color:"#444",fontSize:11 }}>{p.pxAchat?fmtNum(p.pxAchat):"—"}</td>
                      <td style={{ padding:"8px 12px",textAlign:"right",color:"#888",fontSize:11 }}>{fmtNum(p.pxMarche)}</td>
                      <td style={{ padding:"8px 12px",textAlign:"right",color:"white",fontWeight:700 }}>{fmtEur(p.montantEur)}</td>
                      <td style={{ padding:"8px 12px",textAlign:"right",fontWeight:700,color:p.plEur>0?"#10b981":p.plEur<0?UBS_RED:"#444" }}>{p.plEur?fmtEur(p.plEur):"—"}</td>
                      <td style={{ padding:"8px 12px",textAlign:"right",color:p.plPct>0?"#10b981":p.plPct<0?UBS_RED:"#444",fontSize:11 }}>{p.plPct?fmtPct(p.plPct):"—"}</td>
                      <td style={{ padding:"8px 12px",textAlign:"right",color:"#555",fontSize:11 }}>{p.poids?`${p.poids.toFixed(1)}%`:"—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr style={{ borderTop:"1px solid #333",background:"#0A0A0A" }}>
                  <td colSpan={6} style={{ padding:"8px 12px",color:"#555",fontSize:11,fontWeight:700 }}>TOTAL</td>
                  <td style={{ padding:"8px 12px",textAlign:"right",color:"white",fontWeight:700 }}>{fmtEur(grandTotal)}</td>
                  <td style={{ padding:"8px 12px",textAlign:"right",fontWeight:700,color:grandPL>0?"#10b981":grandPL<0?UBS_RED:"#444" }}>{grandPL?fmtEur(grandPL):"—"}</td>
                  <td colSpan={2}/>
                </tr></tfoot>
              </table>
            </div>
          </Section>

          {classes.length>1 && <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
            <Section title="Répartition par classe">
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={classes.map(c=>({ name:c, value:Math.round(lastPositions.filter(p=>p.classe===c).reduce((s,p)=>s+p.montantEur,0)) }))}
                    cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value">
                    {classes.map((c,i)=><Cell key={i} fill={CLASSE_COLORS[c]||"#666"}/>)}
                  </Pie>
                  <Tooltip formatter={v=>fmtEur(v)} contentStyle={{ background:"#111",border:"1px solid #222",borderRadius:8,fontSize:11 }}/>
                </PieChart>
              </ResponsiveContainer>
            </Section>
            <Section title="Détail par classe">
              <div style={{ paddingTop:8 }}>
                {classes.map(c=>{ const t=lastPositions.filter(p=>p.classe===c).reduce((s,p)=>s+p.montantEur,0); return (
                  <div key={c} style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10 }}>
                    <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                      <div style={{ width:8,height:8,borderRadius:"50%",background:CLASSE_COLORS[c]||"#666",flexShrink:0 }}/>
                      <span style={{ color:"#888",fontSize:11 }}>{c}</span>
                    </div>
                    <div>
                      <span style={{ color:"white",fontSize:11,fontWeight:700 }}>{fmtEur(t)}</span>
                      <span style={{ color:"#444",fontSize:10,marginLeft:6 }}>{((t/grandTotal)*100).toFixed(1)}%</span>
                    </div>
                  </div>
                );})}
              </div>
            </Section>
          </div>}
        </> : <Section title="Positions détaillées">
          <div style={{ textAlign:"center",color:"#444",padding:"30px 0",fontSize:13 }}>
            Aucun fichier Position pour {compte.label}.<br/>
            <span style={{ fontSize:11,color:"#333",marginTop:6,display:"block" }}>
              Uploadez <code style={{ color:compte.color }}>Position_de_portefeuille*{compte.suffix||""}.xls</code>
            </span>
          </div>
        </Section>}
      </>}
    </div>
  );
}

// ─── Onglet Évolution produits ─────────────────────────────────────────────
function EvolutionTab({ positionsByDate }) {
  const [selectedCompte, setSelectedCompte] = useState("CTO");
  const [selectedISIN, setSelectedISIN] = useState(null);
  const compte = COMPTES[selectedCompte];

  const posDates = Object.keys(positionsByDate[selectedCompte]||{}).sort();

  const isinMap = {};
  for (const date of posDates) {
    for (const p of (positionsByDate[selectedCompte][date]||[])) {
      if (!isinMap[p.isin]) isinMap[p.isin] = { nom:p.nom,isin:p.isin,classe:p.classe,byDate:{} };
      isinMap[p.isin].byDate[date] = p;
    }
  }

  const positions = Object.values(isinMap).sort((a,b)=>{
    const d=posDates[posDates.length-1];
    return (b.byDate[d]?.montantEur||0)-(a.byDate[d]?.montantEur||0);
  });

  const selData = selectedISIN ? isinMap[selectedISIN] : null;
  const chartData = selData ? posDates.map(d=>({ label:ymdToLabel(d),
    montantEur:selData.byDate[d]?.montantEur??null,
    plEur:selData.byDate[d]?.plEur??null })).filter(d=>d.montantEur!=null) : [];

  return (
    <div style={{ display:"flex",flexDirection:"column",gap:12 }}>
      <div style={{ display:"flex",gap:6,flexWrap:"wrap" }}>
        {COMPTES_LIST.map(c=>(
          <button key={c.id} onClick={()=>{setSelectedCompte(c.id);setSelectedISIN(null);}} style={{
            padding:"7px 18px",borderRadius:6,border:`1px solid ${selectedCompte===c.id?c.color:"#222"}`,
            background:selectedCompte===c.id?c.color+"22":"transparent",
            color:selectedCompte===c.id?c.color:"#555",fontSize:12,fontWeight:700,cursor:"pointer" }}>
            {c.label}
          </button>
        ))}
      </div>

      {!posDates.length ? <Empty msg={`Pas de fichiers Position pour ${compte.label}. Uploadez Position_de_portefeuille*${compte.suffix||""}.xls`}/> : <>

        {selData && chartData.length>1 && <Section title={`Évolution — ${selData.nom}`}>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData} margin={{ left:10,right:10,top:5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#161616"/>
              <XAxis dataKey="label" tick={{ fill:"#555",fontSize:10 }}/>
              <YAxis tick={{ fill:"#555",fontSize:10 }} tickFormatter={v=>fmtEur(v)} width={90}/>
              <Tooltip content={<TT fmt={fmtEur}/>}/>
              <Line type="monotone" dataKey="montantEur" name="Valorisation" stroke={compte.color} strokeWidth={2} dot={{ r:3,fill:compte.color }}/>
            </LineChart>
          </ResponsiveContainer>
        </Section>}

        <Section title={`${positions.length} positions — ${posDates.length} date${posDates.length>1?"s":""} — cliquer pour graphique`} noPad>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%",borderCollapse:"collapse",fontSize:11 }}>
              <thead><tr style={{ borderBottom:"1px solid #1A1A1A",background:"#0A0A0A" }}>
                <th style={{ padding:"8px 12px",textAlign:"left",fontSize:10,fontWeight:700,textTransform:"uppercase",color:"#555",position:"sticky",left:0,background:"#0A0A0A",whiteSpace:"nowrap" }}>Nom</th>
                <th style={{ padding:"8px 12px",textAlign:"left",fontSize:10,fontWeight:700,textTransform:"uppercase",color:"#555",whiteSpace:"nowrap" }}>Classe</th>
                {posDates.map(d=>(
                  <th key={d} style={{ padding:"8px 12px",textAlign:"right",fontSize:10,fontWeight:700,color:"#444",whiteSpace:"nowrap" }}>{ymdToLabel(d)}</th>
                ))}
              </tr></thead>
              <tbody>
                {positions.map((pos,i)=>{
                  const isSel = selectedISIN===pos.isin;
                  return <tr key={i} style={{ borderBottom:"1px solid #0F0F0F",cursor:"pointer",background:isSel?`${compte.color}11`:""}}
                    onClick={()=>setSelectedISIN(isSel?null:pos.isin)}
                    onMouseEnter={e=>{ if(!isSel) e.currentTarget.style.background="#0F0F0F"; }}
                    onMouseLeave={e=>{ if(!isSel) e.currentTarget.style.background=""; }}>
                    <td style={{ padding:"8px 12px",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:isSel?compte.color:"white",fontWeight:600,position:"sticky",left:0,background:isSel?`${compte.color}11`:CARD_BG }}>{pos.nom}</td>
                    <td style={{ padding:"8px 12px" }}>
                      <span style={{ fontSize:10,padding:"2px 5px",borderRadius:3,background:(CLASSE_COLORS[pos.classe]||"#666")+"22",color:CLASSE_COLORS[pos.classe]||"#666",fontWeight:700 }}>{pos.classe}</span>
                    </td>
                    {posDates.map(d=>{
                      const pt=pos.byDate[d];
                      const prev=posDates[posDates.indexOf(d)-1];
                      const prevPt=prev?pos.byDate[prev]:null;
                      const diff=pt&&prevPt?pt.montantEur-prevPt.montantEur:null;
                      return <td key={d} style={{ padding:"8px 12px",textAlign:"right" }}>
                        {pt?<>
                          <div style={{ color:"white",fontWeight:600 }}>{fmtEur(pt.montantEur)}</div>
                          {diff!==null&&<div style={{ fontSize:10,color:diff>500?"#10b981":diff<-500?UBS_RED:"#444" }}>{diff>0?"+":""}{fmtEur(diff)}</div>}
                        </>:<span style={{ color:"#333" }}>—</span>}
                      </td>;
                    })}
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </Section>
      </>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// APP PRINCIPALE
// ═══════════════════════════════════════════════════════════════════════════
const TABS = [
  { id:"global",    label:"🌍 Global" },
  { id:"compte",    label:"🏦 Par compte" },
  { id:"evolution", label:"📈 Évolution produits" },
];

export default function UBSAnalyzer() {
  const [allData, setAllData]   = useState([]);
  const [tab, setTab]           = useState("global");
  const [loading, setLoading]   = useState(false);
  const [storageLoading, setStorageLoading] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const dropRef = useRef(null);

  const syntheses  = allData.filter(d=>d.type==="synthese");
  const timeline   = buildTimeline(syntheses);
  const annualPerf = buildAnnualPerf(timeline);

  const positionsByDate = {};
  for (const c of COMPTES_LIST) positionsByDate[c.id]={};
  for (const d of allData.filter(d=>d.type==="positions")) positionsByDate[d.compteId][d.date]=d.positions;

  useEffect(()=>{
    (async()=>{
      const saved = await loadFromStorage();
      if (saved.length) setAllData(saved);
      setStorageLoading(false);
    })();
  },[]);

  const addFiles = useCallback(async (files) => {
    setLoading(true);
    const newData = [];
    for (const file of files) {
      if (!file.name.match(/\.(xls|xlsx)$/i)) continue;
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const name = file.name.toLowerCase();
        if (name.includes("synth")) {
          const parsed = parseSynthese(buf, file.name);
          if (parsed) newData.push(parsed);
        } else if (name.includes("position")) {
          const parsed = parsePositions(buf, file.name);
          if (parsed?.positions.length) newData.push(parsed);
        }
      } catch(e) { console.warn("Erreur", file.name, e); }
    }
    setAllData(prev => {
      const existingKeys = new Set(prev.map(d=>d.type==="synthese"?`S_${d.date}`:`P_${d.date}_${d.compteId}`));
      const toAdd = newData.filter(d=>!existingKeys.has(d.type==="synthese"?`S_${d.date}`:`P_${d.date}_${d.compteId}`));
      const merged = [...prev, ...toAdd];
      saveToStorage(merged);
      return merged;
    });
    setLoading(false);
  }, []);

  const handleDrop = useCallback((e)=>{ e.preventDefault(); setIsDragging(false); addFiles(Array.from(e.dataTransfer.files)); },[addFiles]);
  const reset = async () => { await clearStorage(); setAllData([]); setTab("global"); };

  if (storageLoading) return (
    <div style={{ minHeight:"100vh",background:BG,display:"flex",alignItems:"center",justifyContent:"center" }}>
      <div style={{ textAlign:"center" }}><UBSLogo size={40}/><div style={{ color:"#444",fontSize:12,marginTop:12 }}>Chargement…</div></div>
    </div>
  );

  if (!allData.length) return (
    <div style={{ minHeight:"100vh",background:BG,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24 }}>
      <div style={{ marginBottom:40,textAlign:"center" }}>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:14,marginBottom:12 }}>
          <UBSLogo size={48}/>
          <div style={{ textAlign:"left" }}>
            <div style={{ fontSize:26,fontWeight:800,color:"white",letterSpacing:"-0.02em" }}>Portfolio Analyzer</div>
            <div style={{ fontSize:13,color:"#444",marginTop:2 }}>UBS · Synthèse + Positions · Multi-dates</div>
          </div>
        </div>
        <div style={{ width:56,height:3,background:UBS_RED,margin:"0 auto 24px" }}/>
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,maxWidth:500,margin:"0 auto",textAlign:"left" }}>
          {[
            { icon:"📊",title:"Fichiers Synthèse",desc:"Synthèse_de_portefeuille*.xls — historique global par compte (obligatoire)",color:"#10b981" },
            { icon:"📋",title:"Fichiers Positions",desc:"Position_de_portefeuille*.xls *_1_ *_2_ *_3_ — détail par produit (optionnel)",color:UBS_RED },
          ].map(f=>(
            <div key={f.title} style={{ padding:14,background:CARD_BG,border:`1px solid ${f.color}33`,borderRadius:10 }}>
              <div style={{ fontSize:20,marginBottom:6 }}>{f.icon}</div>
              <div style={{ color:f.color,fontWeight:700,fontSize:12,marginBottom:4 }}>{f.title}</div>
              <div style={{ color:"#555",fontSize:11,lineHeight:1.5 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </div>

      <div ref={dropRef} onDrop={handleDrop}
        onDragOver={e=>{ e.preventDefault();setIsDragging(true); }}
        onDragLeave={()=>setIsDragging(false)}
        style={{ width:"100%",maxWidth:520,border:`2px dashed ${isDragging?UBS_RED:"#222"}`,borderRadius:12,padding:"44px 32px",textAlign:"center",background:isDragging?"#1A0000":CARD_BG,transition:"all .2s" }}>
        <div style={{ fontSize:40,marginBottom:12 }}>📁</div>
        <div style={{ fontSize:16,fontWeight:700,color:"white",marginBottom:6 }}>Glissez tous vos fichiers UBS ici</div>
        <div style={{ fontSize:12,color:"#555",marginBottom:20 }}>Synthèses + Positions · Tous les mois en une fois</div>
        <label style={{ cursor:"pointer" }}>
          <span style={{ display:"inline-block",padding:"10px 28px",background:UBS_RED,color:"white",borderRadius:6,fontSize:13,fontWeight:700 }}
            onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
            Choisir les fichiers
          </span>
          <input type="file" accept=".xlsx,.xls" multiple style={{ display:"none" }} onChange={e=>addFiles(Array.from(e.target.files))}/>
        </label>
      </div>
      {loading && <div style={{ marginTop:20,color:"#555",fontSize:13 }}>Analyse en cours…</div>}
    </div>
  );

  const nSynth=allData.filter(d=>d.type==="synthese").length;
  const nPos=allData.filter(d=>d.type==="positions").length;

  return (
    <div style={{ minHeight:"100vh",background:BG,color:"white" }}>
      <div style={{ position:"sticky",top:0,zIndex:40,background:"#050505",borderBottom:"1px solid #1A1A1A" }}>
        <div style={{ height:2,background:UBS_RED }}/>
        <div style={{ maxWidth:1280,margin:"0 auto",padding:"10px 20px",display:"flex",flexWrap:"wrap",alignItems:"center",gap:10 }}>
          <div style={{ display:"flex",alignItems:"center",gap:10,marginRight:8 }}>
            <UBSLogo size={26}/>
            <div>
              <div style={{ fontSize:13,fontWeight:800,color:"white" }}>UBS Portfolio Analyzer</div>
              <div style={{ fontSize:10,color:"#444" }}>
                {nSynth} synthèse{nSynth>1?"s":""} · {nPos} position{nPos>1?"s":""} · {timeline.length} snapshot{timeline.length>1?"s":""}
                {timeline.length>0 && ` · ${timeline[0].label} → ${timeline[timeline.length-1].label}`}
              </div>
            </div>
          </div>

          <div style={{ display:"flex",gap:3,flexWrap:"wrap",maxWidth:600 }}>
            {timeline.slice(-10).map(s=>(
              <span key={s.date} style={{ fontSize:10,padding:"2px 7px",borderRadius:4,background:"#1A0000",color:UBS_RED,border:`1px solid ${UBS_RED}33`,fontFamily:"monospace" }}>{s.label}</span>
            ))}
            {timeline.length>10 && <span style={{ fontSize:10,color:"#444",padding:"2px 6px" }}>+{timeline.length-10} mois</span>}
          </div>

          <div style={{ marginLeft:"auto",display:"flex",gap:8 }}>
            <label style={{ cursor:"pointer" }}>
              <span style={{ display:"inline-block",padding:"5px 14px",background:"#1A1A1A",border:"1px solid #333",color:"#888",borderRadius:6,fontSize:12,fontWeight:700 }}
                onMouseEnter={e=>e.currentTarget.style.color="white"} onMouseLeave={e=>e.currentTarget.style.color="#888"}>
                + Ajouter
              </span>
              <input type="file" accept=".xlsx,.xls" multiple style={{ display:"none" }} onChange={e=>addFiles(Array.from(e.target.files))}/>
            </label>
            <button onClick={reset} style={{ padding:"5px 12px",background:"none",border:"1px solid #1A1A1A",color:"#555",borderRadius:6,fontSize:12,cursor:"pointer" }}>✕ Reset</button>
          </div>
        </div>

        <div style={{ maxWidth:1280,margin:"0 auto",padding:"0 20px",display:"flex",gap:2 }}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{ padding:"8px 18px",border:"none",borderBottom:tab===t.id?`2px solid ${UBS_RED}`:"2px solid transparent",background:"none",color:tab===t.id?"white":"#555",fontWeight:tab===t.id?700:400,fontSize:13,cursor:"pointer",transition:"color .15s",marginBottom:-1 }}>
              {t.label}
            </button>
          ))}
          {loading && <span style={{ color:"#555",fontSize:11,padding:"10px 12px" }}>⏳</span>}
        </div>
      </div>

      <div style={{ maxWidth:1280,margin:"0 auto",padding:"20px" }}>
        {tab==="global"    && <GlobalTab timeline={timeline} annualPerf={annualPerf}/>}
        {tab==="compte"    && <CompteTab timeline={timeline} positionsByDate={positionsByDate}/>}
        {tab==="evolution" && <EvolutionTab positionsByDate={positionsByDate}/>}
      </div>
    </div>
  );
}
