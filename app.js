
const appConfig = window.APP_CONFIG || {};
const supabaseReady = appConfig.supabaseUrl && appConfig.supabaseAnonKey &&
  !appConfig.supabaseUrl.includes("PASTE_") && !appConfig.supabaseAnonKey.includes("PASTE_");

let supabaseClient = null;
let trackerRows = [];
let currentLoad = 1;
let currentTrackerId = appConfig.trackerId || "oldbury-main";
let realtimeChannel = null;
let autoRotate = localStorage.getItem("amco-auto-rotate") === "1";
let autoRotateTimer = null;
let editingNoteRowId = null;

const els = {
  setupWarning: document.getElementById("setupWarning"),
  csvFile: document.getElementById("csvFile"),
  downloadCsvBtn: document.getElementById("downloadCsvBtn"),
  viewMode: document.getElementById("viewMode"),
  prevLoadBtn: document.getElementById("prevLoadBtn"),
  nextLoadBtn: document.getElementById("nextLoadBtn"),
  currentLoadBadge: document.getElementById("currentLoadBadge"),
  loadSizeSelect: document.getElementById("loadSizeSelect"),
  searchInput: document.getElementById("searchInput"),
  shipmentDateFilter: document.getElementById("shipmentDateFilter"),
  rowsContainer: document.getElementById("rowsContainer"),
  emptyState: document.getElementById("emptyState"),
  displayTitle: document.getElementById("displayTitle"),
  recordCountText: document.getElementById("recordCountText"),
  connectionBadge: document.getElementById("connectionBadge"),
  saveBadge: document.getElementById("saveBadge"),
  totalKennsTile: document.getElementById("totalKennsTile"),
  pickingTile: document.getElementById("pickingTile"),
  checkedTile: document.getElementById("checkedTile"),
  completeTile: document.getElementById("completeTile"),
  despatchedTile: document.getElementById("despatchedTile"),
  shortageTile: document.getElementById("shortageTile"),
  ringComplete: document.getElementById("ringComplete"),
  ringPct: document.getElementById("ringPct"),
  completePctText: document.getElementById("completePctText"),
  despatchedPctText: document.getElementById("despatchedPctText"),
  pickingPctText: document.getElementById("pickingPctText"),
  shortagesText: document.getElementById("shortagesText"),
  loadPctText: document.getElementById("loadPctText"),
  autoRotateBtn: document.getElementById("autoRotateBtn"),
  themeBtn: document.getElementById("themeBtn"),
  noteModal: document.getElementById("noteModal"),
  noteModalText: document.getElementById("noteModalText"),
  noteCancelBtn: document.getElementById("noteCancelBtn"),
  noteSaveBtn: document.getElementById("noteSaveBtn"),
};

function setTheme(theme){
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("amco-theme", theme);
  els.themeBtn.textContent = theme === "dark" ? "Light Mode" : "Dark Mode";
}
function initTheme(){ setTheme(localStorage.getItem("amco-theme") || "light"); }
function setConnectionState(text, kind){
  els.connectionBadge.textContent = text;
  els.connectionBadge.className = "badge";
  els.connectionBadge.classList.add(kind === "ok" ? "badge-green" : "badge-red");
}
function setSaveState(text){ els.saveBadge.textContent = text; els.saveBadge.className = "badge badge-muted"; }
function normaliseKey(key){ return String(key || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
function splitCsvLine(line){
  const out=[]; let current=""; let inQuotes=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch === '"'){ if(inQuotes && line[i+1] === '"'){ current+='"'; i++; } else { inQuotes=!inQuotes; } }
    else if(ch === "," && !inQuotes){ out.push(current); current=""; }
    else { current += ch; }
  }
  out.push(current); return out;
}
function parseCsv(text){
  const lines=text.replace(/\r/g,"").split("\n").filter(Boolean);
  if(!lines.length) return [];
  const headers=splitCsvLine(lines[0]).map(normaliseKey);
  return lines.slice(1).map(line => {
    const cells=splitCsvLine(line); const obj={};
    headers.forEach((h,idx) => obj[h]=(cells[idx] || "").trim());
    return obj;
  }).filter(obj => Object.values(obj).some(v => String(v).trim() !== ""));
}
function truthy(v){ const t=String(v || "").trim().toLowerCase(); return ["1","true","yes","y","done"].includes(t); }
function toNumber(v){ const n=Number(v); return Number.isFinite(n) ? n : 0; }
function nowIso(){ return new Date().toISOString(); }
function formatDate(value){
  if(!value) return "";
  const d = new Date(value);
  if(Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-GB", {day:"2-digit", month:"2-digit", year:"numeric"});
}
function formatStamp(iso){
  if(!iso) return "";
  const d=new Date(iso);
  if(Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit"});
}
function normaliseBuildType(row){
  const raw = String(row.build_type || row.gru || row.bespoke || "").trim();
  if(raw.toLowerCase() === "bespoke" || raw.toLowerCase() === "yes" || raw.toLowerCase() === "y" || raw === "1") return "Bespoke";
  return raw && raw.toLowerCase() !== "n" && raw.toLowerCase() !== "no" ? raw : "";
}
function normaliseImportedRows(rawRows){
  const loadSize=Number(els.loadSizeSelect.value || appConfig.defaultKennsPerLoad || 11);
  return rawRows.map((r,idx) => {
    const loadNo = toNumber(r.load_no || r.load || r.load_number) || (Math.floor(idx/loadSize)+1);
    const loadPos = toNumber(r.load_pos || r.position || r.load_position) || ((idx%loadSize)+1);
    return {
      tracker_id: currentTrackerId,
      kenn: r.kenn || r.reference || "",
      model: r.model || "",
      build_type: normaliseBuildType(r),
      colour: r.colour || r.color || "",
      notes: r.notes || "",
      shipment_date: r.shipment_date || r.ship_date || r.date || null,
      shortage_note: r.shortage_note || "",
      load_no: loadNo,
      load_pos: loadPos,
      bumper_picking: truthy(r.bumper_picking),
      bumper_picked: truthy(r.bumper_picked),
      cage_picking: truthy(r.cage_picking),
      cage_picked: truthy(r.cage_picked),
      checked: truthy(r.checked),
      complete: truthy(r.complete),
      despatched: truthy(r.despatched),
      shortage: truthy(r.shortage)
    };
  }).filter(r => r.kenn);
}
function currentMaxLoad(){ return Math.max(1, ...trackerRows.map(r => Number(r.load_no || 1))); }
function currentLoadRows(){ return visibleBaseRows().filter(r => Number(r.load_no) === currentLoad); }
function currentLoadCompletePct(){ const rows=currentLoadRows(); return rows.length ? Math.round((rows.filter(r=>r.complete).length/rows.length)*100) : 0; }
function statusClass(row){
  if(row.shortage) return "row-shortage";
  if(row.complete && !row.shortage) return "row-complete";
  if(row.bumper_picking || row.cage_picking || row.checked) return "row-progress";
  return "";
}
function isDone(row){ return !!(row.complete && row.despatched && !row.shortage); }
function uniqueShipmentDates(){
  return [...new Set(trackerRows.map(r => r.shipment_date).filter(Boolean))].sort();
}
function updateShipmentFilterOptions(){
  const current = els.shipmentDateFilter.value;
  const dates = uniqueShipmentDates();
  els.shipmentDateFilter.innerHTML = `<option value="all">All shipment dates</option>` + dates.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(formatDate(d))}</option>`).join("");
  if(dates.includes(current)) els.shipmentDateFilter.value = current;
}
function visibleBaseRows(){
  const dateFilter = els.shipmentDateFilter.value;
  return trackerRows.filter(r => dateFilter === "all" || String(r.shipment_date) === String(dateFilter));
}
function filteredRows(){
  const search=els.searchInput.value.trim().toLowerCase();
  const mode=els.viewMode.value;
  return visibleBaseRows().filter(row => {
    if(mode === "current" && Number(row.load_no) !== currentLoad) return false;
    if(mode === "shortages" && !row.shortage) return false;
    if(search){
      const hay=[row.kenn,row.model,row.colour,row.notes,row.build_type,row.shortage_note,row.shipment_date].join(" ").toLowerCase();
      if(!hay.includes(search)) return false;
    }
    return true;
  }).sort((a,b) => (a.load_no-b.load_no) || (a.load_pos-b.load_pos) || String(a.kenn).localeCompare(String(b.kenn)));
}
function renderSummary(){
  const base=visibleBaseRows();
  const total=base.length;
  const picking=base.filter(r => r.bumper_picking || r.cage_picking).length;
  const checked=base.filter(r => r.checked).length;
  const complete=base.filter(r => r.complete).length;
  const despatched=base.filter(r => r.despatched).length;
  const shortages=base.filter(r => r.shortage).length;
  const completePct=total ? Math.round((complete/total)*100) : 0;
  const despatchedPct=total ? Math.round((despatched/total)*100) : 0;
  const pickingPct=total ? Math.round((picking/total)*100) : 0;
  els.totalKennsTile.textContent=total; els.pickingTile.textContent=picking; els.checkedTile.textContent=checked; els.completeTile.textContent=complete; els.despatchedTile.textContent=despatched; els.shortageTile.textContent=shortages;
  els.completePctText.textContent=completePct+"%"; els.despatchedPctText.textContent=despatchedPct+"%"; els.pickingPctText.textContent=pickingPct+"%"; els.shortagesText.textContent=shortages; els.loadPctText.textContent=currentLoadCompletePct()+"%";
  const r=50,c=2*Math.PI*r,p=(completePct/100)*c;
  els.ringComplete.style.strokeDasharray=`${p} ${c}`; els.ringPct.textContent=completePct+"%";
}
function renderTimestamps(row){
  const lines=[];
  if(row.checked_at) lines.push(`<div class="ts-line">Checked ${formatStamp(row.checked_at)}</div>`);
  if(row.complete_at) lines.push(`<div class="ts-line">Complete ${formatStamp(row.complete_at)}</div>`);
  if(row.despatched_at) lines.push(`<div class="ts-line">Despatched ${formatStamp(row.despatched_at)}</div>`);
  if(row.shortage_at) lines.push(`<div class="ts-line">Shortage ${formatStamp(row.shortage_at)}</div>`);
  return lines.length ? `<div class="ts-list">${lines.join("")}</div>` : "";
}
function renderRows(){
  updateShipmentFilterOptions();
  const rows=filteredRows();
  els.rowsContainer.innerHTML="";
  els.emptyState.classList.toggle("hidden", rows.length>0);
  els.recordCountText.textContent=rows.length+(rows.length===1 ? " row shown" : " rows shown");
  els.displayTitle.textContent=els.viewMode.value === "current" ? `Showing Load ${currentLoad}` : els.viewMode.value === "shortages" ? "Showing Shortages" : "Showing All Loads";
  els.currentLoadBadge.textContent=`Load ${currentLoad} of ${currentMaxLoad()}`;
  rows.forEach(row => {
    const rowEl=document.createElement("div");
    rowEl.className=`row row-grid ${statusClass(row)}`;
    rowEl.innerHTML=`
      <div class="col-info">
        <div class="kenn-main">${escapeHtml(row.kenn || "")}</div>
        <div class="kenn-sub">Load ${row.load_no || "-"} • Position ${row.load_pos || "-"}</div>
        ${row.shipment_date ? `<div class="shipment-line">Shipment ${escapeHtml(formatDate(row.shipment_date))}</div>` : ""}
      </div>
      <div class="col-model"><div class="value-main">${escapeHtml(row.model || "-")}</div></div>
      <div class="col-colour">
        <div class="value-main">${escapeHtml(row.colour || "-")}</div>
        ${row.build_type && String(row.build_type).toLowerCase()==="bespoke" ? `<span class="bespoke-badge">BESPOKE</span>` : ""}
        ${row.notes ? `<div class="mini-note">${escapeHtml(row.notes)}</div>` : ""}
      </div>
      <div class="col-bumper"><div class="stack-buttons">${toggleButtonHtml(row,"bumper_picking","Picking","bumper-picking")}${toggleButtonHtml(row,"bumper_picked","Picked","bumper-picked")}</div></div>
      <div class="col-cage"><div class="stack-buttons">${toggleButtonHtml(row,"cage_picking","Picking","cage-picking")}${toggleButtonHtml(row,"cage_picked","Picked","cage-picked")}</div></div>
      <div class="col-final">
        <div class="stack-buttons single-3">${toggleButtonHtml(row,"checked","Checked","checked")}${toggleButtonHtml(row,"complete","Complete","complete")}${toggleButtonHtml(row,"despatched","Despatched","despatched")}</div>
        ${renderTimestamps(row)}
      </div>
      <div class="col-shortage">
        <div class="stack-buttons single-1">${toggleButtonHtml(row,"shortage",row.shortage ? "SHORTAGE" : "Shortage","shortage")}</div>
        ${row.shortage ? `<span class="shortage-badge">RED SHORTAGE</span>${row.shortage_note ? `<span class="shortage-note-preview">${escapeHtml(row.shortage_note)}</span>` : `<span class="shortage-note-preview">Click shortage again to update note</span>`}` : ""}
      </div>
      <div class="col-done done-cell"><div class="done-check ${isDone(row) ? "is-done" : ""}">${isDone(row) ? "✓" : "–"}</div></div>
    `;
    els.rowsContainer.appendChild(rowEl);
  });
  bindRowButtons();
  renderSummary();
}
function toggleButtonHtml(row,field,label,cssClass){ const on=!!row[field]; return `<button class="status-btn ${cssClass} ${on?"on":"off"}" data-row-id="${row.id}" data-field="${field}">${label}</button>`; }
function escapeHtml(v){ return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;"); }
async function updateRow(rowId, patch){
  setSaveState("Saving...");
  const { error } = await supabaseClient.from("tracker_rows").update(patch).eq("id", rowId);
  if(error) throw error;
  setSaveState("Saved");
}
function openShortageModal(rowId){
  editingNoteRowId=rowId;
  const row=trackerRows.find(r => Number(r.id) === Number(rowId));
  els.noteModalText.value=row?.shortage_note || "";
  els.noteModal.classList.remove("hidden");
  setTimeout(() => els.noteModalText.focus(),10);
}
function closeShortageModal(){ editingNoteRowId=null; els.noteModal.classList.add("hidden"); }
function bindRowButtons(){
  document.querySelectorAll(".status-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const rowId=Number(btn.dataset.rowId), field=btn.dataset.field;
      const row=trackerRows.find(r => Number(r.id) === rowId);
      if(!row || !supabaseClient) return;
      const next=!row[field];
      const patch={ [field]:next };
      if(field==="checked") patch.checked_at = next ? nowIso() : null;
      if(field==="complete"){ patch.complete_at = next ? nowIso() : null; if(next){ patch.shortage=false; patch.shortage_at=null; } }
      if(field==="despatched"){ patch.despatched_at = next ? nowIso() : null; if(next){ patch.complete=true; patch.complete_at = row.complete_at || nowIso(); patch.checked=true; patch.checked_at = row.checked_at || nowIso(); patch.shortage=false; patch.shortage_at=null; } }
      if(field==="shortage"){ patch.shortage_at = next ? nowIso() : null; if(next){ patch.complete=false; patch.complete_at=null; patch.despatched=false; patch.despatched_at=null; } else { patch.shortage_note=""; } }
      try{
        await updateRow(rowId, patch);
        if(field==="shortage" && next) openShortageModal(rowId);
        if(field==="shortage" && !next && row.shortage_note) openShortageModal(rowId);
      }catch(err){ console.error(err); setSaveState("Save failed"); alert("Update failed. Check Supabase setup."); }
    });
  });
}
async function loadRows(){
  if(!supabaseClient) return;
  const { data, error } = await supabaseClient.from("tracker_rows").select("*").eq("tracker_id", currentTrackerId).order("shipment_date",{ascending:true}).order("load_no",{ascending:true}).order("load_pos",{ascending:true});
  if(error){ console.error(error); setConnectionState("Supabase error","bad"); return; }
  trackerRows=data || [];
  currentLoad=Math.min(currentLoad,currentMaxLoad());
  renderRows();
}
async function replaceRowsFromCsv(file){
  if(!supabaseClient) return;
  const raw=await file.text();
  const parsed=parseCsv(raw);
  const rows=normaliseImportedRows(parsed);
  if(!rows.length){ alert("No valid rows were found in the CSV."); return; }
  const ok=confirm(`Replace all rows in tracker "${currentTrackerId}" with ${rows.length} imported KENNs?`);
  if(!ok) return;
  try{
    setSaveState("Replacing rows...");
    const { error: deleteError }=await supabaseClient.from("tracker_rows").delete().eq("tracker_id",currentTrackerId);
    if(deleteError) throw deleteError;
    const { error: insertError }=await supabaseClient.from("tracker_rows").insert(rows);
    if(insertError) throw insertError;
    setSaveState("Import complete");
  }catch(err){ console.error(err); setSaveState("Import failed"); alert("CSV import failed. Check schema has V3 columns."); }
}
function exportCsv(){
  const headers=["kenn","model","build_type","colour","notes","shipment_date","shortage_note","load_no","load_pos","bumper_picking","bumper_picked","cage_picking","cage_picked","checked","complete","despatched","shortage","checked_at","complete_at","despatched_at","shortage_at"];
  const lines=[headers.join(",")];
  [...trackerRows].sort((a,b) => String(a.shipment_date||"").localeCompare(String(b.shipment_date||"")) || (a.load_no-b.load_no) || (a.load_pos-b.load_pos)).forEach(row => {
    lines.push(headers.map(h => csvValue(row[h])).join(","));
  });
  const blob=new Blob([lines.join("\n")],{type:"text/csv;charset=utf-8;"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`${currentTrackerId}-tracker-export.csv`; a.click(); URL.revokeObjectURL(a.href);
}
function csvValue(v){ const s=String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replaceAll('"','""')}"` : s; }
function subscribeRealtime(){
  if(!supabaseClient) return;
  if(realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
  realtimeChannel = supabaseClient.channel(`tracker-${currentTrackerId}`)
    .on("postgres_changes",{event:"*",schema:"public",table:"tracker_rows",filter:`tracker_id=eq.${currentTrackerId}`}, () => loadRows())
    .subscribe();
}
function applyAutoRotate(){
  els.autoRotateBtn.textContent=`Auto Rotate Loads: ${autoRotate ? "On" : "Off"}`;
  if(autoRotateTimer){ clearInterval(autoRotateTimer); autoRotateTimer=null; }
  if(autoRotate){
    autoRotateTimer=setInterval(() => {
      if(els.viewMode.value === "current"){
        currentLoad = currentLoad >= currentMaxLoad() ? 1 : currentLoad + 1;
        renderRows();
      }
    }, 8000);
  }
}
function initEvents(){
  els.loadSizeSelect.value=String(appConfig.defaultKennsPerLoad || 11);
  els.viewMode.addEventListener("change", renderRows);
  els.searchInput.addEventListener("input", renderRows);
  els.shipmentDateFilter.addEventListener("change", () => { currentLoad=1; renderRows(); });
  els.prevLoadBtn.addEventListener("click", () => { currentLoad=Math.max(1,currentLoad-1); renderRows(); });
  els.nextLoadBtn.addEventListener("click", () => { currentLoad=Math.min(currentMaxLoad(),currentLoad+1); renderRows(); });
  els.downloadCsvBtn.addEventListener("click", exportCsv);
  els.csvFile.addEventListener("change", async e => { const file=e.target.files && e.target.files[0]; if(file) await replaceRowsFromCsv(file); e.target.value=""; });
  els.autoRotateBtn.addEventListener("click", () => { autoRotate=!autoRotate; localStorage.setItem("amco-auto-rotate",autoRotate?"1":"0"); applyAutoRotate(); });
  els.themeBtn.addEventListener("click", () => { const next=(localStorage.getItem("amco-theme") || "light")==="light" ? "dark" : "light"; setTheme(next); });
  els.noteCancelBtn.addEventListener("click", closeShortageModal);
  els.noteSaveBtn.addEventListener("click", async () => {
    if(!editingNoteRowId) return;
    try{ await updateRow(editingNoteRowId,{shortage_note:els.noteModalText.value.trim()}); closeShortageModal(); }
    catch(err){ console.error(err); alert("Could not save shortage note."); }
  });
  els.noteModal.addEventListener("click", e => { if(e.target === els.noteModal) closeShortageModal(); });
}
function setTheme(theme){ document.documentElement.setAttribute("data-theme",theme); localStorage.setItem("amco-theme",theme); els.themeBtn.textContent=theme==="dark"?"Light Mode":"Dark Mode"; }
function initTheme(){ setTheme(localStorage.getItem("amco-theme") || "light"); }
async function initApp(){
  initTheme(); initEvents(); applyAutoRotate();
  if(!supabaseReady){ els.setupWarning.classList.remove("hidden"); setConnectionState("Setup needed","bad"); renderSummary(); renderRows(); return; }
  try{
    supabaseClient=window.supabase.createClient(appConfig.supabaseUrl,appConfig.supabaseAnonKey);
    setConnectionState("Connecting...","ok");
    subscribeRealtime();
    await loadRows();
    setConnectionState("Live connected","ok");
    setSaveState("Ready");
  }catch(err){ console.error(err); setConnectionState("Connection failed","bad"); els.setupWarning.classList.remove("hidden"); }
}
initApp();
