/* Reading Tracker — GitHub Pages-ready
   - Minutes-first (Apple Books friendly)
   - Pages optional (used for estimating minutes remaining)
   - Required minutes/day per book
   - Streak + weekly summary
   - Toast + light haptic/vibration where supported
   - Export/Import JSON
   - Service worker offline caching
*/

const LS_KEY = "readingTrackerData.v1";

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
function round1(n){ return Math.round(n*10)/10; }

function daysBetween(aISO, bISO){
  // whole days between dates (b - a)
  const ms = parseISO(bISO).getTime() - parseISO(aISO).getTime();
  return Math.floor(ms / 86400000);
}

function daysRemaining(finishISO){
  return Math.max(1, daysBetween(todayISO(), finishISO));
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
  const ms = local - start;
  return clamp(Math.floor(ms/86400000) + 1, 0, daysInYear(year));
}

function uid(){
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

/* ---------------- Toast + Haptics ---------------- */

let toastTimer = null;

function hapticSuccess(){
  // iOS Safari often ignores vibration; safe no-op.
  try{
    if (navigator.vibrate) navigator.vibrate([10, 10, 10]);
  }catch(_){}
}

function showToast(msg){
  const t = $("#toast");
  if (!t) return;

  t.textContent = msg;
  t.classList.remove("show");
  void t.offsetWidth;
  t.classList.add("show");

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> t.classList.remove("show"), 1600);
}

/* ---------------- Data load/save ---------------- */

async function fetchDefaultData(){
  try{
    const r = await fetch("./data.json", { cache: "no-store" });
    if (!r.ok) throw new Error("no data.json");
    return await r.json();
  }catch(_){
    return {
      settings: { year: 2026, booksGoal: 52, minutesGoal: 30000, pagesPerHour: 30 },
      books: [],
      logs: []
    };
  }
}

function loadLocal(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  }catch(_){
    return null;
  }
}

function saveLocal(data){
  localStorage.setItem(LS_KEY, JSON.stringify(data));
}

let state = null;

function normalizeState(s){
  s.settings ||= {};
  if (typeof s.settings.year !== "number") s.settings.year = 2026;
  if (typeof s.settings.booksGoal !== "number") s.settings.booksGoal = 52;
  if (typeof s.settings.minutesGoal !== "number") s.settings.minutesGoal = 30000;
  if (typeof s.settings.pagesPerHour !== "number") s.settings.pagesPerHour = 30;

  s.books ||= [];
  s.logs ||= [];

  s.books.forEach(b => {
    if (!b.id) b.id = uid();
    if (b.finished === undefined) b.finished = false;
  });

  s.logs.forEach(l => {
    if (!l.id) l.id = uid();
    if (!l.bookId) l.bookId = "";
    if (!l.pages) l.pages = 0;
    if (!l.minutes) l.minutes = 0;
  });

  return s;
}

/* ---------------- Derived metrics ---------------- */

function logsForBook(bookId){
  return state.logs.filter(l => l.bookId === bookId);
}

function sumMinutes(logs){ return logs.reduce((a,l)=>a + (Number(l.minutes)||0), 0); }
function sumPages(logs){ return logs.reduce((a,l)=>a + (Number(l.pages)||0), 0); }

function bookMinutesRead(bookId){ return sumMinutes(logsForBook(bookId)); }
function bookPagesRead(bookId){ return sumPages(logsForBook(bookId)); }

function bookPagesRemaining(book){
  return Math.max(0, Number(book.totalPages||0) - bookPagesRead(book.id));
}

function estimatedMinutesRemaining(book){
  const pagesLeft = bookPagesRemaining(book);
  const pph = Number(state.settings.pagesPerHour || 30);
  return Math.round((pagesLeft / Math.max(1, pph)) * 60);
}

function minutesPerDayRequired(book){
  return Math.max(0, Math.round(estimatedMinutesRemaining(book) / daysRemaining(book.finishDate)));
}

function bookMinutesStatus(book){
  const minsRead = bookMinutesRead(book.id);
  const startISO = book.startDate || todayISO();
  const elapsed = Math.max(1, daysBetween(startISO, todayISO()) + 1);
  const actualPerDay = Math.round(minsRead / elapsed);
  const required = minutesPerDayRequired(book);

  if (required === 0 && bookPagesRemaining(book) === 0) return "✅ Done";
  if (minsRead <= 0) return "⚪ No data yet";
  return (actualPerDay >= required) ? "🟢 On Track" : "🔴 Behind";
}

function computeYearMetrics(){
  const year = Number(state.settings.year || 2026);
  const planned = state.books.length;
  const finished = state.books.filter(b => b.finished).length;

  const yearLogs = state.logs.filter(l => String(l.date || "").startsWith(String(year)));
  const minutesDone = sumMinutes(yearLogs);

  const minutesGoal = Number(state.settings.minutesGoal || 0);
  const booksGoal = Number(state.settings.booksGoal || 0);

  const elapsed = dayOfYear(year);
  const totalDays = daysInYear(year);
  const minPerDay = elapsed > 0 ? Math.round(minutesDone / elapsed) : 0;

  const booksPct = booksGoal > 0 ? clamp(finished / booksGoal, 0, 1) : 0;
  const minutesPct = minutesGoal > 0 ? clamp(minutesDone / minutesGoal, 0, 1) : 0;

  const minutesPerDayTarget = (minutesGoal > 0 && totalDays > 0) ? Math.round(minutesGoal / totalDays) : 0;
  const onTrackYear = (minutesPerDayTarget === 0) ? "—" : (minPerDay >= minutesPerDayTarget ? "🟢 On Track" : "🔴 Behind");

  return {
    year, planned, finished, minutesDone, minutesGoal, booksGoal,
    elapsed, totalDays, minPerDay, booksPct, minutesPct, minutesPerDayTarget, onTrackYear
  };
}

function readingStreak(){
  const dates = new Set(state.logs.map(l => l.date));
  let streak = 0;
  let d = todayISO();

  while (dates.has(d)) {
    streak++;
    const prev = parseISO(d);
    prev.setDate(prev.getDate() - 1);
    const off = prev.getTimezoneOffset();
    const local = new Date(prev.getTime() - off*60*1000);
    d = local.toISOString().slice(0,10);
  }
  return streak;
}

function minutesThisWeek(){
  const today = parseISO(todayISO());
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 6);

  return state.logs
    .filter(l => {
      const d = parseISO(l.date);
      return d >= weekAgo && d <= today;
    })
    .reduce((a,l)=>a + Number(l.minutes||0), 0);
}

/* ---------------- Rendering ---------------- */

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

  $("#todayBook").innerHTML = `<option value="">— No book selected —</option>${opts}`;
  $("#filterBook").innerHTML = `<option value="">All books</option>${opts}`;
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
  $("#minutesPerDay").textContent = ym.minPerDay;

  $("#barBooks").style.width = `${Math.round(ym.booksPct*100)}%`;
  $("#barMinutes").style.width = `${Math.round(ym.minutesPct*100)}%`;

  $("#yearStatus").textContent =
    ym.onTrackYear === "—"
      ? "Set a minutes goal to enable year pacing."
      : `${ym.onTrackYear} • Target ${ym.minutesPerDayTarget} min/day`;

  $("#streakCount").textContent = readingStreak();
  $("#weekMinutes").textContent = minutesThisWeek();

  const activeBooks = state.books.filter(b => !b.finished).slice();
  const decorated = activeBooks.map(b => {
    const status = bookMinutesStatus(b);
    return {
      ...b,
      status,
      minsReq: minutesPerDayRequired(b),
      minsRead: bookMinutesRead(b.id),
      pagesLeft: bookPagesRemaining(b)
    };
  });

  const behind = decorated.filter(b => b.status === "🔴 Behind");
  const onTrack = decorated.filter(b => b.status === "🟢 On Track");
  $("#countBehind").textContent = behind.length;
  $("#countOnTrack").textContent = onTrack.length;

  $("#attentionList").innerHTML = behind
    .sort((a,b)=>new Date(a.finishDate)-new Date(b.finishDate))
    .slice(0,6)
    .map(b => `
      <div class="item">
        <div class="t">${escapeHtml(b.title)} <span class="badge bad">Behind</span></div>
        <div class="m">Finish ${b.finishDate} • Need ${b.minsReq} min/day • Minutes: ${b.minsRead} • Pages left: ${b.pagesLeft}</div>
      </div>
    `).join("") || `<div class="hint">No fires today. Keep it that way.</div>`;

  $("#currentList").innerHTML = decorated
    .sort((a,b)=>new Date(a.finishDate)-new Date(b.finishDate))
    .slice(0,8)
    .map(b => {
      const badge =
        b.status === "🟢 On Track" ? `<span class="badge good">On Track</span>` :
        b.status === "🔴 Behind" ? `<span class="badge bad">Behind</span>` :
        b.status === "✅ Done" ? `<span class="badge good">Done</span>` :
        `<span class="badge warn">No data</span>`;
      return `
        <div class="item">
          <div class="t">${escapeHtml(b.title)} ${badge}</div>
          <div class="m">Finish ${b.finishDate} • Need ${b.minsReq} min/day • Minutes: ${b.minsRead} • Pages left: ${b.pagesLeft}</div>
        </div>`;
    }).join("") || `<div class="hint">Add a book to start tracking.</div>`;

  $("#recentLogs").innerHTML = state.logs
    .slice()
    .sort((a,b)=> (b.date||"").localeCompare(a.date||""))
    .slice(0,10)
    .map(l => {
      const book = state.books.find(b => b.id === l.bookId);
      const bname = book ? book.title : (l.bookId ? "Unknown book" : "—");
      return `
        <div class="item">
          <div class="t">${l.date} <span class="badge">${escapeHtml(bname)}</span></div>
          <div class="m">${Number(l.minutes||0)} min • ${Number(l.pages||0)} pages</div>
        </div>`;
    }).join("") || `<div class="hint">No logs yet. Add today’s minutes.</div>`;
}

function renderBooksTable(){
  const tbody = $("#booksTable tbody");
  const rows = state.books
    .slice()
    .sort((a,b)=>new Date(a.finishDate)-new Date(b.finishDate))
    .map(b => {
      const pagesLeft = bookPagesRemaining(b);
      const minsReq = minutesPerDayRequired(b);
      const status = bookMinutesStatus(b);
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
          <td>${pagesLeft}</td>
          <td>${minsReq}</td>
          <td>${badge}</td>
          <td>
            <input type="checkbox" data-action="toggle-finished" data-id="${b.id}" ${b.finished ? "checked":""} />
          </td>
          <td>
            <button class="btn danger" data-action="delete-book" data-id="${b.id}" type="button">Delete</button>
          </td>
        </tr>`;
    }).join("");

  tbody.innerHTML = rows || `<tr><td colspan="8" style="color:var(--muted);padding:14px;">No books yet.</td></tr>`;
}

function renderLogTable(filters=null){
  const tbody = $("#logTable tbody");
  let logs = state.logs.slice();

  if(filters){
    if(filters.bookId) logs = logs.filter(l => l.bookId === filters.bookId);
    if(filters.from) logs = logs.filter(l => (l.date||"") >= filters.from);
    if(filters.to) logs = logs.filter(l => (l.date||"") <= filters.to);
  }

  logs.sort((a,b)=> (b.date||"").localeCompare(a.date||""));

  tbody.innerHTML = logs.map(l => {
    const book = state.books.find(b => b.id === l.bookId);
    const bname = book ? book.title : (l.bookId ? "Unknown book" : "—");
    return `
      <tr>
        <td>${l.date || ""}</td>
        <td>${escapeHtml(bname)}</td>
        <td>${Number(l.minutes||0)}</td>
        <td>${Number(l.pages||0)}</td>
        <td><button class="btn danger" data-action="delete-log" data-id="${l.id}" type="button">Delete</button></td>
      </tr>`;
  }).join("") || `<tr><td colspan="5" style="color:var(--muted);padding:14px;">No logs match.</td></tr>`;
}

function renderSettings(){
  $("#setYear").value = state.settings.year ?? 2026;
  $("#setBooksGoal").value = state.settings.booksGoal ?? 52;
  $("#setMinutesGoal").value = state.settings.minutesGoal ?? 30000;
  $("#setSpeed").value = state.settings.pagesPerHour ?? 30;
}

/* ---------------- Modal ---------------- */

function openBookModal(book){
  const pagesRead = bookPagesRead(book.id);
  const minsRead = bookMinutesRead(book.id);
  const pagesLeft = bookPagesRemaining(book);
  const minsLeft = estimatedMinutesRemaining(book);
  const minsReq = minutesPerDayRequired(book);
  const status = bookMinutesStatus(book);

  $("#modalTitle").textContent = book.title;
  $("#modalBody").innerHTML = `
    <div class="item" style="margin-bottom:10px;">
      <div class="t">${escapeHtml(book.title)} <span class="badge">${escapeHtml(status)}</span></div>
      <div class="m">Start: ${book.startDate} • Finish: ${book.finishDate}</div>
    </div>

    <div class="kv">
      <div class="k">Total pages</div><div class="v">${book.totalPages}</div>
      <div class="k">Pages read</div><div class="v">${pagesRead}</div>
      <div class="k">Pages left</div><div class="v">${pagesLeft}</div>
      <div class="k">Minutes read</div><div class="v">${minsRead}</div>
      <div class="k">Est. minutes left</div><div class="v">${minsLeft}</div>
      <div class="k">Required</div><div class="v">${minsReq} min/day</div>
    </div>

    <p class="muted" style="margin-top:10px;">
      Estimates use your pages/hour setting. Log minutes daily; pages are optional.
    </p>
  `;

  const m = $("#bookModal");
  m.classList.add("show");
  m.setAttribute("aria-hidden", "false");
}

function closeBookModal(){
  const m = $("#bookModal");
  m.classList.remove("show");
  m.setAttribute("aria-hidden", "true");
}

/* ---------------- Actions ---------------- */

function addBook({title,totalPages,startDate,finishDate}){
  state.books.push({
    id: uid(),
    title: String(title || "").trim(),
    totalPages: Number(totalPages),
    startDate,
    finishDate,
    finished: false
  });
  saveLocal(state);
  rerenderAll();
  showToast("Book added ✔");
}

function deleteBook(id){
  state.books = state.books.filter(b => b.id !== id);
  state.logs = state.logs.filter(l => l.bookId !== id);
  saveLocal(state);
  rerenderAll();
  showToast("Book deleted");
}

function toggleFinished(id, checked){
  const b = state.books.find(x => x.id === id);
  if(!b) return;
  b.finished = !!checked;
  saveLocal(state);
  rerenderAll();
  showToast(checked ? "Marked finished ✔" : "Marked unfinished");
}

function addLog({date, minutes, pages, bookId}){
  state.logs.push({
    id: uid(),
    date,
    minutes: Number(minutes||0),
    pages: Number(pages||0),
    bookId: bookId || ""
  });
  saveLocal(state);
  rerenderAll();
}

/* ---------------- Export/Import ---------------- */

function downloadJSON(filename, obj){
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- Wiring ---------------- */

function rerenderAll(){
  renderSelectors();
  renderDashboard();
  renderBooksTable();
  renderLogTable();
  renderSettings();
}

function initTabs(){
  $$(".tab").forEach(btn => btn.addEventListener("click", () => setActiveTab(btn.dataset.tab)));
}

function initForms(){
  $("#todayForm").addEventListener("submit", (e)=>{
    e.preventDefault();

    const date = $("#todayDate").value;
    const minutes = $("#todayMinutes").value;
    const pages = $("#todayPages").value;
    const bookId = $("#todayBook").value;

    if(!date) return;
    if(Number(minutes) < 0) return;

    addLog({ date, minutes, pages, bookId });

    $("#todayMinutes").value = "";
    $("#todayPages").value = "";
    $("#todayBook").value = "";

    hapticSuccess();
    showToast("Saved ✔");
  });

  $("#bookForm").addEventListener("submit", (e)=>{
    e.preventDefault();
    addBook({
      title: $("#bookTitle").value,
      totalPages: $("#bookPages").value,
      startDate: $("#bookStart").value,
      finishDate: $("#bookFinish").value
    });
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
    rerenderAll();
    showToast("Settings saved ✔");
  });

  // Keyboard shortcut: press "L" to jump to Minutes
  document.addEventListener("keydown", (e)=>{
    if (e.target && ["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName)) return;
    if (e.key.toLowerCase() === "l"){
      setActiveTab("dashboard");
      $("#todayMinutes").focus();
    }
    if (e.key === "Escape"){
      closeBookModal();
    }
  });
}

function initTables(){
  $("#booksTable").addEventListener("click", (e)=>{
    const link = e.target.closest(".book-link");
    if (link){
      const b = state.books.find(x => x.id === link.dataset.id);
      if (b) openBookModal(b);
      return;
    }

    const btn = e.target.closest("button");
    if(!btn) return;

    if(btn.dataset.action === "delete-book"){
      deleteBook(btn.dataset.id);
    }
  });

  $("#booksTable").addEventListener("change", (e)=>{
    const cb = e.target.closest("input[type=checkbox]");
    if(!cb) return;
    if(cb.dataset.action === "toggle-finished"){
      toggleFinished(cb.dataset.id, cb.checked);
    }
  });

  $("#logTable").addEventListener("click", (e)=>{
    const btn = e.target.closest("button");
    if(!btn) return;

    if(btn.dataset.action === "delete-log"){
      state.logs = state.logs.filter(l => l.id !== btn.dataset.id);
      saveLocal(state);
      rerenderAll();
      showToast("Log deleted");
    }
  });
}

function initLogFilters(){
  $("#btnApplyFilters").addEventListener("click", ()=>{
    renderLogTable({
      bookId: $("#filterBook").value,
      from: $("#filterFrom").value,
      to: $("#filterTo").value
    });
  });

  $("#btnClearFilters").addEventListener("click", ()=>{
    $("#filterBook").value = "";
    $("#filterFrom").value = "";
    $("#filterTo").value = "";
    renderLogTable();
  });
}

function initDataTools(){
  $("#btnExport").addEventListener("click", ()=>{
    downloadJSON("data.json", state);
  });

  $("#fileImport").addEventListener("change", async (e)=>{
    const f = e.target.files && e.target.files[0];
    if(!f) return;

    const text = await f.text();
    try{
      const obj = JSON.parse(text);
      state = normalizeState(obj);
      saveLocal(state);
      rerenderAll();
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

function initModal(){
  $("#closeModal").addEventListener("click", closeBookModal);
  $("#bookModal").addEventListener("click", (e)=>{
    if (e.target && e.target.id === "bookModal") closeBookModal();
  });
}

/* ---------------- Service Worker ---------------- */

function initServiceWorker(){
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
}

/* ---------------- Boot ---------------- */

(async function boot(){
  initTabs();
  initForms();
  initTables();
  initLogFilters();
  initDataTools();
  initModal();
  initServiceWorker();

  $("#todayDate").value = todayISO();

  // local first; else use repo data.json
  const local = loadLocal();
  const base = local ? local : await fetchDefaultData();
  state = normalizeState(base);

  // Persist to local so app stays fast/offline
  saveLocal(state);

  rerenderAll();
})();
