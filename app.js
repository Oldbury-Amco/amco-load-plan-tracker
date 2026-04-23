const appConfig = window.APP_CONFIG || {};
const supabaseReady = appConfig.supabaseUrl && appConfig.supabaseAnonKey &&
  !appConfig.supabaseUrl.includes("PASTE_") && !appConfig.supabaseAnonKey.includes("PASTE_");

let supabaseClient = null;
let trackerRows = [];
let currentLoad = 1;
let currentTrackerId = appConfig.trackerId || "oldbury-main";
let realtimeChannel = null;

const els = {
  setupWarning: document.getElementById("setupWarning"),
  csvFile: document.getElementById("csvFile"),
  downloadCsvBtn: document.getElementById("downloadCsvBtn"),
  trackerIdInput: document.getElementById("trackerIdInput"),
  viewMode: document.getElementById("viewMode"),
  prevLoadBtn: document.getElementById("prevLoadBtn"),
  nextLoadBtn: document.getElementById("nextLoadBtn"),
  currentLoadBadge: document.getElementById("currentLoadBadge"),
  loadSizeSelect: document.getElementById("loadSizeSelect"),
  searchInput: document.getElementById("searchInput"),
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
};

function setConnectionState(text, kind){
  els.connectionBadge.textContent = text;
  els.connectionBadge.className = "badge";
  els.connectionBadge.classList.add(kind === "ok" ? "badge-green" : "badge-red");
}

function setSaveState(text){
  els.saveBadge.textContent = text;
  els.saveBadge.className = "badge badge-muted";
}

function normaliseKey(key){
  return String(key || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function splitCsvLine(line){
  const out = [];
  let current = "";
  let inQuotes = false;
  for(let i=0;i<line.length;i++){
    const ch = line[i];
    if(ch === '"'){
      if(inQuotes && line[i+1] === '"'){ current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if(ch === "," && !inQuotes){
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function parseCsv(text){
  const lines = text.replace(/\r/g,"").split("\n").filter(Boolean);
  if(!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map(normaliseKey);
  const rows = [];
  for(let i=1;i<lines.length;i++){
    const cells = splitCsvLine(lines[i]);
    if(cells.every(c => String(c).trim() === "")) continue;
    const obj = {};
    headers.forEach((h,idx) => obj[h] = (cells[idx] || "").trim());
    rows.push(obj);
  }
  return rows;
}

function truthy(v){
  const t = String(v || "").trim().toLowerCase();
  return ["1","true","yes","y","done"].includes(t);
}

function toNumber(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normaliseImportedRows(rawRows){
  const loadSize = Number(els.loadSizeSelect.value || appConfig.defaultKennsPerLoad || 11);
  return rawRows.map((r, idx) => {
    const loadNo = toNumber(r.load_no || r.load || r.load_number) || (Math.floor(idx / loadSize) + 1);
    const loadPos = toNumber(r.load_pos || r.position || r.load_position) || ((idx % loadSize) + 1);
    return {
      tracker_id: currentTrackerId,
      kenn: r.kenn || r.reference || "",
      model: r.model || "",
      gru: r.gru || "",
      colour: r.colour || r.color || "",
      notes: r.notes || "",
      load_no: loadNo,
      load_pos: loadPos,
      bumper_picking: truthy(r.bumper_picking),
      bumper_picked: truthy(r.bumper_picked),
      cage_picking: truthy(r.cage_picking),
      cage_picked: truthy(r.cage_picked),
      checked: truthy(r.checked),
      complete: truthy(r.complete),
      despatched: truthy(r.despatched),
      shortage: truthy(r.shortage),
    };
  }).filter(r => r.kenn);
}

function currentMaxLoad(){
  return Math.max(1, ...trackerRows.map(r => Number(r.load_no || 1)));
}

function statusClass(row){
  if(row.shortage) return "row-shortage";
  if(row.complete && !row.shortage) return "row-complete";
  if(row.bumper_picking || row.cage_picking || row.checked) return "row-progress";
  return "";
}

function isDone(row){
  return !!(row.complete && row.despatched && !row.shortage);
}

function filteredRows(){
  const search = els.searchInput.value.trim().toLowerCase();
  const mode = els.viewMode.value;
  return trackerRows.filter(row => {
    if(mode === "current" && Number(row.load_no) !== currentLoad) return false;
    if(search){
      const hay = [row.kenn, row.model, row.colour, row.notes, row.gru].join(" ").toLowerCase();
      if(!hay.includes(search)) return false;
    }
    return true;
  }).sort((a,b) => {
    if(a.load_no !== b.load_no) return a.load_no - b.load_no;
    if(a.load_pos !== b.load_pos) return a.load_pos - b.load_pos;
    return String(a.kenn).localeCompare(String(b.kenn));
  });
}

function renderSummary(){
  const total = trackerRows.length;
  const picking = trackerRows.filter(r => r.bumper_picking || r.cage_picking).length;
  const checked = trackerRows.filter(r => r.checked).length;
  const complete = trackerRows.filter(r => r.complete).length;
  const despatched = trackerRows.filter(r => r.despatched).length;
  const shortages = trackerRows.filter(r => r.shortage).length;
  const completePct = total ? Math.round((complete / total) * 100) : 0;
  const despatchedPct = total ? Math.round((despatched / total) * 100) : 0;
  const pickingPct = total ? Math.round((picking / total) * 100) : 0;

  els.totalKennsTile.textContent = total;
  els.pickingTile.textContent = picking;
  els.checkedTile.textContent = checked;
  els.completeTile.textContent = complete;
  els.despatchedTile.textContent = despatched;
  els.shortageTile.textContent = shortages;

  els.completePctText.textContent = completePct + "%";
  els.despatchedPctText.textContent = despatchedPct + "%";
  els.pickingPctText.textContent = pickingPct + "%";
  els.shortagesText.textContent = shortages;

  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const progress = (completePct / 100) * circumference;
  els.ringComplete.style.strokeDasharray = `${progress} ${circumference}`;
  els.ringPct.textContent = completePct + "%";
}

function renderRows(){
  const rows = filteredRows();
  els.rowsContainer.innerHTML = "";
  els.emptyState.classList.toggle("hidden", rows.length > 0);
  els.recordCountText.textContent = rows.length + (rows.length === 1 ? " row shown" : " rows shown");
  els.displayTitle.textContent = els.viewMode.value === "current" ? `Showing Load ${currentLoad}` : "Showing All Loads";
  els.currentLoadBadge.textContent = `Load ${currentLoad} of ${currentMaxLoad()}`;

  rows.forEach(row => {
    const rowEl = document.createElement("div");
    rowEl.className = `row row-grid ${statusClass(row)}`;
    rowEl.innerHTML = `
      <div class="col-info">
        <div class="kenn-main">${escapeHtml(row.kenn || "")}</div>
        <div class="kenn-sub">Load ${row.load_no || "-"} • Position ${row.load_pos || "-"}</div>
      </div>
      <div class="col-model">
        <div class="value-main">${escapeHtml(row.model || "-")}</div>
        <div class="value-sub">${row.gru ? "GRU " + escapeHtml(row.gru) : ""}</div>
      </div>
      <div class="col-colour">
        <div class="value-main">${escapeHtml(row.colour || "-")}</div>
        <div class="value-sub">${escapeHtml(row.notes || "")}</div>
      </div>
      <div class="col-bumper">
        <div class="stack-buttons">
          ${toggleButtonHtml(row, "bumper_picking", "Picking", "bumper-picking")}
          ${toggleButtonHtml(row, "bumper_picked", "Picked", "bumper-picked")}
        </div>
      </div>
      <div class="col-cage">
        <div class="stack-buttons">
          ${toggleButtonHtml(row, "cage_picking", "Picking", "cage-picking")}
          ${toggleButtonHtml(row, "cage_picked", "Picked", "cage-picked")}
        </div>
      </div>
      <div class="col-final">
        <div class="stack-buttons single-3">
          ${toggleButtonHtml(row, "checked", "Checked", "checked")}
          ${toggleButtonHtml(row, "complete", "Complete", "complete")}
          ${toggleButtonHtml(row, "despatched", "Despatched", "despatched")}
        </div>
      </div>
      <div class="col-shortage">
        <div class="stack-buttons single-1">
          ${toggleButtonHtml(row, "shortage", "Shortage", "shortage")}
        </div>
      </div>
      <div class="col-done done-cell">
        <div class="done-check ${isDone(row) ? "is-done" : ""}">${isDone(row) ? "✓" : "–"}</div>
      </div>
    `;
    els.rowsContainer.appendChild(rowEl);
  });

  bindRowButtons();
  renderSummary();
}

function toggleButtonHtml(row, field, label, cssClass){
  const on = !!row[field];
  return `<button class="status-btn ${cssClass} ${on ? "on" : "off"}" data-row-id="${row.id}" data-field="${field}">${label}</button>`;
}

function bindRowButtons(){
  document.querySelectorAll(".status-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const rowId = Number(btn.dataset.rowId);
      const field = btn.dataset.field;
      const row = trackerRows.find(r => Number(r.id) === rowId);
      if(!row || !supabaseClient) return;

      const next = !row[field];
      const patch = { [field]: next };

      if(field === "shortage" && next){
        patch.complete = false;
        patch.despatched = false;
      }
      if(field === "complete" && next){
        patch.shortage = false;
      }
      if(field === "despatched" && next){
        patch.complete = true;
        patch.checked = true;
        patch.shortage = false;
      }

      try{
        setSaveState("Saving...");
        const { error } = await supabaseClient.from("tracker_rows").update(patch).eq("id", rowId);
        if(error) throw error;
        setSaveState("Saved");
      }catch(err){
        console.error(err);
        setSaveState("Save failed");
        alert("Update failed. Please check your Supabase setup.");
      }
    });
  });
}

function escapeHtml(v){
  return String(v ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

async function loadRows(){
  if(!supabaseClient) return;
  const { data, error } = await supabaseClient
    .from("tracker_rows")
    .select("*")
    .eq("tracker_id", currentTrackerId)
    .order("load_no", { ascending: true })
    .order("load_pos", { ascending: true });

  if(error){
    console.error(error);
    setConnectionState("Supabase error", "bad");
    return;
  }
  trackerRows = data || [];
  currentLoad = Math.min(currentLoad, currentMaxLoad());
  renderRows();
}

async function replaceRowsFromCsv(file){
  if(!supabaseClient) return;
  const raw = await file.text();
  const parsed = parseCsv(raw);
  const rows = normaliseImportedRows(parsed);

  if(!rows.length){
    alert("No valid rows were found in the CSV.");
    return;
  }

  const ok = confirm(`Replace all rows in tracker "${currentTrackerId}" with ${rows.length} imported KENNs?`);
  if(!ok) return;

  try{
    setSaveState("Replacing rows...");
    const { error: deleteError } = await supabaseClient.from("tracker_rows").delete().eq("tracker_id", currentTrackerId);
    if(deleteError) throw deleteError;
    const { error: insertError } = await supabaseClient.from("tracker_rows").insert(rows);
    if(insertError) throw insertError;
    setSaveState("Import complete");
  }catch(err){
    console.error(err);
    setSaveState("Import failed");
    alert("CSV import failed. Please check the README and Supabase setup.");
  }
}

function exportCsv(){
  const headers = [
    "kenn","model","gru","colour","notes","load_no","load_pos",
    "bumper_picking","bumper_picked","cage_picking","cage_picked",
    "checked","complete","despatched","shortage"
  ];
  const lines = [headers.join(",")];
  [...trackerRows].sort((a,b) => (a.load_no - b.load_no) || (a.load_pos - b.load_pos)).forEach(row => {
    lines.push(headers.map(h => csvValue(row[h])).join(","));
  });
  const blob = new Blob([lines.join("\n")], { type:"text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${currentTrackerId}-tracker-export.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function csvValue(v){
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"','""')}"` : s;
}

function initEvents(){
  els.trackerIdInput.value = currentTrackerId;
  els.loadSizeSelect.value = String(appConfig.defaultKennsPerLoad || 11);

  els.trackerIdInput.addEventListener("change", async () => {
    currentTrackerId = els.trackerIdInput.value.trim() || "oldbury-main";
    if(supabaseClient){
      subscribeRealtime();
      await loadRows();
    }
  });
  els.viewMode.addEventListener("change", renderRows);
  els.searchInput.addEventListener("input", renderRows);
  els.prevLoadBtn.addEventListener("click", () => {
    currentLoad = Math.max(1, currentLoad - 1);
    renderRows();
  });
  els.nextLoadBtn.addEventListener("click", () => {
    currentLoad = Math.min(currentMaxLoad(), currentLoad + 1);
    renderRows();
  });
  els.downloadCsvBtn.addEventListener("click", exportCsv);
  els.csvFile.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if(file) await replaceRowsFromCsv(file);
    e.target.value = "";
  });
}

function subscribeRealtime(){
  if(!supabaseClient) return;
  if(realtimeChannel){
    supabaseClient.removeChannel(realtimeChannel);
  }
  realtimeChannel = supabaseClient
    .channel(`tracker-${currentTrackerId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "tracker_rows",
      filter: `tracker_id=eq.${currentTrackerId}`
    }, () => {
      loadRows();
    })
    .subscribe();
}

async function initApp(){
  initEvents();

  if(!supabaseReady){
    els.setupWarning.classList.remove("hidden");
    setConnectionState("Setup needed", "bad");
    renderSummary();
    renderRows();
    return;
  }

  try{
    supabaseClient = window.supabase.createClient(appConfig.supabaseUrl, appConfig.supabaseAnonKey);
    setConnectionState("Connecting...", "ok");
    subscribeRealtime();
    await loadRows();
    setConnectionState("Live connected", "ok");
    setSaveState("Ready");
  }catch(err){
    console.error(err);
    setConnectionState("Connection failed", "bad");
    els.setupWarning.classList.remove("hidden");
  }
}

initApp();
