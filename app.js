const LS_KEY = "readingTrackerData.v2_1";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function todayISO(){
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off*60*1000);
  return local.toISOString().slice(0,10);
}
function parseISO(s){
  const [y,m,d] = String(s).split("-").map(Number);
  return new Date(y, m-1, d);
}
function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
function uid(){ return Math.random().toString(16).slice(2) + Date.now().toString(16); }
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}
function daysInYear(year){
  const a = new Date(year,0,1);
  const b = new Date(year+1,0,1);
  return Math.round((b-a)/86400000);
}
function dayOfYear(year){
  const start = new Date(year,0,1);
  const now = new Date();
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (local < start) return 0;
  return clamp(Math.floor((local-start)/86400000) + 1, 0, daysInYear(year));
}
function daysRemaining(finishISO){
  const ms = parseISO(finishISO).getTime() - parseISO(todayISO()).getTime();
  return Math.max(1, Math.floor(ms/86400000));
}

/* Toast + Haptics */
let toastTimer = null;
function hapticSuccess(){ try{ if(navigator.vibrate) navigator.vibrate([10,10,10]); }catch(_){} }
function showToast(msg){
  const t = $("#toast");
  if(!t) return;
  t.textContent = msg;
  t.classList.remove("show");
  void t.offsetWidth;
  t.classList.add("show");
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove("show"), 1600);
}

/* Data */
async function fetchDefaultData(){
  try{
    const r = await fetch("./data.json", { cache:"no-store" });
    if(!r.ok) throw new Error("no data.json");
    return await r.json();
  }catch(_){
    return {
      settings: { year: 2026, booksGoal: 52, minutesGoal: 30000, pagesPerHour: 30 },
      books: [],
      dailyMinutes: [],
      progress: []
    };
  }
}
function loadLocal(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(_){ return null; }
}
function saveLocal(data){ localStorage.setItem(LS_KEY, JSON.stringify(data)); }

let state = null;

function normalizeState(s){
  s.settings ||= {};
  if(typeof s.settings.year !== "number") s.settings.year = 2026;
  if(typeof s.settings.booksGoal !== "number") s.settings.booksGoal = 52;
  if(typeof s.settings.minutesGoal !== "number") s.settings.minutesGoal = 30000;
  if(typeof s.settings.pagesPerHour !== "number") s.settings.pagesPerHour = 30;

  s.books ||= [];
  s.dailyMinutes ||= [];
  s.progress ||= [];

  s.books.forEach(b => {
    if(!b.id) b.id = uid();
    if(b.finished === undefined) b.finished = false;
    if(b.currentlyReading === undefined) b.currentlyReading = true; // default ON for new books
  });

  s.dailyMinutes.forEach(x => { if(!x.id) x.id = uid(); });
  s.progress.forEach(x => { if(!x.id) x.id = uid(); });

  return s;
}

/* Derived helpers */
function minutesForYear(year){
  return state.dailyMinutes
    .filter(x => String(x.date||"").startsWith(String(year)))
    .reduce((a,x)=>a + Number(x.minutes||0), 0);
}

function readingStreak(){
  const dates = new Set(state.dailyMinutes.filter(x => Number(x.minutes||0) > 0).map(x => x.date));
  let streak = 0;
  let d = todayISO();
  while(dates.has(d)){
    streak++;
    const prev = parseISO(d);
    prev.setDate(prev.getDate()-1);
    const off = prev.getTimezoneOffset();
    const local = new Date(prev.getTime() - off*60*1000);
    d = local.toISOString().slice(0,10);
  }
  return streak;
}

function minutesThisWeek(){
  const t = parseISO(todayISO());
  const weekAgo = new Date(t); weekAgo.setDate(t.getDate()-6);
  return state.dailyMinutes
    .filter(x => {
      const d = parseISO(x.date);
      return d >= weekAgo && d <= t;
    })
    .reduce((a,x)=>a + Number(x.minutes||0), 0);
}

function latestProgress(bookId){
  const entries = state.progress
    .filter(p => p.bookId === bookId)
    .slice()
    .sort((a,b)=> (b.date||"").localeCompare(a.date||""));
  return entries[0] || null;
}

function currentPage(book){
  const lp = latestProgress(book.id);
  return lp ? Number(lp.currentPage||0) : 0;
}

function pagesLeft(book){
  return Math.max(0, Number(book.totalPages||0) - currentPage(book));
}

function estMinutesLeft(book){
  const pph = Number(state.settings.pagesPerHour || 30);
  return Math.round((pagesLeft(book) / Math.max(1, pph)) * 60);
}

function minPerDayRequired(book){
  return Math.max(0, Math.round(estMinutesLeft(book) / daysRemaining(book.finishDate)));
}

/* Currently reading filtering */
function unfinishedBooks(){
  return state.books.filter(b => !b.finished);
}
function currentlyReadingBooks(){
  const list = state.books.filter(b => !b.finished && b.currentlyReading);
  return list.length ? list : unfinishedBooks(); // fallback to all unfinished if none selected
}

/* Allocation logic:
   Allocate your avg minutes/day across CURRENTLY READING books,
   proportional to each book’s required minutes/day.
*/
function allocationWeight(book){
  return Math.max(1, minPerDayRequired(book));
}

function allocatedMinutesPerDayAverage(book){
  const year = Number(state.settings.year || 2026);
  const elapsed = Math.max(1, dayOfYear(year));
  const totalMin = minutesForYear(year);
  const avgPerDay = totalMin / elapsed;

  const books = currentlyReadingBooks();
  const totalWeight = books.reduce((a,b)=>a + allocationWeight(b), 0) || 1;

  return avgPerDay * (allocationWeight(book) / totalWeight);
}

function bookStatus(book){
  if (pagesLeft(book) === 0 && currentPage(book) > 0) return "✅ Done";
  const req = minPerDayRequired(book);
  if (req === 0) return "⚪ Needs finish date";
  const alloc = allocatedMinutesPerDayAverage(book);
  return (alloc >= req) ? "🟢 On Track" : "🔴 Behind";
}

/* Render */
function setActiveTab(name){
  $$(".tab").forEach(b => b.classList.toggle("is-active", b.dataset.tab === name));
  $$(".panel").forEach(p => p.classList.toggle("is-active", p.id === `panel-${name}`));
}

function renderSelectors(){
  const opts = state.books
    .slice()
    .sort((a,b)=>a.title.localeCompare(b.title))
    .map(b => `<option value="${b.id}">${escapeHtml(b.title)}</option>`)
    .join("");
  $("#progressBook").innerHTML = `<option value="">— Select a book —</option>${opts}`;
}

function computeYearMetrics(){
  const year = Number(state.settings.year || 2026);
  const planned = state.books.length;
  const finished = state.books.filter(b => b.finished).length;
  const minutesDone = minutesForYear(year);
  const minutesGoal = Number(state.settings.minutesGoal || 0);
  const booksGoal = Number(state.settings.booksGoal || 0);
  const elapsed = Math.max(1, dayOfYear(year));
  const totalDays = daysInYear(year);
  const avgMinDay = Math.round(minutesDone / elapsed);

  const minutesPerDayTarget = minutesGoal > 0 ? Math.round(minutesGoal / totalDays) : 0;
  const onTrackYear = minutesPerDayTarget === 0 ? "—" : (avgMinDay >= minutesPerDayTarget ? "🟢 On Track" : "🔴 Behind");

  return { year, planned, finished, minutesDone, minutesGoal, booksGoal, elapsed, totalDays, avgMinDay, minutesPerDayTarget, onTrackYear };
}

function renderDashboard(){
  const ym = computeYearMetrics();

  $("#yearLabel").textContent = ym.year;
  $("#booksGoal").textContent = ym.booksGoal;
  $("#minutesGoal").textContent = Number(ym.minutesGoal).toLocaleString();
  $("#speedLabel").textContent = `${state.settings.pagesPerHour} p/h`;
  $("#daysElapsed").textContent = ym.elapsed;
  $("#daysInYear").textContent = ym.totalDays;

  $("#booksDone").textContent = ym.finished;
  $("#booksPlanned").textContent = ym.planned;
  $("#minutesDone").textContent = Number(ym.minutesDone).toLocaleString();
  $("#minutesPerDay").textContent = ym.avgMinDay;

  const booksPct = ym.booksGoal > 0 ? clamp(ym.finished / ym.booksGoal, 0, 1) : 0;
  const minutesPct = ym.minutesGoal > 0 ? clamp(ym.minutesDone / ym.minutesGoal, 0, 1) : 0;
  $("#barBooks").style.width = `${Math.round(booksPct*100)}%`;
  $("#barMinutes").style.width = `${Math.round(minutesPct*100)}%`;

  $("#yearStatus").textContent =
    ym.onTrackYear === "—"
      ? "Set a minutes goal to enable year pacing."
      : `${ym.onTrackYear} • Target ${ym.minutesPerDayTarget} min/day`;

  $("#streakCount").textContent = readingStreak();
  $("#weekMinutes").textContent = minutesThisWeek();

  const decorated = currentlyReadingBooks().map(b => ({
    ...b,
    cur: currentPage(b),
    left: pagesLeft(b),
    req: minPerDayRequired(b),
    status: bookStatus(b)
  }));

  $("#currentList").innerHTML = decorated
    .sort((a,b)=>new Date(a.finishDate)-new Date(b.finishDate))
    .slice(0,10)
    .map(b => {
      const badge =
        b.status === "🟢 On Track" ? `<span class="badge good">On Track</span>` :
        b.status === "🔴 Behind" ? `<span class="badge bad">Behind</span>` :
        b.status === "✅ Done" ? `<span class="badge good">Done</span>` :
        `<span class="badge warn">No data</span>`;
      return `
        <div class="item">
          <div class="t">${escapeHtml(b.title)} ${badge}</div>
          <div class="m">Page ${b.cur}/${b.totalPages} • Left ${b.left} • Need ${b.req} min/day • Finish ${b.finishDate}</div>
        </div>`;
    }).join("") || `<div class="hint">Add books to start tracking.</div>`;

  const activity = [];
  state.dailyMinutes.slice().sort((a,b)=> (b.date||"").localeCompare(a.date||"")).slice(0,6)
    .forEach(x => activity.push({ t:`${x.date}`, m:`${Number(x.minutes||0)} minutes (daily total)` }));

  state.progress.slice().sort((a,b)=> (b.date||"").localeCompare(a.date||"")).slice(0,6)
    .forEach(x => {
      const book = state.books.find(b=>b.id===x.bookId);
      activity.push({ t:`${x.date}`, m:`${book?book.title:"Unknown"} → page ${x.currentPage}` });
    });

  activity.sort((a,b)=> b.t.localeCompare(a.t));

  $("#recentActivity").innerHTML = activity.slice(0,10).map(a => `
    <div class="item">
      <div class="t">${escapeHtml(a.t)}</div>
      <div class="m">${escapeHtml(a.m)}</div>
    </div>
  `).join("") || `<div class="hint">No activity yet.</div>`;
}

function renderBooksTable(){
  const tbody = $("#booksTable tbody");
  tbody.innerHTML = state.books
    .slice()
    .sort((a,b)=>new Date(a.finishDate)-new Date(b.finishDate))
    .map(b => {
      const cur = currentPage(b);
      const left = pagesLeft(b);
      const req = minPerDayRequired(b);
      const status = bookStatus(b);
      const badge =
        status === "🟢 On Track" ? `<span class="badge good">On</span>` :
        status === "🔴 Behind" ? `<span class="badge bad">Behind</span>` :
        status === "✅ Done" ? `<span class="badge good">Done</span>` :
        `<span class="badge warn">No data</span>`;

      return `
        <tr>
          <td><strong class="book-link" data-id="${b.id}">${escapeHtml(b.title)}</strong></td>
          <td>${b.finishDate}</td>
          <td>${b.totalPages}</td>
          <td>${cur}</td>
          <td>${left}</td>
          <td>${req}</td>
          <td>${badge}</td>
          <td><input type="checkbox" data-action="toggle-reading" data-id="${b.id}" ${b.currentlyReading?"checked":""} /></td>
          <td><input type="checkbox" data-action="toggle-finished" data-id="${b.id}" ${b.finished?"checked":""} /></td>
          <td><button class="btn danger" data-action="delete-book" data-id="${b.id}" type="button">Delete</button></td>
        </tr>`;
    }).join("") || `<tr><td colspan="10" style="color:var(--muted);padding:14px;">No books yet.</td></tr>`;
}

function renderLogs(){
  const mt = $("#minutesTable tbody");
  mt.innerHTML = state.dailyMinutes
    .slice()
    .sort((a,b)=> (b.date||"").localeCompare(a.date||""))
    .map(x => `
      <tr>
        <td>${x.date}</td>
        <td>${Number(x.minutes||0)}</td>
        <td><button class="btn danger" data-action="delete-minutes" data-id="${x.id}" type="button">Delete</button></td>
      </tr>
    `).join("") || `<tr><td colspan="3" style="color:var(--muted);padding:14px;">No entries.</td></tr>`;

  const pt = $("#progressTable tbody");
  pt.innerHTML = state.progress
    .slice()
    .sort((a,b)=> (b.date||"").localeCompare(a.date||""))
    .map(x => {
      const book = state.books.find(b=>b.id===x.bookId);
      return `
        <tr>
          <td>${x.date}</td>
          <td>${escapeHtml(book?book.title:"Unknown")}</td>
          <td>${Number(x.currentPage||0)}</td>
          <td><button class="btn danger" data-action="delete-progress" data-id="${x.id}" type="button">Delete</button></td>
        </tr>`;
    }).join("") || `<tr><td colspan="4" style="color:var(--muted);padding:14px;">No updates.</td></tr>`;
}

function renderSettings(){
  $("#setYear").value = state.settings.year ?? 2026;
  $("#setBooksGoal").value = state.settings.booksGoal ?? 52;
  $("#setMinutesGoal").value = state.settings.minutesGoal ?? 30000;
  $("#setSpeed").value = state.settings.pagesPerHour ?? 30;
}

/* Modal */
function openBookModal(book){
  const cur = currentPage(book);
  const left = pagesLeft(book);
  const minsLeft = estMinutesLeft(book);
  const req = minPerDayRequired(book);
  const status = bookStatus(book);

  $("#modalTitle").textContent = book.title;
  $("#modalBody").innerHTML = `
    <div class="item">
      <div class="t">${escapeHtml(book.title)} <span class="badge">${escapeHtml(status)}</span></div>
      <div class="m">Start ${book.startDate} • Finish ${book.finishDate}</div>
    </div>
    <div class="kv" style="margin-top:10px;">
      <div class="k">Currently reading</div><div class="v">${book.currentlyReading ? "Yes" : "No"}</div>
      <div class="k">Current page</div><div class="v">${cur}</div>
      <div class="k">Total pages</div><div class="v">${book.totalPages}</div>
      <div class="k">Pages left</div><div class="v">${left}</div>
      <div class="k">Est. minutes left</div><div class="v">${minsLeft}</div>
      <div class="k">Required</div><div class="v">${req} min/day</div>
    </div>
  `;
  $("#bookModal").classList.add("show");
}
function closeBookModal(){ $("#bookModal").classList.remove("show"); }

/* Actions */
function saveMinutes(date, minutes){
  const existing = state.dailyMinutes.find(x => x.date === date);
  if (existing) existing.minutes = Number(minutes||0);
  else state.dailyMinutes.push({ id: uid(), date, minutes: Number(minutes||0) });

  saveLocal(state);
  renderAll();
  hapticSuccess();
  showToast("Minutes saved ✔");
}

function saveProgress(date, bookId, currentPageVal){
  state.progress.push({ id: uid(), date, bookId, currentPage: Number(currentPageVal||0) });
  saveLocal(state);
  renderAll();
  hapticSuccess();
  showToast("Progress saved ✔");
}

function addBook(title, totalPages, startDate, finishDate){
  state.books.push({
    id: uid(),
    title: String(title).trim(),
    totalPages: Number(totalPages),
    startDate,
    finishDate,
    finished:false,
    currentlyReading:true
  });
  saveLocal(state);
  renderAll();
  showToast("Book added ✔");
}

function deleteBook(id){
  state.books = state.books.filter(b=>b.id!==id);
  state.progress = state.progress.filter(p=>p.bookId!==id);
  saveLocal(state);
  renderAll();
  showToast("Book deleted");
}

function toggleFinished(id, checked){
  const b = state.books.find(x=>x.id===id);
  if(!b) return;
  b.finished = !!checked;
  if (b.finished) b.currentlyReading = false; // auto-disable reading when finished
  saveLocal(state);
  renderAll();
  showToast(checked ? "Marked finished ✔" : "Marked unfinished");
}

function toggleReading(id, checked){
  const b = state.books.find(x=>x.id===id);
  if(!b) return;
  b.currentlyReading = !!checked;
  if (b.currentlyReading) b.finished = false; // if you mark reading, it can’t be finished
  saveLocal(state);
  renderAll();
  showToast(checked ? "Now reading ✔" : "Not currently reading");
}

function deleteMinutes(id){
  state.dailyMinutes = state.dailyMinutes.filter(x=>x.id!==id);
  saveLocal(state);
  renderAll();
  showToast("Deleted");
}

function deleteProgress(id){
  state.progress = state.progress.filter(x=>x.id!==id);
  saveLocal(state);
  renderAll();
  showToast("Deleted");
}

/* Export/Import */
function downloadJSON(filename, obj){
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* Render all */
function renderAll(){
  renderSelectors();
  renderDashboard();
  renderBooksTable();
  renderLogs();
  renderSettings();
}

/* Wire */
function initTabs(){
  $$(".tab").forEach(btn => btn.addEventListener("click", ()=> setActiveTab(btn.dataset.tab)));
}

function initForms(){
  $("#minutesForm").addEventListener("submit", (e)=>{
    e.preventDefault();
    saveMinutes($("#minutesDate").value, $("#minutesTotal").value);
    $("#minutesTotal").value = "";
  });

  $("#progressForm").addEventListener("submit", (e)=>{
    e.preventDefault();
    saveProgress($("#progressDate").value, $("#progressBook").value, $("#progressPage").value);
    $("#progressPage").value = "";
    $("#progressBook").value = "";
  });

  $("#bookForm").addEventListener("submit", (e)=>{
    e.preventDefault();
    addBook($("#bookTitle").value, $("#bookPages").value, $("#bookStart").value, $("#bookFinish").value);
    $("#bookTitle").value = "";
    $("#bookPages").value = "";
  });

  $("#settingsForm").addEventListener("submit", (e)=>{
    e.preventDefault();
    state.settings.year = Number($("#setYear").value);
    state.settings.booksGoal = Number($("#setBooksGoal").value);
    state.settings.minutesGoal = Number($("#setMinutesGoal").value);
    state.settings.pagesPerHour = Number($("#setSpeed").value || 30);
    saveLocal(state);
    renderAll();
    showToast("Settings saved ✔");
  });

  document.addEventListener("keydown", (e)=>{
    if (e.target && ["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName)) return;
    if (e.key.toLowerCase()==="l"){ setActiveTab("dashboard"); $("#minutesTotal").focus(); }
    if (e.key==="Escape"){ closeBookModal(); }
  });
}

function initTables(){
  $("#booksTable").addEventListener("click", (e)=>{
    const link = e.target.closest(".book-link");
    if (link){
      const b = state.books.find(x=>x.id===link.dataset.id);
      if (b) openBookModal(b);
      return;
    }
    const btn = e.target.closest("button");
    if(!btn) return;
    if(btn.dataset.action==="delete-book") deleteBook(btn.dataset.id);
  });

  $("#booksTable").addEventListener("change", (e)=>{
    const cb = e.target.closest("input[type=checkbox]");
    if(!cb) return;

    if(cb.dataset.action==="toggle-finished") toggleFinished(cb.dataset.id, cb.checked);
    if(cb.dataset.action==="toggle-reading") toggleReading(cb.dataset.id, cb.checked);
  });

  $("#minutesTable").addEventListener("click", (e)=>{
    const btn = e.target.closest("button");
    if(!btn) return;
    if(btn.dataset.action==="delete-minutes") deleteMinutes(btn.dataset.id);
  });

  $("#progressTable").addEventListener("click", (e)=>{
    const btn = e.target.closest("button");
    if(!btn) return;
    if(btn.dataset.action==="delete-progress") deleteProgress(btn.dataset.id);
  });
}

function initModal(){
  $("#closeModal").addEventListener("click", closeBookModal);
  $("#bookModal").addEventListener("click", (e)=>{ if(e.target && e.target.id==="bookModal") closeBookModal(); });
}

function initDataTools(){
  $("#btnExport").addEventListener("click", ()=> downloadJSON("data.json", state));

  $("#fileImport").addEventListener("change", async (e)=>{
    const f = e.target.files && e.target.files[0];
    if(!f) return;
    try{
      state = normalizeState(JSON.parse(await f.text()));
      saveLocal(state);
      renderAll();
      showToast("Imported ✔");
    }catch(_){
      showToast("Import failed");
    }finally{
      e.target.value = "";
    }
  });

  $("#btnReset").addEventListener("click", ()=>{
    if(!confirm("Reset local data? This cannot be undone.")) return;
    localStorage.removeItem(LS_KEY);
    location.reload();
  });
}

function initServiceWorker(){
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
}

/* Boot */
(async function boot(){
  initTabs();
  initForms();
  initTables();
  initModal();
  initDataTools();
  initServiceWorker();

  $("#minutesDate").value = todayISO();
  $("#progressDate").value = todayISO();

  const local = loadLocal();
  const base = local ? local : await fetchDefaultData();
  state = normalizeState(base);
  saveLocal(state);
  renderAll();
})();
