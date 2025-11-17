/* ===== BOOTSTRAP CONVENZIONI (una sola volta, in alto) ================== */
(function bootstrap(){
  const g = window;

  // LocalStorage helpers (idempotenti)
  g.lsGet = g.lsGet || function(k, d){ try{ const r = localStorage.getItem(k); return r ? JSON.parse(r) : d; } catch { return d; } };
  g.lsSet = g.lsSet || function(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); g.__anima_dirty = true; } catch {} };

  window.faseLabel = window.faseLabel || function(commessa, idx){
  try{
    const i = Number(idx|0);
    const f = commessa && Array.isArray(commessa.fasi) ? commessa.fasi[i] : null;
    return (f && f.lav) ? f.lav : `Fase ${i+1}`;
  }catch{ return `Fase ${Number(idx|0)+1}`; }
};

// === ID progressivi generici (DDT, FATT, OF, ecc.) ===
// Usage: const idObj = await window.nextIdFor({ prefix:'DDT', storageKey:'ddtRows', seriesKey:'DDT', width:3 });
window.nextIdFor = window.nextIdFor || async function nextIdFor({
  prefix,                 // es. 'DDT', 'FATT', 'OF'
  storageKey,             // es. 'ddtRows', 'fattureRows', 'ordiniFornitoriRows'
  seriesKey = prefix,     // chiave nei counters/appSettings (di solito = prefix)
  width = 3               // OF-YYYY-NNN → 3; se vuoi 4, metti 4
} = {}) {
  const y   = new Date().getFullYear();
  const pad = n => String(n).padStart(width, '0');

  // 1) LS
  const lsGet = window.lsGet || ((k,d)=>{ try{const v=JSON.parse(localStorage.getItem(k)); return (v??d);}catch{return d;} });
  const lsArr = lsGet(storageKey, []) || [];

  // 2) Server (best effort)
  let svArr = [];
  try { if (window.api?.kv?.get) svArr = await window.api.kv.get(storageKey) || []; } catch {}

  // 3) stato in RAM (se esiste una vista con rows nello scope globale)
  const stArr = Array.isArray(window.__rowsMap?.[storageKey]) ? window.__rowsMap[storageKey] : [];

  // 4) scansiona tutti
  const all = [...lsArr, ...svArr, ...stArr];
  let maxN = 0;
  for (const r of all) {
    const m = String(r?.id || '').match(new RegExp(`^${prefix}-(\\d{4})-(\\d{${width}})$`));
    if (m && Number(m[1])===y) {
      const n = Number(m[2]); if (n>maxN) maxN=n;
    }
  }

  // 5) Impostazioni → “ULTIMO numero emesso”
  try {
    const cfg   = lsGet('appSettings', {}) || {};
    const byYr  = cfg?.numerazioni?.[seriesKey]?.[String(y)]?.ultimo;
    const flat  = cfg?.numerazioni?.[seriesKey]?.ultimo ?? cfg?.numeratori?.[seriesKey]?.ultimo;
    const legacy= cfg?.[`${seriesKey}_last`] ?? cfg?.[`ultimo${seriesKey}`];
    const ultimo= Number(byYr ?? flat ?? legacy ?? 0) || 0;
    if (ultimo > maxN) maxN = ultimo;
  } catch {}

  // 6) Counters (sincronizza e incrementa)
  try {
    const counters = JSON.parse(localStorage.getItem('counters') || '{}') || {};
    const cur = counters[seriesKey] || { year: y, num: maxN };
    if (cur.year !== y) { cur.year = y; cur.num = maxN; }
    if (cur.num < maxN) cur.num = maxN;
    cur.num += 1;
    counters[seriesKey] = cur;
    localStorage.setItem('counters', JSON.stringify(counters));
    return { id: `${prefix}-${y}-${pad(cur.num)}`, year: y, num: cur.num };
  } catch {
    const n = maxN + 1;
    return { id: `${prefix}-${y}-${pad(n)}`, year: y, num: n };
  }
};

// ============== PDF UTILS (lazy, no build) ==============
window.loadPdfLib = window.loadPdfLib || async function(){
  if (window.__pdfjs) return window.__pdfjs;
  const ver = '4.10.38';
  const lib = await import(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${ver}/build/pdf.min.mjs`);
  lib.GlobalWorkerOptions.workerSrc =
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${ver}/build/pdf.worker.min.mjs`;
  window.__pdfjs = lib;
  return lib;
};

window.extractPdfText = window.extractPdfText || async function(file){
  const pdfjs = await window.loadPdfLib();
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  let out = '';
  for (let p = 1; p <= doc.numPages; p++){
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    out += tc.items.map(i => i.str).join('\n') + '\n';
  }
  return out;
};

// parse dd/mm/yy, dd-mm-yy, dd.mm.yy → ISO yyyy-mm-dd (assume 20xx se yy<70)
window.parseITDate = window.parseITDate || function(s){
  const m = String(s||'').match(/(\d{1,2})[\.\/\-](\d{1,2})[\.\/\-](\d{2,4})/);
  if (!m) return '';
  let [_, d, M, y] = m; d=+d; M=+M; y=+y; if (y<100) y+=2000;
  const iso = `${y}-${String(M).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return isNaN(Date.parse(iso)) ? '' : iso;
};

window.parseITNumber = window.parseITNumber || function(s){
  if (s==null) return 0;
  const t = String(s).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(t);
  return isFinite(n) ? n : 0;
};

// ============== ORDER PARSER (testo PDF → oggetto commessa) ==============
window.parseOrderText = window.parseOrderText || function(rawText, filename=''){
  const text = String(rawText || '').replace(/[ \t]+\n/g, '\n').replace(/\s+/g,' ').trim();

   // 1) Cliente (preferisci “SPETT.LE …” o blocchi con P.IVA)
let cliente = '';
const rxCliente1 = /(SPETT\.LE|Spett\.le|Destinatario|Cliente|Ragione\s+Sociale)\s*[: ]*\s*([A-Z0-9&\/\.\-' ]{3,}?(?:\bS\.?R\.?L\.?\b|\bS\.?P\.?A\.?\b|\bSAS\b|\bSNC\b))/i;
const mC1 = text.match(rxCliente1);
if (mC1) cliente = mC1[2].replace(/\s{2,}/g,' ').trim();

// Fallback minimal: niente ANIMA qui
if (!cliente) {
  const rxCliente2 = /(VIMEK BAKERY AUTOMATION SRL|BREMBO|CATERPILLAR)/i;
  const mC2 = text.match(rxCliente2);
  if (mC2) cliente = mC2[1].toUpperCase();
}

// Se per errore è uscita ANIMA, riprova su “Cliente/Destinatario”
if (/^ANIMA\b/i.test(cliente)) {
  const mAlt = text.match(/(?:Cliente|Destinatario|Ragione\s+Sociale)\s*[: ]*([A-Z0-9&\/\.\-' ]{3,})/i);
  if (mAlt) cliente = mAlt[1].replace(/\s{2,}/g,' ').trim();
}

  // 2) Numero e data ordine (fallback: dal filename “...DEL_14.10.25”)
  let dataOrdine = '';
  const rxDataOrd = /(DATA\s+(?:DOCUMENTO|ORDINE)\s*[: ]*|DEL\s+)(\d{1,2}[\.\/\-]\d{1,2}[\.\/\-]\d{2,4})/i;
  const mDO = text.match(rxDataOrd);
  if (mDO) dataOrdine = window.parseITDate(mDO[2]);
  if (!dataOrdine){
    const mFN = String(filename).match(/DEL[_\-\s]?(\d{1,2}[.\-]\d{1,2}[.\-]\d{2,4})/i);
    if (mFN) dataOrdine = window.parseITDate(mFN[1]);
  }

  // 3) Data prevista consegna (globale o per riga; prendi la più “tarda” nel testo)
  let dataCons = '';
  const allDates = [];
  text.replace(/(\d{1,2}[\.\/\-]\d{1,2}[\.\/\-]\d{2,4})/g, (_,d)=>{ allDates.push(window.parseITDate(d)); });
  // euristica: scegli la massima futura/ragionevole come consegna
  const valids = allDates.filter(Boolean).map(d => new Date(d).getTime());
  if (valids.length){
    const max = Math.max.apply(null, valids);
    dataCons = new Date(max).toISOString().slice(0,10);
  }

  // 4) Quantità totale pezzi (somma “PZ NNN” o “qt NNN”)
  let qtaTot = 0;
  const rxPZ = /(PZ|pz|Qt\.?|qt)\s*([0-9\.\,]+)/g;
  let m; while ((m = rxPZ.exec(text))) qtaTot += window.parseITNumber(m[2]);
  if (!qtaTot) qtaTot = 1;

  // 5) Descrizione sintetica (prendi “Fornitura …” oppure prima riga articolo)
  let descr = '';
  const mForn = text.match(/Fornitura\s+([A-Za-z0-9_\-\/\.\,\s]{6,})/i);
  if (mForn) descr = ('Fornitura ' + mForn[1]).trim();
  if (!descr){
    const mArt = text.match(/^[A-Z0-9][A-Z0-9\-\_\.]{2,}\s+(.{8,80}?)\s+(?:PZ|qt)\b/i);
    if (mArt) descr = mArt[1].trim();
  }
  if (!descr) descr = 'Commessa da ordine PDF';

  // 6) Genera ID commessa (C-YYYY-NNN) senza chiedere all’utente
  function nextCommessaId(){
    try{
      if (window.nextIdUnique) return window.nextIdUnique('commesse','C','commesseRows').id;
      const year = new Date().getFullYear();
      const counters = (window.lsGet && window.lsGet('counters', {})) || {};
      const key = `C:${year}`;
      const num = (Number(counters[key]||0) + 1);
      counters[key] = num;
      if (window.lsSet) window.lsSet('counters', counters); else localStorage.setItem('counters', JSON.stringify(counters));
      return `C-${year}-${String(num).padStart(3,'0')}`;
    }catch{ return `C-${new Date().getFullYear()}-${String(Math.floor(Math.random()*999)).padStart(3,'0')}`; }
  }

window.getNextCommessaId = window.getNextCommessaId || window.nextCommessaId;

  const commessa = {
    id: nextCommessaId(),
    cliente: cliente || '',
    descrizione: descr,
    qtaPezzi: Math.max(1, Math.round(qtaTot)),
    qtaProdotta: 0,
    scadenza: dataCons || '',
    dataOrdine: dataOrdine || '',
    priorita: '',
    fasi: Array.isArray(window.defaultFasi) ? window.defaultFasi.slice() : [
      { lav: 'Taglio', qtaPrevista: 0, qtaProdotta: 0 },
      { lav: 'Saldatura', qtaPrevista: 0, qtaProdotta: 0 },
      { lav: 'Verniciatura', qtaPrevista: 0, qtaProdotta: 0 }
    ],
    materiali: []
  };

  return commessa;
};

// === HELPERS PER REPORT/TIMBRATURE (retro-compat, idempotenti) ===
window.safeArr = window.safeArr || (x => Array.isArray(x) ? x : (x ? [x] : []));
window.numVal  = window.numVal  || (x => { const n = Number(x); return Number.isFinite(n) ? n : 0; });
window.toMinCompat = window.toMinCompat || (v => {
  if (v == null) return 0;
  const t = String(v).trim();
  const m = t.match(/^(\d{1,4})(?::([0-5]?\d))?$/);
  if (m) { const h = +m[1]||0, mm = +m[2]||0; return h*60+mm; }
  const n = Number(t);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
});
window.matchFase = window.matchFase || function(o, idx, label){
  if (!o) return false;
  const sameIdx   = Number(o.faseIdx) === Number(idx);
  const sameLabel = o.fase && String(o.fase).toLowerCase() === String(label||'').toLowerCase();
  return sameIdx || sameLabel;
};

// Stampa etichette centrale (non rimuove la tua funzione se già esiste)
window.triggerEtichetteFor = window.triggerEtichetteFor || function(commessa, opts = {}){
  try{
    const defaultColli = Math.max(1, Number(opts.colli || 1));
    const colli = Number(prompt('Numero colli da etichettare?', String(defaultColli))) || defaultColli;
    if (typeof window._maybeAutoScaricoAndLabels === 'function') {
      window._maybeAutoScaricoAndLabels(commessa.id, { colli });
    } else {
      alert('Funzione etichette non configurata (_maybeAutoScaricoAndLabels)');
    }
  }catch(e){ console.warn('triggerEtichetteFor:', e); }
};

// ---- AppSettings defaults (AUTO su ogni device) ----
// Metti questo SUBITO dopo lsGet/lsSet, dentro l'IIFE principale.
(function ensureAppDefaults(){
  try {
    const cur = JSON.parse(localStorage.getItem('appSettings') || '{}') || {};
    // <-- INSERISCI QUI i tuoi valori DEFINITIVI
    const defaults = {
      cloudEnabled : true,
      supabaseTable: 'anima_sync',
      supabaseUrl  : 'https://fjlextoigwwhikovkhge.supabase.co',
      supabaseKey  : 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqbGV4dG9pZ3d3aGlrb3ZraGdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk0NzQyMjgsImV4cCI6MjA3NTA1MDIyOH0.TEpdcsxYew4wxDWsXJQTfn6dxMiYCX8VcoL2Oei230M',
      // mappa ruoli (vedi punto ruoli sotto)
      users: [
        { email: 'masettoriccardoanima@gmail.com', role: 'admin' },
        { email: 'masettoriccardo2@gmail.com',    role: 'admin' }
        // es: { email: 'operaio1@anima.local', role: 'worker' }
      ]
    };
    (function migrateUsersAdmin(){
  try{
    const s = JSON.parse(localStorage.getItem('appSettings')||'{}') || {};
    const list = Array.isArray(s.users) ? s.users.slice() : [];
    const need = 'masettoriccardo2@gmail.com';
    if (!list.some(u => String(u.email||u.username||'').toLowerCase() === need)) {
      list.push({ email: need, role: 'admin' });
      s.users = list;
      localStorage.setItem('appSettings', JSON.stringify(s));
      console.log('appSettings.users aggiornato con admin:', need);
    }
  }catch{}
})();

    // unisci senza sovrascrivere ciò che già c’è lato utente
    const next = { ...defaults, ...cur };
    localStorage.setItem('appSettings', JSON.stringify(next));
  } catch {}
})();

// Bootstrap appSettings da settings.json (solo se vuoto)
(async function primeAppSettings(){
  try {
    if (!localStorage.getItem('appSettings')) {
      const res = await fetch('./settings.json', { cache: 'no-store' });
      if (res.ok) {
        const cfg = await res.json();
        const base = { supabaseTable:'anima_sync', cloudEnabled:true };
        localStorage.setItem('appSettings', JSON.stringify(Object.assign(base, cfg||{})));
        console.log('[boot] appSettings da settings.json');
      }
    }
  } catch(e){ console.warn('[boot] primeAppSettings', e); }
})();

// --- Supabase client lazy (usa URL/KEY da appSettings) ---
window.getSupabase = window.getSupabase || function(){
  try{
    if (window.__sbClient) return window.__sbClient;
    const s = JSON.parse(localStorage.getItem('appSettings') || '{}') || {};
    const url  = String(s.supabaseUrl || '').trim();
    const anon = String(s.supabaseKey  || '').trim();
    if (!url || !anon || !window.supabase || !supabase.createClient) return null;
    window.__sbClient = supabase.createClient(url, anon);
    return window.__sbClient;
  }catch{ return null; }
};

// === Supabase Password Recovery bootstrap (idempotente) ===
(function supabaseRecoveryBootstrap(){
  try {
    const sb = window.getSupabase && window.getSupabase();
    if (!sb) return;

    // 1) Gestione dei link moderni (PKCE): la dashboard invia ?code=... su Site URL
    //    Scambio il "code" per una sessione valida (necessario perché l'evento altrimenti non parte).
    const href = String(location.href || '');
    const hasCode = href.includes('?code=') || href.includes('&code=');
    if (hasCode) {
      sb.auth.exchangeCodeForSession(href).catch(err => {

        console.warn('exchangeCodeForSession:', err?.message || err);
      });
          // Supporto link stile hash (#access_token=...&type=recovery)
    const hash = String(location.hash || '');
    if (hash.includes('access_token') && hash.includes('type=recovery')) {
      sb.auth.getSessionFromUrl({ storeSession: true }).catch(err => {
        console.warn('getSessionFromUrl:', err?.message || err);
      });
    }

    }

    // 2) Ascolta i cambi di stato: PASSWORD_RECOVERY → chiedi nuova password, poi aggiorna
    sb.auth.onAuthStateChange(async (event /*, session */) => {
      try {
        if (event === 'PASSWORD_RECOVERY' || (new URL(location.href)).searchParams.get('type') === 'recovery') {
          // Prompt minimale (poi lo trasformiamo in overlay carino): 
          const newPwd = prompt('Imposta una NUOVA password (almeno 8 caratteri):');
          if (!newPwd || newPwd.length < 8) {
            alert('Password troppo corta o annullata.');
            // Ritorno al login per evitare stati sospesi
            location.hash = '#/login';
            return;
          }
          const { error } = await sb.auth.updateUser({ password: newPwd });
          if (error) {
            alert('Errore aggiornamento: ' + (error.message || error));
          } else {
            alert('Password aggiornata! Ora accedi con la nuova password.');
          }
          // Torna alla schermata di login
          location.hash = '#/login';
        }
      } catch (e) {
        console.warn('Recovery handler error:', e?.message || e);
      }
    });
  } catch (e) {
    console.warn('supabaseRecoveryBootstrap error:', e?.message || e);
  }
})();

// --- Helper tempo (idempotenti, per Report/Registrazioni) ---
window.toMin = window.toMin || function (hhmm) {
  if (typeof hhmm !== 'string') return 0;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return 0;
  const h = parseInt(m[1], 10) || 0;
  const mm = parseInt(m[2], 10) || 0;
  return h * 60 + mm;
};
window.fmtHHMM = window.fmtHHMM || function (mins) {
  const t = Math.max(0, Math.round(Number(mins) || 0));
  const h = Math.floor(t / 60), m = t % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
};
// Alias compatibile se qualche vista usa il vecchio nome
window.fmtHHMMfromMin = window.fmtHHMMfromMin || window.fmtHHMM;

// ==== ORDER helper unico (incolla dopo i bootstrap) ====
window.sortNewestFirst = window.sortNewestFirst || function listSort(arr, opts){
  const dateKeys = (opts && opts.dateKeys) || ['updatedAt','createdAt','data','dataDocumento'];
  const getNumFromId = (id) => {
    const m = String(id||'').match(/-(\d{4})-(\d{3})$/); // -YYYY-NNN
    return m ? (+m[1])*1000 + (+m[2]) : -1;
  };
  const getDate = (obj) => {
    for (const k of dateKeys) {
      const v = obj && obj[k];
      const t = (typeof v === 'number') ? v : Date.parse(v||'');
      if (Number.isFinite(t)) return t;
    }
    return 0;
  };
  return (Array.isArray(arr)?arr:[]).slice().sort((a,b)=>{
    const td = getDate(b) - getDate(a);
    if (td) return td;
    const na = getNumFromId(a.id), nb = getNumFromId(b.id);
    if (nb !== na) return nb - na;           // DESC
    return String(b.id||'').localeCompare(String(a.id||''));
  });
};

// === AUTH CORE (beta) — login/logout, sessione e sola-lettura ===
(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

  const e = React.createElement;

  // Helper JSON con cookie
  window.fetchJSON = async function(url, opt={}){
    const res = await fetch(url, {
      credentials:'include',
      headers:{ 'Content-Type':'application/json', ...(opt.headers||{}) },
      ...opt
    });
    const ct = res.headers.get('content-type')||'';
    const body = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok){ const err = new Error('HTTP '+res.status); err.status=res.status; err.body=body; throw err; }
    return body;
  };

  // Stato utente in memoria
  window.__USER = null;

  window.getMe = async function(){
  const me = (global.apiMe ? await global.apiMe() : null);
  window.__USER = me;
  return me;
  };



  window.requireLogin = async function(){
    const u = await window.getMe();
    if (!u){ location.hash = '#/login'; throw new Error('not logged'); }
    return u;
  };

  // Delega al login Supabase-first (fallback shim in dev/LAN)
  window.login = async function(username, password){
    if (window.apiLogin) return await window.apiLogin(username, password);
  // fallback solo dev (shim)
    await window.fetchJSON('/api/auth/login', { method:'POST', body: JSON.stringify({ username, password }) });
    return window.requireLogin();
  };

  window.logout = async function(){
    if (global.logout) await global.logout();
    else { window.__USER = null; location.hash = '#/login'; }
  };

  // Ricorda se l'utente è arrivato con hash di Timbratura (es. QR)
(function rememberIntentTimbratura(){
  try {
    const h = (location.hash || '').toLowerCase();
    if (h.startsWith('#/timbratura')) {
      sessionStorage.setItem('__intent_timbratura', '1');
    } else {
      // non toccare se già impostata da QR nella stessa sessione
    }
  } catch {}
})();

  // Sola lettura: l’accountant non può scrivere; se non loggato → NON blocchiamo (così puoi lavorare offline)
  // --- RBAC: unica fonte di verità ---
  window.isReadOnlyUser = function(){
    return !!(window.__USER && window.__USER.role === 'accountant');
  };
  
  // Props da spalmare sui pulsanti che scrivono
  window.roProps = function(){
    return window.isReadOnlyUser() ? { disabled:true, title:'Sola lettura (accountant)' } : {};
  };
})();

// === LoginView (allineata al tuo AUTH CORE) ===
(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

  const e = React.createElement;

  function LoginView(){
    if (window.__USER) {
    const last = localStorage.getItem('lastRoute') || '#/dashboard';
    if (String(location.hash).toLowerCase().startsWith('#/login')) {
      location.hash = (typeof last === 'string' && last.startsWith('#/')) ? last : '#/dashboard';
    }
  return null;
  }
    const [u,setU] = React.useState('');
    const [p,setP] = React.useState('');
    const [err,setErr] = React.useState('');
    const [busy,setBusy] = React.useState(false);
    const logged = !!window.__USER;

    async function onSubmit(ev){
      ev.preventDefault();
      setErr(''); setBusy(true);
      try{
        await window.login(u,p);      // usa il tuo AUTH CORE
        await window.getMe();         // aggiorna __USER
        location.hash = '#/ddt';      // vai dove preferisci
      }catch(e){
        setErr( (e.body && e.body.error) ? String(e.body.error) : 'Login fallito' );
      }finally{
        setBusy(false);
      }
    }

    async function doLogout(){
      setBusy(true);
      try{
        await window.logout();        // usa il tuo AUTH CORE
        alert('Logout OK');
        location.hash = '#/login';
      }finally{ setBusy(false); }
    }

    return e('div',{className:'page', style:{maxWidth:360, margin:'40px auto'}},
  e('h2', null, logged ? 'Sei autenticato' : 'Accedi'),
  logged
    ? e('div',{className:'card', style:{padding:12}},
        e('div',{
          className:'actions',
          style:{justifyContent:'flex-end', marginTop:10}
        },
          e('button',{
            className:'btn',
            onClick:doLogout,
            disabled:busy
          }, busy ? '…' : 'Logout')
        )
      )
    : e('form',{onSubmit:onSubmit, className:'card', style:{padding:12}},
        e('label', null, 'Utente'),
        e('input',{
          value:u,
          onChange:ev=>setU(ev.target.value),
          autoFocus:true
        }),
        e('label', null, 'Password'),
        e('input',{
          type:'password',
          value:p,
          onChange:ev=>setP(ev.target.value)
        }),
        err && e('div',{style:{color:'#b00',marginTop:8}}, String(err)),
        e('div',{
          className:'actions',
          style:{marginTop:10, justifyContent:'flex-end'}
        },
          e('button',{
            type:'submit',
            className:'btn',
            disabled:busy
          }, busy ? '…' : 'Entra')
        )
      )
  );
  }

    // dopo la definizione di LoginView (versione 2)
  window.LoginView = LoginView;
  window.ROUTES = window.ROUTES || {};
  window.ROUTES['#/login'] = window.LoginView;

})();

// === Overlay di Login (idempotente, solo su #/login, auto-close) ===
(function mountAuthOverlay(){
  // se già autenticato e sei finito su #/login, porta via e non montare
  if (window.__USER && String(location.hash).toLowerCase().startsWith('#/login')) {
    const intent = sessionStorage.getItem('__intent_timbratura') === '1';
    location.hash = intent ? '#/timbratura' : '#/dashboard';
    try { sessionStorage.removeItem('__intent_timbratura'); } catch {}
    return;
  }

  // monta solo se siamo su #/login
  if (!String(location.hash).toLowerCase().startsWith('#/login')) return;

  // evita duplicati / attese DOM
  if (!document.body) { requestAnimationFrame(mountAuthOverlay); return; }
  if (document.getElementById('auth-overlay')) return;

  // container unico
  const host = document.createElement('div');
  host.id = 'auth-overlay';
  document.body.appendChild(host);

  const e = React.createElement;
  const root = ReactDOM.createRoot(host);
  window.__AUTH_OVERLAY_ROOT = root; // riferimento globale (debug/cleanup)

  function Screen(){
    const [hash, setHash] = React.useState(location.hash);

    const close = React.useCallback(() => {
      try { root.unmount(); } catch {}
      try { host.remove(); } catch {}
    }, []);

    React.useEffect(() => {
      // chiudi se cambia hash fuori da #/login o se arriva un auth-change con utente loggato
      const onHash = () => {
        setHash(location.hash);
        if (!String(location.hash).toLowerCase().startsWith('#/login')) close();
      };
      const onAuth = () => {
        if (!window.__USER) return;
        const last = localStorage.getItem('lastRoute') || '#/dashboard';
        if (String(location.hash).toLowerCase().startsWith('#/login')) {
          location.hash = (typeof last === 'string' && last.startsWith('#/')) ? last : '#/dashboard';
        }
        close();
      };

      // --- (1) hashchange: rimuovi eventuale handler precedente e re-installa in modo sicuro
try {
  if (window.__anima_router_handler) {
    window.removeEventListener('hashchange', window.__anima_router_handler);
  }
} catch {}

window.__anima_router_handler = function(ev){
  const now = Date.now();
  if (now - (window.__anima_lastNav || 0) < 30) {
    // debounce anti-doppio trigger (estensioni/refresh rapidi)
    return;
  }
  window.__anima_lastNav = now;
  try { onHash(ev); } catch (e) { console.error('[router] onHash error', e); }
};
window.addEventListener('hashchange', window.__anima_router_handler);

// --- (2) load: stesso principio, un solo handler
try {
  if (window.__anima_router_load_handler) {
    window.removeEventListener('load', window.__anima_router_load_handler);
  }
} catch {}

window.__anima_router_load_handler = function(ev){
  try { onHash(ev); } catch (e) { console.error('[router] onLoad->onHash error', e); }
};
window.addEventListener('load', window.__anima_router_load_handler);

// --- (3) flag di installazione (solo informativo)
window.__anima_router.installed = true;

      // stato iniziale: se già loggato, chiudi subito
      if (window.__USER) onAuth();

      return () => {
        window.removeEventListener('hashchange', onHash);
        window.removeEventListener('auth-change', onAuth);
      };
    }, [close]);

    // se per qualche race non siamo più su #/login, non renderizzare nulla
    if (!String(hash||'').toLowerCase().startsWith('#/login')) return null;

    const wrap = {
      position:'fixed', inset:0, background:'rgba(0,0,0,.35)', zIndex:10000,
      display:'grid', placeItems:'center', padding:16
    };
    const card = {
      background:'#fff', width:'min(420px, 100%)',
      borderRadius:10, padding:16, boxShadow:'0 8px 24px rgba(0,0,0,.2)'
    };

    return e('div', {style:wrap},
      e('div', {style:card},
        e(window.LoginView || (() => e('div', null, 'Login non disponibile')))
      )
    );
  }

  root.render(e(Screen));
})();


// === producedPieces: modello A = MIN tra le fasi (limitata a qtaPezzi) ===
window.producedPieces = window.producedPieces || function (c) {
  if (!c) return 0;
  const tot = Math.max(0, Number(c.qtaPezzi || 0));
  if (Array.isArray(c.fasi) && c.fasi.length) {
    const arr = c.fasi.map(f => Math.max(0, Number(f.qtaProdotta || 0)));
    const m = arr.length ? Math.min(...arr) : 0;
    return tot > 0 ? Math.min(m, tot) : m;
  }
  return Math.max(0, Number(c.qtaProdotta || 0));
};


// ===== ID generator uniforme: usa nextIdUnique se c'è, altrimenti counters in LS =====
(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

  const lsGet = window.lsGet || ((k,d)=>{ try{ return JSON.parse(localStorage.getItem(k)); }catch{return d;} });
  const lsSet = window.lsSet || ((k,v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} });
  const pad = (n,w)=> String(n).padStart(w||3,'0');

  function nextSeriesCounter(series){
    const year = new Date().getFullYear();
    const counters = lsGet('counters', {}) || {};
    const prev = counters[series];
    const num = (prev && prev.year===year && Number.isFinite(prev.num)) ? (prev.num+1) : 1;
    counters[series] = { year, num };
    lsSet('counters', counters);
    return { year, num };
  }

  // API: nextIdFor({ prefix:'OF', storageKey:'ordiniFornitoriRows', seriesKey:'OF', width:3 })
  window.nextIdFor = window.nextIdFor || function({ prefix, storageKey, seriesKey, width=3 }){
    const sKey = seriesKey || prefix; // es. 'OF', 'DDT', 'FA', 'MC'
    if (typeof window.nextIdUnique === 'function') {
      // usa l’implementazione nativa se presente (mantiene compatibilità con altre viste)
      return window.nextIdUnique(sKey, prefix, storageKey);
    }
    const { year, num } = nextSeriesCounter(sKey);
    return { id: `${prefix}-${year}-${pad(num, width)}`, year, num };
  };
})();

// === ATOMIC PERSIST (scrive subito e forza repaint) ===
window.persistKV = window.persistKV || function persistKV(key, value){
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  // facoltativo: duplica su lsSet per marcare __anima_dirty, se presente
  try { if (typeof window.lsSet === 'function') window.lsSet(key, value); } catch {}
  window.__anima_dirty = true;
  try { if (typeof window.requestAppRerender === 'function') window.requestAppRerender(); } catch {}
};

// ==== RBAC helper: true se ruolo = accountant (sola lettura) ====
window.isReadOnlyUser = function(){
  try{
    // priorità: app.me, poi localStorage 'me'
    const me = (window.app && window.app.me) || JSON.parse(localStorage.getItem('me')||'null');
    const role = me && (me.role || me.r);
    return role === 'accountant';
  }catch(e){
    return false;
  }
};

// Zeri a sinistra per i progressivi
  g.formatNNN = g.formatNNN || (n => String(n).padStart(3,'0'));

  // Progressivi centralizzati per anno (serie: "ore","C","DDT","FA","OF", ecc.)
  g.nextProgressivo = g.nextProgressivo || function(series){
    try{
      const year = new Date().getFullYear();
      const counters = g.lsGet('counters', {});
      const key = `${series}:${year}`;
      const num = Number(counters[key]||0) + 1;
      counters[key] = num;
      g.lsSet('counters', counters);
      return { year, num, code: `${series}-${year}-${g.formatNNN(num)}` };
    }catch(e){
      const year = new Date().getFullYear();
      return { year, num: 1, code: `${series}-${year}-001` };
    }
  };

  // Stampa sicura di una stringa HTML
  g.safePrintHTMLString = g.safePrintHTMLString || function(html){
    try{
      const ifr = document.createElement('iframe');
      ifr.style.width = ifr.style.height = '0';
      ifr.style.border = '0';
      document.body.appendChild(ifr);
      const d = ifr.contentWindow.document;
      d.open(); d.write(html); d.close();
      setTimeout(() => { try{ ifr.contentWindow && ifr.contentWindow.focus(); }catch{} }, 80);
    }catch(e){ console.warn('safePrintHTMLString error', e); }
  };

  // Navigazione coerente col tuo progetto
  g.navigateTo = g.navigateTo || function(tab){
    const t = String(tab||'').toLowerCase();
    const hash = (t==='report') ? '#/report'
               : (t==='impostazioni') ? '#/impostazioni'
               : (t==='timbratura') ? '#/timbratura'
               : '#/';
    if (location.hash !== hash) location.hash = hash;
    if (typeof g.setTab === 'function') g.setTab(tab);
  };
  g.goBackSmart = g.goBackSmart || function(){
    try { if (history.length > 1) history.back(); else location.hash = '#/impostazioni'; }
    catch { location.hash = '#/impostazioni'; }
  };

  // Ordinamento utility (usata da varie view)
  g.sortNewestFirst = g.sortNewestFirst || function(arr, { dateKeys=[] } = {}){
    const a = Array.isArray(arr) ? arr.slice() : [];
    const keys = dateKeys;
    const ts = o => {
      for (const k of keys){ const v = o && o[k]; if (v) return new Date(v).getTime(); }
      return new Date(o && (o.updatedAt || o.__createdAt || o.createdAt || 0)).getTime() || 0;
    };
    return a.sort((x,y)=> ts(y) - ts(x));
  };
})();

/* ===== Supabase helpers (cloud) ========================================== */
(function supabaseHelpers(){
  const g = window;

  // Legge le credenziali da appSettings (se abilitate)
  g.getSB = g.getSB || function(){
    try{
      const a = g.lsGet('appSettings', {}) || {};
      if (!(a.cloudEnabled && a.supabaseUrl && a.supabaseKey)) return null;
      return {
        url: String(a.supabaseUrl).replace(/\/+$/,''),
        key: a.supabaseKey,
        table: a.supabaseTable || 'anima_sync'
      };
    }catch{ return null; }
  };

  // Insert generico
  g.sbInsert = g.sbInsert || async function(table, payload){
    const sb = g.getSB(); if(!sb) throw new Error('Supabase non configurato');
    const url = `${sb.url}/rest/v1/${encodeURIComponent(table)}`;
    const res = await fetch(url, {
      method:'POST',
      headers:{
        apikey: sb.key,
        Authorization: `Bearer ${sb.key}`,
        'Content-Type':'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(payload)
    });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  };

  // Patch by id (colonna "id")
  g.sbPatchById = g.sbPatchById || async function(table, id, payload){
    const sb = g.getSB(); if(!sb) throw new Error('Supabase non configurato');
    const url = `${sb.url}/rest/v1/${encodeURIComponent(table)}?id=eq.${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method:'PATCH',
      headers:{
        apikey: sb.key,
        Authorization: `Bearer ${sb.key}`,
        'Content-Type':'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(payload)
    });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  };

  // Select semplice (opzionale, può tornare utile)
  g.sbSelect = g.sbSelect || async function(table, query='*'){
    const sb = g.getSB(); if(!sb) throw new Error('Supabase non configurato');
    const url = `${sb.url}/rest/v1/${encodeURIComponent(table)}?select=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers:{ apikey: sb.key, Authorization:`Bearer ${sb.key}` } });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  };
})();

/* ===== Timesheets sync utils (una sola volta) ============================ */
(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

  const LS_WM_KEY = 'oreSyncWM';
  window.__oreSync = window.__oreSync || {
    getWM(){ try{ return JSON.parse(localStorage.getItem(LS_WM_KEY)||'{}').ts || ''; }catch{ return '';} },
    setWM(ts){ try{ localStorage.setItem(LS_WM_KEY, JSON.stringify({ts: ts||''})); }catch{}; },
    isDup(rec, rows){
      // DEDUP: stessa commessa + stessa data + stesso operatore + stessi minuti + stesse note
      return (rows||[]).some(x =>
        x.commessaId === rec.commessaId &&
        String(x.data||'').slice(0,10) === rec.data &&
        String(x.operatore||'') === String(rec.operatore||'') &&
        Number(x.oreMin||0) === Number(rec.oreMin||0) &&
        String(x.note||'') === String(rec.note||'')
      );
    }
  };
})();

/* ===== Alias chiavi Magazzino + saveKey compat =========================== */
(function ensureMagKeyAliases(){
  const g = window;

  // Scrive sulle chiavi corrette e mantiene compatibilità
  g.saveKey = g.saveKey || function(key, value){
    try{
      if (key === 'magArticoli' || key === 'magazzinoArticoli'){
        g.lsSet('magArticoli', value);
        g.lsSet('magazzinoArticoli', value);
        return;
      }
      if (key === 'magMovimenti'){
        g.lsSet('magMovimenti', value);
        return;
      }
      g.lsSet(key, value);
    }catch{}
  };

  // Se esiste solo una delle due, duplica nell’altra
  try{
    const a = g.lsGet('magArticoli', null);
    const b = g.lsGet('magazzinoArticoli', null);
    if (a && !b) g.lsSet('magazzinoArticoli', a);
    if (b && !a) g.lsSet('magArticoli', b);
  }catch{}
})();

/* ===== Compat kit: helper & fallback senza cambiare UI =================== */
(function compatKit(){
  const g=window;

  // Ordina array per date più recenti (usato in DDT/Fatture)
  g.sortNewestFirst = g.sortNewestFirst || function(arr, {dateKeys=[]}={}){
    const getMs = (o,k)=>{ const v=o && o[k]; const d=new Date(v); return isNaN(d)?0:d.getTime(); };
    const a = Array.isArray(arr)?arr.slice():[];
    a.sort((A,B)=>{
      for(const k of dateKeys){ const diff=getMs(B,k)-getMs(A,k); if(diff) return diff; }
      const ib=String((B&&B.id)||''); const ia=String((A&&A.id)||''); return ib.localeCompare(ia);
    });
    return a;
  };

  // ID progressivo unico: PREFIX-YYYY-NNN, evitando collisioni nello store
  g.nextIdUnique = g.nextIdUnique || function(series, prefix, storeKey){
    const np = g.nextProgressivo(series);
    const pad = g.formatNNN ? g.formatNNN : (n=>String(n).padStart(3,'0'));
    const rows = g.lsGet(storeKey, []) || [];
    const used = new Set((Array.isArray(rows)?rows:[]).map(r=>String(r.id)));
    let n = np.num, id = `${prefix}-${np.year}-${pad(n)}`, guard=0;
    while(used.has(id) && guard<1000){ n++; id = `${prefix}-${np.year}-${pad(n)}`; guard++; }
    return { id, year: np.year, num: n };
  };

  // Stampa sicura di un HTML string (iframe temporaneo)
  g.safePrintHTMLString = g.safePrintHTMLString || function(html){
    try{
      const ifr = document.createElement('iframe');
      ifr.style.position='fixed'; ifr.style.right='0'; ifr.style.bottom='0';
      ifr.style.width='0'; ifr.style.height='0'; ifr.style.border='0';
      document.body.appendChild(ifr);
      const d = ifr.contentWindow.document;
      d.open(); d.write(String(html||'')); d.close();
      setTimeout(()=>{ try{ ifr.contentWindow.focus(); ifr.contentWindow.print(); }catch{} setTimeout(()=>ifr.remove(),300); }, 200);
    }catch(e){ alert('Stampa non disponibile: '+(e&&e.message||e)); }
  };

  // Scanner QR (fallback minimale se lo scanner non è disponibile)
  g.scanQR = g.scanQR || function(){
    const v = prompt('Inserisci ID commessa (es. C-2025-001) oppure incolla il QR/URL:');
    if(!v) return;
    const m = String(v).match(/[?&]job=([^&#]+)/i);
    const id = m ? decodeURIComponent(m[1]) : String(v).trim();
    if(!id) return;
    try{ localStorage.setItem('qrJob', JSON.stringify(id)); }catch{}
    location.hash = '#/timbratura?job=' + encodeURIComponent(id);
  };

  // Carico da Ordine Fornitore (+ CMP opzionale)
  g.creaMovimentoCaricoDaOrdine = g.creaMovimentoCaricoDaOrdine || function(ordine, righeCarico, opt={}){
    try{
      const updateCMPGlobal = !!((g.lsGet('appSettings',{})||{}).magUpdateCMP);
      const updCMP = !!(opt && (opt.updateCMP || updateCMPGlobal));
      const mov = g.lsGet('magMovimenti', []) || [];
      const art = g.lsGet('magArticoli', []) || g.lsGet('magazzinoArticoli', []) || [];

      const today = new Date().toISOString().slice(0,10);
      (Array.isArray(righeCarico)?righeCarico:[]).forEach(r=>{
        const codice = String(r.codice||'').trim(); if(!codice) return;
        const q = Math.max(0, Number(r.qta||0)); if(!q) return;
        const prezzo = Number(r.prezzo||0) || 0;

        // movimento
        mov.push({
          id: undefined,
          data: opt.data || today,
          tipo: 'CARICO',
          codice,
          descrizione: r.descrizione || r.descr || '',
          um: r.um || r.UM || '',
          qta: q,
          prezzo, // costo unitario
          ordineId: ordine && ordine.id,
          ddtFornitore: opt.ddtFornitore || '',
          note: opt.note || `Carico da ordine ${ordine && ordine.id ? ordine.id : ''}`
        });

        // giacenza + CMP (media ponderata)
        let i = art.findIndex(a => String(a.codice||'').trim().toLowerCase() === codice.toLowerCase());
        if (i < 0) { art.push({ codice, descrizione: r.descrizione||r.descr||'', um: r.um||r.UM||'', giacenza: 0, cmp: 0 }); i = art.length-1; }
        const a = art[i];
        const giac0 = Number(a.giacenza||0);
        const cmp0 = Number(a.cmp||0);
        const giac1 = giac0 + q;
        let cmp1 = cmp0;
        if (updCMP){
          const tot0 = Math.max(0, giac0) * cmp0;
          const tot1 = tot0 + (q * prezzo);
          cmp1 = giac1 > 0 ? (tot1 / giac1) : cmp0;
        }
        art[i] = { ...a, giacenza: giac1, cmp: cmp1 };
      });

      g.saveKey('magMovimenti', mov);
      g.saveKey('magArticoli', art); // duplica anche su magazzinoArticoli
      g.__anima_dirty = true;
    }catch(e){ console.warn('creaMovimentoCaricoDaOrdine errore:', e); }
  };

  // Export selettivo (no-op se non configurato)
  g.syncExportToCloudOnly = g.syncExportToCloudOnly || function(keys){
    try{
      if (typeof g.syncExportToCloud === 'function') { return g.syncExportToCloud(keys); }
      console.info('[syncExportToCloudOnly] no-op', keys);
    }catch{}
  };

  // Report rapido (fallback)
  g.openReport = g.openReport || function(){ g.navigateTo && g.navigateTo('Report'); };

  // DDT rapido da commessa (prefill + nav)
  g.createDDTRapidoFromCommessa = g.createDDTRapidoFromCommessa || function(c){
    try{
      const righe = [{
        codice: '',
        descrizione: c && c.descrizione ? c.descrizione : 'Lavorazione',
        qta: Math.max(1, Number(c && c.qtaPezzi || 1)),
        UM: 'PZ',
        note: ''
      }];
      const pf = {
        data: new Date().toISOString().slice(0,10),
        clienteId: c && c.clienteId || '',
        cliente: c && c.cliente || '',
        commessaRif: c && c.id || '',
        righe
      };
      localStorage.setItem('prefillDDT', JSON.stringify(pf));
      location.hash = '#/ddt';
    }catch(e){ alert('Impossibile preparare il DDT: ' + (e && e.message || e)); }
  };

  // Backup / Ripristino (usati in Impostazioni)
  g.downloadBackup = function(){
    try{
      const dump = {};
      for (let i=0;i<localStorage.length;i++){
        const k = localStorage.key(i);
        dump[k] = localStorage.getItem(k);
      }
      const blob = new Blob([JSON.stringify(dump,null,2)], {type:'application/json'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'anima_backup.json';
      a.click(); URL.revokeObjectURL(a.href);
    }catch(e){ alert('Backup non riuscito: ' + (e && e.message || e)); }
  };
  g.restoreFromFile = g.restoreFromFile || async function(file){
    const txt = await file.text();
    const dump = JSON.parse(txt);
    Object.keys(dump||{}).forEach(k => localStorage.setItem(k, dump[k]));
    alert('Ripristino completato. L’app verrà ricaricata.'); location.reload();
  };

  // goBackSmart fallback
  g.goBackSmart = g.goBackSmart || function(){
    try { if (history.length > 1) history.back(); else location.hash = '#/impostazioni'; }
    catch { location.hash = '#/impostazioni'; }
  };
})();

// ================== BOOTSTRAP GLOBALI + SUPABASE AUTO-SYNC ==================
// --- Utils globali sicuri (una sola volta) ---
(function () {
  // LocalStorage helpers (globali)
  window.lsGet = window.lsGet || function (k, def) {
    try { const v = JSON.parse(localStorage.getItem(k)); return (v ?? def); } catch { return def; }
  };
  window.lsSet = window.lsSet || function (k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); window.__anima_dirty = true; } catch {}
  };

  window.persistListFactory = window.persistListFactory || function(key, setState){
    return function persist(next){
      try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
      try { if (typeof setState === 'function') setState(next); } catch {}
      window.__anima_dirty = true;
      try { if (typeof window.requestAppRerender === 'function') window.requestAppRerender(); } catch {}
    };
  };

  // Contatori progressivi (per ID tipo O-2025-001)
  window.formatNNN = window.formatNNN || (n => String(n).padStart(3, '0'));

  // === nextIdUnique: calcola il prossimo ID scansionando lo storage (max+1) ===
window.nextIdUnique = window.nextIdUnique || function (kind, series, storageKey) {
  const lsGet = window.lsGet || ((k,d)=>{ try{ return JSON.parse(localStorage.getItem(k)) ?? d; }catch{ return d; } });
  const rows = Array.isArray(lsGet(storageKey, [])) ? lsGet(storageKey, []) : [];
  const year = new Date().getFullYear();
  const re = new RegExp(`^${series}-${year}-([0-9]{3})$`, 'i');
  let max = 0;
  for (const r of rows) {
    const m = String(r?.id||'').match(re);
    if (m) { const n = parseInt(m[1], 10) || 0; if (n > max) max = n; }
  }
  const next = max + 1;
  const pad = (window.formatNNN ? window.formatNNN(next) : String(next).padStart(3,'0'));
  return { id: `${series}-${year}-${pad}`, year, num: next };
};

  // === Progressivi unificati (solo {year,num}) ===
 window.nextProgressivo = window.nextProgressivo || function (series) {
  const year = new Date().getFullYear();
  let counters = {};
  try { counters = JSON.parse(localStorage.getItem('counters') || '{}') || {}; } catch {}
  const prev = counters[series];
  const next = (prev && prev.year === year && Number.isFinite(prev.num)) ? (prev.num + 1) : 1;
  counters[series] = { year, num: next };
  try { localStorage.setItem('counters', JSON.stringify(counters)); } catch {}
  return { year, num: next };
};

// === Progressivo commesse robusto (idempotente) ===
// Scansiona le commesse esistenti dell'anno corrente e genera il prossimo ID
window.nextCommessaId = window.nextCommessaId || function nextCommessaId(){
  const year = new Date().getFullYear();
  const fmt = (window.formatNNN || (n => String(n).padStart(3,'0')));
  const lsGet = window.lsGet || ((k,d)=>{ try{ return JSON.parse(localStorage.getItem(k)||'null') ?? d; }catch{ return d; } });

  const rows = lsGet('commesseRows', []);
  let max = 0;
  if (Array.isArray(rows)) {
    for (const c of rows) {
      const m = String(c && c.id || '').match(/^C-(\d{4})-(\d{3})$/i);
      if (m && +m[1] === year) {
        const n = +m[2];
        if (n > max) max = n;
      }
    }
  }

  // sincronizza anche il vecchio "counters.C" se presente
  try {
    const counters = JSON.parse(localStorage.getItem('counters')||'{}') || {};
    const c = counters['C'];
    if (c && c.year === year && Number.isFinite(c.num)) {
      if (c.num > max) max = c.num;
    }
    counters['C'] = { year, num: max + 1 };
    localStorage.setItem('counters', JSON.stringify(counters));
  } catch {}

  return `C-${year}-${fmt(max + 1)}`;
};

// === PATCH E1: print HTML sicuro (usato da etichette colli) ===
window.safePrintHTMLString = window.safePrintHTMLString || function(html){
  try{
    const w = window.open('', '_blank', 'noopener,noreferrer');
    if(!w){ alert('Popup bloccato: abilita le finestre per la stampa.'); return; }
    w.document.open(); w.document.write(html); w.document.close();
    const doPrint = ()=> { try{ w.focus(); w.print(); w.close(); }catch{} };
    if (w.document.readyState === 'complete') doPrint();
    else w.addEventListener('load', doPrint);
  }catch(e){ console.warn('safePrintHTMLString', e); }
};

// === PATCH E4: navigateTo & scanQR (usati in Timbratura/Impostazioni) ===
window.navigateTo = window.navigateTo || function(label){
  const map = {
    'Impostazioni':'#/impostazioni','DDT':'#/ddt','Fatture':'#/fatture','Magazzino':'#/magazzino',
    'Ore':'#/ore','Commesse':'#/commesse','Report':'#/report','Report tempi':'#/report-tempi',
    'Report materiali':'#/report-materiali','OrdiniFornitori':'#/ordini','Dashboard':'#/dashboard',
    'TIMBRATURA':'#/timbratura','Timbratura':'#/timbratura'
  };
  const target = map[label] || '#/dashboard';

  const u = window.__USER || null;
  const isAdmin = !!(u && u.role === 'admin');
  const allowed = new Set(['#/timbratura', '#/commesse', '#/impostazioni', '#/login', '#/ddt']);
  if (!isAdmin && !allowed.has(target)) {
    return (location.hash = '#/timbratura');
  }
  location.hash = target;
};


// === PATCH E5: salvataggi sicuri per Magazzino (saveKey/safeSetJSON) ===
window.safeSetJSON = window.safeSetJSON || function(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} };
window.saveKey = window.saveKey || function(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} };

// === PATCH E6: Supabase helpers (getSB/sbInsert) compatibili coi 9/10 ===
window.getSB = window.getSB || function(){
  try{ const a = JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; 
       if(a.supabaseUrl && a.supabaseKey) return { url:a.supabaseUrl, key:a.supabaseKey, table:(a.syncTable||'anima_sync') };
  }catch{}
  return null;
};
// Patch I — Alias robusto per ReportView
(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

  if (typeof window.ReportView !== 'function') {
    window.ReportView = window.ReportProdView || window.ReportMaterialiView || function(){
      return React.createElement('div', {className:'page'}, 'Report materiali — vista non ancora implementata');
    };
  }
  // opzionale: rendi openReport coerente con la tua route preferita
  window.openReport = window.openReport || function () {
    if (typeof window.setTab === 'function') window.setTab('REPORT_MAT');
    if (location.hash !== '#/report-materiali') location.hash = '#/report-materiali';
  };
})();
window.sbInsert = window.sbInsert || async function(table, row){
  const sb = window.getSB && window.getSB(); if(!sb) return;
  const url = `${sb.url}/rest/v1/${encodeURIComponent(table)}`;
  const res = await fetch(url, {
    method:'POST',
    headers:{ apikey:sb.key, Authorization:`Bearer ${sb.key}`, 'Content-Type':'application/json', Prefer:'return=minimal' },
    body: JSON.stringify(row)
  });
  if(!res.ok){ console.warn('[sbInsert]', table, await res.text()); }
};

// ---- AppSettings defaults (cloud OFF se non presente) ----
(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

  try {
    const s = JSON.parse(localStorage.getItem('appSettings')||'{}') || {};
    if (typeof s.cloudEnabled === 'undefined') s.cloudEnabled = true;
    if (!('supabaseTable' in s)) s.supabaseTable = 'anima_sync';
    localStorage.setItem('appSettings', JSON.stringify(s));
  } catch {}
})();


/* === PATCH 3: seed Order Parsers & Process Templates (idempotente) === */
(function seedParsersAndTemplates(){
  if (window.__PATCH3_SEEDED__) return; 
  window.__PATCH3_SEEDED__ = true;

  // Registro runtime (funzioni vive, non serializzate)
  window.__orderParsers = window.__orderParsers || [];
  window.registerOrderParser = window.registerOrderParser || function(def){
    try{
      if (!def || !def.id) return;
      const id = String(def.id).toLowerCase();
      if (!window.__orderParsers.some(p => String(p.id).toLowerCase() === id)) {
        window.__orderParsers.push(def);
       console.log('[registerOrderParser] attivato', def.id);
      }
    }catch(e){ console.warn('registerOrderParser fail', e); }
  };

  // Fallback: definisci addOrderParser / addProcessTemplate se mancanti
  if (typeof window.addOrderParser !== 'function') {
    window.addOrderParser = function(def){
    try{
      // 1) registra subito in runtime (funzioni vive)
      if (typeof window.registerOrderParser === 'function') {
        window.registerOrderParser(def);
      }

      // 2) salva SOLO metadati in appSettings (non funzioni)
      const s = JSON.parse(localStorage.getItem('appSettings')||'{}') || {};
      const metaArr = Array.isArray(s.orderParsersMeta) ? s.orderParsersMeta : [];
     const id  = String(def?.id||'').toLowerCase();
      if (!id) return;
      if (!metaArr.some(p => String(p.id||'').toLowerCase() === id)) {
        metaArr.push({ id: def.id, name: def.name || def.id, addedAt: new Date().toISOString() });
        s.orderParsersMeta = metaArr;
        localStorage.setItem('appSettings', JSON.stringify(s));
        console.log('[addOrderParser] metadati salvati', def.id);
      }
    }catch(e){ console.warn('addOrderParser fail', e); }
  };
  }
  if (typeof window.addProcessTemplate !== 'function') {
    window.addProcessTemplate = function(def){
      try{
        const s = JSON.parse(localStorage.getItem('appSettings')||'{}') || {};
        const arr = Array.isArray(s.processTemplates) ? s.processTemplates : [];
        const id  = String(def?.id||'').toLowerCase();
        if (!id) return;
        if (!arr.some(p => String(p.id||'').toLowerCase() === id)) {
          arr.push(def);
          s.processTemplates = arr;
          localStorage.setItem('appSettings', JSON.stringify(s));
          console.log('[addProcessTemplate] aggiunto', def.id);
        }
      }catch(e){ console.warn('addProcessTemplate fail', e); }
    };
  }

  // === ESEMPI SEED (salta se già presenti) ===
  // Brembo v1
  addOrderParser({
    id  : 'brembo-v1',
    name: 'Brembo (righe tabellari)',
    test: txt => /BREMBO/i.test(txt) && /(ORDINE|PO)\s*[:#]/i.test(txt),
    extract: txt => {
      const cliente = 'BREMBO';
      // righe: CODICE - DESCR - QTA [UM]
      const righe = [];
      const re = /([A-Z0-9][A-Z0-9._\-]{2,})\s+-\s+(.{6,80}?)\s+([0-9]+(?:[.,][0-9]+)?)\s*([A-Z]{1,3})?\b/g;
      let m; while ((m = re.exec(txt))){
        righe.push({ codice:m[1], descrizione:m[2].trim(), qta:Number(String(m[3]).replace(',','.'))||0, um:(m[4]||'PZ') });
      } 
      const descr = (txt.match(/Oggetto\s*[:\-]\s*(.+)/i)||[])[1] || 'Commessa da ordine PDF';
      const consegna = (txt.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/)||[])[1] || '';
      return { cliente, descrizione: descr.trim(), righe, qtaPezzi: righe.reduce((s,r)=>s+(r.qta||0),0) || 1, consegna };
    }
  });

  // Caterpillar v1
  addOrderParser({
    id  : 'caterpillar-v1',
    name: 'Caterpillar (scheda righe)',
    test: txt => /CATERPILLAR/i.test(txt) && /PURCHASE\s+ORDER/i.test(txt),
    extract: txt => {
      const cliente = 'CATERPILLAR';
      const righe = [];
      const re = /Item\s*[:#]?\s*([A-Z0-9._\-]{3,})\s+Desc\s*[:\-]\s*(.{6,80}?)\s+Qty\s*[:\-]\s*([0-9]+(?:[.,][0-9]+)?)/gi;
      let m; while ((m = re.exec(txt))){
        righe.push({ codice:m[1], descrizione:m[2].trim(), qta:Number(String(m[3]).replace(',','.'))||0, um:'PZ' });
      }
      const descr = (txt.match(/(?:Fornitura|Description)\s*[:\-]\s*(.+)/i)||[])[1] || 'Commessa da ordine PDF';
      const consegna = (txt.match(/(Delivery|Consegna)\s*[:\-]\s*([0-9]{4}[-/][0-9]{2}[-/][0-9]{2})/i)||[])[2] || '';
      return { cliente, descrizione: descr.trim(), righe, qtaPezzi: righe.reduce((s,r)=>s+(r.qta||0),0) || 1, consegna };
    }
  });

  // Vimek v1
  addOrderParser({
    id  : 'vimek-v1',
    name: 'Vimek (distinta semplice)',
    test: txt => /VIMEK/i.test(txt) && /(ORDINE|COMMESSA)\s*[:#]/i.test(txt),
    extract: txt => {
      const cliente = 'VIMEK BAKERY AUTOMATION SRL';
      const righe = [];
      const re = /([A-Z0-9._\-]{3,})\s+[–-]\s+(.{6,80}?)\s+(?:QTA|Q\.T\.)\s*[:\-]?\s*([0-9]+(?:[.,][0-9]+)?)/gi;
      let m; while ((m = re.exec(txt))){
        righe.push({ codice:m[1], descrizione:m[2].trim(), qta:Number(String(m[3]).replace(',','.'))||0, um:'PZ' });
      }
      const descr = (txt.match(/Oggetto\s*[:\-]\s*(.+)/i)||[])[1] || 'Commessa da ordine PDF';
      const consegna = (txt.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/)||[])[1] || '';
      return { cliente, descrizione: descr.trim(), righe, qtaPezzi: righe.reduce((s,r)=>s+(r.qta||0),0) || 1, consegna };
    }
  });
  try{
    // Parser “generico IT” (puoi tenerlo come fallback)
    addOrderParser({
      id  : 'ordine-generico-IT',
      name: 'Generico IT (numero e data)',
      test: txt => /ordine\s*(n\.|nr|numero)?/i.test(txt) && /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/.test(txt),
      extract: txt => ({
        cliente    : (txt.match(/(?:Cliente|Rag\.?\s*Sociale|Destinatario)\s*[:\-]?\s*(.+)/i)||[])[1]?.trim() || '',
        ordineId   : (txt.match(/Ordine\s*(?:n\.|nr|numero)?\s*[:\-]?\s*([A-Z0-9._\/\-]+)/i)||[])[1]?.trim() || '',
        consegna   : (txt.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/)||[])[1] || '',
        descrizione: (txt.match(/Oggetto\s*[:\-]\s*(.+)/i)||txt.match(/Descrizione\s*[:\-]\s*(.+)/i)||[])[1]?.trim() || '',
        qtaPezzi   : 1
      })
    });

    // Template di processo “Tramoggia” (adatta i regex e i tempi al tuo standard)
    addProcessTemplate({
      id  : 'tramoggia-standard',
      name: 'Tramoggia — ciclo standard',
      match: { any:[/TRAMOGG/i, /TRG-\d+/i, /TRAM\w*/i] },
      fasi: [
        { lav:'Taglio',        oreHHMM:'0:15' },
        { lav:'Puntatura',     oreHHMM:'0:20' },
        { lav:'Saldatura',     oreHHMM:'0:45' },
        { lav:'Pulizia',       oreHHMM:'0:10' },
        { lav:'Collaudo',      oreHHMM:'0:15', unaTantum:true }
      ]
    });
  }catch(e){
    console.warn('Seed parsers/templates skipped:', e);
  }
})();

// ==== AUTH + API HELPERS (incolla in cima a app.js) ====
(function (global) {
  const API = ''; // stesso origin: '' va benissimo (http://server:8080)

  async function fetchJSON(path, opts={}) {
    const o = { credentials: 'include', headers: {}, ...opts };
    if (o.body != null && typeof o.body !== 'string') {
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(o.body);
    }
    const res = await fetch(API + path, o);
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
      const err = new Error(msg); err.status = res.status; throw err;
    }
    const ct = res.headers.get('Content-Type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }

    // --- AUTH: Supabase nativo + mapping ruolo da appSettings.users ---
global.apiLogin = async (username, password) => {
  const sb = window.getSupabase && window.getSupabase();
  if (!sb) throw new Error('Supabase non configurato');

  const { error } = await sb.auth.signInWithPassword({
    email: String(username||'').trim(),
    password: String(password||'').trim()
  });
  if (error) throw error;

  // 👇 FONTE UNICA: mappa ruolo passando SEMPRE da apiMe()
  const me = (global.apiMe ? await global.apiMe() : null);
  if (!me) throw new Error('Login riuscito ma impossibile ricavare utente');
  return me;
};

// Redirect post-login: Dashboard di default, ma rispetta la Timbratura da QR
window.addEventListener('auth-change', () => {
  const h = (location.hash || '').toLowerCase();
  const intent = sessionStorage.getItem('__intent_timbratura') === '1';
  if (intent || h.startsWith('#/timbratura')) {
    location.hash = '#/timbratura';
  } else {
    location.hash = '#/dashboard';
  }
  // Consuma l'intento, così i login successivi da PC vanno a dashboard
  try { sessionStorage.removeItem('__intent_timbratura'); } catch {}
});

// Chi sono (evita /api/auth/me)
global.apiMe = async () => {
  const sb = window.getSupabase && window.getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getUser();
  const email = data?.user?.email || null;

  if (!email) return null;

  // ricava ruolo da appSettings
  let role = 'worker';
  try{
    const s = JSON.parse(localStorage.getItem('appSettings') || '{}') || {};
    const match = (Array.isArray(s.users)?s.users:[]).find(u =>
      String(u.email || u.username || '').trim().toLowerCase() ===
      String(email).toLowerCase()
    );
    if (match && match.role) role = match.role;
  }catch{}

  const u = { id: data.user.id, username: email, role };
  global.currentUser = u;
  window.__USER = u;
  return u;
};

global.requireLogin = async () => {
  const me = await global.apiMe();
  if (!me) {
    location.hash = '#/login';
    throw new Error('non autenticato');
  }
  return me;
};

global.logout = async () => {
  try {
    const sb = window.getSupabase && window.getSupabase();
    if (sb) await sb.auth.signOut();
  } catch {}
  global.currentUser = null;
  window.__USER = null;
  location.hash = '#/login';
};


// Alias di compatibilità (se altrove chiami window.login)
window.login = window.login || global.apiLogin;


  global.apiLogout = async ()=> {
  try{ const sb = window.getSupabase && window.getSupabase(); if (sb) await sb.auth.signOut(); }catch{}
  try{ await fetchJSON('/api/auth/logout', { method:'POST' }); }catch{}
  global.currentUser = null;
  window.__USER = null;
  window.__ONLINE__ = true;
  window.dispatchEvent(new CustomEvent('auth-change', { detail: null }));
  return true;
};

  // Chi sono (Supabase prima, poi fallback /api/auth/me)
global.apiMe = async ()=> {
  try{
    const sb = window.getSupabase && window.getSupabase();
    if (sb){
      const { data: { user } } = await sb.auth.getUser();
      if (user){
        let role = 'admin';
        try{
          const s = JSON.parse(localStorage.getItem('appSettings') || '{}') || {};
          const m = (s.users||[]).find(u =>
            String(u.username || u.email || '').trim().toLowerCase() ===
            String(user.email || '').trim().toLowerCase()
          );
          if (m && m.role) role = m.role;
        }catch{}
        const u = { id: user.id, username: user.email, role };
        global.currentUser = u;
        window.__USER = u;
        window.__ONLINE__ = true;
        window.dispatchEvent(new CustomEvent('auth-change', { detail: u }));
        return u;
      }
    }
  }catch{}

  // Fallback dev/LAN
  try{
    const r = await fetchJSON('/api/auth/me');
    const u = r.user || null;
    global.currentUser = u;
    window.__USER = u;
    window.__ONLINE__ = true;
    window.dispatchEvent(new CustomEvent('auth-change', { detail: u }));
    return u;
  }catch{
    window.__ONLINE__ = false;
    return null;
  }
};

  // opzionale ma utile: unifica anche il RO helper
  window.isReadOnlyUser = function(){
    const u = window.__USER || window.currentUser || null;
    return !!(u && u.role === 'accountant');
  };

// --- Riconoscimento hosting statico (Netlify/Vercel/GitHub Pages) ---
function isStaticHost(){
  const h = location.hostname;
  const isLAN = /(^localhost$)|(^127\.0\.0\.1$)|(^192\.168\.)/.test(h);
  return (location.protocol !== 'file:' && !isLAN);
}

  // --- KV store ---
  global.kvGet = async (key, fallback=null)=> {
    if (isStaticHost()) {
      try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
      catch { return fallback; }
    }

     try { const r = await fetchJSON('/api/kv/' + encodeURIComponent(key)); global.__ONLINE__=true; return (r==null? fallback : r); }
     catch { global.__ONLINE__=false; try{ return JSON.parse(localStorage.getItem(key)) ?? fallback; }catch{return fallback;} }
  };
   global.kvMultiGet = async (keys)=> {
     if (isStaticHost()) {
   const out = {};
   (keys || []).forEach(k => {
     try { out[k] = JSON.parse(localStorage.getItem(k) || 'null'); }
     catch { out[k] = null; }
   });
   return out;
  }

    try {
      const q = encodeURI(keys.join(','));
      const r = await fetchJSON('/api/kv?keys=' + q);
      global.__ONLINE__ = true;
      return r || {};
    } catch {
      global.__ONLINE__ = false;
      const out = {};
      keys.forEach(k => { try{ out[k] = JSON.parse(localStorage.getItem(k)); }catch{ out[k]=null; } });
      return out;
    }
  };
  global.kvSet = async (key, value)=> {
    if (isStaticHost()) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    return { ok: true, storage: 'local' };
  }
    try { const r = await fetchJSON('/api/kv/' + encodeURIComponent(key), { method:'PUT', body:value }); global.__ONLINE__=true; return r; }
    catch (e) {
      // se offline o 403 (accountant), ripiego su localStorage
      try{ localStorage.setItem(key, JSON.stringify(value)); }catch{}
      throw e;
    }
  };

  // Bridge per compatibilità con codice che usa window.api.kv
  window.api = window.api || {};
  window.api.kv = window.api.kv || {
  get:    (k)    => window.kvGet(k, null),
  set:    (k, v) => window.kvSet(k, v),
  multiGet: (arr)=> window.kvMultiGet(arr)
  };


  // mirror helper: salva SEMPRE su localStorage, e SE possibile anche sul server (solo admin)
  global.mirrorToServer = (key, value)=> {
    try{ localStorage.setItem(key, JSON.stringify(value)); }catch{}
    if (global.__ONLINE__ && global.currentUser && global.currentUser.role === 'admin') {
      global.kvSet(key, value).catch(()=>{ /* ignora errori di rete/permessi */ });
    }
  };

  // all’avvio, prova a capire chi sono
  (async function initAuth(){
    await global.apiMe(); // setta currentUser / __ONLINE__
  })();
})(window);

// === Channel & Version (BETA vs STABLE) ===
window.__APP_CHANNEL__ = window.__APP_CHANNEL__ || 'beta'; // 'stable' in produzione
window.__APP_VERSION__ = window.__APP_VERSION__ || '0.8.0-beta.1';
window.__APP_NS__      = (window.__APP_CHANNEL__ === 'beta') ? 'ANIMA_BETA__' : 'ANIMA__';

// RBAC semplice: admin ha sempre accesso
window.hasRole = window.hasRole || function (role) {
  const u = window.__USER || window.currentUser || null;
  if (!u) return false;
  if (u.role === 'admin') return true;
  return String(u.role) === String(role);
};

// ============ LS namespace per separare BETA/STABLE ============
(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

  const NS = window.__APP_NS__ || '';  // es: "ANIMA_BETA__"
  function rawGet(k){ 
    // fallback: se non trovi la chiave namespaced, leggi quella "vecchia"
    const v = localStorage.getItem(NS + k);
    if (v != null) return v;
    return localStorage.getItem(k);
  }
  window.lsGet = window.lsGet || function(k, def){
    try { const v = rawGet(k); return v != null ? JSON.parse(v) : def; } catch { return def; }
  };
  window.lsSet = window.lsSet || function(k, val){
    try { localStorage.setItem(NS + k, JSON.stringify(val)); window.__anima_dirty = true; } catch {}
  };
})();

/* ================== MAGAZZINO: movimenti & giacenze (helper generici) ================== */
(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

  const lsGet = window.lsGet || ((k,d)=>{ try{ const v=JSON.parse(localStorage.getItem(k)); return (v??d);}catch{return d;}});
  const lsSet = window.lsSet || ((k,v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} });

  const MAG_MOV_KEY = 'magMovimenti';          // elenco movimenti magazzino
  const ART_KEY     = 'magazzinoArticoli';     // anagrafica articoli

  // ======================================================================
// ID helper uniforme (DDT/FA/MC): genera PREFIX-YYYY-NNN usando "counters"
// Se esistono nextIdUnique/nextProgressivo, li riusa; altrimenti fallback robusto.
// ======================================================================
window.nextIdFor = window.nextIdFor || function nextIdFor({
  prefix,          // es. 'MC'
  storageKey,      // es. 'magMovimenti'
  seriesKey,       // es. 'MC' (chiave nei counters)
  width = 3        // cifre NNN
}){
  const pad = (n,w)=> String(n).padStart(w,'0');
  const Y = new Date().getFullYear();

  // 1) preferisci nextIdUnique (se presente nel tuo progetto)
  if (typeof window.nextIdUnique === 'function') {
    // NB: nextIdUnique accetta (namespace, prefix, storageKey)
    try {
      const out = window.nextIdUnique(seriesKey || prefix, prefix, storageKey);
      if (out && out.id) return out;
    } catch {}
  }

  // 2) preferisci nextProgressivo (se presente e compatibile)
  if (typeof window.nextProgressivo === 'function') {
    try {
      const { year, num } = window.nextProgressivo(seriesKey || prefix);
      const id = `${prefix}-${year}-${(window.formatNNN ? window.formatNNN(num) : pad(num,width))}`;
      return { id, year, num };
    } catch {}
  }

  // 3) fallback: usa counters + scansione storageKey per allinearti al massimo già usato
  const lsGet = window.lsGet || ((k,d)=>{ try{ return JSON.parse(localStorage.getItem(k)); }catch{return d;} });
  const lsSet = window.lsSet || ((k,v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} });

  // legge massimo già presente nello storage per l'anno corrente
  const all = lsGet(storageKey, []) || [];
  let maxInStore = 0;
  for (const r of all) {
    const m = String(r.id||'').match(new RegExp(`^${prefix}-${Y}-(\\d{${width}})$`));
    if (m) maxInStore = Math.max(maxInStore, parseInt(m[1],10) || 0);
  }

  // legge counters
  let counters = {};
  try { counters = JSON.parse(localStorage.getItem('counters')||'{}') || {}; } catch {}
  const key = seriesKey || prefix;

  let base = 0;
  if (counters[key] && counters[key].year === Y) base = Number(counters[key].num) || 0;
  // allineati al massimo esistente se superiore
  base = Math.max(base, maxInStore);

  const next = base + 1;
  counters[key] = { year: Y, num: next };
  try { localStorage.setItem('counters', JSON.stringify(counters)); } catch {}

  const id = `${prefix}-${Y}-${pad(next,width)}`;
  return { id, year:Y, num:next };
};

// ======================================================================
// Crea un movimento di CARICO da Ordine Fornitore (ID: MC-YYYY-NNN)
// - righeCarico: [{codice, qta, prezzo}] (qta>0)
// - opts: { data, ddtFornitore, note, updateCMP }
//   * updateCMP: se true forza l’aggiornamento CMP; altrimenti usa appSettings.magUpdateCMP
// ======================================================================
window.creaMovimentoCaricoDaOrdine = function(ordine, righeCarico, opts = {}){
  const lsGet = window.lsGet || ((k,d)=>{ try{ return JSON.parse(localStorage.getItem(k)); }catch{return d;} });
  const lsSet = window.lsSet || ((k,v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} });

  const KEYS = (window.__MAG_KEYS__ || { MAG_MOV_KEY:'magMovimenti', ART_KEY:'magArticoli' });
  const MAG_MOV_KEY = KEYS.MAG_MOV_KEY || 'magMovimenti';
  const ART_KEY     = KEYS.ART_KEY     || 'magArticoli'; // nel dubbio: supporto chiave classica

  // normalizza righe
  const lines = (Array.isArray(righeCarico)?righeCarico:[])
    .map(r => ({
      codice: String(r.codice||'').trim(),
      qta: Number(r.qta||0),
      prezzo: Number(r.prezzo||0)
    }))
    .filter(r => r.codice && r.qta>0);

  if (!lines.length) { alert('Nessuna riga valida per il carico.'); return null; }

  // ID MC-YYYY-NNN uniforme
  const { id } = window.nextIdFor({
    prefix: 'MC',
    storageKey: MAG_MOV_KEY,
    seriesKey: 'MC',
    width: 3
  });

  const nowISO = new Date().toISOString();

  const mov = {
    id,
    tipo: 'CARICO',
    data: (opts.data || nowISO.slice(0,10)),
    rifDoc: ordine?.id || '',
    fornitoreId: ordine?.fornitoreId || '',
    ddtFornitore: opts.ddtFornitore || '',
    note: opts.note || '',
    righe: lines,
    createdAt: nowISO,
    updatedAt: nowISO
  };

  // salva movimento
  const movs = lsGet(MAG_MOV_KEY, []) || [];
  movs.push(mov);
  lsSet(MAG_MOV_KEY, movs);

  // aggiorna giacenze (quantità; CMP opzionale)
  const app = (function(){ try{ return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; }catch{return{};} })();
  const finalUpdCMP = !!opts.updateCMP || !!app.magUpdateCMP;

  if (typeof window.applyCaricoToMagazzino === 'function') {
    // delega alla tua routine di magazzino
    window.applyCaricoToMagazzino(mov.righe, { updateCMP: finalUpdCMP });
  } else {
    // fallback minimal: aggiorna solo quantità; NON tocca CMP
    const arts = lsGet(ART_KEY, []) || [];
    mov.righe.forEach(r => {
      const a = arts.find(x => String(x.codice||x.id||'').trim() === r.codice);
      if (a) {
        a.qta = Number(a.qta||0) + Number(r.qta||0);
        a.updatedAt = nowISO;
      }
    });
    lsSet(ART_KEY, arts);
  }

  // sync cloud (best-effort, non blocca)
  try { if (typeof window.syncExportToCloudOnly === 'function') window.syncExportToCloudOnly([MAG_MOV_KEY]); } catch {}
  try { if (typeof window.syncExportToCloudOnly === 'function') window.syncExportToCloudOnly([ART_KEY]); } catch {}

  return mov;
};


  function applyCaricoToMagazzino(righe, {updateCMP=false}={}){
    const articoli = lsGet(ART_KEY, []);
    const indexByCode = new Map(articoli.map((a,i)=>[(a.codice||a.id||`#${i}`), i]));
    righe.forEach(r=>{
      const code = r.codice;
      let idx = indexByCode.get(code);
      if (idx == null) {
        // articolo non presente: crealo minimo
        articoli.push({ codice: code, descrizione: code, um: '', giacenza: Number(r.qta||0), cmp: Number(r.prezzo||0) });
        indexByCode.set(code, articoli.length-1);
      } else {
        const a = articoli[idx];
        const oldQ = Number(a.giacenza||0);
        const oldCMP = Number(a.cmp||0);
        const addQ = Number(r.qta||0);
        const price = Number(r.prezzo||0);
        a.giacenza = oldQ + addQ;
        if (updateCMP) {
          // costo medio ponderato
          const newTot = oldQ*oldCMP + addQ*price;
          const newQ = oldQ + addQ;
          a.cmp = newQ > 0 ? (newTot / newQ) : price;
        }
        articoli[idx] = a;
      }
    });
    lsSet(ART_KEY, articoli);
  }

  // export chiavi per altre view
  window.__MAG_KEYS__ = { MAG_MOV_KEY, ART_KEY };
  // === Ricalcolo giacenze dagli storici (tollerante schema) ===
 window.ricalcolaGiacenzeDaMovimenti = function(){
  const lsGet = window.lsGet || ((k,d)=>{ try{ const v=JSON.parse(localStorage.getItem(k)); return (v??d);}catch{return d;}});
  const lsSet = window.lsSet || ((k,v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} });
  const MOV_KEY = (window.__MAG_KEYS__ && window.__MAG_KEYS__.MAG_MOV_KEY) || 'magMovimenti';
  const ART_KEY = (window.__MAG_KEYS__ && window.__MAG_KEYS__.ART_KEY)     || 'magazzinoArticoli';

  const movs = lsGet(MOV_KEY, []);
  const map = new Map();

  const getLines = (r) => {
    if (Array.isArray(r?.righe)) return r.righe;
    if (Array.isArray(r?.rows)) return r.rows;
    if (Array.isArray(r?.items)) return r.items;
    if (r && (r.codice || r.code)) return [{ codice: r.codice || r.code, qta: r.qta || r.qty || r.quantita || 0, prezzo: r.prezzo || r.price || r.costo || 0 }];
    return [];
  };
  const tipo = (t)=> String(t||'').toUpperCase();

  movs.forEach(m=>{
    const lines = getLines(m);
    const T = tipo(m.tipo);
    lines.forEach(x=>{
      const code = x.codice || x.code || x.articolo || x.id;
      if (!code) return;
      const q = Number(x.qta||x.qty||x.quantita||0) || 0;
      const p = Number(x.prezzo||x.price||x.costo||0) || 0;
      let a = map.get(code) || { codice: code, descrizione: code, um:'', giacenza:0, cmp:0 };
      if (T==='CARICO' || T==='C'){
        const totOld = a.giacenza * a.cmp;
        const newQ = a.giacenza + q;
        a.cmp = newQ > 0 ? (totOld + q*p) / newQ : a.cmp;
        a.giacenza = newQ;
      } else if (T==='SCARICO' || T==='S'){
        a.giacenza = a.giacenza - q;
      }
      map.set(code, a);
    });
  });

  const out = Array.from(map.values());
  lsSet(ART_KEY, out);
  alert(`Ricalcolo completato. Articoli ricostruiti: ${out.length}`);
};
})();
(function mirrorMagazzinoKeys(){
  try{
    const a = JSON.parse(localStorage.getItem('magazzinoArticoli') || 'null');
    const b = JSON.parse(localStorage.getItem('magArticoli') || 'null');
    if (a && !b) localStorage.setItem('magArticoli', JSON.stringify(a));
    if (b && !a) localStorage.setItem('magazzinoArticoli', JSON.stringify(b));
  }catch{}
})();

// === ID unico: salta i numeri già usati su quello store ===
window.nextIdUnique = function (series, prefix, storeKey) {
  const year = new Date().getFullYear();
  let counters = {};
  try { counters = JSON.parse(localStorage.getItem('counters') || '{}') || {}; } catch {}
  let num = (counters[series] && counters[series].year === year && Number.isFinite(counters[series].num))
    ? (counters[series].num + 1) : 1;

  // prendi gli ID già esistenti in quello store (es. 'commesseRows')
  let ids = new Set();
  try {
    const arr = JSON.parse(localStorage.getItem(storeKey) || '[]') || [];
    ids = new Set(arr.map(x => x && x.id).filter(Boolean));
  } catch {}

  let id = `${prefix}-${year}-${String(num).padStart(3,'0')}`;
  while (ids.has(id)) {
    num += 1;
    id = `${prefix}-${year}-${String(num).padStart(3,'0')}`;
  }
  counters[series] = { year, num };
  try { localStorage.setItem('counters', JSON.stringify(counters)); } catch {}
  return { id, year, num };
};
})();

// === Patch anti-crash: normalizza i cleanup di useEffect ===
// Evita l'errore "TypeError: c is not a function" quando qualche effetto ritorna un valore non funzione.
// Non rimuove nulla: si limita a scartare cleanup non validi e loggare un warning.
(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

  try{
    const _ue = React.useEffect;
    const wrap = (fn) => {
      return function wrappedEffect(){
        let cleanup;
        try { cleanup = fn && fn(); }
        catch(err){ console.error('[useEffect body error]:', err); }
        if (cleanup && typeof cleanup !== 'function'){
          console.warn('[useEffect] cleanup non-funzione scartato:', cleanup);
          return undefined;
        }
        return cleanup;
      };
    };
    React.useEffect = (fn, deps) => _ue(wrap(fn), deps);
    if (React.useLayoutEffect){
      const _ule = React.useLayoutEffect;
      React.useLayoutEffect = (fn, deps) => _ule(wrap(fn), deps);
    }
  }catch(err){ console.warn('Patch anti-crash useEffect non applicata:', err); }
})();



// Migrazione contatori: {last} -> {num}
(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

  try {
    const counters = JSON.parse(localStorage.getItem('counters') || '{}') || {};
    let dirty = false;
    Object.keys(counters).forEach(k => {
      const v = counters[k];
      if (v && v.last != null) {
        v.num = Number(v.num ?? v.last) || 0;
        delete v.last;
        dirty = true;
      }
    });
    if (dirty) localStorage.setItem('counters', JSON.stringify(counters));
  } catch {}
})();

// --- salvatore centralizzato: segna dirty + salva ---
function saveKey(k, v){
  if (typeof window.lsSet === 'function') {
    window.lsSet(k, v);              // imposta anche __anima_dirty = true
  } else {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
    window.__anima_dirty = true;
  }
}
// === Loader XLSX globale con fallback locale+CDN ===
window.ensureXLSX = window.ensureXLSX || (function () {
  let p = null;
  return function ensureXLSX() {
    if (window.XLSX) return Promise.resolve();
    if (p) return p;
    p = new Promise((resolve, reject) => {
      const urls = [
        './vendor/xlsx.full.min.js',                                        // locale
        'https://unpkg.com/xlsx@0.19.3/dist/xlsx.full.min.js',              // CDN 1
        'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.19.3/xlsx.full.min.js' // CDN 2
      ];
      const next = () => {
        const src = urls.shift();
        if (!src) return reject(new Error('XLSX non caricato'));
        const s = document.createElement('script');
        s.src = src; s.defer = true;
        s.onload = resolve;
        s.onerror = next;
        document.head.appendChild(s);
      };
      next();
    });
    return p;
  };
})();

// ================== SUPABASE AUTO-SYNC v2 (REST) ==================
(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

   // --- GUARD CONFIG: se non abilitato o credenziali mancanti, esci in silenzio ---
  const __S = (function(){
    try { return JSON.parse(localStorage.getItem('appSettings') || '{}') || {}; }
    catch { return {}; }
  })();

  const __ENABLED = !!__S.cloudEnabled;
  const __URL_OK  = !!(__S.supabaseUrl && String(__S.supabaseUrl).trim());
  const __KEY_OK  = !!(__S.supabaseKey && String(__S.supabaseKey).trim());

  if (!__ENABLED || !__URL_OK || !__KEY_OK) {
  window.__cloudSync__ = { enabled: false };
  return; // blocca auto-sync finché non abiliti e configuri
  }


  const SYNC_KEYS = [
  'appSettings',
  'commesseRows',
  'oreRows',
  'magazzinoArticoli',
  'magMovimenti',
  'fattureRows',
  'ddtRows',
  'counters',
  'clientiRows',
  'fornitoriRows',
  'ordiniFornitoriRows'
 ];
  function getSettings(){
    try { return JSON.parse(localStorage.getItem('appSettings')||'{}') || {}; }
    catch { return {}; }
  }
  function sbReady(cfg){
    return !!(cfg.supabaseUrl && cfg.supabaseKey && (cfg.supabaseTable||'').trim());
  }
  function sbEndpoint(cfg, tail){
    return cfg.supabaseUrl.replace(/\/+$/,'') + tail;
  }
  async function sbRequest(cfg, method, path, body){
    const url = sbEndpoint(cfg, path);
    const headers = {
      'apikey': cfg.supabaseKey,
      'Authorization': 'Bearer ' + cfg.supabaseKey,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    };
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok && res.status !== 406) {
      const txt = await res.text().catch(()=>res.statusText);
      throw new Error(txt || res.statusText);
    }
    try { return await res.json(); } catch { return null; }
  }

  function takeSnapshot(){
    const snap = {};
    for (const k of SYNC_KEYS){
      try { snap[k] = JSON.parse(localStorage.getItem(k) || 'null'); }
      catch { snap[k] = null; }
    }
    return snap;
  }
  function mergeAppSettings(localApp, remoteApp){
  // il remoto sovrascrive SOLO i campi che fornisce
  const out = { ...localApp, ...remoteApp };
  // proteggi array locali se il remoto NON li fornisce
  if (!Array.isArray(remoteApp?.operators) && Array.isArray(localApp?.operators)) {
    out.operators = localApp.operators;
  }
  if (!Array.isArray(remoteApp?.fasiStandard) && Array.isArray(localApp?.fasiStandard)) {
    out.fasiStandard = localApp.fasiStandard;
  }
  return out;
}
  function applySnapshot(snap){
  if (!snap || typeof snap!=='object') return;

  // merge per array di record -> per id con preferenza updatedAt più recente
  const preferNewer = (a, b) => {
    const ta = Date.parse(a?.updatedAt||0) || 0;
    const tb = Date.parse(b?.updatedAt||0) || 0;
    if (ta && tb) return tb >= ta ? b : a;
    if (tb && !ta) return b;
    return a || b;
  };
  const mergeById = (localArr, remoteArr) => {
    const map = new Map();
    (Array.isArray(localArr)?localArr:[]).forEach(x => { if (x && x.id!=null) map.set(x.id, x); });
    (Array.isArray(remoteArr)?remoteArr:[]).forEach(r => {
      if (!r || r.id==null) return;
      const prev = map.get(r.id);
      map.set(r.id, prev ? preferNewer(prev, r) : r);
    });
    return Array.from(map.values());
  };

  // chiavi principali
  const KEYS = [
    'commesseRows','oreRows','magazzinoArticoli','magMovimenti',
    'fattureRows','ddtRows','clientiRows','fornitoriRows','ordiniFornitoriRows'
  ];

  // 1) appSettings: prendi quello con updatedAt più recente
  if ('appSettings' in snap) {
    const localApp = (function(){ try{ return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; }catch{return{}} })();
    const remoteApp = snap.appSettings || {};
    const lt = Date.parse(localApp.updatedAt||0) || 0;
    const rt = Date.parse(remoteApp.updatedAt||0) || 0;
    const nextApp = (rt >= lt) ? mergeAppSettings(localApp, remoteApp)
                           : mergeAppSettings(remoteApp, localApp);
    try { localStorage.setItem('appSettings', JSON.stringify(nextApp)); } catch {}
  }

  // 2) arrays: merge per id
  for (const k of KEYS){
    if (!(k in snap)) continue;
    const local = (function(){ try{ return JSON.parse(localStorage.getItem(k)||'[]') || []; }catch{return[]} })();
    const remote = snap[k];
    const merged = mergeById(local, remote);
    try { localStorage.setItem(k, JSON.stringify(merged)); } catch {}
  }

  // 3) counters: tieni il massimo per ogni serie nello stesso anno
  if ('counters' in snap) {
    const local = (function(){ try{ return JSON.parse(localStorage.getItem('counters')||'{}')||{}; }catch{return{}} })();
    const remote = snap.counters || {};
    const out = { ...local };
    Object.keys(remote).forEach(series=>{
      const r = remote[series] || {};
      const l = local[series] || {};
      if (r.year === l.year) {
        out[series] = { year: r.year, num: Math.max(Number(l.num||0), Number(r.num||0)) };
      } else {
        // scegli il più recente come anno attivo
        const pick = (Number(r.year||0) >= Number(l.year||0)) ? r : l;
        out[series] = { year: Number(pick.year||0), num: Number(pick.num||0) || 0 };
      }
    });
    try { localStorage.setItem('counters', JSON.stringify(out)); } catch {}
  }

  window.__anima_dirty = false;
  }

  async function exportAll(){
    const cfg = getSettings();
    if (!sbReady(cfg)) throw new Error('Config Supabase mancante');
    const tbl = encodeURIComponent(cfg.supabaseTable || 'anima_sync');
    const now = new Date().toISOString();
    const snap = takeSnapshot();

    const rows = Object.keys(snap).map(k => ({
      bucket: 'local',
      k,
      payload: snap[k],
      updated_at: now
    }));

    await sbRequest(cfg, 'POST', `/rest/v1/${tbl}?on_conflict=bucket,k`, rows);
    window.__anima_dirty = false;
    window.__anima_lastPush = Date.now();
    
  }

  async function exportOnly(onlyKeys){
    const cfg = getSettings();
    if (!sbReady(cfg)) throw new Error('Config Supabase mancante');
    const tbl = encodeURIComponent(cfg.supabaseTable || 'anima_sync');
    const now = new Date().toISOString();
    const snap = takeSnapshot();

    const rows = [];
    for (const k of SYNC_KEYS){
      if (!onlyKeys || onlyKeys.includes(k)) {
        rows.push({ bucket:'local', k, payload: snap[k], updated_at: now });
      }
    }
    await sbRequest(cfg, 'POST', `/rest/v1/${tbl}?on_conflict=bucket,k`, rows);
    window.__anima_lastPush = Date.now();
  }

  async function importAll(){
    const cfg = getSettings();
    if (!sbReady(cfg)) throw new Error('Config Supabase mancante');
    const tbl = encodeURIComponent(cfg.supabaseTable || 'anima_sync');
    const data = await sbRequest(cfg, 'GET', `/rest/v1/${tbl}?select=bucket,k,payload,updated_at&bucket=eq.local`);
    if (Array.isArray(data)) {
      const snap = {};
      for (const row of data) { if (row && row.k) snap[row.k] = row.payload; }
      applySnapshot(snap);
    }
  }

  // === Espongo i pulsanti (con alert) ===
  window.testSupabaseConnection = async function(url, key, table){
  // leggo i salvati come fallback
  const saved = (function(){
    try { return JSON.parse(localStorage.getItem('appSettings')||'{}') || {}; } catch { return {}; }
  })();

  const cfg = {
    supabaseUrl:   (url   && String(url).trim())   || saved.supabaseUrl,
    supabaseKey:   (key   && String(key).trim())   || saved.supabaseKey,
    supabaseTable: (table && String(table).trim()) || (saved.supabaseTable || 'anima_sync')
  };

  if (!cfg.supabaseUrl || !cfg.supabaseKey || !cfg.supabaseTable) {
    alert('Config Supabase mancante'); return;
  }

  // piccola GET su 1 riga a caso
  const endpoint = cfg.supabaseUrl.replace(/\/+$/,'') + `/rest/v1/${encodeURIComponent(cfg.supabaseTable)}?select=k&limit=1`;
  try{
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'apikey': cfg.supabaseKey,
        'Authorization': 'Bearer ' + cfg.supabaseKey
      }
    });
    if (!res.ok && res.status !== 406) throw new Error(await res.text().catch(()=>res.statusText));
    alert('Connessione OK ✅');
  }catch(e){
    alert('Errore: ' + (e && e.message ? e.message : String(e)));
  }
  
};

  window.syncExportToCloud = async function(){
  try { await exportAll(); console.info('[cloud] Dati inviati'); }
  catch(e){ console.warn('[cloud] Errore export:', e); }
  };
  // ========== IMPORT CLOUD (override): MERGE per id, niente cancellazioni ==========
function mergeById(localArr, remoteArr){
  const map = new Map((Array.isArray(localArr)?localArr:[]).map(x => [x.id, x]));
  (Array.isArray(remoteArr)?remoteArr:[]).forEach(r => {
    if (!r || r.id == null) return;
    map.set(r.id, { ...(map.get(r.id)||{}), ...r }); // upsert + shallow-merge
  });
  return Array.from(map.values());
}
// (dentro lo stesso IIFE del sync, prima di window.syncImportFromCloud)
window.mergeById = window.mergeById || function(localArr, remoteArr){
  const map = new Map((Array.isArray(localArr)?localArr:[]).map(x => [x.id, x]));
  (Array.isArray(remoteArr)?remoteArr:[]).forEach(r => {
    if (!r || r.id == null) return;
    map.set(r.id, { ...(map.get(r.id)||{}), ...r });
  });
  return Array.from(map.values());
};

window.syncImportFromCloud = async function(){
  const S = JSON.parse(localStorage.getItem('appSettings')||'{}')||{};
  const url = (S.supabaseUrl||'').replace(/\/+$/,'');
  const key = S.supabaseKey;
  const table = S.supabaseTable || 'anima_sync';
  if (!url || !key) { console.info('[cloud] config mancante → skip import'); return; }


  try{
    // ⬇️ seleziona le colonne giuste e filtra il bucket 'local'
    const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?select=bucket,k,payload&bucket=eq.local`, {
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
    });
    if (!res.ok) {
      const t = await res.text().catch(()=> '');
      throw new Error(`HTTP ${res.status}${t ? ' — '+t : ''}`);
    }
    const rows = await res.json();

    // mappa chiave -> payload (non 'v')
    const remote = Object.create(null);
    rows.forEach(r => { remote[r.k] = r.payload; });

    // merge "per id" (usa la helper già definita sopra)
    const localC = JSON.parse(localStorage.getItem('commesseRows')||'[]')||[];
    const cloudC = Array.isArray(remote.commesseRows) ? remote.commesseRows : [];
    localStorage.setItem('commesseRows', JSON.stringify(mergeById(localC, cloudC)));

    ['oreRows','ddtRows','fattureRows','magMovimenti','clientiRows','fornitoriRows','ordiniFornitoriRows'].forEach(k=>{
    if (Array.isArray(remote[k])) {
    const loc = JSON.parse(localStorage.getItem(k)||'[]')||[];
    localStorage.setItem(k, JSON.stringify(mergeById(loc, remote[k])));
    }
    });


    if (remote.appSettings && typeof remote.appSettings === 'object' && !Array.isArray(remote.appSettings)) {
  const localApp  = (function(){ try{ return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; }catch{return{}} })();
  const remoteApp = remote.appSettings || {};
  const lt = Date.parse(localApp.updatedAt || 0)  || 0;
  const rt = Date.parse(remoteApp.updatedAt || 0) || 0;
  const nextApp = (rt >= lt) ? mergeAppSettings(localApp, remoteApp)
                           : mergeAppSettings(remoteApp, localApp);
  localStorage.setItem('appSettings', JSON.stringify(nextApp));
}

    console.info('Import cloud completato (merge, senza cancellazioni).');

  }catch(e){
    console.error(e);
    alert('Errore import cloud: ' + (e && e.message ? e.message : e));
  }
};
  // opzionale: export selettivo senza alert (per timbratura)
  window.syncExportToCloudOnly = async function(keys){
    try { await exportOnly(keys); } catch(e){ console.warn(e); }
  };

  // === Loop automatico SILENZIOSO (niente alert salvo errore) ===
(function autoSyncLoop(){
  const INTERVAL_MS = 15000;
  let lastErrTs = 0; // throttling: max 1 alert ogni 2 minuti

    async function tick(){
    const cfg = getSettings();
    const ready = sbReady(cfg);
    // aggiorna stato visibile in Dashboard
    window.__cloudSync__ = { enabled: !!ready };

    if (!ready) {
      setTimeout(tick, INTERVAL_MS);
      return;
    }
    try {
      // 1) Se ho modifiche locali, spingo PRIMA (evita “resurrezioni”)
      if (window.__anima_dirty) {
        window.__anima_dirty = false;
        await exportAll();
        window.__anima_lastPush = Date.now();
      } else if (!window.__anima_lastPush) {
        // Prima volta: stabilisci una baseline remota
        await exportAll();
        window.__anima_lastPush = Date.now();
      }
      // 2) Poi tiro giù dal cloud
      await importAll();
      window.__anima_lastPull = Date.now();
    } 
         catch(e){
      console.warn('[cloud] auto-sync error:', (e && e.message ? e.message : e));
      window.__cloud_lastErr = e && e.message ? e.message : String(e);
      const now = Date.now();
      if (now - lastErrTs > 120000) {    // 2 minuti
        lastErrTs = now;
        alert('Errore sincronizzazione cloud: ' + (e && e.message ? e.message : String(e)));
      }
    }finally{
      setTimeout(tick, INTERVAL_MS);
    }
  }
  setTimeout(tick, 3000);
})();

})();

// ============ Helpers QR (autonomi, senza dipendenze esterne) ============
function loadScriptOnce(src){
  return new Promise((resolve, reject)=>{
    if ([...document.scripts].some(s=>s.src===src)) return resolve();
    const el = document.createElement('script');
    el.src = src; el.async = true;
    el.onload = ()=> resolve();
    el.onerror = (e)=> reject(e);
    document.head.appendChild(el);
  });
}
// === QR scanner fallback senza HTTPS: foto + jsQR ===
function ensureJsQR(){
  if (window.jsQR) return Promise.resolve();
  return loadScriptOnce('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js');
}

// === Scanner QR unico: camera live se possibile, altrimenti foto+jsQR ===
window.scanQR = (function(){
  // dipendenza opzionale (solo per fallback foto)
  function ensureJsQR(){
    if (window.jsQR) return Promise.resolve();
    return new Promise((resolve, reject)=>{
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
      s.async = true;
      s.onload = resolve;
      s.onerror = ()=>reject(new Error('jsQR non caricato'));
      document.head.appendChild(s);
    });
  }

  async function liveCamera() {
    if (!navigator.mediaDevices || !navigator.isSecureContext || !('BarcodeDetector' in window)) return false;
    try{
      console.info('[scanQR] live camera');
      const det = new window.BarcodeDetector({ formats: ['qr_code'] });
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = document.createElement('video');
      video.playsInline = true; video.srcObject = stream; await video.play();
      const canvas = document.createElement('canvas');
      const step = async ()=>{
        if (video.readyState >= 2) {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0);
          const bmp = await createImageBitmap(canvas);
          const codes = await det.detect(bmp);
          if (codes && codes[0] && codes[0].rawValue) {
            const raw = String(codes[0].rawValue||'').trim();
            stream.getTracks().forEach(t=>t.stop());
            const m = raw.match(/[?#&]job=([^&]+)/i);
            const job = m ? decodeURIComponent(m[1]) : raw;
            console.info('[scanQR] decodificato (live):', raw);
            location.hash = '#/timbratura?job=' + encodeURIComponent(job);
            return;
          }
        }
        requestAnimationFrame(step);
      };
      step();
      return true;
    }catch(e){
      console.warn('[scanQR] live camera error:', e);
      return false;
    }
  }

  async function photoFallback(){
    console.info('[scanQR] fallback foto + jsQR');
    await ensureJsQR();

    return new Promise((resolve)=>{
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment';
      input.style.display = 'none';
      document.body.appendChild(input);

      input.onchange = function(ev){
        const file = ev.target.files && ev.target.files[0];
        if (!file) { document.body.removeChild(input); return resolve(false); }

        const fr = new FileReader();
        fr.onload = function(){
          const img = new Image();
          img.onload = function(){
            var MAX = 1400;
            var scales = [1, 0.75, 0.5, 0.35, 0.25];
            var rots   = [0, 90, 180, 270];

            function tryDecode() {
              var baseW = img.naturalWidth || img.width;
              var baseH = img.naturalHeight || img.height;
              var big = Math.max(baseW, baseH);
              var baseScale = Math.min(1, MAX / big);

              var canvas = document.createElement('canvas');
              var ctx = canvas.getContext('2d', { willReadFrequently: true });

              for (var si = 0; si < scales.length; si++) {
                for (var ri = 0; ri < rots.length; ri++) {
                  var s = baseScale * scales[si];
                  var w0 = Math.max(300, Math.round(baseW * s));
                  var h0 = Math.max(300, Math.round(baseH * s));
                  var r = rots[ri];
                  var rad = r * Math.PI / 180;
                  var rotW = (r % 180 === 0) ? w0 : h0;
                  var rotH = (r % 180 === 0) ? h0 : w0;

                  canvas.width = rotW; canvas.height = rotH;
                  ctx.setTransform(1,0,0,1,0,0);
                  ctx.imageSmoothingEnabled = false;
                  ctx.translate(rotW/2, rotH/2);
                  ctx.rotate(rad);
                  ctx.drawImage(img, -w0/2, -h0/2, w0, h0);
                  ctx.setTransform(1,0,0,1,0,0);

                  var frame = ctx.getImageData(0,0,rotW,rotH);
                  var res = window.jsQR(frame.data, rotW, rotH, { inversionAttempts: 'attemptBoth' });
                  if (res && res.data) return res.data;

                  var side = Math.min(rotW, rotH);
                  var x = Math.floor((rotW  - side)/2);
                  var y = Math.floor((rotH  - side)/2);
                  var crop = ctx.getImageData(x, y, side, side);
                  res = window.jsQR(crop.data, side, side, { inversionAttempts: 'attemptBoth' });
                  if (res && res.data) return res.data;
                }
              }
              return null;
            }

            var text = tryDecode();
            document.body.removeChild(input);

            if (text) {
              var raw = String(text).trim();
              console.info('[scanQR] decodificato (foto):', raw);
              var m = raw.match(/[?#&]job=([^&]+)/i);
              var job = m ? decodeURIComponent(m[1]) : raw;
              location.hash = '#/timbratura?job=' + encodeURIComponent(job);
              return resolve(true);
            } else {
              alert('QR non riconosciuto. Assicurati che sia a fuoco e riempia bene l’inquadratura.');
              return resolve(false);
            }
          };
          img.onerror = function(){ alert('Immagine non valida'); document.body.removeChild(input); resolve(false); };
          img.src = fr.result;
        };
        fr.readAsDataURL(file);
      };

      input.click();
    });
  }

  return async function(){
    // 1) prova camera live; se non parte, 2) prova foto+jsQR; se anche quella fallisce, 3) prompt
    const okLive = await liveCamera();
    if (okLive) return;
    const okPhoto = await photoFallback();
    if (okPhoto) return;

    const v = prompt('Inserisci ID commessa (es. C-2025-012):');
    if (v) location.hash = '#/timbratura?job=' + encodeURIComponent(String(v).trim());
  };
})();

// Prova "qrcode" moderna, poi "qrcodejs" legacy
async function ensureQRCodeLib(){
  if (window.QRCode && (window.QRCode.toCanvas || window.QRCode.prototype)) {
    return (window.QRCode.toCanvas ? 'modern' : 'classic');
  }
  try {
    await loadScriptOnce('https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js');
    if (window.QRCode && window.QRCode.toCanvas) return 'modern';
  } catch {}
  try {
    await loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js');
    if (window.QRCode && window.QRCode.prototype) return 'classic';
  } catch {}
  throw new Error('Impossibile caricare la libreria QR');
}
function makeTimbraturaURL(commessaId){
  const base = location.origin + location.pathname;
  return `${base}#/timbratura?job=${encodeURIComponent(commessaId||'')}`;
}
async function getQRDataURL(text, size=120){
  try{
    const mode = await ensureQRCodeLib();
    if (mode === 'modern' && window.QRCode && window.QRCode.toDataURL){
      return await window.QRCode.toDataURL(String(text), { width: size, margin: 0 });
    }
    if (window.QRCode && window.QRCode.prototype){
      const tmp = document.createElement('div');
      document.body.appendChild(tmp);
      new window.QRCode(tmp, { text:String(text), width:size, height:size, correctLevel: window.QRCode.CorrectLevel.M });
      await new Promise(r => setTimeout(r, 30));
      let dataUrl = null;
      const canvas = tmp.querySelector('canvas'); if (canvas && canvas.toDataURL) dataUrl = canvas.toDataURL('image/png');
      const img = tmp.querySelector('img'); if (!dataUrl && img && img.src) dataUrl = img.src;
      tmp.remove();
      return dataUrl;
    }
  }catch(e){ console.warn('QR gen error', e); }
  return null;
}
async function showQRModal(text){
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;';
  const card = document.createElement('div');
  card.style.cssText = 'background:#fff;border-radius:10px;max-width:90vw;max-height:90vh;padding:16px;display:grid;gap:12px;place-items:center;';
  const title = Object.assign(document.createElement('div'), {textContent:'QR Commessa'});
  title.style.cssText = 'font-weight:600;font-size:16px';
  const holder = document.createElement('div');
  holder.style.cssText = 'width:280px;height:280px;display:grid;place-items:center;border:1px solid #eee;border-radius:8px';
  const msg = Object.assign(document.createElement('div'), {textContent:'Caricamento QR…'});
  msg.style.cssText = 'color:#666;font-size:12px';
  const row = document.createElement('div'); row.style.cssText='display:flex;gap:8px;align-items:center;justify-content:center;';
  const closeBtn = document.createElement('button'); closeBtn.className='btn'; closeBtn.textContent='Chiudi'; closeBtn.onclick=()=>document.body.removeChild(overlay);
  const saveBtn = document.createElement('button'); saveBtn.className='btn btn-outline'; saveBtn.textContent='Scarica PNG'; saveBtn.style.display='none';
  row.append(closeBtn, saveBtn); card.append(title, holder, msg, row); overlay.appendChild(card); document.body.appendChild(overlay);
  try{
    const mode = await ensureQRCodeLib(); msg.textContent='';
    if (mode === 'modern') {
      const canvas = document.createElement('canvas');
      await window.QRCode.toCanvas(canvas, String(text||''), { width: 280, margin: 1 });
      holder.innerHTML = ''; holder.appendChild(canvas); saveBtn.style.display='';
      saveBtn.onclick = ()=>{ canvas.toBlob(b=>{ const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download='commessa-qr.png'; a.click(); URL.revokeObjectURL(a.href); }); };
    } else {
      holder.innerHTML = ''; const div = document.createElement('div'); holder.appendChild(div);
      new window.QRCode(div, { text:String(text||''), width:280, height:280, correctLevel: window.QRCode.CorrectLevel.M });
      saveBtn.style.display='none';
    }
  } catch (err){ msg.textContent='Errore nel generare il QR'; console.error(err); }
}
// === QR CONFIG: genera e applica la configurazione cloud su un dispositivo ===
window.showConfigQR = function(){
  const s = (function(){ try { return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; } catch { return {}; } })();
  const payload = {
    type: 'cfg',
    appSettings: {
      supabaseUrl:   s.supabaseUrl   || '',
      supabaseKey:   s.supabaseKey   || '',
      supabaseTable: s.supabaseTable || 'anima_sync',
      cloudEnabled:  true
    }
  };
  // riusa il modal già presente
  if (typeof window.showQRModal === 'function') {
    window.showQRModal(JSON.stringify(payload));
  } else {
    alert('QR modal non disponibile');
  }
};

// Applica un testo QR (JSON) come configurazione
window.applyConfigFromText = function(raw){
  try {
    const obj = JSON.parse(String(raw||'').trim());
    if (obj && obj.type === 'cfg' && obj.appSettings) {
      const cur  = (function(){ try { return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; } catch { return {}; } })();
      const next = { ...cur, ...obj.appSettings, updatedAt: new Date().toISOString() };
      localStorage.setItem('appSettings', JSON.stringify(next));
      alert('Configurazione salvata ✅\nAvvio import dal cloud…');
      try { window.syncImportFromCloud && window.syncImportFromCloud(); } catch {}
      return true;
    }
  } catch {}
  alert('QR non riconosciuto come configurazione.');
  return false;
};

// Scanner che legge un QR di CONFIG (camera o prompt) e lo applica
window.scanConfigQR = async function(){
  let raw = null;

  // camera non disponibile su http → prompt
  const noCam = !navigator.mediaDevices || !navigator.isSecureContext;
  if (noCam) {
    raw = prompt('Incolla qui il contenuto del QR config (JSON):');
    if (!raw) return;
    window.applyConfigFromText(raw);
    return;
  }

  // Prova BarcodeDetector
  if ('BarcodeDetector' in window) {
    try{
      const det = new window.BarcodeDetector({ formats: ['qr_code'] });
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = document.createElement('video');
      video.playsInline = true; video.srcObject = stream; await video.play();

      const canvas = document.createElement('canvas');
      const scan = async () => {
        if (video.readyState >= 2) {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
          const bmp = await createImageBitmap(canvas);
          const codes = await det.detect(bmp);
          if (codes && codes[0] && codes[0].rawValue) {
            raw = String(codes[0].rawValue||'');
            stream.getTracks().forEach(t=>t.stop());
            window.applyConfigFromText(raw);
            return;
          }
        }
        requestAnimationFrame(scan);
      };
      scan(); return;
    }catch(e){
      // fallback → prompt
    }
  }

  raw = prompt('Incolla qui il contenuto del QR config (JSON):');
  if (!raw) return;
  window.applyConfigFromText(raw);
};

// === MIGRAZIONE counters legacy → nuovo formato ===
(function migrateCounters(){
  let changed = false; let raw;
  try { raw = JSON.parse(localStorage.getItem('counters') || 'null'); } catch {}
  if (!raw || typeof raw !== 'object') return;
  const nowYear = new Date().getFullYear();
  const out = {};
  const ensureObj = (ser, year, last) => { if (!ser) return; const y=Number(year)||nowYear; const l=Number(last)||0; out[ser]={year:y,last:l}; changed=true; };
  const known = ['commesse','ddt','fatture','ore'];
  const yearKeys = Object.keys(raw).filter(k => /^\d{4}$/.test(k));
  if (yearKeys.length) {
    const yKey = yearKeys.sort().pop(); const inner = raw[yKey];
    if (inner && typeof inner === 'object') known.forEach(ser => { if (ser in inner) ensureObj(ser, Number(yKey), Number(inner[ser])); });
  }
  known.forEach(ser => { const v = raw[ser]; if (v && typeof v === 'object' && ('year' in v || 'num' in v)) ensureObj(ser, v.year, v.num); });
  if (!changed) {
    const looksNew = known.some(ser => raw[ser] && typeof raw[ser] === 'object' && 'year' in raw[ser] && 'last' in raw[ser]);
    if (!looksNew) known.forEach(ser => { if (typeof raw[ser] === 'number') ensureObj(ser, nowYear, raw[ser]); });
    else return;
  }
  try { localStorage.setItem('counters', JSON.stringify(out)); } catch {}
})();

// ================== PRINT HEADER (logo + dati azienda) ==================
(function ensurePrintCSS(){
  if (document.getElementById('anima-print-css')) return;
  const css = `
@media screen {.print-only{display:none}}
@media print {
  .no-print{display:none!important}
  .print-only{display:block!important}
  .print-header{display:flex; gap:16px; align-items:center; margin-bottom:12px}
  .print-header .logo{max-width:180px; max-height:60px; object-fit:contain}
  .print-header .info{font-size:12px; line-height:1.3}
  .print-header .title{font-weight:700; font-size:14px}
}`;
  const el = document.createElement('style'); el.id='anima-print-css'; el.textContent=css; document.head.appendChild(el);
})();
function PrintHeader(){
  const e = React.createElement;
   const app = lsGet('appSettings', {}) || {};
  const rows = [];
  if (app.ragioneSociale) rows.push(e('div', {key:'r', className:'title'}, app.ragioneSociale));
  if (app.sedeLegale)     rows.push(e('div', {key:'sl'}, `Sede legale: ${app.sedeLegale}`));
  if (app.sedeOperativa)  rows.push(e('div', {key:'so'}, `Sede operativa: ${app.sedeOperativa}`));
  if (app.pIva || app.email || app.telefono){
    const cont = [app.pIva?`P.IVA/CF: ${app.pIva}`:null, app.email||null, app.telefono||null].filter(Boolean).join(' • ');
    rows.push(e('div', {key:'ct'}, cont));
  }
  return e('div', {className:'print-header print-only'},
    app.logoDataUrl ? e('img', {src:app.logoDataUrl, alt:'Logo', className:'logo'}) : null,
    e('div', {className:'info'}, rows)
  );
}

// ================== Progressivi per anno (peek) ==================
window.COUNTERS_KEY = window.COUNTERS_KEY || 'counters';
function getCounters(){ try { return JSON.parse(localStorage.getItem(window.COUNTERS_KEY) || '{}'); } catch { return {}; } }
function setCounters(obj){ try { localStorage.setItem(window.COUNTERS_KEY, JSON.stringify(obj)); } catch {} }
// NON incrementa: serve solo per mostrare l'anteprima dell'ID senza consumare numeri
function peekNextProgressivo(series){
  const y = new Date().getFullYear();
  const all = getCounters();
  const cur = all[series] || {};
  const next = (cur.year === y) ? ((cur.num || 0) + 1) : 1; // ← usa num, non last
  return { year: y, num: next };
}
// === Crea DDT rapido da commessa (1 riga "pz") =============================
window.createDDTRapidoFromCommessa = function(c){
  try{
    if (!c || !c.id) { alert('Commessa non valida'); return; }
    const lsGet = window.lsGet || ((k,d)=>{ try{ return JSON.parse(localStorage.getItem(k)); }catch{return d;} });
    const lsSet = window.lsSet || ((k,v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} });
    const formatNNN = window.formatNNN || (n=>String(n).padStart(3,'0'));
    const nextProgressivo = window.nextProgressivo || (series => {
      const year = new Date().getFullYear();
      let counters = {}; try{ counters = JSON.parse(localStorage.getItem('counters')||'{}')||{}; }catch{}
      const cur = (counters[series] && counters[series].year === year) ? ((+counters[series].num||0)+1) : 1;
      counters[series] = { year, num: cur }; try{ localStorage.setItem('counters', JSON.stringify(counters)); }catch{}
      return { year, num: cur };
    });

    const today = new Date().toISOString().slice(0,10);
    const rows = lsGet('ddtRows', []) || [];
      const nid = (window.nextIdUnique && window.nextIdUnique('ddt','DDT','ddtRows'))
         || { id: `DDT-${new Date().getFullYear()}-001` };
      const id  = nid.id;


    const colli = Math.max(1, Number(c.colliPrevisti || 1));
    const qta   = Math.max(0, Number(c.qtaPezzi || 0));
    const riga  = {
      codice: c.codiceArticolo || '',
      descrizione: c.descrizione ? String(c.descrizione) : `Lavorazione commessa ${c.id}`,
      qta: qta,
      UM: 'pz',
      note: ''
    };

    const rec = {
      id, data: today,
      clienteId: c.clienteId || '',
      cliente: c.cliente || '',
      commessaRif: c.id,
      note: '',
      colli: String(colli),
      righe: [riga],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    rows.push(rec); lsSet('ddtRows', rows);
    window.__anima_dirty = true;
    alert(`DDT creato: ${id}`);
    try{ window.syncExportToCloudOnly && window.syncExportToCloudOnly(['ddtRows']); }catch{}
  }catch(e){ console.error(e); alert('Errore creazione DDT'); }
};

// === Quantità prodotta/residua — Modello A (pezzi prodotti = min tra fasi) ===
function producedPieces(c){
  const tot = Math.max(1, Number(c?.qtaPezzi || 1));
  const fasi = Array.isArray(c?.fasi) ? c.fasi : [];
  if (!fasi.length) return Number(c?.qtaProdotta || 0) || 0;   // fallback legacy
  const arr = fasi.map(f => Math.max(0, Number(f?.qtaProdotta || 0)));
  const min = Math.min(...arr);
  return Math.max(0, Math.min(tot, min));
}
function residualPieces(c){
  const tot = Math.max(1, Number(c?.qtaPezzi || 1));
  return Math.max(0, tot - producedPieces(c));
}

// ================== Backup / Restore ==================
function makeBackupBlob(){
  const payload = { version: 1, ts: new Date().toISOString(), data: {} };
  for(const k of BACKUP_KEYS){
    try { payload.data[k] = JSON.parse(localStorage.getItem(k) || 'null'); }
    catch { payload.data[k] = null; }
  }
  const str = JSON.stringify(payload, null, 2);
  return new Blob([str], {type:'application/json'});
}
function downloadBackup(){
  const blob = makeBackupBlob();
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  a.href = URL.createObjectURL(blob);
  a.download = `ANIMA-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
async function restoreFromFile(file){
  const txt = await file.text();
  let payload; try { payload = JSON.parse(txt); } catch { alert('Backup non valido'); return; }
  if(!payload || !payload.data){ alert('Backup non valido'); return; }
  for(const k of BACKUP_KEYS){
    const v = (payload.data || {})[k];
    if(typeof v === 'undefined') continue;
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  }
  alert('Ripristino completato ✅\nRicarico la pagina per applicare i dati.');
  location.reload();
}
// Salvataggio robusto su localStorage con messaggio chiaro se va in errore (quota piena, ecc.)
window.safeSetJSON = function(key, value){
  try{
    localStorage.setItem(key, JSON.stringify(value));
    window.__anima_dirty = true;
    return true;
  }catch(e){
    console.error('[LS SAVE]', e);
    alert('Salvataggio non riuscito: dati troppo grandi o memoria del browser piena.\nRiduci il file / abilita il salvataggio cloud.');
    return false;
  }
};
// rende globale il saver robusto per tutti i moduli
window.lsSet = window.safeSetJSON;

/* ================== Widget: Cloud/Supabase status ================== */
function CloudStatusWidget(){
  const e = React.createElement;
  const s = (function(){ try { return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; } catch { return {}; } })();
  const on  = !!(window.__cloudSync__ && window.__cloudSync__.enabled);
  const lastPullTs = window.__anima_lastPull ? new Date(window.__anima_lastPull) : null;
  const lastPushTs = window.__anima_lastPush ? new Date(window.__anima_lastPush) : null;
  const lastErr    = window.__cloud_lastErr || '';

  const fmt = (d)=> d ? `${d.toLocaleDateString()} ${d.toLocaleTimeString()}` : '—';

  return e('div', { className:'card', style:{minWidth:280} },
    e('div', { className:'row', style:{justifyContent:'space-between', alignItems:'center'} },
      e('h3', null, 'Cloud'),
      e('div', { style:{fontWeight:'bold', color: on ? '#1a7f37' : '#b54708'} },
        on ? '● ON' : '● OFF'
      )
    ),
    e('div', { className:'muted' }, s.cloudEnabled ? 'Abilitato' : 'Disabilitato'),
    e('div', { style:{marginTop:8} },
      e('div', null, e('strong', null, 'Ultimo import:'), ' ', fmt(lastPullTs)),
      e('div', null, e('strong', null, 'Ultimo export:'), ' ', fmt(lastPushTs)),
    ),
    lastErr ? e('div', { style:{marginTop:8, color:'#b42318'} }, 'Errore: ', lastErr) : null,
    e('div', { className:'row', style:{gap:8, marginTop:10, flexWrap:'wrap'} },
      e('button', { className:'btn btn-sm', onClick:()=>window.syncImportFromCloud && window.syncImportFromCloud() }, '⬇️ Importa'),
      e('button', { className:'btn btn-sm', onClick:()=>window.syncExportToCloud && window.syncExportToCloud() }, '⬆️ Esporta')
    )
  );
}
// Ordina per data più recente (fallback su createdAt/updatedAt) e poi per id desc
function sortNewestFirst(arr, { dateKeys=['data','dataDocumento','createdAt','updatedAt'], idKey='id' } = {}) {
  return (arr||[]).slice().sort((a,b)=>{
    const maxDate = (o)=> dateKeys.reduce((M,k)=> Math.max(M, Date.parse(o?.[k]||0) || 0), 0);
    const ta = maxDate(a), tb = maxDate(b);
    if (tb !== ta) return tb - ta;
    return String(b?.[idKey]||'').localeCompare(String(a?.[idKey]||''));
  });
}
// ================== STAMPA COMMESSA v2 (layout "foto") ==================
window.stampaCommessaV2 = function (r) {
  try {
    const app = (function(){ try{ return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; }catch{return{}} })();

    // --- helpers ---
    const fmtIT = d => d ? new Date(d).toLocaleDateString('it-IT') : '';
    const pad2 = n => String(n).padStart(2,'0');
    const hhmm2min = s => {
      const m = String(s||'').trim().match(/^(\d{1,3})(?::([0-5]?\d))?$/);
      if (!m) return 0;
      const h = +m[1]||0, mm = +(m[2]||0)||0;
      return h*60+mm;
    };
    const min2hhmm = m => `${pad2(Math.floor((+m||0)/60))}:${pad2((+m||0)%60)}`;

    // campi di comodo/robustezza
      const ID   = r?.id || '';
      const TIT  = r?.tipoArticolo || r?.titolo || r?.descrizione || '';
      const CLIENTE = r?.clienteRagione || r?.cliente || '';
      const PRIO = String(r?.priorita || r?.priority || '').toUpperCase();
      const DUE  = r?.dataConsegna || r?.scadenza || '';
      const PEZZI = +r?.pezziTotali || +r?.qtaPezzi || 0;


    // fasi: accetta [{lav, hhmm}] o varianti
    const fasi = Array.isArray(r?.fasi) ? r.fasi.map((f,i)=>({
      lav:   f.lav || f.nome || f.descr || f.descrizione || `Fase ${i+1}`,
      hhmm:  f.hhmm || f.durata || f.tempo || f.hh || f.min ? (f.hhmm || (f.min? min2hhmm(f.min): '')) : (f.durataHHMM || ''),
    })) : [];

    // ore/pezzo: se mancante, somma delle fasi; ore totali = pezzi * ore/pezzo
    const orePerPezzo = (r?.orePerPezzo && String(r.orePerPezzo)) || (fasi.length ? min2hhmm(fasi.reduce((s,x)=> s + hhmm2min(x.hhmm||0),0)) : '00:00');
    const oreTotPrev  = (r?.oreTotaliPrev && String(r.oreTotaliPrev)) || (PEZZI>0 ? min2hhmm(hhmm2min(orePerPezzo)*PEZZI) : '00:00');

    // materiali: accetta r.materialiPrevisti o r.materiali
    const mats0 = Array.isArray(r?.materialiPrevisti) ? r.materialiPrevisti
                : Array.isArray(r?.materiali) ? r.materiali : [];
    const materiali = mats0.map(m=>({
      codice: String(m.codice||''),
      descr:  String(m.descr||m.descrizione||''),
      um:     String(m.um||''),
      qta:    (m.qta!=null? m.qta : (m.quantita!=null? m.quantita : '')) || '',
      note:   String(m.note||'')
    }));

    // istruzioni: array o testo → bullet; fallback alle fasi.lav
    const istrTxt = r?.istruzioni;
    let istruzioni = [];
    if (Array.isArray(istrTxt)) istruzioni = istrTxt.map(x=>String(x).trim()).filter(Boolean);
    else if (typeof istrTxt === 'string') {
      istruzioni = istrTxt.split(/\r?\n|;|•|- /).map(s=>s.trim()).filter(Boolean);
    } else if (fasi.length) {
      istruzioni = fasi.map(f=>f.lav).filter(Boolean);
    }

    // logo + QR URL
    const logo = app.logoDataUrl || '';
    const qrUrl = (function(){
    try {
    const cfgBase = (app.publicBaseUrl && String(app.publicBaseUrl).trim()) || '';
    if (cfgBase) {
      const base = cfgBase.replace(/\/+$/,''); // niente slash finale
      return `${base}/#\/timbratura?job=${encodeURIComponent(ID)}`;
    }
    // fallback: origin corrente (funziona solo sullo stesso dispositivo)
    const base = location.origin + location.pathname;
    return `${base}#/timbratura?job=${encodeURIComponent(ID)}`;
    } catch { return `#/timbratura?job=${encodeURIComponent(ID)}`; }
    })();


    const css = `
      <style>
        *{box-sizing:border-box}
        body{font-family: Arial, Helvetica, sans-serif; color:#222; margin:20px; font-size:12px;}
        .head{display:grid; grid-template-columns: 1fr 200px; gap:12px; align-items:start;}
        .brand{display:flex; gap:12px; align-items:center;}
        .logo{height:64px; border:1px solid #ddd; padding:4px; border-radius:4px;}
        h1{font-size:18px; margin:0 0 2px;}
        .muted{color:#666;}
        .pill{display:inline-block; font-weight:700;}
        .pill .lab{color:#666; margin-right:4px;}
        .qrwrap{display:flex; flex-direction:column; align-items:flex-end; gap:6px;}
        .qrwrap small{color:#666; word-break:break-all; max-width:200px; text-align:right;}
        .kpis{display:grid; grid-template-columns: repeat(3, 1fr); gap:8px; margin:12px 0;}
        .kpi{border:1px solid #ddd; border-radius:6px; padding:10px;}
        .kpi .lab{font-size:11px; color:#666; margin-bottom:4px;}
        .kpi .val{font-weight:700; font-size:16px;}
        table{width:100%; border-collapse:collapse; margin-top:8px;}
        th,td{border:1px solid #ccc; padding:6px; text-align:left;}
        th{background:#f7f7f7;}
        td.right, th.right{text-align:right;}
        h3{font-size:14px; margin:14px 0 6px;}
        .ibox{border:1px dashed #bbb; border-radius:6px; padding:10px; min-height:48px;}
        ul{margin:6px 0 0 18px;}
        @media print{
          body{margin:16mm;}
          .no-print{display:none!important;}
        }
      </style>
    `;

    const fasiRows = (fasi.length? fasi: []).map((f,i)=>`
      <tr>
        <td class="right">${i+1}</td>
        <td>${f.lav||''}</td>
        <td class="right">${f.hhmm||''}</td>
        <td class="right">${PEZZI||0}</td>
      </tr>
    `).join('');

    const matRows = (materiali.length? materiali: []).map(m=>`
      <tr>
        <td>${m.codice}</td>
        <td>${m.descr}</td>
        <td>${m.um}</td>
        <td class="right">${m.qta}</td>
        <td>${m.note||''}</td>
      </tr>
    `).join('');

    const istrList = (istruzioni.length? `<ul>${istruzioni.map(x=>`<li>${x}</li>`).join('')}</ul>` : '');

    const html = `
      <html>
      <head><meta charset="utf-8">${css}
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js"></script>
      </head>
      <body>
        <div class="head">
          <div>
            <div class="brand">
              ${logo ? `<img class="logo" src="${logo}" alt="logo">` : `<div class="muted">[Logo non impostato]</div>`}
              <div>
                <div style="font-weight:700">${CLIENTE || ''}</div>
                <h1>${TIT || '-'}</h1>
                <div class="pill"><span class="lab">Priorità:</span> ${PRIO||'-'}</div><br>
                <div class="pill"><span class="lab">Consegna prevista:</span> ${fmtIT(DUE)||'-'}</div>
              </div>
            </div>
          </div>
          <div class="qrwrap">
            <div><b>Commessa: ${ID}</b></div>
            <canvas id="qr"></canvas>
            <small>${qrUrl}</small>
          </div>
        </div>

        <div class="kpis">
          <div class="kpi"><div class="lab">Pezzi totali</div><div class="val">${PEZZI||0}</div></div>
          <div class="kpi"><div class="lab">Ore per pezzo (previste)</div><div class="val">${orePerPezzo}</div></div>
          <div class="kpi"><div class="lab">Ore totali (previste)</div><div class="val">${oreTotPrev}</div></div>
        </div>

        <h3>Fasi di lavorazione</h3>
        <table>
          <thead><tr><th class="right">#</th><th>Lavorazione</th><th class="right">HH:MM per fase</th><th class="right">Q.tà</th></tr></thead>
          <tbody>
            ${fasiRows || `<tr><td colspan="4" class="muted">Nessuna fase impostata</td></tr>`}
          </tbody>
        </table>

        <h3>Materiali previsti</h3>
        <table>
          <thead><tr><th>Codice</th><th>Descrizione</th><th>UM</th><th class="right">Q.tà</th><th>Note</th></tr></thead>
          <tbody>
            ${matRows || `<tr><td colspan="5" class="muted">Nessun materiale</td></tr>`}
          </tbody>
        </table>

        <h3>Istruzioni</h3>
        <div class="ibox">
          ${istrList || '<div class="muted">—</div>'}
        </div>

        <script>
          try {
            var c = document.getElementById('qr');
            new QRious({ element: c, value: ${JSON.stringify(''+qrUrl)}, size: 140 });
          } catch(e) { /* ignore */ }
          setTimeout(function(){ window.print(); }, 200);
        </script>
      </body></html>
    `;

    const f = document.createElement('iframe');
    Object.assign(f.style, { position:'fixed', right:0, bottom:0, width:0, height:0, border:0 });
    document.body.appendChild(f);
    const w = f.contentWindow;
    w.document.open(); w.document.write(html); w.document.close(); w.focus();
    setTimeout(()=>{ try{ document.body.removeChild(f); }catch{} }, 1500);
  } catch(e) {
    console.error(e);
    alert('Errore stampa commessa.');
  }
};
// === Scanner QR: usa BarcodeDetector se presente, altrimenti html5-qrcode ===
if (!window.scanQR) window.scanQR = async function(){
  // 1) se il browser NON può usare la camera (HTTP su LAN), cado su prompt
  const needsPrompt = !navigator.mediaDevices || !navigator.isSecureContext;
  if (needsPrompt) {
    const v = prompt('Inserisci ID commessa (es. C-2025-012):');
    if (!v) return;
    location.hash = '#/timbratura?job=' + encodeURIComponent(String(v).trim());
    return;
  }

  // 2) prova BarcodeDetector (se supportato)
  if ('BarcodeDetector' in window) {
    try{
      const det = new window.BarcodeDetector({ formats: ['qr_code'] });
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = document.createElement('video');
      video.playsInline = true; video.srcObject = stream; await video.play();

      const canvas = document.createElement('canvas');
      const scan = async () => {
        if (video.readyState >= 2) {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
          const bitmap = await createImageBitmap(canvas);
          const codes = await det.detect(bitmap);
          if (codes && codes[0] && codes[0].rawValue) {
            const raw = String(codes[0].rawValue || '').trim();
            stream.getTracks().forEach(t=>t.stop());
            // accetto sia ID puro che URL con ?job=
            const m = raw.match(/[?#&]job=([^&]+)/i);
            const job = m ? decodeURIComponent(m[1]) : raw;
            location.hash = '#/timbratura?job=' + encodeURIComponent(job);
            return;
          }
        }
        requestAnimationFrame(scan);
      };
      scan(); return;
    }catch(e){ /* passa al prompt */ }
  }

  // 3) fallback finale: prompt
  const v = prompt('Inserisci ID commessa (es. C-2025-012):');
  if (!v) return;
  location.hash = '#/timbratura?job=' + encodeURIComponent(String(v).trim());
};

window.openEtichetteColliDialog = function(commessa){
  if (!commessa || !commessa.id) { alert('Commessa non valida'); return; }
  const def = Math.max(1, Number(commessa?.colliPrevisti || 1));
  const ans = prompt(`Quanti colli stampare per ${commessa.id}?`, String(def));
  if (ans == null) return;
  const n = Math.max(1, parseInt(ans,10) || def);
  window.printEtichetteColli(commessa, n);
};

// === ETICHETTE COLLI: A4 landscape, 1 collo per pagina, testi molto grandi ===
window.printEtichetteColli = function(commessa, nColli){
  try{
    const html = window.generateEtichetteHTML(commessa, nColli);
    const w = window.open('', '_blank');
    w.document.open(); w.document.write(html); w.document.close();

    function waitAndPrint(doc){
      const imgs = Array.from(doc.images||[]);
      if (imgs.length === 0) { doc.defaultView.focus(); doc.defaultView.print(); return; }
      let done = 0, total = imgs.length, fired = false;
      const tryPrint = ()=> {
        if (!fired) { fired = true; setTimeout(()=>{ doc.defaultView.focus(); doc.defaultView.print(); }, 50); }
      };
      imgs.forEach(img=>{
        if (img.complete) { if (++done>=total) tryPrint(); }
        else {
          img.addEventListener('load', ()=>{ if (++done>=total) tryPrint(); });
          img.addEventListener('error',()=>{ if (++done>=total) tryPrint(); });
        }
      });
      setTimeout(tryPrint, 1500);
    }
    if (w.document.readyState === 'complete') waitAndPrint(w.document);
    else w.addEventListener('load', ()=>waitAndPrint(w.document));
  }catch(e){ console.error(e); alert('Errore stampa etichette'); }
};

window.generateEtichetteHTML = function(c, n){
  // === PATCH C — stampa etichette via iframe (no window.open) ===
  window.printEtichetteHTML = function(html){
    try {
      const fn = (window.safePrintHTMLStringWithPageNum || window.safePrintHTMLString);
      fn(String(html||''));
    } catch(e) { console.warn('printEtichetteHTML:', e); }
  };

  const app      = (function(){ try { return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; } catch { return {}; } })();
  const logo     = app?.logoDataUrl || '';
  const id       = c?.id || '';
  const cliente  = c?.cliente || '';
  const articolo = c?.codiceArticolo || c?.descrizione || '';   // fallback
  const consegna = c?.scadenza ? new Date(c.scadenza).toLocaleDateString('it-IT') : '—';
  const stampato = new Date().toLocaleDateString('it-IT');
  const totPezzi = Math.max(0, Number(c?.qtaPezzi||0));

  // Distribuzione automatica per collo (se conosciamo la q.tà totale)
  const qtyPerCollo = [];
  if (totPezzi > 0 && Number.isFinite(totPezzi)) {
    const base = Math.floor(totPezzi / n);
    let rem = totPezzi % n;
    for (let i = 0; i < n; i++) qtyPerCollo.push(base + (i < rem ? 1 : 0));
  } else {
    // sconosciuto → lascia vuoto (verrà mostrato solo "Q.tà totale: —")
    for (let i = 0; i < n; i++) qtyPerCollo.push(null);
  }

  const pages = [];
  for (let i=1; i<=n; i++){
    const base  = (app?.publicBaseUrl || window.__inferPublicBase__() || '').trim();
    const qrData = base ? `${base}/#/timbratura?job=${encodeURIComponent(id)}` : id;
    const qrURL  = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(qrData)}`;

    const qCollo = qtyPerCollo[i-1];
    pages.push(`
      <section class="page">
        <div class="left">
          ${logo ? `<img class="logo" src="${logo}" alt="logo">` : `<div class="logo ph"></div>`}
          <div class="collo">COLLO <b>${i}/${n}</b></div>

          <div class="cliente">${cliente || '&nbsp;'}</div>
          <div class="articolo">${articolo || '&nbsp;'}</div>

          <div class="info">
            <div><b>Commessa:</b> ${id}</div>
            <div><b>Consegna prevista:</b> ${consegna}</div>
            <div><b>Stampato il:</b> ${stampato}</div>
            <div class="qtys">
              <span><b>Q.tà totale commessa:</b> ${totPezzi ? String(totPezzi) : '—'}</span>
              <span>${qCollo!=null ? `<b>Q.tà collo:</b> ${qCollo}` : ''}</span>
            </div>
          </div>
        </div>
        <div class="right">
          <img class="qr" src="${qrURL}" alt="QR">
        </div>
      </section>
    `);
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Etichette ${id}</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  html, body { height:100%; }
  body { font-family: system-ui, Arial, sans-serif; margin:0; color:#000; }
  .page { width:100%; height:100%; display:flex; align-items:center; justify-content:space-between; page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  .left { flex: 1 1 auto; padding-right: 12mm; display:flex; flex-direction:column; gap:6mm; }
  .right { width: 80mm; display:flex; align-items:center; justify-content:center; }
  .logo { height: 28mm; object-fit:contain; }
  .logo.ph { border:1px solid #000; width: 60mm; height: 28mm; }
  .collo { font-size: 34pt; font-weight: 900; letter-spacing: .5pt; }
  .cliente { font-size: 32pt; font-weight: 800; line-height: 1.1; word-break: break-word; }
  .articolo { font-size: 36pt; font-weight: 900; line-height: 1.05; word-break: break-word; }
  .info { font-size: 16pt; line-height: 1.3; display:grid; gap:4px; }
  .qtys { display:flex; gap:16px; margin-top:4px; }
  .qr { width: 70mm; height: 70mm; }
</style>
</head>
<body>
${pages.join('')}
</body></html>`;
};

// === STAMPA COMMESSA (attende immagini caricate + ore previste) =============
window.printCommessa = function(commessa){
  try{
    const app = (function(){ try { return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; } catch { return {}; } })();
    const html = window.generateCommessaHTML(commessa, app);
    const w = window.open('', '_blank');
    w.document.open(); w.document.write(html); w.document.close();

    // stampa solo quando LOGO/QR sono caricati (risolve anteprima "senza QR")
    function waitAndPrint(doc){
      const imgs = Array.from(doc.images||[]);
      if (imgs.length === 0) { doc.defaultView.focus(); doc.defaultView.print(); return; }
      let done = 0, total = imgs.length, fired = false;
      const tryPrint = ()=> {
        if (!fired) { fired = true; setTimeout(()=>{ doc.defaultView.focus(); doc.defaultView.print(); }, 50); }
      };
      imgs.forEach(img=>{
        if (img.complete) { if (++done>=total) tryPrint(); }
        else {
          img.addEventListener('load', ()=>{ if (++done>=total) tryPrint(); });
          img.addEventListener('error',()=>{ if (++done>=total) tryPrint(); });
        }
      });
      setTimeout(tryPrint, 1500); // fallback
    }
    if (w.document.readyState === 'complete') waitAndPrint(w.document);
    else w.addEventListener('load', ()=>waitAndPrint(w.document));
  }catch(e){ console.error(e); alert('Errore stampa commessa'); }
};

window.generateCommessaHTML = function(c, app){
    // --- html-escape helper locale ---
  const s = v => String(v ?? '').replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]));
  // --- helpers tempo ---
  const toMin = (s) => {
    if (s == null) return 0;
    const m = String(s).trim().match(/^(\d{1,4})(?::([0-5]?\d))?$/);
    if (!m) return 0;
    const h = parseInt(m[1]||'0',10)||0;
    const mm = parseInt(m[2]||'0',10)||0;
    return h*60 + mm;
  };
  const fmtHHMM = (mins) => {
    const t = Math.max(0, Math.round(Number(mins)||0));
    const h = Math.floor(t/60), m=t%60;
    return `${h}:${String(m).padStart(2,'0')}`;
  };
  const deaccent = s => String(s||'')
    .normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim();

  const isOncePhase = (f) => {
    if (f && (f.once === true || f.unaTantum === true)) return true;
    const name = deaccent(f?.lav||'');
    // “preparazione attivita” come chiave
    return /(^|[^a-z])preparazione\s+attivita([^a-z]|$)/.test(name);
  };
  const minsOfPhase = (f) => {
    if (!f) return 0;
    if (Number.isFinite(f.oreMin)) return Math.max(0, Math.round(f.oreMin));
    return toMin(f.oreHHMM);
  };

  // --- dati base ---
  const id        = c?.id || '';
  const data      = new Date().toLocaleDateString('it-IT');
  const cliente   = c?.cliente || '';
  const descr     = c?.descrizione || '';
  const pezzi     = Math.max(1, Number(c?.qtaPezzi||1));
  const scadenza  = c?.scadenza ? new Date(c.scadenza).toLocaleDateString('it-IT') : '';
  const priorita  = c?.priorita || '';
  const istruz    = (c?.istruzioni||'').replace(/\n/g,'<br>');
  const logo      = app?.logoDataUrl || '';
  const azNome    = app?.ragioneSociale || app?.aziendaNome || '';
  const azPiva    = app?.piva || app?.pIva || '';
  const azSede    = app?.sedeOperativa || app?.sedeLegale || '';
  const base  = (app?.publicBaseUrl || window.__inferPublicBase__() || '').trim();
  const qrData = base ? `${base}/#/timbratura?job=${encodeURIComponent(id)}` : id;
  const qrURL  = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(qrData)}`;
  const fasi = Array.isArray(c?.fasi) ? c.fasi : [];
  const mat  = Array.isArray(c?.materiali) ? c.materiali : [];

  // Rif. ordine cliente (accetta stringa o oggetto) — usa la utility globale se presente
  const rifRaw = c?.ordineCliente || c?.nrOrdineCliente || c?.ddtCliente || c?.ordine || c?.ordineId || c?.rifCliente || '';
  const rifCliente = (window.refClienteToText
    ? window.refClienteToText(rifRaw)
    : (typeof rifRaw === 'object'
        ? [
            (rifRaw.tipo || '').toString().trim().toUpperCase(),
            (rifRaw.numero != null ? String(rifRaw.numero) : '').trim(),
            (rifRaw.data ? new Date(rifRaw.data).toLocaleDateString('it-IT') : '')
          ].filter(Boolean).join(' ').trim()
        : String(rifRaw || '')
      )
  );

  // --- calcolo ore previste ---
  let perPieceMins = 0;
  let oneTimeMins  = 0;
  fasi.forEach(f=>{
    const m = minsOfPhase(f);
    if (isOncePhase(f)) oneTimeMins += m;
    else perPieceMins += m;
  });
  const orePerPezzoHHMM = fmtHHMM(perPieceMins);
  const oreTotPrevHHMM  = fmtHHMM(perPieceMins * pezzi + oneTimeMins);

  // --- render fasi/materiali ---
  const fasiRows = fasi.map((f,i)=>`
    <tr>
      <td>${i+1}</td>
      <td>${(f?.lav||'')}${isOncePhase(f) ? ' <span class="tag">una tantum</span>' : ''}</td>
      <td class="right">${fmtHHMM(minsOfPhase(f))}${isOncePhase(f) ? '' : ''}</td>
      <td class="right">${isOncePhase(f) ? '1' : (f?.qtaPrevista!=null ? f.qtaPrevista : pezzi)}</td>
    </tr>
  `).join('');

  const matRows = mat.map((m,i)=>`
    <tr>
      <td>${m?.codice||''}</td>
      <td>${m?.descrizione||''}</td>
      <td>${m?.um||''}</td>
      <td class="right">${m?.qta||0}</td>
      <td>${m?.note||''}</td>
    </tr>
  `).join('');

  // --- HTML ---
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Commessa ${id}</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { font-family: system-ui, Arial, sans-serif; color:#111; }
  .hdr { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:12px; }
  .logo { height: 80px; }
  .az  { font-size:12px; line-height:1.2; margin-top:4px; color:#333; }
  h1 { margin:4px 0 0 0; font-size:22px; }
  .meta { margin:8px 0 14px; font-size:14px; }
  .grid2 { display:grid; grid-template-columns: 1fr 180px; gap:14px; }
  .card { border:1px solid #333; padding:8px; border-radius:6px; }
  table { width:100%; border-collapse:collapse; }
  th, td { border:1px solid #333; padding:6px; font-size:13px; }
  th { background:#f4f4f4; }
  .right { text-align:right; }
  .muted { color:#555; }
  .qr { width:160px; height:160px; }
  .tag { display:inline-block; margin-left:6px; padding:2px 6px; font-size:11px; background:#eee; border:1px solid #bbb; border-radius:10px; }
</style>
</head>
<body>

<div class="hdr">
  <div>
    ${logo ? `<img class="logo" src="${logo}" alt="logo">` : ''}
    <div class="az">${azNome}<br>${azSede}<br>P.IVA: ${azPiva}</div>
  </div>
  <div style="text-align:right">
    <h1>COMMESSA</h1>
    <div class="meta">
      <div><b>ID:</b> ${id}</div>
      <div><b>Data:</b> ${data}</div>
    </div>
  </div>
</div>

<div class="grid2">
  <div class="card">
    <table>
      <tbody>
        <tr><th style="width:200px">Cliente</th><td>${cliente}</td></tr>
        <tr><th>Descrizione / Tipo articolo</th><td>${descr}</td></tr>
        <tr><th>Pezzi totali</th><td>${pezzi}</td></tr>
        <tr><th>Ore/pezzo (previste)</th><td>${orePerPezzoHHMM}</td></tr>
        <tr><th>Ore totali (previste)</th><td>${oreTotPrevHHMM}</td></tr>
        <tr><th>Scadenza</th><td>${scadenza}</td></tr>
        <tr><th>Rif. ordine cliente</th><td>${ s((rifCliente || '').trim()) || '-' }</td></tr>
        <tr><th>Priorità</th><td>${priorita}</td></tr>
      </tbody>
    </table>
  </div>
  <div class="card" style="text-align:right">
    <img class="qr" src="${qrURL}" alt="QR">
    <div class="muted">QR Timbratura</div>
  </div>
</div>

<h3>Fasi di lavorazione</h3>
<table>
  <thead><tr><th>#</th><th>Lavorazione</th><th class="right">Tempo (HH:MM)</th><th class="right">Q.tà</th></tr></thead>
  <tbody>${fasiRows || `<tr><td colspan="4" class="muted">— nessuna fase —</td></tr>`}</tbody>
</table>

<h3 style="margin-top:14px">Materiali previsti</h3>
<table>
  <thead><tr><th>Codice</th><th>Descrizione</th><th>UM</th><th class="right">Q.tà</th><th>Note</th></tr></thead>
  <tbody>${matRows || `<tr><td colspan="5" class="muted">— nessun materiale —</td></tr>`}</tbody>
</table>

<h3 style="margin-top:14px">Istruzioni</h3>
<div class="card">${istruz || '<span class="muted">— nessuna —</span>'}</div>

</body></html>`;
};

// URL pubblico dedotto automaticamente (se sto servendo via http/https)
window.__inferPublicBase__ = function(){
  try {
    const loc = window.location;
    const base = (loc && /^https?:$/i.test(loc.protocol))
      ? (loc.origin + (loc.pathname || '').replace(/\/[^/]*$/,'/'))
      : '';
    return base.replace(/\/+$/,''); // senza slash finale
  } catch { return ''; }
};

window.findClienteDisplay = function(id){
  const arr = (function(){ try{ return JSON.parse(localStorage.getItem('clientiRows')); }catch{return null;} })() || [];
  const row = arr.find(x => String(x.id) === String(id));
  const name = row?.ragioneSociale || row?.denominazione || row?.nome ||
               row?.cliente || row?.ragione || row?.azienda || '';
  return { row, name };
};
// Aggiorna appSettings facendo merge (non cancella campi esistenti)
window.updateAppSettings = function(patch){
  try{
    const cur  = JSON.parse(localStorage.getItem('appSettings')||'{}') || {};
    const next = { ...cur, ...(patch||{}), updatedAt: new Date().toISOString() };
    localStorage.setItem('appSettings', JSON.stringify(next));
    window.__anima_dirty = true;
  }catch(e){ console.error('updateAppSettings', e); }
};

// === Commessa → DDT: prefill completo e robusto ===
window.prefillDDTfromCommessa = function(comm){
  try{
    const lsGet = window.lsGet || ((k,d)=>{ try{ return JSON.parse(localStorage.getItem(k)); }catch{return d;} });
    const today = new Date().toISOString().slice(0,10);

    // cliente
    const clienti = lsGet('clientiRows', []) || [];
    const cli = clienti.find(c => String(c.id) === String(comm.clienteId)) || null;

    const clienteNome =
      comm.cliente ||
      (cli ? (cli.ragione || cli.ragioneSociale || cli.denominazione || cli.nome || '') : '');

    // luogo consegna: priorità commessa, poi anagrafica (sede operativa/indirizzo)
    const luogoConsegna =
      comm.luogoConsegna ||
      (cli && (cli.sedeOperativa || cli.indirizzoOperativo || cli.indirizzo)) || '';

    // riferimenti cliente: nr ordine o nr DDT cliente, ecc.
    const rifCliente =
      comm.rifCliente || comm.ordineCliente || comm.nrOrdineCliente ||
      comm.ddtCliente || comm.po || comm.nrCliente || '';

    // causale trasporto se presente in commessa
    const causaleTrasporto = comm.causaleTrasporto || '';

    // colli/peso se li usi
    const colli = comm.colliPrevisti || comm.colli || '';
    const peso  = comm.pesoPrevisto || comm.peso || '';

    // righe: prova varie forme
    let righe = [];
    if (Array.isArray(comm.righe) && comm.righe.length){
      righe = comm.righe.map(r => ({
        codice:      r.codice || r.code || '',
        descrizione: r.descrizione || r.desc || r.titolo || '',
        qta:         Number(r.qta || r.quantita || 0) || 0,
        UM:          r.UM || r.um || 'PZ',
        note:        r.note || ''
      })).filter(r => String(r.descrizione||'').trim());
    } else if (comm.descrizione) {
      // se la commessa ha una descrizione multilinea, splitta in righe
      String(comm.descrizione).split(/\r?\n/).forEach(line=>{
        const t = String(line||'').trim();
        if (!t) return;
        righe.push({ codice:'', descrizione:t, qta:1, UM:'PZ', note:'' });
      });
    }

    // minimo una riga
    if (!righe.length){
      const qta = Math.max(1, Number(comm.qtaPezzi||1));
      righe = [{
        codice: comm.codiceArticolo || '',
        descrizione: comm.descrizione ? String(comm.descrizione)
                     : `Lavorazione commessa ${comm.id||''}`,
        qta, UM:'PZ', note:''
      }];
    }

    // payload per DDTView
    const pf = {
      data: today,
      clienteId:    comm.clienteId || '',
      cliente:      clienteNome,
      luogoConsegna,
      commessaRif:  comm.id || comm.codice || comm.rif || '',
      rifCliente,
      causaleTrasporto,
      colli: String(colli||''),
      peso:  String(peso||''),
      note:  comm.note || '',
      righe
    };

    localStorage.setItem('prefillDDT', JSON.stringify(pf));
    // apri la vista DDT: la DDTView leggerà 'prefillDDT' e popolerà il form
    location.hash = '#/ddt';
    if (typeof window.setTab === 'function') window.setTab('DDT');
  }catch(e){
    console.error('prefillDDTfromCommessa error:', e);
    alert('Impossibile preparare il DDT dalla commessa.');
  }
};

// === [AUTH BOOTSTRAP] — incollare in cima a beta/app.js ===
(function (global) {
  const e = React.createElement;

  // --- API helper con cookie ---
  async function api(path, opts={}) {
    const res = await fetch(path, { credentials:'include', ...opts });
    if (!res.ok) throw new Error(`API ${path} ${res.status}`);
    return res.json();
  }

  // --- sessione utente ---
  async function whoAmI() {
  // 1) prova Supabase (se configurato)
  try {
    const sb = window.getSupabase && window.getSupabase();
    if (sb) {
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        // mappa ruolo da appSettings.users (se esiste), altrimenti 'admin'
        let role = 'admin';
        try {
          const s = JSON.parse(localStorage.getItem('appSettings') || '{}') || {};
          const m = (s.users || []).find(u =>
            String(u.username || u.email || '').trim().toLowerCase() ===
            String(user.email || '').trim().toLowerCase()
          );
          if (m && m.role) role = m.role;
        } catch {}
        global.__USER = { id: user.id, username: user.email, role };
        return global.__USER;
      }
    }
  } catch {}

  // 2) fallback: vecchio endpoint
  try {
    const j = await api('/api/auth/me');
    global.__USER = j.user || null;
    return global.__USER;
  } catch {
    global.__USER = null;
    return null;
  }
}

  global.isReadOnlyUser = function () { return !!(global.__USER && global.__USER.role === 'accountant'); };
  global.canWrite       = function () { return !(global.__USER && global.__USER.role === 'accountant'); };
  global.logout = async function () {
  // 1) prova a chiudere la sessione Supabase
  try { const sb = window.getSupabase && window.getSupabase(); if (sb) await sb.auth.signOut(); } catch {}

  // 2) fallback: endpoint locale (utile con shim in dev)
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch {}

  global.__USER = null;
  try { window.currentUser = null; } catch {}
  location.hash = '#/login';
  window.dispatchEvent(new CustomEvent('auth-change', { detail: null }));
  return true;
};

  // --- guardia: richiede login ---
  global.requireLogin = async function () {
    const u = await whoAmI();
    if (!u) { if (location.hash !== '#/login') location.hash = '#/login'; throw new Error('unauthenticated'); }
    return u;
  };

  // --- props comodi per disabilitare bottoni in sola lettura ---
  global.roProps = function (title='Sola lettura') { return global.isReadOnlyUser() ? { disabled:true, title } : {}; };

  // --- bootstrap: obbliga login all’avvio ---
  addEventListener('load', async ()=>{
    if (window.__ANIMA_APP_MOUNTED__) return;
  let u = null;
  try { u = await whoAmI(); } catch {}
  // leggi preferenza
  const S = (()=>{ try{ return JSON.parse(localStorage.getItem('appSettings')||'{}')||{} }catch{return{}} })();
  const mustLogin = !!S.authRequired;

  if (mustLogin && !u){
    if (!location.hash || location.hash==='#' || location.hash==='#/') location.hash = '#/login';
    return; // enforcement
  }
  // default offline-friendly
  if (!location.hash || location.hash==='#' || location.hash==='#/') location.hash = '#/ddt';
});

  // --- piccolo badge sessione (facoltativo) ---
  try{
    const box = document.createElement('div');
    Object.assign(box.style,{position:'fixed',right:'8px',bottom:'8px',background:'#222',color:'#fff',padding:'4px 8px',borderRadius:'8px',fontSize:'12px',opacity:.75,zIndex:9999});
    document.addEventListener('DOMContentLoaded', ()=>document.body.appendChild(box));
    (async function refresh(){
      const u = await whoAmI();
      box.textContent = u ? `${u.username} (${u.role})` : 'non autenticato';
      setTimeout(refresh, 30000);
    })();
  }catch{}
})(window);

// === SessionBar (singleton) ===
(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

  if (window.__SESSIONBAR_MOUNTED__) return;
  window.__SESSIONBAR_MOUNTED__ = true;

  const e = React.createElement;

  function formatUserLabel(u){
    if (!u) return '';
    const email = u.email || u.username || u.user || '';
    const role  = (u.role || '').toString().toUpperCase();
    const short = email.split('@')[0] || email;
    return role ? `${role} · ${short}` : short;
  }

  function SessionBar(){
    const [u,setU] = React.useState(window.__USER||null);

    React.useEffect(()=>{
      (async()=>{
        try { await (window.requireLogin && window.requireLogin()); } catch {}
        setU(window.__USER||null);
      })();
      const t = setInterval(()=> setU(window.__USER||null), 3000);
      return ()=>clearInterval(t);
    },[]);

    const label = formatUserLabel(u);

    return e('div', { className:"sessionbar", id:"anima-session" },
      u
        ? e(React.Fragment,null,
            e('div', { className:"sessionbar-info" },
              e('div', { className:"sessionbar-role" }, label || 'Utente'),
              (u.email || u.username)
                ? e('div', { className:"sessionbar-mail" }, u.email || u.username)
                : null
            ),
            e('button', {
              className:"btn btn-outline btn-logout",
              type:"button",
              onClick:()=> window.logout && window.logout()
            }, "Logout")
          )
        : e('button', {
            className:"btn btn-outline btn-login",
            type:"button",
            onClick:()=>{ location.hash = '#/login'; }
          }, "Login")
    );
  }

  // mount: prova a metterlo nella sidebar, in fondo al menu
  let host = document.getElementById('anima-session');
  if (!host) {
    host = document.createElement('div');
    host.id = 'anima-session';
    const sideNav =
      document.querySelector('aside.sidebar nav.nav') ||
      document.querySelector('aside.sidebar') ||
      document.body;

    sideNav.appendChild(host);
  }

  const root = ReactDOM.createRoot(host);
  root.render(e(SessionBar));
})();

/* ================== MAGAZZINO ▸ MOVIMENTI (compat + CSV + ricalcolo + sorting) ================== */
function MagazzinoMovimentiView({ query = '' }) {
  const e = React.createElement;
  const lsGet = window.lsGet || ((k,d)=>{ try{ const v=JSON.parse(localStorage.getItem(k)); return (v??d);}catch{return d;}});
  const MOV_KEY = (window.__MAG_KEYS__ && window.__MAG_KEYS__.MAG_MOV_KEY) || 'magMovimenti';

  const [rows, setRows] = React.useState(()=> lsGet(MOV_KEY, []));
  const [q, setQ] = React.useState(query||'');
  const [da, setDa] = React.useState('');
  const [a,  setA ] = React.useState('');

  React.useEffect(()=>{ setRows(lsGet(MOV_KEY, [])); }, []);

  const getLines = (r) => {
    if (Array.isArray(r?.righe)) return r.righe;
    if (Array.isArray(r?.rows)) return r.rows;
    if (Array.isArray(r?.items)) return r.items;
    if (r && (r.codice || r.code)) return [{ codice: r.codice || r.code, qta: r.qta || r.qty || r.quantita || 0, prezzo: r.prezzo || r.price || r.costo || 0 }];
    return [];
  };
  const tipoStr = (t) => {
    const up = String(t||'').toUpperCase();
    if (up==='C') return 'CARICO';
    if (up==='S') return 'SCARICO';
    return t||'';
  };

  const inRange = (d) => {
    if (!d) return true;
    const t = Date.parse(d);
    const tDa = da ? Date.parse(da) : null;
    const tA  = a  ? Date.parse(a)  : null;
    if (tDa && t < tDa) return false;
    if (tA  && t > (tA + 24*3600*1000 - 1)) return false;
    return true;
  };
  const matches = (r) => {
    const s = (q||'').toLowerCase().trim();
    if (!s) return true;
    const lines = getLines(r);
    const hay = [
      r.id, r.tipo, r.data, r.rifDoc, r.ddtFornitore, r.fornitoreId, r.note,
      ...lines.map(x => `${x.codice||x.code||''}`)
    ].join(' ').toLowerCase();
    return hay.includes(s);
  };

  const filtered = (Array.isArray(rows)?rows:[])
    .filter(r => inRange(r.data) && matches(r))
    .sort((a,b)=>{
      const ta = Date.parse(a.data||0) || 0;
      const tb = Date.parse(b.data||0) || 0;
      if (tb!==ta) return tb-ta;
      return String(b.id).localeCompare(String(a.id));
    });

  const totQ = filtered.reduce((S,r)=> S + getLines(r).reduce((s,x)=> s + Number(x.qta||x.qty||x.quantita||0),0), 0);
  const totRig = filtered.reduce((S,r)=> S + getLines(r).length, 0);

  function exportCSV(){
  const q = v => {
    const s = (v==null ? '' : String(v));
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const header = ['id','data','tipo','rifDoc','fornitore','ddt','codice','qta','prezzo'];
  const lines = [header.join(';')];
  filtered.forEach(r=>{
    const rl = getLines(r);
    if (rl.length===0) {
      lines.push([q(r.id),q(r.data),q(tipoStr(r.tipo)),q(r.rifDoc),q(r.fornitoreId||''),q(r.ddtFornitore||''),q(''),q(0),q(0)].join(';'));
    } else {
      rl.forEach(x=>{
        lines.push([q(r.id),q(r.data),q(tipoStr(r.tipo)),q(r.rifDoc),q(r.fornitoreId||''),q(r.ddtFornitore||''),q(x.codice||x.code||''),q(x.qta||x.qty||x.quantita||0),q(x.prezzo||x.price||x.costo||0)].join(';'));
      });
    }
  });
  const blob = new Blob([lines.join('\n')], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'mag_movimenti.csv'; a.click();
  URL.revokeObjectURL(url);
}

  const doRicalcola = ()=> window.ricalcolaGiacenzeDaMovimenti && window.ricalcolaGiacenzeDaMovimenti();

  return e('div', { className:'container' },
    e('div', { className:'row', style:{gap:12, alignItems:'center', marginBottom:12, flexWrap:'wrap'} },
      e('h2', null, `Movimenti Magazzino (${filtered.length})`),
      e('div',{style:{flex:1}}),
      e('label', null, 'Da: ', e('input', { type:'date', value:da, onChange:ev=>setDa(ev.target.value) })),
      e('label', null, 'A: ',  e('input', { type:'date', value:a,  onChange:ev=>setA(ev.target.value) })),
      e('input', { placeholder:'Cerca…', value:q, onChange:ev=>setQ(ev.target.value), style:{minWidth:220} }),
      e('button', { className:'btn', onClick:exportCSV }, '⬇️ CSV'),
      e('button', { className:'btn btn-outline', onClick:doRicalcola }, '↻ Ricalcola giacenze')
    ),

    e('div', { className:'table-wrap' },
      e('table', { className:'table' },
        e('thead', null, e('tr', null,
          e('th', null, 'ID'), e('th', null, 'Data'), e('th', null, 'Tipo'),
          e('th', null, 'Rif.'), e('th', null, 'Fornitore/DDT'), 
          e('th', null, '#Righe'), e('th', null, 'Q tot.'), e('th', {style:{textAlign:'right'}}, 'Azioni')
        )),
        e('tbody', null,
          filtered.map(r=>{
            const rl = getLines(r);
            const qty = rl.reduce((s,x)=> s + Number(x.qta||x.qty||x.quantita||0),0);
            return e('tr', { key:r.id },
              e('td', null, r.id),
              e('td', null, r.data || ''),
              e('td', null, tipoStr(r.tipo) || ''),
              e('td', null, r.rifDoc || ''),
              e('td', null, (r.fornitoreId||'') + (r.ddtFornitore?(' / '+r.ddtFornitore):'')),
              e('td', null, rl.length),
              e('td', null, qty),
              e('td', {style:{textAlign:'right'}},
                e('button', { className:'btn btn-sm',onClick: ()=> (window.printBollaMagazzino && window.printBollaMagazzino(r))}, '🖨️ Bolla')
              )
            );
          })
        )
      )
    ),

    e('div', { className:'row', style:{gap:8, marginTop:8, justifyContent:'flex-end'} },
      e('button', { className:'btn', onClick:doRicalcola }, '↻ Ricalcola giacenze')
    ),

    e('div', { className:'muted', style:{marginTop:8} },
      `Totale righe: ${totRig} · Totale quantità: ${totQ}`
    )
  );
}
window.MagazzinoMovimentiView = window.MagazzinoMovimentiView || MagazzinoMovimentiView;

(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

  window.printBollaMagazzino = function(mov){
    try{
      const esc = s => String(s==null?'':s).replace(/[<>&]/g, c=>({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c]));
      const fmt2 = n => Number(n||0).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2});
      const app = (function(){ try{ return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; }catch{return{};} })();

      const ars = (function(){ try{ return JSON.parse(localStorage.getItem('magArticoli')||'[]')||[]; }catch{return[];} })();
      const findDesc = code => {
        const a = ars.find(x=> String(x.codice||x.id||'').toLowerCase() === String(code||'').toLowerCase());
        return a?.descrizione || '';
      };

      const tipo = (function(t){ const up=String(t||'').toUpperCase(); return up==='C'?'CARICO':(up==='S'?'SCARICO':(t||'')); })(mov?.tipo);
      const righe = (function(r){
        if (Array.isArray(r?.righe)) return r.righe;
        if (Array.isArray(r?.rows))  return r.rows;
        if (Array.isArray(r?.items)) return r.items;
        if (r && (r.codice || r.code)) return [{ codice:r.codice||r.code, qta:r.qta||r.qty||r.quantita||0, prezzo:r.prezzo||r.price||r.costo||0 }];
        return [];
      })(mov);

      const css = `<style>
        @page { size:A4; margin: 10mm 8mm; }
        *{-webkit-print-color-adjust:exact; print-color-adjust:exact}
        html,body{margin:0;padding:0}
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;color:#0f172a;font-size:12px}
        .hdr{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #0f172a;padding-bottom:8px;margin-bottom:10px}
        .az .rs{font-size:18px;font-weight:800}
        .muted{color:#64748b}
        table{width:100%;border-collapse:collapse;margin-top:8px}
        thead{display:table-header-group}
        th,td{border:1px solid #e2e8f0;padding:6px 8px;vertical-align:top}
        th{background:#f8fafc;font-weight:700}
        .num{text-align:right}
        .ctr{text-align:center}
        .footer{margin-top:12px;display:grid;grid-template-columns:1fr 240px;gap:10px}
        .sign{min-height:40px;border:1px dashed #cbd5e1;padding:10px}
        .pagebox{position:fixed;right:8mm;bottom:10mm;font-size:12px}
        .pageNum[data-mode="css"]::after{content: counter(page) " / " counter(pages)}
      </style>`;

      const header = `
        <div class="hdr">
          <div class="az">
            <div class="rs">${esc(app.ragioneSociale||app.companyName||'')}</div>
            ${app.piva ? `<div class="muted">P.IVA: ${esc(app.piva)}</div>` : ``}
            ${app.sedeLegale ? `<div class="muted">${esc(app.sedeLegale)}</div>` : ``}
          </div>
          <div class="doc">
            <div><b>BOLLA MAGAZZINO — ${esc(tipo||'')}</b></div>
            <div class="muted">Data: ${esc(mov?.data||'')}</div>
            ${mov?.rifDoc ? `<div class="muted">Rif.: ${esc(mov.rifDoc)}</div>` : ``}
            ${(mov?.fornitoreId || mov?.ddtFornitore) ? `<div class="muted">${esc(mov.fornitoreId||'')} ${mov.ddtFornitore?(' / '+esc(mov.ddtFornitore)) : ''}</div>` : ``}
          </div>
        </div>`;

      const bodyRows = righe.map((r,i)=>{
        const code = String(r.codice||'').trim();
        const q    = Number(r.qta||0);
        const pr   = Number(r.prezzo||0);
        const desc = findDesc(code);
        return `<tr>
          <td class="ctr">${i+1}</td>
          <td>${esc(code)}</td>
          <td>${esc(desc||'')}</td>
          <td class="ctr">${q ? q : ''}</td>
          <td class="num">${pr ? fmt2(pr) : ''}</td>
        </tr>`;
      }).join('');

      const table = `
        <table>
          <thead><tr>
            <th style="width:26px" class="ctr">#</th>
            <th style="width:120px">Codice</th>
            <th>Descrizione</th>
            <th style="width:90px" class="ctr">Q.tà</th>
            <th style="width:110px" class="num">Prezzo</th>
          </tr></thead>
          <tbody>${bodyRows || `<tr><td colspan="5" class="muted">— Nessuna riga —</td></tr>`}</tbody>
        </table>`;

      const footer = `
        <div class="footer">
          <div class="grid">
            <div class="box">Vettore: <b>${vettore || '—'}</b></div>
            <div class="box">Aspetto beni: <b>${aspetto || '—'}</b></div>
            <div class="box">Colli: <b>${colli || '—'}</b></div>
            <div class="box">Data/ora: <b>${dataOra || '—'}</b></div>
            <div class="box">Peso netto: <b>${pesoNetto || '—'}</b></div>
            <div class="box">Peso lordo: <b>${pesoLordo || '—'}</b></div>
          </div>
        <div id="pagebox" class="pagebox">Pag. <span class="pageNum" data-mode="css"></span></div>
      </div>`;

      const html = `<!doctype html><html><head><meta charset="utf-8">${css}</head><body>
        ${header}
        ${table}
        ${footer}
      </body></html>`;

      if (window.safePrintHTMLStringWithPageNum) window.safePrintHTMLStringWithPageNum(html);
      else if (window.safePrintHTMLString) window.safePrintHTMLString(html);
      else {
        const ifr = document.createElement('iframe');
        ifr.style.width=ifr.style.height=0; ifr.style.border=0; document.body.appendChild(ifr);
        const d = ifr.contentWindow.document; d.open(); d.write(html); d.close();
        setTimeout(()=>{ try{ ifr.contentWindow.focus(); ifr.contentWindow.print(); }catch{} setTimeout(()=>ifr.remove(),300); }, 200);
      }
    }catch(e){ alert('Errore stampa bolla: ' + (e?.message || e)); }
  };
})();

// === PATCH A — safePrint unificato, idempotente, con cleanup e page numbering fallback ===
(function(){
  // Forza la versione robusta: una sola definizione vincente
  window.safePrintHTMLString = function(html){
    try {
      const ifr = document.createElement('iframe');
      ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      document.body.appendChild(ifr);

      const w = ifr.contentWindow;
      const d = w.document;
      d.open(); d.write(String(html||'')); d.close();

      // fallback numerazione (solo se manca .pageNum via CSS)
      const setupPageNum = ()=>{
        try{
          const pn = d.querySelector('#pagebox .pageNum') || d.querySelector('.pageNum');
          if (!pn) return;
          pn.setAttribute('data-mode','css');
          const pseudo = w.getComputedStyle(pn,'::after').getPropertyValue('content') || '';
          const bad = (!pseudo || !/\d/.test(pseudo));
          if (bad){
            const mmToPx = (() => {
              const t = d.createElement('div');
              t.style.height = '100mm'; t.style.position='absolute'; t.style.visibility='hidden';
              d.body.appendChild(t);
              const px = t.getBoundingClientRect().height||0;
              t.remove(); return px/100;
            })();
            const pageHeightMm = 297 - (16 + 22);
            const pageHeightPx = (mmToPx>0) ? (mmToPx*pageHeightMm) : (w.innerHeight||1123);
            const content = d.querySelector('.content') || d.body;
            const h = Math.max(content.scrollHeight, content.offsetHeight, d.body.scrollHeight);
            const total = Math.max(1, Math.ceil(h / pageHeightPx));
            pn.removeAttribute('data-mode');
            pn.textContent = `1 / ${total}`;
          }
        }catch{}
      };

      setTimeout(()=>{
        try{ setupPageNum(); w.focus(); w.print(); }catch{}
        setTimeout(()=>{ try{ ifr.remove(); }catch{} }, 300);
      },150);
    } catch(e) {
      alert('Errore stampa (safePrintHTMLString): ' + (e?.message || e));
    }
  };
})();
  

/* ================== DASHBOARD (widget: pronte, timbrature oggi, allarmi) ================== */
function DashboardView(){
  const e = React.createElement;

  // ---- Utils LocalStorage (GLOBAL SAFE) ----
  window.lsGet = window.lsGet || function (k, def) {
    try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : def; }
    catch { return def; }
  };
  window.lsSet = window.lsSet || function (k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); window.__anima_dirty = true; } catch {}
  };
  // ⚠️ Non dichiarare più `const lsGet/lsSet` a livello globale

  // ---- Helpers tempo/quantità ----
  const toMin = (s) => {
    if (s == null) return 0;
    const m = String(s).trim().match(/^(\d{1,4})(?::([0-5]?\d))?$/);
    if (!m) return 0;
    const h = parseInt(m[1]||'0',10)||0;
    const mm = parseInt(m[2]||'0',10)||0;
    return h*60+mm;
  };
  const fmtHHMM = (mins) => {
    const t = Math.max(0, Math.round(Number(mins)||0));
    const h = Math.floor(t/60), m=t%60;
    return `${h}:${String(m).padStart(2,'0')}`;
  };
  const todayISO = () => new Date().toISOString().slice(0,10);

  // Modello A: pezzi prodotti = min(qtaProdotta delle fasi)
  function producedPieces(c){
    const tot = Math.max(1, Number(c?.qtaPezzi||1));
    const fasi = Array.isArray(c?.fasi) ? c.fasi : [];
    if (!fasi.length) return Math.max(0, Math.min(tot, Number(c?.qtaProdotta||0) || 0));
    const arr = fasi.map(f => Math.max(0, Number(f?.qtaProdotta||0)));
    if (!arr.length) return 0;
    const min = Math.min(...arr);
    return Math.max(0, Math.min(tot, min));
  }

  // Ore pianificate
  function plannedMinutes(c){
    const fasi = Array.isArray(c?.fasi) ? c.fasi : [];
    const perPezzo = fasi.reduce((s,f)=> s + (Number.isFinite(f?.oreMin) ? Math.max(0, Math.round(f.oreMin)) : toMin(f?.oreHHMM)), 0);
    const tot = perPezzo * Math.max(1, Number(c?.qtaPezzi||1));
    return { perPezzo, tot };
  }

  // Ore effettive registrate (sommatoria ore della commessa)
  function effectiveMinutes(c, oreRows){
    return (Array.isArray(oreRows)?oreRows:[])
      .filter(o => o.commessaId === c.id)
      .reduce((s,o)=> s + (Number(o.oreMin)||toMin(o.oreHHMM)||0), 0);
  }

  // ---- Dati ----
  const commesse = lsGet('commesseRows', []);
  const oreRows  = lsGet('oreRows', []);
  const today    = todayISO();

  // ---- Dataset widget ----
  // 1) Commesse pronte
  const pronte = (Array.isArray(commesse)?commesse:[])
    .map(c => {
      const tot = Math.max(1, Number(c.qtaPezzi||1));
      const prod = producedPieces(c);
      const residuo = Math.max(0, tot - prod);
      return { c, tot, prod, residuo };
    })
    .filter(x => x.residuo === 0)
    .sort((a,b)=>{
      const ma = String(a.c.id||'').match(/^C-(\d{4})-(\d{3})$/);
      const mb = String(b.c.id||'').match(/^C-(\d{4})-(\d{3})$/);
      if (ma && mb){
        const ay=+ma[1], an=+ma[2], by=+mb[1], bn=+mb[2];
        if (by!==ay) return by-ay;
        if (bn!==an) return bn-an;
      }
      const at = Date.parse(a.c.updatedAt||a.c.createdAt||0)||0;
      const bt = Date.parse(b.c.updatedAt||b.c.createdAt||0)||0;
      return bt - at;
    })
    .slice(0, 10);

  // 2) Timbrature di oggi (ultime N)
  const oggiRows = (Array.isArray(oreRows)?oreRows:[])
    .filter(o => (o.data || '').slice(0,10) === today)
    .sort((a,b)=> (Date.parse(b.__createdAt||b.data||0) - Date.parse(a.__createdAt||a.data||0)))
    .slice(0, 12);

  // 3) Allarmi: sforo ore pianificate oppure fermi >24h con residuo >0
  const now = Date.now();
  const allarmi = (Array.isArray(commesse)?commesse:[])
    .map(c => {
      const { tot: planTot } = plannedMinutes(c);
      const effTot = effectiveMinutes(c, oreRows);
      const tot = Math.max(1, Number(c.qtaPezzi||1));
      const prod = producedPieces(c);
      const residuo = Math.max(0, tot - prod);

      const lastRow = (Array.isArray(oreRows)?oreRows:[]).filter(o => o.commessaId === c.id)
        .sort((a,b)=> (Date.parse(b.__createdAt||b.data||0) - Date.parse(a.__createdAt||a.data||0)))[0];
      const lastTime = lastRow ? (Date.parse(lastRow.__createdAt||lastRow.data||0)||0) : 0;
      const fermeMs = lastTime ? (now - lastTime) : Infinity;

      const sforo = (planTot>0 && effTot > planTot + 1);
      const ferme24h = residuo>0 && (fermeMs > 24*3600*1000);

      return sforo || ferme24h ? {
        c, residuo, planTot, effTot,
        cause: [
          sforo ? `SFORO ore: prev. ${fmtHHMM(planTot)} vs eff. ${fmtHHMM(effTot)}` : null,
          ferme24h ? `Ferma da >24h` : null
        ].filter(Boolean).join(' · ')
      } : null;
    })
    .filter(Boolean)
    .sort((a,b)=> {
      const dSforo = (b.effTot - b.planTot) - (a.effTot - a.planTot);
      if (dSforo !== 0 && isFinite(dSforo)) return dSforo;
      return b.residuo - a.residuo;
    })
    .slice(0, 10);

  // ---- UI helper ----
  function opFaseLabel(row){
    const op = row && row.operatore ? row.operatore : '—';
    const idx = row ? row.faseIdx : null;
    if (idx === '' || idx == null) return `${op} – Extra`;
    const c = (Array.isArray(commesse)?commesse:[]).find(x => x.id === row.commessaId);
    const label = (typeof window.faseLabel === 'function')
      ? window.faseLabel(c, Number(idx))
      : `Fase ${(Number(idx)||0)+1}`;
    return `${op} – ${label}`;
  }

  function RowPronta({ x }) {
  const e = React.createElement;
  const c = x?.c || x || {};

  // Calcolo "Rif. cliente" (multi = ordine/DDT, singola = codice)
  const rifCol = (() => {
    if (typeof window.previewDescrAndRef === 'function') {
      const p = window.previewDescrAndRef(c);
      return p.rifCol || '-';
    }
    const righe = Array.isArray(c.righeArticolo) ? c.righeArticolo
               : (Array.isArray(c.righe) ? c.righe : []);
    if (Array.isArray(righe) && righe.length > 1) {
      const ref = c.ordineCliente || c.nrOrdineCliente || c.rifCliente || c.ddtCliente || c.ordine || c.ordineId || '';
      const txt = (window.refClienteToText ? window.refClienteToText(ref) : String(ref||''));
      return txt || `Multi (${righe.length})`;
    } else {
      const r0 = (Array.isArray(righe) && righe[0]) ? righe[0] : null;
      const code = c.articoloCodice || r0?.articoloCodice || r0?.codice || '';
      if (code) return code;
      const ref = c.ordineCliente || c.nrOrdineCliente || c.rifCliente || c.ddtCliente || c.ordine || c.ordineId || '';
      const txt = (window.refClienteToText ? window.refClienteToText(ref) : String(ref||''));
      return txt || '-';
    }
  })();

  return e('tr', null,
    e('td', null, c.id || '-'),
    e('td', null, c.cliente || '-'),
    e('td', null, (function(){
      try{
        // Se esiste il tuo helper, lo riuso per restare coerente
        if (typeof window.previewDescrAndRef === 'function') {
          const p = window.previewDescrAndRef(c);
          const extra = p.rifCol && p.rifCol !== '-' ? ` — ${p.rifCol}` : '';
          return (p.descr || c.descrizione || '-') + extra;
        }

        // Fallback robusto se l’helper non c’è
        const righe = Array.isArray(c.righeArticolo) ? c.righeArticolo
                     : (Array.isArray(c.righe) ? c.righe : []);
        const multi = Array.isArray(righe) && righe.length > 1;

        if (multi) {
          // multi-articolo → Descrizione + n° ordine cliente (se disponibile)
          const ref = c.ordineCliente || c.nrOrdineCliente || c.rifCliente || c.ddtCliente || c.ordine || c.ordineId || '';
          const txt = (window.refClienteToText ? window.refClienteToText(ref) : String(ref||''));
          return (c.descrizione || '-') + (txt ? ` — ${txt}` : '');
        } else {
          // singola riga → Descrizione + codice articolo (se disponibile)
          const r0 = (Array.isArray(righe) && righe[0]) ? righe[0] : null;
          const code = c.articoloCodice || r0?.articoloCodice || r0?.codice || r0?.code || '';
          return (c.descrizione || '-') + (code ? ` — ${code}` : ''); 
        } 
      }catch{
        return (c.descrizione || '-');
      }
    })()),
    e('td', null, rifCol),                // Nuova colonna: Rif. cliente
    e('td', { className:'right' }, String(c.qtaPezzi || 1)),
    e('td', { className:'right' }, '100%')
    );
  }

  function RowToday(o){
    return e('tr', {key:o.id},
      e('td', null, o.id),
      e('td', null, o.commessaId || '-'),
      e('td', null, opFaseLabel(o)),
      e('td', {className:'right'}, fmtHHMM(Number(o.oreMin)||toMin(o.oreHHMM)||0))
    );
  }
  function RowAllarme(a){
    return e('tr', {key:a.c.id},
      e('td', null, a.c.id),
      e('td', null, a.c.cliente || '-'),
      e('td', null, a.c.descrizione || '-'),
      e('td', {className:'right'}, fmtHHMM(a.planTot)),
      e('td', {className:'right'}, fmtHHMM(a.effTot)),
      e('td', null, a.cause)
    );
  }

  // ---- Render ----
  return e('div', {className:'grid', style:{gap:16}},
    e('div', {className:'muted'}, 'Vista PC: avanzamento commesse e scorciatoie utili.'),

    // Widget 1: Commesse pronte
    e('div', {className:'card'},
      e('h3', null, 'Commesse pronte (residuo = 0)'),
      pronte.length === 0
        ? e('div', {className:'muted'}, 'Nessuna commessa pronta.')
        : e('table', {className:'table'},
            e('thead', null, e('tr', null,
              e('th', null, 'ID'),
              e('th', null, 'Cliente'),
              e('th', null, 'Descrizione'),
              e('th', {className:'right'}, 'Pezzi'),
              e('th', {className:'right'}, 'Completamento')
            )),
            e('tbody', null, pronte.map((x,i)=> e(RowPronta, {key:i, x})))
          )
    ),

    // Widget 2: Timbrature di oggi
    e('div', {className:'card'},
      e('h3', null, 'Timbrature di oggi'),
      oggiRows.length === 0
        ? e('div', {className:'muted'}, 'Nessuna timbratura registrata oggi.')
        : e('table', {className:'table'},
            e('thead', null, e('tr', null,
              e('th', null, 'ID reg.'),
              e('th', null, 'Commessa'),
              e('th', null, 'Operatore / Fase'),
              e('th', {className:'right'}, 'Minuti')
            )),
            e('tbody', null, oggiRows.map(RowToday))
          )
    ),

    // Widget 3: Allarmi
    e('div', {className:'card'},
      e('h3', null, 'Allarmi (sforo ore / fermi >24h)'),
      allarmi.length === 0
        ? e('div', {className:'muted'}, 'Nessun allarme.')
        : e('table', {className:'table'},
            e('thead', null, e('tr', null,
              e('th', null, 'ID'),
              e('th', null, 'Cliente'),
              e('th', null, 'Descrizione'),
              e('th', {className:'right'}, 'Ore previste'),
              e('th', {className:'right'}, 'Ore effettive'),
              e('th', null, 'Note')
            )),
            e('tbody', null, allarmi.map(RowAllarme))
          )
    ),
    e(CloudStatusWidget, null)
  );
}
window.DashboardView = DashboardView;


/* ================== ANAGRAFICA CLIENTI (con SDI/PEC/pagamento/IBAN/plafond) ================== */
function ClientiView(){
  const e = React.createElement;

  const blank = {
    id:'', ragione:'', piva:'', email:'',
    sedeLegale:'', sedeOperativa:'',
    codiceUnivoco:'', pec:'',
    pagamento:'Immediato', iban:'', plafond:false, naturaIva:'N3.5 Plafond',
    note:''
  };

  // alias globali
  const lsGet = window.lsGet;
  const lsSet = window.lsSet;

  // stato
  const [rows, setRows] = React.useState(()=> lsGet('clientiRows', []));

  // Persistenza immediata per Clienti
  function persistClienti(next){
    try { localStorage.setItem('clientiRows', JSON.stringify(next)); } catch {}
    setRows(next);
    window.__anima_dirty = true;
    try { if (window.requestAppRerender) window.requestAppRerender(); } catch {}
    // ➜ push selettivo immediato (se il cloud è configurato)
    try { window.syncExportToCloudOnly && window.syncExportToCloudOnly(['clientiRows']); } catch {}
  }

  React.useEffect(()=> lsSet('clientiRows', rows), [rows]);

  // --- selezione righe per elimina bulk ---
  const [sel, setSel] = React.useState({}); // { [id]: true }

  function toggleRow(id){ setSel(p=>({ ...p, [id]: !p[id] })); }

  function toggleAll(list){
    const allOn = (list||[]).every(r=> sel[String(r.id)]);
    if (allOn) {
      const next = {...sel}; (list||[]).forEach(r=> delete next[String(r.id)]);
     setSel(next);
    } else {
      const next = {...sel}; (list||[]).forEach(r=> next[String(r.id)] = true);
     setSel(next);
   }
  }

  function delSelected(){
    const idsSel = Object.keys(sel).filter(k => sel[k]);
    if (!idsSel.length) { alert('Nessuna selezione'); return; }
    if (!confirm(`Eliminare ${idsSel.length} clienti selezionati?`)) return;
    const all = (function(){ try { return JSON.parse(localStorage.getItem('clientiRows')||'[]'); } catch { return []; }})();
    const next = all.filter(x => !idsSel.includes(String(x.id)));
    persistClienti(next);
    setSel({});
    alert('Eliminate selezionate ✅');
  }
  const [q, setQ] = React.useState('');
  const [form, setForm] = React.useState(blank);
  const [editingId, setEditingId] = React.useState(null);
  const [showForm, setShowForm] = React.useState(false);

  function openNew(){ setForm(blank); setEditingId(null); setShowForm(true); }
  function openEdit(id){
    const x = rows.find(r=> String(r.id)===String(id)); if(!x) return;
    setForm({ ...blank, ...x });
    setEditingId(id); setShowForm(true);
  }
  function del(id){
    if (!confirm('Eliminare il cliente?')) return;
    const all = (function(){ try { return JSON.parse(localStorage.getItem('clientiRows')||'[]'); } catch { return []; }})();
    const next = all.filter(x => String(x.id) !== String(id));
    persistClienti(next);
    alert('Cliente eliminato ✅');
  }

  function onChange(ev){
    const {name,value,type,checked}=ev.target;
    setForm(p=>({ ...p, [name]: (type==='checkbox'? checked : value) }));
  }

  function save(){
    // id stabile: se non c’è usa email/piva/ragione o fallback
    const safeId =
      (form.id && String(form.id).trim()) ||
      (form.email && String(form.email).trim()) ||
      (form.piva && String(form.piva).trim()) ||
      (form.ragione && String(form.ragione).trim()) ||
      ('CLI-' + Date.now());

    const rec = { ...form, id: safeId };

    const all = (function(){ try { return JSON.parse(localStorage.getItem('clientiRows')||'[]'); } catch { return []; } })();
    const ix = all.findIndex(x => String(x.id) === String(rec.id));
    if (ix >= 0) all[ix] = rec; else all.push(rec);

    persistClienti(all);
    setShowForm(false);
    alert('Cliente salvato ✅');
  }

  // ===== Import CSV =====
  const fileCliRef = React.useRef(null);

  function csvToObjects(text, delimGuess){
    const delim = delimGuess || (text.indexOf(';')>-1 ? ';' : ',');
    const rows = [];
    let inQ=false, cell='', row=[];
    for(let i=0;i<text.length;i++){
      const ch = text[i];
      if(inQ){
        if(ch==='"'){ if(text[i+1]==='"'){cell+='"'; i++;} else inQ=false; }
        else cell+=ch;
      }else{
        if(ch==='"') inQ=true;
        else if(ch===delim){ row.push(cell); cell=''; }
        else if(ch==='\r'){ /* skip */ }
        else if(ch==='\n'){ row.push(cell); rows.push(row); row=[]; cell=''; }
        else cell+=ch;
      }
    }
    if(cell.length||row.length){ row.push(cell); rows.push(row); }
    if(!rows.length) return [];
    const header = rows[0].map(h=> String(h||'').trim());
    const out = [];
    for(let r=1;r<rows.length;r++){
      const o={}; for(let c=0;c<header.length;c++) o[header[c]] = rows[r][c] ?? '';
      out.push(o);
    }
    return out;
  }

  function normKey(k){
    k = String(k||'').trim().toLowerCase();
    if (k.includes('ragione')) return 'ragione';
    if (k.includes('p.iva') || k.includes('piva') || k.includes('partita')) return 'piva';
    if (k==='email' || k.includes('mail')) return 'email';
    if (k.includes('pec')) return 'pec';
    if (k.includes('codice') && k.includes('univ')) return 'codiceUnivoco';
    if (k.includes('pagamento')) return 'pagamento';
    if (k.includes('iban')) return 'iban';
    if (k.includes('plafond')) return 'plafond';
    if (k.includes('natura') && k.includes('iva')) return 'naturaIva';
    if (k.includes('sede') && k.includes('legale')) return 'sedeLegale';
    if (k.includes('sede') && k.includes('operat')) return 'sedeOperativa';
    if (k.includes('note')) return 'note';
    return k;
  }
  function mapCliente(o){
    const out = {};
    Object.keys(o||{}).forEach(k=>{ out[normKey(k)] = o[k]; });
    out.plafond = (String(out.plafond||'').toLowerCase()==='true' || String(out.plafond||'').toLowerCase()==='si');
    return out;
  }
  function keyCliente(c){
    // chiave di merge: P.IVA se c'è, altrimenti ragione
    return (String(c.piva||'').trim().toLowerCase())
      || ('rag:'+String(c.ragione||'').trim().toLowerCase());
  }

  async function handleClientiImportFile(ev){
    try{
      const file = ev?.target?.files?.[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.csv')) { alert('Importa un CSV (punto e virgola o virgola).'); return; }
      const text = await file.text();
      const rowsX = csvToObjects(text);
      if (!rowsX.length) { alert('Il file non contiene righe'); fileCliRef.current && (fileCliRef.current.value=''); return; }

      const imported = rowsX.map(mapCliente).filter(c=> c.ragione || c.piva);
      if (!imported.length) { alert('Nessun cliente valido'); fileCliRef.current && (fileCliRef.current.value=''); return; }

      // merge con esistenti (usiamo localStorage diretto per coerenza col write atomico)
      const cur = (function(){ try { return JSON.parse(localStorage.getItem('clientiRows')||'[]'); } catch { return []; } })();
      const map = new Map((Array.isArray(cur)?cur:[]).map(c=> [keyCliente(c), c]));

      imported.forEach(c=>{
        const k = keyCliente(c); if (!k) return;
        const old = map.get(k) || {};
        // id stabile: tieni l'esistente se c'è, altrimenti genera
        const id = old.id || ('CLI-' + Date.now().toString(36) + Math.random().toString(36).slice(2,6));
        map.set(k, { ...old, ...c, id });
      });

      const next = Array.from(map.values())
        .sort((a,b)=> String(a.ragione||'').localeCompare(String(b.ragione||'')));

      // 🔐 scrivi SUBITO e aggiorna UI
      persistClienti(next);

      alert(`Import clienti completato: ${imported.length} righe (totale: ${next.length}).`);
      fileCliRef.current && (fileCliRef.current.value='');
    }catch(err){
      console.error(err);
      alert('Errore durante import CSV clienti.');
      fileCliRef.current && (fileCliRef.current.value='');
    }
  }
  function onImportCliClick(){ fileCliRef.current && fileCliRef.current.click(); }

  const filtered = (Array.isArray(rows)?rows:[]).filter(r=>{
    const s = q.trim().toLowerCase(); if(!s) return true;
    return (String(r.ragione||'')+' '+String(r.piva||'')+' '+String(r.email||'')+' '+String(r.note||'')).toLowerCase().includes(s);
  }).sort((a,b)=> String(a.ragione||'').localeCompare(String(b.ragione||'')));

  return e('div', {className:'page'},
    e('div',{className:'toolbar'},
      e('input',{placeholder:'Cerca...',value:q,onChange:ev=>setQ(ev.target.value)}),
      e('button', {className:'btn', onClick:openNew}, '➕ Nuovo cliente'),
      e('button', { className:'btn btn-outline', type:'button', onClick:onImportCliClick }, '⬆️ Importa (.csv)'),
      e('input', { type:'file', accept:'.csv', ref:fileCliRef, style:{display:'none'}, onChange:handleClientiImportFile })
    ),
    showForm && e('form',{
      className:'card',
      onSubmit:(ev)=>{ ev.preventDefault(); save(); },
      style:{ padding:12 }
    },
      e('h3', null, editingId ? `Modifica ${form.ragione||''}` : 'Nuovo cliente'),

      e('div', {
        className:'form',
        style:{ gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))', gap:12 }
      },

        // --- Dati anagrafici ---
        e('div',{className:'form-group-title', style:{gridColumn:'1 / -1'}}, 'Dati anagrafici'),

        e('div',{className:'form-row'},
          e('label', null, 'Ragione sociale'),
          e('input', {
            name:'ragione',
            value:form.ragione||'',
            onChange:onChange,
            placeholder:'es. Rossi Srl'
          })
        ),
        e('div',{className:'form-row'},
          e('label', null, 'Partita IVA'),
          e('input', {
            name:'piva',
            value:form.piva||'',
            onChange:onChange,
            placeholder:'es. 01234567890'
          })
        ),
        e('div',{className:'form-row'},
          e('label', null, 'Email'),
          e('input', {
            name:'email',
            type:'email',
            value:form.email||'',
            onChange:onChange,
            placeholder:'es. amministrazione@cliente.it'
          })
        ),

        e('div',{className:'form-row form-row-full'},
          e('label', null, 'Sede legale'),
          e('input', {
            name:'sedeLegale',
            value:form.sedeLegale||'',
            onChange:onChange,
            placeholder:'via, CAP, città, provincia'
          })
        ),
        e('div',{className:'form-row form-row-full'},
          e('label', null, 'Sede operativa'),
          e('input', {
            name:'sedeOperativa',
            value:form.sedeOperativa||'',
            onChange:onChange,
            placeholder:'se diversa dalla sede legale'
          })
        ),

        // --- Fatturazione elettronica / fiscali ---
        e('div',{className:'form-group-title', style:{gridColumn:'1 / -1', marginTop:4}}, 'Dati fiscali e fatturazione elettronica'),

        e('div',{className:'form-row'},
          e('label', null, 'Codice Univoco SDI'),
          e('input', {
            name:'codiceUnivoco',
            value:form.codiceUnivoco||'',
            onChange:onChange,
            placeholder:'es. ABCDEF1'
          })
        ),
        e('div',{className:'form-row'},
          e('label', null, 'PEC'),
          e('input', {
            name:'pec',
            value:form.pec||'',
            onChange:onChange,
            placeholder:'es. azienda@pec.it'
          })
        ),
        e('div',{className:'form-row'},
          e('label', null, 'Pagamento (predefinito)'),
          e('input', {
            name:'pagamento',
            value:form.pagamento||'',
            onChange:onChange,
            placeholder:'es. Rimessa diretta 30 gg'
          })
        ),
        e('div',{className:'form-row'},
          e('label', null, 'IBAN / coordinate bancarie'),
          e('input', {
            name:'iban',
            value:form.iban||'',
            onChange:onChange,
            placeholder:'es. IT00A0000000000000000000000'
          })
        ),

        e('div',{className:'form-row form-row-full'},
          e('label', {className:'row', style:{gap:8, alignItems:'center', marginTop:4}},
            e('input', {
              type:'checkbox',
              name:'plafond',
              checked:!!form.plafond,
              onChange:onChange
            }),
            e('span', null, 'Cliente a plafond (IVA 0)')
          )
        ),
        e('div',{className:'form-row'},
          e('label', null, 'Natura IVA (se plafond)'),
          e('input', {
            name:'naturaIva',
            value:form.naturaIva||'',
            onChange:onChange,
            placeholder:'es. N3.5 – operazioni non imponibili'
          })
        ),

        // --- Note ---
        e('div',{className:'form-row form-row-full'},
          e('label', null, 'Note interne'),
          e('textarea', {
            name:'note',
            value:form.note||'',
            onChange:onChange,
            rows:2,
            placeholder:'Note sul cliente, condizioni particolari…'
          })
        )
      ),

      e('div',{className:'actions', style:{justifyContent:'flex-end', gap:8, marginTop:8}},
        e('button',{
          type:'button',
          className:'btn btn-outline',
          onClick:()=>{ setShowForm(false); setEditingId(null); }
        }, 'Annulla'),
        e('button',{className:'btn', type:'submit'}, 'Salva')
      )
    ),

    e('div',{className:'card',style:{marginTop:8,overflowX:'auto'}},
      e('table',{className:'table'},
        e('thead', null, e('tr', null,
    e('th', {style:{width:36, textAlign:'center'}},
      e('input', {
        type:'checkbox',
        ref: el => { if (el) el.indeterminate = (filtered.some(c=>sel[String(c.id)]) && !filtered.every(c=>sel[String(c.id)])); },
        checked: (filtered.length>0 && filtered.every(c=>sel[String(c.id)])),
        onChange: () => toggleAll(filtered)
      })
    ),
    e('th', null, 'Ragione sociale'),
    e('th', null, 'P.IVA'),
    e('th', null, 'Email'),
    e('th', {style:{width:220}},
      e('div', {className:'row', style:{justifyContent:'space-between', gap:8}},
        e('span', null, 'Azioni'),
        e('button', {
           className:'btn btn-outline',
          disabled: Object.keys(sel).filter(k=>sel[k]).length===0,
          onClick: delSelected
        }, '🗑 Elimina selezionati')
      )
    )
  )),
        e('tbody',null,
          filtered.map(c=> e('tr',{key:c.id},
            e('td',{style:{textAlign:'center'}},
              e('input',{
               type:'checkbox',
                checked: !!sel[String(c.id)],
                onChange: ()=> toggleRow(String(c.id))
              })
            ),
            e('td',null,c.ragione||''),
            e('td',null,c.piva||''),
            e('td',null,c.email||'-'),
            e('td',null,
              e('button',{className:'btn btn-outline',onClick:()=>openEdit(c.id)},'Apri'),' ',
              e('button',{className:'btn btn-outline',onClick:()=>del(c.id)},'🗑')
            )
          ))
        )
      )
    )
  );
}
window.ClientiView = ClientiView;

/* ================== FORNITORI ================== */
function FornitoriView(){
  const e = React.createElement;
  const lsGet = window.lsGet, lsSet = window.lsSet;

  // aggiunti: cf, pec, telefono, fax, codiceUnivoco, banca, iban, intestatario
  const blank = {
    id:'',
    ragione:'',
    sedeLegale:'',
    sedeOperativa:'',
    piva:'',
    cf:'',
    email:'',
    pec:'',
    telefono:'',
    fax:'',
    codiceUnivoco:'',
    banca:'',
    iban:'',
    intestatario:'',
    note:''
  };

  const [rows, setRows] = React.useState(() => lsGet('fornitoriRows', []));

  function persistFornitori(next){
    try { localStorage.setItem('fornitoriRows', JSON.stringify(next)); } catch {}
    setRows(next);
    window.__anima_dirty = true;
    try { if (window.requestAppRerender) window.requestAppRerender(); } catch {}
    try { window.syncExportToCloudOnly && window.syncExportToCloudOnly(['fornitoriRows']); } catch {}
  }

  React.useEffect(() => lsSet('fornitoriRows', rows), [rows]);

  // --- selezione righe per elimina bulk ---
  const [sel, setSel] = React.useState({}); // { [id]: true }

  function toggleRow(id){ setSel(p=>({ ...p, [id]: !p[id] })); }

  function toggleAll(list){
    const allOn = (list||[]).every(r=> sel[String(r.id)]);
    if (allOn) {
      const next = {...sel}; (list||[]).forEach(r=> delete next[String(r.id)]);
      setSel(next);
    } else {
      const next = {...sel}; (list||[]).forEach(r=> next[String(r.id)] = true);
      setSel(next);
    }
  }

  function delSelected(){
    const idsSel = Object.keys(sel).filter(k => sel[k]);
    if (!idsSel.length) { alert('Nessuna selezione'); return; }
    if (!confirm(`Eliminare ${idsSel.length} fornitori selezionati?`)) return;
    const all = (function(){ try { return JSON.parse(localStorage.getItem('fornitoriRows')||'[]'); } catch { return []; }})();
    const next = all.filter(x => !idsSel.includes(String(x.id)));
    persistFornitori(next);
    setSel({});
    alert('Eliminate selezionate ✅');
  }

  const [q, setQ] = React.useState('');
  const [form, setForm] = React.useState(blank);
  const [editingId, setEditingId] = React.useState(null);
  const [showForm, setShowForm] = React.useState(false);

  function openNew(){
    setForm(blank);
    setEditingId(null);
    setShowForm(true);
  }

  function openEdit(id){
    const x = rows.find(r => r.id === id);
    if(!x) return;
    setForm({ ...blank, ...x });
    setEditingId(id);
    setShowForm(true);
  }

  function onChange(ev){
    const {name, value} = ev.target;
    setForm(p => ({...p, [name]: value}));
  }

  function save(ev){
    ev && ev.preventDefault();
    if (!form.ragione.trim()) { alert('Inserisci la ragione sociale'); return; }

    const rec = {...form};
    rec.id = editingId ? editingId : 'FO-'+Math.random().toString(36).slice(2,8).toUpperCase();

    const next = rows
      .filter(r => r.id !== rec.id)
      .concat(rec)
      .sort((a,b)=> (a.ragione||'').localeCompare(b.ragione||''));

    persistFornitori(next);
    setShowForm(false);
    setEditingId(null);
  }

  function del(id){
    if (!confirm('Eliminare il fornitore?')) return;
    const all = (function(){ try { return JSON.parse(localStorage.getItem('fornitoriRows')||'[]'); } catch { return []; }})();
    const next = all.filter(x => String(x.id) !== String(id));
    persistFornitori(next);
    alert('Fornitore eliminato ✅');
  }

  const filtered = rows
    .filter(r => {
      const s = q.toLowerCase();
      return (
        (String(r.ragione||'')+' '+
         String(r.piva||'')+' '+
         String(r.cf||'')+' '+
         String(r.email||'')+' '+
         String(r.pec||'')+' '+
         String(r.telefono||'')+' '+
         String(r.fax||'')+' '+
         String(r.codiceUnivoco||'')+' '+
         String(r.sedeLegale||'')+' '+
         String(r.sedeOperativa||'')+' '+
         String(r.banca||'')+' '+
         String(r.iban||'')+' '+
         String(r.intestatario||'')+' '+
         String(r.note||'')
        ).toLowerCase().includes(s)
      );
    })
    .sort((a,b)=> String(a.ragione||'').localeCompare(String(b.ragione||'')));

  return e('div',{className:'page'},
    // toolbar
    e('div',{className:'toolbar'},
      e('input',{placeholder:'Cerca...', value:q, onChange:ev=>setQ(ev.target.value)}),
      e('button',{className:'btn', onClick:openNew}, '➕ Nuovo fornitore')
    ),

    // TABELLONE: solo i campi che vuoi tu
    e('div', {className:'card', style:{overflowX:'auto'}},
      e('table', {className:'table'},
        e('thead', null, e('tr', null,
          e('th', {style:{width:36, textAlign:'center'}},
            e('input', {
              type:'checkbox',
              ref: el => {
                if (el) {
                  el.indeterminate = (filtered.some(r=>sel[String(r.id)]) && !filtered.every(r=>sel[String(r.id)]));
                }
              },
              checked: (filtered.length>0 && filtered.every(r=>sel[String(r.id)])),
              onChange: () => toggleAll(filtered)
            })
          ),
          e('th', null, 'Ragione sociale'),
          e('th', null, 'Sede legale'),
          e('th', null, 'Sede operativa'),
          e('th', null, 'P.IVA'),
          e('th', null, 'Telefono'),
          e('th', null, 'Email'),
          e('th', {style:{width:220}},
            e('div', {className:'row', style:{justifyContent:'space-between', gap:8}},
              e('span', null, 'Azioni'),
              e('button', {
                className:'btn btn-outline',
                disabled: Object.keys(sel).filter(k=>sel[k]).length===0,
                onClick: delSelected
              }, '🗑 Elimina selezionati')
            )
          )
        )),
        e('tbody', null,
          filtered.map(r => e('tr', {key:r.id || r.ragione},
            e('td', {style:{textAlign:'center'}},
              e('input', {
                type:'checkbox',
                checked: !!sel[String(r.id)],
                onChange: ()=> toggleRow(String(r.id))
              })
            ),
            e('td', null,
              r.ragione||'',
              (!((r.piva||'').trim() || (r.cf||'').trim())
                ? e('span',{className:'badge badge-warn',style:{marginLeft:6}},'⚠︎ dati fiscali')
                : null)
            ),
            e('td', null, r.sedeLegale||''),
            e('td', null, r.sedeOperativa||''),
            e('td', null, r.piva||''),
            e('td', null, r.telefono||''),
            e('td', null, r.email||''),
            e('td', null,
              e('button', {className:'btn btn-outline', onClick:()=>openEdit(r.id)}, '✏️'),
              ' ',
              e('button', {className:'btn btn-outline', onClick:()=>del(r.id)}, '🗑')
            )
          ))
        )
      )
    ),

    // FORM: con i <div> wrapper per non sfasare la griglia
    showForm && e('form', {
      className:'card',
      onSubmit:save,
      style:{ marginTop:8, padding:12 }
    },
      e('h3', null, editingId ? `Modifica ${form.ragione||''}` : 'Nuovo fornitore'),

      e('div', {className:'form'},

        // --- Dati anagrafici ---
        e('div',{className:'form-group-title', style:{gridColumn:'1 / -1'}}, 'Dati anagrafici'),

        e('div',{className:'form-row'},
          e('label', null, 'Ragione sociale'),
          e('input', {
            name:'ragione',
            value:form.ragione||'',
            onChange:onChange,
            placeholder:'es. Carpenteria Rossi Srl'
          })
        ),
        e('div',{className:'form-row form-row-full'},
          e('label', null, 'Sede legale'),
          e('input', {
            name:'sedeLegale',
            value:form.sedeLegale||'',
            onChange:onChange,
            placeholder:'via, CAP, città, provincia'
          })
        ),
        e('div',{className:'form-row form-row-full'},
          e('label', null, 'Sede operativa'),
          e('input', {
            name:'sedeOperativa',
            value:form.sedeOperativa||'',
            onChange:onChange,
            placeholder:'se diversa dalla sede legale'
          })
        ),

        // --- Contatti ---
        e('div',{className:'form-group-title', style:{gridColumn:'1 / -1', marginTop:4}}, 'Contatti'),

        e('div',{className:'form-row'},
          e('label', null, 'Email'),
          e('input', {
            name:'email',
            type:'email',
            value:form.email||'',
            onChange:onChange,
            placeholder:'es. ufficio@fornitore.it'
          })
        ),
        e('div',{className:'form-row'},
          e('label', null, 'PEC'),
          e('input', {
            name:'pec',
            value:form.pec||'',
            onChange:onChange,
            placeholder:'es. fornitore@pec.it'
          })
        ),
        e('div',{className:'form-row'},
          e('label', null, 'Telefono'),
          e('input', {
            name:'telefono',
            value:form.telefono||'',
            onChange:onChange
          })
        ),
        e('div',{className:'form-row'},
          e('label', null, 'Fax'),
          e('input', {
            name:'fax',
            value:form.fax||'',
            onChange:onChange
          })
        ),

        // --- Dati fiscali ---
        e('div',{className:'form-group-title', style:{gridColumn:'1 / -1', marginTop:4}}, 'Dati fiscali'),

        e('div',{className:'form-row'},
          e('label', null, 'Partita IVA'),
          e('input', {
            name:'piva',
            value:form.piva||'',
            onChange:onChange,
            placeholder:'es. 01234567890'
          })
        ),
        e('div',{className:'form-row'},
          e('label', null, 'Codice Fiscale'),
          e('input', {
            name:'cf',
            value:form.cf||'',
            onChange:onChange
          })
        ),
        e('div',{className:'form-row'},
          e('label', null, 'Codice Univoco SDI'),
          e('input', {
            name:'codiceUnivoco',
            value:form.codiceUnivoco||'',
            onChange:onChange
          })
        ),

        // --- Dati bancari ---
        e('div',{className:'form-group-title', style:{gridColumn:'1 / -1', marginTop:4}}, 'Dati bancari'),

        e('div',{className:'form-row'},
          e('label', null, 'Banca'),
          e('input', {
            name:'banca',
            value:form.banca||'',
            onChange:onChange
          })
        ),
        e('div',{className:'form-row'},
          e('label', null, 'IBAN'),
          e('input', {
            name:'iban',
            value:form.iban||'',
            onChange:onChange,
            placeholder:'es. IT00A0000000000000000000000'
          })
        ),
        e('div',{className:'form-row'},
          e('label', null, 'Intestatario conto'),
          e('input', {
            name:'intestatario',
            value:form.intestatario||'',
            onChange:onChange
          })
        ),

        // --- Note ---
        e('div',{className:'form-row form-row-full'},
          e('label', null, 'Note interne'),
          e('textarea', {
            name:'note',
            value:form.note||'',
            onChange:onChange,
            rows:2
          })
        )
      ),

      e('div',{className:'actions', style:{justifyContent:'flex-end', gap:8, marginTop:8}},
        e('button',{
          type:'button',
          className:'btn btn-outline',
          onClick:()=>{ setShowForm(false); setEditingId(null); setForm(blank); }
        }, 'Annulla'),
        e('button',{className:'btn', type:'submit'}, 'Salva')
      )
    ),
  );
}

window.FornitoriView = FornitoriView;


// ================== QR + STAMPA COMMESSA (definitivo) ==================

function makeQRDataUrl(text, size = 140){
  return new Promise((resolve, reject) => {
    if (!window.QRCode) return reject(new Error('QRCode library non caricata'));
    const holder = document.createElement('div');
    holder.style.position = 'fixed';
    holder.style.left = '-99999px';
    holder.style.top = '0';
    document.body.appendChild(holder);
    try {
      new QRCode(holder, { text, width:size, height:size, correctLevel: QRCode.CorrectLevel.M });
      setTimeout(() => {
        try{
          const img = holder.querySelector('img');
          const canvas = holder.querySelector('canvas');
          let dataUrl = '';
          if (img && img.src) dataUrl = img.src;
          else if (canvas) dataUrl = canvas.toDataURL('image/png');
          if (!dataUrl) throw new Error('QR non generato');
          resolve(dataUrl);
        }catch(e){ reject(e); }
        finally { document.body.removeChild(holder); }
      }, 0);
    } catch (e) {
      document.body.removeChild(holder);
      reject(e);
    }
  });
}
// --- stampa HTML in nuova finestra in modo robusto ---
// Stampa HTML in un iFrame nascosto (niente popup blocker)
function safePrintHTMLString(html){
  try{
    const iframe = document.createElement('iframe');
    iframe.style.position='fixed';
    iframe.style.right='0'; iframe.style.bottom='0';
    iframe.style.width='0'; iframe.style.height='0';
    iframe.style.border='0'; iframe.setAttribute('aria-hidden','true');
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();

    iframe.onload = () => {
      try{
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      }finally{
        setTimeout(()=>{ try{ document.body.removeChild(iframe); }catch{} }, 1000);
      }
    };
  }catch(e){
    console.warn('Print iframe fallita, fallback a nuova scheda', e);
    const w = window.open('', '_blank');
    if (w){
      w.document.write(html); w.document.close(); w.focus();
      try{ w.print(); }catch{}
    }
  }
}
  // === REF CLIENTE → TESTO (globale, idempotente) ===
  window.refClienteToText = window.refClienteToText || function refClienteToText(x) {
    if (!x) return '';
    if (typeof x === 'string') return x.trim();
    if (typeof x === 'object') {
      // campi tipici: { tipo, numero, data }
      const tipo = (x.tipo || '').toString().trim().toUpperCase();
      const num  = (x.numero != null ? String(x.numero) : '').trim();
      const dt   = x.data ? new Date(x.data).toLocaleDateString('it-IT') : '';
      return [tipo, num, dt].filter(Boolean).join(' ').trim();
    }
    return String(x);
  };

function renderCommessaHTML(rec, appCfg = {}, opts = {}){
  
  const { qrDataUrl = '', qrCaption = '' } = opts;

  // --- helper locali ---
  const s = v => String(v ?? '').replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch]));
  const formatIT = d => d ? new Date(d).toLocaleDateString('it-IT') : '';
  const toMin = v => {
    if (typeof v === 'number') return Math.max(0, Math.round(v));
    const m = String(v||'').trim().match(/^(\d{1,4})(?::([0-5]?\d))?$/);
    if (!m) return 0; const h=+m[1]||0, mm=+m[2]||0; return h*60+mm;
  };
  const fmtHHMM = mins => {
    const t = Math.max(0, Math.round(Number(mins)||0));
    const h = Math.floor(t/60), m = t%60;
    return `${h}:${String(m).padStart(2,'0')}`;
  };

  // === Helpers locali per KPI di fase (stessa logica della Timbratura) ===
  function plannedMinsOfPhaseRP(fase, commessa){
    // Usa i campi più frequenti: oreMin/minuti/min/oreHHMM/ore
    const val =
      (fase && (Number(fase.oreMin)||Number(fase.minuti)||Number(fase.min))) ? 
        (Number(fase.oreMin)||Number(fase.minuti)||Number(fase.min)) :
      (typeof fase?.oreHHMM === 'string') ? toMin(fase.oreHHMM) :
      (typeof fase?.ore === 'string') ? toMin(fase.ore) :
      (Number(fase?.ore)||0);

    const perPezzo = !!(fase && (fase.perPezzo || fase.xPezzo || fase.onePerPiece));
    const qta = Math.max(1, Number(commessa?.qtaPezzi || 1));
    return perPezzo ? (val * qta) : val;
  }
  function effMinsOfPhaseRP(oreRows, commessaId, faseIdx){
    const rows = Array.isArray(oreRows) ? oreRows : [];
    return rows.reduce((S,o)=>{
      try{
        if (String(o.commessaId||o.commessa) !== String(commessaId)) return S;
        const fi = (o.faseIdx!=null) ? Number(o.faseIdx) :
                   (o.faseIndex!=null) ? Number(o.faseIndex) : null;
        if (fi !== Number(faseIdx)) return S;
        const add = (o.oreMin!=null) ? Number(o.oreMin) :
                    (o.minuti!=null) ? Number(o.minuti) :
                    (o.minutes!=null) ? Number(o.minutes) :
                    (o.oreHHMM!=null) ? toMin(o.oreHHMM) :
                    (o.ore!=null) ? (typeof o.ore==='string' ? toMin(o.ore) : Number(o.ore)*60) : 0;
        return S + Math.max(0, Number(add)||0);
      }catch{return S;}
    }, 0);
  }

  // --- dati base ---
  const fasi = Array.isArray(rec.fasi) ? rec.fasi : [];
  const perPezzoMin = fasi.reduce((tot,f)=> tot + (Number.isFinite(f.oreMin) ? f.oreMin : toMin(f.oreHHMM)), 0);
  const qta = Math.max(1, Number(rec.qtaPezzi||1));
  const totMin = perPezzoMin * qta;

  const priorita = rec.priorita || '-';
  const logo = appCfg.logoDataUrl || appCfg.logoUrl || appCfg.logo || (appCfg.azienda && (appCfg.azienda.logoDataUrl || appCfg.azienda.logoUrl)) || '';

  // Rif. ordine cliente (accetta stringa o oggetto)
  const rifRaw = rec.ordineCliente || rec.nrOrdineCliente || rec.ddtCliente || rec.ordine || rec.ordineId || rec.rifCliente || '';
  const rifCliente = window.refClienteToText
    ? window.refClienteToText(rifRaw)
    : (typeof rifRaw === 'object'
        ? [ (rifRaw.tipo||'').toString().trim().toUpperCase(),
            (rifRaw.numero!=null?String(rifRaw.numero):'').trim(),
            (rifRaw.data?new Date(rifRaw.data).toLocaleDateString('it-IT'):'') ].filter(Boolean).join(' ').trim()
       : String(rifRaw||''));

  // --- stile di stampa (autonomo) ---
  const stile = `
  <style>
    @page { size: A4; margin: 12mm; }
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:12px;color:#111}
    h1{font-size:22px;margin:0}
    h2{font-size:14px;margin:0 0 6px}
    .muted{color:#666}
    .right{text-align:right}
    .row{display:flex;gap:12px;align-items:flex-start}
    .col{display:flex;flex-direction:column;gap:4px}
    .header{display:grid; grid-template-columns: 180px 1fr 160px; gap:12px; align-items:center; border-bottom:2px solid #222; padding-bottom:10px; margin-bottom:12px}
    .logo{width:160px; height:80px; object-fit:contain; border:1px solid #eee; background:#fff}
    .bigline{font-size:18px; font-weight:800; line-height:1.2}
    .kp{display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:8px; margin-top:6px}
    .box{border:1px dashed #bbb; border-radius:8px; padding:8px}
    table{width:100%; border-collapse:collapse; margin-top:8px}
    th,td{border:1px solid #ddd; padding:6px; vertical-align:top}
    th{background:#fafafa; text-align:left}
    .qrwrap{display:flex; flex-direction:column; align-items:center; gap:6px}
    .qr{width:140px; height:140px; object-fit:contain}
  </style>`;

  // --- intestazione ---
  const headerHTML = `
    <div class="header">
      <div class="col">
        ${logo ? `<img class="logo" src="${logo}" alt="Logo">` : `<div class="muted">[Logo non impostato]</div>`}
      </div>
      <div class="col">
        <div class="bigline">${s(rec.cliente || '-')}</div>
        <div class="bigline">${s(rec.descrizione || '-')}</div>
        <div>Priorità: <strong>${s(priorita)}</strong></div>
        <div>Consegna prevista: <strong>${formatIT(rec.scadenza) || '-'}</strong></div>
        <div>Rif. ordine cliente: <strong>${
        (function() {
          const ref = rec.ordineCliente || rec.nrOrdineCliente || rec.ddtCliente || rec.ordine || rec.ordineId || rec.rifCliente || '';
          return s(window.refClienteToText(ref) || '-');})()}</strong></div>
        </div>
      <div class="qrwrap">
        <div style="font-weight:700">Commessa: ${s(rec.id || '-')}</div>
        ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt="QR">` : `<div class="muted" style="text-align:center">QR non disponibile</div>`}
        ${qrCaption ? `<div class="muted" style="font-size:10px;word-break:break-all;text-align:center">${s(qrCaption)}</div>` : ''}
      </div>
    </div>`;

  // --- riepilogo chiavi (etichette corrette: PREVISTE) ---
  const riepilogoHTML = `
    <div class="kp">
      <div class="box"><div class="muted">Pezzi totali</div><div style="font-size:16px;font-weight:800">${qta}</div></div>
      <div class="box"><div class="muted">Ore per pezzo (previste)</div><div style="font-size:16px;font-weight:800">${fmtHHMM(perPezzoMin)}</div></div>
      <div class="box"><div class="muted">Ore totali (previste)</div><div style="font-size:16px;font-weight:800">${fmtHHMM(totMin)}</div></div>
    </div>`;

  // --- tabella fasi: # / Lavorazione / HH:MM per fase / Q.tà ---
  const rowsHTML = (fasi.length ? fasi : []).map((f, idx) => {
    const hhmm = f.oreHHMM ? String(f.oreHHMM) : fmtHHMM(Number.isFinite(f.oreMin) ? f.oreMin : 0);
    return `<tr>
      <td style="width:40px">faseLabel(commessa, idx)</td>
      <td>${s(f.lav || '-')}</td>
      <td style="width:120px">${s(hhmm)}</td>
      <td style="width:80px">${qta}</td>
    </tr>`;
  }).join('');

  const tableHTML = `
    <h2>Fasi di lavorazione</h2>
    <table>
      <thead>
        <tr><th>#</th><th>Lavorazione</th><th>HH:MM per fase</th><th>Q.tà</th></tr>
      </thead>
      <tbody>${rowsHTML || `<tr><td colspan="4" class="muted">Nessuna fase definita</td></tr>`}</tbody>
    </table>`;
    // --- materiali previsti ---
// Legge "materialiPrevisti" (primario) o "materiali" (fallback)
const mats = Array.isArray(rec.materialiPrevisti) ? rec.materialiPrevisti
            : (Array.isArray(rec.materiali) ? rec.materiali : []);

const matRowsHTML = (mats.length ? mats : []).map(m => {
  const qtyPerPezzo = Number(m.qta ?? m.qty ?? m.pezzi ?? 0);
  return `<tr>
    <td>${s(m.codice || '')}</td>
    <td>${s(m.descrizione || '')}</td>
    <td style="width:60px">${s(m.um || '')}</td>
    <td style="width:80px">${(Number.isFinite(qtyPerPezzo) ? qtyPerPezzo : '')}</td>
    <td>${s(m.note || '')}</td>
  </tr>`;
}).join('');

const matTableHTML = `
  <h2 style="margin-top:12px">Materiali previsti</h2>
  <table>
    <thead><tr>
      <th>Codice</th><th>Descrizione</th><th>UM</th><th>Q.tà</th><th>Note</th>
    </tr></thead>
    <tbody>${matRowsHTML || `<tr><td colspan="5" class="muted">Nessun materiale</td></tr>`}</tbody>
  </table>`;


  // --- istruzioni (se presenti) ---
  const istrLines = String(rec.istruzioni || rec.note || '')
  .split(/\r?\n/)
  .map(x => x.trim())
  .filter(Boolean);
const noteHTML = istrLines.length ? `
  <div class="box" style="margin-top:10px">
    <div class="muted">Istruzioni</div>
    <ul style="margin:6px 0 0 18px; padding:0">
      ${istrLines.map(li => `<li>${s(li)}</li>`).join('')}
    </ul>
  </div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8">${stile}</head><body>
  ${headerHTML}
  ${riepilogoHTML}
  ${tableHTML}
  ${matTableHTML}
  ${noteHTML}
  </body></html>`;

}

// === STAMPA COMMESSA con QR in Data URL (stabile in stampa) ===
async function printCommessa(c){
  // Impostazioni intestazione per stampe (logo, ragione sociale, ecc.)
  const appCfg = (function(){ try{ return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; }catch{return{};} })();

  // URL che il QR dovrà aprire sul telefono
  const qrUrl = makeTimbraturaURL(c.id);

  // Genero un QR come Data URL (prima la libreria in-page, poi eventuale fallback esterno)
  let qrDataUrl = null;
  try {
    qrDataUrl = await getQRDataURL(qrUrl, 180);
  } catch(_) {}
  if (!qrDataUrl) {
    const fallback = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(qrUrl)}`;
    try{
      const resp = await fetch(fallback, { cache: 'no-store' });
      const blob = await resp.blob();
      qrDataUrl = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
    }catch{}
    if (!qrDataUrl) qrDataUrl = fallback; // estrema ratio
  }

  // HTML della scheda: usa i tempi/fasi reali (lav + oreHHMM) e le etichette “previste”
  const html = renderCommessaHTML(c, appCfg, { qrDataUrl, qrCaption: qrUrl });

  // Stampa tramite iFrame nascosto (niente popup blocker)
  safePrintHTMLString(html);
}
/* ================== ETICHETTE COLLI (stampa A4 semplice con QR) ================== */
function stampaEtichetteColli({ commessa, nColli=1 }) {
  const makeLabel = (i) => `
    <div style="border:1px solid #000; padding:10px; margin:8px; width:48%; display:inline-block; box-sizing:border-box;">
      <div style="font-size:18px; font-weight:bold;">ETICHETTA COLLO ${i}/${nColli}</div>
      <div><b>Commessa:</b> ${commessa?.id || commessa?.code || '-'}</div>
      <div><b>Cliente:</b> ${commessa?.cliente || '-'}</div>
      <div><b>Descr.:</b> ${commessa?.titolo || commessa?.descrizione || '-'}</div>
      <div id="qr_${i}" style="margin-top:8px;"></div>
    </div>
  `;
  const html = `
    <html><head><meta charset="utf-8">
      <style>@media print { @page { size:A4; margin:12mm; } body { font-family:Arial; } }</style>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js"></script>
    </head>
    <body>
      <h1>Etichette colli — ${commessa?.id || '-'}</h1>
      ${Array.from({length:nColli}, (_,i)=>makeLabel(i+1)).join('')}
      <script>
        (function(){
          const id = ${JSON.stringify(commessa?.id || '')};
          for (let i=1;i<=${nColli};i++){
            const el = document.getElementById('qr_'+i);
            if (!el) continue;
            const c = document.createElement('canvas'); el.appendChild(c);
            try {
              new QRious({ element:c, value: 'commessa:'+id+':collo:'+i, size: 140 });
            } catch(e) { el.innerHTML = '<div style="color:#900">QR non disponibile</div>'; }
          }
          setTimeout(()=>window.print(),200);
        })();
      </script>
    </body></html>`;
  const f = document.createElement('iframe');
  Object.assign(f.style, { position:'fixed', right:0, bottom:0, width:0, height:0, border:0 });
  document.body.appendChild(f);
  const w = f.contentWindow; w.document.open(); w.document.write(html); w.document.close();
  w.focus();
  setTimeout(()=>document.body.removeChild(f), 2000);
}

function chiediEtichetteECStampa(commessa) {
  const n = Number(prompt('Commessa completata. Quanti colli stampare?', '1')||'0');
  if (n>0) {
    try { localStorage.setItem('__NCOLLI__:'+String(commessa?.id||''), String(n)); } catch {}
    stampaEtichetteColli({ commessa, nColli:n });
  }
}

/* ================== HOOK COMPLETAMENTO COMMESSA → ETICHETTE ================== */
(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

  const lsGet = window.lsGet || ((k,d)=>{ try{ const v=JSON.parse(localStorage.getItem(k)); return (v??d);}catch{return d;}});
  const origLsSet = window.lsSet || ((k,v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} });

  function isClosed(row){
    // prova varianti comuni di “fine commessa”
    return (
      row?.stato === 'Consegnata' ||
      row?.stato === 'Chiusa' ||
      row?.consegnata === true ||
      row?.chiusa === true ||
      Number(row?.progress || row?.avanzamento || 0) >= 100
    );
  }

  window.lsSet = function(k, v){
    // prendi snapshot PRIMA
    let prev = null;
    if (k === 'commesseRows') { prev = lsGet('commesseRows', []); }

    // esegui set
    const ret = origLsSet(k, v);

    // dopo il set, se sono commesseRows → confronta e lancia popup per nuove chiusure
    if (k === 'commesseRows') {
      try {
        const next = Array.isArray(v) ? v : (lsGet('commesseRows', []) || []);
        const byIdPrev = new Map((prev||[]).map(x => [x.id, x]));
        for (const n of (next||[])) {
          const p = byIdPrev.get(n.id);
          const wasClosed = p ? isClosed(p) : false;
          const nowClosed = isClosed(n);
          if (!wasClosed && nowClosed) {
            try { if (typeof chiediEtichetteECStampa === 'function') chiediEtichetteECStampa(n); } catch {}
          }
        }
      } catch {}
    }
    return ret;
  };
})();

/* ================== COMMESSE (multi-selezione → DDT, import PDF ordine, multi-articolo) ================== */
  // === Helpers elenco Commesse (idempotenti) ===
window.orderRefFor = window.orderRefFor || function orderRefFor(c){
  try{
    const ref = c?.ordineCliente || c?.nrOrdineCliente || c?.ddtCliente || c?.ordine || c?.ordineId || c?.rifCliente || '';
    return (window.refClienteToText ? window.refClienteToText(ref) : String(ref||'')).trim();
  }catch{ return ''; }
};

window.previewDescrAndRef = window.previewDescrAndRef || function previewDescrAndRef(c){
  const descr = String(c?.descrizione || '').trim();
  const righe = Array.isArray(c?.righeArticolo) ? c.righeArticolo : (Array.isArray(c?.righe) ? c.righe : []);
  const isMulti = Array.isArray(righe) && righe.length > 1;
  const isSingle = Array.isArray(righe) && righe.length === 1;
  const codiceSingolo = (isSingle && righe[0] && (righe[0].codice || righe[0].code)) ? (righe[0].codice || righe[0].code) : (c?.articoloCodice || '');
  const ref = window.orderRefFor(c) || '';

  // output:
  // colonna "Descrizione" = descrizione
  // colonna "Rif. cliente" = (multi) ref  | (singola) codice  | fallback ref | '-'
  const rifCol = isMulti ? (ref || `Multi (${righe.length})`) : (codiceSingolo || ref || '-');
  return { descr, rifCol };
};

function CommesseView({ query = '' }) {
  const e = React.createElement;

  // — Renderer sicuro per valori di cella (evita React error #31)
  const V = (v) => {
    if (v == null) return '';
    if (typeof v === 'object') {
      // oggetti noti: mostra un campo utile (id/numero/data) o serializza
      if ('id' in v || 'numero' in v || 'data' in v) {
        return String(v.id ?? v.numero ?? v.data ?? '');
      }
      if (Array.isArray(v)) return v.map(V).join(', ');
      try { return JSON.stringify(v); } catch { return '[obj]'; }
    }
    return String(v);
  };

  // --- utili LS sicuri ---
  const lsGet = window.lsGet || ((k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } });
  const lsSet = window.lsSet || ((k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); window.__anima_dirty = true; } catch {} });

  // --- chiudi i menu "…" cliccando fuori ---
  const [menuRow, setMenuRow] = React.useState(null);
  React.useEffect(() => {
    const onDocClick = (ev) => { if (!ev.target.closest('.dropdown')) setMenuRow(null); };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  // --- tempo & formati ---
  const formatNNN = window.formatNNN || (n => String(n).padStart(3,'0'));
  const nextProgressivo = window.nextProgressivo || (series => {
    const year = new Date().getFullYear();
    let counters = {}; try { counters = JSON.parse(localStorage.getItem('counters') || '{}') || {}; } catch {}
    const key = `${series}:${year}`; const num = Number(counters[key]||0) + 1; counters[key]=num;
    try { localStorage.setItem('counters', JSON.stringify(counters)); } catch {}
    return { year, num };
  });
  const toMin = (s) => {
    if(!s) return 0;
    const m = String(s).trim().match(/^(\d{1,4})(?::([0-5]?\d))?$/);
    if (!m) return 0;
    return (parseInt(m[1]||'0',10)||0)*60 + (parseInt(m[2]||'0',10)||0);
  };
  const fmtHHMM = (mins) => { const t=Math.max(0,Math.round(+mins||0)), h=Math.floor(t/60), m=t%60; return `${h}:${String(m).padStart(2,'0')}`; };
  const todayISO = () => new Date().toISOString().slice(0,10);

  // --- producedPieces coerente ovunque ---
  const producedPieces = window.producedPieces || function(c){
    const tot = Math.max(1, Number(c?.qtaPezzi || 1));
    if (!Array.isArray(c?.fasi) || c.fasi.length === 0) {
      return Math.min(tot, Math.max(0, Number(c?.qtaProdotta || 0)));
    }
    const perPhase = c.fasi.filter(f => !(f?.unaTantum || f?.once)).map(f => Math.max(0, Number(f.qtaProdotta || 0)));
    return perPhase.length ? Math.min(tot, Math.min(...perPhase)) : 0;
  };

  // --- dati di base ---
  const app       = React.useMemo(() => lsGet('appSettings', {}) || {}, []);
  const clienti   = React.useMemo(() => {
    const arr = lsGet('clientiRows', []) || [];
    return (Array.isArray(arr) ? arr : []).map((x, i) => ({
      id: (x && (x.id!=null ? x.id : (x.codice||x.code||String(i)))),
      ragioneSociale: (x && (x.ragioneSociale||x.denominazione||x.nome||x.descrizione||x.ragione||'')) || ''
    }));
  }, []);
  const articoliA = React.useMemo(() => lsGet('magArticoli', []) , []);
  const FASI_STD  = Array.isArray(app.fasiStandard) ? app.fasiStandard.filter(Boolean) : [];

  // --- ordinamento per più-recenti/decrescente (C-YYYY-NNN) ---
  function idKeyC(row){
    const id = String(row?.id||'');
    const m = id.match(/C-(\d{4})-(\d{3})/i);
    if (!m) return 0;
    const y = parseInt(m[1],10)||0, n=parseInt(m[2],10)||0;
    return y*100000 + n;
  }

  // --- stato archivio ---
  const [rows, setRows] = React.useState(() => lsGet('commesseRows', []));
  React.useEffect(() => lsSet('commesseRows', rows), [rows]);

  // Writer unico: aggiorna stato + localStorage (idempotente)
  function writeCommesse(nextArr){
    try {
      if (typeof lsSet === 'function') lsSet('commesseRows', nextArr);
      else localStorage.setItem('commesseRows', JSON.stringify(nextArr));
    } catch {}
    setRows(Array.isArray(nextArr) ? nextArr : []);
  }

  // --- filtro ricerca ---
  const [q, setQ] = React.useState(query||'');
  const rowsSorted = (Array.isArray(rows)? rows.slice():[]).sort((a,b)=> idKeyC(b) - idKeyC(a));
  const filtered = rowsSorted.filter(c => {
    const s = `${c.id||''} ${c.cliente||''} ${c.descrizione||''} ${c.articoloCodice||''} ${(Array.isArray(c.righe)&&c.righe.map(r=>r.articoloCodice).join(' '))||''}`.toLowerCase();
    return s.includes((q||'').toLowerCase());
  });

  // --- selezione multipla per DDT ---
  const [sel, setSel] = React.useState({}); // { [id]: true }
  const selectedList = filtered.filter(c => sel[c.id]);
  const selectedClientIds = Array.from(new Set(selectedList.map(c => String(c.clienteId||''))));
  const sameClient = selectedClientIds.length <= 1;
  const toggleRow  = (id)=> setSel(prev => ({ ...prev, [id]: !prev[id] }));
  const toggleAll  = ()=> {
    const allSelected = filtered.every(c => sel[c.id]);
    if (allSelected) {
      const next = {...sel}; filtered.forEach(c => { delete next[c.id]; }); setSel(next);
    } else {
      const next = {...sel}; filtered.forEach(c => { next[c.id] = true; }); setSel(next);
    }
  };

  // --- form commessa ---
  const blank = {
    id:'', clienteId:'', cliente:'',
    articoloCodice:'', articoloUM:'',
    descrizione:'',
    qtaPezzi: 1,
    orePerPezzoHHMM: '1:00',
    oreTotaliPrev: 60,
    scadenza:'', priorita:'MEDIA',
    istruzioni:'',
    materiali:[],
    fasi:[],
    righeArticolo: [],                 // 👈 NEW (multi-articolo)
    qtaProdotta: 0,
    rifCliente: { tipo:'ordine', numero:'', data:'' },
    luogoConsegna: '',
    createdAt: null, updatedAt: null
  };
  const [form, setForm] = React.useState(blank);
  const [editingId, setEditingId] = React.useState(null);
  const [showForm, setShowForm] = React.useState(false);

  React.useEffect(()=>{ // ricalcola oreTotaliPrev
    setForm(p => ({ ...p, oreTotaliPrev: toMin(p.orePerPezzoHHMM) * Math.max(1, Number(p.qtaPezzi||1)) }));
  }, [form.qtaPezzi, form.orePerPezzoHHMM]);

  function onChange(ev){
    const { name, value, type } = ev.target;
    setForm(p => ({ ...p, [name]: type==='number' ? (value===''? '' : +value) : value }));
  }

  // --- fasi ---
  function addFase(){ setForm(p => ({ ...p, fasi:[...(p.fasi||[]), { lav:'', oreHHMM:'0:10', qtaPrevista: Math.max(1, Number(p.qtaPezzi||1)), qtaProdotta:0 }] })); }
  function delFase(idx){ setForm(p => ({ ...p, fasi:(p.fasi||[]).filter((_,i)=>i!==idx) })); }
  function onChangeFase(idx, field, value){
    setForm(p => {
      const arr = Array.isArray(p.fasi) ? p.fasi.slice() : [];
      const r = { ...(arr[idx]||{}) };
      r[field] = (field==='qtaPrevista') ? Math.max(1, Number(value)||1) : value;
      arr[idx] = r; return { ...p, fasi: arr };
    });
  }

  // --- materiali previsti ---
  function addMat(){ setForm(p => ({ ...p, materiali:[...(p.materiali||[]), { codice:'', descrizione:'', um:'', qta:0, note:'' }] })); }
  function delMat(idx){ setForm(p => ({ ...p, materiali:(p.materiali||[]).filter((_,i)=>i!==idx) })); }
  function onChangeMat(idx, field, value){
    setForm(p => {
      const arr = Array.isArray(p.materiali) ? p.materiali.slice() : [];
      const r = { ...(arr[idx]||{}) };
      r[field] = (field==='qta') ? (+value||0) : value;
      if (field==='codice') {
        const a = (articoliA||[]).find(x => String(x.codice||'').trim() === String(value||'').trim());
        if (a) { r.descrizione = r.descrizione || a.descrizione || ''; r.um = r.um || a.um || ''; }
      }
      arr[idx] = r; return { ...p, materiali: arr };
    });
  }

  // ---- righe articolo (multi-articolo) ----
  function addRiga(){
    setForm(p => ({
      ...p,
      righeArticolo: [
        ...(Array.isArray(p.righeArticolo) ? p.righeArticolo : []),
        { codice:'', descrizione:'', um:'PZ', qta:1, note:'' }
      ]
  }));
}
function delRiga(idx){
  setForm(p => ({
    ...p,
    righeArticolo: (Array.isArray(p.righeArticolo) ? p.righeArticolo : []).filter((_,i)=>i!==idx)
  }));
}
function onChangeRiga(idx, field, value){
  setForm(p => {
    const arr = Array.isArray(p.righeArticolo) ? p.righeArticolo.slice() : [];
    const r   = { ...(arr[idx]||{}) };
    if (field === 'qta') r.qta = (+value || 0);
    else r[field] = value;

    // autocompilazione da anagrafica articoli
    if (field === 'codice') {
      const a = (Array.isArray(articoliA) ? articoliA : []).find(
        x => String(x.codice||'').trim() === String(value||'').trim()
      );
      if (a) {
        if (!r.descrizione) r.descrizione = a.descrizione || '';
        if (!r.um)          r.um          = a.um || 'PZ';
      }
    }

    arr[idx] = r;
    return { ...p, righeArticolo: arr };
  });
}

  // --- azioni form ---
  function startNew(){
    setEditingId(null);
    setForm({ ...blank, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
    setShowForm(true);
    setTimeout(()=>{ const el=document.getElementById('commessa-form'); if(el) el.scrollIntoView({behavior:'smooth', block:'start'}); },0);
  }
  function startEdit(c){
    setEditingId(c.id);
    setForm({ ...blank, ...c, rifCliente: c.rifCliente || {tipo:'ordine',numero:'',data:''}, updatedAt:new Date().toISOString() });
    setShowForm(true);
    setTimeout(()=>{ const el=document.getElementById('commessa-form'); if(el) el.scrollIntoView({behavior:'smooth', block:'start'}); },0);
  }
  function cancelForm(){ setShowForm(false); setEditingId(null); setForm(blank); }

  function segnaCompleta(c){
    const tot = Math.max(1, Number(c.qtaPezzi||1));
    const upd = { ...c, fasi:(Array.isArray(c.fasi)?c.fasi:[]).map(f=>({...f, qtaProdotta:tot})), qtaProdotta:tot, updatedAt:new Date().toISOString(), __completedAt:new Date().toISOString() };
    setRows(prev => { const ix=prev.findIndex(x=>x.id===c.id); const next=[...prev]; if(ix>=0) next[ix]=upd; return next; });
    try{ lsSet('commesseRows', (function(p){ const ix=p.findIndex(x=>x.id===upd.id); if(ix>=0)p[ix]=upd; return p; })(lsGet('commesseRows', []))); }catch{}
    try{ window._maybeAutoScaricoAndLabels && window._maybeAutoScaricoAndLabels(c.id); }catch{}
    alert('Commessa segnata come COMPLETA ✅');
  }

  function save(){
  const all = lsGet('commesseRows', []);

 // 1) ID: se vuoto o se sto creando (no editingId) → genera SEMPRE un ID nuovo e unico
let id = String(form.id || '').trim();
const creating = !editingId;

// ricava l'elenco ID già esistenti (usa lo state 'rows' se disponibile, fallback LS)
const allExisting = Array.isArray(rows) ? rows : ((window.lsGet && window.lsGet('commesseRows', [])) || []);
const existIds = new Set(allExisting.map(x => String(x.id)));

if (!id || creating) {
  // genera un candidato (usa nextCommessaId del bootstrap)
  const gen = (typeof window.nextCommessaId === 'function')
    ? window.nextCommessaId()
    : (function(){ const y=new Date().getFullYear(); return `C-${y}-001`; })();

  // se collisione, sali fino a trovare il primo libero
  const pad = (n)=> String(n).padStart(3,'0');
  let trial = gen;

  if (existIds.has(trial)) {
    const m = trial.match(/^C-(\d{4})-(\d{3})$/i);
    const y = m ? +m[1] : new Date().getFullYear();
    let n = m ? +m[2] : 1;
    while (existIds.has(`C-${y}-${pad(n)}`)) n++;
    trial = `C-${y}-${pad(n)}`;
  }

  id = trial;
}

  // 2) normalizzazioni
  const normFasi = (form.fasi||[]).map(f => ({
    lav: f.lav || '',
    oreHHMM: f.oreHHMM || '0:10',
    qtaPrevista: Math.max(1, Number(f.qtaPrevista||form.qtaPezzi||1)),
    qtaProdotta: Math.max(0, Math.min(Number(form.qtaPezzi||1), Number(f.qtaProdotta||0)))
  }));

  // --- quantità e codice articolo da righeArticolo ---
const righe = Array.isArray(form.righeArticolo) ? form.righeArticolo : [];
const qtaFromRighe = righe.reduce((s,r)=> s + (+r.qta||0), 0);
const articoloCodiceFinal =
  (righe.length === 1) ? (righe[0].codice || form.articoloCodice || '') :
  (righe.length > 1)  ? '' : (form.articoloCodice || '');

  const righeArt = Array.isArray(form.righeArticolo) ? form.righeArticolo.filter(r => (r.codice||r.descrizione||'').trim()) : [];
  const qtaTotRighe = righeArt.reduce((s,r)=> s + (Number(r.qta)||0), 0);

   const partial = {
    ...form,
    id,
    cliente: form.cliente || (clienti.find(x=>String(x.id)===String(form.clienteId))?.ragioneSociale || ''),
    qtaPezzi: qtaFromRighe || Math.max(1, Number(form.qtaPezzi||1)),                 // 👈 usa le righe
    articoloCodice: articoloCodiceFinal,                                             // 👈 da righe
    orePerPezzoHHMM: form.orePerPezzoHHMM || '0:10',
    oreTotaliPrev: toMin(form.orePerPezzoHHMM) * (qtaFromRighe || Math.max(1, Number(form.qtaPezzi||1))),
    fasi: normFasi,
    materiali: (form.materiali||[]).map(m => ({
      codice: m.codice||'', descrizione: m.descrizione||'', um: m.um||'', qta: +m.qta||0, note: m.note||''
    })),
    righeArticolo: righe,                                                            // 👈 salva le righe
    updatedAt: new Date().toISOString(),
    createdAt: form.createdAt || new Date().toISOString()
  };

  partial.qtaProdotta = producedPieces(partial);

  // 3) scrivi su LS + stato
  const ix = all.findIndex(x => x.id === partial.id);
  let nextAll;
  if (ix >= 0) {
    nextAll = all.slice();
    nextAll[ix] = partial;
  } else {
    nextAll = [partial, ...all]; // in testa
  }
  lsSet('commesseRows', nextAll);
  setRows(nextAll);

  try{ window._maybeAutoScaricoAndLabels && window._maybeAutoScaricoAndLabels(partial.id); }catch{}
  alert('Commessa salvata ✅');
  setShowForm(false);
}

  // --- Duplica / Elimina (mancanti) ---
function duplicaCommessa(src){
  if (!src || !src.id) return;
  try{
    const all = lsGet('commesseRows', []);
    const nid = (typeof window.nextCommessaId === 'function') ? window.nextCommessaId() :
                (function(){ const y=new Date().getFullYear(); return `C-${y}-001`; })();

    const copy = JSON.parse(JSON.stringify(src));
    const newId = (typeof window.ensureUniqueCommessaId === 'function') ? window.ensureUniqueCommessaId(nid) : nid;
    copy.id = newId;
    copy.qtaProdotta = 0;
    delete copy.__completedAt;
    if (Array.isArray(copy.fasi)) copy.fasi = copy.fasi.map(f => ({ ...f, qtaProdotta: 0 }));
    copy.createdAt = new Date().toISOString();
    copy.updatedAt = new Date().toISOString();

    all.push(copy);
    writeCommesse(all);
    alert(`Commessa duplicata come ${nid} ✅`);
  }catch(e){
    console.error(e);
    alert('Errore durante la duplicazione.');
  }
}
window.duplicaCommessa = duplicaCommessa;

function delCommessa(c){
  if (!c || !c.id) return;

  const oreRows = (function(){ try{ return JSON.parse(localStorage.getItem('oreRows')||'[]'); }catch{return[]} })();
  const magMov  = (function(){ try{ return JSON.parse(localStorage.getItem('magMovimenti')||'[]'); }catch{return[]} })();
  const ddtRows = (function(){ try{ return JSON.parse(localStorage.getItem('ddtRows')||'[]'); }catch{return[]} })();

  const nOre = oreRows.filter(o => o.commessaId === c.id).length;
  const nMov = magMov.filter(m => String(m.commessaId||'') === c.id || (Array.isArray(m.righe) && m.righe.some(r => String(r.commessaId||'')===c.id))).length;
  const nDDT = ddtRows.filter(d => String(d.commessaId||'') === c.id || (Array.isArray(d.righe) && d.righe.some(r => String(r.commessaId||'')===c.id))).length;

  const msg = [
    `Eliminare la commessa "${c.id}"?`,
    '',
    `Collegamenti:`,
    `• Timbrature: ${nOre}`,
    `• Movimenti magazzino: ${nMov}`,
    `• DDT: ${nDDT}`,
    '',
    'Verrà eliminata solo la commessa. I dati collegati resteranno invariati.'
  ].join('\n');

  if (!confirm(msg)) return;

  try{
    const all = lsGet('commesseRows', []);
    const next = all.filter(x => x.id !== c.id);
    writeCommesse(next); // 👈 persiste davvero

    // Guardia write-through: se per qualsiasi motivo non risultasse scritto, forza LS
    try{
      const cur = JSON.parse(localStorage.getItem('commesseRows')||'[]');
      if (!Array.isArray(cur) || cur.length !== next.length) {
        localStorage.setItem('commesseRows', JSON.stringify(next));
        window.__anima_dirty = true;
      }
    }catch{}

    try{
      if (typeof window.syncExportToCloudOnly === 'function') {
        window.syncExportToCloudOnly(['commesseRows']);
      }
    }catch(e){ console.warn('Sync cloud commesse fallito:', e); }

    alert(`Commessa ${c.id} eliminata ✅`);
  }catch(e){
    console.error(e);
    alert('Errore durante eliminazione commessa.');
  }
}
window.delCommessa = delCommessa;


// (opzionale) esponi globali per altre viste
window.duplicaCommessa = window.duplicaCommessa || duplicaCommessa;
window.delCommessa     = window.delCommessa     || delCommessa;

  // --- DDT: singola & multiple ---
  function timbrUrl(id){ return `#/timbratura?job=${encodeURIComponent(id||'')}`; }
  function creaDDTdaCommessa(commessa){
  try{
    const lsGet = window.lsGet || ((k,d)=>{ try{ return JSON.parse(localStorage.getItem(k)||'null') ?? d; }catch{ return d; }});
    const articoli = lsGet('magArticoli', []) || [];
    const cli = (lsGet('clientiRows', [])||[]).find(x => String(x.id)===String(commessa.clienteId)) || null;
    const todayISO = ()=> new Date().toISOString().slice(0,10);

    // --- costruzione righe DDT (multi-articolo friendly)
const righeDDT = (Array.isArray(commessa.righeArticolo) && commessa.righeArticolo.length > 0)
  ? commessa.righeArticolo.map(r => {
      const a = articoli.find(x => String(x.codice||'').trim() === String(r.codice||'').trim()) || null;
      return {
        codice: r.codice || '',
        descrizione: r.descrizione || (a && a.descrizione) || '',
        UM: String(r.um || (a && a.um) || 'PZ').toUpperCase(), // 👈 UM sempre maiuscolo
        qta: Number(r.qta || 0) || 0,
        note: r.note || commessa.noteSpedizione || ''
      };
    })
  : (function(){
      // fallback back-compat: singola riga
      const a = articoli.find(x => String(x.codice||'').trim() === String(commessa.articoloCodice||'').trim()) || null;
      return [{
        codice: commessa.articoloCodice || '',
        descrizione: (a && a.descrizione) || commessa.descrizione || '',
        UM: String((a && a.um) || commessa.articoloUM || 'PZ').toUpperCase(), // 👈 UM maiuscolo
        qta: Math.max(1, Number(commessa.qtaPezzi || 1)),
        note: commessa.noteSpedizione || ''
      }];
    })();

const pf = {
  data: (typeof todayISO === 'function' ? todayISO() : new Date().toISOString().slice(0,10)),
  clienteId:     commessa.clienteId || '',
  cliente:       commessa.cliente || (cli && (cli.ragioneSociale || '')) || '',
  commessaRif:   commessa.id || '',
  luogoConsegna: commessa.luogoConsegna || (cli && (cli.sedeOperativa || cli.sede) || ''),
  rifClienteTipo: (commessa.rifCliente && commessa.rifCliente.tipo) || '',
  rifClienteNum:  (commessa.rifCliente && commessa.rifCliente.numero) || '',
  rifClienteData: (commessa.rifCliente && commessa.rifCliente.data) || '',
  righe: righeDDT
};

    localStorage.setItem('prefillDDT', JSON.stringify(pf));
    location.hash = '#/ddt';
  }catch(e){
    alert('Impossibile preparare il DDT: ' + (e && e.message ? e.message : e));
  }
}
  function creaDDTdaSelezionate(){
    const list = selectedList; if (!list.length) { alert('Nessuna commessa selezionata.'); return; }
    const clientIds = Array.from(new Set(list.map(c => String(c.clienteId||''))));
    if (clientIds.length > 1) { alert('Seleziona commesse dello stesso cliente.'); return; }

    const clienteId = clientIds[0] || '';
    const cli = (clienti||[]).find(x => String(x.id)===clienteId) || null;
    const articoli = Array.isArray(articoliA) ? articoliA : [];

      const righe = list.map(c => {
      // prendo le righe articolo (nuovo modello) o, in fallback, c.righe
      const righeArt = Array.isArray(c.righeArticolo)
        ? c.righeArticolo
        : (Array.isArray(c.righe) ? c.righe : []);

      const firstRiga = righeArt[0] || null;

      // codice riga per il DDT:
      // - se multi-articolo → "Multi (N)" (o eventuale articoloCodice di sintesi)
      // - se singola riga → codice di quella riga / articoloCodice
      let code;
      if (Array.isArray(c.righeArticolo) && c.righeArticolo.length > 1) {
        code =
          (c.articoloCodice && String(c.articoloCodice).trim()) ||
          `Multi (${c.righeArticolo.length})`;
      } else {
        code =
          c.articoloCodice ||
          (firstRiga && (firstRiga.codice || firstRiga.articoloCodice)) ||
          '';
      }

      // articolo da anagrafica per recuperare UM/descrizione se presente
      const art = articoli.find(
        a => String(a.codice || '').trim().toLowerCase() === String(code || '').trim().toLowerCase()
      ) || null;

      const UM = String(
        (art && art.um) ||
        c.articoloUM ||
        (firstRiga && (firstRiga.um || firstRiga.UM)) ||
        'PZ'
      ).toUpperCase();

      const descr =
        (art && art.descrizione) ||
        c.descrizione ||
        (firstRiga && (firstRiga.descrizione || firstRiga.articoloDescr)) ||
        '';

      const qtaDefault = (
        +c.qtaProdotta > 0
          ? +c.qtaProdotta
          : (
              +c.qtaPezzi ||
              (firstRiga && (+firstRiga.qta || +firstRiga.quantita)) ||
              1
            )
      );

      return {
        codice: code,
        descrizione: descr,
        UM,
        qta: qtaDefault,
        note: c.noteSpedizione || ''
      };
    });

    const luogoCz = (() => {
      const setLC = Array.from(new Set(list.map(c => c.luogoConsegna || ''))).filter(Boolean);
      if (setLC.length === 1) return setLC[0];
      return (cli && (cli.sedeOperativa || cli.sede)) || '';
    })();

    const pf = {
      data: todayISO(),
      clienteId,
      cliente: (cli && (cli.ragioneSociale || cli.nome || cli.denominazione)) || (list[0].cliente || ''),
      luogoConsegna: luogoCz,
      rifClienteTipo: (list[0].rifCliente && list[0].rifCliente.tipo) || '',
      rifClienteNum:  (list[0].rifCliente && list[0].rifCliente.numero) || '',
      rifClienteData: (list[0].rifCliente && list[0].rifCliente.data) || '',
      commesseIds: list.map(c=>c.id),
      righe
    };
    try { localStorage.setItem('prefillDDT', JSON.stringify(pf)); } catch {}
    location.hash = '#/ddt';
  }

      // --- Import Ordine (PDF) → COMMESSA UNICA multi-articolo ---
  const orderPdfInput = e('input', {
    id:'order-pdf-input',
    type:'file',
    accept:'application/pdf',
    style:{ display:'none' },
    onChange: async ev => {
      try{
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;

        const raw = await window.extractPdfText(f);
        const fileName = f.name || '';

        // 1) Usa la PIPELINE UNICA (importOrderFromPDFText)
        let parsed = {};
        if (typeof window.importOrderFromPDFText === 'function') {
          parsed = window.importOrderFromPDFText(raw, fileName) || {};
        } else if (typeof window.parseOrderText === 'function') {
          parsed = window.parseOrderText(raw, fileName) || {};
        }

                // 2) Normalizza righe: accettiamo righe con codice O descrizione
        let righe = Array.isArray(parsed.righe)
          ? parsed.righe.filter(r =>
              r &&
              (
                String(r.codice || '').trim().length > 0 ||
                String(r.descrizione || '').trim().length > 0
              )
            )
          : [];

        // Se non ho righe valide, NON blocco più l'utente:
        // creo comunque una commessa "vuota" da completare a mano
        if (!righe.length) {
          console.warn('[import-ordine] nessuna riga valida trovata, creo commessa vuota da completare a mano', {
            parsedPreview: {
              cliente    : parsed.cliente || '',
              descrizione: parsed.descrizione || '',
              scadenza   : parsed.scadenza || ''
            }
          });

          // provo a derivare una descrizione intelligente dal testo dell'ordine
          const descrAuto =
            (raw.match(/Oggetto\s*[:\-]\s*(.+)/i) || [])[1] ||
            (raw.match(/Ord\. acq\.\s*C\/Lavoro\s+Numero\s+(\d+)/i) || [])[1] ||
            fileName ||
            'Commessa da ordine PDF';

          parsed.descrizione = (parsed.descrizione || descrAuto || '').trim();

          // lascio righe vuote: la commessa nascerà senza righeArticolo
          righe = [];
        }

        // === Cliente (come prima) ===
        const clienti = (window.lsGet && window.lsGet('clientiRows', [])) || [];
        let clienteRag = String(parsed.cliente || '').trim();

        // se il cliente è noi stessi (ANIMA...) lo azzero
        if (/^ANIMA\b/i.test(clienteRag)) clienteRag = '';

        let clienteId = '';
        if (clienteRag) {
          const hit = clienti.find(c =>
            String(c.ragioneSociale || c.nome || '').toLowerCase() === clienteRag.toLowerCase()
          );
          if (hit) {
            clienteId = hit.id;
            clienteRag = hit.ragioneSociale || hit.nome || clienteRag;
          }
        }

        // === ID nuova commessa ===
        const idNuovo = (typeof window.nextCommessaId === 'function')
          ? window.nextCommessaId()
          : (function(){
              const y = new Date().getFullYear();
              return `C-${y}-001`;
            })();

        // qta totale = somma righe (se ci sono), altrimenti parsed.qtaPezzi || 1
        const qtaTot = righe.length
          ? righe.reduce((s,r)=> s + (Number(r.qta || r.quantita || 0) || 0), 0)
          : (Number(parsed.qtaPezzi || 1) || 1);

        // articoloCodice sintetico per la lista: Multi(N) o primo codice
        const articoloCodiceFinal = righe.length > 1
          ? `Multi (${righe.length})`
          : (righe[0]?.codice || parsed.articoloCodice || '');

        // Scadenza → provo a portarla in YYYY-MM-DD
        const scad = (function(){
          const s = String(parsed.scadenza || '').trim();
          if (!s) return '';
          const d = new Date(s);
          return isNaN(d.getTime()) ? '' : d.toISOString().slice(0,10);
        })();

        const comm = {
          id: idNuovo,
          clienteId,
          cliente: clienteRag || (parsed.cliente || ''),
          descrizione: (parsed.descrizione || parsed.articoloDescr || '').trim(),
          articoloCodice: articoloCodiceFinal,
          qtaPezzi: Math.max(1, qtaTot || 1),
          scadenza: scad,
          rifCliente: parsed.rifCliente || null,

          // multi-articolo → righeArticolo
          righeArticolo: righe.map(r => ({
            codice     : r.codice || r.articoloCodice || '',
            descrizione: (r.descrizione || r.articoloDescr || '').trim(),
            um         : String(r.um || r.UM || 'PZ').toUpperCase(),
            qta        : Number(r.qta || r.quantita || 0) || 0,
            note       : r.note || ''
          })),

          fasi      : Array.isArray(parsed.fasi) ? parsed.fasi : [],
          materiali : Array.isArray(parsed.materiali) ? parsed.materiali : [],
          priorita  : 'MEDIA',
          istruzioni: (parsed.istruzioni || '').trim(),
          consegnata: false,
          createdAt : new Date().toISOString(),
          updatedAt : new Date().toISOString()
        };

        // 3) Salva la nuova commessa
        const allCommesse = (window.lsGet && window.lsGet('commesseRows', [])) || [];
        allCommesse.unshift(comm);
        if (window.lsSet) window.lsSet('commesseRows', allCommesse);
        else localStorage.setItem('commesseRows', JSON.stringify(allCommesse));
        window.__anima_dirty = true;

        alert(`Commessa creata: ${comm.id} — ${comm.cliente || ''}`);
        ev.target.value = '';
        location.hash = '#/commesse';
      }catch(e){
        console.error('Import PDF ordine fallito', e);
        alert('Errore durante la lettura del PDF.');
        try { ev.target.value = ''; } catch {}
      }
    }
  });

  // --- UI ---
  return e('div', {className:'grid', style:{gap:16}},

    // elenco + azioni
    e('div', {className:'card'},
      e('div', {className:'actions', style:{justifyContent:'space-between', flexWrap:'wrap'}},
        e('div', {className:'row', style:{gap:8}},
          e('input', {placeholder:'Cerca commesse…', value:q, onChange:ev=>setQ(ev.target.value)}),
          e('button', {className:'btn', onClick:startNew}, '➕ Nuova commessa'),

          // input nascosto (unico) + 2 bottoni come da tua preferenza
          orderPdfInput,

          // A) Vecchio flusso (se esiste): riusa dialog legacy o il file picker
          e('button', { className:'btn btn-outline',
            onClick: ()=> {
              if (typeof window.openImportPDFDialog === 'function') window.openImportPDFDialog();
              else { const el=document.getElementById('order-pdf-input'); if (el) el.click(); }
            }
          }, '📄 Importa PDF'),

          // B) Nuovo flusso: file picker diretto → commessa unica multi-articolo
          e('button', { className:'btn',
            onClick: ()=> {
              if (typeof window.hasRole === 'function' && !window.hasRole('admin')) { alert('Solo admin'); return; }
              const el=document.getElementById('order-pdf-input'); if (el) el.click();
            }
          }, '📄 Importa Ordine (PDF)')
        ),
        e('div', {className:'row', style:{gap:8, alignItems:'center'}},
            e('span', {className:'muted'}, `${filtered.length} record — selezionate: ${selectedList.length}`),
            e('button', {className:'btn', onClick: creaDDTdaSelezionate }, '📦 Crea DDT con selezionate')
          )
      ),

      filtered.length===0
        ? e('div', {className:'muted'}, 'Nessuna commessa')
        : e('table', { className:'table' },
            e('thead', null,
              e('tr', null,
                // checkbox header (se ce l'hai già, lascia questo)
                e('th', {style:{width:36, textAlign:'center'}},
                  e('input', {type:'checkbox',onChange: ()=> toggleAll(filtered),checked: filtered.length > 0 && filtered.every(r => sel[r.id])})
                ),
                e('th', null, 'ID'),
                e('th', null, 'Cliente'),
                e('th', null, 'Descrizione'),
                e('th', null, 'Rif. cliente'),     // ⬅️ NUOVA COLONNA
                e('th', {className:'right'}, 'Q.tà'),
                e('th', null, 'Scadenza'),
                e('th', null, 'Azioni')
                )
            ),
              e('tbody', null,
              filtered
                .slice()
                .sort((a,b) => idKeyC(b) - idKeyC(a))
                .map(c => e('tr', {key:c.id},
                  e('td', {style:{width:36, textAlign:'center'}},
                    e('input', { type:'checkbox', checked: !!sel[c.id], onChange: ()=>toggleRow(c.id) })
                  ),
                  e('td', null, e('a', { href:'#', onClick:(ev)=>{ ev.preventDefault(); startEdit(c); } }, c.id)),
                  e('td', null, c.cliente||''),
                    // Descrizione
                    e('td', null, (() => {
                      if (window.previewDescrAndRef) {
                        try { return window.previewDescrAndRef(c).descr || ''; } catch {}
                      }
                      return c.descrizione || '';
                    })()),

                    // Rif. cliente
                    e('td', null, (() => {
                      if (window.previewDescrAndRef) {
                        try { return window.previewDescrAndRef(c).rifCol || ''; } catch {}
                      }

                      const ref =
                        c.rifCliente ||
                        c.ordineCliente ||
                        c.nrOrdineCliente ||
                        c.ddtCliente ||
                        c.ordine ||
                        c.ordineId ||
                        '';

                      if (!ref) return '';
                      if (typeof ref === 'string') return ref;
                      if (typeof ref === 'object') {
                        const tipo = (ref.tipo || '').toUpperCase();
                        const num  = ref.numero || '';
                        const dt   = ref.data ? new Date(ref.data).toLocaleDateString('it-IT') : '';
                        return [tipo, num, dt].filter(Boolean).join(' ');
                      }
                      return String(ref);
                    })()),

                  e('td', {className:'right'}, String(c.qtaPezzi||1)),
                  e('td', null, c.scadenza || ''),
                  e('td', null,
                    e('button', { className:'btn btn-outline', onClick:()=>window.printCommessa && window.printCommessa(c) }, 'Stampa'), ' ',
                    e('button', { className:'btn btn-outline', onClick:()=>window.openEtichetteColliDialog && window.openEtichetteColliDialog(c) }, 'Etichette'), ' ',
                    e('a', { className:'btn btn-outline', href: timbrUrl(c.id) }, 'QR/Timbr.'), ' ',
                    e('button', { className:'btn btn-outline', onClick:()=>duplicaCommessa(c) }, '⧉ Duplica'), ' ',
                    e('button', { className:'btn btn-outline', onClick:()=>creaDDTdaCommessa(c) }, '📦 DDT'), ' ',
                    e('button', { className:'btn btn-outline', onClick:()=>segnaCompleta(c) }, '✅ Completa'), ' ',
                    e('button', { className:'btn btn-outline', onClick:()=>delCommessa(c) }, '🗑️ Elimina')
                  )
                ))
            )
          )
    ),

    // form
    showForm && e('div', {className:'card', id:'commessa-form'},
      e('h3', null, editingId ? `Modifica commessa ${form.id}` : 'Nuova commessa'),

      e('datalist', { id:'fasiStdList' }, FASI_STD.map((s,i)=> e('option', { key:i, value:s })) ),
      e('datalist', { id:'magArtList' }, (Array.isArray(articoliA)?articoliA:[]).map((a,i)=> e('option', { key:i, value:a.codice||'' }, a.descrizione||'')) ),
      e('datalist', { id:'artList' }, (Array.isArray(articoliA)?articoliA:[]).map((a,i)=> e('option', { key:i, value:a.codice||'' }, a.descrizione||'')) ),

      e('div', {className:'form'},

        // Cliente
        e('div', null, e('label', null, 'Cliente'),
          e('select', {
            name:'clienteId',
            value:form.clienteId||'',
            onChange:ev=>{
              const v = ev.target.value;
              const cli = (clienti||[]).find(x=> String(x.id)===String(v));
              setForm(p=>({ ...p, clienteId:v, cliente: cli ? (cli.ragioneSociale||cli.nome||'') : '' }));
            }
          },
            e('option', {value:''}, '— seleziona —'),
            (clienti||[]).map(c => e('option', {key:c.id, value:c.id}, c.ragioneSociale || c.nome || c.denominazione || c.id))
          )
        ),

        // Articolo (codice)
        e('div', null, e('label', null, 'Articolo (codice)'),
          e('input', {
            name:'articoloCodice', list:'magArtList', value: form.articoloCodice || '',
            onChange: ev => {
              const v = ev.target.value;
              const a = (articoliA||[]).find(x => String(x.codice||'').trim() === String(v||'').trim());
              setForm(p => ({
                ...p,
                articoloCodice: v,
                articoloUM: a ? (a.um || p.articoloUM || '') : p.articoloUM,
                descrizione: p.descrizione ? p.descrizione : (a ? (a.descrizione||'') : '')
              }));
            }
          })
        ),

        // Descrizione
        e('div', null, e('label', null, 'Descrizione / Tipo articolo'),
          e('input', { name:'descrizione', value:form.descrizione||'', onChange:onChange, placeholder:'es. Serbatoio 028' })
        ),

        // Pezzi totali
        e('div', null, e('label', null, 'Pezzi totali'),
          e('input', { type:'number', min:'1', step:'1', name:'qtaPezzi', value:form.qtaPezzi, onChange:onChange })
        ),

        // Ore per pezzo
        e('div', null, e('label', null, 'Ore per pezzo (HH:MM)'),
          e('input', { name:'orePerPezzoHHMM', value:form.orePerPezzoHHMM, onChange:onChange })
        ),

        // Ore totali previste
        e('div', null, e('label', null, 'Ore totali (previste)'),
          e('input', { value: fmtHHMM(form.oreTotaliPrev), readOnly: true })
        ),

        // Scadenza
        e('div', null, e('label', null, 'Scadenza'),
          e('input', { type:'date', name:'scadenza', value:form.scadenza||'', onChange:onChange })
        ),

        // Priorità
        e('div', null, e('label', null, 'Priorità'),
          e('select', { name:'priorita', value:form.priorita||'MEDIA', onChange:onChange },
            e('option',{value:'ALTISSIMA'}, 'ALTISSIMA'),
            e('option',{value:'ALTA'}, 'ALTA'),
            e('option',{value:'MEDIA'}, 'MEDIA'),
            e('option',{value:'BASSA'}, 'BASSA')
          )
        ),

        // Riferimento cliente
        e('div', {style:{gridColumn:'1 / -1'}},
          e('label', null, 'Riferimento cliente (solo gestionale)'),
          e('div', { className:'row', style:{gap:8, flexWrap:'wrap'} },
            e('select', {
              value: (form.rifCliente && form.rifCliente.tipo) || 'ordine',
              onChange: ev => setForm(p => ({ ...p, rifCliente: { ...(p.rifCliente||{}), tipo: ev.target.value } }))
            },
              e('option', {value:'ordine'}, 'Ordine'),
              e('option', {value:'ddt'}, 'DDT'),
              e('option', {value:'altro'}, 'Altro')
            ),
            e('input', {
              placeholder:'Numero (es. 12345)',
              value: (form.rifCliente && form.rifCliente.numero) || '',
              onChange: ev => setForm(p => ({ ...p, rifCliente: { ...(p.rifCliente||{}), numero: ev.target.value } }))
            }),
            e('input', {
              type:'date',
              value: (form.rifCliente && form.rifCliente.data) || '',
              onChange: ev => setForm(p => ({ ...p, rifCliente: { ...(p.rifCliente||{}), data: ev.target.value } }))
            })
          ),
          e('div', { className:'muted' }, 'Non stampato. Serve per richiamarlo nei DDT e poi in fattura.')
        ),

        // Istruzioni
        e('div', {style:{gridColumn:'1 / -1'}},
          e('label', null, 'Istruzioni'),
          e('textarea', { name:'istruzioni', rows:4, value:form.istruzioni||'', onChange:onChange })
        ),

        // Fasi
        e('div', {className:'subcard', style:{gridColumn:'1 / -1'}},
          e('h4', null, 'Fasi di lavorazione'),
          e('table', {className:'table'},
            e('thead', null, e('tr', null, e('th', null, '#'), e('th', null, 'Lavorazione'), e('th', null, 'HH:MM/pezzo'), e('th', null, 'Q.tà'), e('th', null, 'Azioni'))),
            e('tbody', null,
              (form.fasi||[]).map((f,idx)=> e('tr', {key:idx},
                e('td', null, String(idx+1)),
                e('td', null, e('input', { value:f.lav||'', list:'fasiStdList', placeholder:'es. Puntatura', onChange:ev=>onChangeFase(idx,'lav',ev.target.value) })),
                e('td', null, e('input', { value:f.oreHHMM||'0:10', placeholder:'0:10', onChange:ev=>onChangeFase(idx,'oreHHMM',ev.target.value) })),
                e('td', null, e('input', { type:'number', min:'1', step:'1', value:f.qtaPrevista||form.qtaPezzi||1, onChange:ev=>onChangeFase(idx,'qtaPrevista', ev.target.value) })),
                e('td', null, e('button', {className:'btn btn-outline', onClick:()=>delFase(idx)}, '🗑'))
              ))
            )
          ),
          e('div', {className:'actions'}, e('button', {className:'btn', onClick:addFase}, '➕ Aggiungi fase'))
        ),

        // Righe Articolo (multi-articolo)
e('div', {className:'subcard', style:{gridColumn:'1 / -1'}},
  e('h4', null, 'Righe articolo'),
  e('table', {className:'table'},
    e('thead', null,
      e('tr', null,
        e('th', null, 'Codice'),
        e('th', null, 'Descrizione'),
        e('th', null, 'UM'),
        e('th', {className:'right'}, 'Q.tà'),
        e('th', null, 'Note'),
        e('th', null, '')
      )
    ),
    e('tbody', null,
      (Array.isArray(form.righeArticolo) ? form.righeArticolo : []).map((r,idx)=> e('tr', {key:idx},
        e('td', null, e('input', {
          value:r.codice||'',
          list:'magArtList',
          onChange:ev=>onChangeRiga(idx,'codice',ev.target.value)
        })),
        e('td', null, e('input', {
          value:r.descrizione||'',
          onChange:ev=>onChangeRiga(idx,'descrizione',ev.target.value)
        })),
        e('td', null, e('input', {
          value:r.um||'PZ',
          onChange:ev=>onChangeRiga(idx,'um',ev.target.value)
        })),
        e('td', {className:'right'}, e('input', {
          type:'number', step:'1', min:'0',
          value:(r.qta==null?1:r.qta),
          onChange:ev=>onChangeRiga(idx,'qta',ev.target.value)
        })),
        e('td', null, e('input', {
          value:r.note||'',
          onChange:ev=>onChangeRiga(idx,'note',ev.target.value)
        })),
        e('td', null, e('button', {className:'btn btn-outline', onClick:()=>delRiga(idx)}, '🗑'))
      ))
    )
  ),
  e('div', {className:'actions'}, e('button', {className:'btn', onClick:addRiga}, '➕ Aggiungi riga'))
),


        // Materiali previsti
        e('div', {className:'subcard', style:{gridColumn:'1 / -1'}},
          e('h4', null, 'Materiali previsti'),
          e('table', {className:'table'},
            e('thead', null, e('tr', null, e('th', null, 'Codice'), e('th', null, 'Descrizione'), e('th', null, 'UM'), e('th', {className:'right'}, 'Q.tà'), e('th', null, 'Note'), e('th', null, ''))),
            e('tbody', null,
              (form.materiali||[]).map((m,idx)=> e('tr', {key:idx},
                e('td', null, e('input', { value:m.codice||'', list:'artList', onChange:ev=>onChangeMat(idx,'codice',ev.target.value) })),
                e('td', null, e('input', { value:m.descrizione||'', onChange:ev=>onChangeMat(idx,'descrizione',ev.target.value) })),
                e('td', null, e('input', { value:m.um||'', onChange:ev=>onChangeMat(idx,'um',ev.target.value) })),
                e('td', {className:'right'}, e('input', { type:'number', step:'0.01', value:m.qta||0, onChange:ev=>onChangeMat(idx,'qta',ev.target.value) })),
                e('td', null, e('input', { value:m.note||'', onChange:ev=>onChangeMat(idx,'note',ev.target.value) })),
                e('td', null, e('button', {className:'btn btn-outline', onClick:()=>delMat(idx)}, '🗑'))
              ))
            )
          ),
          e('div', {className:'actions'}, e('button', {className:'btn', onClick:addMat}, '➕ Aggiungi materiale'))
        ),

        function addRiga(){
    setForm(p => ({
      ...p,
      righeArticolo: [...(p.righeArticolo||[]), { codice:'', descrizione:'', um:'PZ', qta:1 }]
    }));
  },
  function delRiga(idx){
  setForm(p => ({ ...p, righeArticolo: (p.righeArticolo||[]).filter((_,i)=>i!==idx) }));
},
function onChangeRiga(idx, field, value){
  setForm(p => {
    const arr = Array.isArray(p.righeArticolo) ? p.righeArticolo.slice() : [];
    const r = { ...(arr[idx]||{}) };
    r[field] = (field==='qta') ? (+value||0) : value;
    if (field==='codice') {
      const a = (articoliA||[]).find(x => String(x.codice||'').trim() === String(value||'').trim());
      if (a) { r.descrizione = r.descrizione || a.descrizione || ''; r.um = r.um || a.um || r.um || 'PZ'; }
    }
    arr[idx] = r;
    return { ...p, righeArticolo: arr };
  });
},
        // Righe articolo (multi)
e('div', {className:'subcard', style:{gridColumn:'1 / -1'}},
  e('h4', null, 'Righe articolo (multi)'),
  e('table', {className:'table'},
    e('thead', null,
      e('tr', null,
        e('th', null, 'Codice'),
        e('th', null, 'Descrizione'),
        e('th', null, 'UM'),
        e('th', {className:'right'}, 'Q.tà'),
        e('th', null, '')
      )
    ),
    e('tbody', null,
      (form.righeArticolo||[]).map((r,idx)=> e('tr', {key:idx},
        e('td', null, e('input', { value:r.codice||'', list:'artList', onChange:ev=>onChangeRiga(idx,'codice',ev.target.value) })),
        e('td', null, e('input', { value:r.descrizione||'', onChange:ev=>onChangeRiga(idx,'descrizione',ev.target.value) })),
        e('td', null, e('input', { value:r.um||'PZ', onChange:ev=>onChangeRiga(idx,'um',ev.target.value) })),
        e('td', {className:'right'}, e('input', { type:'number', step:'1', min:'0', value:r.qta||0, onChange:ev=>onChangeRiga(idx,'qta',ev.target.value) })),
        e('td', null, e('button', {className:'btn btn-outline', onClick:()=>delRiga(idx)}, '🗑'))
      ))
    )
  ),
  e('div', {className:'actions'}, e('button', {className:'btn', onClick:addRiga}, '➕ Aggiungi riga'))
),

        // azioni salva/annulla
        e('div', {className:'actions', style:{gridColumn:'1 / -1', justifyContent:'space-between'}},
          e('div', null, e('a', { className:'btn btn-outline', href: timbrUrl(form.id||editingId||'') }, 'Apri QR / Timbratura')),
          e('div', null,
            e('button', {className:'btn btn-outline', onClick:()=>window.printCommessa && window.printCommessa(form)}, 'Stampa'),' ',
            e('button', {className:'btn btn-outline', onClick:()=>window.openEtichetteColliDialog && window.openEtichetteColliDialog(form)}, 'Stampa etichette'),' ',
            e('button', {className:'btn btn-outline', onClick:cancelForm}, 'Annulla'),
            e('button', {className:'btn', onClick:save}, editingId ? 'Aggiorna' : 'Crea')
          )
        )
      )
    )
  );
}
window.CommesseView = CommesseView;


// <-- fine CommesseView

/* ================== IMPORT COMMESSA DA PDF — Loader + estrazione testo ================== */
// Lazy loader di pdf.js (CDN fallback) — idempotente
window.loadPdfJs = window.loadPdfJs || function(){
  return new Promise((resolve, reject)=>{
    try {
      if (window.pdfjsLib && pdfjsLib.getDocument) return resolve(window.pdfjsLib);
      const existing = document.querySelector('script[data-anima="pdfjs"]');
      if (existing) { existing.addEventListener('load', ()=>resolve(window.pdfjsLib)); existing.addEventListener('error', ()=>reject(new Error('pdf.js load failed'))); return; }
      const s = document.createElement('script');
      s.async = true;
      s.defer = true;
      s.dataset.anima = 'pdfjs';
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.7.76/pdf.min.js';
      s.onload = ()=> resolve(window.pdfjsLib);
      s.onerror = ()=> reject(new Error('pdf.js load failed'));
      document.head.appendChild(s);
    } catch(e){ reject(e); }
  });
};

// Estrae testo da tutte le pagine del PDF (grezzo ma robusto)
window.extractTextFromPDF = window.extractTextFromPDF || async function(file){
  const pdfjs = await window.loadPdfJs();
  const ab = (file instanceof ArrayBuffer) ? file : await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(ab) }).promise;
  let full = '';
  for (let i=1; i<=doc.numPages; i++){
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Preferisci “\n” tra elementi per dare chance ai regex riga-per-riga
    const lines = content.items.map(it => (it && typeof it.str==='string') ? it.str : '').filter(Boolean);
    full += '\n' + lines.join('\n');
  }
  return full.replace(/\u00A0/g,' ').trim();
};

// Piccola util per date IT → ISO (YYYY-MM-DD)
window.parseDateIT = window.parseDateIT || function(s){
  const m = String(s||'').trim().match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (!m) return '';
  const dd = String(m[1]).padStart(2,'0');
  const mm = String(m[2]).padStart(2,'0');
  const yyyy = String(m[3]).length===2 ? ('20'+m[3]) : m[3];
  return `${yyyy}-${mm}-${dd}`;
};

/* ================== IMPORT COMMESSA DA PDF — Parser + Modale ================== */
// Heuristics generiche + opzionali parser per-cliente da appSettings.pdfParsers
window.parseOrderText = window.parseOrderText || function (rawText, opts={}){
  const text = String(rawText||'');
  const lower = text.toLowerCase();
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);

  function pickLine(re){ 
    for (const l of lines){ const m = l.match(re); if (m) return m[1]||m[0]; }
    return '';
  }
  function pickAll(re){
    const out=[]; for (const l of lines){ const m = l.match(re); if (m) out.push(m); }
    return out;
  }

  // campi base
  let cliente = pickLine(/^(?:cliente|ragione\s*sociale)\s*[:\-]\s*(.+)$/i) 
             || pickLine(/^([A-Z0-9].{3,80})\s+(?:ordine|commessa|p\.o\.)/i);
  let descr   = pickLine(/^(?:oggetto|descri[sz]ione|prodotto|articolo)\s*[:\-]\s*(.+)$/i) 
             || pickLine(/^(?:item|descr)\s*[:\-]\s*(.+)$/i);
  let qta     = pickLine(/^(?:q\.?t[àa]|quantita'|quantità|pezzi)\s*[:\-]\s*([0-9]+)\b/i) 
             || (lower.match(/\b(qta|quantita'|quantità|pezzi)\b.{0,15}\b(\d{1,6})\b/i)?.[2] || '');
  let consegna= pickLine(/^(?:consegna|data\s*consegna|scadenza)\s*[:\-]\s*([0-9\.\/\-]{8,10})/i) 
             || (lower.match(/\b(consegna|scadenza)\b.{0,20}\b([0-9\.\/\-]{8,10})/i)?.[2] || '');
  let codice  = pickLine(/^(?:codice|articolo|item)\s*[:\-]\s*([A-Z0-9\-\._\/]{2,40})$/i);

  // materiali grezzi (tabelline: codice + quantità + um se presenti)
  const materiali = [];
  const rows = pickAll(/^(?:cod\.?|codice|articolo)\s*[:\-]?\s*([A-Z0-9\-\._\/]{2,40}).{0,40}?(?:q(?:ta|uanti[tàa])|pezzi|qty)\s*[:\-]?\s*([0-9]+(?:[\.,][0-9]+)?)\s*(\w{0,5})?$/i);
  rows.forEach(m=>{
    materiali.push({
      codice: m[1]||'',
      descrizione: '',   // potrai arricchirlo dalla tua anagrafica
      qta: Number(String(m[2]||'0').replace(',','.'))||0,
      um: (m[3]||'').toUpperCase()
    });
  });

  // fallback
  if (!qta){ const m = lower.match(/\b(\d{1,6})\s*(pz|pezzi)\b/); if (m) qta = m[1]; }

  // normalizza
  cliente   = String(cliente||'').trim();
  descr     = String(descr||'').trim();
  qta       = Math.max(1, parseInt(qta||'1',10));
  consegna  = window.parseDateIT(consegna) || '';
  codice    = String(codice||'').trim();

  return { cliente, descrizione: descr, qtaPezzi: qta, scadenza: consegna, codiceCliente: codice, materiali };
};

// Modale UMD per import PDF → proposta campi → crea/aggiorna commessa
window.openImportPDFDialog = window.openImportPDFDialog || function(){
  const e = React.createElement;
  const host = document.createElement('div');
  host.id = 'anima-importpdf-root';
  document.body.appendChild(host);
  const root = ReactDOM.createRoot(host);

  const lsGet = window.lsGet || ((k,d)=>{ try{ return JSON.parse(localStorage.getItem(k)) ?? d; }catch{ return d; }});
  const lsSet = window.lsSet || ((k,v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} });

  function nextIdCommessa(){
    if (window.nextIdUnique) return window.nextIdUnique('commesse','C','commesseRows').id;
    // fallback gestionale
    const counters = lsGet('counters', {});
    const y = new Date().getFullYear();
    const k = `C:${y}`;
    const n = Number(counters[k]||0) + 1;
    counters[k] = n;
    lsSet('counters', counters);
    const NNN = String(n).padStart(3,'0');
    return `C-${y}-${NNN}`;
  }

  async function extractPdfText(file){
    if (typeof window.pdfjsLib === 'undefined') {
      alert('pdfjs non disponibile'); throw new Error('pdfjs missing');
    }
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    let text = '';
    for (let i=1; i<=pdf.numPages; i++){
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const t = content.items.map(it=>it.str).join(' ');
      text += '\n' + t;
    }
    return text.replace(/\s+/g,' ').trim();
  }

  function parseOrderText(rawText, fileName=''){
    // Parser "base": tu personalizzerai con addOrderParser in seguito
    const out = { cliente:'', descrizione:'', qtaPezzi:1, scadenza:'', codiceCliente:'', materiali:[] };
    // Cliente (grezzo)
    const mCliente = rawText.match(/(?:Cliente|Ragione)\s*:\s*([A-Z0-9 .,_-]+)/i);
    if (mCliente) out.cliente = mCliente[1].trim();

    // Scadenza (YYYY-MM-DD o simili)
    const mData = rawText.match(/(?:Consegna|Scadenza)\s*[:\- ]\s*([0-9]{4}[-/][0-9]{2}[-/][0-9]{2})/i);
    if (mData) out.scadenza = mData[1].replace(/\//g,'-');

    // Descrizione (prima riga “lunga” plausibile)
    const mDesc = rawText.match(/(?:Descrizione|Oggetto)\s*[:\- ]\s*([A-Z0-9 ().,_\-\/]{10,})/i);
    if (mDesc) out.descrizione = mDesc[1].trim();

    // Materiali (bozza: righe con CODICE - DESC - QTA [UM?])
    const righe = [];
    const reRiga = /([A-Z0-9_-]{3,})\s+-\s+([^0-9]{5,}?)\s+([0-9]+(?:[.,][0-9]+)?)\s*([A-Z]{1,3})?/gi;
    let m;
    while ((m = reRiga.exec(rawText))){
      righe.push({
        codice: m[1].trim(),
        descrizione: m[2].trim(),
        qta: Number(String(m[3]).replace(',','.')) || 0,
        um: (m[4]||'PZ').trim()
      });
    }
    out.materiali = righe;
    // Q.tà pezzi totale (fallback: somma)
    if (!out.qtaPezzi && righe.length) out.qtaPezzi = righe.reduce((s,r)=> s + (Number(r.qta)||0), 0);
    return out;
  }

  function Modal(){
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [rawText, setRawText] = React.useState('');
    const [form, setForm] = React.useState({
      id: nextIdCommessa(),
      cliente: '',
      descrizione: '',
      qtaPezzi: 1,
      scadenza: '',
      materiali: []
    });

    function onChange(field, value){
      setForm(p => ({ ...p, [field]: value }));
    }

    async function onPickFile(ev){
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      setBusy(true); setError('');
      try{
        const txt = await extractPdfText(f);setRawText(txt);
        const parsed = (window.importOrderFromPDFText ? window.importOrderFromPDFText(txt, f.name||'')
               : (window.parseOrderText ? window.parseOrderText(txt, f.name||'') : {})) || {};


        setForm(p => ({
          ...p,
          cliente: parsed.cliente || p.cliente,
          descrizione: parsed.descrizione || p.descrizione,
          qtaPezzi: parsed.qtaPezzi || p.qtaPezzi,
          scadenza: parsed.scadenza || p.scadenza,
          materiali: Array.isArray(parsed.materiali) ? parsed.materiali : (p.materiali||[])
        }));
      }catch(e){
        console.error(e);
        setError(String(e?.message||e));
      }finally{
        setBusy(false);
      }
    }

    function applyCreateOrUpdate(){
      try{
        const commesse = lsGet('commesseRows', []);
        const exists = commesse.find(c => c.id === form.id);
        const payload = {
          id: form.id,
          cliente: form.cliente,
          descrizione: form.descrizione,
          qtaPezzi: Number(form.qtaPezzi)||1,
          scadenza: form.scadenza || '',
          righe: Array.isArray(form.materiali) ? form.materiali.map(r => ({
            codice: r.codice||'',
            descrizione: r.descrizione||'',
            um: r.um||'PZ',
            qta: Number(r.qta||0)
          })) : []
        };
        if (exists){
          const next = commesse.map(c => c.id===form.id ? ({ ...c, ...payload, updatedAt:new Date().toISOString() }) : c);
          lsSet('commesseRows', next);
          alert('Commessa aggiornata: '+form.id);
        } else {
          const next = [{ ...payload, createdAt: new Date().toISOString() }].concat(commesse);
          lsSet('commesseRows', next);
          alert('Commessa creata: '+form.id);
        }
        // Apri Commesse
        location.hash = '#/commesse';
      }catch(e){ alert('Errore salvataggio: '+(e?.message||e)); }
    }

    function close(){
      try{ root.unmount(); }catch{}
      try{ host.remove(); }catch{}
    }

    return e('div', {style:{
      position:'fixed', inset:0, background:'rgba(0,0,0,.35)', zIndex:10000,
      display:'grid', placeItems:'center', padding:12
    }},
      e('div', {className:'card', style:{width:'100%', maxWidth:720, background:'#fff'}},
        e('div', {className:'row', style:{justifyContent:'space-between', alignItems:'center'}},
          e('h3', null, 'Importa Commessa da PDF'),
          e('button', {className:'btn btn-outline', onClick:close}, 'Chiudi')
        ),
        e('div', {className:'grid', style:{gap:8, gridTemplateColumns:'1fr'}},
          e('label', null, 'Seleziona PDF',
            e('input', {type:'file', accept:'.pdf,application/pdf', onChange:onPickFile, disabled:busy})
          ),
          error && e('div', {className:'muted', style:{color:'#b91c1c'}}, error),
          rawText && e('details', null,
            e('summary', null, 'Anteprima testo estratto'),
            e('pre', {style:{whiteSpace:'pre-wrap', maxHeight:180, overflow:'auto'}}, rawText)
          ),
          e('div', {className:'grid', style:{gap:8, gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))'}},
            e('label', null, 'ID Commessa',
              e('input', {value:form.id, onChange:ev=>onChange('id', ev.target.value)})
            ),
            e('label', null, 'Cliente',
              e('input', {value:form.cliente, onChange:ev=>onChange('cliente', ev.target.value)})
            ),
            e('label', null, 'Q.tà pezzi',
              e('input', {type:'number', min:1, step:1, value:form.qtaPezzi, onChange:ev=>onChange('qtaPezzi', ev.target.value)})
            ),
            e('label', null, 'Scadenza (YYYY-MM-DD)',
              e('input', {value:form.scadenza, onChange:ev=>onChange('scadenza', ev.target.value), placeholder:'2025-11-30'})
            )
          ),
          e('label', null, 'Descrizione',
            e('input', {value:form.descrizione, onChange:ev=>onChange('descrizione', ev.target.value)})
          ),
          e('div', null, e('b', null, 'Materiali individuati')),
          (Array.isArray(form.materiali) && form.materiali.length)
            ? e('table', {className:'table'},
                e('thead', null, e('tr', null,
                  e('th', null, 'Codice'), e('th', null, 'Descrizione'), e('th', null, 'UM'), e('th', {className:'right'}, 'Q.tà')
                )),
                e('tbody', null,
                  form.materiali.map((m, i)=> e('tr', {key:i},
                    e('td', null, e('input', {value: m.codice||'', onChange:ev=>{
                      const a=[...form.materiali]; a[i]={...a[i], codice:ev.target.value}; onChange('materiali', a);
                    }})),
                    e('td', null, e('input', {value: m.descrizione||'', onChange:ev=>{
                      const a=[...form.materiali]; a[i]={...a[i], descrizione:ev.target.value}; onChange('materiali', a);
                    }})),
                    e('td', null, e('input', {value: m.um||'', onChange:ev=>{
                      const a=[...form.materiali]; a[i]={...a[i], um:ev.target.value}; onChange('materiali', a);
                    }})),
                    e('td', {className:'right'}, e('input', {type:'number', step:'0.01', value: m.qta||0, onChange:ev=>{
                      const a=[...form.materiali]; a[i]={...a[i], qta: Number(ev.target.value)||0 }; onChange('materiali', a);
                    }}))
                  ))
                )
              )
            : e('div', {className:'muted'}, '— nessun materiale trovato nel PDF —')
        ),
        e('div', {className:'actions', style:{justifyContent:'flex-end', marginTop:12}},
          e('button', {className:'btn btn-outline', onClick:close}, 'Annulla'),
          e('button', {className:'btn', onClick:applyCreateOrUpdate, disabled:busy}, 'Applica')
        )
      )
    );
  }

  root.render(e(Modal));
}


/* ================== REPORT PRODUZIONE (con Materiali & DDT) ================== */
function ReportProdView({ query = '' } = {}) {
  const e = React.createElement;

  // --- util lettura LS ---
  const ls = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };

  // --- dati base ---
  const commesse  = React.useMemo(() => ls('commesseRows', []), []);
  const oreRows   = React.useMemo(() => ls('oreRows', []), []);
  const movimenti = React.useMemo(() => ls('magMovimenti', []), []);
  const ddtRows   = React.useMemo(() => ls('ddtRows', []), []);
  const articoli  = React.useMemo(() => {
    const a1 = ls('magazzinoArticoli', null);
    if (Array.isArray(a1)) return a1;
    return ls('magArticoli', []);
  }, []);

  // --- selezione commessa (con UI locale) ---
  const [filter, setFilter] = React.useState('');
  const [selId, setSelId]   = React.useState('');
    // 👇 menu “…” (stato + chiusura click fuori)
  const [menuRow, setMenuRow] = React.useState(null);
  React.useEffect(() => {
    const onDocClick = (ev) => {
      if (!ev.target.closest('.dropdown')) setMenuRow(null);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  React.useEffect(() => {
    if (!selId && query) {
      const q = String(query).toLowerCase();
      const found = (commesse||[]).find(c =>
        String(c.id||'').toLowerCase().includes(q) ||
        String(c.cliente||'').toLowerCase().includes(q) ||
        String(c.descrizione||'').toLowerCase().includes(q)
      );
      if (found) setSelId(found.id);
    }
  }, [query, selId, commesse]);

  const opts = React.useMemo(() => (
    (commesse||[])
      .filter(c => {
        const f = String(filter||'').toLowerCase();
        if (!f) return true;
        return String(c.id||'').toLowerCase().includes(f)
            || String(c.cliente||'').toLowerCase().includes(f)
            || String(c.descrizione||'').toLowerCase().includes(f);
      })
      .sort((a,b)=> String(a.id).localeCompare(String(b.id)))
  ), [commesse, filter]);

  const sel = (commesse||[]).find(c => c.id === selId) || null;

  // --- helpers ---
  const fmtIT = d => d ? new Date(d).toLocaleDateString('it-IT') : '';
  const toMin = (s) => {
    if (s == null) return 0;
    const str = String(s).trim();
    if (!str) return 0;
    const m = str.match(/^(\d{1,4})(?::([0-5]?\d))?$/);
    if (!m) return 0;
    const h = parseInt(m[1],10) || 0;
    const mm = parseInt(m[2]||'0',10) || 0;
    return (h*60 + mm);
  };

      // --- formattatore HH:MM robusto (minuti => "H:MM")
    const fmtHHMM = (mins) => {
      const m = Math.max(0, Math.round(mins||0));
      const h = Math.floor(m / 60);
      const mm = String(m % 60).padStart(2, '0');
      return `${h}:${mm}`;
    };

    // --- minuti previsti per fase (segue la logica KPI: per pezzo vs una tantum)
    function plannedMinsOfPhaseRP(fase, commessa){
      if (!fase || !commessa) return 0;
      const base = Number.isFinite(fase.oreMin) ? Math.max(0, Math.round(fase.oreMin)) : toMin(fase.oreHHMM);
      const qta = Math.max(1, Number(commessa.qtaPezzi || 1));
      // Se la fase è una tantum, non moltiplico per i pezzi
      const isOnce = !!(fase.once || fase.unaTantum);
      return isOnce ? base : (base * qta);
    }

    // --- minuti effettivi registrati per fase (somma oreRows per commessaId+faseIdx)
    function effMinsOfPhaseRP(oreRows, commessaId, faseIdx){
      const rows = Array.isArray(oreRows) ? oreRows : [];
      return rows.reduce((S,o)=>{
        try{
          if (String(o.commessaId||'') !== String(commessaId||'')) return S;
          const fi = (o.faseIdx==='' || o.faseIdx==null) ? null : Number(o.faseIdx);
          if (fi !== Number(faseIdx)) return S;
          const add = (Number(o.oreMin)||0) || toMin(o.oreHHMM||0);
          return S + Math.max(0, add||0);
        }catch{ return S; }
      }, 0);
    }

    // — Renderer sicuro per celle tabellari
    const V = (v) => {
      if (v == null) return '';
      if (typeof v === 'object') {
        if (v.id || v.numero || v.data) return String(v.id || v.numero || v.data);
        try { return JSON.stringify(v); } catch { return '[obj]'; }
      }
      return String(v);
    };

  const producedPieces = (typeof window.producedPieces === 'function')
    ? window.producedPieces
    : (c => Array.isArray(c?.fasi) ? c.fasi.reduce((s,f)=> s + (Number(f.qtaProdotta||0)), 0) : 0);


  // ========== KPI ==========
  const kpi = React.useMemo(() => {
    if (!sel) return { pezzi: 0, oreEff: 0, orePrev: 0 };
    const oreEff = (oreRows||[])
      .filter(o => o.commessaId === sel.id)
      .reduce((s,o)=> s + (Number(o.oreMin)||toMin(o.oreHHMM)||0), 0) / 60; // ore

    let perPiece = 0, oneTime = 0;
    (sel.fasi||[]).forEach(f=>{
      const m = Number.isFinite(f.oreMin) ? Math.max(0,Math.round(f.oreMin)) : toMin(f.oreHHMM);
      if (f.once || f.unaTantum) oneTime += m; else perPiece += m;
    });
    const orePrev = ((perPiece * (Number(sel.qtaPezzi)||1)) + oneTime) / 60;
    return { pezzi: producedPieces(sel), oreEff, orePrev };
  }, [sel, oreRows]);

    // === FASI: Prevista vs Usata per la commessa selezionata ===
  const phaseAgg = React.useMemo(()=>{
    if (!sel) return [];
    const fasi = Array.isArray(sel.fasi) ? sel.fasi : [];
    return fasi.map((f, idx) => {
      const pian = plannedMinsOfPhaseRP(f, sel);
      const eff  = effMinsOfPhaseRP(oreRows, sel.id, idx);
      const scostPerc = pian > 0 ? ((eff - pian) / pian * 100) : null;
      const nome = (typeof window.faseLabel === 'function') ? window.faseLabel(sel, idx) : (f.titolo || f.nome || `Fase ${idx+1}`);
      return { idx, nome, pian, eff, delta: (eff - pian), scostPerc };
    });
  }, [sel, oreRows]);

  function exportCSV_Fasi(){
    if (!sel || !phaseAgg.length) return;
    const q = s => { const v = (s==null?'':String(s)); return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v; };
    const header = ['Commessa','Fase','Prevista','Usata','Delta','Scostamento %'];
    const rows = phaseAgg.map(r => [
      sel.id,
      r.nome,
      fmtHHMM(r.pian),
      fmtHHMM(r.eff),
      (r.delta>0?'+':'') + fmtHHMM(r.delta),
      (r.scostPerc==null ? '' : ((r.scostPerc>=0?'+':'') + (Math.round(r.scostPerc*10)/10).toFixed(1) + '%'))
    ]);
    const csv = [header, ...rows].map(a=>a.join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
    a.download = `report_fasi_${sel.id}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // =================== MATERIALI & DDT ===================
  const findArticolo = (codLike) => {
    if (!codLike) return null;
    return (articoli||[]).find(a =>
      String(a.codice||'') === String(codLike) || String(a.id||'') === String(codLike)
    ) || null;
  };
  const getMovKey  = (m) => (m.articolo || m.articoloCodice || m.codice || m.articoloId || '');
  const getMovDesc = (m) => m.descrizione || (findArticolo(getMovKey(m))?.descrizione || '') || '';
  const getMovUM   = (m) => m.um || (findArticolo(getMovKey(m))?.um || '') || '';

  const movCommessa = React.useMemo(() => {
    if (!sel) return [];
    return (Array.isArray(movimenti) ? movimenti : [])
      .filter(m => String(m.commessaId||m.commessa||'').trim() === sel.id)
      .map(m => ({
        data: m.data || '',
        tipo: m.tipo || m.movimento || '',
        codice: m.codice || m.articolo || m.articoloCodice || m.articoloId || '',
        descrizione: getMovDesc(m),
        um: getMovUM(m),
        qta: +(m.qta || m.qty || m.quantita || 0) || 0
      }))
      .sort((a,b)=> (Date.parse(b.data||0)||0) - (Date.parse(a.data||0)||0));
  }, [sel, movimenti, articoli]);

    // --- Aggregazione ore per riga articolo (compat: righeArticolo | righe) ---
  const aggRighe = React.useMemo(() => {
    const target = sel;
    if (!target) return [];
    const righe = Array.isArray(target.righeArticolo)
      ? target.righeArticolo
      : (Array.isArray(target.righe) ? target.righe : []);

    // somma minuti/pezzi per rigaIdx
    const sum = {};
    const toMin = (v) => {
      if (typeof v === 'number') return Math.max(0, Math.round(v));
      const m = String(v||'').match(/^(\d{1,4})(?::([0-5]?\d))?$/);
      if (!m) return 0; const h = +m[1]||0, mm = + (m[2]||0); return h*60+mm;
    };
    (Array.isArray(oreRows)?oreRows:[])
      .filter(r => r && r.commessaId === target.id)
      .forEach(r => {
        const idx = (r.rigaIdx==='' || r.rigaIdx==null) ? -1 : Number(r.rigaIdx);
        const key = String(idx);
        if (!sum[key]) sum[key] = { rigaIdx: (idx>=0?idx:null), oreMin:0, pezzi:0 };
        sum[key].oreMin += (Number(r.oreMin)||0) || toMin(r.oreHHMM||0);
        sum[key].pezzi  += Math.max(0, Number(r.qtaPezzi||0));
      });

    const toHHMM = (mins) => {
      const t = Math.max(0, Math.round(mins)); const h = Math.floor(t/60), m=t%60;
      return `${h}:${String(m).padStart(2,'0')}`;
    };

    return Object.values(sum).map(x => ({
      ...x,
      oreHHMM: toHHMM(x.oreMin),
      rigaCodice     : (x.rigaIdx!=null && righe[x.rigaIdx]) ? (righe[x.rigaIdx].codice || righe[x.rigaIdx].articoloCodice || '') : '',
      rigaDescrizione: (x.rigaIdx!=null && righe[x.rigaIdx]) ? (righe[x.rigaIdx].descrizione || '') : '',
      rigaUM         : (x.rigaIdx!=null && righe[x.rigaIdx]) ? (righe[x.rigaIdx].um || 'PZ') : '',
    })).sort((a,b)=> (a.rigaIdx??99)-(b.rigaIdx??99));
  }, [sel, oreRows]);

  const isScarico = (row) => {
    const t = String(row.tipo||'').toLowerCase();
    return t.includes('scarico') || Number(row.qta) < 0;
  };

  const consumiAgg = React.useMemo(() => {
    const map = {};
    (movCommessa||[]).forEach(r => {
      if (!isScarico(r)) return;
      const key = r.codice || r.descrizione || '(senza codice)';
      if (!map[key]) map[key] = {
        codice: r.codice || '',
        descrizione: r.descrizione || '',
        um: r.um || '',
        usata: 0
      };
      map[key].usata += Math.abs(r.qta || 0);
    });
    return Object.values(map).sort((a,b)=> String(a.codice).localeCompare(String(b.codice)));
  }, [movCommessa]);

  const previsti = React.useMemo(() => {
    const arr = (sel && Array.isArray(sel.materiali)) ? sel.materiali : [];
    return arr.map(m => ({
      codice: m.codice || '',
      descrizione: m.descrizione || '',
      um: m.um || '',
      prevista: +(m.qta || 0) || 0
    }));
  }, [sel]);

  const righeMerge = React.useMemo(() => {
    const byKeyPrev = {};
    (previsti||[]).forEach(p => {
      const k = p.codice || p.descrizione || '(senza codice)';
      byKeyPrev[k] = p;
    });
    const keys = new Set([
      ...Object.keys(byKeyPrev),
      ...consumiAgg.map(c => c.codice || c.descrizione || '(senza codice)')
    ]);
    const rows = [];
    keys.forEach(k => {
      const p = byKeyPrev[k] || { prevista: 0, um: '', descrizione: '' };
      const c = consumiAgg.find(x => (x.codice||x.descrizione||'(senza codice)') === k) || { usata: 0, um: '', descrizione: '' };
      rows.push({
        codice: (k === '(senza codice)') ? '' : k,
        descrizione: c.descrizione || p.descrizione || '',
        um: c.um || p.um || '',
        prevista: +p.prevista || 0,
        usata: +c.usata || 0,
        delta: (+c.usata||0) - (+p.prevista||0)
      });
    });
    return rows.sort((a,b)=> String(a.codice).localeCompare(String(b.codice)));
  }, [previsti, consumiAgg]);

  const totPrevista = righeMerge.reduce((s,r)=> s + (r.prevista||0), 0);
  const totUsata   = righeMerge.reduce((s,r)=> s + (r.usata||0), 0);
  const totDelta   = righeMerge.reduce((s,r)=> s + (r.delta||0), 0);

  const ddtCommessa = React.useMemo(() => {
    if (!sel) return [];
    return (Array.isArray(ddtRows) ? ddtRows : [])
      .filter(d => String(d.commessa||'') === sel.id)
      .sort((a,b)=> (Date.parse(b.data||0)||0) - (Date.parse(a.data||0)||0));
  }, [sel, ddtRows]);

      // --- Aggregazione ORE per riga articolo (commessa selezionata) ---
  const oreRiga = React.useMemo(() => {
    if (!sel) return [];
    const arr = Array.isArray(oreRows) ? oreRows.filter(r => String(r.commessaId) === String(sel.id)) : [];
    const by = new Map();

    const toMin = (v) => {
      if (typeof v === 'number') return Math.max(0, Math.round(v));
      const m = String(v || '').trim().match(/^(\d{1,4})(?::([0-5]?\d))?$/);
      if (!m) return 0;
      const h = +m[1] || 0, mm = +(m[2] || 0);
      return h * 60 + mm;
    };

    for (const r of arr) {
      const key = (r.rigaIdx == null || r.rigaIdx === '') ? 'ALL' : String(Number(r.rigaIdx));
      const cur = by.get(key) || {
        rigaIdx: (r.rigaIdx == null || r.rigaIdx === '') ? null : Number(r.rigaIdx),
        rigaCodice: r.rigaCodice || '',
        rigaDescrizione: r.rigaDescrizione || '',
        rigaUM: r.rigaUM || 'PZ',
        pezzi: 0,
        oreMin: 0
      };

      const addMins =
        (Number(r.oreMin) || 0) ||
        toMin(r.oreHHMM || 0);

      cur.oreMin += Math.max(0, addMins);
      cur.pezzi  += Math.max(0, Number(r.qtaPezzi || 0));
      // ultimo valore "vince" per i metadati riga
      if (r.rigaCodice)      cur.rigaCodice      = String(r.rigaCodice);
      if (r.rigaDescrizione) cur.rigaDescrizione = String(r.rigaDescrizione);
      if (r.rigaUM)          cur.rigaUM          = String(r.rigaUM);

      by.set(key, cur);
    }

    return Array.from(by.values()).sort((a,b) => (a.rigaIdx ?? 999) - (b.rigaIdx ?? 999));
  }, [sel, oreRows]);

  // --- azioni ---
  function exportCSV(){
    if (!sel) return;
    const rows = [
      ['Commessa', sel.id],
      ['Cliente', (sel.cliente||'')],
      ['Descrizione', (sel.descrizione||'')],
      [],
      ['Codice','Descrizione','UM','Prevista','Usata','Delta']
    ];
    (righeMerge||[]).forEach(r => rows.push([
      r.codice||'',
      r.descrizione||'',
      r.um||'',
      String(r.prevista||0),
      String(r.usata||0),
      String(r.delta||0)
    ]));
    const csv = rows.map(row =>
      row.map(v => {
        const s = String(v==null?'':v);
        return /[;"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
      }).join(';')
    ).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download = `report-commessa-${sel.id}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

    // === Card: Ore per riga articolo (selezione attuale) ===
const cardOreRiga = (sel && Array.isArray(aggRighe) && aggRighe.length>0)
  ? e('div', { className:'card', style:{marginTop:8} },
      e('h3', null, 'Ore per riga articolo'),
      e('table', { className:'table' },
        e('thead', null, e('tr', null,
          e('th', null, 'Riga #'),
          e('th', null, 'Codice'),
          e('th', null, 'Descrizione'),
          e('th', null, 'UM'),
          e('th', {className:'right'}, 'Pezzi'),
          e('th', {className:'right'}, 'Minuti'),
          e('th', {className:'right'}, 'HH:MM')
        )),
        e('tbody', null,
          aggRighe.map((r,i) => e('tr', { key:i },
            e('td', null, r.rigaIdx==null ? '—' : String(r.rigaIdx+1)),
            e('td', null, r.rigaCodice || ''),
            e('td', null, r.rigaDescrizione || ''),
            e('td', null, r.rigaUM || ''),
            e('td', { className:'right' }, String(r.pezzi || 0)),
            e('td', { className:'right' }, String(r.oreMin || 0)),
            e('td', { className:'right' }, (function(m){ const h=Math.floor(m/60), mm=m%60; return h+':'+String(mm).padStart(2,'0'); })(r.oreMin || 0))
          ))
        )
      )
    )
  : null;

  function exportCSV_Fasi(){
    if (!sel || !phaseAgg.length) return;
    const q = s => {
      const v = (s==null ? '' : String(s));
      return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v;
    };
    const header = ['Commessa','Fase','Prevista','Usata','Delta','Scostamento %'];
    const rows = phaseAgg.map(r => [
      sel.id,
      r.nome,
      fmtHHMM(r.pian),
      fmtHHMM(r.eff),
      (r.delta>0?'+':'') + fmtHHMM(r.delta),
      (r.scostPerc==null ? '' : ((r.scostPerc>=0?'+':'') + (Math.round(r.scostPerc*10)/10).toFixed(1) + '%'))
    ]);
    const csv = [header, ...rows].map(a=>a.join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
    a. download = `report_fasi_${sel.id}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // -------------------- RENDER --------------------
  return e('div', { className:'grid', style:{ gap:16 } },

    // Card selezione commessa (sempre visibile)
    e('div', { className:'card' },
      e('h3', null, 'Seleziona commessa'),
      e('div', { className:'row', style:{ gap:8, alignItems:'center', marginTop:8, flexWrap:'wrap' } },
        e('input', {
          className:'input',
          style:{ maxWidth:280 },
          placeholder:'Filtra per ID, cliente o descrizione…',
          value:filter, onChange:ev=>setFilter(ev.target.value)
        }),
        e('select', {
          value: selId || '',
          onChange: ev => setSelId(ev.target.value),
          style: { minWidth:260 }
        },
          e('option', { value:'' }, '— scegli una commessa —'),
          opts.map(c => e('option', { key:c.id, value:c.id },
            `${c.id} — ${c.cliente||''}${c.descrizione?(' — '+c.descrizione):''}`
          ))
        ),
        sel && e('a', { className:'btn btn-outline', href:`#/timbratura?job=${encodeURIComponent(sel.id)}` }, 'QR / Timbratura')
      ),
      !sel && e('div', { className:'muted', style:{ marginTop:8 } }, 'Seleziona una commessa per vedere i dettagli.')
    ),

    // Barra superiore azioni (solo con commessa selezionata)
    sel && e('div', { className:'row', style:{gap:6, alignItems:'center', flexWrap:'wrap'} },
      e('button', { className:'btn btn-outline', onClick:()=> window.printCommessa && window.printCommessa(sel) }, 'Stampa'),
      e('button', { className:'btn btn-outline', onClick:exportCSV }, 'Esporta CSV'),
      e('button', { className:'btn btn-outline', onClick:()=> window.creaDDTdaCommessa && window.creaDDTdaCommessa(sel) }, '📦 DDT'),
      e('div', { className:'dropdown', style:{position:'relative', display:'inline-block'} },
        e('button', {
          className:'btn',
          onClick:()=> setMenuRow(r => r===sel.id ? null : sel.id)
        }, '…'),
        (menuRow===sel.id) && e('div', {
          className:'dropdown-menu',
          style:{
            position:'absolute', right:0, top:'100%', marginTop:6,
            background:'#fff', border:'1px solid #ddd', borderRadius:8,
            padding:8, minWidth:180, zIndex:1000,
            boxShadow:'0 8px 24px rgba(0,0,0,.12)'
          }
        },
          e('button', { className:'btn btn-outline', style:{width:'100%'},
            onClick:()=>{ setMenuRow(null);
              (window.openEtichetteColliDialog ? window.openEtichetteColliDialog(sel)
               : window.triggerEtichetteFor && window.triggerEtichetteFor(sel, {}));
            }}, 'Etichette colli'),
          e('button', { className:'btn btn-outline', style:{width:'100%'},
            onClick:()=>{ setMenuRow(null); window.duplicaCommessa && window.duplicaCommessa(sel); }}, '⧉ Duplica'),
          e('button', { className:'btn btn-outline', style:{width:'100%'},
            onClick:()=>{ setMenuRow(null); window.delCommessa && window.delCommessa(sel); }}, '🗑️ Elimina')
        )
      )
    ),

    // KPI rapidi produzione
    sel && e('div', { className:'card' },
      e('h3', null, `Commessa ${sel.id} — KPI`),
      e('div', { className:'row', style:{ gap:16, flexWrap:'wrap' } },
        e('div', { className:'kpi' }, e('div', {className:'muted'}, 'Pezzi prodotti'), e('div', {style:{fontWeight:800, fontSize:20}}, String(kpi.pezzi||0)) ),
        e('div', { className:'kpi' }, e('div', {className:'muted'}, 'Ore effettive'), e('div', {style:{fontWeight:800, fontSize:20}}, (kpi.oreEff||0).toFixed(2)) ),
        e('div', { className:'kpi' }, e('div', {className:'muted'}, 'Ore previste'), e('div', {style:{fontWeight:800, fontSize:20}}, (kpi.orePrev||0).toFixed(2)) )
      )
    ),

      // === Tempi per fase — Prevista vs Usata ===
      e('div', { className:'actions', style:{ justifyContent:'space-between', marginTop:8 } },
        e('h3', null, 'Tempi per fase — Prevista vs Usata'),
        e('div', { className:'row', style:{ gap:8 } },
          e('button', { className:'btn btn-outline', onClick:exportCSV_Fasi, disabled:!(sel && phaseAgg.length) }, '⬇️ CSV')
        )
      ),
      e('div', { className:'card' },
        !sel
          ? e('div', { className:'muted' }, 'Seleziona una commessa dalla lista sopra.')
          : (phaseAgg.length===0
              ? e('div', { className:'muted' }, 'Nessuna fase definita per questa commessa.')
              : e('table', { className:'table' },
                  e('thead', null, e('tr', null,
                    e('th', null, 'Fase'),
                    e('th', { className:'right' }, 'Prevista'),
                    e('th', { className:'right' }, 'Usata'),
                    e('th', { className:'right' }, 'Delta'),
                    e('th', { className:'right' }, 'Scost. %')
                  )),
                  e('tbody', null,
                    phaseAgg.map((r,i)=> e('tr', { key:i },
                      e('td', null, r.nome),
                      e('td', { className:'right' }, fmtHHMM(r.pian)),
                      e('td', { className:'right' }, fmtHHMM(r.eff)),
                      e('td', { className:'right' }, (r.delta>0?'+':'') + fmtHHMM(r.delta)),
                      e('td', { className:'right' },
                        (r.scostPerc==null ? '' :
                          e('span', {
                            style:{ fontWeight:600, color: (r.scostPerc>1 ? '#b91c1c' : (r.scostPerc<-1 ? '#065f46' : '#374151')) }
                          }, (r.scostPerc>=0?'+':'') + (Math.round(r.scostPerc*10)/10).toFixed(1) + '%')
                        )
                      )
                    ))
                  )
               )
            )
      ),

            // Tempi per fase — Prevista vs Usata
    sel && e('div', { className:'actions', style:{ justifyContent:'space-between', marginTop:8 } },
      e('h3', null, 'Tempi per fase — Prevista vs Usata'),
      e('div', { className:'row', style:{ gap:8 } },
        e('button', { className:'btn btn-outline', onClick:exportCSV_Fasi, disabled:!(sel && phaseAgg.length) }, '⬇️ CSV')
      )
    ),
    sel && e('div', { className:'card' },
      !phaseAgg.length
        ? e('div', { className:'muted' }, 'Nessuna fase definita per questa commessa.')
        : e('table', { className:'table' },
            e('thead', null, e('tr', null,
              e('th', null, 'Fase'),
              e('th', { className:'right' }, 'Prevista'),
              e('th', { className:'right' }, 'Usata'),
              e('th', { className:'right' }, 'Delta'),
              e('th', { className:'right' }, 'Scost. %')
            )),
            e('tbody', null,
              phaseAgg.map((r,i)=> e('tr', { key:i },
                e('td', null, r.nome),
                e('td', { className:'right' }, fmtHHMM(r.pian)),
                e('td', { className:'right' }, fmtHHMM(r.eff)),
                e('td', { className:'right' }, (r.delta>0?'+':'') + fmtHHMM(r.delta)),
                e('td', { className:'right' },
                  (r.scostPerc==null ? '' :
                    e('span', {
                      style:{ fontWeight:600, color: (r.scostPerc>1 ? '#b91c1c' : (r.scostPerc<-1 ? '#065f46' : '#374151')) }
                    }, (r.scostPerc>=0?'+':'') + (Math.round(r.scostPerc*10)/10).toFixed(1) + '%')
                  )
                )
              ))
            )
          )
    ),

    // Header commessa
    sel && e('div', {className:'card'},
      e('h3', {style:{fontSize:18, fontWeight:600, marginBottom:8}}, `Commessa ${sel.id}`),
      e('table', {className:'table'},
        e('tbody', null,
          e('tr', null, e('th', null, 'Cliente'),        e('td', null, sel.cliente || '-')),
          e('tr', null, e('th', null, 'Descrizione'),    e('td', null, sel.descrizione || '-')),
          e('tr', null, e('th', null, 'Scadenza'),       e('td', null, fmtIT(sel.scadenza))),
          e('tr', null, e('th', null, 'Quantità pezzi'), e('td', null, sel.qtaPezzi || 1)),
          e('tr', null, e('th', null, 'Priorità'),       e('td', null, sel.priorita || '-')),
          e('tr', null, e('th', null, 'Stato'),
            e('td', null, sel.consegnata ? `Consegnata il ${fmtIT(sel.dataConsegna)}` : 'Aperta')
          )
        )
      )
    ),

    // Materiali: previsti vs usati
    sel && e('div', {className:'card'},
      e('h3', {style:{fontSize:18, fontWeight:600, marginBottom:8}}, 'Materiali: previsti vs usati'),
      e('table', {className:'table'},
        e('thead', null,
          e('tr', null,
            e('th', null, 'Codice'),
            e('th', null, 'Descrizione'),
            e('th', null, 'UM'),
            e('th', {className:'right'}, 'Prevista'),
            e('th', {className:'right'}, 'Usata'),
            e('th', {className:'right'}, 'Delta')
          )
        ),
        e('tbody', null,
          righeMerge.map((r,i) => e('tr', {key:i},
            e('td', null, r.codice || '—'),
            e('td', null, r.descrizione || '—'),
            e('td', null, r.um || '—'),
            e('td', {className:'right'}, String(r.prevista||0)),
            e('td', {className:'right'}, String(r.usata||0)),
            e('td', {className:'right', style:{fontWeight:600}},
              (r.delta>0 ? '+' : '') + String(r.delta||0)
            )
          ))
        ),
        e('tfoot', null,
          e('tr', null,
            e('th', {colSpan:3}, 'Totale'),
            e('th', {className:'right'}, String(totPrevista||0)),
            e('th', {className:'right'}, String(totUsata||0)),
            e('th', {className:'right'}, (totDelta>0?'+':'') + String(totDelta||0))
          )
        )
      )
    ),

          // Ore per riga articolo (commessa selezionata)
    sel && e('div', { className:'card' },
      e('h3', {style:{fontSize:18, fontWeight:600, marginBottom:8}}, 'Ore per riga articolo'),
      (oreRiga.length === 0)
        ? e('div', { className:'muted' }, '— Nessun dato per righe articolo —')
        : e('table', { className:'table' },
            e('thead', null,
              e('tr', null,
                e('th', null, 'Riga #'),
                e('th', null, 'Codice'),
                e('th', null, 'Descrizione'),
                e('th', null, 'UM'),
                e('th', {className:'right'}, 'Pezzi'),
                e('th', {className:'right'}, 'Minuti'),
                e('th', {className:'right'}, 'HH:MM')
              )
            ),
            e('tbody', null,
              oreRiga.map((r,i) => e('tr', { key:i },
                e('td', null, r.rigaIdx == null ? '—' : String(r.rigaIdx + 1)),
                e('td', null, r.rigaCodice || ''),
                e('td', null, r.rigaDescrizione || ''),
                e('td', null, r.rigaUM || ''),
                e('td', { className:'right' }, String(r.pezzi || 0)),
                e('td', { className:'right' }, String(r.oreMin || 0)),
                e('td', { className:'right' }, (function(m){ const h=Math.floor(m/60), mm=m%60; return h+':'+String(mm).padStart(2,'0'); })(r.oreMin || 0))
              ))
            )
          )
    ),

        // === Ore per riga articolo (se presente) ===
        cardOreRiga,

    // DDT collegati (resiliente)
    sel && e('div', {className:'card'},
      e('h3', {style:{fontSize:18, fontWeight:600, marginBottom:8}}, 'DDT collegati'),
      (Array.isArray(ddtCommessa) && ddtCommessa.length>0)
        ? e('table', {className:'table'},
            e('thead', null,
              e('tr', null,
                e('th', null, 'ID'),
                e('th', null, 'Data'),
                e('th', null, 'Cliente'),
                e('th', null, 'Note'),
                e('th', null, 'Righe')
              )
            ),
            e('tbody', null,
              ddtCommessa.map((d,i) => {
                const _id      = d?.id ?? '—';
                const _data    = d?.data ? fmtIT(d.data) : '—';
                const _cliente = d?.clienteRagione ?? '—';
                const _note    = d?.note ?? '—';
                const _righe   = Array.isArray(d?.articoli) ? d.articoli.length : 0;
                return e('tr', {key:i},
                  e('td', null, String(_id)),
                  e('td', null, String(_data)),
                  e('td', null, String(_cliente)),
                  e('td', null, String(_note)),
                  e('td', null, String(_righe))
                );
              })
            )
          )
        : e('div', {className:'muted'}, '— Nessun DDT collegato —')
    )


  );
}

/* ================== REPORT MATERIALI (Aggregato per Articolo, filtrabile) ================== */
function ReportMaterialiView({ query = '' } = {}) {
  const e = React.createElement;

  // LS helper
  const ls = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };

  // Dataset base
  const commesse  = React.useMemo(() => ls('commesseRows', []), []);
  const movimenti = React.useMemo(() => ls('magMovimenti', []), []);
  const articoli  = React.useMemo(() => {
    const a1 = ls('magazzinoArticoli', null);
    if (Array.isArray(a1)) return a1;
    return ls('magArticoli', []);
  }, []);

  // Indici rapidi
  const commById = React.useMemo(() => {
    const m = new Map();
    (commesse||[]).forEach(c => m.set(String(c.id), c));
    return m;
  }, [commesse]);

  const findArticolo = (code) => {
    const c = String(code||'');
    if (!c) return null;
    return (articoli||[]).find(a =>
      String(a.codice||'') === c || String(a.id||'') === c
    ) || null;
  };

  // Filtri UI
  const [dal, setDal]               = React.useState('');
  const [al, setAl]                 = React.useState('');
  const [fltCliente, setFltCliente] = React.useState('');
  const [fltComm, setFltComm]       = React.useState('');       // contiene...
  const [fltArt, setFltArt]         = React.useState(query||'');// contiene...
  const [soloScarichi, setSoloScar] = React.useState(true);

  // Normalizzo movimenti con meta (cliente/descrizione articolo)
  const norm = React.useMemo(() => {
    const fromTs = dal ? Date.parse(dal) : null;
    const toTs   = al  ? (Date.parse(al) + 24*3600*1000 - 1) : null; // inclusivo
    const out = [];

    (Array.isArray(movimenti)?movimenti:[]).forEach(m => {
      const ts = Date.parse(m.data || '');
      if (fromTs && !(ts >= fromTs)) return;
      if (toTs && !(ts <= toTs)) return;

      const commId = String(m.commessaId || m.commessa || '').trim();
      const c = commById.get(commId) || null;
      const cliente = (c?.cliente || '').toLowerCase();
      if (fltCliente && !cliente.includes(fltCliente.toLowerCase())) return;

      if (fltComm) {
        const hay = [commId, (c?.descrizione||''), (c?.cliente||'')].join(' ').toLowerCase();
        if (!hay.includes(fltComm.toLowerCase())) return;
      }

      const codice = m.codice || m.articolo || m.articoloCodice || m.articoloId || '';
      const a      = findArticolo(codice);
      const descr  = m.descrizione || a?.descrizione || '';
      const um     = m.um || a?.um || '';

      const mov = String(m.tipo || m.movimento || '').toLowerCase();
      const qty = +(m.qta || m.qty || m.quantita || 0) || 0;

      // filtro “solo scarichi”
      if (soloScarichi) {
        const isScar = mov.includes('scarico') || qty < 0;
        if (!isScar) return;
      }

      const hayArt = [String(codice), String(descr)].join(' ').toLowerCase();
      if (fltArt && !hayArt.includes(fltArt.toLowerCase())) return;

      out.push({
        data: m.data || '',
        ts, mov,
        commessaId: commId || '',
        cliente: c?.cliente || '',
        codice: String(codice||''),
        descrizione: String(descr||''),
        um: String(um||''),
        qta: qty
      });
    });

    return out.sort((a,b)=> (a.codice.localeCompare(b.codice) || (a.ts - b.ts)));
  }, [movimenti, articoli, commById, dal, al, fltCliente, fltComm, fltArt, soloScarichi]);

  // Aggregazione per articolo
  const agg = React.useMemo(() => {
    const map = new Map();
    norm.forEach(r => {
      const key = r.codice || r.descrizione || '(senza codice)';
      if (!map.has(key)) {
        map.set(key, {
          codice: (key === '(senza codice)') ? '' : key,
          descrizione: r.descrizione || '',
          um: r.um || '',
          qta: 0,
          nMov: 0,
          minData: r.ts || null,
          maxData: r.ts || null,
          commesse: new Set()
        });
      }
      const cur = map.get(key);
      cur.qta  += (soloScarichi ? Math.abs(r.qta) : r.qta);
      cur.nMov += 1;
      cur.minData = (cur.minData==null) ? r.ts : Math.min(cur.minData, r.ts);
      cur.maxData = (cur.maxData==null) ? r.ts : Math.max(cur.maxData, r.ts);
      if (r.commessaId) cur.commesse.add(r.commessaId);
    });
    return Array.from(map.values())
      .map(x => ({
        ...x,
        nComm: x.commesse.size,
        dal: (x.minData ? new Date(x.minData).toLocaleDateString('it-IT') : ''),
        al:  (x.maxData ? new Date(x.maxData).toLocaleDateString('it-IT') : '')
      }))
      .sort((a,b)=> a.codice.localeCompare(b.codice));
  }, [norm, soloScarichi]);

  function exportCSV(){
    const header = ['Codice','Descrizione','UM','Q.tà','Movimenti','#Commesse','Dal','Al'];
    const body = agg.map(r => [
      r.codice, r.descrizione, r.um,
      String(r.qta), String(r.nMov), String(r.nComm), r.dal, r.al
    ]);
    const csv = [header, ...body].map(row =>
      row.map(v => {
        const s = String(v||'');
        return /[;"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
      }).join(';')
    ).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download = 'report_materiali_aggregato.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return e('div', {className:'grid', style:{gap:16}},
    e('div', {className:'actions', style:{justifyContent:'space-between'}},
      e('h3', null, 'Report Materiali — Aggregato per articolo'),
      e('div', {className:'row', style:{gap:8}},
        e('button', {className:'btn btn-outline', onClick:exportCSV}, 'Esporta CSV')
      )
    ),
    e('div', {className:'card'},
      e('div', {className:'grid', style:{gap:8, gridTemplateColumns:'repeat(auto-fit, minmax(180px,1fr))'}},
        e('label', null, 'Dal (data)',
          e('input', {type:'date', value:dal, onChange:ev=>setDal(ev.target.value)})
        ),
        e('label', null, 'Al (data)',
          e('input', {type:'date', value:al, onChange:ev=>setAl(ev.target.value)})
        ),
        e('label', null, 'Cliente contiene',
          e('input', {value:fltCliente, onChange:ev=>setFltCliente(ev.target.value), placeholder:'es. Brembo'})
        ),
        e('label', null, 'Commessa contiene',
          e('input', {value:fltComm, onChange:ev=>setFltComm(ev.target.value), placeholder:'es. C-2025'})
        ),
        e('label', null, 'Articolo/Descrizione contiene',
          e('input', {value:fltArt, onChange:ev=>setFltArt(ev.target.value), placeholder:'codice o testo'})
        ),
        e('label', {className:'row', style:{alignItems:'center', gap:6, marginTop:4}},
          e('input', {type:'checkbox', checked:soloScarichi, onChange:ev=>setSoloScar(ev.target.checked)}),
          e('span', null, 'Solo scarichi (consumi)')
        )
      )
    ),
    e('div', {className:'card'},
      agg.length===0
        ? e('div', {className:'muted'}, '— Nessun dato con i filtri correnti —')
        : e('table', {className:'table'},
            e('thead', null,
              e('tr', null,
                e('th', null, 'Codice'),
                e('th', null, 'Descrizione'),
                e('th', null, 'UM'),
                e('th', {className:'right'}, 'Q.tà'),
                e('th', {className:'right'}, 'Movimenti'),
                e('th', {className:'right'}, '# Commesse'),
                e('th', null, 'Dal'),
                e('th', null, 'Al')
              )
            ),
            e('tbody', null,
              agg.map((r,i)=> e('tr', {key:i},
                e('td', null, r.codice || '—'),
                e('td', null, r.descrizione || '—'),
                e('td', null, r.um || '—'),
                e('td', {className:'right'}, String(r.qta)),
                e('td', {className:'right'}, String(r.nMov)),
                e('td', {className:'right'}, String(r.nComm)),
                e('td', null, r.dal || '—'),
                e('td', null, r.al  || '—')
              ))
            )
          )
    )
  );
}
window.ReportMaterialiView = window.ReportMaterialiView || ReportMaterialiView;

// Compat: alias e agganci globali
window.ReportProdView = ReportProdView;
window.ReportView = window.ReportView || ReportProdView;
window.openReport = window.openReport || function () {
  if (typeof window.setTab === 'function') window.setTab('Report');
  if (location.hash !== '#/report') location.hash = '#/report';
};


/* ================== IMPOSTAZIONI (unificata: logo, operatori, fasi, cloud) ================== */
function ImpostazioniView() {
  const e = React.createElement;

  const isAdmin = window.hasRole && window.hasRole('admin');
  // se non admin, non blocchiamo: mostriamo la vista ma disabilitiamo i campi più avanti (quando definisci gli <input>, metti disabled: !isAdmin)


  // Helpers LS
  const lsGet = window.lsGet || ((k,d)=>{ try{ const v=JSON.parse(localStorage.getItem(k)); return (v??d);}catch{return d;}});

  // Fallback locale se l'helper globale non fosse presente
  const updateAppSettings = window.updateAppSettings || function(patch){
    try{
      const cur = JSON.parse(localStorage.getItem('appSettings')||'{}') || {};
      const next = { ...cur, ...(patch||{}), updatedAt: new Date().toISOString() };
      localStorage.setItem('appSettings', JSON.stringify(next));
      window.__anima_dirty = true;
      return next;
    }catch(e){ console.error('updateAppSettings error', e); }
  };

  // Stato iniziale da appSettings
  const app0 = lsGet('appSettings', {}) || {};
  const counters0 = lsGet('counters', {}) || {};
  const Y = new Date().getFullYear();
  const last = (series) => {
    const c = counters0[series];
    return (c && c.year === Y) ? Number(c.num) || 0 : 0;
  };

  const operatorsTextInitial =
    Array.isArray(app0.operators) ? app0.operators.join('\n')
    : (typeof app0.operators==='string' ? String(app0.operators).replace(/[,;|]/g,'\n') : '');

  const [form, setForm] = React.useState({
    publicBaseUrl : app0.publicBaseUrl || '',
    magUpdateCMP  : !!app0.magUpdateCMP,

    // Dati azienda
    ragioneSociale   : app0.ragioneSociale || app0.aziendaNome || '',
    piva             : app0.piva || app0.pIva || '',
    sedeLegale       : app0.sedeLegale || '',
    sedeOperativa    : app0.sedeOperativa || '',
    email            : app0.email || '',
    telefono         : app0.telefono || '',

    // ► Dati fiscali aggiuntivi
    rea              : app0.rea || '',
    capitaleSociale  : app0.capitaleSociale || app0.capitale || '',
    sdi              : app0.sdi || app0.codiceSdi || '',
    regimeFiscale    : app0.regimeFiscale || 'RF01',

    // ► Dati bancari (stampa di cortesia)
    bankName         : app0.bankName || '',
    bankHolder       : app0.bankHolder || '',
    iban             : app0.iban || '',
    bic              : app0.bic || '',

    // Progressivi (peek ultimo usato nell'anno)
    numC   : last('C')   || '',
    numDDT : last('DDT') || '',
    numFA  : last('FA')  || '',
    numOF  : last('OF')  || '',

    // Default documenti
    defaultIva       : Number.isFinite(+app0.defaultIva) ? +app0.defaultIva : 22,
    defaultPagamento : app0.defaultPagamento || '30 gg data fattura',

    // Operatori (multiline)
    operatorsText    : operatorsTextInitial,

    // Cloud (Supabase)
    cloudEnabled     : !!app0.cloudEnabled,
    supabaseUrl      : app0.supabaseUrl || '',
    supabaseKey      : app0.supabaseKey || '',
    supabaseTable    : app0.supabaseTable || 'anima_sync',

    // Fasi standard
    fasiStandard     : Array.isArray(app0.fasiStandard) ? app0.fasiStandard : [],

    // Logo (base64 per stampe)
    logoDataUrl      : app0.logoDataUrl || ''
  });

  function onChange(ev){
    const {name, value, type, checked} = ev.target;
    setForm(p => ({ ...p, [name]: (type==='checkbox' ? !!checked : value) }));
  }

  // Parse operatori
  function parseOperators(text){
    const arr = String(text||'')
      .split(/\r?\n|,|;|\|/)
      .map(s => s.trim())
      .filter(Boolean);
    const out=[]; const seen=new Set();
    for (const x of arr){ if(!seen.has(x)){ seen.add(x); out.push(x);} }
    return out;
  }

  // Upload logo
  async function onPickLogo(ev){
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const b64 = await new Promise((res,rej)=>{
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = rej;
      fr.readAsDataURL(f);
    });
    setForm(p => ({ ...p, logoDataUrl: b64 }));
    ev.target.value = '';
  }

  // Salva TUTTO → usa SEMPRE updateAppSettings (merge + updatedAt)
  function save(ev){
    ev && ev.preventDefault();

      try{
      const den  = String(form.ragioneSociale||'').trim();
      const piva = String(form.piva||'').replace(/\s/g,'');
      const cf   = String(form.cf||form.codiceFiscale||'').trim();
      const sede = String(form.sedeLegale||'').trim();
      const reasons = [];
      if (!den)  reasons.push('Denominazione azienda mancante');
      if (!(piva || cf)) reasons.push('P.IVA o CF azienda mancanti');
      if (!sede) reasons.push('Sede legale mancante');
      if (reasons.length) {
        (window.toast||alert)(
          'Attenzione: dati azienda incompleti.\n• ' + reasons.join('\n• ') +
          '\nPuoi salvare lo stesso; l’XML SdI resterà bloccato finché non completi i dati.'
        );
      }
    }catch{}

    const operatorsArr = parseOperators(form.operatorsText);
    const fasiStd = (form.fasiStandard||[])
      .map(x => (typeof x === 'string' ? x : (x?.label || x?.code || '')).trim())
      .filter(Boolean);

    // Patch con i soli campi da aggiornare
    updateAppSettings({
      publicBaseUrl : String(form.publicBaseUrl||'').trim(),
      magUpdateCMP  : !!form.magUpdateCMP,

      // Dati azienda
      ragioneSociale  : String(form.ragioneSociale||'').trim(),
      piva            : String(form.piva||'').trim(),
      sedeLegale      : String(form.sedeLegale||'').trim(),
      sedeOperativa   : String(form.sedeOperativa||'').trim(),
      email           : String(form.email||'').trim(),
      telefono        : String(form.telefono||'').trim(),

      // ► Dati fiscali aggiuntivi
      rea             : String(form.rea||'').trim(),
      capitaleSociale : String(form.capitaleSociale||'').trim(),
      sdi             : String(form.sdi||'').trim(),
      regimeFiscale   : String(form.regimeFiscale||'RF01').trim(),

      // ► Dati bancari
      bankName        : String(form.bankName||'').trim(),
      bankHolder      : String(form.bankHolder||'').trim(),
      iban            : String(form.iban||'').trim(),
      bic             : String(form.bic||'').trim(),

      // Documenti default
      defaultIva      : Number(form.defaultIva)||0,
      defaultPagamento: form.defaultPagamento || '30 gg data fattura',

      // Operatori & Fasi
      operators       : operatorsArr,
      fasiStandard    : fasiStd,

      // Cloud
      cloudEnabled    : !!form.cloudEnabled,
      supabaseUrl     : String(form.supabaseUrl||'').trim(),
      supabaseKey     : String(form.supabaseKey||'').trim(),
      supabaseTable   : (String(form.supabaseTable||'').trim() || 'anima_sync'),

      // Logo
      logoDataUrl     : form.logoDataUrl || app0.logoDataUrl || ''
    });

    // Aggiorna progressivi documento (ULTIMO numero usato nell'anno)
    try {
      const counters = JSON.parse(localStorage.getItem('counters')||'{}') || {};
      const Y = new Date().getFullYear();
      if (Number.isFinite(+form.numC))   counters['C']   = { year: Y, num: +form.numC };
      if (Number.isFinite(+form.numDDT)) counters['DDT'] = { year: Y, num: +form.numDDT };
      if (Number.isFinite(+form.numFA))  counters['FA']  = { year: Y, num: +form.numFA };
      if (Number.isFinite(+form.numOF))  counters['OF']  = { year: Y, num: +form.numOF };
      localStorage.setItem('counters', JSON.stringify(counters));
      window.__anima_dirty = true;
    } catch {}

    // opzionale: push solo appSettings al cloud
    try { window.syncExportToCloudOnly && window.syncExportToCloudOnly(['appSettings']); } catch {}

    alert('Impostazioni salvate ✅\nSe hai appena abilitato il Cloud, ricarica (Ctrl+F5).');
  }

  // Azioni Cloud
  const sbReady = !!(form.supabaseUrl && form.supabaseKey && form.supabaseTable);
  function testConn(){
    const url = (form.supabaseUrl||'').trim();
    const key = (form.supabaseKey||'').trim();
    const table = (form.supabaseTable||'anima_sync').trim();
    if (!url || !key) return alert('Compila URL e API Key.');
    const endpoint = url.replace(/\/+$/,'') + `/rest/v1/${encodeURIComponent(table)}?select=k&limit=1`;
    fetch(endpoint, { method:'GET', headers:{ apikey:key, Authorization:'Bearer '+key } })
      .then(res => { if (!res.ok && res.status !== 406) return res.text().then(t=>{throw new Error(t||res.statusText);}); })
      .then(()=> alert('Connessione OK ✅'))
      .catch(e => alert('Connessione KO: ' + (e?.message || String(e))));
  }
  function importCloud(){
    if (!sbReady) return alert('Config Supabase mancante.');
    if (!form.cloudEnabled) return alert('Attiva “Cloud abilitato” e Salva, poi ricarica.');
    if (typeof window.syncImportFromCloud === 'function') window.syncImportFromCloud();
    else alert('Funzioni cloud non inizializzate. Salva e ricarica (Ctrl+F5).');
  }
  function exportCloud(){
    if (!sbReady) return alert('Config Supabase mancante.');
    if (!form.cloudEnabled) return alert('Attiva “Cloud abilitato” e Salva, poi ricarica.');
    if (typeof window.syncExportToCloud === 'function') window.syncExportToCloud();
    else alert('Funzioni cloud non inizializzate. Salva e ricarica (Ctrl+F5).');
  }

  const autosync = !!(window.__cloudSync__ && window.__cloudSync__.enabled);

  // UI
  return e('div', {className:'grid', style:{gap:16, maxWidth:1000}},
    
    // Dati azienda
    e('div', {className:'card'},
      e('h3', null, 'Dati azienda'),
      e('div', {className:'form'},
        e('div', null, e('label', null, 'Ragione sociale'), e('input', {name:'ragioneSociale', value:form.ragioneSociale, onChange:onChange})),
        e('div', null, e('label', null, 'P. IVA'),          e('input', {name:'piva', value:form.piva, onChange:onChange})),
        e('div', null, e('label', null, 'Sede legale'),     e('input', {name:'sedeLegale', value:form.sedeLegale, onChange:onChange})),
        e('div', null, e('label', null, 'Sede operativa'),  e('input', {name:'sedeOperativa', value:form.sedeOperativa, onChange:onChange})),
        e('div', null, e('label', null, 'Email'),           e('input', {name:'email', value:form.email, onChange:onChange})),
        e('div', null, e('label', null, 'Telefono'),        e('input', {name:'telefono', value:form.telefono, onChange:onChange}))
      )
    ),

    // ► Dati fiscali aggiuntivi
    e('div', {className:'card'},
      e('h3', null, 'Dati fiscali aggiuntivi'),
      e('div', {className:'form'},
        e('div', null, e('label', null, 'REA'),               e('input', {name:'rea', value:form.rea, onChange:onChange})),
        e('div', null, e('label', null, 'Capitale sociale'),  e('input', {name:'capitaleSociale', value:form.capitaleSociale, onChange:onChange, placeholder:'es. € 10.000 i.v.'})),
        e('div', null, e('label', null, 'Codice SDI'),        e('input', {name:'sdi', value:form.sdi, onChange:onChange})),
        e('div', null,
          e('label', null, 'Regime fiscale (RFxx)'),
          e('select', {name:'regimeFiscale', value:form.regimeFiscale||'RF01', onChange:onChange},
            e('option',{value:'RF01'},'RF01 — Ordinario'),
            e('option',{value:'RF19'},'RF19 — Forfettario'),
            e('option',{value:'RF02'},'RF02 — Contribuenti minimi'),
            e('option',{value:'RF04'},'RF04 — Agricoltura e pesca'),
            e('option',{value:'RF18'},'RF18 — Altro regime speciale')
          )
        ),
      )
    ),

    // Logo per stampe
    e('div', {className:'card'},
      e('h3', null, 'Logo per stampe'),
      e('div', {className:'row', style:{gap:8, alignItems:'center'}},
        e('input', {type:'file', accept:'image/*', onChange:onPickLogo}),
        form.logoDataUrl
          ? e('img', {src:form.logoDataUrl, alt:'logo', style:{height:40, border:'1px solid #ddd', padding:4}})
          : e('div', {className:'muted'}, 'Nessun logo caricato')
      )
    ),

    // Operatori
    e('div', {className:'card'},
      e('h3', null, 'Operatori (uno per riga)'),
      e('textarea', {name:'operatorsText', value:form.operatorsText, onChange:onChange, rows:6})
    ),

    // Fasi standard
    e('div', {className:'card'},
      e('h3', null, 'Fasi standard (tendina nelle commesse)'),
      e('div', null,
        (form.fasiStandard||[]).map((v,i)=> e('div',{key:i, className:'row', style:{gap:6, marginBottom:6}},
          e('input', {value:v, onChange:ev=>{
            const val = ev.target.value;
            setForm(p=>({ ...p, fasiStandard: p.fasiStandard.map((x,ix)=> ix===i ? val : x) }));
          }}),
          e('button', {type:'button', className:'btn btn-outline', onClick:()=> setForm(p=>({...p, fasiStandard: p.fasiStandard.filter((_,ix)=>ix!==i)}))}, '🗑')
        )),
        e('button', {type:'button', className:'btn', onClick:()=> setForm(p=>({...p, fasiStandard:[...(p.fasiStandard||[]), '']}))}, '➕ Aggiungi fase')
      )
    ),

    // ► Dati bancari (per stampa di cortesia)
    e('div', {className:'card'},
      e('h3', null, 'Dati bancari (stampa fattura di cortesia)'),
      e('div', {className:'form'},
        e('div', null, e('label', null, 'Banca'),            e('input', {name:'bankName', value:form.bankName, onChange:onChange, placeholder:'es. Intesa Sanpaolo'})),
        e('div', null, e('label', null, 'Intestatario conto'),e('input', {name:'bankHolder', value:form.bankHolder, onChange:onChange, placeholder:'es. ANIMA S.r.l.'})),
        e('div', null, e('label', null, 'IBAN'),             e('input', {name:'iban', value:form.iban, onChange:onChange})),
        e('div', null, e('label', null, 'BIC/SWIFT'),        e('input', {name:'bic', value:form.bic, onChange:onChange}))
      )
    ),

    // Numerazione documenti (anno corrente)
    e('div', {className:'card'},
      e('h3', null, `Numerazione documenti (${new Date().getFullYear()})`),
      e('div', {className:'row', style:{gap:12, alignItems:'center', flexWrap:'wrap'}},
        e('label', null, 'Commesse (C):',
          e('input', {
            type:'number',
            value: form.numC || '',
            onChange: ev=> setForm(p=>({...p, numC: Number(ev.target.value)||0 }))
          })
        ),
        e('label', null, 'DDT (DDT):',
          e('input', {
            type:'number',
            value: form.numDDT || '',
            onChange: ev=> setForm(p=>({...p, numDDT: Number(ev.target.value)||0 }))
          })
        ),
        e('label', null, 'Fatture (FA):',
          e('input', {
            type:'number',
            value: form.numFA || '',
            onChange: ev=> setForm(p=>({...p, numFA: Number(ev.target.value)||0 }))
          })
        ),
        e('label', null, 'Ordini Fornitori (OF):',
          e('input', {
            type:'number',
            value: form.numOF || '',
            onChange: ev=> setForm(p=>({...p, numOF: Number(ev.target.value)||0 }))
          })
        ),
        e('div', {className:'muted'}, 'Inserisci l’ULTIMO numero emesso nel ', new Date().getFullYear(), '. Dal prossimo documento proseguirà +1. Nel 2026 riparte da 1 automaticamente.')
      )
    ),

    // Magazzino
    e('div', {className:'card'},
      e('h3', null, 'Magazzino'),
      e('div', {className:'row', style:{gap:12, alignItems:'center'}},
        e('label', null,
          e('input', { type:'checkbox', name:'magUpdateCMP', checked:!!form.magUpdateCMP, onChange:onChange }),
          ' Aggiorna automaticamente il CMP ai carichi da Ordini Fornitori'
        ),
        e('div', {className:'muted'}, 'Suggerito: OFF. Si può spuntare caso per caso nella ricezione.')
      )
    ),

    // Cloud (Supabase)
    e('div', {className:'card'},
      e('h3', null, 'Cloud (Supabase)'),
      e('div', {className:'row', style:{gap:12, alignItems:'center', flexWrap:'wrap'}},
        e('label', null,
          e('input', {type:'checkbox', name:'cloudEnabled', checked:!!form.cloudEnabled, onChange:onChange}),
          ' Cloud abilitato'
        ),
        e('label', { style:{minWidth:360} }, 'URL:',
          e('input', {name:'supabaseUrl', value:form.supabaseUrl, onChange:onChange, placeholder:'https://xxxx.supabase.co'})
        ),
        e('label', { style:{minWidth:360} }, 'API Key:',
          e('input', {type:'password', name:'supabaseKey', value:form.supabaseKey, onChange:onChange, placeholder:'eyJ...'})
        ),
        e('label', null, 'Tabella:',
          e('input', {name:'supabaseTable', value:form.supabaseTable, onChange:onChange, placeholder:'anima_sync'})
        )
      ),
      e('div', {className:'row', style:{gap:8, marginTop:10, flexWrap:'wrap'}},
        e('button', {type:'button', className:'btn', onClick:testConn}, '🔌 Test connessione'),
        e('button', {type:'button', className:'btn', onClick:importCloud}, '⬇️ Importa ora'),
        e('button', {type:'button', className:'btn', onClick:exportCloud}, '⬆️ Esporta ora')
      ),
      e('div', {className:'muted', style:{marginTop:6}},
        `Stato: ${form.cloudEnabled ? 'Abilitato' : 'Disabilitato'} · Auto-sync: ${!!(window.__cloudSync__ && window.__cloudSync__.enabled) ? 'attivo' : 'spento'}`
      )
    ),

    // URL pubblico per QR
    e('div', {className:'card'},
      e('h3', null, 'URL pubblico per QR (opzionale)'),
      e('div', {className:'form'},
        e('div', null, e('label', null, 'Base URL'),
          e('input', {
            name:'publicBaseUrl',
            value: form.publicBaseUrl,
            onChange: onChange,
            placeholder: 'es. http://192.168.1.50:5500/App oppure https://miazienda.it/anima'
          })
        )
      ),
      e('div', {className:'muted', style:{marginTop:6}},
        'Se impostato, i QR useranno questo host. Utile da smartphone (LAN o dominio pubblico).'
      )
    ),

    // Backup & Ripristino
    e('div', {className:'card'},
      e('h3', null, 'Backup dati'),
      e('div', {className:'row', style:{gap:8, flexWrap:'wrap', alignItems:'center'}},
        e('button', {
          type:'button',
          className:'btn',
          onClick:()=> (window.downloadBackup ? window.downloadBackup() : alert('Funzione downloadBackup non trovata'))
        }, '💾 Scarica backup'),

        // Ripristino da file .json
        e('label', {className:'btn btn-outline', htmlFor:'restore-file'}, '⤴️ Ripristina da file…'),
        e('input', {
          id:'restore-file',
          type:'file',
          accept:'application/json',
          style:{display:'none'},
          onChange: async (ev)=>{
            const f = ev.target.files && ev.target.files[0];
            ev.target.value = '';
            if (!f) return;
            if (!window.restoreFromFile) { alert('Funzione restoreFromFile non trovata'); return; }
            try { await window.restoreFromFile(f); } catch(e){ alert('Ripristino fallito: '+(e?.message||e)); }
          }
        })
      ),
      e('div', {className:'muted', style:{marginTop:6}},
        'Salva un file .json con tutti i tuoi dati. Il ripristino sovrascrive le chiavi presenti e ricarica l’app.'
      )
    ),

    // Salva TUTTO
    e('div', {className:'actions'},
      e('button', {className:'btn btn-primary', onClick:save}, '💾 Salva impostazioni')
    )
  );
}
window.ImpostazioniView = ImpostazioniView;


// utilità globali
window.get = window.get || function (k, d) {
  try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : d; }
  catch { return d; }
};

/* ================== DDT (lista, CRUD, stampa, fattura da DDT) ================== */
// === Prefill DDT da Commessa (idempotente) ===
window.buildDDTFromCommessa = window.buildDDTFromCommessa || function buildDDTFromCommessa(c){
  if (!c) return null;

  const righe = Array.isArray(c.righeArticolo) ? c.righeArticolo
             : (Array.isArray(c.righe) ? c.righe : []);

  const rows = (righe.length > 0)
    ? righe.map(r => ({
        codice: String(r.codice || r.articoloCodice || ''),
        descrizione: String(r.descrizione || ''),
        um: String(r.um || 'PZ'),
        qta: Math.max(0, Number(r.qta || r.quantita || 0))
      }))
    : [{
        codice: String(c.articoloCodice || ''),
        descrizione: String(c.descrizione || ''),
        um: String(c.um || 'PZ'),
        qta: Math.max(1, Number(c.qtaPezzi || 1))
      }];

  return {
    clienteRagione: String(c.cliente || ''),
    clienteId: c.clienteId || '',
    commessaId: String(c.id || ''),
    note: (c.descrizione || ''),
    articoli: rows
  };
};

  // === Normalizzatore DDT (idempotente) ===
// Accetta sia {cliente} che {clienteRagione}, sia {articoli} che {righe}, ecc.
window.normalizeDDTRecord = window.normalizeDDTRecord || function normalizeDDTRecord(src){
  const S = src || {};
  // data in formato ISO (fallback oggi)
  const todayISO = () => new Date().toISOString().slice(0,10);

  const clienteRagione = String(S.clienteRagione || S.cliente || '').trim();
  const clienteId      = S.clienteId || '';
  const commessaRif    = String(S.commessaRif || S.commessaId || S.__fromCommessaId || '').trim();
  const note           = String(S.note || S.annotazioni || '').trim();
  const data           = (S.data && String(S.data)) || todayISO();

  const rowsSrc = Array.isArray(S.articoli) ? S.articoli
                 : (Array.isArray(S.righe) ? S.righe : []);
  const rows = (rowsSrc || []).map(r => ({
    codice: String(r.codice || r.articoloCodice || '').trim(),
    descrizione: String(r.descrizione || '').trim(),
    um: String(r.um || 'PZ').trim(),
    qta: Math.max(0, Number(r.qta || r.quantita || 0))
  })).filter(r => r.codice || r.descrizione || r.qta>0);

  return {
    id: String(S.id || '').trim(),
    data,
    clienteRagione,
    clienteId,
    commessaRif,
    note,
    articoli: rows
  };
};


function DDTView(){
  const e = React.createElement;
  
  // Prefill da hash ?from=C-… (esegue una sola volta al mount)
  React.useEffect(() => {
    // fallback locale se getHashParam non c'è
    const getHashParamLocal = (name) => {
      try {
        const q = (location.hash.split('?')[1] || '');
        return new URLSearchParams(q).get(name) || '';
      } catch { return ''; }
    };

    const from = (typeof window.getHashParam === 'function'
                    ? window.getHashParam('from')
                    : getHashParamLocal('from'));

    if (!from) return;

    // leggi la commessa
    let comm = null;
    try {
      const all = JSON.parse(localStorage.getItem('commesseRows') || '[]') || [];
      comm = all.find(x => String(x.id) === String(from)) || null;
    } catch {}
    if (!comm) return;

    // costruisci il prefill
    const pre = (typeof window.buildDDTFromCommessa === 'function'
                  ? window.buildDDTFromCommessa(comm)
                  : null);
    if (!pre) return;

    // individua lo state setter disponibile (form/draft)
    const setter =
      (typeof setForm  === 'function' && setForm) ||
      (typeof setDraft === 'function' && setDraft) ||
      null;

    if (!setter) return; // non abbiamo un setter disponibile

    // aggiorna lo stato SENZA sovrascrivere campi già valorizzati
    setter(prev => {
      const next = { ...(prev || {}) };

      // righe articoli (nome campo più usato: "articoli"; se il tuo stato usa "righe", scrivo anche lì)
      if (!Array.isArray(next.articoli) || next.articoli.length === 0) next.articoli = pre.articoli;
      if (('righe' in (prev || {})) && (!Array.isArray(next.righe) || next.righe.length === 0)) next.righe = pre.articoli;

      // intestazione
      if (!next.clienteRagione) next.clienteRagione = pre.clienteRagione;
      if (!next.note)           next.note           = pre.note;

      // metadata link alla commessa
      if (!next.commessaId) next.commessaId = pre.commessaId;
    next.__fromCommessaId = pre.commessaId;

      return next;
    });
  }, []);

  // piccolo helper debug: stampa lo stato corrente (form o draft) in console
  window.__DEBUG_DDT = function(){
    try {
      // "typeof x !== 'undefined'" evita errori se la variabile non esiste
      const state = (typeof form  !== 'undefined' ? form
                  : typeof draft !== 'undefined' ? draft
                  : null);
      console.log('DDT state:', state);
    } catch(e) { console.warn(e); }
  };

  const user = window.__currentUser || null;
  const readOnly = !!(user && user.role === 'accountant');


  // --- helpers ---
  const todayISO = () => new Date().toISOString().slice(0,10);
  const pad3 = n => String(n).padStart(3,'0');
  // Helpers compat per mantenere righe su tutte le chiavi
    const __getRighe = (f) =>
      Array.isArray(f?.righe)         ? f.righe
    : Array.isArray(f?.righeDDT)      ? f.righeDDT
    : Array.isArray(f?.righeArticolo) ? f.righeArticolo
    : [];
  const __setRighe = (updater) => setForm(prev => {
    const rows = updater(__getRighe(prev));
    const next = { ...prev, righe: rows, righeDDT: rows, righeArticolo: rows };
    return next;
  });
  // Prefill da hash ?from=C-… (una sola volta)
React.useEffect(() => {
  try{
    const from = (window.getHashParam && window.getHashParam('from')) || '';
    if (!from) return;
    const all = JSON.parse(localStorage.getItem('commesseRows')||'[]') || [];
    const c = all.find(x => String(x.id) === String(from));
    if (!c) return;
    const pre = window.buildDDTFromCommessa(c);
    if (!pre) return;

    // prova a settare su 'form' o 'draft' a seconda di come si chiama lo stato
    if (typeof setForm === 'function') {
      setForm(prev => {
        const next = {...(prev||{})};
        if (!next.articoli || !Array.isArray(next.articoli) || !next.articoli.length) next.articoli = pre.articoli;
        if (!next.clienteRagione) next.clienteRagione = pre.clienteRagione;
        if (!next.note) next.note = pre.note;
        next.__fromCommessaId = pre.commessaId;
        return next;
      });
    } else if (typeof setDraft === 'function') {
      setDraft(prev => {
        const next = {...(prev||{})};
        if (!next.articoli || !Array.isArray(next.articoli) || !next.articoli.length) next.articoli = pre.articoli;
        if (!next.clienteRagione) next.clienteRagione = pre.clienteRagione;
        if (!next.note) next.note = pre.note;
        next.__fromCommessaId = pre.commessaId;
        return next;
      });
    }

  }catch(e){ console.warn('DDT prefill error', e); }
}, []); // solo al mount

  // dataset di base
  const app      = React.useMemo(() => lsGet('appSettings', {}) || {}, []);
  const clienti  = React.useMemo(() => lsGet('clientiRows', [])  || [], []);
  const articoli = React.useMemo(() => lsGet('magArticoli', [])  || [], []);

  function findArt(cod){
    const s = String(cod||'').trim();
    return (Array.isArray(articoli)?articoli:[]).find(a => String(a.codice||'').trim() === s);
  }

  // modello vuoto
  const blank = {
    id: '', data: todayISO(),
    clienteId: '', cliente: '',
    commessaRif: '', note: '',
    rifCliente: '',             // n° ordine/DDT cliente (solo a video)
    causaleTrasporto: '',
    luogoConsegna: '',
    vettore: '', firmaVettore: '', firmaDestinatario: '', firmaConducente: '',
    dataOra: '', pesoNetto: '', pesoLordo: '', colli: '', aspetto: '',
    righe: [] // {codice, descrizione, qta, UM, note}
  };

  // Prefill da URL ?from=C-YYYY-NNN
  let __prefilled = null;
  try{
    const fromId = (window.getHashParam ? window.getHashParam('from') : '') || '';
    if (fromId) {
      const commesse = (function(){ try{ return JSON.parse(localStorage.getItem('commesseRows')||'[]'); }catch{return [];} })();
      const c = commesse.find(x => String(x.id) === String(fromId));
      if (c) {
        const lines = window.prefillDDTFromCommessa(c);
        __prefilled = {
          cliente: c.cliente || '',
          commessaId: c.id,
          ...lines
        };
      }
    }
  } catch {}

  // Prefill da URL ?from=C-YYYY-NNN
  let prefilled = null;
  try{
    const fromId = (window.getHashParam ? window.getHashParam('from') : '') || '';
    if (fromId) {
      const commesse = (function(){ try{ return JSON.parse(localStorage.getItem('commesseRows')||'[]'); }catch{return [];} })();
      const c = commesse.find(x => String(x.id) === String(fromId));
      if (c) {
        const lines = window.prefillDDTFromCommessa(c);
        prefilled = {
          cliente: c.cliente || '',
          commessaId: c.id,
          ...lines
        };
      }
    } 
  } catch {}

  // stato principale
  // stato DDT
  const [rowsDDT, setRowsDDT] = React.useState(()=> lsGet('ddtRows', []));

  // hydrate da server
  React.useEffect(()=>{
    (async ()=>{
      try{
        const s = await window.api.kv.get('ddtRows');
        if (Array.isArray(s)) {
          setRowsDDT(s);
          lsSet('ddtRows', s);
        }
      }catch(e){}
   })();
  },[]);

  // mirror ad ogni modifica
  React.useEffect(()=>{
    lsSet('ddtRows', rowsDDT);
    window.mirrorToServer('ddtRows', rowsDDT);
  },[rowsDDT]);


  const [qDDT, setQDDT]           = React.useState('');
  const [form, setForm]           = React.useState(__prefilled ? { ...blank, ...__prefilled } : blank);
  const [editingId, setEditingId] = React.useState(null);
  const [showForm, setShowForm]   = React.useState(false);

  // ====== Bulk "Genera fattura…" da più DDT ======
  const [bulkFaOpen, setBulkFaOpen] = React.useState(false);
  const [bulkCliId, setBulkCliId]   = React.useState('');
  const [bulkPick, setBulkPick]     = React.useState({}); // { [ddtId]: true }

  function openBulkFa(){
    setBulkFaOpen(true);
    setBulkCliId('');
    setBulkPick({});
  }
  function togglePick(id){
    setBulkPick(p => ({ ...p, [id]: !p[id] }));
  }

  const ddtForCli = React.useMemo(()=>{
    if (!bulkCliId) return [];
    return (rowsDDT||[])
      .filter(r => String(r.clienteId||'') === String(bulkCliId) && !r.__fatturato)
      .sort((a,b)=>{
        const ma = String(a.id||'').match(/^DDT-(\d{4})-(\d{3})$/);
        const mb = String(b.id||'').match(/^DDT-(\d{4})-(\d{3})$/);
        if (ma && mb){
          if (+mb[1] !== +ma[1]) return +mb[1] - +ma[1];
          if (+mb[2] !== +ma[2]) return +mb[2] - +ma[2];
        }
        return String(b.id||'').localeCompare(String(a.id||''));
      });
  }, [rowsDDT, bulkCliId]);

  function confirmBulkFa(){
    const selIds = Object.keys(bulkPick).filter(id => bulkPick[id]);
    if (!selIds.length){ alert('Seleziona almeno un DDT'); return; }

    const sel = (rowsDDT||[]).filter(d => selIds.includes(d.id));
    const clientiSet = new Set(sel.map(d => String(d.clienteId||'')));
    if (clientiSet.size > 1){ alert('Seleziona DDT dello stesso cliente'); return; }

    const ddt0 = sel[0];

    // righe flatten con riferimento DDT (ddtId / ddtData) in ogni riga
    const righe = list.map(c => {
    const ra = Array.isArray(c.righeArticolo) ? c.righeArticolo
          : (Array.isArray(c.righe) ? c.righe : []);
      const firstRiga = ra[0] || null;
      const code = c.articoloCodice || (firstRiga && (firstRiga.codice || firstRiga.articoloCodice)) || '';
      const art  = articoli.find(a => String(a.codice||'').trim() === String(code||'').trim()) || null;
      const UM   = (art && art.um) || c.articoloUM || (firstRiga && firstRiga.um) || 'PZ';
      const descr= (art && art.descrizione) || c.descrizione || (firstRiga && firstRiga.descrizione) || '';
      const qtaDefault = (+c.qtaProdotta>0 ? +c.qtaProdotta : (+c.qtaPezzi || (firstRiga && +firstRiga.qta) || 1));
      return { codice: code, descrizione: descr, UM, qta: qtaDefault, note: c.noteSpedizione || '' };
    });

    const cliDet = (clienti||[]).find(c => String(c.id)===String(ddt0.clienteId)) || null;
    const pf = {
      data: todayISO(),
      clienteId: ddt0.clienteId || '',
      cliente: ddt0.cliente || '',
      pagamento: app.defaultPagamento || '30 gg data fattura',
      esigibilitaIVA: '', // 'I' (immediata), 'D' (differita), 'S' (scissione)
      iban: app.iban || '',
      plafond: !!(cliDet && cliDet.plafond),
      naturaIva: (cliDet && cliDet.naturaIva) || '',
      causale: '',
      note: '',
      righe,
      __fromDDTs: sel.map(d => d.id)
    };

    try { localStorage.setItem('prefillFattura', JSON.stringify(pf)); } catch {}
    setBulkFaOpen(false);
    if (window.setTab) window.setTab('Fatture');
    location.hash = '#/fatture';
  }

  // prefill da altre viste (forza UM maiuscolo se arriva "um")
  React.useEffect(()=>{
    try{
      const raw = localStorage.getItem('prefillDDT');
      if (!raw) return;
      localStorage.removeItem('prefillDDT');
      const pf = JSON.parse(raw);

      const righe = Array.isArray(pf?.righe) ? pf.righe.map(r => ({
        ...r,
        UM: r.UM || r.um || 'PZ'
      })) : [];

      setForm({ ...blank, ...(pf||{}), righe });
      setEditingId(null);
      setShowForm(true);
    }catch{}
  },[]);


  // --- handlers form ---
  function onChange(ev){
    const {name, value} = ev.target;
    setForm(p => ({ ...p, [name]: value }));
  }
  function onSelCliente(id){
    const c = (Array.isArray(clienti)?clienti:[]).find(x => String(x.id)===String(id)) || null;
    setForm(p => ({
      ...p,
      clienteId: id,
      cliente: c ? (c.ragione || c.ragioneSociale || '') : '',
      luogoConsegna: c ? (c.sedeOperativa || p.luogoConsegna || '') : (p.luogoConsegna || '')
    }));
  }

  // righe
  function addRiga(){
    setForm(p => ({ ...p, righe: [ ...(p.righe||[]), { codice:'', descrizione:'', qta:'', UM:'PZ', note:'' } ] }));
  }
  function updRiga(i, patch){
    setForm(p => ({
      ...p,
      righe: (p.righe||[]).map((r,ix)=> ix===i ? { ...r, ...patch } : r)
    }));
  }
  function remRiga(i){
    setForm(p => ({ ...p, righe: (p.righe||[]).filter((_,ix)=> ix!==i) }));
  }

 // CRUD
async function openNew(){
  // ID robusto: DDT-YYYY-NNN (Impostazioni + counters + LS + server)
  const idObj = (typeof window.nextIdFor === 'function')
        ? await window.nextIdFor({ prefix:'DDT', storageKey:'ddtRows', seriesKey:'DDT', width:3 })
    : (function(){
        const y = new Date().getFullYear();
        const pad = n => String(n).padStart(3,'0');
        let all = [];
        try { all = JSON.parse(localStorage.getItem('ddtRows')||'[]')||[]; } catch {}
        const n = 1 + all.filter(r => String(r.id||'').startsWith(`DDT-${y}-`)).length;
        return { id:`DDT-${y}-${pad(n)}`, year:y, num:n };
      })();

  const today = new Date().toISOString().slice(0,10);
  const now   = new Date().toISOString();
  setForm({ ...blank, id:idObj.id, data: today, __createdAt: now, updatedAt: now, righe: [] });
  setEditingId(null);
  setShowForm(true);
}

function openEdit(id){
  const x = (rowsDDT || []).find(r => String(r.id) === String(id));
  if (!x) return;

  const righe = Array.isArray(x.righe) ? x.righe : [];

  setForm({
    ...blank,
    ...x,
    righe
  });

  setEditingId(id);
  setShowForm(true);
}

function delRec(id){
  if (!confirm('Eliminare DDT?')) return;
  setRowsDDT(prev => prev.filter(r => r.id !== id));
}

  // --- SALVA (DDT) --- SOSTITUISCI INTERAMENTE QUESTA FUNZIONE ---
  async function save(ev){
    ev && ev.preventDefault();

    // 1) Assicura un ID DDT valido (DDT-YYYY-NNN)
    let curId = String(form.id || '').trim();
    const badId =
      !curId ||                                 // vuoto
      curId.toUpperCase().includes('NAN') ||    // conteneva NaN
      !curId.startsWith('DDT-');                // non inizia con DDT-

    if (badId) {
      let newId = null;

      // 1.a) Prova a usare il generatore unificato legato ai contatori (Impostazioni → DDT)
      if (typeof window.nextIdFor === 'function') {
        try {
          const obj = await window.nextIdFor({
            prefix:     'DDT',
            storageKey: 'ddtRows',
            seriesKey:  'DDT',   // stessa chiave che usi in "Numerazione documenti (DDT)"
            width:      3
          });
          if (obj && obj.id) newId = obj.id;
        } catch {}
      }

      // 1.b) Fallback locale se nextIdFor non esiste o fallisce
      if (!newId) {
        const y   = new Date().getFullYear();
        const pad = n => String(n).padStart(3,'0');
        let all   = [];
        try { all = JSON.parse(localStorage.getItem('ddtRows') || '[]') || []; } catch {}
        const n = 1 + (all.filter(r => String(r.id||'').startsWith(`DDT-${y}-`)).length || 0);
        newId = `DDT-${y}-${pad(n)}`;
      }

      curId = newId;
    }

    // 2) Validazioni base
    if (!form.clienteId && !form.cliente){
      alert('Seleziona un cliente'); 
      return;
    }

    const righeValide = (form.righe||[]).filter(r => {
      const hasText = String(r.codice||'').trim() || String(r.descrizione||'').trim();
      const qty = Number(r.qta||0);
      return !!hasText && Number.isFinite(qty) && qty>0;
    });
    if (!righeValide.length){
      alert('Aggiungi almeno una riga valida (codice/descrizione e quantità > 0)');
      return;
    }

    const rec = {
      ...form,
      id: curId,
      righe: righeValide,
      colli: form.colli || righeValide.length,
      updatedAt: new Date().toISOString()
    };

    // 3) Scrivi in LS (write-through)
    let all = [];
    try { all = JSON.parse(localStorage.getItem('ddtRows')||'[]')||[]; } catch {}
    const ix = all.findIndex(r => String(r.id) === String(rec.id));
    if (ix>=0) all[ix]=rec; else all.push(rec);
    try { localStorage.setItem('ddtRows', JSON.stringify(all)); } catch {}

    // 4) Aggiorna UI
    setRowsDDT(all);
    setShowForm(false);
    setEditingId(rec.id);

    // 5) Sync cloud (non crashare se offline)
    try {
      if (window.syncExportToCloudOnly) window.syncExportToCloudOnly(['ddtRows']);
      if (window.persistKV) await window.persistKV('ddtRows', all);
      if (window.api?.kv?.set) await window.api.kv.set('ddtRows', all);
    } catch {}

    alert('DDT salvato ✅');
  }

  // fattura singola da DDT
  function faiFatturaDaDDT (ddt) {
    const cli        = clienti.find(c => c.id === (ddt.clienteId || '')) || null;
    const defaultIva = Number(app.defaultIva) || 22;
    const isPlafond  = !!(cli && cli.plafond);

    const pf = {
      data: todayISO(),
      clienteId: ddt.clienteId || '',
      cliente: ddt.cliente || '',
      pagamento: app.defaultPagamento || '30 gg data fattura',
      iban: app.iban || '',
      codiceUnivoco: (cli && cli.codiceUnivoco) || '',
      pec: (cli && cli.pec) || '',
      note: (ddt.note || ''), // niente "Rif. DDT..." nelle note
      righe: (ddt.righe||[]).map(r => ({
        descrizione: r.descrizione||'',
        qta: r.qta||'',
        UM: r.UM||'PZ',
        prezzo: '',
        sconto: '',
        iva: isPlafond ? 0 : (Number(app.defaultIva)||22),
        ddtId: ddt.id || '',
        ddtData: ddt.data || ''
      })),
      plafond: isPlafond,
      naturaIva: (cli && cli.naturaIva) || (isPlafond ? 'N3.5 Plafond' : '')
    };

    try { localStorage.setItem('prefillFattura', JSON.stringify(pf)); } catch {}
    if (window.setTab) window.setTab('Fatture');
    else location.hash = '#/fatture';
  }

  // ricerca + ordinamento
  const filteredDDT = React.useMemo(()=>{
    const s = String(qDDT||'').toLowerCase();
    return (Array.isArray(rowsDDT)?rowsDDT:[])
      .filter(r =>
        (String(r.id||'')+' '+String(r.cliente||'')+' '+String(r.note||'')+' '+String(r.commessaRif||'')+' '+String(r.rifCliente||''))
        .toLowerCase().includes(s)
      )
      .sort((a,b)=>{
        const ma = String(a.id||'').match(/^DDT-(\d{4})-(\d{3})$/);
        const mb = String(b.id||'').match(/^DDT-(\d{4})-(\d{3})$/);
        if (ma && mb){
          if (+mb[1] !== +ma[1]) return +mb[1] - +ma[1];
          if (+mb[2] !== +ma[2]) return +mb[2] - +ma[2];
        }
        const ta = (Date.parse(b.updatedAt||b.__CreatedAt||b.__createdAt||0) - Date.parse(a.updatedAt||a.__CreatedAt||a.__createdAt||0));
        if (ta !== 0 && isFinite(ta)) return ta;
        return String(b.id||'').localeCompare(String(a.id||''));
      });
  },[rowsDDT,qDDT]);

  // ===== Modale multi-fattura (definito PRIMA del return) =====
  const modalMultiFa = bulkFaOpen ? e('div', {
    style:{
      position:'fixed', inset:0, background:'rgba(0,0,0,.35)',
      display:'flex', alignItems:'center', justifyContent:'center',
      zIndex: 9999
    },
    onClick: (ev)=>{ if (ev.target === ev.currentTarget) setBulkFaOpen(false); }
  },
    e('div', {
      className:'card',
      style:{ width:760, maxWidth:'95vw', maxHeight:'90vh', overflow:'auto' },
      onClick:(ev)=>ev.stopPropagation()
    },
      e('h3', null, 'Genera fattura da DDT'),

      // Selettore cliente
      e('div', { className:'form', style:{gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))'} },
        e('div', null,
          e('label', null, 'Cliente'),
          (clienti && clienti.length)
            ? e('select', {
                value: bulkCliId || '',
                onChange: ev => { setBulkCliId(ev.target.value); setBulkPick({}); }
              },
                e('option', {value:''}, '— seleziona —'),
                ...(clienti).map(c =>
                  e('option', { key:c.id, value:c.id },
                    String(c.ragione || c.ragioneSociale || c.denominazione || c.nome || c.id)
                  )
                )
              )
            : e('a', { className:'btn btn-outline', href:'#/clienti' }, 'Crea cliente…')
        )
      ),

      // Elenco DDT del cliente selezionato
      (bulkCliId
        ? e('div', { className:'card', style:{ marginTop:8, overflowX:'auto' } },
            e('table', { className:'table' },
              e('thead', null,
                e('tr', null,
                  e('th', {style:{width:32}}, ''),
                  e('th', {style:{width:140}}, 'DDT'),
                  e('th', null, 'Data'),
                  e('th', null, 'Note'),
                  e('th', {style:{width:80}}, 'Righe')
                )
              ),
              e('tbody', null,
                ddtForCli.map(r => e('tr', { key:r.id },
                  e('td', { className:'ctr' },
                    e('input', {
                      type:'checkbox',
                      checked: !!bulkPick[r.id],
                      onChange: () => togglePick(r.id)
                    })
                  ),
                  e('td', null, r.id),
                  e('td', null, r.data || ''),
                  e('td', null, r.note || ''),
                  e('td', { className:'ctr' }, String((r.righe||[]).length))
                ))
              )
            )
          )
        : e('div', { className:'muted', style:{marginTop:8} },
            'Seleziona un cliente per vedere i DDT disponibili.'
          )
      ),

      // Azioni
      e('div', { className:'actions', style:{ justifyContent:'flex-end', marginTop:10 } },
        e('button', { className:'btn btn-outline', onClick: ()=> setBulkFaOpen(false) }, 'Annulla'),
        e('button', { className:'btn', onClick: confirmBulkFa }, 'Conferma')
      )
    )
  ) : null;

  // --- render ---
  return e('div', { className:'page' },

    // toolbar
    e('div', { className:'actions', style:{marginBottom:8} },
      e('input', { className:'input', placeholder:'Cerca…', value:qDDT, onChange:ev=>setQDDT(ev.target.value) }),
      e('button', { className:'btn', onClick:openNew, ...window.roProps() }, '➕ Nuovo DDT'),
      e('button', { className:'btn btn-outline', onClick: openBulkFa }, '🧾 Genera fattura…')
    ),

    // lista
    e('div', { className:'card', style:{overflowX:'auto'} },
      e('table', { className:'table' },
        e('thead', null,
          e('tr', null,
            e('th', {style:{width:130}}, 'DDT'),
            e('th', null, 'Data'),
            e('th', null, 'Cliente'),
            e('th', null, 'Note'),
            e('th', {style:{width:260}}, 'Azioni')
          )
        ),
        e('tbody', null,
          filteredDDT.map(r => e('tr', { key:r.id },
            e('td', null, r.id),
            e('td', null, r.data || ''),
            e('td', null, r.cliente || ''),
            e('td', null, r.note || ''),
            e('td', null,
  e('button', { className:'btn btn-outline', onClick:()=>openEdit(r.id), disabled: readOnly, title: readOnly ? 'Sola lettura' : '' }, '✏️ Modifica'), ' ',
  e('button', { className:'btn btn-outline', onClick: () => window.printDDT && window.printDDT(r) }, 'Stampa'), ' ',
  e('button', { className:'btn btn-outline', onClick:()=>faiFatturaDaDDT(r), disabled: readOnly, title: readOnly ? 'Sola lettura' : '' }, '→ Fattura'), ' ',
  e('button', { className:'btn btn-outline', onClick:()=>delRec(r.id), ...window.roProps('Solo admin può eliminare') }, '🗑')
            )
          ))
        )
      )
    ),

    // form (con sola-lettura)
showForm && e('form', { className:'card', onSubmit:save, style:{marginTop:8,padding:12} },
  e('h3', null, editingId ? `Modifica ${form.id}` : 'Nuovo DDT'),

  // TUTTI I CAMPI BLOCCATI IN SOLA LETTURA
  e('fieldset', { disabled: readOnly },

        // metadati
    e('div', {
      className:'form',
      style:{
        gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',
        gap:12
      }
    },
      // titolo sezione
      e('div',{className:'form-group-title', style:{gridColumn:'1 / -1'}}, 'Dati DDT'),

      e('div', null,
        e('label', null, 'Data'),
        e('input', {
          type:'date',
          name:'data',
          value:form.data,
          onChange:onChange
        })
      ),
      e('div', null,
        e('label', null, 'Cliente'),
        (clienti && clienti.length)
          ? e('select', {
              value:form.clienteId,
              onChange:ev=>onSelCliente(ev.target.value)
            },
              e('option', {value:''}, '— seleziona —'),
              ...(clienti||[]).map(c =>
                e('option', { key:c.id, value:c.id },
                  String(c.ragione||c.ragioneSociale||'')
                )
              )
            )
          : e('a', { className:'btn btn-outline', href:'#/clienti' }, 'Crea cliente…')
      ),

      // seconda sezione
      e('div',{className:'form-group-title', style:{gridColumn:'1 / -1', marginTop:4}}, 'Trasporto e riferimenti'),

      e('div', { style:{gridColumn:'1/-1'} },
        e('label', null, 'Luogo di consegna'),
        e('input', {
          name:'luogoConsegna',
          value:form.luogoConsegna,
          onChange:onChange
        })
      ),
      e('div', { style:{gridColumn:'1/-1'} },
        e('label', null, 'Causale del trasporto (facoltativa)'),
        e('input', {
          name:'causaleTrasporto',
          value:form.causaleTrasporto,
          onChange:onChange
        })
      ),
      e('div', null,
        e('label', null, 'Commessa (rif.)'),
        e('input', {
          name:'commessaRif',
          value:form.commessaRif,
          onChange:onChange
        })
      ),
      e('div', null,
        e('label', null, 'Rif. cliente (ordine/DDT)'),
        e('input', {
          name:'rifCliente',
          value:form.rifCliente,
          onChange:onChange
        })
      ),
      e('div', { style:{gridColumn:'1/-1'} },
        e('label', null, 'Note'),
        e('textarea', {
          name:'note',
          value:form.note,
          onChange:onChange
        })
      )
    ),

    // righe
    e('div', { className:'card', style:{marginTop:8,overflowX:'auto'} },
      e('table', { className:'table' },
        e('thead', null,
          e('tr', null,
            e('th', {style:{width:32}}, '#'),
            e('th', {style:{width:150}}, 'Articolo'),
            e('th', null, 'Descrizione'),
            e('th', {style:{width:80}}, 'Q.tà'),
            e('th', {style:{width:60}}, 'UM'),
            e('th', null, 'Note'),
            e('th', {style:{width:60}}, '')
          )
        ),
        e('tbody', null,
          (form.righe||[]).map((r,i)=> e('tr',{key:i},
            e('td', {style:{textAlign:'center'}}, String(i+1)),
            e('td', null,
              e('input', {
                list:'art-list',
                value:r.codice||'',
                onChange: ev => {
                  const cod = ev.target.value;
                  const a = findArt(cod);
                  if (a) updRiga(i, { codice:a.codice, descrizione:a.descrizione||'', UM:a.um||r.UM||'PZ' });
                  else   updRiga(i, { codice:cod });
                }
              })
            ),
            e('td', null, e('input', { value:r.descrizione||'', onChange:ev=>updRiga(i,{descrizione:ev.target.value}) })),
            e('td', {style:{textAlign:'center'}},
              e('input', { type:'number', step:'any', value:r.qta||'', onChange:ev=>updRiga(i,{qta:ev.target.value}) })
            ),
            e('td', {style:{textAlign:'center'}},
              e('input', { value:r.UM||'PZ', onChange:ev=>updRiga(i,{UM:ev.target.value}) })
            ),
            e('td', null, e('input', { value:r.note||'', onChange:ev=>updRiga(i,{note:ev.target.value}) })),
            e('td', {style:{textAlign:'center'}},
              e('button', { type:'button', className:'btn btn-outline', onClick:()=>remRiga(i) }, '🗑')
            )
          ))
        )
      ),
      e('div', { className:'actions', style:{justifyContent:'flex-end'} },
        e('button', { type:'button', className:'btn btn-outline', onClick:addRiga }, '➕ Aggiungi riga')
      )
    ),

    // footer gestionale
    e('div', { className:'card', style:{marginTop:8} },
      e('div', { className:'form', style:{gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))'} },
        e('div', null, e('label', null, 'Vettore'),          e('input', { name:'vettore',          value:form.vettore,          onChange:onChange })),
        e('div', null, e('label', null, 'Aspetto beni'),     e('input', { name:'aspetto',          value:form.aspetto,          onChange:onChange })),
        e('div', null, e('label', null, 'Colli'),            e('input', { name:'colli',            value:form.colli,            onChange:onChange })),
        e('div', null, e('label', null, 'Data/ora'),         e('input', { name:'dataOra',          value:form.dataOra,          onChange:onChange })),
        e('div', null, e('label', null, 'Peso netto'),       e('input', { name:'pesoNetto',        value:form.pesoNetto,        onChange:onChange })),
        e('div', null, e('label', null, 'Peso lordo'),       e('input', { name:'pesoLordo',        value:form.pesoLordo,        onChange:onChange })),
        e('div', null, e('label', null, 'Firma vettore'),    e('input', { name:'firmaVettore',     value:form.firmaVettore,     onChange:onChange })),
        e('div', null, e('label', null, 'Firma conducente'), e('input', { name:'firmaConducente',  value:form.firmaConducente,  onChange:onChange })),
        e('div', null, e('label', null, 'Firma destinatario'), e('input', { name:'firmaDestinatario', value:form.firmaDestinatario, onChange:onChange }))
      )
    )
  ),

  // azioni (fuori dal fieldset: Annulla SEMPRE, Salva disabilitato se readOnly)
  e('div', { className:'actions', style:{justifyContent:'flex-end',gap:8} },
    e('button', { type:'button', className:'btn btn-outline',
      onClick:()=>{ setShowForm(false); setEditingId(null); } }, 'Annulla'),
    e('button', { type:'button', className:'btn btn-outline',
      onClick:()=>{ try{
        if (window.printDDT) window.printDDT(form);
        else {
          const html = window.renderDDTHTML ? window.renderDDTHTML(form) : '';
            if (html) (window.safePrintHTMLStringWithPageNum ? window.safePrintHTMLStringWithPageNum(html) : window.safePrintHTMLString(html));
            else alert('renderDDTHTML non disponibile');
        }
      }catch(e){ alert('Errore stampa DDT'); console.error(e); } } }, 'Stampa'),
    e('button', { type:'button', className:'btn btn-outline', onClick:()=>{ try{ window.openRicezioneOF && window.openRicezioneOF(form); }catch(e){ alert('Ricezione non disponibile: '+(e?.message||e)); } }}, 'Ricevi…'),
    e('button', { type:'button', className:'btn btn-outline',onClick:()=>{ try{ window.receiveAllOF && window.receiveAllOF(form); }catch(e){ alert('Ricezione non disponibile'); } }}, 'Ricevi tutto'),
    e('button', { type:'submit', className:'btn', ...(window.roProps ? window.roProps() : {}) }, 'Salva')
  ),


  // datalist articoli
  e('datalist', { id:'art-list' },...(Array.isArray(articoli)?articoli:[]).map(a =>
    e('option', { key:String(a.codice||a.id||Math.random()), value:String(a.codice||'') }, String(a.descrizione||''))
  ))
),


    // Modale multi-fattura
    modalMultiFa
  );
}

window.DDTView = DDTView;
window.ROUTES = window.ROUTES || {};
window.ROUTES['#/ddt'] = window.DDTView;

//* ==== GLOBAL DDT PRINT (render + print) ================================== */
;(function(){
  // Evita doppie definizioni ma NON saltare dopo il mount
  if (window.renderDDTHTML && window.safePrintHTMLString && window.printDDT) return;

  // stampa sicura in iframe (idempotente)
  if (!window.safePrintHTMLString) {
    window.safePrintHTMLString = function (html) {
      try{
        const ifr = document.createElement('iframe');
        ifr.style.width = ifr.style.height = '0';
        ifr.style.border = '0';
        document.body.appendChild(ifr);
        const d = ifr.contentWindow.document;
        d.open(); d.write(html); d.close();
        setTimeout(()=>{ try{ ifr.contentWindow && ifr.contentWindow.print(); }catch{} 
          setTimeout(()=>{ try{ ifr.remove(); }catch{} }, 300);
        },150);
      }catch(e){ console.warn('safePrintHTMLString error', e); }
    };
  }
    // Wrapper con fallback numerazione (idempotente)
    // === OVERRIDE NUMERAZIONE — VERSIONE UNICA ===
window.safePrintHTMLStringWithPageNum = function(html){
  try{
    const ifr = document.createElement('iframe');
    ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(ifr);

    const w = ifr.contentWindow, d = w.document;
    d.open(); d.write(String(html||'')); d.close();

    const run = () => {
      try{
        // DEDUPE pagebox nel documento figlio
        try{
          const boxes = Array.from(d.querySelectorAll('.pagebox'));
          if (boxes.length > 1) {
            const keep = d.querySelector('#pagebox') || boxes[0];
            boxes.forEach(el => { if (el !== keep) el.remove(); });
          }
        }catch{}

        // Neutralizza qualsiasi ::after che stampi solo " / "
        const kill = d.createElement('style');
        kill.textContent = '.pageNum::after,.pageX::after{content:"" !important}';
        d.head.appendChild(kill);

        // Leggi i margini reali da @page { margin: ... } (1/2/3/4 valori)
        let topMm = 16, bottomMm = 22;
        try{
          const cssText = Array.from(d.querySelectorAll('style')).map(s => s.textContent || '').join('\n');
          const m = /@page\s*{[^}]*margin\s*:\s*([0-9.]+)mm(?:\s+([0-9.]+)mm(?:\s+([0-9.]+)mm(?:\s+([0-9.]+)mm)?)?)?/i.exec(cssText);
          if (m){
            const v = [m[1],m[2],m[3],m[4]].filter(Boolean).map(parseFloat);
            if (v.length === 1){ topMm = bottomMm = v[0]; }
            else if (v.length === 2){ topMm = bottomMm = v[0]; }   // top/bottom = 1° valore
            else if (v.length === 3){ topMm = v[0]; bottomMm = v[2]; }
            else if (v.length >= 4){ topMm = v[0]; bottomMm = v[2]; }
          }
        }catch{}

        // mm → px
        const mmToPx = (() => {
          const t = d.createElement('div');
          t.style.height='100mm'; t.style.position='absolute'; t.style.visibility='hidden';
          d.body.appendChild(t);
          const px = t.getBoundingClientRect().height || 0;
          t.remove(); return px/100;
        })();

        const pageHeightMm = 297 - (topMm + bottomMm);
        const pageHeightPx = (mmToPx>0) ? (mmToPx * pageHeightMm) : (w.innerHeight || 1123);

        // Misura SOLO il contenuto (hai già il wrapper .content nella Fattura)
        const content = d.querySelector('.content') || d.body;
        const h = Math.max(content.scrollHeight, content.offsetHeight, d.body.scrollHeight);

        // Totale con tolleranza anti “falso 2”
        let total = Math.max(1, Math.ceil(h / pageHeightPx));
        const overPx = h - pageHeightPx;

        if (total === 2) {
          const snapPx = Math.max(140, pageHeightPx * 0.18); // ~18% o 140px
          if (overPx <= snapPx) total = 1;
        }
        if (total === 2) {
          const lastTr = d.querySelector('table tbody tr:last-child');
          if (lastTr) {
            const r = lastTr.getBoundingClientRect();
            if (r && (r.bottom + 16) < pageHeightPx) total = 1;
          }
        }

        // Scrivi SEMPRE il testo su .pageNum (markup Fattura)
        const pn = d.querySelector('#pagebox .pageNum') || d.querySelector('.pageNum');
        if (pn){ pn.removeAttribute('data-mode'); pn.textContent = `1 / ${total}`; }

      } finally {
        try { w.focus(); w.print(); } catch {}
        setTimeout(()=>{ try{ ifr.remove(); }catch{} }, 300);
      }
    };

    // Attendi immagini/logo per misurazioni stabili
    const imgs = Array.from(d.images || []);
    if (imgs.length === 0) setTimeout(run, 120);
    else {
      let done = 0; const tick = () => { if (++done >= imgs.length) run(); };
      imgs.forEach(im => { if (im.complete) tick(); else { im.addEventListener('load', tick, { once:true }); im.addEventListener('error', tick, { once:true }); }});
      setTimeout(run, 1600);
    }

    w.addEventListener?.('afterprint', () => { try{ ifr.remove(); }catch{} });
  }catch(e){
    console.warn('safePrintHTMLStringWithPageNum error', e);
    if (window.safePrintHTMLString) window.safePrintHTMLString(html);
  }
};


  // HTML della stampa DDT (idempotente)
  if (!window.renderDDTHTML) {
      // ===== HTML della stampa DDT (layout classico) =====
  // ===== HTML stampa DDT (header/footer fissi + pagina X/Y + sedi in header) =====
window.renderDDTHTML = function(ddt){
  const esc = v => String(v ?? '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));

  // Config azienda
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; } catch {}
  const logoUrl  = cfg.logoDataUrl || cfg.logoUrl || cfg.logo || '';
  const ragAzi   = esc(
    cfg.ragioneSociale || cfg.ragione || cfg.ragioneAzienda ||
    cfg.companyName ||
    (cfg.azienda && (cfg.azienda.ragione || cfg.azienda.ragioneSociale)) || ''
  );
  const pivaAzi  = esc(
    cfg.piva || cfg.partitaIva || cfg.companyVat ||
    (cfg.azienda && (cfg.azienda.piva || cfg.azienda.partitaIva)) || ''
  );
  const sedeLeg  = esc(
    cfg.sedeLegale || cfg.companyLegal || (cfg.azienda && cfg.azienda.sedeLegale) || ''
  );
  const sedeOp   = esc(
    cfg.sedeOperativa || (cfg.azienda && cfg.azienda.sedeOperativa) || ''
  );
  const telAzi   = esc(cfg.telefono || cfg.phone || (cfg.azienda && (cfg.azienda.telefono || cfg.azienda.phone)) || '');
  const emailAzi = esc(cfg.email || (cfg.azienda && cfg.azienda.email) || '');
  const pecAzi   = esc(cfg.pec   || (cfg.azienda && cfg.azienda.pec)   || '');

  // Cliente
  const cliRag   = esc(ddt?.cliente || ddt?.clienteRagione || '');
  const cliPiva  = esc(ddt?.clientePiva || '');

  // Luogo di consegna (evita duplicati col cliente)
  const lcRaw    = String(ddt?.luogoConsegna||'').trim();
  const luogoTxt = (!lcRaw || lcRaw.toLowerCase() === String(ddt?.cliente||'').trim().toLowerCase()) ? '' : esc(lcRaw);

  // Riferimento cliente (usa util globale se c'è)
  let rifClienteTxt = '';
  try{
    const ref = ddt?.rifCliente || {
      tipo  : ddt?.rifClienteTipo || '',
      numero: ddt?.rifClienteNum  || '',
      data  : ddt?.rifClienteData || ''
    };
    if (typeof window.refClienteToText === 'function') {
      rifClienteTxt = window.refClienteToText(ref);
    } else {
      const t = String(ref?.tipo||'').toUpperCase();
      const n = String(ref?.numero||'');
      const ds= String(ref?.data||'');
      rifClienteTxt = [t, n && ('n. '+n), ds && ('del '+ds)].filter(Boolean).join(' ');
    }
  }catch{}

  // Righe
  const righe = Array.isArray(ddt?.righe) ? ddt.righe : (Array.isArray(ddt?.articoli) ? ddt.articoli : []);
  const hasNote = (righe||[]).some(r => r && r.note);
  const rowsHTML = (righe && righe.length ? righe : [{}]).map((r,i)=>`
    <tr>
      <td class="ctr">${righe.length ? (i+1) : ''}</td>
      <td>${esc(r.codice || r.articoloCodice || '')}</td>
      <td>${esc(r.descrizione || '')}</td>
      <td class="ctr">${esc(r.UM || r.um || '')}</td>
      <td class="ctr">${r.qta ?? r.quantita ?? ''}</td>
      ${hasNote ? `<td>${esc(r.note||'')}</td>` : ''}
    </tr>
  `).join('');

  // Footer (trasporto) — ripetuto a ogni pagina
  const vettore   = esc(ddt?.vettore || '');
  const aspetto   = esc(ddt?.aspetto || ddt?.aspettoBeni || '');
  const colli     = esc(ddt?.colli || '');
  const dataOra   = esc(ddt?.dataOra || '');
  const pesoNetto = esc(ddt?.pesoNetto || '');
  const pesoLordo = esc(ddt?.pesoLordo || '');

  let css = window.__PRINT_CSS({ top:16, right:12, bottom:22, left:12 });
css += `
  <style>
    /* RIMOSSE dal tuo blocco originale:
       - @page { ... }              → gestita dal tema
       - .pageNum[data-mode="css"]  → non serve
       - .pageNum[data-mode="css"]::after { ... } → non serve
    */

    html,body{margin:0;padding:0}
    body{
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;
      font-size:12px; color:#0f172a;
      -webkit-print-color-adjust:exact; print-color-adjust:exact;
    }

    .header{
      position:fixed; top:0; left:0; right:0; height:36mm;
      border-bottom:2px solid #111; padding:6px 0;
      display:flex; justify-content:space-between; align-items:center; gap:12px;
      background:#fff;
    }
    .header .logo{height:80px; max-height:80px; object-fit:contain; margin-left:2mm}
    .header .tit{ text-align:right; padding-top:4mm }
    .header .docTitle{ font-size:20px; font-weight:800; margin:0 }
    .header .muted{ color:#64748b }

        /* FOOTER fisso + box trasporto + numerazione X/Y */
    .footer{
      position:fixed; bottom:0; left:0; right:0; height:24mm;
      border-top:1px solid #cbd5e1; background:#fff;
      padding:4mm 0 4mm 0;         /* spazio interno per pagebox */
    }
    .footer .grid{
      display:grid;
      grid-template-columns:repeat(3,1fr);
      gap:6px;
      padding:0 8mm;               /* respiro a destra per non toccare la numerazione */
    }
    .footer .box{ font-size:11px; border:1px solid #e5e7eb; border-radius:6px; padding:6px }
    .footer { position:fixed; }     /* compat: forza i motori più capricciosi */

    /* Numeratore in basso a destra ALL’INTERNO del footer */
    .footer .pagebox{
      position: static;
      margin-top: 6px;     /* va sotto "Peso lordo" */
      margin-left: auto;   /* allineato a destra */
      font-weight: 700;
      text-align: right;
    }
    .footer .pagebox .pageNum{
      display:inline-block;
      min-width:38px;
      text-align:right;
    }

    /* Margine contenuto: lascia spazio al footer più alto */
    .content{ margin:36mm 0 30mm 0; }


    /* pagebox: lasciamo quello del tema; se vuoi tenerlo qui, ok ma NON toccare ::after */
    /* .footer .pagebox{ min-width:68px; text-align:right; padding-right:2mm; font-weight:700; } */

    .content{ margin:40mm 0 30mm 0; }

    .muted{color:#64748b}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px}
    .box{border:1px solid #cbd5e1;border-radius:8px;padding:8px}
    .lbl{font-weight:600;margin-bottom:4px}

    table{width:100%;border-collapse:collapse;margin-top:10px}
    thead{display:table-header-group}
    th,td{border:1px solid #e5e7eb;padding:6px;vertical-align:top}
    th{background:#f8fafc}
    .ctr{text-align:center}.right{text-align:right}
    .footer .grid{
  display:grid;
  grid-template-columns:repeat(3,minmax(0,1fr));
  gap:6px
}
.footer .box{
  border:1px solid #e5e7eb;
  padding:6px;
  border-radius:6px;
  font-size:11px
}
.pagebox{margin-top:6px;font-weight:700;text-align:right}
.pagebox .pageNum{display:inline-block;min-width:38px;text-align:right}

  </style>`;
  
  const header = `
    <div class="header">
      <div style="display:flex;gap:12px;align-items:center">
        ${logoUrl ? `<img class="logo" src="${logoUrl}">` : ``}
        <div>
          <div class="doc">${ragAzi}</div>
          ${pivaAzi ? `<div class="muted">P.IVA: ${pivaAzi}</div>` : ``}
          ${sedeLeg ? `<div class="muted">Sede legale: ${sedeLeg}</div>` : ``}
          ${sedeOp  ? `<div class="muted">Sede operativa: ${sedeOp}</div>` : ``}
          ${telAzi   ? `<div class="muted">Tel: ${telAzi}</div>`   : ``}
          ${emailAzi ? `<div class="muted">Email: ${emailAzi}</div>` : ``}
          ${pecAzi   ? `<div class="muted">PEC: ${pecAzi}</div>`   : ``}
        </div>
      </div>
      <div class="tit">
        <div class="docTitle">DOCUMENTO DI TRASPORTO</div>
        <div class="muted"><b>${esc(ddt?.id||'')}</b></div>
        <div class="muted">Data: <b>${esc(ddt?.data||'')}</b></div>
      </div>
    </div>`;

  const mittDest = `
    <div class="grid2">
      <div class="box">
        <div class="lbl">Mittente</div>
        <div><b>${ragAzi}</b></div>
        ${pivaAzi ? `<div class="muted">P.IVA: ${pivaAzi}</div>` : ``}
        ${sedeLeg ? `<div class="muted">${sedeLeg}</div>` : ``}
        ${sedeOp  ? `<div class="muted">${sedeOp}</div>` : ``}
      </div>
      <div class="box">
        <div class="lbl">Destinatario</div>
        <div><b>${cliRag || '—'}</b></div>
        ${cliPiva ? `<div class="muted">P.IVA: ${cliPiva}</div>` : ``}
        ${luogoTxt ? `<div class="muted">Luogo di consegna: ${luogoTxt}</div>` : ``}
        ${rifClienteTxt ? `<div class="muted" style="margin-top:4px">Rif. doc. cliente: ${rifClienteTxt}</div>` : ``}
        ${ddt?.commessaRif ? `<div class="muted">Commessa: ${esc(ddt.commessaRif)}</div>` : ``}
      </div>
    </div>`;

  const causale = (ddt?.causaleTrasporto)
    ? `<div class="box" style="margin-top:8px">Causale del trasporto: <b>${esc(ddt.causaleTrasporto)}</b></div>`
    : ``;

  const tabella = `
    <table>
      <thead><tr>
        <th class="ctr" style="width:26px">#</th>
        <th style="width:140px">Codice</th>
        <th>Descrizione</th>
        <th class="ctr" style="width:60px">UM</th>
        <th class="ctr" style="width:64px">Q.tà</th>
        ${hasNote ? `<th style="width:160px">Note</th>` : ``}
      </tr></thead>
      <tbody>${rowsHTML}</tbody>
    </table>`;

  const footer = `
  <div class="footer">
    <div class="grid">
      <div class="box">Vettore: <b>${vettore || '—'}</b></div>
      <div class="box">Aspetto beni: <b>${aspetto || '—'}</b></div>
      <div class="box">Colli: <b>${colli || '—'}</b></div>
      <div class="box">Data/ora: <b>${dataOra || '—'}</b></div>
      <div class="box">Peso netto: <b>${pesoNetto || '—'}</b></div>
      <div class="box">Peso lordo: <b>${pesoLordo || '—'}</b></div>
    </div>
    <div id="pagebox" class="pagebox">Pag. <span class="pageNum"></span></div>
  </div>
`;



  return `<!doctype html><html><head><meta charset="utf-8">${css}</head>
  <body>
    ${header}
    ${footer}
    <div class="content">
      ${mittDest}
      ${causale}
      ${tabella}
    </div>
  </body></html>`;
};

// ===== Stampa DDT con fallback numerazione pagina =====
window.printDDT = function(state){
  try{
    // 1) Sorgente dati
    let ddt = state;
    if (!ddt && typeof window.__DEBUG_DDT === 'function') {
      try { ddt = window.__DEBUG_DDT(); } catch {}
    }
    if (!ddt || Object.keys(ddt||{}).length === 0) {
      alert('Nessun DDT da stampare (stato vuoto).'); return;
    }

    // 2) HTML
    const html = window.renderDDTHTML(ddt);

    // 3) Finestra di stampa
    const w = window.open('', '_blank');
    if (!w) { alert('Popup bloccato: consenti i pop-up per la stampa.'); return; }
    w.document.open(); w.document.write(html); w.document.close();

    // DEDUPE: se per errore ci sono più pagebox, tieni il primo
    try{
      const boxes = Array.from(w.document.querySelectorAll('.pagebox'));
      boxes.forEach((el, i) => { if (i>0) el.remove(); });
    }catch{}

    // — Fallback pagina X/Y quando i counters CSS non funzionano —
    const setupPageNum = () => {
      try{
        const pn = w.document.querySelector('#pagebox .pageNum') || w.document.querySelector('.pageNum');
        if (!pn) return;

        // prova prima in "modalità CSS"
        pn.setAttribute('data-mode', 'css');

        // leggi il contenuto generato dal ::after
        const pseudo = w.getComputedStyle(pn, '::after').getPropertyValue('content') || '';

        // alcune implementazioni restituiscono "normal", "none" o stringhe vuote "" oppure "0 / 0"
        const bad = (!pseudo || !/\d/.test(pseudo)); // valido solo se vedo almeno una cifra

        if (bad) {
          // passa a fallback JS e scrivi "1 / N" come testo interno
          pn.removeAttribute('data-mode');

          // stima il numero di pagine in px convertendo i mm della pagina
          const mmToPx = (() => {
            const t = w.document.createElement('div');
            t.style.height = '100mm';
            t.style.position = 'absolute';
            t.style.visibility = 'hidden';
            w.document.body.appendChild(t);
            const px = t.getBoundingClientRect().height || 0;
            t.remove();
            return px / 100;
          })();

          // altezza utile stimata (A4 297mm, margini @page top/bottom = 16/22mm)
          const pageHeightMm = 297 - (16 + 22);
          const pageHeightPx = (mmToPx > 0) ? (mmToPx * pageHeightMm) : (w.innerHeight || 1123); // fallback

          const content = w.document.querySelector('.content') || w.document.body;
          const h = Math.max(content.scrollHeight, content.offsetHeight, w.document.body.scrollHeight);
          const total = Math.max(1, Math.ceil(h / pageHeightPx));

          // NB: con fallback non possiamo mostrare "2 / N" su ogni pagina,
          // quindi mettiamo "1 / N" uguale su tutte. Almeno evita "0/0".
          pn.textContent = `1 / ${total}`;
        }
      }catch{}
    };

    // 4) Stampa dopo immagini/caricamenti
    const finish = () => { try { w.focus(); setupPageNum(); w.print(); } catch {} };
    const imgs = w.document.images;
    if (imgs && imgs.length){
      let done = 0;
      const onOne = () => { done++; if (done >= imgs.length) setTimeout(finish, 80); };
      for (const im of imgs) { im.addEventListener('load', onOne); im.addEventListener('error', onOne); }
      setTimeout(finish, 1200); // fallback
    } else {
      if (w.document.readyState === 'complete') finish();
      else w.addEventListener('load', () => setTimeout(finish, 60));
    }
  }catch(e){
    console.error('printDDT error', e);
    alert('Errore durante la stampa DDT');
  }
};
  }
})();


/* ================== FATTURE (lista, CRUD) ================== */
(function (global) {
  const e = React.createElement;

  // Helpers LS
  const lsGet = global.lsGet || ((k,d)=>{ try{ const v=JSON.parse(localStorage.getItem(k)); return (v??d);}catch{return d;} });
  const lsSet = global.lsSet || ((k,v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} });

  const todayISO = ()=> new Date().toISOString().slice(0,10);
  const fmt2 = n => Number(n||0).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2});
  const pad3 = n => String(n).padStart(3,'0');

  // read-only: accountant
  const readOnly = (global.isReadOnlyUser ? !!global.isReadOnlyUser() : !!(global.__currentUser && global.__currentUser.role==='accountant'));
  const roProps  = () => (readOnly ? { disabled:true, title:'Sola lettura' } : {});

  // mirror al server (se disponibile)
  const mirrorToServer = global.mirrorToServer || ((k,v)=>{});
  const api = (global.api && global.api.kv) ? global.api.kv : null;

  function totals(righe){
    let imponibile=0, imposta=0;
    (righe||[]).forEach(r=>{
      const qty = Number(r.qta||0);
      const pr  = Number(r.prezzo||0);
      const scp = Number(r.sconto||r.scontoPerc||0);
      const iva = Number(r.iva||0);
      const rowBase = qty * pr * (1 - (scp/100));
      imponibile += rowBase;
      imposta    += rowBase * iva/100;
    });
    return { imponibile, imposta, totale: imponibile+imposta };
  }

  function FattureView(){
    const app      = React.useMemo(()=> lsGet('appSettings',{})||{}, []);
    const clienti  = React.useMemo(()=> lsGet('clientiRows',[])||[], []);
    const [rows, setRows] = React.useState(()=> lsGet('fattureRows', []) || []);

    // hydrate da server, se disponibile
    React.useEffect(()=>{
      (async ()=>{
        try{
          if (api && typeof api.get==='function'){
            const s = await api.get('fattureRows');
            if (Array.isArray(s)) { setRows(s); lsSet('fattureRows', s); }
          }
        }catch(e){}
      })();
    },[]);

    // mirror locale + server
    React.useEffect(()=>{
      lsSet('fattureRows', rows);
      try { mirrorToServer('fattureRows', rows); } catch {}
    },[rows]);

    const [q, setQ]         = React.useState('');
    const [form, setForm]   = React.useState({
      id:'', data: todayISO(),
      clienteId:'', cliente:'',
      pagamento: app.defaultPagamento || '30 gg data fattura',
      iban: app.iban || '', codiceUnivoco:'', pec:'',
      plafond:false, naturaIva:'',
      causale:'',
      ddtId:'', ddtData:'',
      note:'',
      rifNormativo:'', // es. “Operazione non imponibile art. 8, DPR 633/72”
      righe:[], // {descrizione,qta,UM,prezzo,iva,sconto}
      stato: 'Bozza',
      scadenze: [] // [{data:'YYYY-MM-DD', importo: number}]

    });
    const [editingId, setEditingId] = React.useState(null);
    const [showForm, setShowForm]   = React.useState(false);

    // Prefill da DDT
    React.useEffect(()=>{
      try{
        const raw = localStorage.getItem('prefillFattura');
        if(!raw) return;
        localStorage.removeItem('prefillFattura');
        const pf = JSON.parse(raw);
        setForm(prev => ({ ...prev, ...pf, causale: (prev.causale||'') }));
        setShowForm(true);
      }catch{}
    },[]);

        async function openNew(){
      // Genera ID robusto FA-YYYY-NNN (legge anche Impostazioni/counters se hai nextIdFor)
      const idObj = (typeof window.nextIdFor === 'function')
            ? await window.nextIdFor({ prefix:'FA', storageKey:'fattureRows', seriesKey:'FA', width:3 })
        : (function(){
            const y  = new Date().getFullYear();
            const pad = n => String(n).padStart(3,'0');
            let all = [];
            try { all = JSON.parse(localStorage.getItem('fattureRows')||'[]')||[]; } catch {}
            const n = 1 + all.filter(r => String(r.id||'').startsWith(`FA-${y}-`)).length;
            return { id:`FA-${y}-${pad(n)}`, year:y, num:n };
          })();

      setForm(()=>({
        id: idObj.id,
        data: todayISO(),
        clienteId:'', cliente:'',
        pagamento: app.defaultPagamento || '30 gg data fattura',
        iban: app.iban || '', codiceUnivoco:'', pec:'',
        plafond:false, naturaIva:'',
        causale:'',
        ddtId:'', ddtData:'',
        note:'',
        righe:[],
        stato:'Bozza',
        scadenze:[]
      }));
      setEditingId(null);
      setShowForm(true);
    }

    function openEdit(id){
      const x = (rows||[]).find(r=>r.id===id); if(!x) return;
      setForm({ ...x, righe: Array.isArray(x.righe)?x.righe:[] });
      setEditingId(id);
      setShowForm(true);
    }
    function del(id){
      if(!confirm('Eliminare fattura?')) return;
      setRows(prev=>prev.filter(r=>r.id!==id));
    }

    function onChange(ev){
      const {name,value,type,checked} = ev.target;
      setForm(p=>({...p, [name]: (type==='checkbox'? !!checked : value)}));
    }
    function onSelCliente(id){
      const c = (clienti||[]).find(x=>String(x.id)===String(id)) || null;
      setForm(p=>({
        ...p,
        clienteId:id,
        cliente: c ? (c.ragione || c.ragioneSociale || c.denominazione || c.nome || '') : '',
        codiceUnivoco: c ? (c.codiceUnivoco||'') : '',
        pec: c ? (c.pec||'') : '',
        plafond: !!(c && c.plafond),
        naturaIva: c ? (c.naturaIva || p.naturaIva) : p.naturaIva,
        pagamento: p.pagamento || (app.defaultPagamento || '30 gg data fattura')
      }));
    }
          function addScadenza(){
      const d = todayISO();
      setForm(p => ({ ...p, scadenze: [...(p.scadenze||[]), { data:d, importo:0 }] }));
    }
    function updScadenza(i, patch){
      setForm(p => {
        const nx = [...(p.scadenze||[])];
        nx[i] = { ...nx[i], ...patch };
        return { ...p, scadenze: nx };
      });
    }
    function delScadenza(i){
      setForm(p => ({ ...p, scadenze: (p.scadenze||[]).filter((_,k)=>k!==i) }));
    }

    // Righe
    function addRiga(){
      const ivaDef = (form.plafond ? 0 : (Number(app.defaultIva)||22));
      setForm(p=>({
        ...p,
        righe:[...(p.righe||[]), { descrizione:'', qta:'', UM:'PZ', prezzo:'', iva: ivaDef, sconto:'' }]
      }));
    }
    function updRiga(i,patch){
      setForm(p=>({
        ...p,
        righe:(p.righe||[]).map((r,ix)=> ix===i ? { ...r, ...patch } : r)
      }));
    }
    function remRiga(i){
      setForm(p=>({
        ...p,
        righe:(p.righe||[]).filter((_,ix)=>ix!==i)
      }));
    }

        async function save(ev){
      ev && ev.preventDefault();

      // Assicura un ID fattura valido (FA-YYYY-NNN)
      const curId = String(form.id || '').trim();
      const badId =
        !curId ||                                 // vuoto
        curId.toUpperCase().includes('NAN') ||    // conteneva NaN
        !curId.startsWith('FA-');                 // qualsiasi cosa non inizi con FA-

      if (badId) {
        let idObj = null;

        if (typeof window.nextIdFor === 'function') {
          try {
            idObj = await window.nextIdFor({
              prefix:     'FA',
              storageKey: 'fattureRows',
              seriesKey:  'FA',
              width:      3
            });
          } catch {}
        }

        // Fallback locale se nextIdFor non è disponibile
        if (!idObj || !idObj.id) {
          const y   = new Date().getFullYear();
          const pad = n => String(n).padStart(3,'0');
          let all   = [];
          try { all = JSON.parse(localStorage.getItem('fattureRows') || '[]') || []; } catch {}
          const n = 1 + (all.filter(r => String(r.id||'').startsWith(`FA-${y}-`)).length || 0);
          idObj = { id:`FA-${y}-${pad(n)}`, year:y, num:n };
        }

        form.id = idObj.id;
      }

      // Validazioni base
      if (!form.clienteId && !form.cliente){
        alert('Seleziona un cliente');
        return;
      }

      const righeValide = (form.righe||[]).filter(r=>{
        const hasText = String(r.descrizione||'').trim() || String(r.codice||'').trim();
        const qty = Number(r.qta||0);
        return !!hasText && Number.isFinite(qty) && qty>0;
      });
      if (!righeValide.length){
        alert('Inserisci almeno una riga con descrizione/codice e quantità > 0');
        return;
      }

      const rec = {
        ...form,
        righe: righeValide,
        updatedAt: new Date().toISOString()
      };

      // Scrivi LS (write-through)
      let all = [];
      try { all = JSON.parse(localStorage.getItem('fattureRows')||'[]')||[]; } catch {}
      const ix = all.findIndex(r => String(r.id) === String(rec.id));
      if (ix>=0) all[ix]=rec; else all.push(rec);
      try { localStorage.setItem('fattureRows', JSON.stringify(all)); } catch {}

      // UI
      setRows(all);
      setShowForm(false);
      setEditingId(rec.id);

      // Sync cloud (best-effort, non crashare offline)
      try{
        if (window.syncExportToCloudOnly) window.syncExportToCloudOnly(['fattureRows']);
        if (window.persistKV) await window.persistKV('fattureRows', all);
        if (window.api?.kv?.set) await window.api.kv.set('fattureRows', all);
      }catch{}

      alert('Fattura salvata ✅');
    }


    // Totali live del form
    const formTotals = totals(form.righe||[]);

    // Ricerca/ordinamento
    const filtered = React.useMemo(()=>{
      const s = String(q||'').toLowerCase();
      return (rows||[])
        .filter(fa => (String(fa.id)+' '+String(fa.cliente||'')+' '+String(fa.note||'')).toLowerCase().includes(s))
        .sort((a,b)=>{
          const ma = String(a.id||'').match(/^(?:FATT|FA)-(\d{4})-(\d{3})$/);
          const mb = String(b.id||'').match(/^(?:FATT|FA)-(\d{4})-(\d{3})$/);
          if(ma&&mb){
            if(+mb[1]!==+ma[1]) return +mb[1]-+ma[1];
            if(+mb[2]!==+ma[2]) return +mb[2]-+ma[2];
          }
          return String(b.id||'').localeCompare(String(a.id||'')); // fallback
        });
    },[rows,q]);

            // ---- FILTRO ANNO (lista dinamica dagli ID/Data) ----
    const [year, setYear] = React.useState('');

    // Estrae anno da 'data' (YYYY-MM-DD) o da ID tipo FA-2025-001, altrimenti vuoto
    const getYearFromFa = (fa) => {
      try{
        const d = fa?.data || fa?.dataFattura || '';
        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0,4);
      }catch{}
      try{
        const id = String(fa?.id||'');
        const m = id.match(/(\d{4})/);
        if (m) return m[1];
      }catch{}
      return '';
    };

    const years = React.useMemo(()=>{
      const set = new Set();
      (rows||[]).forEach(fa => {
        const y = getYearFromFa(fa);
        if (y) set.add(y);
      });
      return Array.from(set).sort((a,b)=> b.localeCompare(a)); // discendente
    }, [rows]);

    // Applica il filtro per anno sopra al filtro testuale
    const filteredView = React.useMemo(()=>{
      if (!year) return filtered;
      return (filtered||[]).filter(fa => getYearFromFa(fa) === year);
    }, [filtered, year]);

        // Somma totale delle fatture attualmente filtrate (per la toolbar)
            const filteredTotale = React.useMemo(()=>{
      try{
        return (filteredView||[]).reduce((S, fa)=>{
          const t = totals(fa.righe||[]);
          return S + (Number.isFinite(t.totale) ? t.totale : 0);
        }, 0);
      }catch{ return 0; }
    }, [filteredView]);


    return e('div',{className:'page'},

      // Toolbar
      e('div',{className:'actions',style:{marginBottom:8}},
        e('input',{className:'input',placeholder:'Cerca…', value:q, onChange:ev=>setQ(ev.target.value)}),
        e('button',{ className:'btn', onClick:openNew, ...(global.roProps ? global.roProps() : roProps()) }, '➕ Nuova fattura'),
        e('select', {className:'input',value: year,onChange: e => setYear(e.target.value),style:{ width: 140 }},
          e('option', { value:'' }, 'Anno: tutti'),
          ...years.map(y => e('option', { key:y, value:String(y) }, y))
        ),
    
        e('div',{ className:'muted', style:{ marginLeft:'auto' } },
          'Totale filtro: € ' + fmt2(filteredTotale)
        )

      ),

                e('div',{className:'card', style:{marginTop:8}},
            e('div',{className:'actions',style:{justifyContent:'space-between'}},
              e('h4',null,'Scadenze'),
              e('button',{type:'button',className:'btn btn-outline', onClick:addScadenza},'➕ Aggiungi scadenza')
            ),
            e('table',{className:'table'},
              e('thead',null,
                e('tr',null,
                  e('th',{style:{width:160}},'Data'),
                  e('th',{style:{width:160}},'Importo'),
                  e('th',{style:{width:60}},'')
                )
              ),
              e('tbody',null,
                (form.scadenze||[]).map((s,i)=> e('tr',{key:i},
                  e('td',null, e('input',{type:'date', value:s.data||todayISO(), onChange:ev=>updScadenza(i,{data:ev.target.value})})),
                  e('td',null, e('input',{type:'number', step:'0.01', value:s.importo||0, onChange:ev=>updScadenza(i,{importo:ev.target.value})})),
                  e('td',null, e('button',{type:'button',className:'btn btn-outline', onClick:()=>delScadenza(i)},'🗑'))
                ))
              )
            )
          ),

      // Lista
      e('div',{className:'card',style:{overflowX:'auto'}},
        e('table',{className:'table'},
          e('thead',null,
            e('tr',null,
              e('th',{style:{width:130}},'N.'),
              e('th',null,'Data'),
              e('th',null,'Cliente'),
              e('th',{style:{width:120}},'Totale'),
              e('th',{style:{width:120}},'Stato'),
              e('th',{style:{width:250}},'Azioni')
            )
          ),
          e('tbody',null,
            filteredView.map(fa=>{
              const t=totals(fa.righe||[]);
              return e('tr',{key:fa.id},
                e('td',null,fa.id),
                e('td',null,fa.data||''),
                e('td',null,fa.cliente||''),
                e('td',null,fmt2(t.totale)),
                                e('td',null,
                  e('span',{
                    className:'pill',
                    style:{
                      padding:'2px 8px', borderRadius:999,
                      background:
                        (fa.stato==='Pagata' ? '#dcfce7' :
                        fa.stato==='Inviata' ? '#dbeafe' :
                        fa.stato==='Stornata'? '#fee2e2' :
                        fa.stato==='Emessa' ? '#e9d5ff' : '#e5e7eb'),
                      color:'#111827', fontSize:12
                    }
                  }, fa.stato || 'Bozza')
                ),
                e('td', null,
                  e('button',{className:'btn btn-outline',onClick:()=>openEdit(fa.id), disabled: readOnly, title: readOnly ? 'Sola lettura' : ''},'✏️ Modifica'),' ',
                  e('button',{className:'btn btn-outline',title:'Anteprima/Stampa',onClick:()=>window.printFattura && window.printFattura(fa)}, '🖨️ Stampa'),' ',
                  (function(){
                    let ok=true, tip='Esporta XML FatturaPA';
                      try{
                        const res = window.canExportFatturaPA ? window.canExportFatturaPA(fa) : {ok:true,reasons:[]};
                        ok = !!res.ok; if(!ok) tip = 'Impossibile esportare: ' + res.reasons.join(' · ');
                        }catch{}
                      return e('button',{type:'button',className:'btn btn-outline',title: tip,disabled: !ok,onClick:()=>{ if(ok) try{ window.exportFatturaPAXML && window.exportFatturaPAXML(faObj); }catch(e){} }}, 'XML FatturaPA');})(), ' ',
                  e('button',{ className:'btn btn-outline', onClick:()=>del(fa.id), ...(global.roProps ? global.roProps() : roProps()) }, '🗑')
                )
              );
            })
          )
        )
      ),

      // Form
      showForm && e('form', { className:'card', onSubmit: save, style:{marginTop:8,padding:12} },
        e('h3', null, editingId ? `Modifica ${form.id}` : 'Nuova fattura'),

        // CAMPI BLOCCATI IN SOLA LETTURA
        e('fieldset', { disabled: readOnly },

          // metadati
          e('div',{className:'form', style:{gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:12}
          },
            e('div',{className:'form-group-title', style:{gridColumn:'1 / -1'}}, 'Dati fattura'),
            e('div',null, e('label',null,'Data'), e('input',{type:'date',name:'data',value:form.data,onChange:onChange})),
            e('div',null,
              e('label',null,'Cliente'),
              (clienti && clienti.length)
                ? e('select',{value:form.clienteId,onChange:ev=>onSelCliente(ev.target.value)},
                    e('option',{value:''},'— seleziona —'),
                    (clienti.map(c=> e('option',{key:c.id,value:c.id},String(c.ragione||c.ragioneSociale||c.denominazione||c.nome||c.id))))
                  )
                : e('a',{className:'btn btn-outline',href:'#/clienti'},'Crea cliente…')
            ),
            e('div',null,
              e('label',null,'Stato'),
              e('select',{ name:'stato', value:form.stato||'Bozza', onChange:onChange },
                e('option',{value:'Bozza'},'Bozza'),
                e('option',{value:'Emessa'},'Emessa'),
                e('option',{value:'Inviata'},'Inviata'),
                e('option',{value:'Pagata'},'Pagata'),
                e('option',{value:'Stornata'},'Stornata')
              )
            ),
            e('div',null,
              e('label',null,'Bollo virtuale'),
            e('div',null,
              e('input',{type:'checkbox', checked:!!form.bolloVirtuale, onChange:ev=>setForm(p=>({...p, bolloVirtuale: ev.target.checked}))}),
                ' Applicare € 2,00 per bollo su esenti/non imponibili (o personalizza importo sotto)'
            )
          ),
          e('div',null,
            e('label',null,'Importo bollo'),e('input',{type:'number', step:'0.01', value: form.importoBollo ?? 2.00,onChange:ev=> setForm(p=>({...p, importoBollo: Number(ev.target.value||2)}))})
          ),
            e('div',null, e('label',null,'Pagamento'), e('input',{name:'pagamento',value:form.pagamento||'',onChange:onChange})),
            e('div',null,e('label',null,'Esigibilità IVA'), 
              e('select',{name:'esigibilitaIVA', value:form.esigibilitaIVA||'', onChange:onChange},
                e('option',{value:''},'—'),
                e('option',{value:'I'},'I — Immediata'),
                e('option',{value:'D'},'D — Differita'),
                e('option',{value:'S'},'S — Scissione pagamenti (split)')
              )
            ),
            e('div',null,
              e('label',null,'Riferimento normativo (per IVA 0)'),
              e('input',{name:'rifNormativo', value:form.rifNormativo||'', onChange:onChange, placeholder:'es. Operazione esente art. 10 DPR 633/72'})
            ),
            e('div',null, e('label',null,'IBAN (documento)'), e('input',{name:'iban',value:form.iban||'',onChange:onChange})),
            e('div',null, e('label',null,'Codice Univoco SDI'), e('input',{name:'codiceUnivoco',value:form.codiceUnivoco||'',onChange:onChange})),
            e('div',null, e('label',null,'PEC'), e('input',{name:'pec',value:form.pec||'',onChange:onChange})),

            e('label',{className:'row',style:{gap:8,alignItems:'center'}},
              e('input',{type:'checkbox',checked:!!form.plafond,onChange:ev=>setForm(p=>({...p,plafond:ev.target.checked, righe:(p.righe||[]).map(r=>({...r,iva:0}))}))}),
              e('span',null,'Cliente a plafond (IVA 0 e natura IVA)')
            ),
            e('div',null, e('label',null,'Natura IVA (se plafond)'), e('input',{name:'naturaIva',value:form.naturaIva||'',onChange:onChange})),

            e('div',{style:{gridColumn:'1/-1'}}, e('label',null,'Causale'), e('input',{name:'causale',value:form.causale||'',onChange:onChange})),

            e('div',null, e('label',null,'Rif. DDT (facoltativo)'), e('input',{name:'ddtId',value:form.ddtId||'',onChange:onChange})),
            e('div',null, e('label',null,'Data DDT'), e('input',{type:'date', name:'ddtData',value:form.ddtData||'',onChange:onChange})),

            e('div',{style:{gridColumn:'1/-1'}}, e('label',null,'Note (solo stampa di cortesia)'), e('textarea',{name:'note',value:form.note||'',onChange:onChange}))
          ),

          // RIGHE
e('div',{className:'card',style:{marginTop:8,overflowX:'auto'}},
  e('table',{className:'table'},
    e('thead',null,
      e('tr',null,
        e('th',{style:{width:28}},'#'),
        e('th',null,'Descrizione'),
        e('th',{style:{width:60}},'UM'),
        e('th',{style:{width:80}},'Q.tà'),
        e('th',{style:{width:100}},'Prezzo un.'),
        e('th',{style:{width:80}},'IVA'),               // << aggiunta
        e('th',{style:{width:120}},'Natura'),           // << aggiunta
        e('th',{style:{width:90}},'Sconto %'),
        e('th',{style:{width:110}},'Importo'),
        e('th',{style:{width:60}},'')
      )
    ),
    e('tbody',null,
      (form.righe||[]).map((r,i)=> e('tr',{key:i},
        e('td',{style:{textAlign:'center'}}, String(i+1)),
        e('td',null,
          e('input',{value:r.descrizione||'', onChange:ev=>updRiga(i,{descrizione:ev.target.value})})
        ),
        e('td',{style:{textAlign:'center'}},
          e('input',{value:r.UM||'PZ', onChange:ev=>updRiga(i,{UM:ev.target.value})})
        ),
        e('td',{style:{textAlign:'center'}},
          e('input',{type:'number', step:'any', value:r.qta||'', onChange:ev=>updRiga(i,{qta:ev.target.value})})
        ),
        e('td',{style:{textAlign:'right'}},
          e('input',{type:'number', step:'any', value:r.prezzo||'', onChange:ev=>updRiga(i,{prezzo:ev.target.value})})
        ),
        // IVA (nuova colonna)
        e('td',{style:{textAlign:'center'}},
          e('input',{
            type:'number', step:'0.01',
            value: (r.iva ?? ''),
            onChange: ev=>{
              const v = Number(ev.target.value||0);
              updRiga(i,{ iva: v });
            }
          })
        ),
        // Natura (nuova colonna)
        e('td',null,
          e('select',{
            value: r.natura || '',
            onChange: ev=> updRiga(i,{ natura: ev.target.value || '' })
          },
            e('option',{value:''},'—'),
            e('option',{value:'N1'},  'N1 escl. art.15'),
            e('option',{value:'N2.1'},'N2.1 non sogg. art.7-7septies'),
            e('option',{value:'N2.2'},'N2.2 non sogg. altre norme'),
            e('option',{value:'N3.1'},'N3.1 non impon. esportaz.'),
            e('option',{value:'N3.2'},'N3.2 cessioni intracom.'),
            e('option',{value:'N3.3'},'N3.3 cessioni a San Marino'),
            e('option',{value:'N3.4'},'N3.4 operaz. assimilate'),
            e('option',{value:'N3.5'},'N3.5 dichiaraz. intento'),
            e('option',{value:'N3.6'},'N3.6 altre non impon.'),
            e('option',{value:'N4'},  'N4 esenti'),
            e('option',{value:'N5'},  'N5 regimi particolari'),
            e('option',{value:'N6.1'},'N6.1 reverse rottami'),
            e('option',{value:'N6.2'},'N6.2 reverse oro/argento'),
            e('option',{value:'N6.3'},'N6.3 reverse subappalto edil.'),
            e('option',{value:'N6.4'},'N6.4 reverse edifici/energia'),
            e('option',{value:'N6.5'},'N6.5 reverse telefonia'),
            e('option',{value:'N6.6'},'N6.6 reverse elettronica'),
            e('option',{value:'N6.7'},'N6.7 reverse settori partic.'),
            e('option',{value:'N6.8'},'N6.8 reverse costruzioni'),
            e('option',{value:'N6.9'},'N6.9 reverse altri casi'),
            e('option',{value:'N7'},  'N7 IVA assolta in altro Stato')
          )
        ),
        e('td',{style:{textAlign:'center'}},
          e('input',{
            type:'number', step:'any',
            value: (r.sconto ?? r.scontoPerc ?? ''),
            onChange:ev=>updRiga(i,{sconto:ev.target.value})
          })
        ),
        e('td',{style:{textAlign:'right'}},
          (function(){
            const qty=+r.qta||0, pr=+r.prezzo||0, sc=(+r.sconto||+r.scontoPerc||0);
            return fmt2(qty*pr*(1-sc/100)); // importo riga = imponibile
          })()
        ),
               e('td',{style:{textAlign:'center', whiteSpace:'nowrap'}},
                e('button',{type:'button',className:'btn btn-outline',style:{marginRight:6},onClick:()=>{ try{ window.riceviRigaOF ? window.riceviRigaOF(form, i) : window.openRicezioneOF && window.openRicezioneOF(form); }catch(e){ alert('Ricezione non disponibile'); } }},'⬇️ Ricevi'),
                e('button',{type:'button',className:'btn btn-outline',onClick:()=>remRiga(i)},'🗑')
              )
      ))
    )
  ),
  e('div',{className:'actions',style:{justifyContent:'flex-end'}},
    e('button',{type:'button',className:'btn btn-outline',onClick:addRiga},'➕ Aggiungi riga')
  )
)
), // fine fieldset


        // Totali + azioni (fuori dal fieldset)
        e('div', {className:'actions', style:{justifyContent:'space-between',gap:8}},
          e('div', null,
            e('span', null, `Imponibile: ${fmt2(formTotals.imponibile)}  —  IVA: ${fmt2(formTotals.imposta)}  —  Totale: ${fmt2(formTotals.totale)}`)
          ),
          e('div', null,
            e('button', { type:'button', className:'btn btn-outline',onClick:()=>{ setShowForm(false); setEditingId(null); } }, 'Annulla'), ' ',
              e('button', {type:'button',className:'btn btn-outline',title:'Anteprima/Stampa',
                onClick:()=>{ try{window.printFattura && window.printFattura({ ...form, id: (editingId ? form.id : '(bozza)') });}catch(e){} }}, '🖨️ Stampa'), ' ',
            (function()
              {const faObj = { ...form, id: (editingId ? form.id : '(bozza)') };
              let ok=true, tip='Esporta XML FatturaPA';
            try{
              const res = window.canExportFatturaPA ? window.canExportFatturaPA(faObj) : {ok:true,reasons:[]};
              ok = !!res.ok; if(!ok) tip = 'Impossibile esportare: ' + res.reasons.join(' · ');
            }catch{}
            return 
            e('button',{type:'button',className:'btn btn-outline',title: tip,disabled: !ok,onClick:()=>{ if(ok) try{ window.exportFatturaPAXML && window.exportFatturaPAXML(faObj); }catch(e){} }}, 'XML FatturaPA');})(),' ',
            e('button', { type:'submit', className:'btn', disabled: readOnly, title: readOnly ? 'Sola lettura' : '' }, 'Salva')
          )
        )
      )
    );
  }

  // export & route
  global.FattureView = FattureView;
  global.ROUTES = global.ROUTES || {};
  global.ROUTES['#/fatture'] = global.FattureView;
  global.ROUTES['#/Fatture'] = global.FattureView;
})(window);


// ===== Stampa Fattura aggiornata =====
(function (global) {
  const esc = s => String(s==null?'':s).replace(/[<>&]/g, c=>({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c]));
  const fmt2 = n => Number(n||0).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2});
            
  window.printFattura = function printFattura(fa){
    
    try{
      const app  = (function(){ try{ return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; }catch{return{}} })();
      const logo = app.logoDataUrl || '';
      const clienti = (function(){ try{ return JSON.parse(localStorage.getItem('clientiRows')||'[]')||[]; }catch{return[]} })();
      const cli = clienti.find(c=> String(c.id)===String(fa.clienteId)) || null;

      const ragAzi  = esc(app.ragioneSociale||'');
      const pivaAzi = esc(app.piva||app.pIva||'');
      const sedeLeg  = esc(app.sedeLegale || app.companyLegal || '');
      const sedeOp   = esc(app.sedeOperativa || app.companyOperational || '');
      const emailAzi = esc(app.email || '');
      const pecAzi   = esc(app.pec   || '');
      const telAzi   = esc(app.telefono || '');


      const sedeOpe = esc(app.sedeOperativa||'');
      const emailAz = esc(app.email||'');
      const telAz   = esc(app.telefono||'');
      const rea     = esc(app.rea || '');
      const capSoc  = esc(app.capitaleSociale || '');
      const sdi     = esc(app.codiceSDI || app.sdi || '');

      const bancaInt = esc(app.bancaIntestatario || '');
      const bancaIstit = esc(app.bancaIstituto || '');
      const bancaIban = esc(app.bancaIban || '');
      const bancaBic  = esc(app.bancaBicSwift || app.bicswift || '');

      const cliRag   = esc(fa.cliente || cli?.ragione || cli?.ragioneSociale || cli?.denominazione || cli?.nome || '');
      const cliPiva  = esc(cli?.piva || cli?.pIva || '');
      const cliInd   = esc(cli?.indirizzo || cli?.sedeOperativa || cli?.sedeLegale || '');
      const cliEmail = esc(cli?.email || '');
      const cliTel   = esc(cli?.telefono || '');

      const causale  = esc(fa.causale || '');
      const ddtId    = esc(fa.ddtId || '');
      const ddtData  = esc(fa.ddtData || '');

      // Righe + totali per aliquota (con sconto)
      const righe = Array.isArray(fa.righe) ? fa.righe : [];
      const ivaMap = {}; // {aliq: imponibile}
      let imponibile=0, imposta=0;

      const righeHTML = righe.map((r,i)=>{
        const qty = Number(r.qta||0);
        const pr  = Number(r.prezzo||0);
        const sc  = Number(r.sconto||r.scontoPerc||0);
        const iva = Number(r.iva||0);
        const base = qty*pr*(1 - (sc/100));
        imponibile += base;
        imposta    += base * iva/100;
        ivaMap[iva] = (ivaMap[iva]||0) + base;

        const desc = esc(r.descrizione||'').replace(/\n/g,'<br>');
        const um   = esc(r.UM||r.um||'');
        const ddtRef = (r.ddtId || ddtId) ? `<div class="muted small">Rif. DDT ${esc(r.ddtId||ddtId)}${(r.ddtData||ddtData)?(' del '+esc(r.ddtData||ddtData)) : ''}</div>` : '';

        return `<tr>
          <td class="ctr">${i+1}</td>
          <td>${desc}${ddtRef}</td>
          <td class="ctr">${um||''}</td>
          <td class="ctr">${qty||''}</td>
          <td class="num">${fmt2(pr)}</td>
          <td class="ctr">${(sc? fmt2(sc) : '')}</td>
          <td class="num">${fmt2(base)}</td>
        </tr>`;
      }).join('');

      const totale = imponibile + imposta;

      // Riepilogo IVA
      const ivaRows = Object.keys(ivaMap).sort((a,b)=>Number(a)-Number(b)).map(k=>{
        const aliq = Number(k||0);
        const impB = ivaMap[k]||0;
        const impI = impB*aliq/100;
        const aliqLbl = (aliq>0) ? (aliq.toFixed(0)+'%')
                       : (fa.plafond ? 'Plafond (art. 8 DPR 633/72)' : '0%');
        return `<tr>
          <td class="ctr">${aliqLbl}</td>
          <td class="num">${fmt2(impB)}</td>
          <td class="num">${fmt2(impI)}</td>
        </tr>`;
      }).join('') || `<tr><td class="ctr">${fa.plafond ? 'Plafond (art. 8 DPR 633/72)' : '—'}</td><td class="num">0,00</td><td class="num">0,00</td></tr>`;

      const css = `<style>
        @page { size: A4; margin: 10mm 8mm; }
        * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        html,body{margin:0;padding:0}
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;color:#0f172a;font-size:12px}
        .muted{color:#64748b}
        .small{font-size:11px}
        .doc-title{font-size:20px;font-weight:700;letter-spacing:.3px}
        .hdr{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:6px 0 8px;border-bottom:2px solid #111}
        .content{ margin-top: 6mm; }
        .idbox{border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;min-width:210px}
        .box{border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px}
        .logo{ height:80px; max-height:80px; object-fit:contain }
        .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}
        table{width:100%;border-collapse:collapse;margin-top:8px}
        thead{display:table-header-group}
        th,td{border:1px solid #e2e8f0;padding:6px;vertical-align:top}
        th{background:#f8fafc}
        @media screen {
          th,td{ border-color: transparent; }
        }
        @media print {
          th,td{ border:1px solid #e5e7eb; }
        }
                .ctr{text-align:center}
        .num{text-align:right}
        tr{page-break-inside:avoid}

        .footer{
          position:fixed;
          left:8mm;
          right:8mm;
          bottom:20mm;                       /* totali un po' sopra il bordo */
          display:grid;
          grid-template-columns:1fr 280px;
          gap:10px;
        }
        /* Spazio utile per il numeratore in basso a destra */
        .content{ margin-bottom: 30mm; }
        .bank{margin-top:6px}

        .pagebox{
          position:fixed;
          right:8mm;
          bottom:8mm;                        /* numero pagina sotto al footer */
          font-size:12px;
        }
        .pageX[data-mode="css"]::after{content: counter(page)}
        @media screen { th,td{ border-color: transparent } }
        @media print  { th,td{ border:1px solid #e5e7eb } }
      </style>`;

      const html = `<!doctype html><html><head><meta charset="utf-8">${css}</head><body>

        <div class="hdr">
          <div style="display:flex;align-items:center;gap:12px">
            ${logo ? `<img src="${logo}" class="logo">` : ``}
            <div>
              <div class="doc-title">${ragAzi}</div>
              <div class="muted small">${[pivaAzi && 'P.IVA '+pivaAzi, sdi && ('SDI '+sdi)].filter(Boolean).join(' · ')}</div>
              <div class="muted small">${[sedeLeg && ('Sede legale: '+sedeLeg), sedeOpe && ('Sede operativa: '+sedeOpe)].filter(Boolean).join(' · ')}</div>
              <div class="muted small">${[emailAz, telAz].filter(Boolean).join(' · ')}</div>
              ${ (rea||capSoc) ? `<div class="muted small">${[rea && ('REA: '+rea), capSoc && ('Cap. soc.: '+capSoc)].filter(Boolean).join(' · ')}</div>` : '' }
            </div>
          </div>
          <div class="idbox">
            <div><strong>FATTURA</strong></div>
            <div><strong>${esc(fa.id||'')}</strong></div>
            <div>Data: <strong>${esc(fa.data||'')}</strong></div>
          </div>
        </div>
        <div class="grid2">
          <div class="box">
            <div class="muted">Cliente</div>
            <div><strong>${cliRag}</strong></div>
            ${cliInd   ? `<div class="small">${cliInd}</div>` : ''}
            ${cliPiva  ? `<div class="muted small">P.IVA: ${cliPiva}</div>` : ''}
            ${ (cliEmail||cliTel) ? `<div class="muted small">${[cliEmail,cliTel].filter(Boolean).join(' · ')}</div>` : '' }
            <div class="small">Pagamento: <strong>${esc(fa.pagamento||'')}</strong></div>
          </div>
        </div>

        ${causale ? `<div class="box"><strong>Causale:</strong> ${causale}</div>` : ''}

        <table>
          <thead><tr>
            <th style="width:28px" class="ctr">#</th>
            <th>Descrizione</th>
            <th style="width:60px" class="ctr">UM</th>
            <th style="width:70px" class="ctr">Q.tà</th>
            <th style="width:100px" class="num">Prezzo un.</th>
            <th style="width:80px" class="ctr">Sconto %</th>
            <th style="width:110px" class="num">Importo</th>
          </tr></thead>
          <tbody>${righeHTML || `<tr><td colspan="7" class="muted">Nessuna riga</td></tr>`}</tbody>
        </table>

        <div class="footer">
          <div class="box">
            <div style="font-weight:600; margin-bottom:6px">Riepilogo IVA</div>
            <table style="width:100%; border-collapse:collapse">
              <thead><tr>
                <th class="ctr" style="width:140px">Aliquota</th>
                <th class="num">Imponibile</th>
                <th class="num">Imposta</th>
              </tr></thead>
              <tbody>${ivaRows}</tbody>
            </table>

            ${(fa.note||'').trim() ? `<div class="muted small" style="margin-top:8px">Note: ${esc(fa.note).replace(/\n/g,' ')}</div>` : ''}

            <div class="bank">
              <div style="font-weight:600; margin-bottom:4px">Dati pagamento</div>
              <div class="small">${['Intestatario: '+bancaInt, bancaIstit && ('Banca: '+bancaIstit), bancaIban && ('IBAN: '+bancaIban), bancaBic && ('BIC/SWIFT: '+bancaBic)]
                .filter(s=>s && !/:\s*$/.test(s.replace(/\s+/g,''))).map(esc).join('<br>')}</div>
            </div>
          </div>

          <div class="box">
            <div>Imponibile: <span style="float:right">${fmt2(imponibile)}</span></div>
            <div>Imposta IVA: <span style="float:right">${fmt2(imposta)}</span></div>
            <div style="border-top:1px solid #cbd5e1;margin-top:6px;padding-top:6px">
              <strong>Totale: <span style="float:right">${fmt2(totale)}</span></strong>
            </div>
          </div>
          <div id="pagebox" class="pagebox">Pag. <span class="pageNum" data-mode="css"></span></div>
        </div>

      </body></html>`;

      if (window.safePrintHTMLStringWithPageNum) window.safePrintHTMLStringWithPageNum(html);
      else (window.safePrintHTMLStringWithPageNum
        ? window.safePrintHTMLStringWithPageNum(html)
        : (global.safePrintHTMLString ? global.safePrintHTMLString(html) : window.safePrintHTMLString(html)));

    }catch(e){
      alert('Errore Fattura: ' + (e?.message || e));
    }
  };
})(window);


// ============= STAMPA FATTURA (A4) — globale =============

// ===== THEME STAMPA UNICO (A4) =====
(function(){
  // CSS comune per DDT / Fatture / Ordini Fornitore
  window.__PRINT_CSS = window.__PRINT_CSS || function(opts = {}){
    const top = Number(opts.top ?? 10);
    const right = Number(opts.right ?? 8);
    const bottom = Number(opts.bottom ?? 10);
    const left = Number(opts.left ?? 8);
    // NB: .pageNum::after neutralizzato: numerazione sempre via JS
    return (
      '<style>'
      + '@page{size:A4;margin:'+top+'mm '+right+'mm '+bottom+'mm '+left+'mm}'
      + '*{-webkit-print-color-adjust:exact;print-color-adjust:exact}'
      + 'html,body{margin:0;padding:0;height:100%}'
      + 'body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;color:#0f172a;font-size:13px}'
      + '.content{position:relative}'
      + 'img{max-width:100%;height:auto}'
      + 'table{width:100%;border-collapse:collapse;margin-top:8px;page-break-inside:auto}'
      + 'thead{display:table-header-group}'
      + 'tfoot{display:table-footer-group}'
      + 'th,td{border:1px solid #e5e7eb;padding:6px;vertical-align:top;font-size:13px}'
      + '.ctr{text-align:center}.num{text-align:right}.small{font-size:12px}.muted{color:#64748b}'
      + '.pagebox{position:fixed;right:'+right+'mm;bottom:'+bottom+'mm;font-size:12px;z-index:999;min-width:68px;text-align:right}'
      + '.pageNum::after,.pageX::after{content:"" !important}'
      + '@media screen{th,td{border-color:transparent}}'
      + '</style>'
    );
  };
})();

(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;


  // helper stampa in iframe (riutilizzabile da DDT)
  if (!window.safePrintHTMLString) {
    window.safePrintHTMLString = function(html){
      try{
        var ifr = document.createElement('iframe');
        ifr.style.width = ifr.style.height = 0;
        ifr.style.border = 0;
        document.body.appendChild(ifr);
        var d = ifr.contentWindow.document;
        d.open(); d.write(html); d.close();
        // Fallback numerazione pagina (come DDT)
        try{
          (function(){
            const w = ifr.contentWindow, doc = w.document;
            const pn = doc.querySelector('#pagebox .pageNum') || doc.querySelector('.pageNum');
            if (!pn) return;
                 pn.setAttribute('data-mode','css');
            const pseudo = w.getComputedStyle(pn,'::after').getPropertyValue('content') || '';
           const bad = (!pseudo || !/\d/.test(pseudo));
            if (bad){
             const mmToPx = (function(){
                const t = doc.createElement('div'); t.style.height='100mm'; t.style.position='absolute'; t.style.visibility='hidden';
                doc.body.appendChild(t); const px=t.getBoundingClientRect().height||0; t.remove();
                return px/100;
              })();
              const pageHeightMm = 297 - (16 + 22);
              const pageHeightPx = (mmToPx>0) ? (mmToPx * pageHeightMm) : (w.innerHeight || 1123);
              const content = doc.querySelector('.content') || doc.body;
              const h = Math.max(content.scrollHeight, content.offsetHeight, doc.body.scrollHeight);
              const total = Math.max(1, Math.ceil(h / pageHeightPx));
              pn.textContent = `1 / ${total}`;
            }
         })();
        }catch{}

        setTimeout(function(){
          try{ if (ifr.contentWindow){ ifr.contentWindow.focus(); ifr.contentWindow.print(); } }catch{}
          setTimeout(function(){ try{ ifr.remove(); }catch{} }, 350);
        }, 150);
      }catch(e){ alert('Errore stampa: ' + (e?.message || e)); }
    };
  }

  function esc(s){ return String(s==null?'':s).replace(/[<>&]/g, c=>({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c])); }
  function fmt2(n){ n=Number(n||0); return n.toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2}); }

  // Prova a ricavare un rif. DDT globale da fa.note (prefill standard "Rif. DDT XXX")
  function parseDDTRefFromNote(note){
    const m = /Rif\.?\s*DDT\s*([A-Za-z0-9\-_/]+)/i.exec(String(note||''));
    return m ? m[1] : '';
  }

  window.__printFatturaLegacy = function(fa){
    try{
      // ---- app settings (logo, intestazione, bancari) ----
      var app = {};
      try { app = JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; } catch {}
      var logo  = app.logoDataUrl || '';
      var rag   = app.ragioneSociale || '';
      var piva  = app.piva || app.pIva || '';
      var sedeL = app.sedeLegale || '';
      var sedeO = app.sedeOperativa || '';
      var email = app.email || '';
      var tel   = app.telefono || '';
      var rea   = app.rea || '';
      var cap   = app.capitaleSociale || app.capitale || '';
      var sdi   = app.sdi || app.codiceSdi || '';
      var bank  = app.bankName || '';
      var holder= app.bankHolder || '';
      var iban  = app.iban || '';
      var bic   = app.bic || '';

      // ---- Cliente (stampa cortesia) ----
      // se in anagrafica: P.IVA, indirizzo, mail e telefono
      var cliAll = [];
      try { cliAll = JSON.parse(localStorage.getItem('clientiRows')||'[]')||[]; } catch {}
      var cli = cliAll.find(c=> String(c.id)===String(fa.clienteId||'')) || {};
      var cliPiva = cli.piva || cli.pIva || '';
      var cliAddr = cli.indirizzo || cli.sedeOperativa || cli.sedeLegale || '';
      var cliMail = cli.email || '';
      var cliTel  = cli.telefono || '';

      // ---- righe + totali per aliquota ----
      var righe = Array.isArray(fa.righe) ? fa.righe : [];
      var ivaMap = {}; // {aliquota: imponibile}
      var imponibile=0, imposta=0;

      // rif DDT (globale) se non è presente per singola riga
      var ddtRefGlobal = parseDDTRefFromNote(fa.note);

      var righeHTML = righe.map(function(r, i){
        var q   = Number(r.qta||0);
        var pu  = Number(r.prezzo||0);
        var iva = Number(r.iva||0);
        var scp = Number(r.scontoPerc||r.sconto||0); // % opzionale
        if (!isFinite(scp)) scp = 0;
        var impon = q * pu * (1 - scp/100);
        imponibile += impon;
        imposta    += impon * iva/100;
        ivaMap[iva] = (ivaMap[iva]||0) + impon;

        // rif DDT per riga: usa r.ddtId/r.ddtRef/r.ddtData se presenti, altrimenti globale
        var ddtRiga = r.ddtId || r.ddtRef || ddtRefGlobal || '';
        var ddtData = r.ddtData || '';

        // descrizione + eventuale riga “rif. DDT …” sotto
        var descrBlock = esc(r.descrizione||'');
        if (ddtRiga) {
          descrBlock += '<div class="muted small">Rif. DDT: ' + esc(ddtRiga) + (ddtData ? (' del ' + esc(ddtData)) : '') + '</div>';
        }

        return (
          '<tr>'
          + '<td class="ctr">'+(i+1)+'</td>'
          + '<td>'+ descrBlock +'</td>'
          + '<td class="ctr">'+esc(r.UM||r.um||'')+'</td>'
          + '<td class="ctr">'+(q||'')+'</td>'
          + '<td class="num">'+fmt2(pu)+'</td>'
          + '<td class="ctr">'+(scp? fmt2(scp).replace(',00','') : '')+'</td>'
          + '<td class="num">'+fmt2(impon)+'</td>'
          + '</tr>'
        );
      }).join('');

      if (!righeHTML) {
        righeHTML = '<tr><td colspan="7" class="muted">— Nessuna riga —</td></tr>';
      }

      var totale = imponibile + imposta;

      // Riepilogo IVA (sempre visibile)
      var ivaRows = Object.keys(ivaMap).map(function(k){
        var aliq = Number(k||0);
        var base = ivaMap[k]||0;
        var imp  = base*aliq/100;
        return '<tr>'
          + '<td class="ctr">'+ (aliq===0 ? 'Esente/0%' : (aliq + '%')) +'</td>'
          + '<td class="num">'+fmt2(base)+'</td>'
          + '<td class="num">'+fmt2(imp)+'</td>'
          + '</tr>';
      }).join('');
      if (!ivaRows) ivaRows = '<tr><td class="ctr">—</td><td class="num">0,00</td><td class="num">0,00</td></tr>';

      // Nota plafond: sotto “Aliquota”, scriviamo la dicitura legale al posto della % quando aliq=0
      // (la riga sopra già mostra “Esente/0%”; se vuoi il testo normativo pieno sostituisci qui).
      // Esempio comune per plafond: “N3.5 – Operazioni non imponibili a seguito di dichiarazione d’intento (art. 8, c. 1, lett. c, DPR 633/72)”
      var naturaText = (fa.plafond && (fa.naturaIva || 'N3.5 – Operazioni non imponibili a seguito di dichiarazione d’intento (art. 8, c.1, lett. c, DPR 633/72)')) || '';

      // CSS + HTML
      var css = window.__PRINT_CSS({ top:10, right:8, bottom:8, left:8 });

      css += `<style>
  /* Header: permetti wrap e riduci logo */
  .hdr{display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap}
  .brand{display:flex; align-items:center; gap:10px; flex:1 1 auto}
  .brand .logo{max-height:90px; width:auto; object-fit:contain}
  .doc{border:1px solid #cbd5e1; border-radius:10px; padding:10px 12px; min-width:240px; text-align:right} /* prima 210px */
  .az .muted{color:#64748b}

  /* Tabelle e box come prima */
  .box{border:1px solid #cbd5e1;border-radius:8px;padding:8px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}
  .totgrid{display:grid;grid-template-columns:1fr 260px;gap:10px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  thead{display:table-header-group}
  th,td{border:1px solid #e5e7eb;padding:6px;vertical-align:top}
  th{background:#f8fafc}.ctr{text-align:center}.num{text-align:right}

  /* Footer: numeratore dentro il footer, non flottante */
    .footer{
    position:fixed;
    left:8mm;
    right:8mm;
    bottom:6mm;                 /* un filo più giù (prima era 8mm) */
    display:flex;
    justify-content:space-between;
    align-items:flex-start;
    gap:10mm;                   /* spazio tra blocco totali e blocco banca */
  }
  .footer .pagebox{position:static; margin-left:auto; font-weight:700}
  .hdr img.logo{max-height:90px !important;width:auto;object-fit:contain;}
</style>`;


      var header =
        '<div class="hdr">'
          + '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">'
            + (logo ? '<img class="logo" src="'+logo+'" alt="logo">' : '')
            + '<div>'
              + '<div style="font-size:20px;font-weight:800">'+esc(rag)+'</div>'
              + (piva ? '<div class="small">P.IVA: '+esc(piva)+'</div>' : '')
              + (sedeL ? '<div class="small">'+esc(sedeL)+'</div>' : '')
              + (sedeO ? '<div class="small">'+esc(sedeO)+'</div>' : '')
              + (sdi   ? '<div class="small">Codice SDI: '+esc(sdi)+'</div>' : '')
              + (rea   ? '<div class="small">REA: '+esc(rea)+'</div>' : '')
              + (cap   ? '<div class="small">Capitale Sociale: '+esc(cap)+'</div>' : '')
            + '</div>'
          + '</div>'
          + '<div class="idbox">'
            + '<div><strong>FATTURA</strong></div>'
            + '<div><strong>'+esc(fa.id||'')+'</strong></div>'
            + '<div>Data: <strong>'+esc(fa.data||'')+'</strong></div>'
          + '</div>'
        + '</div>';

      var clienteBox =
        '<div class="grid2">'
          + '<div class="box">'
            + '<div class="muted">Cliente</div>'
            + '<div><strong>'+esc(fa.cliente||'')+'</strong></div>'
            + (cliPiva ? '<div class="small">P.IVA: '+esc(cliPiva)+'</div>' : '')
            + (cliAddr ? '<div class="small">'+esc(cliAddr)+'</div>' : '')
            + (cliMail ? '<div class="small">'+esc(cliMail)+'</div>' : '')
            + (cliTel  ? '<div class="small">'+esc(cliTel)+'</div>' : '')
          + '</div>'
          + '<div class="box">'
            + (fa.pagamento ? '<div>Pagamento: <strong>'+esc(fa.pagamento)+'</strong></div>' : '')
            + (fa.iban ? '<div>IBAN: <strong>'+esc(fa.iban)+'</strong></div>' : '')
            + (fa.codiceUnivoco ? '<div class="small">CUU/SDI cliente: '+esc(fa.codiceUnivoco)+'</div>' : '')
            + (fa.pec ? '<div class="small">PEC cliente: '+esc(fa.pec)+'</div>' : '')
            + (fa.plafond && naturaText ? '<div class="small muted" style="margin-top:4px">Natura IVA: '+esc(naturaText)+'</div>' : '')
          + '</div>'
        + '</div>';

      var causaleBlock = (fa.causale ? ('<div class="box small" style="margin:8px 0 4px 0"><strong>Causale: </strong>'+esc(fa.causale)+'</div>') : '');

      var table =
        '<table>'
          + '<thead><tr>'
            + '<th style="width:28px" class="ctr">#</th>'
            + '<th>Descrizione</th>'
            + '<th style="width:56px" class="ctr">UM</th>'
            + '<th style="width:70px" class="ctr">Q.tà</th>'
            + '<th style="width:100px" class="num">Prezzo un.</th>'
            + '<th style="width:80px" class="ctr">Sconto %</th>'
            + '<th style="width:110px" class="num">Importo</th>'
          + '</tr></thead>'
          + '<tbody>'+righeHTML+'</tbody>'
        + '</table>';

      var footer =
        '<div class="footer">'
          + '<div class="totgrid">'
            + '<div class="box">'
              + '<div style="font-weight:600;margin-bottom:6px">Riepilogo IVA</div>'
              + '<table style="width:100%;border-collapse:collapse">'
                + '<thead><tr>'
                  + '<th class="ctr" style="width:90px">Aliquota</th>'
                  + '<th>Imponibile</th>'
                  + '<th>Imposta</th>'
                + '</tr></thead>'
                + '<tbody>'+ivaRows+'</tbody>'
              + '</table>'
              + (fa.plafond && naturaText ? '<div class="small muted" style="margin-top:6px">'+esc(naturaText)+'</div>' : '')
            + '</div>'
            + '<div class="box">'
              + '<div>Imponibile: <span style="float:right">'+fmt2(imponibile)+'</span></div>'
              + '<div>Imposta IVA: <span style="float:right">'+fmt2(imposta)+'</span></div>'
              + '<div style="border-top:1px solid #cbd5e1;margin-top:6px;padding-top:6px">'
                + '<strong>Totale: <span style="float:right">'+fmt2(totale)+'</span></strong>'
              + '</div>'
            + '</div>'
          + '</div>'
          + (
            (bank || holder || iban || bic)
                ? '<div class="small" style="margin-top:8px; padding-left:4mm">'
                + (bank ? '<div>Banca: <strong>'+esc(bank)+'</strong></div>' : '')
                + (holder ? '<div>Intestatario: <strong>'+esc(holder)+'</strong></div>' : '')
                + (iban ? '<div>IBAN: <strong>'+esc(iban)+'</strong></div>' : '')
                + (bic ? '<div>BIC/SWIFT: <strong>'+esc(bic)+'</strong></div>' : '')
                + '</div>'
              : ''
            )
        + '</div>';

      // aggiungo una piccola regola per il wrapper .content
      css += '<style>.content{position:relative}.pageNum::after,.pageX::after{content:"" !important}</style>';

      var html = '<!doctype html><html><head><meta charset="utf-8">'+css+'</head><body>'
        + '<div class="content">'     // <-- WRAPPER MISURABILE
        +   header
        +   clienteBox 
        +   causaleBlock
        +   table
        + '</div>'                     // <-- FINE WRAPPER
        + footer
        + '</body></html>';

        if (window.safePrintHTMLStringWithPageNum) {
          window.safePrintHTMLStringWithPageNum(html);
        } else if (window.safePrintHTMLString) {
          window.safePrintHTMLString(html);
        }

      }catch(e){
      alert('Errore Fattura: ' + (e?.message || e));
    }
  };

})(); 

// === PATCH B2 — shim printFattura (se mancasse) ===
(function(){
  if (typeof window.printFattura !== 'function' && typeof window.generateFatturaHTML === 'function') {
    window.printFattura = function(fa){
      try {
        const html = window.generateFatturaHTML(fa);
        if (!html) throw new Error('generateFatturaHTML ha restituito stringa vuota');
        (window.safePrintHTMLStringWithPageNum || window.safePrintHTMLString)(html);
      } catch(e) { alert('Errore stampa Fattura: ' + (e?.message || e)); }
    };
  }
})();

/* ================== MODAL: Ricevi da Ordine Fornitore ================== */
function RiceviDaOrdineModal({ ordine, riga, onClose, onConfirm }) {
  const e = React.createElement;
  const [qta, setQta] = React.useState(() => Math.max(0, Number(riga.qta || 0) - Number(riga.qtaRicevuta||0)));
  const [data, setData] = React.useState(()=> new Date().toISOString().slice(0,10));
  const [ddt, setDDT] = React.useState('');
  const [note, setNote] = React.useState('');
  const [updCMP, setUpdCMP] = React.useState(()=>{
  try { return !!(JSON.parse(localStorage.getItem('appSettings')||'{}')||{}).magUpdateCMP; }
  catch { return false; }
  });


  const residuo = Math.max(0, Number(riga.qta||0) - Number(riga.qtaRicevuta||0));
  const max = residuo;

  return e('div', { className:'modal-backdrop' },
    e('div', { className:'modal-card' },
      e('h3', null, `Ricezione — ${riga.codice||''}`),
      e('div', { className:'row', style:{gap:8} },
        e('div', null, `Ordinato: ${riga.qta||0}`),
        e('div', null, `Ricevuto: ${riga.qtaRicevuta||0}`),
        e('div', null, `Residuo: ${residuo}`)
      ),
      e('div', { className:'row', style:{gap:8, marginTop:8} },
        e('label', null, 'Data: ',
          e('input', { type:'date', value:data, onChange:ev=>setData(ev.target.value) })
        ),
        e('label', null, 'DDT fornitore: ',
          e('input', { value:ddt, onChange:ev=>setDDT(ev.target.value), placeholder:'n./data DDT' })
        ),
        e('label', null, 'Qta da ricevere: ',
          e('input', {
            type:'number', step:'0.01', min:0, max,
            value:qta, onChange:ev=>setQta(Math.max(0, Math.min(max, Number(ev.target.value))))
          })
        ),
        e('label', null,
          e('input', { type:'checkbox', checked:updCMP, onChange:ev=>setUpdCMP(ev.target.checked) }),
          ' Aggiorna CMP'
        )
      ),
      e('div', { className:'row', style:{gap:8, marginTop:12, justifyContent:'flex-end'} },
        e('button', { className:'btn', onClick:onClose }, 'Annulla'),
        e('button', {
          className:'btn btn-primary',
          onClick:()=> onConfirm({ qta, data, ddtFornitore: ddt, note, updateCMP: updCMP })
        }, 'Conferma')
      )
    )
  );
}

/* ================== ORDINI FORNITORI (OF-YYYY-NNN) — con RICEZIONE ================== */
function OrdiniFornitoriView({ query = '' }) {
  const e = React.createElement;

    const PAGAMENTI_FORNITORE = [
    'Bonifico vista fattura',
    'Bonifico 30gg FM',
    'Bonifico 60gg FM',
    'RiBa 30gg',
    'RiBa 30-60gg',
    'RiBa 30-60-90gg',
    'RiBa 60gg'
  ];

    // === CHIAVI ===
// === CHIAVE ORDINI FORNITORE (globale, anti-duplicato) ===
const ORD_KEY = window.__OF_KEY || (window.__OF_KEY = 'ordiniFornitoriRows');


// Alias da chiavi storiche → chiave attuale (una tantum)
(function aliasOldKeys(){
  try{
    const prev = JSON.parse(localStorage.getItem('ordiniRows') || 'null');
    if (Array.isArray(prev) && !localStorage.getItem(ORD_KEY)) {
      localStorage.setItem(ORD_KEY, JSON.stringify(prev));
    }
  }catch{}
})();

  const user = window.__currentUser || null;
  const readOnly = !!(user && user.role === 'accountant');

  // Helpers
  const lsGet = window.lsGet || ((k,d)=>{ try{const v=JSON.parse(localStorage.getItem(k)); return (v??d);}catch{return d;}});
  const lsSet = window.lsSet || ((k,v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} });
  const formatNNN = window.formatNNN || (n=>String(n).padStart(3,'0'));
  const nextProgressivo = window.nextProgressivo;
  const { MAG_MOV_KEY, ART_KEY } = (window.__MAG_KEYS__||{MAG_MOV_KEY:'magMovimenti', ART_KEY:'magazzinoArticoli'});
    // Default IVA per ordini (legge dalle impostazioni, fallback 22%)
  const appSettings = lsGet('appSettings', {}) || {};
  const DEFAULT_IVA = Number(appSettings.defaultIva) || 22;


  window.nextIdOrdine = window.nextIdOrdine || function(){
  const np = (window.nextProgressivo && window.nextProgressivo('ofr')) 
             || {year:new Date().getFullYear(), num:1};
  const n3 = (window.formatNNN? window.formatNNN(np.num): String(np.num).padStart(3,'0'));
  return `OF-${np.year}-${n3}`;
  };

  // Storage keys
  const FORN_KEY = 'fornitoriRows';
  const ARTK = ART_KEY;
    // === NEXT ID "OF-YYYY-NNN" ROBUSTO (scansione stato + LS + counters + opz. server) ===
  window.nextIdOF = window.nextIdOF || async function nextIdOF() {
    const y = new Date().getFullYear();
    const pad = n => String(n).padStart(3, '0');

    // 1) prendi tutto ciò che hai in mano
    const lsArr  = lsGet(ORD_KEY, []) || [];
    const stArr  = Array.isArray(rows) ? rows : [];

    // 2) opzionale: prova a leggere dal server (se disponibile) — non blocca se offline
    let svArr = [];
    try { if (window.api?.kv?.get) svArr = await window.api.kv.get('ordiniFornitoriRows') || []; } catch {}

    // 3) trova il max N dell'anno corrente
    const all = [...stArr, ...lsArr, ...svArr];
    let maxN = 0;
    for (const r of all) {
      const m = String(r?.id || '').match(/^OF-(\d{4})-(\d{3})$/);
      if (m && Number(m[1]) === y) {
        const n = Number(m[2]);
        if (n > maxN) maxN = n;
      }
    }

    // 3.bis) considera anche l'ULTIMO numero emesso dalle Impostazioni (se presente)
    try {
      const cfg = lsGet('appSettings', {}) || {};
      // Proviamo alcune varianti comuni di struttura:
      const byYear  = cfg?.numerazioni?.OF?.[String(y)]?.ultimo;
      const flat    = cfg?.numerazioni?.OF?.ultimo ?? cfg?.numeratori?.OF?.ultimo;
      const legacy  = cfg?.OF_last ?? cfg?.ultimoOF;

      const ultimo = Number(
        byYear ?? flat ?? legacy ?? 0
      ) || 0;

      if (ultimo > maxN) maxN = ultimo;
    } catch {}

    // 4) sincronizza coi counters (se li usi)
    try {
      const counters = JSON.parse(localStorage.getItem('counters') || '{}') || {};
      const cur = counters['OF'] || { year: y, num: maxN };
      if (cur.year !== y) { cur.year = y; cur.num = maxN; }
      if (cur.num < maxN) cur.num = maxN; // allinea in avanti
      cur.num += 1;                       // prossimo disponibile
      counters['OF'] = cur;
      localStorage.setItem('counters', JSON.stringify(counters));
      return { id: `OF-${y}-${pad(cur.num)}`, year: y, num: cur.num };
    } catch {
      // fallback se counters non scrivibili
      const n = maxN + 1;
      return { id: `OF-${y}-${pad(n)}`, year: y, num: n };
    }
  };

  // Utils
  const today = ()=> new Date().toISOString().slice(0,10);
  const clone = o => JSON.parse(JSON.stringify(o));
  const num = v => Number(v||0);
  const residuoRiga = r => Math.max(0, num(r.qta) - num(r.qtaRicevuta));
  const totaleDoc = o => (o?.righe||[]).reduce((s,r)=> s + num(r.qta)*num(r.prezzo), 0);

  // ===== Stato automatico ordine =====
  function statoAutoPerOrdine(o){
    const righe = o?.righe || [];
    if (!righe.length) return o.stato || 'Bozza';
    const totOrd = righe.reduce((s,r)=> s + num(r.qta||0), 0);
    const totRx  = righe.reduce((s,r)=> s + num(r.qtaRicevuta||0), 0);
    if (totOrd>0 && totRx>=totOrd) return 'Chiuso';
    if (totRx>0) return 'Parziale';
    return o.stato || 'Bozza';
  }

    // ===== Stato =====
    // stato ordini (carico iniziale da server se disponibile, altrimenti localStorage)
  const [rows, setRows] = React.useState(()=> lsGet(ORD_KEY, []));

  // 1) Hydrate da server alla prima apertura
  React.useEffect(()=>{
    (async ()=>{
      try{
          // Carica dal server SOLO se l’API è disponibile
        if (!(window.api?.kv?.get)) return;
        const serverRows = await window.api.kv.get('ordiniFornitoriRows');

        if (Array.isArray(serverRows)) {
          const localRows = lsGet(ORD_KEY, []);
          const byId = new Map();

          // 1) metti prima i locali
          for (const r of (Array.isArray(localRows)?localRows:[])) {
            byId.set(String(r?.id||''), r);
          }
          // 2) poi i server SOLO se più "nuovi"
          for (const s of serverRows) {
            const id = String(s?.id||'');
            const a  = byId.get(id);
            const au = (a && a.updatedAt) ? new Date(a.updatedAt).getTime() : 0;
            const su = (s && s.updatedAt) ? new Date(s.updatedAt).getTime() : 0;
            if (!a || su > au) byId.set(id, s);
          }

          const merged = [...byId.values()];
          const sameLen = Array.isArray(localRows) && localRows.length === merged.length;
          const sameIds = sameLen && localRows.every((r,i)=>String(r.id||'')===String(merged[i]?.id||''));
          if (!sameLen || !sameIds) {
            setRows(merged);
            lsSet(ORD_KEY, merged);
          }
        }
}catch(e){ /* offline o non loggato → ignora */ }

    })();
  },[]);

    // 2) Ogni volta che rows cambia: salva in locale + (se c'è) scrivi al server, **senza** rileggerlo
  React.useEffect(()=>{
    try{ lsSet(ORD_KEY, rows); }catch{}
    try{ if (window.api?.kv?.set) window.api.kv.set('ordiniFornitoriRows', rows); }catch{}
  },[rows]);

  const [q, setQ] = React.useState(query||'');
  const [filtroStato, setFiltroStato] = React.useState('TUTTI'); // TUTTI, APERTI, PARZIALI, CHIUSI
  
  const [showForm, setShowForm] = React.useState(false);
  const [draft, setDraft] = React.useState(null);

  const fornitori = lsGet(FORN_KEY, []);
  const articoli  = lsGet(ARTK, []);
  
  // CRUD
  async function startNew(){
    const idObj = (typeof window.nextIdOF === 'function') ? await window.nextIdOF() : { id: `OF-${new Date().getFullYear()}-${formatNNN(1)}` };
    setDraft({
      id: idObj.id, data: today(),
      fornitoreId: null, fornitoreRagione: '',
      rifOrdine: '', consegnaPrevista: today(),
      stato: 'Bozza', note: '',
      righe: [],
      condizioniPagamento: PAGAMENTI_FORNITORE[0], // default: Bonifico vista fattura
      nsRiferimento: '',
      confermaFileDataUrl: '',
      confermaFileName: '',
      __createdAt: new Date().toISOString(),
      updatedAt:  new Date().toISOString()
    });
    setShowForm(true);
  }

  function startEdit(r){ setDraft(clone(r)); setShowForm(true); }
  function removeRow(id){ if(confirm('Eliminare ordine?')) setRows(rows.filter(x=>x.id!==id)); }
      // Duplica un ordine fornitore esistente
  async function duplicaOrdine(ofOrig){
    if (!ofOrig || !ofOrig.id) return;

    // 1) genera nuovo ID robusto in serie OF-YYYY-NNN
    const idObj = (typeof window.nextIdOF === 'function')
      ? await window.nextIdOF()
      : { id: `OF-${new Date().getFullYear()}-${formatNNN(1)}` };

    // 2) copia profonda dell'ordine
    const copy = clone(ofOrig);
    copy.id    = idObj.id;
    copy.stato = 'Bozza';

    // 2.bis) azzera il ricevuto sulle righe
    copy.righe = (Array.isArray(copy.righe) ? copy.righe : []).map(r => ({
      ...r,
      qtaRicevuta: Number(r.qtaRicevuta || 0) > 0 ? 0 : (r.qtaRicevuta || 0)
    }));

    // 2.ter) date di tracking
    const now = new Date().toISOString();
    copy.__createdAt = now;
    copy.updatedAt   = now;

    // 3) costruisci il NUOVO array righe in memoria
    const nextRows = (() => {
      const base = Array.isArray(rows) ? clone(rows) : [];
      base.push(copy); // lo sortiamo comunque dopo con compareOF
      return base;
    })();

    // 3.bis) salvataggio su localStorage
    try { lsSet(ORD_KEY, nextRows); } catch {}

    // 3.ter) compat: eventuali persistenze legacy
    try { if (window.persistOF) window.persistOF(copy); } catch {}
    try { if (window.persistKV) window.persistKV('ordiniFornitoriRows', nextRows); } catch {}

    // 3.quater) server, se presente
    (async ()=> {
      try {
        if (window.api?.kv?.set) {
          await window.api.kv.set('ordiniFornitoriRows', nextRows);
        }
      } catch {}
    })();

    // 3.quinq) aggiorna stato React → rerender immediato
    setRows(nextRows);

    // 4) reset filtri per vederlo subito
    setFiltroStato('TUTTI');
    setQ('');

    try { alert('Ordine duplicato come ' + copy.id); } catch {}
  }

    async function saveDraft(){
    const now = new Date().toISOString();
    const doc = JSON.parse(JSON.stringify(draft));
          // Se per qualsiasi motivo la bozza non ha ID, generane uno ora
        // Se la bozza non ha ID, generane uno robusto adesso
        // Se la bozza non ha ID, generane uno robusto adesso (OF-YYYY-NNN)
    if (!doc.id) {
      let idObj = null;

      // 1) prima scelta: nextIdOF dedicato agli Ordini Fornitori
      if (typeof window.nextIdOF === 'function') {
        try {
          idObj = await window.nextIdOF();
        } catch {}
      }

      // 2) fallback: generatore generico nextIdFor, ma in serie OF
      if (!idObj && typeof window.nextIdFor === 'function') {
        try {
          idObj = await window.nextIdFor({
            prefix: 'OF',
            storageKey: ORD_KEY,
            seriesKey: 'OF',
            width: 3
          });
        } catch {}
      }

      if (idObj && idObj.id) doc.id = idObj.id;
    }

    doc.totale = (doc?.righe||[]).reduce((s,r)=> s + Number(r.qta||0)*Number(r.prezzo||0), 0);
    doc.stato  = (function(o){
      const righe = o?.righe || [];
      if (!righe.length) return o.stato || 'Bozza';
      const totOrd = righe.reduce((s,r)=> s + Number(r.qta||0), 0);
      const totRx  = righe.reduce((s,r)=> s + Number(r.qtaRicevuta||0), 0);
      if (totOrd>0 && totRx>=totOrd) return 'Chiuso';
      if (totRx>0) return 'Parziale';
      return o.stato || 'Bozza';
    })(doc);
    if (!doc.__createdAt) doc.__createdAt = now;
    doc.updatedAt = now;

    const idx = rows.findIndex(x=>x.id===doc.id);
    const nxt = JSON.parse(JSON.stringify(rows));
    if (idx>=0) nxt[idx]=doc; else nxt.push(doc);
        // === Persistenza robusta (evita snapshot vecchi di "rows")
setRows(prev => {
  const arr = Array.isArray(prev) ? JSON.parse(JSON.stringify(prev)) : [];
  const j = arr.findIndex(x => String(x?.id||'') === String(doc.id||''));
  if (j >= 0) arr[j] = doc; else arr.push(doc);

  // 1) scrivi subito in localStorage
  try { lsSet(ORD_KEY, arr); } catch {}

  // 2) storage “compat”
  try { if (window.persistOF) window.persistOF(doc); } catch {}
  try { if (window.persistKV) window.persistKV('ordiniFornitoriRows', arr); } catch {}

  // 3) server (se c’è)
  (async ()=>{ try { if (window.api?.kv?.set) await window.api.kv.set('ordiniFornitoriRows', arr); } catch {} })();

  return arr;
});

setShowForm(false);
setDraft(null);
// azzera filtri per sicurezza (se prima stavi filtrando "CHIUSI" o cercando testo)
setFiltroStato('TUTTI');
setQ('');
setTimeout(()=>{ try{ alert('Ordine salvato.'); }catch{} }, 0);

  }

  // RIGHE
    function addRiga(){
    const d = clone(draft); 
    d.righe = d.righe || [];
    d.righe.push({
      codice:'', descr:'', um:'',
      qta:1,
      prezzo:0,
      iva: DEFAULT_IVA,        // 👈 nuovo campo IVA%
      qtaRicevuta:0
    });
    setDraft(d);
  }
  function updRiga(i, patch){ const d=clone(draft); d.righe[i]={...d.righe[i], ...patch}; setDraft(d); }
  function delRiga(i){ const d=clone(draft); d.righe.splice(i,1); setDraft(d); }
    function pickArticolo(i, codice){
    const a = (articoli||[]).find(x => (x.codice||x.id) === codice);
    if (!a) { 
      updRiga(i, { codice }); 
      return; 
    }
    updRiga(i,{
      codice: (a.codice||a.id),
      descr:  (a.descrizione||a.nome||''),
      um:     (a.um||a.unita||''),
      prezzo: num(a.prezzo)||num(a.cmp)||0,
      iva:    (typeof a.iva === 'number' ? a.iva : DEFAULT_IVA) // 👈 se articolo ha IVA, altrimenti default
    });
  }

  // Ricezione (modal per riga)
  const [rx, setRx] = React.useState(null); // { indexRiga }
  function apriRicezione(i){ setRx({ indexRiga:i }); }

  function confermaRicezione({ qta, data, ddtFornitore, note, updateCMP }){
    if (!draft || rx==null) return;
    const i = rx.indexRiga; const r = draft.righe[i];
    const residuo = residuoRiga(r);
    const take = Math.max(0, Math.min(residuo, Number(qta||0)));
    if (take<=0) { setRx(null); return; }

    // 1) movimento magazzino
    window.creaMovimentoCaricoDaOrdine(draft, [{ codice: r.codice, qta: take, prezzo: num(r.prezzo) }], {
      data, ddtFornitore, note, updateCMP
    });

    // 2) aggiorna riga ordine
    updRiga(i, { qtaRicevuta: num(r.qtaRicevuta)+take });

    // 3) aggiorna stato automatico (Parziale / Chiuso)
    setDraft(d=>{
      const dd = clone(d);
      const res = (dd.righe||[]).map(rr => residuoRiga(rr));
      const hasRighe = (dd.righe||[]).some(rr => num(rr.qta)>0);
      const allClosed = hasRighe && res.every(x=>x===0);
      const anyReceived = (dd.righe||[]).some(rr => num(rr.qtaRicevuta)>0);
      if (allClosed) dd.stato='Chiuso';
      else if (anyReceived) dd.stato='Parziale';
      return dd;
    });

    setRx(null);
  }

  // Ricevi TUTTO residuo (azione rapida per riga)
  function riceviTutto(i){
    if (!draft) return;
    const r = draft.righe[i];
    const res = residuoRiga(r);
    if (res<=0) return;
    // 1) movimento
    window.creaMovimentoCaricoDaOrdine(draft, [{ codice: r.codice, qta: res, prezzo: num(r.prezzo)}], {
      data: today()
    });
    // 2) aggiorna riga
    updRiga(i, { qtaRicevuta: num(r.qtaRicevuta)+res });
    // 3) stato auto
    setDraft(d=>{
      const dd = clone(d);
      const resArr = (dd.righe||[]).map(rr => residuoRiga(rr));
      const hasRighe = (dd.righe||[]).some(rr => num(rr.qta)>0);
      const allClosed = hasRighe && resArr.every(x=>x===0);
      const anyReceived = (dd.righe||[]).some(rr => num(rr.qtaRicevuta)>0);
      if (allClosed) dd.stato='Chiuso';
      else if (anyReceived) dd.stato='Parziale';
      return dd;
    });
  }

    function riceviOrdineIntero(){
  if (!draft) return;
  // Costruisci elenco righe residue da ricevere
  const righe = (draft.righe||[])
    .map(r => {
      const q = Number(r.qta||0);
      const rx = Number(r.qtaRicevuta||0);
      const res = Math.max(0, q - rx);
      return res>0 ? { codice: String(r.codice||'').trim(), qta: res, prezzo: Number(r.prezzo||0) } : null;
    })
    .filter(Boolean);

  if (righe.length===0) {
    alert('Nessun residuo da ricevere su questo ordine.');
    return;
  }

  // Conferma per sicurezza (evita doppi click)
  if (!confirm(`Confermi la ricezione del residuo? (${righe.length} righe)`)) return;

  // 1) Movimento magazzino cumulativo (usa data odierna)
  const today = new Date().toISOString().slice(0,10);
  window.creaMovimentoCaricoDaOrdine(draft, righe, { data: today });

  // 2) Aggiorna draft: qtaRicevuta = qta per le righe interessate
  const d = clone(draft);
  d.righe = (d.righe||[]).map(r => {
    const q = Number(r.qta||0);
    const rx = Number(r.qtaRicevuta||0);
    const res = Math.max(0, q - rx);
    return res>0 ? { ...r, qtaRicevuta: rx + res } : r;
  });

  // 3) Stato automatico (Chiuso/Parziale)
  const resArr = (d.righe||[]).map(rr => Math.max(0, Number(rr.qta||0) - Number(rr.qtaRicevuta||0)));
  const hasRighe = (d.righe||[]).some(rr => Number(rr.qta||0)>0);
  const allClosed = hasRighe && resArr.every(x=>x===0);
  const anyReceived = (d.righe||[]).some(rr => Number(rr.qtaRicevuta||0)>0);
  if (allClosed) d.stato = 'Chiuso';
  else if (anyReceived) d.stato = 'Parziale';

  setDraft(d);

  // 4) Persisti subito (write-through coerente)
  saveDraft();
}

    // Filtro elenco (search + stato) + ORDINAMENTO DESC (OF-YYYY-NNN)
  const compareOF = (a,b)=>{
    const ra = String(a.id||'').match(/^OF-(\d{4})-(\d{3})$/);
    const rb = String(b.id||'').match(/^OF-(\d{4})-(\d{3})$/);
    if (ra && rb){
      const ya = +ra[1], yb = +rb[1];
      if (yb!==ya) return yb-ya;
      const na = +ra[2], nb = +rb[2];
      if (nb!==na) return nb-na;
    }
    const ta = Date.parse(a.updatedAt||a.__createdAt||a.data||0) || 0;
    const tb = Date.parse(b.updatedAt||b.__createdAt||b.data||0) || 0;
    if (tb!==ta) return tb-ta;
    return String(b.id||'').localeCompare(String(a.id||''));
  };

  const frows = (rows||[])
  .map(o => ({ ...o, statoCalc: (function(){
    const righe = o?.righe || [];
    if (!righe.length) return o.stato || 'Bozza';
    const totOrd = righe.reduce((s,r)=> s + Number(r.qta||0), 0);
    const totRx  = righe.reduce((s,r)=> s + Number(r.qtaRicevuta||0), 0);
    if (totOrd>0 && totRx>=totOrd) return 'Chiuso';
    if (totRx>0) return 'Parziale';
    return o.stato || 'Bozza';
  })()}))
  .filter(r=>{
    const s=(q||'').toLowerCase().trim(); if(!s) return true;
    const hay = [
      r.id, r.data, r.stato, r.statoCalc, r.rifOrdine, r.consegnaPrevista, r.fornitoreRagione, r.fornitoreId
    ].concat((r.righe||[]).map(x=>`${x.codice} ${x.descr}`)).join(' ').toLowerCase();
    return hay.includes(s);
  })
  .filter(r=>{
    if (filtroStato==='TUTTI') return true;
    if (filtroStato==='CHIUSI') return r.statoCalc==='Chiuso';
    if (filtroStato==='PARZIALI') return r.statoCalc==='Parziale';
    if (filtroStato==='APERTI') return r.statoCalc!=='Chiuso';
    return true;
  })
  .sort(compareOF);

  // UI
  async function creaNuovoOrdine(){
  const idObj = (typeof window.nextIdOF === 'function') ? await window.nextIdOF() : { id: `OF-${new Date().getFullYear()}-${formatNNN(1)}` };

  const nuovo = {
    id: idObj.id,
    data: new Date().toISOString().slice(0,10),
    stato: 'Bozza',
    righe: [],
    __createdAt: new Date().toISOString(),
    updatedAt:  new Date().toISOString()
  };
  if (window.persistOF) window.persistOF(nuovo);

  setRows(prev => {
    const next = [nuovo, ...(Array.isArray(prev)?prev:[])];
    try { if (typeof window.persistKV === 'function') window.persistKV('ordiniFornitoriRows', next); } catch {}
    try { lsSet(ORD_KEY, next); } catch {}
    return next;
  });

  alert('Nuovo ordine creato: ' + idObj.id);
}


  return e('div', { className:'container' },
    e('div', { className:'row', style:{alignItems:'center', gap:12, marginBottom:12} },
      e('h2', null, `Ordini Fornitori (${rows.length})`),
      e('div', { style:{flex:1} }),
      e('select', { value:filtroStato, onChange:ev=>setFiltroStato(ev.target.value), style:{minWidth:150} },
        e('option', {value:'TUTTI'}, 'Tutti'),
        e('option', {value:'APERTI'}, 'Aperti'),
        e('option', {value:'PARZIALI'}, 'Parziali'),
        e('option', {value:'CHIUSI'}, 'Chiusi')
      ),
      e('input', { placeholder:'Cerca…', value:q, onChange:ev=>setQ(ev.target.value), style:{minWidth:220} }),
      e('button', { className:'btn', onClick:startNew, ...window.roProps() }, '➕ Nuovo ordine'),
          e('button', { className:'btn btn-outline', onClick: ()=> window.exportOrdiniApertiCSV && window.exportOrdiniApertiCSV() }, '⬇️ CSV ordini aperti'),
           ' ',
          e('button', { id:'btn-reset-of',  className:'btn btn-outline', title:'Reset filtri', onClick: ()=>{ setQ(''); setFiltroStato('TUTTI'); }}, '↺ Reset filtro')
    ),
    e('div', { className:'table-wrap' },
  e('table', { className:'table' },
    e('thead', null, 
      e('tr', null,
        e('th', null, 'ID'),
        e('th', null, 'Data'),
        e('th', null, 'Fornitore'),
        e('th', null, '#Righe'),
        e('th', null, 'Totale'),
        e('th', null, 'Stato'),
        e('th', null, 'Azioni')
      )
    ),
    e('tbody', null,
      frows.length
        ? frows.map(r => 
            e('tr', { key: r.id },
              e('td', null, r.id, (r.confermaFileDataUrl ? ' 📎' : '')),
              e('td', null, r.data || ''),
              e('td', null, r.fornitoreRagione || r.fornitoreId || ''),
              e('td', null, (r.righe || []).length),
              e('td', null, (r.totale || totaleDoc(r)).toFixed(2)),
              e('td', null, r.statoCalc || r.stato || 'Bozza'),
                            e('td', null,
                // Modifica
                e('button', {
                  className:'btn btn-sm',
                  onClick:()=>startEdit(r),
                  disabled: readOnly,
                  title: readOnly ? 'Sola lettura' : ''
                }, '✏️'),
                ' ',
                // Visualizza (solo anteprima/modale)
                e('button', {
                  className:'btn btn-sm',
                  onClick:()=>{ const doc=clone(r); setDraft(doc); setShowForm(true);}
                }, '📄'),
                ' ',
                // Duplica
                e('button', {
                  className:'btn btn-sm',
                  onClick:()=>duplicaOrdine(r),
                  disabled: readOnly,
                  title: readOnly ? 'Sola lettura' : 'Duplica ordine'
                }, '⧉ Duplica'),
                ' ',
                // Stampa
                e('button', {
                  className:'btn btn-sm',
                  onClick:()=>window.printOrdineFornitore && window.printOrdineFornitore(r)
                }, '🖨️ Stampa'),
                ' ',
                // Elimina
                !readOnly && e('button', {
                  className:'btn btn-sm btn-danger',
                  onClick:()=>removeRow(r.id)
                }, '🗑️')
              )

            )
          )
        : e('tr', null,
            e('td', { colSpan: 7, className: 'muted' },
              'Nessun ordine da mostrare. Premi "↺ Reset filtro" oppure "➕ Nuovo ordine".'
            )
          )
    )
  )
), // ← lascia la virgola qui: separa dal blocco successivo (la modale)

    // MODALE Ordine Fornitore (con sola-lettura)
  showForm && e('div', { className:'modal-backdrop' },
    e('div', { className:'modal-card', style:{maxWidth:1200, width:'100%'} },

    e('h3', null, draft && draft.id ? `Ordine ${draft.id}` : 'Nuovo Ordine'),

    // CAMPI BLOCCATI IN SOLA LETTURA
        e('fieldset', { disabled: readOnly },

      // meta ordine in griglia (niente sovrapposizioni)
e('div', { 
  className:'form', 
  style:{
    display:'grid',
    gridTemplateColumns:'repeat(auto-fit, minmax(260px, 1fr))',
    gap:12
  }
},
  // Titolo sezione
  e('div',{className:'form-group-title', style:{gridColumn:'1 / -1'}}, 'Dati ordine'),

  // Data
  e('div', null,
    e('label', null, 'Data'),
    e('input', { 
      type:'date', 
      value:draft.data, 
      onChange:ev=>setDraft({...draft, data:ev.target.value})
    })
  ),

  // Fornitore
  e('div', null,
    e('label', null, 'Fornitore'),
    fornitori && fornitori.length
      ? e('select', {
          value: draft.fornitoreId || '',
          onChange: ev => {
            const id = ev.target.value;
            const f  = fornitori.find(x => String(x.id)===String(id)) || null;
            setDraft(p => ({
              ...p,
              fornitoreId: id,
              fornitoreRagione: f ? (f.ragione || f.ragioneSociale || '') : ''
            }));
          }
        },
          e('option',{value:''},'— seleziona —'),
          ...fornitori.map(f =>
            e('option',{key:f.id,value:f.id},String(f.ragione||f.ragioneSociale||''))
          )
        )
      : e('a', { className:'btn btn-outline', href:'#/fornitori' }, 'Crea fornitore…')
  ),

  // Pagamento fornitore
  e('div', null,
    e('label', null, 'Pagamento fornitore'),
    e('select', {
      name:'condizioniPagamento',
      value: draft.condizioniPagamento || '',
      onChange: ev => setDraft(p => ({ ...p, condizioniPagamento: ev.target.value }))
    },
      PAGAMENTI_FORNITORE.map(opt =>
        e('option', { key: opt, value: opt }, opt)
      )
    )
  ),

  // Consegna prevista
  e('div', null,
    e('label', null, 'Consegna prevista'),
    e('input', {
      type:'date',
      value:draft.consegnaPrevista || '',
      onChange: ev => setDraft({...draft, consegnaPrevista:ev.target.value})
    })
  ),

  // NS riferimento (interno Anima) – a tutta larghezza
  e('div', { style:{gridColumn:'1 / -1'} },
    e('label', null, 'NS Riferimento (Anima SRL)'),
    e('input', { 
      value:draft.nsRiferimento || '', 
      onChange:ev=>setDraft({...draft, nsRiferimento:ev.target.value}),
      placeholder:'es. Commessa C-2025-123 / Richiedente interno'
    })
  ),

  // Riferimento fornitore – a tutta larghezza
  e('div', { style:{gridColumn:'1 / -1'} },
    e('label', null, 'Riferimento fornitore'),
    e('input', { 
      value:draft.rifOrdine || '', 
      onChange:ev=>setDraft({...draft, rifOrdine:ev.target.value}), 
      placeholder:'es. richiesta n. … / preventivo fornitore'
    })
  ),
        // Conferma ordine allegata – a tutta larghezza
        e('div', { style:{gridColumn:'1 / -1'} },
          e('label', null, 'Conferma ordine (PDF/JPG/PNG)'),
          e('input', {type:'file',
            accept:'application/pdf,image/*',
            onChange: ev => {
              try{
                const f = ev?.target?.files?.[0];
                if(!f){ 
                  setDraft({...draft, confermaFileDataUrl:'', confermaFileName:''}); 
                  return; 
                }
                const rd = new FileReader();
                rd.onload = () => setDraft({...draft, confermaFileDataUrl:String(rd.result||''), confermaFileName:f.name});
                rd.readAsDataURL(f);
              }catch{}
            }
          }),
          (draft.confermaFileName
            ? e('div', {className:'muted'}, 'Allegato: ', draft.confermaFileName, ' ',
                e('button', {
                  type:'button', 
                  className:'btn btn-sm btn-outline',
                  onClick:()=>setDraft({...draft, confermaFileDataUrl:'', confermaFileName:''})
                }, 'Rimuovi')
              )
            : null
          )
        ),

        // Stato ordine
        e('div', null,
          e('label', null, 'Stato'),
          e('select', { 
            value:draft.stato, 
            onChange:ev=>setDraft({...draft, stato:ev.target.value}) 
          },
            e('option', { value:'Bozza' }, 'Bozza'),
            e('option', { value:'Inviato' }, 'Inviato'),
            e('option', { value:'Confermato' }, 'Confermato'),
            e('option', { value:'Parziale' }, 'Parziale'),
            e('option', { value:'Chiuso' }, 'Chiuso'),
            e('option', { value:'Annullato' }, 'Annullato')
          )
        )
      ),


      // tabella righe
      e('div', { style:{marginTop:12} },
        // datalist per suggerimenti articoli (codice + descrizione)
        articoli.length ? e('datalist', { id:'of-articoli-list' },
          articoli.map(a => e('option', {
            key:   (a.codice || a.id),
            value: (a.codice || a.id)
          }, (a.codice || a.id) + ' — ' + (a.descrizione || a.nome || '')))
        ) : null,
        e('table', { className:'table' },
          e('thead', null, e('tr', null,
            e('th', null, '#'),
            e('th', null, 'Codice'),
            e('th', null, 'Descrizione'),
            e('th', null, 'UM'),
            e('th', null, 'Qta Ord.'),
            e('th', null, 'Ricevuto'),
            e('th', null, 'Residuo'),
            e('th', null, 'Prezzo'),
            e('th', null, 'IVA %'),
            e('th', null, 'Totale'),
            e('th', null, 'Azioni')
          )),

          e('tbody', null,
            (draft.righe||[]).map((r,i)=> e('tr', { key:i },
              e('td', null, String(i+1)),
                            e('td', null,
                e('input', {
                  list:  articoli.length ? 'of-articoli-list' : null,
                  value: r.codice || '',
                  onChange: ev => {
                    const codice = ev.target.value;
                    pickArticolo(i, codice);
                  }
                })
              ),
              e('td', null, e('input', { value:r.descr||'', onChange:ev=>updRiga(i,{descr:ev.target.value}) })),
              e('td', null, e('input', { value:r.um||'', onChange:ev=>updRiga(i,{um:ev.target.value}) })),
                            e('td', null,
                e('input', {
                  type:'number',
                  step:'0.01',
                  value: r.qta || 0,
                  onChange:ev => updRiga(i,{ qta:Number(ev.target.value) })
                })
              ),
              e('td', null, r.qtaRicevuta || 0),
              e('td', null, residuoRiga(r)),
              e('td', null,
                e('input', {
                  type:'number',
                  step:'0.01',
                  value: r.prezzo || 0,
                  onChange:ev => updRiga(i,{ prezzo:Number(ev.target.value) })
                })
              ),
              e('td', null,
                e('input', {
                  type:'number',
                  step:'1',
                  min:'0',
                  value: (r.iva != null ? r.iva : DEFAULT_IVA),
                  onChange:ev => updRiga(i,{ iva: Number(ev.target.value)||0 })
                })
              ),
              e('td', null, (Number(r.qta||0) * Number(r.prezzo||0)).toFixed(2)),
              e('td', null,
                e('button', { className:'btn btn-sm', onClick:()=>apriRicezione(i), ...window.roProps() }, '📥 Ricevi'),
                ' ',
                e('button', { className:'btn btn-sm', onClick:()=>riceviTutto(i), ...window.roProps() }, '⇥ Tutto'),
                ' ',
                e('button', { className:'btn btn-sm btn-danger', onClick:()=>delRiga(i), ...window.roProps() }, '✖')
              )
            ))
          )
        ),

        e('button', { className:'btn btn-sm', onClick:addRiga }, '➕ Aggiungi riga'),
        e('div', { style:{float:'right', marginTop:8, fontWeight:'bold'} }, `Totale: € ${(totaleDoc(draft)).toFixed(2)}`)
      )
    ),

    // azioni finali (fuori dal fieldset)
    e('div', { className:'row', style:{justifyContent:'flex-end', gap:8, marginTop:12} },
      e('button', { className:'btn', onClick:()=>{ setShowForm(false); setDraft(null); } }, 'Chiudi'),
      e('button', {className:'btn btn-outline',onClick: riceviOrdineIntero,...window.roProps()}, '⬇️ Ricevi ordine (residuo)'),
      ' ',
      e('button', {className:'btn btn-outline',title:'Anteprima/Stampa Ordine',onClick:()=>{ try{ window.printOrdineFornitore && window.printOrdineFornitore(draft); }catch(e){ alert('Stampa OF non disponibile'); } }}, '🖨️ Stampa'),
      ' ',
      e('button', { className:'btn btn-primary', onClick:saveDraft, ...window.roProps() }, 'Salva')
    )
    )
  ),

    rx && draft && e(RiceviDaOrdineModal, {
      ordine: draft,
      riga: draft.righe[rx.indexRiga],
      onClose: ()=> setRx(null),
      onConfirm: confermaRicezione
    })
  );
}
window.OrdiniFornitoriView = window.OrdiniFornitoriView || OrdiniFornitoriView;


// ============== STAMPA ORDINE FORNITORE — neutra (solo totale colorato) ==============
(function(){
  // idempotente: ridefinisce ogni reload, OK

  window.printOrdineFornitore = function(of){
    try{
      const esc  = s => String(s==null?'':s).replace(/[<>&]/g, c=>({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c]));
      const fmt2 = n => Number(n||0).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2});
      const fmtIT = d => { try{ return d ? new Date(d).toLocaleDateString('it-IT') : ''; }catch{return String(d||'');} };
      const todayISO = () => new Date().toISOString().slice(0,10);

      // Dati app + fornitore
      const app = (function(){ try{ return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; }catch{return{}} })();
      const fornRows = (function(){ try{ return JSON.parse(localStorage.getItem('fornitoriRows')||'[]')||[]; }catch{return[]} })();

      // Fornitore
      let forn = fornRows.find(f => String(f.id||f.codice||'') === String(of.fornitoreId||'')) || null;
        if (!forn && of.fornitoreRagione) {
          const norm = s => String(s||'').trim().toLowerCase();
          forn = fornRows.find(f => norm(f.ragione||f.nome||'') === norm(of.fornitoreRagione)) || null;
        }

        const ragioneF  = esc(of.fornitoreRagione || forn?.ragione || forn?.nome || of.fornitoreId || '');
        const pivaF     = esc(forn?.piva || forn?.pIva || '');
        const indirF    = esc(forn?.indirizzo || forn?.ind || forn?.sedeOperativa || forn?.sedeLegale || '');
        const telF      = esc(forn?.telefono || forn?.tel || '');
        const mailF     = esc(forn?.email || '');
        const cfF       = esc(forn?.cf || '');
        const codUnivF  = esc(forn?.codiceUnivoco || forn?.codiceSDI || '');
        const pecForn   = esc(forn?.pec || '');
        const faxF      = esc(forn?.fax || '');
        const contattiF = [mailF || '', telF || '', faxF ? ('Fax: ' + faxF) : '']
          .filter(Boolean)
          .join(' · ');


      // Header ANIMA
      const logo     = app.logoDataUrl || '';
      const sedeLeg  = esc(app.sedeLegale || '');
      const sedeOp   = esc(app.sedeOperativa || '');
      const pivaA    = esc(app.piva || app.pIva || '');
      const telAzi   = esc(app.telefono || app.phone || '');
      const emailAzi = esc(app.email || '');
      const pecAzi   = esc(app.pec || '');

      // Colore SOLO per totale
      const ACCENT = app.brandColor || app.coloreBrand || '#0ea5e9';

      const righe = Array.isArray(of.righe)?of.righe:[];
      const totOrdine = righe.reduce((s,r)=> s + (Number(r.qta||0)*Number(r.prezzo||0)), 0);

      let css = window.__PRINT_CSS({ top:12, right:8, bottom:12, left:8 });
css += `<style>
  /* RIMOSSE dal tuo blocco originale:
     - @page { ... }                               → gestita dal tema
     - .pageNum[data-mode="css"]::after{...}       → non serve (numerazione via JS)
     - .pageNum[data-mode="css"]{...}              → non serve
     - .pagebox { ... } (puoi lasciarla se vuoi padding extra, ma il tema già la posiziona)
  */
    .pageNumOF::after{ content: counter(page); }

  /* Header pulito, nessun colore pieno */
  
  .hdr{display:flex;justify-content:space-between;align-items:center;gap:14px;
       border-bottom:2px solid #0f172a; padding-bottom:8px; margin-bottom:10px}
  .brand{display:flex;align-items:center;gap:12px}
  .brand img{height:60px;object-fit:contain}
  .az .rs{font-size:18px;font-weight:800;letter-spacing:.2px}
  .az .muted{color:#64748b}
  .doc{border:1px solid #cbd5e1; border-radius:10px; padding:10px 12px; min-width:210px; text-align:right}
  .doc .title{font-weight:800; font-size:12px; letter-spacing:.3px}
  .doc .num{font-weight:800; font-size:14px}
  .doc .row{margin-top:2px}

  /* Fornitore (senza contorni) + info riga */
  .supplier{margin-top:8px}
  .supplier .rs{font-weight:700; margin-bottom:2px}
  .supplier .muted{color:#64748b}
  .note-conf{color:#64748b; font-style:italic; margin:4px 0 0}

  /* Info pagamento / consegna / riferimenti in griglia leggera */
  .infos{display:grid; grid-template-columns:1fr 1fr; gap:6px 16px; margin-top:8px}
  .info .lab{color:#64748b}
  .info .val{font-weight:600}

  /* Fascia indirizzo ricezione (ben visibile, no colori) */
  .receive-band{margin:12px 0 6px 0; text-align:center}
  .receive-band .t1{font-weight:800; border-top:2px solid #0f172a; border-bottom:2px solid #0f172a; padding:6px 0; letter-spacing:.3px}
  .receive-band .t2{margin-top:4px}

  /* Tabella righe */
  table{width:100%; border-collapse:collapse; margin-top:6px}
  thead{display:table-header-group}
  th,td{border:1px solid #e2e8f0; padding:7px 8px; vertical-align:top}
  th{background:#f8fafc; font-weight:700}
  .ctr{text-align:center}
  .num{text-align:right}
  .no-break{page-break-inside:avoid}
  @media print{
    table{ page-break-inside:auto }
    tr{ break-inside:avoid; page-break-inside:avoid }
    td,th{ break-inside:avoid; page-break-inside:avoid }
  }

     /* Footer con totale colorato */
  .content{margin-bottom:0}
  .footer{
    position:fixed;
    left:8mm;
    right:8mm;
    bottom:12mm;
    display:flex;
    justify-content:space-between;
    align-items:flex-end;
    gap:12px;
  }
  .footer .pagebox{ position: static; margin-left:auto; font-weight:700; }

  .sign{min-width:280px; padding:8px 2px}
  .sign .lab{color:#64748b; font-size:12px}
  .sign .line{height:26px; border-bottom:1px solid #cbd5e1}
  .sign .name{margin-top:6px; font-weight:600}
  .tot{
    min-width:260px; background:${ACCENT}; color:#fff; border-radius:12px; padding:12px 14px;
    display:flex; justify-content:space-between; align-items:center
  }
  .tot .lab{font-weight:700}
  .tot .val{font-weight:900; font-size:16px}
</style>`;


      const header = `
        <div class="hdr">
          <div class="brand">
            ${logo ? `<img src="${logo}">` : ``}
            <div class="az">
              <div class="rs">${esc(app.ragioneSociale||'')}</div>
              ${sedeLeg ? `<div class="muted">Sede legale: ${sedeLeg}</div>` : ``}
              ${sedeOp  ? `<div class="muted">Sede operativa: ${sedeOp}</div>` : ``}
              ${pivaA   ? `<div class="muted">P.IVA: ${pivaA}</div>` : ``}
              ${telAzi   ? `<div class="muted">Tel: ${telAzi}</div>` : ``}
              ${emailAzi ? `<div class="muted">Email: ${emailAzi}</div>` : ``}
              ${pecAzi   ? `<div class="muted">PEC: ${pecAzi}</div>` : ``}
            </div>
          </div>
          <div class="doc">
            <div class="title">ORDINE FORNITORE</div>
            <div class="num">${esc(of.id||'')}</div>
            <div class="row">Data: <strong>${esc(of.data || todayISO())}</strong></div>
          </div>
        </div>`;

      const bloccoFornitore = `
        <div class="supplier">
          <div class="rs">${ragioneF || '—'}</div>
          ${indirF ? `<div class="muted">${indirF}</div>` : ``}
          ${contattiF ? `<div class="muted">${contattiF}</div>` : ``}
          ${pivaF    ? `<div class="muted">P.IVA: ${pivaF}</div>` : ``}
          ${cfF      ? `<div class="muted">CF: ${cfF}</div>` : ``}
          ${codUnivF ? `<div class="muted">Codice Univoco SDI: ${codUnivF}</div>` : ``}
          ${pecForn  ? `<div class="muted">PEC: ${pecForn}</div>` : ``}
        </div>`;


      const infos = `
        <div class="infos">
          <div class="info">
            <div class="lab">Condizioni di pagamento</div>
            <div class="val">${esc(of.condizioniPagamento || 'Rimessa Diretta')}</div>
          </div>
          <div class="info">
            <div class="lab">Consegna prevista</div>
            <div class="val">${esc(fmtIT(of.consegnaPrevista||''))}</div>
          </div>
          <div class="info">
            <div class="lab">NS. Riferimento</div>
            <div class="val">${esc(of.nsRiferimento || '')}</div>
          </div>
          <div class="info">
            <div class="lab">Riferimento interno</div>
            <div class="val">${esc(of.rifOrdine || '')}</div>
          </div>
        </div>`;

      const bandRicezione = `
        <div class="receive-band">
          <div class="t1">INDIRIZZO RICEZIONE MATERIALE ANIMA SRL</div>
          <div class="t2">Via Botte, 32 int. 5 - 35011 Campodarsego (PD) - Italia</div>
        </div>`;

      // righe
      const righeHTML = righe.map((r,i)=>{
        const descr  = esc(r.descr||r.descrizione||'');
        const um     = esc(r.um||r.UM||'PZ');
        const qta    = Number(r.qta||0);
        const prezzo = Number(r.prezzo||0);
        const tot    = qta * prezzo;

        // IVA per riga: usa r.iva se c'è, altrimenti default app/of se disponibile
        const ivaVal = (r.iva !== undefined && r.iva !== null && r.iva !== '')
          ? Number(r.iva)
          : (typeof of.defaultIva === 'number'
              ? of.defaultIva
              : (typeof app.defaultIva === 'number' ? app.defaultIva : 0));

        const ivaTxt = ivaVal ? esc(String(ivaVal)) : '';

        return `<tr class="no-break">
          <td class="ctr">${i+1}</td>
          <td>${descr}</td>
          <td class="ctr">${um||'PZ'}</td>
          <td class="ctr">${qta ? fmt2(qta) : ''}</td>
          <td class="num">${ivaTxt}</td>
          <td class="num">${prezzo ? fmt2(prezzo) : ''}</td>
          <td class="num">${tot ? fmt2(tot) : ''}</td>
        </tr>`;
      }).join('');

      const table = `
        <table>
          <thead><tr>
            <th style="width:26px" class="ctr">#</th>
            <th>Descrizione</th>
            <th style="width:60px" class="ctr">UM</th>
            <th style="width:90px" class="ctr">Q.tà</th>
            <th style="width:70px" class="num">IVA %</th>
            <th style="width:100px" class="num">P. Unitario</th>
            <th style="width:110px" class="num">P. Totale</th>
          </tr></thead>
          <tbody>${righeHTML || `<tr><td colspan="7" class="muted">— Nessuna riga —</td></tr>`}</tbody>
        </table>`;

      const footer = `
        <div class="footer">
          <div class="sign">
            <div class="lab">Nome richiedente</div>
            <div class="line"></div>
            <div class="name">${esc(of.nsRiferimento || '')}</div>
          </div>
          <div class="tot">
            <div class="lab">Totale ordine</div>
            <div class="val">€ ${fmt2(totOrdine)}</div>
          </div>
          <div class="pagebox">Pag. 1</div>
        </div>`;

            const html = `<!doctype html><html><head><meta charset="utf-8">${css}</head><body>
        ${header}
        <div class="content">
          ${bloccoFornitore}
          ${infos}
          ${of.confermaFileDataUrl ? `<div class="note-conf">Conferma ordine del fornitore allegata al documento.</div>` : ``}
          ${bandRicezione}
          ${table}
        </div>
        ${footer}
      </body></html>`;

            // stampa (OF: numerazione semplice via CSS, niente "1 / 2" JS)
      if (window.safePrintHTMLString) {
        window.safePrintHTMLString(html);
      } else if (window.safePrintHTMLStringWithPageNum) {
        window.safePrintHTMLStringWithPageNum(html);
      } else {
        const w = window.open('', '_blank');
        if (w) { w.document.write(html); w.document.close(); }
      }

    }catch(e){
      alert('Errore stampa ordine: ' + (e?.message||e));
    }
  };
})();

// ============= EXPORT CSV: Ordini Fornitori APERTI / PARZIALI =============
(function(){
  if (window.__ANIMA_APP_MOUNTED__) return;

  if (window.exportOrdiniApertiCSV) return;

  function statoAutoPerOrdine(o){
    const righe = o?.righe || [];
    if (!righe.length) return o.stato || 'Bozza';
    const totOrd = righe.reduce((s,r)=> s + Number(r.qta||0), 0);
    const totRx  = righe.reduce((s,r)=> s + Number(r.qtaRicevuta||0), 0);
    if (totOrd>0 && totRx>=totOrd) return 'Chiuso';
    if (totRx>0) return 'Parziale';
    return o.stato || 'Bozza';
  }

  window.exportOrdiniApertiCSV = function(){
    const rows = (function(){ try{ return JSON.parse(localStorage.getItem('ordiniFornitoriRows')||'[]')||[]; }catch{return[]} })();
    const out = [];
    // header (usa ; per compatibilità con virgola decimale)
    out.push([
      'ID','Data','Fornitore','Riferimento','ConsegnaPrevista','Stato',
      'Codice','Descrizione','UM','QtaOrd','QtaRicev','Residuo','Prezzo','TotRiga','Note'
    ].join(';'));

    rows.forEach(o=>{
      const stato = statoAutoPerOrdine(o);
      if (stato==='Chiuso' || stato==='Annullato') return; // solo Aperti/Parziali
      const fornitore = o.fornitoreRagione || o.fornitoreId || '';
      (o.righe||[]).forEach(r=>{
        const q   = Number(r.qta||0);
        const rx  = Number(r.qtaRicevuta||0);
        const res = Math.max(0, q-rx);
        const pr  = Number(r.prezzo||0);
        const tot = q*pr;
        out.push([
          o.id, o.data||'', fornitore, (o.rifOrdine||''), (o.consegnaPrevista||''), stato,
          (r.codice||''), (r.descr||''), (r.um||''),
          q, rx, res, pr, tot, (o.note||'')
        ].map(v => String(v).replace(/[\r\n]+/g,' ').replace(/;/g,',')).join(';'));
      });
    });

    const csv = out.join('\r\n');
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ymd = new Date().toISOString().slice(0,10).replace(/-/g,'');
    a.href = url;
    a.download = `ordini_aperti_parziali_${ymd}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 1200);
  };
})();

/* ================== AUTO-SCARICO + ETICHETTE COLLI (A4 landscape) ================== */

// — util locali (no conflitti) —
const _fmtIT = d => d ? new Date(d).toLocaleDateString('it-IT') : '';
const _todayISO = () => new Date().toISOString().slice(0,10);
function _s(v){ return String(v||'').replace(/[<>&]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[ch])); }

// commessa completa se: qtaProdotta >= qtaTotale E OGNI fase ha qtaProdotta >= qtaTotale
function isCommessaCompleta(c){
  const tot = Math.max(1, Number(c?.qtaPezzi||1));
  const prod = Number(c?.qtaProdotta||0);
  const fasiOk = Array.isArray(c?.fasi) ? c.fasi.every(f => Number(f?.qtaProdotta||0) >= tot) : true;
  return prod >= tot && fasiOk;
}

// scarico materiali: se riga materiale ha perPezzo===true scarico (qta*riga * qtaPezzi), altrimenti qta "totale commessa"
function scaricaMaterialiDaCommessa(c){
  try{
    const mats = Array.isArray(c?.materiali) ? c.materiali : [];
    if (!mats.length) return;

    const art = lsGet('magArticoli', []) || [];
    const mov = lsGet('magMovimenti', []) || [];
    try {
    if (typeof window.syncExportToCloudOnly === 'function') {
    window.syncExportToCloudOnly(['magMovimenti','magArticoli','commesseRows']);
    }
    } catch {}

    const qTot = Math.max(1, Number(c.qtaPezzi||1));
    const when = new Date().toISOString().slice(0,10);

    for (const m of mats){
      const codice = (m?.codice||'').trim(); if (!codice) continue;
      const perPezzo = !!m?.perPezzo;
      const q = Number(m?.qta||0);
      const qScarico = perPezzo ? q * qTot : q;
      if (!qScarico) continue;

      // aggiorna giacenza di magArticoli (facoltativo)
      const i = art.findIndex(a => (a?.codice||'') === codice);
      if (i >= 0) {
        art[i] = { ...art[i], giacenza: Number(art[i].giacenza||0) - qScarico };
      } else {
        art.push({ codice, descrizione:(m?.descrizione||m?.descr||''), um:(m?.um||''), giacenza: -qScarico });
      }

      // movimento FLAT compatibile
      const np = window.nextProgressivo('mag');
      mov.push({
        id: `MAG-${np.year}-${window.formatNNN(np.num)}`,
        data: when,
        tipo: 'SCARICO',
        codice,
        descrizione: (m?.descrizione||m?.descr||''),
        um: (m?.um||''),
        qta: -Math.abs(qScarico),
        commessaId: c.id,
        note: `Scarico commessa ${c.id}`
      });
    }

    lsSet('magMovimenti', mov);
    lsSet('magArticoli', art);
  }catch(e){ console.warn('scaricaMaterialiDaCommessa errore:', e); }
}

// etichette colli (una per pagina A4 orizzontale)
function buildEtichetteHTML(c, nColli){
  const cfg = (function(){ try{ return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; }catch{return{};} })();
  const azi = _s(cfg.companyName || cfg.ragioneSociale || 'Azienda');
  const addr = _s(cfg.companyAddress || cfg.sedeOperativa || cfg.sedeLegale || '');
  const piva = _s(cfg.companyVat || cfg.piva || '');
  const logo = cfg.logoDataUrl || '';

  const stile = `
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111}
    .page{page-break-after: always; display:flex; align-items:center; justify-content:center; height:100vh;}
    .label{border:2px solid #000; border-radius:12px; padding:16px 24px; width:90%; display:flex; gap:18px; align-items:center;}
    .logo{width:120px; height:80px; object-fit:contain; border:1px solid #eee; background:#fff}
    .h1{font-size:36px; font-weight:800; line-height:1.1}
    .h2{font-size:22px; font-weight:700}
    .muted{color:#555}
    .info{display:grid; grid-template-columns:1fr 1fr; gap:8px 24px; font-size:16px}
    .big{font-size:26px; font-weight:800}
  </style>`;

  const blocchi = [];
  const tot = Math.max(1, Number(nColli||1));
  const now = _fmtIT(new Date());

  for (let i=1; i<=tot; i++){
    blocchi.push(`
      <div class="page">
        <div class="label">
          ${logo ? `<img class="logo" src="${logo}" alt="logo" />` : ''}
          <div style="flex:1">
            <div class="h1">${azi}</div>
            <div class="muted">${addr}${addr && piva ? ' · ' : ''}${piva ? 'P.IVA '+piva : ''}</div>
            <div class="h2" style="margin-top:6px">COLLO ${i}/${tot}</div>
            <div class="info" style="margin-top:10px">
              <div><span class="muted">Cliente:</span> <span class="big">${_s(c?.cliente||'-')}</span></div>
              <div><span class="muted">Commessa:</span> <span class="big">${_s(c?.id||'-')}</span></div>
              <div><span class="muted">Articolo/Assieme:</span> ${_s(c?.descrizione||'-')}</div>
              <div><span class="muted">Consegna prevista:</span> ${_fmtIT(c?.scadenza)||'-'}</div>
              <div><span class="muted">Data stampa:</span> ${now}</div>
            </div>
          </div>
        </div>
      </div>`);
  }

  return `<!doctype html><html><head><meta charset="utf-8">${stile}</head><body>
    ${blocchi.join('\n')}
  </body></html>`;
}

function printEtichetteColli(c, nColli){
  const html = buildEtichetteHTML(c, nColli);
  safePrintHTMLString(html);
}
function openEtichetteColliDialog(c){
  try{
    let def = Number(c.colli||1);
    if (!Number.isFinite(def) || def < 1) def = 1;

    const ans = prompt(`Quanti colli ha la commessa ${c.id}?`, String(def));
    if (ans == null) return; // annullato

    const n = Math.max(1, Math.min(99, parseInt(ans||'1',10)));
    c.colli = n;

    // persisto il valore se la commessa esiste in archivio
    try{
      const all = lsGet('commesseRows', []);
      const ix = all.findIndex(x => x.id === c.id);
      if (ix >= 0){
        all[ix] = { ...all[ix], colli: n };
        lsSet('commesseRows', all);
        window.__anima_dirty = true;
      }
    }catch{}

    printEtichetteColli(c, n);
  }catch(e){
    console.warn('openEtichetteColliDialog error:', e);
  }
}

// Controllo fine-commessa: scarico + popup colli + stampa etichette (una volta sola)
function _maybeAutoScaricoAndLabels(jobId){
  try{
    const all = lsGet('commesseRows', []);
    const ix = all.findIndex(c => c.id === jobId);
    if (ix < 0) return;

    const c = { ...all[ix] };
    if (!isCommessaCompleta(c)) return; // <-- popup SOLO quando tutta la commessa è completa

    // eseguo una sola volta
    if (!c.scaricoDone){
      scaricaMaterialiDaCommessa(c);
      c.scaricoDone = true;
    }

    if (!c.labelsPrinted){
      let def = Number(c.colli||1);
      if (!Number.isFinite(def) || def < 1) def = 1;
      const ans = prompt(`Quanti colli ha la commessa ${c.id}?`, String(def));
      const n = Math.max(1, Math.min(99, parseInt(ans||'1',10)));
      c.colli = n;
      c.labelsPrinted = true;

      all[ix] = c;
      lsSet('commesseRows', all);
      window.__anima_dirty = true;

      printEtichetteColli(c, n);
    }
  }catch(e){ console.warn('_maybeAutoScaricoAndLabels errore:', e); }
}
window._maybeAutoScaricoAndLabels = window._maybeAutoScaricoAndLabels || _maybeAutoScaricoAndLabels;

/* ================== REGISTRAZIONI ORE (Locale + Cloud) ================== */
function RegistrazioniOreView({ query = '' }) {
  const e = React.createElement;

  // --- Helper tempo ---
  const toMin = (s) => {
    if (s == null) return 0;
    const str = String(s).trim();
    if (!str) return 0;
    const m = str.match(/^(\d{1,4})(?::([0-5]?\d))?$/);
    if (!m) return NaN;
    const h = parseInt(m[1],10) || 0;
    const mm = parseInt(m[2]||'0',10) || 0;
    return (h*60 + mm);
  };
  const fmtHHMMfromMin = (mins) => {
    const t = Math.max(0, Math.round(Number(mins) || 0));
    const h = Math.floor(t/60);
    const m = t%60;
    return `${h}:${String(m).padStart(2,'0')}`;
  };
  const todayISO = () => new Date().toISOString().slice(0,10);

  // --- Helper ID coerenti con Timbratura ---
  function formatNNN(n){ return String(n).padStart(3,'0'); }

  // Fallback robusto per progressivo "ore"
  function safeNextProgressivoOre(){
    try{
      if (typeof window.nextProgressivo === 'function'){
        const out = window.nextProgressivo('ore') || {};
        const y = Number(out.year) || (new Date().getFullYear());
        const n = Number(out.num);
        if (Number.isFinite(n) && n > 0) return { year: y, num: n };
      }
    }catch{}
    const year = (new Date()).getFullYear();
    let counters = {};
    try { counters = JSON.parse(localStorage.getItem('counters') || '{}') || {}; } catch {}
    let n = 1;
    if (counters.ore && counters.ore.year === year && Number.isFinite(Number(counters.ore.num))) {
      n = Number(counters.ore.num) + 1;
    }
    counters.ore = { year, num: n };
    try { localStorage.setItem('counters', JSON.stringify(counters)); } catch {}
    return { year, num: n };
  }

  // Wrapper: prova il nextProgressivo globale e valida, altrimenti fallback
  function getNextOreProgressivo(){
    try{
      if (typeof window.nextProgressivo === 'function'){
        const out = window.nextProgressivo('ore') || {};
        const y = Number(out.year) || (new Date().getFullYear());
        const n = Number(out.num);
        if (Number.isFinite(n) && n > 0) return { year: y, num: n };
      }
    }catch{}
    return safeNextProgressivoOre();
  }

  // Operatori (select se presenti in Impostazioni)
  function renderOperatoreField_Local(value, onChange){
    const app = (function(){ try{ return JSON.parse(localStorage.getItem('appSettings')||'{}'); }catch{return{}} })();
    const ops = Array.isArray(app.operators) ? app.operators.map(s=>String(s).trim()).filter(Boolean) : [];
    return ops.length
      ? e('select', {name:'operatore', value:value, onChange:onChange},
          e('option', {value:''}, '— seleziona —'),
          ...ops.map((op,i)=> e('option',{key:i, value:op}, op))
        )
      : e('input', {name:'operatore', value:value, onChange:onChange, placeholder:'es. Mario Rossi'});
  }

  // --- Supabase config (se presente) ---
  const sbCfg = (typeof getSB === 'function') && getSB();
  const sbOk = !!sbCfg;

  // --- Dati base ---
  const commesse = React.useMemo(()=>{ try{ return JSON.parse(localStorage.getItem('commesseRows')||'[]'); }catch{ return []; } }, []);

  // ===================== MODALITÀ LOCALE =====================
  const [rows, setRows] = React.useState(()=>{ try{ return JSON.parse(localStorage.getItem('oreRows')||'[]'); }catch{ return []; } });

  // Upgrade 1-shot: assegna __createdAt alle righe che non ce l'hanno
  React.useEffect(()=>{
    try{
      const arr = JSON.parse(localStorage.getItem('oreRows') || '[]') || [];
      let changed = false;
      arr.forEach((r, i) => {
        if (!r.__createdAt){
          const base = r.data ? (r.data + 'T00:00:00') : new Date().toISOString();
          const t = (Date.parse(base) || Date.now()) + (i * 1000);
          r.__createdAt = new Date(t).toISOString();
          changed = true;
        }
      });
      if (changed){
        localStorage.setItem('oreRows', JSON.stringify(arr));
        setRows(arr);
      }
    }catch{}
  }, []);

  React.useEffect(()=>{ try{ localStorage.setItem('oreRows', JSON.stringify(rows)); }catch{} }, [rows]);

  // --- Filtri condivisi (sia locale che cloud) ---
  const [flt, setFlt] = React.useState({ from:'', to:'', commessa:'', operatore:'', fase:'' });
  const opsImpostazioni = (function(){
    try{ const a = JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; return Array.isArray(a.operators)? a.operators.filter(Boolean):[]; }catch{return[]}
  })();
  const selCommessaFiltro = React.useMemo(()=> (commesse.find(c=>c.id===flt.commessa) || null), [commesse, flt.commessa]);
  const fasiFiltro = React.useMemo(()=> Array.isArray(selCommessaFiltro?.fasi) ? selCommessaFiltro.fasi : [], [selCommessaFiltro]);

  function inDateRangeISO(dateStr, from, to){
    const d = String(dateStr||'').slice(0,10);
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  }

  // form locale
  const [form, setForm] = React.useState({
    id: '',
    data: todayISO(),
    commessaId: '',
    faseIdx: '',
    operatore: '',
    oreHHMM: '1:00',
    qtaPezzi: '',
    note: ''
  });

  const selCommessaLoc = React.useMemo(
    ()=> (commesse.find(c=>c.id===form.commessaId) || null),
    [commesse, form.commessaId]
  );
  const fasiLoc = React.useMemo(()=> Array.isArray(selCommessaLoc?.fasi) ? selCommessaLoc.fasi : [], [selCommessaLoc]);

  function onChangeLocal(ev){
    const {name, value} = ev.target;
    setForm(p=>({...p, [name]: value}));
  }
  function validateLocal(){
    if(!form.data) return 'Data obbligatoria';
    if(!form.commessaId) return 'Seleziona una commessa';
    const mins = toMin(form.oreHHMM);
    if(!Number.isFinite(mins) || mins<=0) return 'Ore non valide (HH:MM > 0)';
    if(form.faseIdx!=='' && (Number(form.faseIdx)<0 || Number(form.faseIdx)>=fasiLoc.length)) return 'Fase non valida';
    return null;
  }
  function resetLocalForm(){
    setForm({
      id: '',
      data: todayISO(),
      commessaId: '',
      faseIdx: '',
      operatore: '',
      oreHHMM: '1:00',
      qtaPezzi: '',
      note: ''
    });
  }

  // Salva locale (assegna ID qui)
  function saveLocal(ev){
    ev.preventDefault();
    const err = validateLocal(); 
    if (err){ alert(err); return; }

    const oreMin = toMin(form.oreHHMM);
    const { year, num } = getNextOreProgressivo();
    const recId = `O-${year}-${String(num).padStart(3,'0')}`;

    const rec = {
      id: recId,
      ...form,
      faseIdx: (form.faseIdx === '' ? null : Number(form.faseIdx)),
      oreMin,
      ore: +(oreMin/60).toFixed(2),
      qtaPezzi: Math.max(0, Number(form.qtaPezzi||0)),
      __createdAt: new Date().toISOString()
    };

    // metto in testa così lo vedi subito
    setRows(prev => [rec, ...prev]);
    alert('Registrazione salvata in locale ✅');
    resetLocalForm();
  }

  function delLocal(r){
    if(!confirm(`Eliminare registrazione ${r.id}?`)) return;
    setRows(prev=> prev.filter(x=>x.id!==r.id));
  }

  // ===================== MODALITÀ CLOUD (SUPABASE) =====================
  const [mode, setMode] = React.useState(sbOk ? 'cloud' : 'local'); // 'cloud' | 'local'
  const [cloudRows, setCloudRows] = React.useState([]);
  const [cloudLoading, setCloudLoading] = React.useState(false);

  async function loadCloud(){
    if(!sbOk) return;
    try{
      setCloudLoading(true);
      const sb = getSB();
      const url = `${sb.url}/rest/v1/timesheets?select=*&order=created_at.desc`;
      const res = await fetch(url, { headers:{ apikey: sb.key, Authorization:`Bearer ${sb.key}` } });
      if(!res.ok){
        const t = await res.text();
        throw new Error(`HTTP ${res.status} – ${t || res.statusText}`);
      }
      const data = await res.json();
      setCloudRows(Array.isArray(data)?data:[]);
    }catch(err){
      console.error('[loadCloud]', err);
      alert('Errore caricamento cloud: ' + (err?.message || err));
    }finally{
      setCloudLoading(false);
    }
  }
  React.useEffect(()=>{ if(sbOk){ loadCloud(); } }, [sbOk]);

  // === Watermark (ISO) & dedup ID importati ===
function _getWMISO(key){
  try{
    const raw = JSON.parse(localStorage.getItem(key)||'{}');
    if (!raw || !raw.ts) return '1970-01-01T00:00:00Z';
    return Number.isFinite(raw.ts) ? new Date(raw.ts).toISOString() : String(raw.ts);
  }catch{ return '1970-01-01T00:00:00Z'; }
}
function _setWMISO(key, isoOrMs){
  try{
    const iso = Number.isFinite(isoOrMs) ? new Date(isoOrMs).toISOString() : String(isoOrMs);
    localStorage.setItem(key, JSON.stringify({ ts: iso }));
  }catch{}
}
function _getImportedCloudIds(){
  try{ return new Set(JSON.parse(localStorage.getItem('ORE_CLOUD_IMPORTED_IDS')||'[]')); }catch{ return new Set(); }
}
function _saveImportedCloudIds(set){
  try{ localStorage.setItem('ORE_CLOUD_IMPORTED_IDS', JSON.stringify(Array.from(set))); }catch{}
}

  // Import nuove dal Cloud (accetta {silent:true} per non mostrare alert)
  async function importNewFromCloud(opts={}) {
  const silent = !!opts.silent;
  if(!sbOk){ if(!silent) alert('Configura Supabase in Impostazioni.'); return 0; }
  try{
    const sb = getSB();
    const WM_KEY = 'ORE_CLOUD_WM';
    const wmIso = _getWMISO(WM_KEY);
    const url = `${sb.url}/rest/v1/timesheets?select=*&order=created_at.asc&created_at=gt.${encodeURIComponent(wmIso)}&limit=1000`;
    const res = await fetch(url, { headers:{ apikey: sb.key, Authorization:`Bearer ${sb.key}` } });
    if(!res.ok){ throw new Error(await res.text()); }
    const data = await res.json();


          if(!Array.isArray(data) || data.length===0){
      if(!silent) alert('Nessuna novità dal cloud.');
      return 0;
    }

    const base = (function(){ try{ return JSON.parse(localStorage.getItem('oreRows')||'[]'); }catch{return []} })();
    const importedIds = _getImportedCloudIds();
    let maxIso = wmIso;
    const toAdd = [];

    for(const r of data){
      const cloudId = r.id; // PK/UUID su timesheets
      if (cloudId && importedIds.has(cloudId)) {
        if (r.created_at && r.created_at > maxIso) maxIso = r.created_at;
        continue;
      }
      const oreMin = Number(r.minutes||0);
      const { year, num } = getNextOreProgressivo();
      const rec = {
        id: `O-${year}-${String(num).padStart(3,'0')}`,
        data: String(r.created_at||'').slice(0,10),
        commessaId: r.commessa_id || '',
        faseIdx: (r.fase_idx==null ? null : Number(r.fase_idx)),
        operatore: r.operatore || '',
        oreHHMM: fmtHHMMfromMin(oreMin),
        note: r.note || '',
        oreMin,
        ore: +((oreMin||0)/60).toFixed(2),
        __createdAt: new Date(r.created_at || Date.now()).toISOString()
      };
      toAdd.push(rec);
      if (cloudId) importedIds.add(cloudId);
      if (r.created_at && r.created_at > maxIso) maxIso = r.created_at;
    }

    if(toAdd.length===0){
      if(!silent) alert('Nessuna nuova timbratura (tutte già importate).');
      return 0;
    }

    setRows(prev => [...prev, ...toAdd]);
    _saveImportedCloudIds(importedIds);
    _setWMISO(WM_KEY, maxIso);

    if(!silent) alert(`Importate ${toAdd.length} timbrature dal cloud ✅`);
    return toAdd.length;
    }catch(err){
      console.error('[importNewFromCloud]', err);
      if(!silent) alert('Errore import dal cloud: ' + (err?.message || err));
      return 0;
    }
  }

  // Flag vista aperta + auto ricezione silenziosa ogni 15s quando in CLOUD
  React.useEffect(()=>{
    window.__O_PAGE_ACTIVE = true;
    return ()=>{ window.__O_PAGE_ACTIVE = false; };
  },[]);
  React.useEffect(()=>{
    if (mode!=='cloud' || !sbOk) return;
    let stop=false, t=null;
    const tick = async ()=>{
      if (stop || !window.__O_PAGE_ACTIVE) return;
      try{ await importNewFromCloud({silent:true}); }catch{}
      t = setTimeout(tick, 15000);
    };
    t = setTimeout(tick, 15000);
    return ()=>{ stop=true; if(t) clearTimeout(t); };
  }, [mode, sbOk]);

  // ===== Filtri applicati =====
  const q = (query||'').toLowerCase();

  // Locale filtrato + ordinato (più recente in alto)
  const rowsFiltrateLocal = rows
    .filter(r => {
      // filtri
      if (flt.from || flt.to) {
        if (!inDateRangeISO(r.data, flt.from, flt.to)) return false;
      }
      if (flt.commessa && r.commessaId !== flt.commessa) return false;
      if (flt.operatore && String(r.operatore||'') !== flt.operatore) return false;
      if (flt.fase === 'extra') {
        if (r.faseIdx != null) return false;
      } else if (flt.fase !== '' && flt.fase != null) {
        if (r.faseIdx == null || String(r.faseIdx) !== String(flt.fase)) return false;
      }
      // ricerca libera
      return (r.id+' '+r.commessaId+' '+(r.operatore||'')+' '+(r.note||'')).toLowerCase().includes(q);
    })
    .sort((a,b)=>{
      const ta = Date.parse(a.__createdAt || (a.data ? (a.data + 'T00:00:00') : 0)) || 0;
      const tb = Date.parse(b.__createdAt || (b.data ? (b.data + 'T00:00:00') : 0)) || 0;
      if (tb !== ta) return tb - ta;
      const ra = String(a.id||'').match(/^O-(\d{4})-(\d{1,})$/);
      const rb = String(b.id||'').match(/^O-(\d{4})-(\d{1,})$/);
      if (ra && rb){
        const ya = +ra[1], na = +ra[2];
        const yb = +rb[1], nb = +rb[2];
        if (yb !== ya) return yb - ya;
        if (nb !== na) return nb - na;
      }
      return String(b.id||'').localeCompare(String(a.id||''));
    });

  // Cloud filtrato
  const rowsFiltrateCloud = (cloudRows||[]).filter(r=>{
    const d = String(r.created_at||'').slice(0,10);
    if (flt.from || flt.to){
      if (!inDateRangeISO(d, flt.from, flt.to)) return false;
    }
    if (flt.commessa && (r.commessa_id||'') !== flt.commessa) return false;
    if (flt.operatore && String(r.operatore||'') !== flt.operatore) return false;
    if (flt.fase === 'extra') {
      if (r.fase_idx != null) return false;
    } else if (flt.fase !== '' && flt.fase != null) {
      if (r.fase_idx == null || String(r.fase_idx) !== String(flt.fase)) return false;
    }
    const s = (r.commessa_id+' '+(r.operatore||'')+' '+(r.note||'')+' '+(r.created_at||'')).toLowerCase();
    return s.includes(q);
  });

  // Totale minuti EXTRA "Cambio Bombola Gas" sul dataset visibile
  function isGasNote(t){ return /cambio\s*bombola\s*gas/i.test(String(t||'')); }
  const extraLocalMin = rowsFiltrateLocal.reduce((s,r)=>{
    const mins = Number(r.oreMin)||toMin(r.oreHHMM)||0;
    return s + ((r.faseIdx==null && isGasNote(r.note)) ? mins : 0);
  }, 0);
  const extraCloudMin = rowsFiltrateCloud.reduce((s,r)=>{
    const mins = Number(r.minutes)||0;
    return s + ((r.fase_idx==null && isGasNote(r.note)) ? mins : 0);
  }, 0);

  // Export CSV locale
  function exportCSVLocal(){
    const header = ['ID','Data','Commessa','Fase','Operatore','Ore (HH:MM)','Minuti','Qta','Note'];
    const body = rowsFiltrateLocal.map(r => {
      const c = commesse.find(x=>x.id===r.commessaId);
      const faseLab = (function(){
        if (r.faseIdx==null) return '';
        if (typeof window.faseLabel === 'function') return window.faseLabel(c, Number(r.faseIdx));
        const f = c && Array.isArray(c?.fasi) ? c.fasi[r.faseIdx|0] : null;
        return (f && f.lav) ? f.lav : `Fase ${(r.faseIdx|0)+1}`;
      })();
      return [
        r.id, r.data, r.commessaId, faseLab,
        r.operatore||'',
        r.oreHHMM||fmtHHMMfromMin(r.oreMin||0),
        String(r.oreMin||0),
        String(r.qtaPezzi||0),
        r.note||''
      ];
    });
    const csv = [header, ...body].map(row =>
      row.map(v => {
        const s = String(v==null?'':v);
        return /[;"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
      }).join(';')
    ).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download = 'registrazioni_ore_locale.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Export CSV cloud
  function exportCSVCloud(){
    const header = ['ID','Created at','Commessa','Fase','Operatore','Minuti','HH:MM','Note'];
    const body = rowsFiltrateCloud.map(r => [
      r.id, r.created_at, r.commessa_id || '',
      (function(){
        if (r.fase_idx==null) return '';
        const c = commesse.find(x=>x.id===r.commessa_id);
        const f = c && Array.isArray(c?.fasi) ? c.fasi[r.fase_idx|0] : null;
        return (f && f.lav) ? f.lav : `Fase ${(r.fase_idx|0)+1}`;
      })(),
      r.operatore || '', String(r.minutes||0),
      fmtHHMMfromMin(r.minutes||0), r.note || ''
    ]);
    const csv = [header, ...body].map(row =>
      row.map(v => {
        const s = String(v==null?'':v);
        return /[;"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
      }).join(';')
    ).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download = 'registrazioni_ore_cloud.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ===== UI =====
  return e('div', {className:'grid', style:{gap:16}},

    // Switch sorgente (HEADER)
    e('div', {className:'card'},
      e('div', {className:'actions', style:{justifyContent:'space-between'}},
        e('div', {className:'row', style:{gap:8}},
          e('button', {
            className: mode==='cloud' ? 'btn' : 'btn btn-outline',
            onClick: ()=> setMode('cloud'),
            disabled: !sbOk
          }, 'Sorgente: Cloud'),
          e('button', {
            className: mode==='local' ? 'btn' : 'btn btn-outline',
            onClick: ()=> setMode('local')
          }, 'Sorgente: Locale')
        ),
        (mode==='cloud'
          ? e('div', {className:'row', style:{gap:8, alignItems:'center'}},
              e('span', {className:'muted'}, `Extra gas visibili: ${fmtHHMMfromMin(extraCloudMin)}`),
              e('button', {className:'btn', onClick:loadCloud, disabled:!sbOk || cloudLoading},
                cloudLoading?'Carico…':'Aggiorna'
              ),
              rowsFiltrateCloud.length>0 && e('button', {className:'btn btn-outline', onClick:exportCSVCloud}, 'Esporta CSV'),
              e('button', {className:'btn btn-outline', onClick:()=>importNewFromCloud({silent:false})}, 'Importa nuove dal Cloud')
            )
          : e('div', {className:'row', style:{gap:8, alignItems:'center'}},
              e('span', {className:'muted'}, `Extra gas visibili: ${fmtHHMMfromMin(extraLocalMin)}`),
              rowsFiltrateLocal.length>0 && e('button', {className:'btn btn-outline', onClick:exportCSVLocal}, 'Esporta CSV')
            )
        )
      )
    ),

    // PANNELLO FILTRI
    e('div', {className:'card'},
      e('div', {className:'row', style:{gap:12, alignItems:'end'}},
        e('div', null, e('label', null, 'Dal'),
          e('input', {type:'date', value:flt.from, onChange:ev=>setFlt(p=>({...p, from: ev.target.value}))})
        ),
        e('div', null, e('label', null, 'Al'),
          e('input', {type:'date', value:flt.to, onChange:ev=>setFlt(p=>({...p, to: ev.target.value}))})
        ),
        e('div', null, e('label', null, 'Commessa'),
          e('select', {value:flt.commessa, onChange:ev=>setFlt(p=>({...p, commessa: ev.target.value, fase:''}))},
            e('option', {value:''}, '— tutte —'),
            commesse.map(c => e('option', {key:c.id, value:c.id}, c.id + (c.descrizione? (' • '+c.descrizione):'')))
          )
        ),
        e('div', null, e('label', null, 'Operatore'),
          e('select', {value:flt.operatore, onChange:ev=>setFlt(p=>({...p, operatore: ev.target.value}))},
            e('option', {value:''}, '— tutti —'),
            opsImpostazioni.map((op,i)=> e('option', {key:i, value:op}, op))
          )
        ),
        e('div', null, e('label', null, 'Fase'),
          e('select', {value:flt.fase, onChange:ev=>setFlt(p=>({...p, fase: ev.target.value}))},
            e('option', {value:''}, '— tutte —'),
            e('option', {value:'extra'}, 'Solo EXTRA'),
            ...(fasiFiltro||[]).map((f,idx)=> e('option', {key:idx, value:String(idx)},
              (typeof window.faseLabel==='function' ? window.faseLabel(selCommessaFiltro, idx) : `Fase ${idx+1}`)
            ))
          )
        ),
        e('div', {className:'actions'},
          e('button', {className:'btn btn-outline', onClick:()=>setFlt({from:'',to:'',commessa:'',operatore:'',fase:''})}, 'Pulisci filtri')
        )
      )
    ),

    // ======= CLOUD =======
    (mode==='cloud') && e('div', {className:'grid', style:{gap:16}},
      // Form cloud (semplice)
      e('div', {className:'card'},
        e('h3', {style:{marginBottom:8}}, 'Nuova/modifica timbratura (cloud)'),
        e('div', {className:'muted'}, 'Inserimento diretto nel cloud. Per ora lasciamo solo import/lettura come flusso principale.')
      ),

      // Elenco cloud
      e('div', {className:'card'},
        e('div', {className:'actions', style:{justifyContent:'space-between', marginBottom:8}},
          e('h3', null, 'Timbrature (cloud, filtrate)'),
          e('span', {className:'muted'}, `${rowsFiltrateCloud.length} record`)
        ),
        (rowsFiltrateCloud.length===0)
          ? e('div', {className:'muted'}, sbOk ? (cloudLoading ? 'Caricamento…' : 'Nessuna timbratura') : 'Configura Supabase in Impostazioni')
          : e('table', {className:'table'},
              e('thead', null,
                e('tr', null,
                  e('th', null, 'Data'),
                  e('th', null, 'Commessa'),
                  e('th', null, 'Fase'),
                  e('th', null, 'Operatore'),
                  e('th', {className:'right'}, 'Min'),
                  e('th', {className:'right'}, 'HH:MM'),
                  e('th', null, 'Note')
                )
              ),
              e('tbody', null,
                rowsFiltrateCloud.map(r => e('tr', {key:r.id},
                  e('td', null, new Date(r.created_at).toLocaleString('it-IT')),
                  e('td', null, r.commessa_id || '—'),
                  e('td', null, (function(){
                    if (r.fase_idx==null) return '—';
                    const c = commesse.find(x=>x.id===r.commessa_id);
                    const f = c && Array.isArray(c.fasi) ? c.fasi[r.fase_idx|0] : null;
                    return (f && f.lav) ? f.lav : `Fase ${(r.fase_idx|0)+1}`;
                  })() ),
                  e('td', null, r.operatore || '—'),
                  e('td', {className:'right'}, String(r.minutes||0)),
                  e('td', {className:'right'}, fmtHHMMfromMin(r.minutes||0)),
                  e('td', null, r.note || ' ')
                ))
              )
            )
      )
    ),

    // ======= LOCALE =======
    (mode==='local') && e('div', {className:'grid', style:{gap:16}},
      // Form locale
      e('div', {className:'card'},
        e('h3', {style:{marginBottom:8}}, 'Nuova registrazione ore (locale)'),
        e('form', {className:'form', onSubmit:saveLocal},
          e('div', null, e('label', null, 'Data'),
            e('input', {type:'date', name:'data', value:form.data, onChange:onChangeLocal})
          ),
          e('div', null, e('label', null, 'Commessa'),
            e('select', {name:'commessaId', value:form.commessaId, onChange:onChangeLocal},
              e('option', {value:''}, '— seleziona —'),
              commesse.map(c => e('option', {key:c.id, value:c.id}, `${c.id} • ${c.cliente||''} • ${c.descrizione||''}`))
            )
          ),
          e('div', null, e('label', null, 'Fase (opzionale)'),
            e('select', {name:'faseIdx', value:form.faseIdx, onChange:onChangeLocal, disabled:!selCommessaLoc || fasiLoc.length===0},
              e('option', {value:''}, '— intera commessa —'),
              fasiLoc.map((f,idx)=> e('option', { key:idx, value:String(idx) }, (typeof window.faseLabel==='function'? window.faseLabel(selCommessaLoc, idx):`Fase ${idx+1}`)))
            )
          ),
          e('div', null,
            e('label', null, 'Operatore'),
            renderOperatoreField_Local(form.operatore, onChangeLocal)
          ),
          e('div', null, e('label', null, 'Ore (HH:MM)'),
            e('input', {name:'oreHHMM', value:form.oreHHMM, onChange:onChangeLocal, placeholder:'es. 1:30'})
          ),
          e('div', null, e('label', null, 'Quantità (pezzi)'),
            e('input', {name:'qtaPezzi', type:'number', min:'0', step:'1', value:form.qtaPezzi||'', onChange:onChangeLocal})
          ),
          e('div', {style:{gridColumn:'1 / -1'}}, e('label', null, 'Note'),
            e('textarea', {name:'note', value:form.note, onChange:onChangeLocal})
          ),
          e('div', {className:'actions', style:{gridColumn:'1 / -1', justifyContent:'flex-end'}},
            e('button', {className:'btn'}, 'Salva registrazione (locale)')
          )
        )
      ),

      // Elenco locale
      e('div', {className:'card'},
        e('div', {className:'actions', style:{justifyContent:'space-between', marginBottom:8}},
          e('h3', null, 'Registrazioni recenti (locale, filtrate)'),
          e('span', {className:'muted'}, `${rowsFiltrateLocal.length} record`)
        ),
        rowsFiltrateLocal.length===0
          ? e('div', {className:'muted'}, 'Nessuna registrazione')
          : e('table', {className:'table'},
              e('thead', null,
                e('tr', null,
                  e('th', null, 'ID'),
                  e('th', null, 'Data'),
                  e('th', null, 'Commessa'),
                  e('th', null, 'Fase'),
                  e('th', null, 'Operatore'),
                  e('th', {className:'right'}, 'Ore (HH:MM)'),
                  e('th', {className:'right'}, 'Qta'),
                  e('th', null, 'Note'),
                  e('th', null, 'Azioni')
                )
              ),
              e('tbody', null,
                rowsFiltrateLocal.map((r,i)=>{
                  const c = commesse.find(x=>x.id===r.commessaId);
                  const faseLab = (function(){
                    if (r.faseIdx==null) return '—';
                    const f = c && Array.isArray(c?.fasi) ? c.fasi[r.faseIdx|0] : null;
                    if (typeof window.faseLabel === 'function') return window.faseLabel(c, Number(r.faseIdx));
                    return (f && f.lav) ? f.lav : `Fase ${(r.faseIdx|0)+1}`;
                  })();
                  return e('tr', {key:r.id||i},
                    e('td', null, r.id),
                    e('td', null, r.data),
                    e('td', null, r.commessaId),
                    e('td', null, faseLab || '—'),
                    e('td', null, r.operatore || '—'),
                    e('td', {className:'right'}, r.oreHHMM || fmtHHMMfromMin(r.oreMin||0)),
                    e('td', {className:'right'}, String(r.qtaPezzi||0)),
                    e('td', null, r.note || ' '),
                    e('td', null, e('button', {className:'btn btn-outline', onClick:()=>delLocal(r)}, '🗑'))
                  );
                })
              )
            )
      )
    )
  );
}
window.RegistrazioniOreView = RegistrazioniOreView;

  // === Aggregatore per ReportTempi (per riga o per fase) ===
window.__rpt_groupBy = window.__rpt_groupBy || function(oreRows, { byRiga=false, onlyCommessaId=null } = {}) {
  try {
    const arr = Array.isArray(oreRows) ? oreRows : [];
    const rows = onlyCommessaId ? arr.filter(r => String(r.commessaId) === String(onlyCommessaId)) : arr;
    const map = new Map();

    const toMin = (s) => {
      if (s == null) return 0;
      const m = String(s).trim().match(/^(\d{1,4})(?::([0-5]?\d))?$/);
      if (!m) return 0;
      const h = parseInt(m[1]||'0',10)||0;
      const mm = parseInt(m[2]||'0',10)||0;
      return h*60+mm;
    };

    for (const r of rows) {
      const key = byRiga
        ? `${r.commessaId}|${r.rigaIdx ?? ''}|${r.rigaCodice ?? ''}`
        : `${r.commessaId}|${r.faseIdx ?? ''}`;

      const cur = map.get(key) || {
        commessaId: r.commessaId || '',
        rigaIdx: (r.rigaIdx == null ? null : Number(r.rigaIdx)),
        rigaCodice: r.rigaCodice || '',
        rigaDescrizione: r.rigaDescrizione || '',
        rigaUM: r.rigaUM || '',
        pezzi: 0,
        oreMin: 0,
        oreHHMM: '0:00'
      };

      const addMin = (Number(r.oreMin) || 0) || toMin(r.oreHHMM);
      cur.pezzi += Math.max(0, Number(r.qtaPezzi||r.pezzi||0));
      cur.oreMin += addMin;
      // aggiorna HH:MM
      const t = Math.max(0, Math.round(cur.oreMin));
      const h = Math.floor(t/60), m = t%60;
      cur.oreHHMM = `${h}:${String(m).padStart(2,'0')}`;

      map.set(key, cur);
    }
    return Array.from(map.values());
  } catch(e) {
    console.warn('__rpt_groupBy error', e);
    return [];
  }
};


/* ================== REPORT TEMPI (PIANIFICATE vs EFFETTIVE + ORE PER FASE) ================== */
// [RPT] Helper aggregazione per riga articolo (idempotente)
window.__rpt_groupBy = window.__rpt_groupBy || function(oreRows, { byRiga = false, onlyCommessaId = null } = {}) {
  const out = [];
  const map = new Map();
  const toMin = (x) => {
    if (x == null) return 0;
    if (typeof x === 'number') return Math.max(0, x|0);
    const s = String(x).trim();
    const m = s.match(/^(\d{1,4}):([0-5]\d)$/);
    if (m) return (parseInt(m[1],10)||0)*60 + (parseInt(m[2],10)||0);
    const n = Number(s);
    return Number.isFinite(n) ? Math.max(0, n|0) : 0;
  };

  for (const r of (Array.isArray(oreRows) ? oreRows : [])) {
    const commessaId = String(r?.commessaId || '').trim();
    if (!commessaId) continue;
    if (onlyCommessaId && commessaId !== onlyCommessaId) continue;

    const idx = (r?.rigaIdx != null ? String(r.rigaIdx) : '');
    const kRiga = byRiga ? [idx, r?.rigaCodice||'', r?.rigaDescrizione||'', r?.rigaUM||''].join('|') : '';
    const key = commessaId + '|' + kRiga;

    const prev = map.get(key) || {
      commessaId,
      rigaIdx: (r?.rigaIdx != null ? Number(r.rigaIdx) : null),
      rigaCodice: r?.rigaCodice || '',
      rigaDescrizione: r?.rigaDescrizione || '',
      rigaUM: r?.rigaUM || '',
      oreMin: 0,
      pezzi: 0,
      rows: 0
    };

    prev.oreMin += toMin(r?.oreMin) || toMin(r?.minuti) || toMin(r?.minutes) || toMin(r?.oreHHMM);
    prev.pezzi  += Math.max(0, Number(r?.qtaPezzi || 0));
    prev.rows   += 1;
    map.set(key, prev);
  }

  for (const v of map.values()) {
    const h = Math.floor(v.oreMin/60), m = v.oreMin%60;
    v.oreHHMM = `${h}:${String(m).padStart(2,'0')}`;
    out.push(v);
  }
  out.sort((a,b)=>{
    if (a.commessaId !== b.commessaId) return a.commessaId < b.commessaId ? -1 : 1;
    return (a.rigaIdx??-1) - (b.rigaIdx??-1);
  });
  return out;
};

// === Helper aggregazione per Report Tempi (per riga articolo o intera commessa) ===
window.__rpt_groupBy = function(oreRowsAll, { byRiga=false, onlyCommessaId=null } = {}){
  let rows = Array.isArray(oreRowsAll) ? oreRowsAll : [];
  if (onlyCommessaId) {
    rows = rows.filter(r => String(r?.commessaId||'') === String(onlyCommessaId));
  }

  // Indici veloci
  const commesse = (function(){ try {return JSON.parse(localStorage.getItem('commesseRows')||'[]');} catch {return [];} })();
  const commById = new Map(commesse.map(c => [String(c.id), c]));

  // Somma minuti (accetta più formati)
  const toMin = (s) => {
    if (s == null) return 0;
    const t = String(s).trim();
    const m = t.match(/^(\d{1,4})(?::([0-5]?\d))?$/);
    if (!m) return Math.max(0, Number(t) || 0);
    const h = parseInt(m[1]||'0',10)||0, mm = parseInt(m[2]||'0',10)||0;
    return h*60+mm;
  };

  const keyOf = (r) => {
    const cid = String(r?.commessaId||'');
    if (!byRiga) return `C:${cid}`;
    const idx = (r?.rigaIdx==='' || r?.rigaIdx==null) ? 'ALL' : String(r.rigaIdx|0);
    return `C:${cid}|R:${idx}`;
  };

  const map = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const cur = map.get(k) || {
      commessaId: String(r?.commessaId||''),
      rigaIdx: (r?.rigaIdx===''||r?.rigaIdx==null) ? null : (r.rigaIdx|0),
      rigaCodice: r?.rigaCodice || '',
      rigaDescrizione: r?.rigaDescrizione || '',
      rigaUM: r?.rigaUM || '',
      pezzi: 0,
      oreMin: 0
    };
    cur.pezzi += Math.max(0, Number(r?.qtaPezzi||0));
    cur.oreMin += (Number(r?.oreMin)||toMin(r?.oreHHMM)||0);
    map.set(k, cur);
  }

  // Calcola HH:MM e arricchisce con info commessa
  const out = [];
  for (const v of map.values()) {
    const c = commById.get(v.commessaId) || {};
    const ore = Math.floor(v.oreMin/60);
    const min = v.oreMin % 60;
    out.push({
      commessaId: v.commessaId,
      cliente: c?.cliente || '',
      descrizione: c?.descrizione || '',
      rigaIdx: v.rigaIdx,
      rigaCodice: v.rigaCodice,
      rigaDescrizione: v.rigaDescrizione,
      rigaUM: v.rigaUM || (Array.isArray(c?.righeArticolo) && typeof v.rigaIdx==='number' ? (c.righeArticolo[v.rigaIdx]?.um || '') : ''),
      pezzi: v.pezzi,
      oreMin: v.oreMin,
      oreHHMM: `${ore}:${String(min).padStart(2,'0')}`
    });
  }

  // Ordina: commessa → riga
  out.sort((a,b) => (String(a.commessaId).localeCompare(String(b.commessaId)) || ((a.rigaIdx??99) - (b.rigaIdx??99))));
  return out;
};

// === Aggregatore Report per righe articolo (idempotente) ===
window.__rpt_groupBy = window.__rpt_groupBy || function __rpt_groupBy(oreRows, opts = {}){
  const byRiga = !!opts.byRiga;
  const onlyCommessaId = opts.onlyCommessaId ? String(opts.onlyCommessaId) : null;

  const toMin = (s) => {
    if (s == null) return 0;
    const t = String(s).trim();
    const m = t.match(/^(\d{1,4})(?::([0-5]?\d))?$/);
    if (!m) return Math.max(0, Number(t) || 0);
    const h = parseInt(m[1] || '0', 10) || 0;
    const mm = parseInt(m[2] || '0', 10) || 0;
    return h * 60 + mm;
  };
  const fmt = (mins) => {
    const t = Math.max(0, Math.round(Number(mins)||0));
    const h = Math.floor(t/60), m = t%60;
    return `${h}:${String(m).padStart(2,'0')}`;
  };

  const map = new Map();
  for (const r of (Array.isArray(oreRows) ? oreRows : [])) {
    const cid = String(r?.commessaId || '');
    if (!cid) continue;
    if (onlyCommessaId && cid !== onlyCommessaId) continue;

    const idxRaw = (r?.rigaIdx === '' || r?.rigaIdx == null) ? null : Number(r.rigaIdx);
    const key = byRiga ? `${cid}|${idxRaw==null? 'all' : idxRaw}` : cid;

    const cur = map.get(key) || {
      commessaId: cid,
      rigaIdx: (byRiga ? (idxRaw==null ? null : idxRaw) : null),
      rigaCodice: '',
      rigaDescrizione: '',
      rigaUM: '',
      oreMin: 0,
      oreHHMM: '0:00',
      pezzi: 0
    };

    // minuti: prova numerico, poi HH:MM
    const addMin = (Number(r.oreMin) || 0) || toMin(r.oreHHMM || 0);
    cur.oreMin += Math.max(0, addMin);
    cur.oreHHMM = fmt(cur.oreMin);

    // pezzi (se presenti nelle timbrature)
    cur.pezzi += Math.max(0, Number(r.qtaPezzi || 0));

    // metadati riga, se presenti
    if (r.rigaCodice && !cur.rigaCodice) cur.rigaCodice = String(r.rigaCodice);
    if (r.rigaDescrizione && !cur.rigaDescrizione) cur.rigaDescrizione = String(r.rigaDescrizione);
    if (r.rigaUM && !cur.rigaUM) cur.rigaUM = String(r.rigaUM);

    map.set(key, cur);
  }

  return Array.from(map.values())
    .sort((a,b) => (a.commessaId.localeCompare(b.commessaId)
        || String(a.rigaIdx??'').localeCompare(String(b.rigaIdx??''))));
};

function ReportTempiView({ query = '' }) {
  const e = React.createElement;
  // == Raggruppo per riga articolo ==
  const [groupByRiga, setGroupByRiga] = React.useState(false);
  const [commessaFilter, setCommessaFilter] = React.useState('');
  const oreRowsAll = React.useMemo(() => {
    try { return JSON.parse(localStorage.getItem('oreRows') || '[]'); } catch { return []; }
  }, []);
  const aggRows = React.useMemo(() => (
    window.__rpt_groupBy(oreRowsAll, { byRiga: groupByRiga, onlyCommessaId: commessaFilter || null })
  ), [oreRowsAll, groupByRiga, commessaFilter]);
  const commesseIds = React.useMemo(() => {
    return Array.from(new Set((oreRowsAll||[]).map(r => r?.commessaId).filter(Boolean))).sort();
  }, [oreRowsAll]);

function isGasNote(t){ return /cambio\s*bombola\s*gas/i.test(String(t||'')); }

  // Helper tempo
  const toMin = (s) => {
    if (s == null) return 0;
    const str = String(s).trim();
    if (!str) return 0;
    const m = str.match(/^(\d{1,4})(?::([0-5]?\d))?$/);
    if (!m) return 0;
    const h = parseInt(m[1],10) || 0;
    const mm = parseInt(m[2]||'0',10) || 0;
    return (h*60 + mm);
  };
  const fmt = (mins) => {
    const t = Math.max(0, Math.round(Number(mins)||0));
    const h = Math.floor(t/60), m = t%60;
    return `${h}:${String(m).padStart(2,'0')}`;
  };

  // Dati
  const commesse = React.useMemo(()=>{ try{ return JSON.parse(localStorage.getItem('commesseRows')||'[]'); }catch{ return []; } },[]);
  const oreRows  = React.useMemo(()=>{ try{ return JSON.parse(localStorage.getItem('oreRows')||'[]'); }catch{ return []; } },[]);

  // ---- Report 1: Pianificate vs Effettive (fix + % scostamento) ----
function plannedMinPerPiece(c){
  const fasi = Array.isArray(c.fasi) ? c.fasi : [];
  if (fasi.length === 0){
    // se non ci sono fasi: interpreta oreMin/oreHHMM come tempo per pezzo
    const perPiece = (typeof c.oreMin==='number' ? c.oreMin : toMin(c.oreHHMM||'0')) || 0;
    return Math.max(0, Math.round(perPiece));
  }
  let perPiece = 0;
  let unaTantum = 0;
  for (const f of fasi){
    const min = (typeof f.oreMin==='number' ? f.oreMin : toMin(f.oreHHMM||'0')) || 0;
    if (f.unaTantum || f.once) unaTantum += min; else perPiece += min;
  }
  // unaTantum NON è per pezzo; qui ritorniamo solo la parte per pezzo
  return Math.max(0, Math.round(perPiece));
}
function plannedMinTotal(c){
  const fasi = Array.isArray(c.fasi) ? c.fasi : [];
  const q = Math.max(1, Number(c.qtaPezzi||1));
  if (fasi.length === 0){
    // senza fasi: oreMin/oreHHMM * quantità
    const perPiece = (typeof c.oreMin==='number' ? c.oreMin : toMin(c.oreHHMM||'0')) || 0;
    return Math.max(0, Math.round(perPiece * q));
  }
  let perPiece = 0, unaTantum = 0;
  for (const f of fasi){
    const min = (typeof f.oreMin==='number' ? f.oreMin : toMin(f.oreHHMM||'0')) || 0;
    if (f.unaTantum || f.once) unaTantum += min; else perPiece += min;
  }
  return Math.max(0, Math.round(unaTantum + perPiece * q));
}

const righe = React.useMemo(()=>{
  const out = [];
  for (const c of (Array.isArray(commesse)?commesse:[])) {
    const perPezzo = plannedMinPerPiece(c);
    const pianTot  = plannedMinTotal(c);
    const effMin   = (Array.isArray(oreRows)?oreRows:[])
    .filter(o => o.commessaId === c.id && o.faseIdx != null)
    .reduce((s,o)=> s + (
      (Number(o.oreMin)||0) ||
      (Number(o.minuti)||0) ||
      (Number(o.minutes)||0) ||
      toMin(o.oreHHMM||0)
    ), 0);
    const delta    = effMin - pianTot;                       // >0 = sforato
    const perc     = pianTot>0 ? (delta / pianTot) * 100 : 0;
    out.push({
      id: c.id,
      cliente: c.cliente || '',
      descrizione: c.descrizione || '',
      qta: Math.max(1, Number(c.qtaPezzi||1)),
      perPezzo,
      pianTot,
      effMin,
      delta,
      perc
    });
  }
  return out.sort((a,b)=> a.id.localeCompare(b.id));
}, [commesse, oreRows]);

const q = (query||'').toLowerCase();
  const vis = righe.filter(r =>
    (r.id+' '+r.cliente+' '+r.descrizione).toLowerCase().includes(q)
  );

  function exportCSV(){
    const header = ['Commessa','Cliente','Descrizione','Q.tà','Pian. 1 pz (HH:MM)','Pian. tot (HH:MM)','Effettive (HH:MM)','Delta (Eff-Pian)','Scost.%','Stato'];
  const body = vis.map(r => {
    const stato = r.delta>0 ? 'Ritardo' : 'On time';
    const percStr = (r.perc>=0?'+':'') + (Math.round(r.perc*10)/10).toFixed(1) + '%';
    return [r.id, r.cliente, r.descrizione, String(r.qta), fmt(r.perPezzo), fmt(r.pianTot), fmt(r.effMin), (r.delta>=0?'+':'')+fmt(Math.abs(r.delta)), percStr, stato];
  });
    const csv = [header, ...body].map(row =>
      row.map(v => {
        const s = String(v||'');
        return /[;"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
      }).join(';')
    ).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download = 'report_tempi_commesse.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---- Report 2: Ore per FASE (nuovo) ----
  // Filtri locali
  const [fltCliente, setFltCliente]     = React.useState('');
  const [fltCommessa, setFltCommessa]   = React.useState('');
  const [fltDescr, setFltDescr]         = React.useState('');
  const [fltFase, setFltFase]           = React.useState('');
  const [fltOperatore, setFltOperatore] = React.useState('');
  const [inclExtra, setInclExtra]       = React.useState(true);

  // Sorgenti per tendina clienti
  const clienti = React.useMemo(()=>{
    const s = new Set();
    (commesse||[]).forEach(c => { const v = (c.cliente||'').trim(); if (v) s.add(v); });
    return Array.from(s).sort((a,b)=>a.localeCompare(b));
  }, [commesse]);

  // Aggregazione per (commessaId, faseIdx)
  const orePerFase = React.useMemo(()=>{
    const rows = (Array.isArray(oreRows)?oreRows:[]).filter(r => {
      const c = (commesse||[]).find(x => x.id === r.commessaId);
      const cliente = (c?.cliente || '').toLowerCase();
      const idc = (c?.id || '').toLowerCase();
      const descr = (c?.descrizione || '').toLowerCase();
      const faseLabel = (function(){
        if (r.faseIdx == null || r.faseIdx === '') return 'EXTRA: Cambio Bombola Gas';
        return (typeof window.faseLabel === 'function')
          ? window.faseLabel(c, Number(r.faseIdx))
          : `Fase ${(Number(r.faseIdx)||0)+1}`;
      })().toLowerCase();
      const oper = (r.operatore||'').toLowerCase();

      if (fltCliente && cliente !== fltCliente.toLowerCase()) return false;
      if (fltCommessa && !idc.includes(fltCommessa.toLowerCase())) return false;
      if (fltDescr && !descr.includes(fltDescr.toLowerCase())) return false;
      if (fltFase && !faseLabel.includes(fltFase.toLowerCase())) return false;
      if (fltOperatore && !oper.includes(fltOperatore.toLowerCase())) return false;
      if (!inclExtra && (r.faseIdx == null || r.faseIdx === '')) return false;
      return true;
    });

    const map = new Map();
    for (const r of rows){
      const c = (commesse||[]).find(x => x.id === r.commessaId) || {};
      const isNoFase = (r.faseIdx == null || r.faseIdx === '');
      const isExtra  = isNoFase && isGasNote(r.note);
      const keyFase  = isExtra ? 'EXTRA' : (isNoFase ? 'INTERA' : String(r.faseIdx|0));

      const cur = (map.get(keyFase) || {
        commessaId: r.commessaId,
        cliente: c.cliente || '',
        descrizione: c.descrizione || '',
        faseIdx: isNoFase ? null : (r.faseIdx|0),
        faseLabel: (isExtra
          ? 'EXTRA: Cambio Bombola Gas'
          : (isNoFase
              ? 'Intera commessa'
              : ((typeof window.faseLabel === 'function') ? window.faseLabel(c, (r.faseIdx|0)) : `Fase ${(r.faseIdx|0)+1}`)
            )),
        minutes: 0
      });

      const add = Number(r.oreMin)||toMin(r.oreHHMM)||0;
      cur.minutes += add;
      map.set(keyFase, cur);
    }

    return Array.from(map.values())
      .sort((a,b)=> (a.commessaId.localeCompare(b.commessaId) || String(a.faseIdx??99).localeCompare(String(b.faseIdx??99))));
  }, [oreRows, commesse, fltCliente, fltCommessa, fltDescr, fltFase, fltOperatore, inclExtra]);

  function exportCSV_Fasi(){
    const header = ['Cliente','Commessa','Descrizione','Fase','Minuti','HH:MM'];
    const body = orePerFase.map(r => [r.cliente, r.commessaId, r.descrizione, r.faseLabel, String(r.minutes), fmt(r.minutes)]);
    const csv = [header, ...body].map(row =>
      row.map(v => {
        const s = String(v||'');
        return /[;"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
      }).join(';')
    ).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download = 'report_ore_per_fase.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }
  // === Filtro/aggregazione per riga articolo (non sostituisce il report esistente) ===
  const cardAgg = e('div', { className:'card', style:{ marginBottom:8 } },
    e('div', { className:'row', style:{ gap:12, alignItems:'center', flexWrap:'wrap' } },
      e('label', { className:'row', style:{ gap:6 } },
        e('input', { type:'checkbox', checked:groupByRiga, onChange:ev=>setGroupByRiga(ev.target.checked) }),
        e('span', null, 'Raggruppa per riga articolo')
      ),
      e('div', { className:'row', style:{ gap:6, alignItems:'center' } },
        e('span', { className:'muted' }, 'Commessa'),
        e('select', { value:commessaFilter, onChange:ev=>setCommessaFilter(ev.target.value) },
          e('option', { value:'' }, '— tutte —'),
          commesseIds.map(id => e('option', { key:id, value:id }, id))
        )
      )
    ),
    groupByRiga && e('div', { style:{ marginTop:8 } },
      e('table', { className:'table' },
        e('thead', null, e('tr', null,
          e('th', null, 'Commessa'),
          e('th', null, 'Riga #'),
          e('th', null, 'Codice'),
          e('th', null, 'Descrizione'),
          e('th', null, 'UM'),
          e('th', null, 'Pezzi'),
          e('th', null, 'Minuti'),
          e('th', null, 'Ore HH:MM')
        )),
        e('tbody', null,
          aggRows.map((r, i) => e('tr', { key:i },
            e('td', null, r.commessaId),
            e('td', null, r.rigaIdx==null ? '—' : String(r.rigaIdx+1)),
            e('td', null, r.rigaCodice || ''),
            e('td', null, r.rigaDescrizione || ''),
            e('td', null, r.rigaUM || ''),
            e('td', null, String(r.pezzi || 0)),
            e('td', null, String(r.oreMin || 0)),
              e('td', null, r.oreHHMM || '0:00')
          ))
        )
      )
    )
  );

  // ---- Render ----
  return e('div', {className:'grid', style:{gap:16}},
      cardAgg,
    // Report 1
    e('div', {className:'actions', style:{justifyContent:'space-between'}},
      e('h3', null, 'Report Tempi — Pianificate vs Effettive'),
      e('button', {className:'btn btn-outline', onClick:exportCSV}, 'Esporta CSV')
    ),
    e('div', {className:'card'},
      vis.length===0
        ? e('div', {className:'muted'}, 'Nessuna commessa trovata')
        : e('table', {className:'table'},
            e('thead', null,
              e('tr', null,
                e('th', null, 'Commessa'),
                e('th', null, 'Cliente'),
                e('th', null, 'Descrizione'),
                e('th', {className:'right'}, 'Q.tà'),
                e('th', {className:'right'}, 'Pian. 1 pz'),
                e('th', {className:'right'}, 'Pian. tot'),
                e('th', {className:'right'}, 'Effettive'),
                e('th', {className:'right'}, 'Delta'),
                e('th', {className:'right'}, 'Scost. %'),
                e('th', null, 'Stato')
              )
            ),
            e('tbody', null,
              vis.map((r,i)=>{
                const stato = r.delta>0 ? '🔴 Ritardo' : '🟢 On time';
                const deltaStr = (r.delta>0?'+':'') + fmt(r.delta);
                return e('tr', {key:r.id||i},
                  e('td', null, r.id),
                  e('td', null, r.cliente || '-'),
                  e('td', null, r.descrizione || '-'),
                  e('td', {className:'right'}, String(r.qta)),
                  e('td', {className:'right'}, fmt(r.perPezzo)),
                  e('td', {className:'right'}, fmt(r.pianTot)),
                  e('td', {className:'right'}, fmt(r.effMin)),
                  e('td', {className:'right'}, deltaStr),
                  // scostamento percentuale colorato
                  e('td', {className:'right'}, 
                    e('span', {style:{fontWeight:600,color: (r.perc>1 ? '#b91c1c' : (r.perc<-1 ? '#065f46' : '#374151'))}}, (r.perc>=0?'+':'') + (Math.round(r.perc*10)/10).toFixed(1) + '%')),
                  e('td', null, stato)
                );
              })
            )
          )
    ),

    // Report 2: Ore per fase (nuovo)
    e('div', {className:'actions', style:{justifyContent:'space-between', marginTop:8}},
      e('h3', null, 'Ore per fase (filtrabile)'),
      e('div', {className:'row', style:{gap:8}},
        e('button', {className:'btn btn-outline', onClick:exportCSV_Fasi}, 'Esporta CSV')
      )
    ),
    e('div', {className:'card'},
      e('div', {className:'grid', style:{gap:8, gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))'}},
        e('label', null, 'Cliente',
          e('select', {value:fltCliente, onChange:ev=>setFltCliente(ev.target.value)},
            e('option', {value:''}, '— Tutti —'),
            clienti.map(c => e('option', {key:c, value:c}, c))
          )
        ),
        e('label', null, 'Commessa contiene',
          e('input', {value:fltCommessa, onChange:ev=>setFltCommessa(ev.target.value), placeholder:'es. C-2025-001'})
        ),
        e('label', null, 'Descrizione/Articolo contiene',
          e('input', {value:fltDescr, onChange:ev=>setFltDescr(ev.target.value), placeholder:'articolo/descrizione'})
        ),
        e('label', null, 'Fase contiene',
          e('input', {value:fltFase, onChange:ev=>setFltFase(ev.target.value), placeholder:'es. Taglio'})
        ),
        e('label', null, 'Operatore contiene',
          e('input', {value:fltOperatore, onChange:ev=>setFltOperatore(ev.target.value), placeholder:'es. Mario'})
        ),
        e('label', {className:'row', style:{alignItems:'center', gap:6, marginTop:6}},
          e('input', {type:'checkbox', checked:inclExtra, onChange:ev=>setInclExtra(ev.target.checked)}),
          e('span', null, 'Includi EXTRA (Cambio Bombola Gas)')
        )
      ),
      orePerFase.length===0
        ? e('div', {className:'muted', style:{marginTop:8}}, 'Nessun risultato con i filtri correnti.')
        : e('table', {className:'table', style:{marginTop:8}},
            e('thead', null, e('tr', null,
              e('th', null, 'Cliente'),
              e('th', null, 'Commessa'),
              e('th', null, 'Descrizione'),
              e('th', null, 'Fase'),
              e('th', {className:'right'}, 'Minuti'),
              e('th', {className:'right'}, 'HH:MM')
            )),
            e('tbody', null,
              orePerFase.map((r,i) => e('tr', {key:i},
                e('td', null, r.cliente || '—'),
                e('td', null, r.commessaId || '—'),
                e('td', null, r.descrizione || '—'),
                e('td', null, r.faseLabel || '—'),
                e('td', {className:'right'}, String(r.minutes)),
                e('td', {className:'right'}, fmt(r.minutes))
              ))
            )
          )
    )
  );
}

function SchedaArticoloModal({ articolo, movimenti, onClose }) {
  const e = React.createElement;
  const codice = String(articolo?.codice||'').trim();
  const desc   = String(articolo?.descrizione||'').trim();
  const um     = String(articolo?.um||'PZ').toUpperCase();
  const prezzo = Number(articolo?.prezzo||0);
  const cmp    = (articolo && Number.isFinite(Number(articolo.cmp))) ? Number(articolo.cmp) : null;

  const movs = (Array.isArray(movimenti)?movimenti:[]).filter(m=>{
    const rl = Array.isArray(m?.righe) ? m.righe
             : Array.isArray(m?.rows)  ? m.rows
             : Array.isArray(m?.items) ? m.items
             : (m && (m.codice||m.code) ? [{codice:m.codice||m.code, qta:m.qta||m.qty||m.quantita||0, prezzo:m.prezzo||m.price||m.costo||0}] : []);
    return rl.some(x => String(x.codice||'').toLowerCase() === codice.toLowerCase());
  }).slice(-10).reverse(); // ultimi 10

  const fmt2 = n => Number(n||0).toLocaleString('it-IT',{minimumFractionDigits:2, maximumFractionDigits:2});
  const giacenza = movimenti.reduce((s,m)=>{
    const rl = Array.isArray(m?.righe) ? m.righe
             : Array.isArray(m?.rows)  ? m.rows
             : Array.isArray(m?.items) ? m.items
             : (m && (m.codice||m.code) ? [{codice:m.codice||m.code, qta:m.qta||m.qty||m.quantita||0}] : []);
    const add = rl.filter(x=>String(x.codice||'').toLowerCase()===codice.toLowerCase()).reduce((ss,x)=> ss + Number(x.qta||0),0);
    return s + add;
  },0);

  return e('div', { className:'modal-backdrop' },
    e('div', { className:'modal-card' },
      e('h3', null, `Scheda articolo — ${codice}`),
      e('div', { className:'row', style:{gap:8} },
        e('div', null, `Descrizione: ${desc||'—'}`),
        e('div', null, `UM: ${um}`),
        e('div', null, `Prezzo: € ${fmt2(prezzo)}`),
        e('div', null, `CMP: ${cmp!=null ? ('€ '+fmt2(cmp)) : '—'}`),
        e('div', null, `Giacenza: ${fmt2(giacenza)}`)
      ),
      e('div', { className:'card', style:{marginTop:8, maxHeight:300, overflowY:'auto'} },
        e('div', { className:'card-title' }, 'Ultimi movimenti'),
        e('table', { className:'table' },
          e('thead', null, e('tr', null,
            e('th', null, 'Data'), e('th', null, 'Tipo'),
            e('th', null, 'Rif.'), e('th', null, 'DDT/Forn.'),
            e('th', {style:{textAlign:'right'}}, 'Q.tà')
          )),
          e('tbody', null,
            movs.map(m=>{
              const qy = (Array.isArray(m?.righe)?m.righe:Array.isArray(m?.rows)?m.rows:Array.isArray(m?.items)?m.items:[])
                        .filter(x=>String(x.codice||'').toLowerCase()===codice.toLowerCase())
                        .reduce((s,x)=> s + Number(x.qta||x.qty||x.quantita||0),0);
              const tipo = String(m?.tipo||'').toUpperCase()==='C' ? 'CARICO' : (String(m?.tipo||'').toUpperCase()==='S' ? 'SCARICO' : (m?.tipo||''));
              return e('tr',{key:m.id},
                e('td', null, m.data||''), e('td', null, tipo),
                e('td', null, m.rifDoc||''), e('td', null, (m.fornitoreId||'') + (m.ddtFornitore?(' / '+m.ddtFornitore):'')),
                e('td', {style:{textAlign:'right'}}, fmt2(qy))
              );
            })
          )
        )
      ),
      e('div', { className:'row', style:{gap:8, marginTop:12, justifyContent:'flex-end'} },
        e('button', { className:'btn', onClick:onClose }, 'Chiudi')
      )
    )
  );
}

/* ================== MAGAZZINO (Articoli + Movimenti) ================== */
function MagazzinoView(props){
  const initialTab = (props && props.initialTab) ? props.initialTab : 'articoli';
  const e = React.createElement;

  // Alias ai globali (già definiti nel bootstrap)
  const lsGet = window.lsGet;
  const lsSet = window.lsSet || ((k,v)=> {
  try {
    if (window.safeSetJSON) return window.safeSetJSON(k,v);
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
  });

  const persistArticoli  = (rows)=> (typeof saveKey === 'function') ? saveKey('magArticoli', rows)  : lsSet('magArticoli', rows);
  const persistMovimenti = (rows)=> (typeof saveKey === 'function') ? saveKey('magMovimenti', rows) : lsSet('magMovimenti', rows);

  // Stato
  const [tab, setTab]               = React.useState(initialTab); // 'articoli' | 'movimenti'
  const [articoli, setArticoli]     = React.useState(()=> lsGet('magArticoli', []));
  const [movimenti, setMovimenti]   = React.useState(()=> lsGet('magMovimenti', []));
  const [q, setQ]                   = React.useState('');
  const [editArt, setEditArt]       = React.useState(null); // {codice, descrizione, um, prezzo} | null
  const [schedaArt, setSchedaArt]   = React.useState(null); // articolo o null
  const [newMov, setNewMov]         = React.useState({ data:new Date().toISOString().slice(0,10), codice:'', qta:0, note:'' });
  // --- selezione multipla articoli ---
  const [selected, _setSelected] = React.useState(new Set());
  function isSel(cod){ return selected.has(String(cod||'')); }
  function setSelected(next){ _setSelected(new Set(next)); }
  function toggleOne(cod, on){
  const k = String(cod||''); const s = new Set(selected);
  if(on) s.add(k); else s.delete(k);
  setSelected(s);
  }
  function toggleAll(list, on){
  if(!Array.isArray(list)) return;
  const s = new Set(selected);
  list.forEach(a => {
    const k = String(a.codice||''); if(!k) return;
    if(on) s.add(k); else s.delete(k);
  });
  setSelected(s);
  }
  function deleteSelected(){
  if(selected.size===0) return;
  if(!confirm(`Eliminare ${selected.size} articoli selezionati?`)) return;
  const next = (articoli||[]).filter(a => !selected.has(String(a.codice||'')));
  setArticoli(next); persistArticoli(next); setSelected(new Set());
  }

  React.useEffect(()=>{ /* ricarica all’avvio se cambiato fuori */
    setArticoli(lsGet('magArticoli', []));
    setMovimenti(lsGet('magMovimenti', []));
  },[]);

  // ================== Import articoli (.xlsx/.csv) ==================
  const fileArtRef = React.useRef(null);
  function onImportArtClick(){ fileArtRef.current && fileArtRef.current.click(); }

  function normArtKey(k){
    k = String(k||'').trim().toLowerCase();
    if (k.includes('codice') || k==='codice') return 'codice';
    if (k.includes('descri')) return 'descrizione';
    if (k==='um' || k.includes('u.m')) return 'um';
    if (k.includes('prezzo') || k.includes('costo')) return 'prezzo';
    return k;
  }
  function mapArticolo(row){
    const o = {};
    Object.keys(row||{}).forEach(k=> o[normArtKey(k)] = row[k]);
    return {
      codice: String(o.codice||'').trim(),
      descrizione: String(o.descrizione||'').trim(),
      um: (String(o.um||'').trim().toUpperCase() || 'PZ'),
      prezzo: Number(String(o.prezzo||'').replace(',','.')) || 0
    };
  }

  // CSV parser minimale (supporta ; o , e virgolette "")
  function csvToObjects(text){
    const delim = text.split('\n',1)[0].includes(';') ? ';' : ',';
    const s = text.replace(/\r/g,'');
    const rows = [];
    let cell = '', row = [], inQuotes = false;
    for (let i=0;i<s.length;i++){
      const ch = s[i];
      if (inQuotes){
        if (ch === '"'){
          if (s[i+1] === '"'){ cell += '"'; i++; } else inQuotes = false;
        } else cell += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === delim){ row.push(cell); cell=''; }
        else if (ch === '\n'){ row.push(cell); rows.push(row); row=[]; cell=''; }
        else cell += ch;
      }
    }
    if (cell.length || row.length){ row.push(cell); rows.push(row); }

    if (!rows.length) return [];
    const header = rows[0].map(h => String(h||'').trim());
    const out = [];
    for (let r=1;r<rows.length;r++){
      const o = {};
      for (let c=0;c<header.length;c++) o[header[c]] = rows[r][c] ?? '';
      out.push(o);
    }
    return out;
  }

  // Import: accetta .xlsx/.xls (se presente XLSX) oppure .csv (sempre)
  async function handleArtImportFile(ev){
    try{
      const file = ev?.target?.files?.[0];
      if (!file) return;
      const name = file.name.toLowerCase();

      let rowsX = [];
      if (name.endsWith('.csv')){
        const text = await file.text();
        rowsX = csvToObjects(text);
      } else {
        // prova a usare la libreria solo se disponibile o se il loader globale è definito
        if (window.ensureXLSX) await window.ensureXLSX();
        if (!window.XLSX) throw new Error('XLSX non caricato: salva il file come CSV e riprova');
        const buf = await file.arrayBuffer();
        const wb  = window.XLSX.read(buf, { type:'array' });
        const ws  = wb.Sheets[wb.SheetNames[0]];
        if (!ws) throw new Error('Foglio vuoto o non leggibile');
        rowsX = window.XLSX.utils.sheet_to_json(ws, { defval:'' });
      }

      if (!rowsX.length) { alert('Il file non contiene righe'); return; }

      const imported = rowsX.map(mapArticolo).filter(a=> a.codice);
      if (!imported.length){ alert('Nessun articolo valido (manca colonna CODICE)'); return; }

      const next = [...(articoli||[])];
      imported.forEach(src=>{
        const ix = next.findIndex(t=> String(t.codice).toLowerCase() === src.codice.toLowerCase());
        if (ix>=0) next[ix] = { ...next[ix], ...src };
        else next.push(src);
      });
      next.sort((a,b)=> String(a.codice).localeCompare(String(b.codice)));
      setArticoli(next);
      persistArticoli(next);
      alert(`Import articoli completato: ${imported.length} righe.`);
    }catch(err){
      console.error('[Import Articoli]', err);
      alert('Errore import: ' + (err?.message || err));
    }finally{
      if (fileArtRef?.current) fileArtRef.current.value = '';
    }
  }

  // ================== Articoli: CRUD minimale ==================
  function newArt(){ return { codice:'', descrizione:'', um:'PZ', prezzo:0 }; }
  function openNewArt(){ setEditArt(newArt()); }
  function openEditArt(a){ setEditArt({ ...a }); }
  function cancelEditArt(){ setEditArt(null); }
  function saveArt(){
    const a = editArt || {};
    if (!a.codice){ alert('Inserisci CODICE articolo'); return; }
    const next = [...(articoli||[])];
    const ix = next.findIndex(x=> String(x.codice).toLowerCase() === String(a.codice).toLowerCase());
    if (ix>=0) next[ix] = { ...next[ix], ...a };
    else next.push(a);
    next.sort((x,y)=> String(x.codice).localeCompare(String(y.codice)));
    setArticoli(next);
    persistArticoli(next);
    setEditArt(null);
  }
  function delArt(a){
    if (!confirm(`Eliminare articolo ${a.codice}?`)) return;
    const next = (articoli||[]).filter(x=> x !== a);
    setArticoli(next);
    persistArticoli(next);
  }

  // ================== Movimenti ==================
  function addMov(){
    const m = { ...newMov, qta: Number(newMov.qta||0) };
    if (!m.codice){ alert('Inserisci CODICE articolo'); return; }
    if (!m.qta){ alert('Quantità non valida'); return; }
    const next = [...(movimenti||[]), m];
    setMovimenti(next);
    persistMovimenti(next);
    setNewMov({ ...newMov, codice:'', qta:0, note:'' });
  }
  function delMov(ix){
    const next = [...(movimenti||[])];
    next.splice(ix,1);
    setMovimenti(next);
    persistMovimenti(next);
  }

  // Giacenze: somma movimenti per codice
  const giacenze = React.useMemo(()=>{
    const map = new Map();
    (movimenti||[]).forEach(m=>{
      const k = String(m.codice||'').toLowerCase(); if (!k) return;
      map.set(k, (map.get(k)||0) + Number(m.qta||0));
    });
    return map; // key: codice lower, value: qta
  }, [movimenti]);

  // ================== UI ==================
  const tabsUI = e('div', {className:'tabs'},
    e('button', {className: tab==='articoli' ? 'active' : '', onClick:()=>setTab('articoli')}, 'Articoli'),
    e('button', {className: tab==='movimenti' ? 'active' : '', onClick:()=>setTab('movimenti')}, 'Movimenti')
  );

  // ---- ARTICOLI ----
  const filtered = (articoli||[]).filter(a=>{
    if (!q) return true;
    const s = (a.codice+' '+a.descrizione).toLowerCase();
    return s.includes(q.toLowerCase());
  });

  const articoliUI = e('div', null,
    e('div', {className:'actions', style:{justifyContent:'space-between', gap:8}},
      e('input', {placeholder:'Cerca…', value:q, onChange:ev=>setQ(ev.target.value)}),
      e('div', null,
        e('button', {className:'btn btn-outline', onClick:onImportArtClick}, '⬆️ Importa (.xlsx/.csv)'),
        e('input', {type:'file', accept:'.xlsx,.xls,.csv', ref:fileArtRef, style:{display:'none'}, onChange:handleArtImportFile}),
        e('button', {className:'btn', style:{marginLeft:8}, onClick:openNewArt}, '➕ Nuovo articolo'),
        e('button', {className:'btn btn-outline',style:{ marginLeft:8 },disabled: selected.size===0,onClick: deleteSelected}, `Elimina selezionati (${selected.size})`)
      )
    ),

    // form edit/nuovo
    !editArt ? null : e('div', {className:'card', style:{marginTop:8}},
      e('div', {className:'card-title'}, 'Articolo'),
      e('div', {className:'grid grid-2'},
        e('label', null, 'Codice',
          e('input', {value:editArt.codice, onChange:ev=>setEditArt({...editArt, codice:ev.target.value})})
        ),
        e('label', null, 'UM',
          e('input', {value:editArt.um||'PZ', onChange:ev=>setEditArt({...editArt, um:ev.target.value.toUpperCase()})})
        ),
        e('label', {style:{gridColumn:'1 / span 2'}}, 'Descrizione',
          e('input', {value:editArt.descrizione||'', onChange:ev=>setEditArt({...editArt, descrizione:ev.target.value})})
        ),
        e('label', null, 'Prezzo',
          e('input', {type:'number', step:'0.01', value:editArt.prezzo ?? 0, onChange:ev=>setEditArt({...editArt, prezzo:Number(ev.target.value||0)})})
        )
      ),
      e('div', {className:'actions', style:{justifyContent:'flex-end', gap:8}},
        e('button', {className:'btn btn-outline', type:'button', onClick:cancelEditArt}, 'Annulla'),
        e('button', {className:'btn', type:'button', onClick:saveArt}, 'Salva')
      )
    ),

    // tabella articoli
    e('div', {className:'card', style:{marginTop:8}},
      e('div', {className:'card-title'}, `Articoli (${filtered.length})`),
      e('table', {className:'table'},
        e('thead', null, e('tr', null,
          e('th', null, 'Codice'),
          e('th', null, 'Descrizione'),
          e('th', null, 'UM'),
          e('th', {style:{textAlign:'right'}}, 'Prezzo'),
          e('th', {style:{textAlign:'right'}}, 'Giac.'),
          e('th', {style:{textAlign:'center', width:28}}, 
            e('input', {
              type:'checkbox',
              ref: (el)=>{ if(el){ el.indeterminate = (filtered.some(a=>isSel(a.codice)) && !filtered.every(a=>isSel(a.codice))); } },
              checked: (filtered.length>0 && filtered.every(a => isSel(a.codice))),
              onChange: ev => toggleAll(filtered, ev.target.checked)
            })
          ),
          e('th', {style:{textAlign:'right'}}, 'Azioni')
        )),
        e('tbody', null, filtered.map((a,ix)=> e('tr', {key:ix},
          e('td', null, a.codice),
          e('td', null, a.descrizione),
          e('td', null, a.um||''),
          e('td', {style:{textAlign:'right'}}, (a.prezzo!=null? Number(a.prezzo).toFixed(2):'')),
          e('td', {style:{textAlign:'right'}}, giacenze.get(String(a.codice).toLowerCase()) || 0),
          // selezione
          e('td', {style:{textAlign:'center'}},
            e('input', {
              type:'checkbox',
              checked: isSel(a.codice),
              onChange: ev => toggleOne(a.codice, ev.target.checked)
            })
          ),
          // azioni
          e('td', {style:{textAlign:'right'}},
            e('button', {className:'btn btn-outline', onClick:()=>setSchedaArt(a)}, '🔎'),
            e('button', {className:'btn btn-outline', style:{marginLeft:6}, onClick:()=>openEditArt(a)}, '✏️'),
            e('button', {className:'btn btn-outline', style:{marginLeft:6}, onClick:()=>delArt(a)}, '🗑️')
          )
        )))
      )
    )
  );

  // ---- MOVIMENTI ----
  const movUI = e('div', null,
    e('div', {className:'card'},
      e('div', {className:'card-title'}, 'Nuovo movimento'),
      e('div', {className:'grid grid-4'},
        e('label', null, 'Data',
          e('input', {type:'date', value:newMov.data, onChange:ev=>setNewMov({ ...newMov, data:ev.target.value })})
        ),
        e('label', null, 'Codice',
          e('input', {value:newMov.codice, onChange:ev=>setNewMov({ ...newMov, codice:ev.target.value })})
        ),
        e('label', null, 'Q.tà (+ carico / - scarico)',
          e('input', {type:'number', value:newMov.qta, onChange:ev=>setNewMov({ ...newMov, qta:ev.target.value })})
        ),
        e('label', null, 'Note',
          e('input', {value:newMov.note, onChange:ev=>setNewMov({ ...newMov, note:ev.target.value })})
        )
      ),
      e('div', {className:'actions', style:{justifyContent:'flex-end'}},
        e('button', {className:'btn', onClick:addMov, type:'button'}, 'Aggiungi')
      )
    ),

    e('div', {className:'card', style:{marginTop:8}},
      e('div', {className:'card-title'}, `Movimenti (${(movimenti||[]).length})`),
      e('table', {className:'table'},
        e('thead', null, e('tr', null,
          e('th', null, 'Data'),
          e('th', null, 'Codice'),
          e('th', {style:{textAlign:'right'}}, 'Q.tà'),
          e('th', null, 'Note'),
          e('th', null, '')
        ))),
        e('tbody', null, (movimenti||[]).map((m,ix)=> e('tr', {key:ix},
          e('td', null, m.data||''),
          e('td', null, m.codice||''),
          e('td', {style:{textAlign:'right'}}, m.qta||''),
          e('td', null, m.note||''),
          e('td', {style:{textAlign:'right'}},
            e('button', {className:'btn btn-outline', onClick:()=>delMov(ix)}, '🗑️')
          )
        ))
      )
    )
  );

  return e('div', null,
    tabsUI,
    tab==='articoli' ? articoliUI : movUI
      , (schedaArt && e(SchedaArticoloModal, { 
      articolo: schedaArt,
      movimenti,
      onClose: ()=> setSchedaArt(null)
    }))
  );
}
window.MagazzinoView = window.MagazzinoView || MagazzinoView;

// --- SAFE STUB PER SYNC CLOUD ---
(function ensureCloudFns(){
  if (typeof window.syncExportToCloud !== 'function') {
    window.syncExportToCloud = async function(){
      console.info('[syncExportToCloud] non configurata: no-op');
    };
  }
  if (typeof window.syncImportFromCloud !== 'function') {
    window.syncImportFromCloud = async function(){
      console.info('[syncImportFromCloud] non configurata: no-op');
    };
  }
  // ➕ NUOVO: export selettivo (usato dalla Timbratura)
  if (typeof window.syncExportToCloudOnly !== 'function') {
    window.syncExportToCloudOnly = async function(keys){
      try{
        const sb = window.getSB && window.getSB();
        if (!sb) return; // cloud non configurato
        const table = sb.table || 'anima_sync';
        const rows = [];
        (Array.isArray(keys)?keys:[]).forEach(k=>{
          try{
            const raw = localStorage.getItem(k);
            if (raw != null){
              rows.push({ k, data: JSON.parse(raw), updated_at: new Date().toISOString() });
            }
          }catch{}
        });
        if (!rows.length) return;
        const url = `${sb.url}/rest/v1/${encodeURIComponent(table)}?on_conflict=k`;
        const res = await fetch(url, {
          method:'POST',
          headers:{
            apikey: sb.key,
            Authorization:`Bearer ${sb.key}`,
            'Content-Type':'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
          },
          body: JSON.stringify(rows)
        });
        if (!res.ok) { console.warn('[syncExportToCloudOnly] HTTP', res.status, await res.text()); }
      }catch(e){
        console.warn('[syncExportToCloudOnly] errore', e);
      }
    };
  }
})();

// === Error boundary minimale + safeView (UNA SOLA VOLTA) ===
class ErrorBoundary extends React.Component {
  constructor(p){ super(p); this.state = { err:null }; }
  static getDerivedStateFromError(err){ return {err}; }
  componentDidCatch(err, info){ console.error('[ErrorBoundary]', err, info); }
  render(){
    if (this.state.err){
      return React.createElement('div',{className:'card',style:{color:'#b00020',whiteSpace:'pre-wrap'}},
        'Errore UI: ', String(this.state.err));
    }
    return this.props.children;
  }
}
function safeView(Comp, name, props){
  const e = React.createElement;

  if (!Comp || typeof Comp !== 'function') {
    console.warn(`[safeView] ${name}: componente mancante/non funzione`, Comp);
    return e('div', { className:'card muted' }, `Modulo ${name} non disponibile`);
  }

  class Guard extends React.Component {
    constructor(p){ super(p); this.state = { err: null }; }
    static getDerivedStateFromError(err){ return { err }; }
    componentDidCatch(err, info){
      console.error(`[${name}] crash in render`, err, info);
    }
    render(){
      if (this.state.err){
        const msg = (this.state.err && this.state.err.message) ? this.state.err.message : String(this.state.err);
        return e('div', { className:'card', style:{ color:'#b00020', whiteSpace:'pre-wrap' } },
          `Errore ${name}: `, msg
        );
      }
      try { return e(Comp, props || {}); }
      catch(err){
        console.error(`[${name}] sync error`, err);
        return e('div', { className:'card muted' }, `Errore nel modulo ${name}`);
      }
    }
  }
  return e(Guard);
}
/* ================== APP (menu & switch, con TIMBRATURA) ================== */
function App() {
  // Se è attivo il layout con Sidebar moderna, non renderizzare il layout legacy
  if (document.querySelector('aside.sidebar')) { return null; }

  const e = React.createElement;

  // Stato di tab e filtro
 const [tab, setTab] = React.useState(() => {
  try { return localStorage.getItem('activeTab') || 'Dashboard'; }
  catch { return 'Dashboard'; }
 });

 // Espone setTab globalmente (DEVE stare fuori da useState)
 React.useEffect(() => {
  window.setTab = setTab;
  return () => { if (window.setTab === setTab) window.setTab = null; };
 }, []);


  const [query, setQuery] = React.useState('');
  React.useEffect(() => { try { localStorage.setItem('activeTab', tab); } catch {} }, [tab]);

  // === Ricerca globale per le view che accettano {query} ===
  const [search, setSearch] = React.useState('');

  // Routing via hash -> TIMBRATURA
  React.useEffect(() => {
    function syncFromHash(){
    const h = (location.hash || '').toLowerCase();
    if      (h.startsWith('#/timbratura'))     setTab('TIMBRATURA');
    else if (h.startsWith('#/impostazioni'))   setTab('Impostazioni');
    else if (h.startsWith('#/fatture'))        setTab('Fatture');
    else if (h.startsWith('#/ddt'))            setTab('DDT');
    else if (h.startsWith('#/ordini'))         setTab('OrdiniFornitori');
    else if (h.startsWith('#/ore'))            setTab('ORE');
    else if (h.startsWith('#/magazzino'))      setTab('Magazzino');
    else if (h.startsWith('#/report'))         setTab('REPORT');
    else                                       setTab('Dashboard');
    }
    window.addEventListener('hashchange', syncFromHash);
    syncFromHash();
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

    React.useEffect(() => {
    const t = setInterval(() => {
      try{
        const a = (function(){ try{ return JSON.parse(localStorage.getItem('appSettings')||'{}'); }catch{return{}} })();
        if (a.cloudEnabled && typeof window.syncImportFromCloud === 'function') {
        window.syncImportFromCloud(); // pull dallo snapshot anima_sync
        }
      }catch{}
        }, 15000); // ogni 15s
      return () => clearInterval(t);
    }, []);


   // ROUTE FULL-SCREEN per #/operatore (solo timbratura)
  if ((window.location.hash || '').startsWith('#/operatore')) {
  return e(ErrorBoundary, null,
    e('main', null, e(OperatoreApp))
  );
  }

  // ROUTE FULL-SCREEN per #/timbratura (via QR)  ⬅️  INCOLLA QUI
  if ((window.location.hash || '').startsWith('#/timbratura')) {
    return e(ErrorBoundary, null,
      e('main', null, e(TimbraturaMobileView))
    );
  }
  // FINE INSERIMENTO

  // Tabs
  const TABS = [
    { label: 'Dashboard',         key: 'Dashboard' },
    { label: 'Commesse',          key: 'Commesse' },
    { label: 'Clienti',           key: 'Clienti' },
    { label: 'Fornitori',         key: 'Fornitori' },
    { label: 'Ordini Fornitori',  key: 'OrdiniFornitori' },
    { label: 'DDT',               key: 'DDT' },
    { label: 'Fatture',           key: 'Fatture' },
    { label: 'Ore',               key: 'ORE' },
    { label: 'Magazzino',         key: 'Magazzino' },
    { label: 'Movimenti', key: 'MagazzinoMovimenti' }, // al posto della vecchia key
    { label: 'Report tempi',      key: 'REPORT' },
    { label: 'Report materiali',  key: 'REPORT_MAT' },
    { label: 'Impostazioni',      key: 'Impostazioni' }
  ];

  function navBtn(label, key) {
    const synonyms = { Ore:['ORE','Ore'], 'Report tempi':['REPORT','Report'], 'Report materiali':['REPORT_MAT'] };
    const isActive = tab === key || (synonyms[label] && synonyms[label].includes(tab));
    return e('button', {
      key,
      className: isActive ? 'btn' : 'btn btn-outline',
      style: { width: '100%', textAlign: 'left' },
      onClick: () => { setTab(key); if ((location.hash||'').startsWith('#/timbratura')) location.hash = ''; }
    }, label);
  }

  // Switch delle viste – SEMPRE con safeView
  function renderTab() {
    // Usa una query sicura anche se search non è stato ancora inizializzato
    const q = (typeof search === 'string') ? search : '';

  // priorità alla timbratura mobile via QR/hash
  if ((window.location.hash || '').startsWith('#/timbratura')) {
    return React.createElement(TimbraturaMobileView);
  }
    
    switch (tab) {
      case 'TIMBRATURA':
        return safeView((typeof TimbraturaMobileView === 'function' ? TimbraturaMobileView : window.TimbraturaMobileView), 'Timbratura');

      case 'Dashboard':
        return safeView((typeof DashboardView === 'function' ? DashboardView : window.DashboardView), 'Dashboard', { query });

      case 'Commesse':
        return safeView(CommesseView, 'Commesse', { query });

      case 'Clienti':
        return safeView((typeof ClientiView === 'function' ? ClientiView : window.ClientiView), 'Clienti');

      case 'Fornitori':
        return safeView((typeof FornitoriView === 'function' ? FornitoriView : window.FornitoriView), 'Fornitori');

      case 'OrdiniFornitori':
        return safeView(window.OrdiniFornitoriView || OrdiniFornitoriView, 'Ordini Fornitori');

      case 'DDT':
        return safeView((typeof DDTView === 'function' ? DDTView : window.DDTView), 'DDT', { query });

      case 'Fatture':
        return safeView(FattureView, 'Fatture', { query });

      case 'Ore':
      case 'ORE':
        return safeView((typeof RegistrazioniOreView === 'function' ? RegistrazioniOreView : window.RegistrazioniOreView), 'Registrazioni Ore', { query });

      case 'Magazzino':
        return safeView((typeof MagazzinoView === 'function' ? MagazzinoView : window.MagazzinoView), 'Magazzino', { query });
        case 'MagazzinoMovimenti':
        case 'Movimenti':
        case 'Magazzino ▸ Movimenti':
        return safeView((typeof MagazzinoMovimentiView==='function' ? MagazzinoMovimentiView : window.MagazzinoMovimentiView), 'Movimenti', { query });

      case 'Report':
      case 'REPORT':
        return safeView((typeof ReportTempiView === 'function' ? ReportTempiView : window.ReportTempiView), 'Report tempi', { query });

      case 'REPORT_MAT':
        return safeView((typeof ReportView === 'function' ? ReportView : window.ReportView), 'Report materiali', { query });

      case 'Impostazioni':
        return safeView((typeof ImpostazioniView === 'function' ? ImpostazioniView : window.ImpostazioniView), 'Impostazioni');

      default:
        return safeView(CommesseView, 'Commesse', { query });
    }
  }

  const titleMap = { ORE: 'Ore', REPORT: 'Report tempi', REPORT_MAT: 'Report materiali', TIMBRATURA:'Timbratura' };
  const title = titleMap[tab] || tab;
  const showSearch = !['Dashboard', 'Impostazioni', 'TIMBRATURA'].includes(tab);

  // Layout speciale TIMBRATURA (senza sidebar)
  if (tab === 'TIMBRATURA') {
    return e(ErrorBoundary, null,
      e('main', null,
        e('div', { className:'actions', style:{ justifyContent:'space-between', marginBottom:12 } },
          e('h2', null, 'Timbratura'),
          e('div', null,
            e('button', { className:'btn btn-outline', onClick:()=>{ location.hash=''; setTab('Dashboard'); } }, 'Chiudi')
          )
        ),
        renderTab()
      )
    );
  }

  // Layout standard
  return e(ErrorBoundary, null,
    e('div', { style:{ display:'grid', gridTemplateColumns:'220px 1fr', gap:16 } },

      e('aside', { className:'card', style:{ padding:12, position:'sticky', top:12, alignSelf:'start' } },
        e('div', { style:{ display:'grid', gap:6 } }, TABS.map(t => navBtn(t.label, t.key)))
      ),

      e('main', null,
        e('div', { className:'actions', style:{ justifyContent:'space-between', marginBottom:12 } },
          e('h2', null, title),
          showSearch && e('div', { className:'row', style:{ gap:6 } },
            e('input', { placeholder:'Cerca…', value:query, onChange:ev=>setQuery(ev.target.value) }),
            query ? e('button', { className:'btn btn-outline', onClick:()=>setQuery('') }, 'Pulisci') : null
          )
        ),
        renderTab()
      )
    )
  );
  
}

// << dopo la chiusura di function App >>
if (!window.__ANIMA_APP_MOUNTED__) {
  window.App = App;
  if (window.requestAppRerender) window.requestAppRerender();
}


/* ================== OPERATORE APP (solo timbratura) ================== */
function OperatoreApp(){
  const e = React.createElement;
  function scan(){ try{ window.scanQR && window.scanQR(); }catch(e){ alert('Scanner non disponibile'); } }
  function openManual(){ location.hash = '#/timbratura'; }

  return e('main', null,
    e('div', { className:'card', style:{ maxWidth:520, margin:'16px auto', padding:16 } },
      e('h2', {style:{marginTop:0}}, 'Timbratura'),
      e('div', {className:'muted', style:{marginBottom:12}}, 'Scansiona il QR della commessa o seleziona manualmente.'),
      e('div', {className:'actions', style:{gap:8}},
        e('button', {className:'btn', style:{width:'100%'}, onClick:scan}, '📷 Scansiona QR'),
        e('button', {className:'btn btn-outline', style:{width:'100%'}, onClick:openManual}, 'Seleziona manualmente')
      )
    )
  );
}
window.OperatoreApp = window.OperatoreApp || OperatoreApp;

// Riallinea qtaProdotta commessa e clamp fasi a qtaPezzi (SENZA popup di default)
window.riallineaQtaProdotte = function ({ silent = true } = {}) {
  const lsGet = window.lsGet || ((k, def) => {
    try { return JSON.parse(localStorage.getItem(k) || 'null') ?? def; } catch { return def; }
  });
  const lsSet = window.lsSet || ((k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); window.__anima_dirty = true; } catch {}
  });

  const all = Array.isArray(lsGet('commesseRows', [])) ? lsGet('commesseRows', []) : [];
  let commesseAggiornate = 0;
  let fasiClampate = 0;
  const nowISO = new Date().toISOString();

  const next = all.map(c => {
    const qTot = Math.max(1, Number(c.qtaPezzi || 1));
    let changed = false;

    // clamp per fase
    let fasiNew = c.fasi;
    if (Array.isArray(c.fasi)) {
      fasiNew = c.fasi.map(f => {
        const src = { ...f };
        const prev = Math.max(0, Number(src.qtaProdotta || 0));
        const clamped = Math.min(qTot, prev);
        if (clamped !== prev) { src.qtaProdotta = clamped; changed = true; fasiClampate++; }
        return src;
      });
    }

    // producedPieces = min tra fasi (già definito in app)
    const tmp = { ...c, fasi: fasiNew };
    const prodNow = (typeof window.producedPieces === 'function') ? window.producedPieces(tmp) : Number(c.qtaProdotta || 0);
    const prevComm = Number(c.qtaProdotta || 0);

    const out = { ...c, fasi: fasiNew };
    if (prodNow !== prevComm) { out.qtaProdotta = prodNow; changed = true; }

    if (changed) { out.updatedAt = nowISO; commesseAggiornate++; }
    return changed ? out : c;
  });

  if (commesseAggiornate > 0) lsSet('commesseRows', next);

  // niente alert se silent === true (default)
  if (!silent) {
    alert(`Riallineo completato.\nCommesse aggiornate: ${commesseAggiornate}\nFasi clampate a qtaPezzi: ${fasiClampate}`);
  }

  return { commesseAggiornate, fasiClampate };
};
if (!localStorage.getItem('__ANIMA_FIX_QTA_ONCE__')) {
  window.riallineaQtaProdotte && window.riallineaQtaProdotte({ silent: true });
  localStorage.setItem('__ANIMA_FIX_QTA_ONCE__', '1');
}

// --- HOTFIX fallback: garantisci che esista window.FattureView e la route ---
(function () {
  if (typeof window.FattureView !== 'function') {
    window.FattureView = function () {
      return React.createElement('div', null, 'Fatture — vista non ancora inizializzata');
    };
  }
  window.ROUTES = window.ROUTES || {};
  window.ROUTES['#/fatture'] = window.FattureView;
})();

/* ================== IMPORT ORDINI (PDF/TXT) — registry + parsers + pipeline ================== */
(function(){
  // --- Safe lsGet/lsSet ---------------------------------------------------
  const lsGet = window.lsGet || ((k,d)=>{ try{ return JSON.parse(localStorage.getItem(k)) ?? d; }catch{ return d; }});
  const lsSet = window.lsSet || ((k,v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); window.__anima_dirty = true; }catch{} });

  // --- AppSettings: default per import ------------------------------------
  (function ensureImportDefaults(){
    const s = lsGet('appSettings', {}) || {};
    if (!Array.isArray(s.selfAliases))        s.selfAliases        = ['ANIMA','ANIMA SRL','ANIMA S.R.L.','ANIMA S R L'];
    if (!Array.isArray(s.orderParsersMeta))   s.orderParsersMeta   = [];
    if (!Array.isArray(s.processTemplates))   s.processTemplates   = [];
    lsSet('appSettings', s);
  })();

    // --- Normalizzatore unico ----------------------------------------------
    window.sanitizeOrderParsed = function sanitizeOrderParsed(out, txt, name){

    const safe = (v, d)=> (v == null ? d : v);
    const righe = Array.isArray(out?.righe) ? out.righe : [];
    const qSum  = righe.reduce((s,r)=> s + (Number(String(r?.qta||0).replace(',','.')) || 0), 0);

    // hardening: nessun id esterno
    try{ if (out && 'id' in out) delete out.id; }catch{}

    return {
      cliente     : safe(out?.cliente, '').trim(),
      descrizione : safe(out?.descrizione, out?.oggetto || 'Commessa da ordine PDF').trim(),
      scadenza    : safe(out?.scadenza, ''),
      righe       : righe.map(r => ({
        codice     : r?.codice || '',
        descrizione: r?.descrizione || '',
        um         : r?.um || 'PZ',
        qta        : Number(String(r?.qta||0).replace(',','.')) || 0,
      })),
      qtaPezzi    : Number(out?.qtaPezzi) || (qSum || 1),
      sorgente    : { kind:'pdf', name: name||'', bytes: (txt||'').length }
    };
  };

  // --- Registry unico dei parser -----------------------------------------
  window.__orderParsers = window.__orderParsers || [];

  function registerRuntime(def){
    if (!def || !def.id) return;
    const id = String(def.id).toLowerCase();
    if (!window.__orderParsers.some(p => String(p?.id||'').toLowerCase() === id)) {
      window.__orderParsers.push(def);
      console.log('[order-parser] registrato:', def.id);
    }
  }

  window.addOrderParser = function addOrderParser(def){
    try{
      if (!def || !def.id) return;
      registerRuntime(def);

      const s = lsGet('appSettings', {}) || {};
      const meta = Array.isArray(s.orderParsersMeta) ? s.orderParsersMeta : [];
      const id = String(def.id).toLowerCase();
      if (!meta.some(m => String(m.id||'').toLowerCase() === id)) {
        meta.push({ id: def.id, name: def.name || def.id, addedAt: new Date().toISOString() });
        s.orderParsersMeta = meta;
        lsSet('appSettings', s);
      }
    }catch(e){ console.warn('[order-parser] add fail', e); }
  };

  // ================== PARSER VIMEK v2 (una volta sola) ====================
  (function registerVimekV2(){
    if (window.__orderParsers.some(p => p && p.id === 'vimek-v2')) return;

    window.addOrderParser({
      id  : 'vimek-v2',
      name: 'Vimek (righe con Qta / Qtà / Q.T.)',
      test: (txt, name)=> /VIMEK/i.test(txt) && /(ORDINE|COMMESSA|ORDER)\s*[:#]?\s*/i.test(txt),
      extract: (txt, name)=> {
        const cliente = 'VIMEK BAKERY AUTOMATION SRL';
        const righe = [];

        // ABC-123 – Descrizione ... Qta 4 PZ
        const re = new RegExp(
          String.raw`^\s*([A-Z0-9][A-Z0-9._\-]{1,})\s*[–\-]\s*(.+?)\s+(?:QTA|QTÀ|QUANTITA|QUANTITÀ|Q\.?T\.?|QT)\s*[:=]?\s*([0-9]+(?:[.,][0-9]+)?)\s*([A-Z]{1,3})?\s*$`,
          'gmi'
        );
        let m;
        while ((m = re.exec(txt))) {
          const codice = (m[1]||'').trim();
          const descr  = (m[2]||'').replace(/\s+/g,' ').trim();
          const qta    = Number(String(m[3]||'0').replace(',','.')) || 0;
          const um     = (m[4]||'PZ').trim() || 'PZ';
          if (codice && descr && qta>0) righe.push({ codice, descrizione: descr, um, qta });
        }

        const descr = (txt.match(/Oggetto\s*[:\-]\s*(.+)/i)||[])[1]
                   || (txt.match(/Object\s*[:\-]\s*(.+)/i)||[])[1]
                   || 'Commessa da ordine PDF';
        const consegna = (txt.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/)||[])[1]
                      || (txt.match(/\b(20\d{2}[-/]\d{2}[-/]\d{2})\b/)||[])[1]
                      || '';

        return {
          cliente,
          descrizione: descr.trim(),
          righe,
          qtaPezzi: righe.reduce((s,r)=> s + (Number(r.qta)||0), 0) || 1,
          scadenza: consegna
        };
      }
    });

    // metti vimek-v2 in testa
    try{
      window.__orderParsers = [
        ...window.__orderParsers.filter(p => p && p.id === 'vimek-v2'),
        ...window.__orderParsers.filter(p => !p || p.id !== 'vimek-v2'),
      ];
    }catch{}
  })();

  // ================== PARSER ACME IT v1 (una volta sola) ==================
  (function registerAcme(){
    if (window.__orderParsers.some(p => p && p.id === 'acme-it-v1')) return;

    window.addOrderParser({
      id: 'acme-it-v1',
      name: 'ACME S.p.A. (ordine IT)',
      test: (txt, name='') => /ACME\s*S\.?p\.?A\.?/i.test(txt) && /Ordine|Order/i.test(txt),
      extract: (txt, name='') => {
        const numero = (txt.match(/Ordine\s*n[°o]?\s*([A-Z0-9\-\/]+)/i)||[])[1]
                    || (txt.match(/Order\s*No\.?\s*([A-Z0-9\-\/]+)/i)||[])[1]
                    || '';

        const dRaw   = (txt.match(/Data\s*[:\-]?\s*(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4})/i)||[])[1]
                    || (txt.match(/Date\s*[:\-]?\s*(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4})/i)||[])[1]
                    || '';

        const iso = (function(s){
          if (!s) return '';
          const p = s.replace(/\./g,'/').split('/');
          if (p.length!==3) return '';
          let [dd,mm,yy] = p.map(x=>x.trim());
          if (yy.length===2) yy = (Number(yy)>=70 ? '19'+yy : '20'+yy);
          return `${yy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
        })(dRaw);

        const descrizione = (txt.match(/Oggetto\s*[:\-]\s*(.+)/i)||[])[1]
                         || (txt.match(/Object\s*[:\-]\s*(.+)/i)||[])[1]
                         || 'Ordine Cliente';

        const righe = [];
        const rgx = /(?:^|\n)\s*\d+\s+([A-Z0-9.\-\/]{3,})\s+(.+?)\s+(\d+(?:[.,]\d+)?)\s*(PZ|NR|KG|pz|nr|kg)?\s*(?:\n|$)/g;
        let m;
        while ((m = rgx.exec(txt))) {
          const codice = (m[1]||'').trim();
          const descr  = (m[2]||'').replace(/\s+/g,' ').trim();
          const qta    = Number(String(m[3]||'0').replace(',','.')) || 0;
          const um     = (m[4]||'PZ').toUpperCase();
          if (codice && descr && qta>0) righe.push({ codice, descrizione: descr, qta, um });
        }

        return {
          cliente       : 'ACME S.p.A.',
          ordineCliente : { tipo:'PO', numero, data: iso },
          descrizione   : descrizione,
          righe
        };
      }
    });
  })();

  // ================== PARSER STEEL SYSTEMS ===============================
  (function registerSteel(){
    if (window.__orderParsers.some(p => p && p.id === 'steel-systems')) return;

    function toNum(s){
      if (s == null) return 0;
      const t = String(s).replace(/\./g,'').replace(',', '.');
      const n = Number(t);
      return Number.isFinite(n) ? n : 0;
    }

    window.addOrderParser({
      id  : 'steel-systems',
      name: 'Ordini STEEL SYSTEMS',
      test: (txt, name) => {
        const t = String(txt || '');
        return /STEEL SYSTEMS/i.test(t) && /Pos.*Codice.*Rev/i.test(t);
      },
      extract: (txt, name) => {
        const raw   = String(txt || '');
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

        const righe = [];
        let inBody = false;

        for (const line of lines) {
          if (!inBody) {
            if (/Pos.*Codice.*Rev/i.test(line)) inBody = true;
            continue;
          }

          const norm = line.replace(/\s+/g,' ').trim();
          if (/^TOTALE\s+ORDINE/i.test(norm)) break;
          if (/^Vi\s+chiediamo/i.test(norm)) break;
          if (/^ATTENZIONE/i.test(norm)) continue;
          if (!/\d/.test(norm)) continue;

          const toks = norm.split(/\s+/);
          if (toks.length < 8) continue;

          const pos    = toks[0];
          const codice = toks[1];
          if (!/^\d{2,}$/.test(pos))    continue;   // pos 10, 20, ...
          if (!/^\d{6,}$/.test(codice)) continue;   // codice 58042006

          const rev = toks[2]; // non usato

          // ultimi 5 token: UM, Q.tà, PU, PT, consegna
          const um        = toks[toks.length - 5];
          const qtaStr    = toks[toks.length - 4] || '0';
          const unitStr   = toks[toks.length - 3] || '0';
          const totStr    = toks[toks.length - 2] || '0';
          const consegnaS = toks[toks.length - 1] || '';

          const descrTokens = toks.slice(3, -5);
          const descr = descrTokens.join(' ');

          const qta = toNum(qtaStr);

          let dataConsegna = '';
          const m = consegnaS.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
          if (m) {
            let [_, dd, mm, yy] = m;
            if (yy.length === 2) {
              const yNum = Number(yy);
              yy = String(2000 + (Number.isFinite(yNum) ? yNum : 0)).padStart(4, '0');
            }
            dataConsegna = `${yy}-${mm}-${dd}`;
          }

          righe.push({
            codice,
            descrizione: descr,
            um,
            qta,
            dataConsegna
          });
        }

        // se il parser non ha trovato nulla, lascia che il pipeline faccia fallback
        if (!righe.length) return { cliente:'', descrizione:'', righe:[] };

        // Numero & data ordine (es. "Numero 4700045925 Data 03.11.2025")
        let ordineClienteNumero = '';
        let scadenza = '';

        for (const line of lines) {
          const m = line.match(/Numero\s+(\d{6,})\s+Data\s+(\d{2}\.\d{2}\.\d{4})/i);
          if (m) {
            ordineClienteNumero = m[1];
            const d = m[2];
            const m2 = d.match(/(\d{2})\.(\d{2})\.(\d{4})/);
            if (m2) {
              const [_, dd, mm, yy] = m2;
              scadenza = `${yy}-${mm}-${dd}`;
            }
            break;
          }
        }

        // Cliente: STEEL SYSTEMS ...
        let clienteRagione = '';
        for (const line of lines) {
          if (/STEEL SYSTEMS/i.test(line)) {
            clienteRagione = line.trim();
            break;
          }
        }

        // scadenza = minima dataConsegna tra le righe, se più stretta
        for (const r of righe) {
          if (!r.dataConsegna) continue;
          if (!scadenza || r.dataConsegna < scadenza) {
            scadenza = r.dataConsegna;
          }
        }

        const qtaTot = righe.reduce((s,r)=> s + (r.qta || 0), 0);

        return {
          cliente     : clienteRagione || '',
          descrizione : ordineClienteNumero
                        ? `Ordine ${ordineClienteNumero}`
                        : 'Commessa da ordine STEEL SYSTEMS',
          scadenza    : scadenza || '',
          qtaPezzi    : qtaTot || 1,
          righe       : righe.map(r => ({
            codice     : r.codice,
            descrizione: r.descrizione,
            um         : (r.um || 'PZ').toUpperCase(),
            qta        : r.qta || 0
          }))
        };
      }
    });
  })();

  // ================== PIPELINE UNICA DI IMPORT ============================
  window.importOrderFromPDFText = function(txt, name=''){
    const raw = String(txt || '');
    const sanitize = window.sanitizeOrderParsed || ((out)=>out);

    // 1) parser runtime registrati
    const arr = Array.isArray(window.__orderParsers) ? window.__orderParsers : [];
    for (const p of arr) {
      try{
        if (!p || typeof p.test !== 'function') continue;
        if (!p.test(raw, name)) continue;

        const out = (typeof p.extract === 'function' ? p.extract(raw, name) : {}) || {};
        const norm = sanitize(out, raw, name);

        // Se il parser dice di essere valido ma non ci sono righe con codice,
        // lasciamo che il pipeline provi gli altri fallback.
        const haRighe = Array.isArray(norm?.righe) && norm.righe.some(r => String(r.codice||'').trim());
        if (haRighe) return norm;
      }catch(e){
        console.warn('[order-parser] runtime error', p && p.id, e);
      }
    }

    // 2) fallback generico legacy, se esiste
    try{
      if (typeof window.parseOrderText === 'function') {
        const out = window.parseOrderText(raw, name) || {};
        const norm = sanitize(out, raw, name);
        const haRighe = Array.isArray(norm?.righe) && norm.righe.some(r => String(r.codice||'').trim());
        if (haRighe) return norm;
      }
    }catch(e){
      console.warn('[order-parser] parseOrderText fallback error', e);
    }

    // 3) ultima spiaggia: solo descrizione, nessuna riga
    const descr = (raw.match(/Oggetto\s*[:\-]\s*(.+)/i)||[])[1] || 'Commessa da ordine PDF';
    return sanitize({ descrizione: descr, righe: [] }, raw, name);
  };

  // ================== SALVATAGGIO COMMESSA IMPORTATA ======================
  window.saveImportedOrderAsCommessa = function saveImportedOrderAsCommessa(parsed){
    try{
      const genId = (function(){
        if (typeof window.getNextCommessaId === 'function') return window.getNextCommessaId;
        if (typeof window.nextProgressivo === 'function' && typeof window.formatNNN === 'function'){
          return function(){
            const n = window.nextProgressivo('C');
            return `C-${new Date().getFullYear()}-${window.formatNNN(n)}`;
          };
        }
        return function(){
          const y = new Date().getFullYear();
          const k = `C:${y}`;
          let counters={}; try{ counters = JSON.parse(localStorage.getItem('counters')||'{}')||{}; }catch{}
          const n = (Number(counters[k]||0)||0)+1; counters[k]=n;
          try{ localStorage.setItem('counters', JSON.stringify(counters)); }catch{}
          return `C-${y}-${String(n).padStart(3,'0')}`;
        };
      })();

      const all = Array.isArray(lsGet('commesseRows', [])) ? lsGet('commesseRows', []) : [];
      let id = genId();
      const exists = x => all.some(c => String(c.id) === String(x));
      if (exists(id)) { let i=1; while(exists(`${id}-${i}`)) i++; id = `${id}-${i}`; }

      const righe = Array.isArray(parsed?.righe) ? parsed.righe : [];
      const comm = {
        id,
        cliente      : (parsed?.cliente||'').trim(),
        descrizione  : (parsed?.descrizione||parsed?.oggetto||'Commessa da ordine PDF').trim(),
        qtaPezzi     : Number(parsed?.qtaPezzi) || (righe.reduce((s,r)=> s + (Number(r?.qta)||0), 0) || 1),
        scadenza     : parsed?.scadenza || '',
        righeArticolo: righe.map(r => ({
          codice     : r?.codice||'',
          descrizione: r?.descrizione||'',
          um         : r?.um||'PZ',
          qta        : Number(r?.qta)||0
        })),
        createdAt    : new Date().toISOString(),
        updatedAt    : new Date().toISOString(),
        sorgente     : parsed?.sorgente || { kind:'pdf', name: parsed?.sorgente?.name||'', bytes: parsed?.sorgente?.bytes||0 }
      };

      // se il cliente è “noi stessi”, azzera il campo
      try {
        const app = lsGet('appSettings', {});
        const selfSet = new Set((app.selfAliases||[]).map(x => String(x||'').trim().toLowerCase()));
        if (!comm.cliente || selfSet.has(String(comm.cliente).trim().toLowerCase())) comm.cliente = '';
      } catch {}

      try {
        if (typeof window.applyMatchedTemplate === 'function') window.applyMatchedTemplate(comm);
      } catch {}

      all.unshift(comm);
      lsSet('commesseRows', all);
      try { window.syncExportToCloudOnly && window.syncExportToCloudOnly(['commesseRows']); } catch {}
      alert('Ordine importato in commessa: ' + id);
      try { location.hash = '#/ddt?from=' + id; } catch {}
      return id;

    }catch(e){
      alert('Errore salvataggio commessa importata');
      console.error(e);
      return null;
    }
  };
})();

  // === Prefill DDT da commessa (idempotente) ===
  window.prefillDDTFromCommessa = window.prefillDDTFromCommessa || function(comm){
    try{
      const lines = Array.isArray(comm?.righeArticolo) && comm.righeArticolo.length
        ? comm.righeArticolo.map(r => ({
            codice: String(r?.codice||''),
            descrizione: String(r?.descrizione||comm?.descrizione||''),
            um: String(r?.um||'PZ'),
            qta: Number(r?.qta||0) || 0,
          }))
        : [{
            codice: String(comm?.articoloCodice||''),
            descrizione: String(comm?.descrizione||''),
            um: 'PZ',
            qta: Number(comm?.qtaPezzi||1) || 1
          }];
      // compat: duplichiamo sulle chiavi più comuni per qualsiasi UI
      return {
        righe: lines,
        righeDDT: lines.map(x=>({...x})),
        righeArticolo: lines.map(x=>({...x}))
      };
    }catch{ return { righe:[], righeDDT:[], righeArticolo:[] }; }
  };

  // === Prefill DDT da commessa (idempotente) ===
  window.prefillDDTFromCommessa = window.prefillDDTFromCommessa || function(comm){
    try{
      const has = Array.isArray(comm?.righeArticolo) && comm.righeArticolo.length > 0;
      const lines = has
        ? comm.righeArticolo.map(r => ({
            codice: String(r?.codice||''),
            descrizione: String(r?.descrizione||comm?.descrizione||''),
            um: String(r?.um||'PZ'),
            qta: Number(r?.qta||0) || 0,
          }))
        : [{
            codice: String(comm?.articoloCodice||''),
            descrizione: String(comm?.descrizione||''),
            um: 'PZ',
            qta: Number(comm?.qtaPezzi||1) || 1
         }];

    // compat: duplichiamo sulle chiavi più comuni, così qualunque UI legge qualcosa
    return {
      righe: lines,
      righeDDT: lines.map(x=>({...x})),
      righeArticolo: lines.map(x=>({...x}))
    };
  }catch{
    return { righe:[], righeDDT:[], righeArticolo:[] };
  }
};

  // Scorciatoia: apri DDT dalla commessa più recente
window.openDDTFromLastCommessa = window.openDDTFromLastCommessa || function(){
  try{
    const id=(JSON.parse(localStorage.getItem('commesseRows')||'[]')[0]||{}).id;
    if(!id) return alert('Nessuna commessa trovata');
    location.hash = '#/ddt?from='+id;
  }catch(e){ alert('Errore apertura DDT'); console.error(e); }
};

  // === Timbratura: scelta riga commessa (idempotente) =================
window.chooseRigaForCommessa = window.chooseRigaForCommessa || function(comm){
  try{
    const righe = Array.isArray(comm?.righeArticolo) ? comm.righeArticolo : [];
    if (!righe.length) return null;                   // nessuna riga → niente da scegliere
    if (righe.length === 1) return { idx:0, ...righe[0] };

    // prompt semplice e robusto (testo + indice 1..N)
    const menu = righe.map((r,i)=> {
      const cod = String(r?.codice||'').trim();
      const ds  = String(r?.descrizione||'').trim();
      const um  = String(r?.um||'PZ').trim();
      const qt  = Number(r?.qta||0)||0;
      return `${i+1}) ${cod ? cod+' — ' : ''}${ds} [${qt} ${um}]`;
    }).join('\n');
    const ans = prompt(`Questa commessa ha ${righe.length} righe.\nScegli su quale stai timbrando:\n\n${menu}\n\nScrivi un numero (1-${righe.length})`, '1');
    const k = Math.max(1, Math.min(righe.length, Number(ans||1)|0)) - 1;
    return { idx:k, ...righe[k] };
  }catch(e){ console.warn('chooseRigaForCommessa error', e); return null; }
};

// utility: trova commessa per id
window.findCommessaById = window.findCommessaById || function(id){
  try{
    const all = JSON.parse(localStorage.getItem('commesseRows')||'[]');
    return all.find(x => String(x.id) === String(id)) || null;
  }catch{ return null; }
};

// === APP + ROUTER DEFINITIVI (sidebar inclusa) ===
(function () {
  if (window.__ANIMA_APP_MOUNTED__) return;

  const e = React.createElement;

  // ---------------- Sidebar (completa, con dedupe + toggle persistente) ----------------
  window.__ALLOWED_WORKER_ROUTES = window.__ALLOWED_WORKER_ROUTES || new Set(['#/timbratura', '#/commesse', '#/impostazioni', '#/login', '#/ddt']);
  function Sidebar({ hash }) {
    const R   = (window.ROUTES || {});
    const cur = (hash || (location.hash || '#/dashboard')).toLowerCase();

    // Stato “aperta/chiusa” persistente
    const [open, setOpen] = React.useState(() => {
      try { return JSON.parse(localStorage.getItem('sidebarOpen') || 'true'); }
      catch { return true; }
    });
    React.useEffect(() => {
      try { localStorage.setItem('sidebarOpen', JSON.stringify(open)); } catch {}
      try { document.body.classList.toggle('sidebar-collapsed', !open); } catch {}
    }, [open]);
    React.useEffect(() => {
      try {
        const v = JSON.parse(localStorage.getItem('sidebarOpen') || 'true');
        document.body.classList.toggle('sidebar-collapsed', !v);
      } catch {}
    }, []);

    // Voci di menù (base)
    const ALL_LINKS = [
      ['__title__', 'ANIMA'],

      ['__section__', 'Dashboard'],
        ['#/dashboard', 'Dashboard'],

      ['__section__', 'Produzione'],
        ['#/commesse', 'Commesse'],
        ['#/ore', 'Ore'],

      ['__section__', 'Anagrafiche'],
        ['#/clienti', 'Clienti'],
        ['#/fornitori', 'Fornitori'],

      ['__section__', 'Documenti'],
        ['#/ordini', 'Ordini fornitori'],
        ['#/ddt', 'DDT'],
        ['#/fatture', 'Fatture'],

      ['__section__', 'Magazzino'],
        ['#/magazzino', 'Magazzino'],
        ['#/movimenti', 'Movimenti'],

      ['__section__', 'Report'],
        ['#/report-tempi', 'Report tempi'],
        ['#/report-materiali', 'Report materiali'],
        ['#/report', 'Report'],

      ['__section__', 'Sistema'],
        ['#/impostazioni', 'Impostazioni'],
    ];

    // — Filtro ruoli: i worker vedono solo alcune rotte
    const USER    = window.__USER || null;
    const isAdmin = !!(USER && USER.role === 'admin');
    const ALLOWED = window.__ALLOWED_WORKER_ROUTES;  // ← usa la set globale con #/ddt incluso

    const LINKS = isAdmin
      ? ALL_LINKS
      : ALL_LINKS.filter(([href]) =>
          href === '__title__' || href === '__section__' || (ALLOWED && ALLOWED.has(href))
        );

    // Link factory (nome diverso per evitare conflitti)
    const mkLink = (h, label) =>
      e('a', {
          href: h,
          className: 'nav-link' + (cur === h ? ' active' : ''),
          title: label
        },
        e('span', { className:'nav-text' }, label)
      );

    // De-duplica link ed elimina sezioni “vuote”
    const seen = new Set();
    const CLEAN = [];
    let pendingSection = null;

    for (const [href, label] of LINKS) {
      if (href === '__title__') {
        pendingSection = null;
        CLEAN.push([href, label]);
        continue;
      }
      if (href === '__section__') {
        pendingSection = label;               // verrà resa visibile solo se segue almeno un link
        continue;
      }
      // è un link
      if (String(href||'').startsWith('#/')) {
        if (seen.has(href)) continue;         // duplicato → salta
        seen.add(href);
      }
      if (pendingSection != null) {
        CLEAN.push(['__section__', pendingSection]); // prima volta che troviamo un link → mostriamo la sezione
        pendingSection = null;
      }
      CLEAN.push([href, label]);
    }
    // se la lista finisce con una sezione senza link, non la aggiungiamo

    const nodes = [];
    for (const [href, label] of CLEAN) {
      if (href === '__title__') {
        // brand + toggle
        nodes.push(
          e('div', { key:'brand', className:'row', style:{ justifyContent:'space-between', alignItems:'center' } },
            e('div', { className:'brand' }, label),
            e('button', {
              className:'btn btn-outline',
              title: open ? 'Comprimi sidebar' : 'Espandi sidebar',
              onClick: ()=> setOpen(o => !o)
            }, open ? '⟨' : '⟩')
          )
        );
        continue;
      }
      if (href === '__section__') {
        nodes.push(e('div', { key:'sec-'+label, className:'groupTitle' }, label));
        continue;
      }
      if (R[href]) {
        nodes.push(e('div', { key: href }, mkLink(href, label)));
      }
    }

    return e('aside', { className: 'sidebar' }, e('nav', { className: 'nav' }, nodes));
  }

  // ---------------- pickView centralizzato (ignora query e applica RBAC) ----------------
  window.pickView = function () {
    const raw = (location.hash || '#/dashboard').toLowerCase();
    const h = raw.split('?')[0]; // ignora query es. #/timbratura?job=...

    // se già autenticato, non restare su #/login
    if (h === '#/login' && (window.__USER || window.currentUser)) {
      location.hash = '#/dashboard';
      return () => e('div', null);
    }

    // RBAC: i worker possono solo certe viste
    const u = window.__USER || null;
    const isAdmin = !!(u && u.role === 'admin');
    if (!isAdmin) {
      const allowed = new Set(['#/timbratura', '#/commesse', '#/impostazioni', '#/login', '#/ddt']);
      if (!allowed.has(h)) {
        location.hash = '#/timbratura';
        return () => e('div', null);
      }
    }

    const R = window.ROUTES || {};
    return R[h] || R['#/ddt'] || function () {
      return e('div', { className: 'page' }, 'Vista non trovata: ' + h);
    };
  };

  // ---------------- App + Router (unico) ----------------
  function App() {
    const [hash, setHash] = React.useState((location.hash || '#/dashboard').toLowerCase());

    React.useEffect(() => {
      const handler = () => setHash((location.hash || '#/dashboard').toLowerCase());
      // installo un solo listener
      if (window.__anima_router_handler_app) {
        window.removeEventListener('hashchange', window.__anima_router_handler_app);
      }
      window.__anima_router_handler_app = handler;
      window.addEventListener('hashchange', handler);
      return () => {
        try { window.removeEventListener('hashchange', handler); } catch {}
        if (window.__anima_router_handler_app === handler) window.__anima_router_handler_app = null;
      };
    }, []);

    const View = window.pickView();
    const params = new URLSearchParams((location.hash.split('?')[1] || ''));
    const q = params.get('q') || '';

      return e('div', { className:'layout' },
      e(Sidebar, { hash }),
      e('main', { className:'content' }, e(View, { hash, query: q }))
    );

  }

  // ---------------- Mount ----------------
  const rootEl = document.getElementById('root');
  if (!rootEl) { console.error('#root non trovato'); return; }

  // Ripristina ultima rotta se l'URL non ne specifica una
  try {
    const h0 = String(location.hash || '');
    if (!h0 || h0 === '#' || h0 === '#/') {
      const last = localStorage.getItem('lastRoute') || '#/dashboard';
      if (typeof last === 'string' && last.startsWith('#/')) {
        location.replace(last); // no history pollution
      } else {
        location.replace('#/dashboard');
      }
    }
  } catch {}

  const root = ReactDOM.createRoot(rootEl);
  window.requestAppRerender = () => root.render(e(App));
  root.render(e(App));
  window.__ANIMA_APP_MOUNTED__ = true;

  // Dedupe: elimina sidebar legacy se presente
  try {
    const modern = document.querySelector('aside.sidebar');
    if (modern) { document.querySelectorAll('aside.card').forEach(a => a.remove()); }
  } catch {}

  // Riallinea subito lo stato della sidebar
  try {
    const v = JSON.parse(localStorage.getItem('sidebarOpen') || 'true');
    document.body.classList.toggle('sidebar-collapsed', !v);
  } catch {}

  // Salva sempre l'ultima rotta visitata
  try {
    const saveRoute = () => {
      try { localStorage.setItem('lastRoute', location.hash || '#/dashboard'); } catch {}
    };
    saveRoute();
    window.addEventListener('hashchange', saveRoute);
  } catch {}
})();

// === Sidebar: no-history navigation (migliora tasto Indietro) ===
(function tameSidebarHistory(){
  if (window.__tameSidebarHistoryInstalled__) return;
  window.__tameSidebarHistoryInstalled__ = true;
  document.addEventListener('click', function(ev){
    const a = ev.target.closest && ev.target.closest('.sidebar a.nav-link[href^="#/"]');
    if (!a) return;
    ev.preventDefault();
    const h = a.getAttribute('href');
    // sostituisci la voce corrente nella history anziché aggiungerne una nuova
    location.replace(h);
  });
})();

// === Alias report (compatibilità) ===
window.openReport          = window.openReport          || function(){ location.hash = '#/report'; };
window.openReportTempi     = window.openReportTempi     || function(){ location.hash = '#/report-tempi'; };
window.openReportMateriali = window.openReportMateriali || function(){ location.hash = '#/report-materiali'; };

// Persistenza robusta OF (aggiunge/aggiorna in LS)
(function(){
  window.persistOF = window.persistOF || function(of){
    try{
      if (!of || !of.id){ alert('OF senza id'); return false; }
      const all = JSON.parse(localStorage.getItem('ordiniFornitoriRows')||'[]')||[];
      const i = all.findIndex(x => String(x.id)===String(of.id));
      if (i>=0) all[i] = of; else all.push(of);
      localStorage.setItem('ordiniFornitoriRows', JSON.stringify(all));
      window.__anima_dirty = true;
      return true;
    }catch(e){ alert('Errore salvataggio OF: '+(e?.message||e)); return false; }
  };
})();

// --- OVERRIDE finale: stampa con numerazione robusta (JS, compatibile .pageNum e .content) ---
(function(){
  window.safePrintHTMLStringWithPageNum = function(html){
    try{
      const ifr = document.createElement('iframe');
      ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      document.body.appendChild(ifr);

      const w = ifr.contentWindow, d = w.document;
      d.open(); d.write(String(html||'')); d.close();

      const afterLoad = () => {
        try{
          // Dedupe eventuali .pagebox
          try{
            const boxes = Array.from(d.querySelectorAll('.pagebox'));
            if (boxes.length > 1) {
              const keep = d.querySelector('#pagebox') || boxes[0];
              boxes.forEach(el => { if (el !== keep) el.remove(); });
            }
          }catch{}

          // neutralizza ::after che può produrre " / "
          const kill = d.createElement('style');
          kill.textContent = '.pageNum::after,.pageX::after{content:"" !important}';
          d.head.appendChild(kill);

          // leggi @page margin se presenti (altrimenti 16/22mm)
          let topMm = 16, bottomMm = 22;
          try{
            const cssText = Array.from(d.querySelectorAll('style')).map(s => s.textContent || '').join('\n');
            const m = /@page\s*{[^}]*margin\s*:\s*([0-9.]+)mm(?:\s+([0-9.]+)mm(?:\s+([0-9.]+)mm(?:\s+([0-9.]+)mm)?)?)?/i.exec(cssText);
            if (m){
              const v = [m[1],m[2],m[3],m[4]].filter(Boolean).map(parseFloat);
              if (v.length === 1){ topMm = bottomMm = v[0]; }
              else if (v.length === 2){ topMm = bottomMm = v[0]; }
              else if (v.length === 3){ topMm = v[0]; bottomMm = v[2]; }
              else if (v.length >= 4){ topMm = v[0]; bottomMm = v[2]; }
            }
          }catch{}

          // mm→px
          const mmToPx = (() => {
            const t = d.createElement('div');
            t.style.height='100mm'; t.style.position='absolute'; t.style.visibility='hidden';
            d.body.appendChild(t);
            const px = t.getBoundingClientRect().height || 0;
            t.remove(); return px/100;
          })();

          // altezza utile A4
          const pageHeightMm = 297 - (topMm + bottomMm);
          const pageHeightPx = (mmToPx>0) ? (mmToPx*pageHeightMm) : (w.innerHeight||1123);

          // misura contenuto: preferisci wrapper .content (Fatture ce l’hanno)
          const content = d.querySelector('.content') || d.body;
          const h = Math.max(content.scrollHeight, content.offsetHeight, d.body.scrollHeight);

          // totale con tolleranze anti “falso 2”
          let total = Math.max(1, Math.ceil(h / pageHeightPx));
          if (!Number.isFinite(total) || total < 1) total = 1;
          const overPx = h - pageHeightPx;

          if (total === 2) {
            const snapPx = Math.max(120, pageHeightPx * 0.15); // ~15% o 120px
            if (overPx <= snapPx) total = 1;
          }
          if (total === 2) {
            const lastTr = d.querySelector('table tbody tr:last-child');
            if (lastTr) {
              const r = lastTr.getBoundingClientRect();
              if (r && (r.bottom + 16) < pageHeightPx) total = 1;
            }
          }

          // scrivi SEMPRE il testo nella .pageNum
          const pn = d.querySelector('#pagebox .pageNum') || d.querySelector('.pageNum');
          if (pn){ pn.removeAttribute('data-mode'); pn.textContent = `1 / ${total}`; }

        } finally {
          try { w.focus(); w.print(); } catch {}
          setTimeout(()=>{ try{ ifr.remove(); }catch{} }, 300);
        }
      };

      // attesa immagini/loghi per misurazioni stabili
      const imgs = Array.from(d.images||[]);
      if (imgs.length){
        let done=0; const tick=()=>{ if(++done>=imgs.length) setTimeout(afterLoad,120); };
        imgs.forEach(im=> im.complete ? tick() : (im.addEventListener('load',tick,{once:true}), im.addEventListener('error',tick,{once:true})));
        setTimeout(afterLoad, 1600);
      } else {
        setTimeout(afterLoad, 150);
      }

      w.addEventListener?.('afterprint', () => { try{ ifr.remove(); }catch{} });
    }catch(e){
      console.warn('safePrintHTMLStringWithPageNum error', e);
      if (window.safePrintHTMLString) window.safePrintHTMLString(html);
    }
  };
})();


// === Magazzino: vista movimenti come alias ===
window.MagazzinoMovimentiView = window.MagazzinoMovimentiView || function(){
  return React.createElement(MagazzinoView, { initialTab: 'movimenti' });
};

// === Utils hash query ===
window.getHashParam = window.getHashParam || function(name){
  try{
    const q = (location.hash.split('?')[1] || '');
    return new URLSearchParams(q).get(name) || '';
  }catch{ return ''; }
};

/* ================== TIMBRATURA MOBILE — versione unica ==================
   - Timer start/stop
   - x2 / x3 operatori
   - Cambio bombola gas (extra)
   - Aggiorna oreRows + commesseRows (qtaProdotta + totale)
   - Riga articolo (multi-articolo) con rigaIdx e prompt “Dettaglio…”
   - QR scanner integrato (Html5Qrcode / Html5QrcodeScanner, se presenti)
========================================================================= */
var TimbraturaMobileView = function(){
  const e = React.createElement;

  // ---- Helpers LocalStorage sicuri (riusa globali se esistono) ----
  const lsGet = (window.lsGet) || ((k,d)=>{ try{ return JSON.parse(localStorage.getItem(k)) ?? d; }catch{ return d; }});
  const lsSet = (window.lsSet) || ((k,v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); window.__anima_dirty = true; }catch{} });

  // ---- Tempo ----
  const todayISO = () => new Date().toISOString().slice(0,10);
  const _toMin = (s) => {
    if (s == null) return 0;
    const t = String(s).trim();
    const m = t.match(/^(\d{1,4})(?::([0-5]?\d))?$/);
    if (!m) return Math.max(0, Number(t) || 0);
    const h = parseInt(m[1] || '0', 10) || 0;
    const mm = parseInt(m[2] || '0', 10) || 0;
    return h * 60 + mm;
  };
  const fmtHHMM = (mins) => {
    const t = Math.max(0, Math.round(Number(mins)||0));
    const h = Math.floor(t/60), m=t%60;
    return `${h}:${String(m).padStart(2,'0')}`;
  };
  const fmtHMS = (ms) => {
    const s = Math.max(0, Math.floor(ms/1000));
    const hh = String(Math.floor(s/3600)).padStart(2,'0');
    const mm = String(Math.floor((s%3600)/60)).padStart(2,'0');
    const ss = String(s%60).padStart(2,'0');
    return `${hh}:${mm}:${ss}`;
  };

  // ---- Progresso commessa (fallback se non esiste window.producedPieces) ----
  const producedPieces = window.producedPieces || function(c){
    const qTot = Math.max(1, Number(c?.qtaPezzi || 1));
    if (!Array.isArray(c?.fasi) || c.fasi.length === 0) {
      const qp = Math.max(0, Number(c?.qtaProdotta || 0) || 0);
      return Math.min(qTot, qp);
    }
    const perPhase = c.fasi
      .filter(f => !(f?.unaTantum || f?.once))
      .map(f => Math.max(0, Number(f.qtaProdotta || 0)));
    if (perPhase.length === 0) return 0;
    return Math.min(qTot, Math.min(...perPhase));
  };

  // ---- jobId da hash ?job=... o da 'qrJob' persistito ----
  const [jobId, setJobId] = React.useState('');
  React.useEffect(()=>{
    function refreshJob(){
      const h = window.location.hash || '';
      const qs = h.split('?')[1] || '';
      const params = new URLSearchParams(qs);
      const fromHash = params.get('job') || '';
      if (fromHash) { setJobId(fromHash); return; }
      try {
        const tmp = JSON.parse(localStorage.getItem('qrJob') || 'null');
        if (tmp) setJobId(String(tmp));
      } catch {}
    }
    refreshJob();
    window.addEventListener('hashchange', refreshJob);
    return ()=> window.removeEventListener('hashchange', refreshJob);
  },[]);

  // ---- Dataset reattivi + dirty tick ----
  const [refresh, setRefresh] = React.useState(0);
  React.useEffect(()=>{
    function onFocus(){ setRefresh(x=>x+1); }
    function onStorage(ev){
      if (['commesseRows','oreRows','appSettings'].includes(ev.key)) setRefresh(x=>x+1);
    }
    const t = setInterval(()=>{ if (window.__anima_dirty) { window.__anima_dirty = false; setRefresh(x=>x+1); }}, 1000);
    window.addEventListener('focus', onFocus);
    window.addEventListener('storage', onStorage);
    return ()=>{ clearInterval(t); window.removeEventListener('focus', onFocus); window.removeEventListener('storage', onStorage); };
  },[]);

  const app        = React.useMemo(()=> lsGet('appSettings', {}) || {}, [refresh]);
  const operators  = React.useMemo(()=> (Array.isArray(app.operators) ? app.operators : []).map(x=>String(x).trim()).filter(Boolean), [app, refresh]);
  const commesse   = React.useMemo(()=> lsGet('commesseRows', []), [refresh]);
  const oreRows    = React.useMemo(()=> lsGet('oreRows', []), [refresh]);

  const commessa = React.useMemo(()=> (Array.isArray(commesse)?commesse:[]).find(c=>String(c.id)===String(jobId)) || null, [commesse, jobId]);
  const fasi     = React.useMemo(()=> Array.isArray(commessa?.fasi) ? commessa.fasi : [], [commessa]);

    // Stato rete (badge ONLINE/OFFLINE)
    const [isOnline, setIsOnline] = React.useState(navigator.onLine);
    React.useEffect(()=>{
      const go = ()=>setIsOnline(true);
      const off= ()=>setIsOnline(false);
      window.addEventListener('online', go);
      window.addEventListener('offline', off);
      return ()=>{ window.removeEventListener('online', go); window.removeEventListener('offline', off); };
    },[]);

  // — Righe articolo (supporta diversi nomi campo)
  const righe = React.useMemo(() => {
    if (!commessa) return [];
    const r1 = Array.isArray(commessa.righeArticolo) ? commessa.righeArticolo : null;
    const r2 = Array.isArray(commessa.righe) ? commessa.righe : null;
    return r1 || r2 || [];
  }, [commessa]);

  // — Riga articolo selezionata (indice 0-based o '' se nessuna)
  const [rigaIdx, setRigaIdx] = React.useState('');
  React.useEffect(() => {
    if (!commessa) { setRigaIdx(''); return; }
    const valid = Array.isArray(righe) ? righe.filter(r => String(r?.codice||'').trim() || String(r?.descrizione||'').trim()) : [];
    if (valid.length === 1) setRigaIdx('0');
  }, [commessa, righe]);

  // ---- Stato form ----
  const [operatore, setOperatore] = React.useState('');
  const [faseIdx, setFaseIdx]     = React.useState('');    // '' = nessuna fase
  React.useEffect(()=>{ if (!operatore && operators.length===1) setOperatore(operators[0]); }, [operators, operatore]);
  React.useEffect(()=>{ if (commessa && fasi.length && (faseIdx==='' || faseIdx==null)){ setFaseIdx('0'); } }, [commessa, fasi]);

  // ---- x2/x3 + Cambio bombola gas ----
  const [secondOp, setSecondOp]   = React.useState(false);
  const [thirdOp,  setThirdOp]    = React.useState(false);
  const [gasChange, setGasChange] = React.useState(false);
  const [opsCount, setOpsCount]   = React.useState(1);
  const ACTIVE_KEY = 'timbraturaActive';

  const [active, setActive] = React.useState(null);
  React.useEffect(()=>{
    if (thirdOp)      { if (secondOp) setSecondOp(false); setOpsCount(3); }
    else if (secondOp){ setOpsCount(2); }
    else              { setOpsCount(1); }
    if (active){
      const upd = {...active, opsCount: (thirdOp ? 3 : (secondOp ? 2 : 1))};
      setActive(upd); lsSet(ACTIVE_KEY, upd);
    }
  }, [secondOp, thirdOp]); // <-- corretto

  // Ripristino sessione attiva per quella commessa
  React.useEffect(()=>{
    const raw = lsGet(ACTIVE_KEY, null);
    if (raw && String(raw.jobId) === String(jobId)){
      setActive(raw);
      setOperatore(raw.operatore||'');
      setFaseIdx(String(raw.faseIdx ?? ''));
      const oc = Number(raw.opsCount||1);
      setSecondOp(oc===2); setThirdOp(oc===3); setOpsCount(Math.min(3, Math.max(1, oc)));
      setGasChange(!!raw.isGasChange);
      if (typeof raw.rigaIdx === 'number') setRigaIdx(String(raw.rigaIdx));
    }
  },[jobId]);

  // Timer visuale
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(()=>{ if (!active) return; const t = setInterval(()=> setNow(Date.now()), 1000); return ()=> clearInterval(t); },[active]);

  // Minuti effettivi per fase selezionata (retro-compat con vari formati)
  const effMinsPhase = React.useMemo(() => {
    if (!commessa || faseIdx === '' || !Array.isArray(oreRows)) return 0;
    const idx = Number(faseIdx);
    const faseLabel = (Array.isArray(fasi) && fasi[idx])
      ? String(fasi[idx].lav || '').toLowerCase()
      : '';
    return oreRows
      .filter(o => {
        if (!o) return false;
        if (String(o.commessaId) !== String(commessa.id)) return false;
        const sameIdx = Number(o.faseIdx) === idx;
        const sameLabel = o.fase && String(o.fase).toLowerCase() === faseLabel;
        return sameIdx || sameLabel;
      })
      .reduce((sum, o) => {
        const mins =
          (Number(o.oreMin) || 0) ||
          (Number(o.minuti) || 0) ||
          (Number(o.minutes) || 0) ||
          _toMin(o.oreHHMM || 0);
        return sum + Math.max(0, mins);
      }, 0);
  }, [oreRows, commessa, faseIdx, fasi]);

  const plannedMinsOfPhase = (fase) => {
    if (!fase) return 0;
    const candidates = [fase.oreMin, fase.minuti, fase.min, fase.oreHHMM, fase.ore];
    for (const v of candidates) { const n = _toMin(v); if (n > 0) return n; }
    return 0;
  };

  // ---- QR Scanner integrato ----
  const [scanOpen, setScanOpen] = React.useState(false);
  const scannerRef = React.useRef(null);
  function extractJobId(str){
    if (!str) return '';
    const m = String(str).match(/[A-Z]-\d{4}-\d{3}/);
    if (m) return m[0];
    return String(str).trim();
  }
  function openScanner(){
    if (!(window.Html5Qrcode || window.Html5QrcodeScanner)) {
      alert('Scanner non disponibile: aggiungi /vendor/html5-qrcode.min.js e /vendor/jsQR.js nel deploy.');
      return;
    }
    setScanOpen(true);
  }
  React.useEffect(()=>{
    if (!scanOpen) return;
    const elId = 'qr-reader';
    const start = async ()=>{
      try{
        if (window.Html5QrcodeScanner){
          const scanner = new window.Html5QrcodeScanner(elId, { fps: 10, qrbox: 240 }, false);
          scanner.render((decodedText)=>{
            try{
              const jid = extractJobId(decodedText);
              if (jid){ setJobId(jid); try{ localStorage.setItem('qrJob', JSON.stringify(jid)); }catch{} }
              setScanOpen(false);
              scanner.clear && scanner.clear();
            }catch{}
          }, ()=>{});
          scannerRef.current = scanner;
        } else if (window.Html5Qrcode){
          const h5 = new window.Html5Qrcode(elId);
          await h5.start({ facingMode: "environment" }, { fps: 10, qrbox: 240 }, (decodedText)=>{
            try{
              const jid = extractJobId(decodedText);
              if (jid){ setJobId(jid); try{ localStorage.setItem('qrJob', JSON.stringify(jid)); }catch{} }
              setScanOpen(false);
              h5.stop().then(()=> h5.clear());
            }catch{}
          });
          scannerRef.current = h5;
        }
      }catch(e){ console.warn('QR init error', e); }
    };
    const t = setTimeout(start, 50);
    return ()=>{ clearTimeout(t); try{
      const sc = scannerRef.current;
      if (sc && sc.clear) sc.clear();
      if (sc && sc.stop) sc.stop().then(()=> sc.clear && sc.clear());
      scannerRef.current = null;
    }catch{} };
  }, [scanOpen]);

  // ---- Selettore riga (prompt) ----
  function selectRiga(){
    if (!commessa || !Array.isArray(righe) || righe.length <= 1) return;
    const elenco = righe.map((r,i)=> 
      `${i+1}) ${r.codice||''} — ${r.descrizione||''} ${r.um ? '('+r.um+')' : ''} ${r.qta!=null ? '× '+r.qta : ''}`
    ).join('\n');
    const def = (rigaIdx==='' || rigaIdx==null) ? '1' : String(Number(rigaIdx)+1);
    const idx = prompt(`Seleziona riga articolo (1..${righe.length})\n\n${elenco}`, def);
    if (!idx) return;
    const n = Number(idx) - 1;
    if (!Number.isFinite(n) || n < 0 || n >= righe.length) { alert('Indice non valido'); return; }
    setRigaIdx(String(n));
  }

  // ---- Start/Stop ----
  function start(){
    if (!jobId){ alert('Commessa non valida'); return; }
    if (!operatore){ alert('Seleziona un operatore'); return; }
    if (faseIdx===''){ alert('Seleziona una fase'); return; }
    // Se multi-articolo, obbligo scelta riga
    const validRighe = Array.isArray(righe) ? righe.filter(r => (r?.codice||r?.descrizione)) : [];
    if (validRighe.length > 1 && (rigaIdx==='' || rigaIdx==null)) { alert('Seleziona la riga articolo'); return; }

    const payload = {
      jobId: String(jobId),
      faseIdx: Number(faseIdx),
      operatore: String(operatore||''),
      opsCount: Math.min(3, Math.max(1, Number(opsCount)||1)),
      startISO: new Date().toISOString(),
      isGasChange: !!gasChange,
      rigaIdx: (rigaIdx===''||rigaIdx==null) ? null : Number(rigaIdx)
    };
    lsSet(ACTIVE_KEY, payload);
    setActive(payload);
  }

  const [askQty, setAskQty] = React.useState(null);
  const [qtyVal, setQtyVal] = React.useState('');
  function stop(){
    if (!active) return;
    const startMs = new Date(active.startISO).getTime();
    let mins = Math.round((Date.now() - startMs)/60000);
    mins = Math.max(1, mins) * Math.min(3, Math.max(1, Number(active.opsCount)||1));
    setQtyVal('');
    const snap = { ...active };
    try { localStorage.removeItem(ACTIVE_KEY); } catch {}
    setActive(null);
    setAskQty({ minsEff: mins, snapshot: snap });
  }
  function cancelStop(){
    if (askQty && askQty.snapshot){
      const snap = askQty.snapshot;
      try { lsSet(ACTIVE_KEY, snap); } catch {}
      setActive(snap);
    }
    setAskQty(null);
  }

  async function confirmStop(){
    if (!askQty) return;
    const qty = Math.max(0, Math.floor(Number((qtyVal ?? '').toString().trim() === '' ? 0 : qtyVal)));
    const act = askQty.snapshot || active;

    const oreMin  = askQty.minsEff;
    const ore     = +(oreMin/60).toFixed(2);
    const oreHHMM = fmtHHMM(oreMin);

    // ===== RAMO SPECIALE: CAMBIO BOMBOLA GAS =====
    if (gasChange || (act && act.isGasChange)){
      try{
        const nid = (window.nextIdUnique
          ? window.nextIdUnique('ore','O','oreRows')
          : (function(){
              const y = new Date().getFullYear();
              const arr = lsGet('oreRows',[])||[];
              const n = 1 + arr.filter(r => String(r.id||'').startsWith(`O-${y}-`)).length;
              return { id: `O-${y}-${String(n).padStart(3,'0')}` };
            })()
        );
        const recExtra = {
          id: nid.id, data: todayISO(),
          commessaId: String(jobId),
          faseIdx: null,
          operatore: act.operatore || '',
          oreHHMM, oreMin, ore,
          note: 'Cambio Bombola Gas',
          qtaPezzi: 0
        };
        const arr = lsGet('oreRows', []); arr.push(recExtra); lsSet('oreRows', arr);
      }catch{}
      try{
        const sb = (typeof getSB === 'function') && getSB();
        if (sb && typeof sbInsert === 'function'){
          await sbInsert('timesheets', {
            commessa_id: String(jobId),
            fase_idx: null,
            operatore: act.operatore || '',
            minutes: Math.round(oreMin),
            note: 'EXTRA: CambioBombolaGas'
          });
        }
      }catch(e){ console.warn('Mirror extra gas failed:', e); }

      setAskQty(null); setActive(null); setGasChange(false);
      alert('Registrazione extra (Cambio bombola gas) salvata ✅');
      try{ window.syncExportToCloudOnly && window.syncExportToCloudOnly(['oreRows']); }catch{}
      return;
    }
    // ==============================================

    // ----- Flusso STANDARD -----
    const nid = (window.nextIdUnique
      ? window.nextIdUnique('ore','O','oreRows')
      : (function(){
          const y = new Date().getFullYear();
          const arr = lsGet('oreRows',[])||[];
          const n = 1 + arr.filter(r => String(r.id||'').startsWith(`O-${y}-`)).length;
          return { id: `O-${y}-${String(n).padStart(3,'0')}` };
        })()
    );
    const rec = {
      id: nid.id, data: todayISO(),
      commessaId: String(jobId),
      faseIdx: Number(act.faseIdx),
      operatore: act.operatore,
      oreHHMM, oreMin, ore,
      note: qty>0 ? `Quantità prodotta: ${qty}` : '',
      qtaPezzi: qty
    };

    // — Extra: info riga articolo nel record ore
    try{
      const idx = (typeof act.rigaIdx === 'number') ? act.rigaIdx
                 : ((rigaIdx===''||rigaIdx==null) ? null : Number(rigaIdx));
      if (idx != null && Array.isArray(righe) && righe[idx]) {
        const rr = righe[idx];
        rec.rigaIdx         = idx;
        rec.rigaCodice      = String(rr.codice || '');
        rec.rigaDescrizione = String(rr.descrizione || '');
        rec.rigaUM          = String(rr.um || 'PZ');
      }
    }catch{}

    // — Salvataggio oreRows
    try{ const arr = lsGet('oreRows', []); arr.push(rec); lsSet('oreRows', arr); }catch{}

    // — Allinea commessa (qtaProdotta sulle fasi + producedPieces)
    try{
      const all = lsGet('commesseRows', []);
      const ix = all.findIndex(c => String(c.id) === String(jobId));
      if (ix >= 0) {
        const c = { ...all[ix] };
        const tot = Math.max(1, Number(c.qtaPezzi || 1));
        const fIdx = Number(act.faseIdx);

        if (Array.isArray(c.fasi) && c.fasi[fIdx]) {
          const prevF = Math.max(0, Number(c.fasi[fIdx].qtaProdotta || 0));
          c.fasi[fIdx] = { ...c.fasi[fIdx], qtaProdotta: Math.max(0, Math.min(tot, prevF + qty)) };
        }
        c.qtaProdotta = producedPieces(c);
        all[ix] = c; lsSet('commesseRows', all); window.__anima_dirty = true;

        // Etichette colli: apri quando completo (una sola volta)
        const prod = (typeof window.producedPieces === 'function')
          ? window.producedPieces(c)
          : Math.max(0, Number(c.qtaProdotta || 0));
        const justCompleted = (prod >= tot) && !c.__completedAt;
        if (justCompleted) {
          c.__completedAt = new Date().toISOString();
          all[ix] = c; lsSet('commesseRows', all);
          try {
            if (typeof window.openEtichetteColliDialog === 'function') {
              window.openEtichetteColliDialog(c);
            } else if (typeof window.triggerEtichetteFor === 'function') {
              window.triggerEtichetteFor(c, {});
            }
          } catch {}
        }
      }
    }catch{}

    setAskQty(null); setActive(null); setGasChange(false);
    alert('Registrazione salvata ✅');

    try{ window.syncExportToCloudOnly && window.syncExportToCloudOnly(['oreRows','commesseRows']); }catch{}

    try{
      const sb = (typeof getSB === 'function') && getSB();
      if (sb && typeof sbInsert === 'function'){
        await sbInsert('timesheets', {
          commessa_id: String(jobId),
          fase_idx: (act && typeof act.faseIdx === 'number') ? act.faseIdx : null,
          operatore: act.operatore || '',
          minutes: Math.round(oreMin),
          note: (qty > 0) ? `Qta: ${qty}` : ''
        });
      }
    }catch(e){ console.warn('Mirror timesheets opzionale fallito:', e); }
  }

  // ---- UI ----
  // --- Wrapper anti-doppio click & pre-condizioni leggere ---
  let __tGuard = { until: 0 };
  function safeStart(){
    const now = Date.now();
    if (now < __tGuard.until) return;              // debounce 1,2s
    __tGuard.until = now + 1200;

    // se già attivo, non permettere secondo start
    if (active) { (window.toast||alert)('C’è già una timbratura in corso. Premi ⏹️ Fine prima di ripartire.'); return; }

    // se multi-riga, imponi selezione riga (ulteriore paracadute oltre al check di start())
    try{
      const valid = Array.isArray(righe) ? righe.filter(r => (r?.codice||r?.descrizione)) : [];
      if (valid.length > 1 && (rigaIdx==='' || rigaIdx==null)) {
        (window.toast||alert)('Seleziona la riga articolo prima di iniziare.');
       return;
      }
    }catch{}

    start();
  }
  function safeStop(){
    const now = Date.now();
    if (now < __tGuard.until) return;              // debounce
    __tGuard.until = now + 1200;
    stop();
  }

  const header = commessa ? `${commessa.id} — ${commessa.cliente||''}` : (jobId || 'Nessuna commessa');
  const faseSel = (faseIdx!=='' && fasi[Number(faseIdx)]) ? fasi[Number(faseIdx)] : null;
  const pianMins   = React.useMemo(()=> plannedMinsOfPhase(faseSel, commessa), [faseSel, commessa]);
  const effMins    = effMinsPhase;
  const residuoMins = Math.max(0, pianMins - effMins);

  const card = (children)=> e('div',{className:'card', style:{maxWidth:520, margin:'0 auto'}}, children);

  return e('div', {style:{padding:8}},
    card([
      e('h3',{style:{fontSize:18, fontWeight:700, marginBottom:4}}, 'Timbratura'),
      e('div',{className:'muted', style:{marginBottom:8}}, header),

      e('div', {className:'row', style:{gap:8, margin:'6px 0 8px 0', alignItems:'center'}},
        e('button', { className:'btn btn-outline', onClick: ()=> { if (history.length > 1) history.back(); else location.hash = '#/impostazioni'; } }, '⬅️ Indietro'),
        e('span', {className:'badge',tyle:{marginLeft:6, padding:'4px 8px', borderRadius:8, background:isOnline?'#16a34a':'#dc2626', color:'#fff', fontWeight:700}}, isOnline ? '● ONLINE' : '● OFFLINE'),
        commessa && e('button', {className:'btn btn-outline',onClick:()=> commessa && ((window.openEtichetteColliDialog && window.openEtichetteColliDialog(commessa)) ||(window.triggerEtichetteFor && window.triggerEtichetteFor(commessa, {})))}, 'Stampa etichette'),
        e('div', {className:'row', style:{gap:6, marginLeft:'auto'}},
          e('button', {className:'btn btn-outline', onClick:()=> window.syncImportFromCloud && window.syncImportFromCloud()}, '⬇️ Importa'),
          e('button', {className:'btn btn-outline', onClick:()=> window.syncExportToCloud && window.syncExportToCloud()}, '⬆️ Esporta')
        )
      ),

      commessa && e('div',{className:'card', style:{marginBottom:8}},
        e('table',{className:'table two-cols'},
          e('tbody',null,
            e('tr',null, e('th',null,'Descrizione'), e('td',null, commessa.descrizione || '-')),
            e('tr',null, e('th',null,'Q.tà totale'),      e('td',null, String(Math.max(1, Number(commessa?.qtaPezzi || 1))))),
            e('tr',null, e('th',null,'Prodotta finora'),  e('td',null, String(producedPieces(commessa)))),
            e('tr',null, e('th',null,'Residua'),          e('td',null, String(Math.max(0, Math.max(1, Number(commessa?.qtaPezzi||1)) - producedPieces(commessa)))))
          )
        )
      ),

      // Commessa + QR
      e('div', {className:'card', style:{marginBottom:8}},
        e('label', null, 'Commessa'),
        e('div', {className:'row', style:{gap:8, alignItems:'center'}},
          e('input', { value:jobId, onChange:ev=>setJobId(ev.target.value), placeholder:'C-2025-001', style:{fontSize:18}}),
          e('button', { className:'btn btn-outline', type:'button', onClick:openScanner }, '📷 Scan')
        ),
        commessa ? e('div',{className:'muted',style:{marginTop:4}}, (commessa.cliente||'') + (commessa.descrizione? ' — '+commessa.descrizione : '')) : null
      ),

      // Riga articolo (solo se multi-articolo)
      (commessa && Array.isArray(righe) && righe.length > 1) && e('div', {className:'card', style:{marginBottom:8}},
        e('label', null, 'Riga articolo'),
        e('div', {className:'row', style:{gap:6, alignItems:'center'}},
          e('select', {
              value: rigaIdx, onChange: ev => setRigaIdx(ev.target.value), style:{fontSize:18}
            },
            e('option', {value:''}, '— seleziona riga —'),
            righe.map((r, idx) => e('option', { key: idx, value: String(idx) },
              `${idx+1}) ${r.codice || '-'} — ${(r.descrizione || '').slice(0,60)} ${r.um ? `(${r.um})` : ''} ${r.qta != null ? `× ${r.qta}` : ''}`
            ))
          ),
          e('button', {className:'btn btn-outline', onClick: selectRiga}, 'Dettaglio…'),
          rigaIdx!=='' && e('span',{className:'muted', style:{marginLeft:8}}, `Riga selezionata: ${Number(rigaIdx)+1}`)
        )
      ),

      // Operatore
      e('div', {className:'card', style:{marginBottom:8}},
        e('label', null, 'Operatore'),
        operators.length
          ? e('select', { value:operatore, onChange:ev=>setOperatore(ev.target.value), style:{fontSize:18}},
              e('option', {value:''}, '— seleziona —'),
              operators.map((op,i)=> e('option',{key:i, value:op}, op))
            )
          : e('input', { value:operatore, onChange:ev=>setOperatore(ev.target.value), placeholder:'es. Marco', style:{fontSize:18}})
      ),

      // Fase
      e('div', {className:'card', style:{marginBottom:8}},
        e('label', null, 'Fase'),
        fasi.length
          ? e('select', { value:faseIdx, onChange:ev=>setFaseIdx(ev.target.value), style:{fontSize:18}},
              e('option', {value:''}, '— seleziona fase —'),
              fasi.map((f,idx)=> e('option',{ key:idx, value:String(idx) }, (window.faseLabel ? window.faseLabel(commessa, idx) : ((idx+1)+'. '+(f?.lav||'-')))))
            )
          : e('div', {className:'muted'}, 'Questa commessa non ha fasi definite.')
      ),

      // x2/x3 + gas
      e('div', {className:'card', style:{marginBottom:8}},
        e('label', null, 'Operatori contemporanei (x2 / x3)'),
        e('div', {className:'row', style:{gap:16, paddingTop:6, flexWrap:'wrap', alignItems:'center'}},
          e('label', {className:'row', style:{gap:6}}, e('input', { type:'checkbox', checked:secondOp, onChange:ev=> setSecondOp(ev.target.checked && !thirdOp) }), e('span', null, 'Secondo operatore (x2)')),
          e('label', {className:'row', style:{gap:6}}, e('input', { type:'checkbox', checked:thirdOp,  onChange:ev=> setThirdOp(ev.target.checked) }), e('span', null, 'Terzo operatore (x3)')),
          Number(opsCount) > 1 && e('div', {className:'muted', style:{marginLeft:'auto'}}, `Moltiplicatore ×${Number(opsCount)}`),
          e('label', {className:'row', style:{gap:6}}, e('input', { type:'checkbox', checked:gasChange, onChange:ev=> setGasChange(ev.target.checked) }), e('span', null, 'Cambio bombola gas (extra)'))
        )
      ),

      // Indicatori fase
      (faseIdx!=='' && fasi[Number(faseIdx)]) && e('div', {className:'card', style:{marginBottom:8}},
        e('h4', {style:{margin:'0 0 6px 0'}}, 'Tempi fase selezionata'),
        e('table', {className:'table two-cols'},
          e('tbody', null,
            e('tr', null, e('th', null, 'Prevista'),   e('td', null, fmtHHMM(plannedMinsOfPhase(fasi[Number(faseIdx)])))),
            e('tr', null, e('th', null, 'Effettiva'),  e('td', null, fmtHHMM(effMinsPhase))),
            e('tr', null, e('th', null, 'Residuo'),    e('td', null, fmtHHMM(Math.max(0, plannedMinsOfPhase(fasi[Number(faseIdx)]) - effMinsPhase))))
          )
        )
      ),

      // Pulsantiera
      e('div', {className:'card', style:{textAlign:'center', padding:12, marginBottom:8}},
        e('div', {style:{fontSize:28, fontWeight:800, marginBottom:8}},
          active ? fmtHMS(Date.now() - new Date(active.startISO).getTime()) : '00:00:00'
        ),
        !active
          ? e('button', {className:'btn btn-lg', style:{width:'100%'}, onClick:safeStart}, '▶️ Inizio')
          : e('button', {className:'btn btn-lg', style:{width:'100%'}, onClick:safeStop},  '⏹️ Fine')
      ),

      // Modale quantità
      askQty && e('div', {style:{
        position:'fixed', inset:0, background:'rgba(0,0,0,0.35)',
        display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999, padding:'12px'
      }},
        e('div', {className:'card', style:{ width:'100%', maxWidth:420, padding:12, background:'#fff'}},
          e('h4', {style:{margin:'0 0 6px 0', fontSize:18}}, 'Quantità lavorata'),
          e('div', {className:'muted', style:{marginBottom:8, fontSize:14}}, 'Inserisci i pezzi prodotti in questa sessione (può essere 0).'),
          e('input', {
            id:'qty-input', type:'number', min:'0', step:'1',
            value:qtyVal, onChange:ev=>setQtyVal(ev.target.value),
            onFocus:ev=> { if (String(ev.target.value)==='0') ev.target.select(); },
            style:{width:'100%', marginBottom:12, fontSize:18, color:'#111', background:'#fff', caretColor:'#111'}
          }),
          e('div', {className:'actions', style:{justifyContent:'flex-end', gap:8}},
            e('button', {className:'btn btn-outline', onClick:cancelStop}, 'Annulla'),
            e('button', {className:'btn', onClick:confirmStop}, 'Conferma')
          )
        )
      ),

      // Modale Scanner QR
      scanOpen && e('div', {style:{
        position:'fixed', inset:0, background:'rgba(0,0,0,0.6)',
        display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999, padding:'12px'
      }},
        e('div', {className:'card', style:{ width:'100%', maxWidth:520, padding:12, background:'#fff'}},
          e('h4', {style:{margin:'0 0 6px 0'}}, 'Scannerizza QR'),
          e('div', {id:'qr-reader', style:{width:'100%', minHeight:280, background:'#000', borderRadius:8}}),
          e('div', {className:'actions', style:{justifyContent:'flex-end', gap:8, marginTop:8}},
            e('button', {className:'btn btn-outline', onClick:()=> setScanOpen(false)}, 'Chiudi')
          )
        )
      )
    ])
  );
};

// === Override esplicito (questa deve vincere) ===
const TimbraturaView = TimbraturaMobileView;
if (typeof window !== 'undefined') { window.TimbraturaMobileView = TimbraturaMobileView; }



// === STUB + ROUTES REPAIR (idempotente, incolla in fondo) ==================
(function ensureRoutesAndStubs(){
  const e = React.createElement;

  // 1) Crea stubs se la view globale non esiste
  function defView(name, label){
    if (typeof window[name] !== 'function') {
      window[name] = function(){
        return e('div', {className:'page'}, `${label} — vista non ancora implementata`);
      };
    }
  }
  defView('DashboardView',        'Dashboard');
  defView('CommesseView',         'Commesse');
  defView('ClientiView',          'Clienti');
  defView('FornitoriView',        'Fornitori');
  defView('OreView',              'Ore');
  defView('MovimentiView',        'Movimenti');
  defView('ReportTempiView',      'Report tempi');
  defView('ReportMaterialiView',  'Report materiali');
  defView('TimbraturaMobileView', 'Timbratura'); // 👈 stub sempre disponibile

  // 2) Ripara/integra la mappa ROUTES: ogni entry deve essere una funzione
    const R = window.ROUTES = window.ROUTES || {};
  const map = {
    // --- nuove/aggiornate: puntano ai nomi REALI trovati nel file ---
    '#/dashboard':        window.DashboardView,
    '#/commesse':         window.CommesseView,
    '#/report-tempi':     window.ReportTempiView,
    '#/report-materiali': (window.ReportProdView || window.ReportMaterialiView),
    '#/clienti':          window.ClientiView,
    '#/fornitori':        window.FornitoriView,

    // 👇 qui la correzione
    '#/ore':              (window.RegistrazioniOreView || window.OreView),
    '#/movimenti':        (window.MagazzinoMovimentiView || window.MovimentiView),
    
    // Documenti & co.
    '#/ddt':              window.DDTView,
    '#/fatture':          window.FattureView,
    '#/ordini':           window.OrdiniFornitoriView,
    '#/magazzino':        window.MagazzinoView,
    '#/report':           window.ReportView,
    '#/impostazioni':     (window.SettingsView || window.ImpostazioniView),
    '#/login':            window.LoginView,

    // opzionale: se vuoi la rotta dedicata alla timbratura mobile
    '#/timbratura':       window.TimbraturaMobileView
  };
  Object.keys(map).forEach(h => { if (typeof map[h] === 'function') R[h] = map[h]; });


  
  // 3) NON sovrascrivere pickView se esiste già
  if (typeof window.pickView !== 'function') {
    window.pickView = function(){
      const raw = (location.hash || '#/dashboard').toLowerCase();
      const h = raw.split('?')[0]; // ignora ?job=...
      const R = window.ROUTES || {};
      const Comp = R[h] || R['#/ddt'];
        return (typeof Comp === 'function')
        ? Comp
        : function(){ return e('div',{className:'page'}, 'Vista non definita: '+h); };
    };
  }


  // 4) Helper di navigazione per pulsanti/alias legacy
  window.openReport            = () => { location.hash = '#/report'; };
  window.openReportTempi       = () => { location.hash = '#/report-tempi'; };
  window.openReportMateriali   = () => { location.hash = '#/report-materiali'; };

  console.info('[routes ready]', Object.fromEntries(
    ['#/dashboard','#/commesse','#/clienti','#/fornitori','#/ore','#/movimenti',
     '#/report','#/report-tempi','#/report-materiali','#/ddt','#/fatture','#/ordini',
     '#/magazzino','#/impostazioni','#/login'
    ].map(h => [h, typeof (window.ROUTES?.[h]) ])
  ));

  // === HAMBURGER MOBILE (non invasivo) ===
(function mobileHamburger(){
  try{
    const MOBILE_W = 1024;
    if (window.innerWidth > MOBILE_W) return;
    if (document.getElementById('anima-hamburger')) return; // idempotente

    const role = (window.__USER && window.__USER.role) || 'admin';
    const items = (role === 'operator')
      ? [ { label:'Timbratura', hash:'#/timbratura' } ]
      : [
          { label:'Dashboard',    hash:'#/dashboard' },
          { label:'Commesse',     hash:'#/commesse' },
          { label:'Clienti',      hash:'#/clienti' },
          { label:'Fornitori',    hash:'#/fornitori' },
          { label:'Ore',          hash:'#/ore' },
          { label:'Timbratura',   hash:'#/timbratura' },
          { label:'Report',       hash:'#/report' },
          { label:'Impostazioni', hash:'#/impostazioni' }
        ];

    const btn = document.createElement('button');
    btn.id='anima-hamburger'; btn.className='mobile-only'; btn.type='button';
    btn.setAttribute('aria-label','Menu'); btn.textContent='☰';
    document.body.appendChild(btn);

    const nav = document.createElement('nav');
    nav.id='anima-drawer'; nav.className='mobile-only';
    const title = document.createElement('h3');
    title.textContent = (role==='operator') ? 'Operatore' : 'Amministrazione';
    nav.appendChild(title);

    items.forEach(it=>{
      const a=document.createElement('a');
      a.className='drawer-link'; a.href=it.hash; a.textContent=it.label;
      nav.appendChild(a);
    });
    document.body.appendChild(nav);

    btn.addEventListener('click', ()=> nav.classList.toggle('open'));
    window.addEventListener('hashchange', ()=> nav.classList.remove('open'));
    window.addEventListener('resize', ()=>{
      if (window.innerWidth > MOBILE_W) { try{ btn.remove(); nav.remove(); }catch{} }
    });
    document.addEventListener('click', (ev)=>{
      if (!nav.classList.contains('open')) return;
      const t = ev.target;
      if (t===nav || t===btn) return;
      if (!nav.contains(t) && t!==btn) nav.classList.remove('open');
    });

    console.log('[mobile] hamburger attivo per ruolo:', role);
  }catch(e){ console.warn('mobileHamburger error', e); }
})();

})();

// ================== FATTURA ELETTRONICA (FPR12) — EXPORT XML (bootstrap globale) ==================
(function(){
  if (window.buildFatturaPAXml && window.exportFatturaPAXML) return;

  function xmlEsc(s){ 
    return String(s==null?'':s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  }
  function num2(n){ const x=Number(n||0); return isFinite(x)?x.toFixed(2):'0.00'; }
  function todayISO(){ try{ return new Date().toISOString().slice(0,10); }catch{ return '2025-01-01'; } }

  function getClienteById(id){
    try{
      const all = JSON.parse(localStorage.getItem('clientiRows')||'[]')||[];
      return all.find(c => String(c.id)===String(id)) || null;
    }catch{ return null; }
  }
  function riepilogoPerAliquota(righe){
    const map = new Map(); // chiave: `${aliq}__${natura}`
    (righe||[]).forEach(r=>{
      const qty = Number(r.qta||0);
      const pr  = Number(r.prezzo||0);
      const scp = Number(r.sconto||r.scontoPerc||0);
      const iva = Number(r.iva||0);
      const impon = qty*pr*(1-(scp/100));
      const nat = (iva===0 && r && typeof r.natura==='string' && r.natura.trim()) ? r.natura.trim() : '';
      const k = `${iva.toFixed(2)}__${nat}`;
      map.set(k, (map.get(k)||0) + impon);
    });
    return Array.from(map.entries()).map(([key, imponibile])=>{
      const [aliqStr, nat] = key.split('__');
     const aliquota = Number(aliqStr);
      const imposta = aliquota>0 ? (aliquota/100)*imponibile : 0;
      return { aliquota, natura:(aliquota===0?nat:''), imponibile, imposta };
    });
  }

  window.buildFatturaPAXml = function(fa){
    const app = (function(){ try{ return JSON.parse(localStorage.getItem('appSettings')||'{}')||{}; }catch{return{}} })();
    const cli = getClienteById(fa.clienteId) || { ragione: fa.cliente || '' };

    const cedente = {
      denominazione: app.ragioneSociale || app.ragione || '',
      piva: (app.piva || app.pIva || '').replace(/\s/g,''),
      cf: (app.cf || app.codiceFiscale || '') || '',
      regime: app.regimeFiscale || 'RF01',
      sedeLegale: app.sedeLegale || (app.azienda && app.azienda.sedeLegale) || '',
      sedeOper: app.sedeOperativa || (app.azienda && app.azienda.sedeOperativa) || ''
    };
    const cessionario = {
      denominazione: cli.ragione || cli.denominazione || '',
      piva: (cli.piva||'').replace(/\s/g,''),
      cf: (cli.cf || cli.codiceFiscale || '') || '',
      sede: cli.sedeLegale || cli.sedeOperativa || ''
    };

    const numero = String(fa.id||'').replace(/[^\w\-./]/g,'') || 'FA-TEST';
    const data   = fa.data || todayISO();
    const divisa = 'EUR';
    // Esigibilità IVA per DatiRiepilogo: 'I' (immediata), 'D' (differita), 'S' (scissione)
    const esig = (fa.esigibilitaIVA||'').toUpperCase();
    const esigOk = (esig==='I' || esig==='D' || esig==='S') ? esig : '';


    const tipoDocumento = fa.tipoDocumento || 'TD01';

    const codiceDest = (fa.codiceUnivoco || cli.codiceUnivoco || '').trim() || '0000000';
    const pecDest    = (fa.pec || cli.pec || '').trim();

    const righe = Array.isArray(fa.righe) ? fa.righe : [];
    const riepiloghi = riepilogoPerAliquota(righe);

    const condPag = (Array.isArray(fa.scadenze) && fa.scadenze.length<=1) ? 'TP01' : 'TP02';
    const modPag  = fa.modalitaPagamento || 'MP05';
    const iban    = (fa.iban || app.iban || '').replace(/\s/g,'');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12"
  xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente>
        <IdPaese>IT</IdPaese>
        <IdCodice>${xmlEsc(cedente.piva||cedente.cf||'00000000000')}</IdCodice>
      </IdTrasmittente>
      <ProgressivoInvio>${xmlEsc(numero.replace(/[^A-Za-z0-9]/g,'').slice(-10) || 'INV0000001')}</ProgressivoInvio>
      <FormatoTrasmissione>FPR12</FormatoTrasmissione>
      <CodiceDestinatario>${xmlEsc(codiceDest)}</CodiceDestinatario>
      ${(!pecDest || codiceDest!=='0000000') ? '' : `<PECDestinatario>${xmlEsc(pecDest)}</PECDestinatario>`}
    </DatiTrasmissione>
    <CedentePrestatore>
      <DatiAnagrafici>
        ${cedente.piva ? `<IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${xmlEsc(cedente.piva)}</IdCodice></IdFiscaleIVA>` : ''}
        ${cedente.cf ? `<CodiceFiscale>${xmlEsc(cedente.cf)}</CodiceFiscale>` : ''}
        <Anagrafica><Denominazione>${xmlEsc(cedente.denominazione)}</Denominazione></Anagrafica>
        <RegimeFiscale>${xmlEsc(cedente.regime)}</RegimeFiscale>
      </DatiAnagrafici>
      <Sede><Indirizzo>${xmlEsc(cedente.sedeLegale||'')}</Indirizzo></Sede>
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        ${cessionario.piva ? `<IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${xmlEsc(cessionario.piva)}</IdCodice></IdFiscaleIVA>` : ''}
        ${cessionario.cf ? `<CodiceFiscale>${xmlEsc(cessionario.cf)}</CodiceFiscale>` : ''}
        <Anagrafica><Denominazione>${xmlEsc(cessionario.denominazione)}</Denominazione></Anagrafica>
      </DatiAnagrafici>
      <Sede><Indirizzo>${xmlEsc(cessionario.sede||'')}</Indirizzo></Sede>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>${xmlEsc(tipoDocumento)}</TipoDocumento>
        <Divisa>${divisa}</Divisa>
        <Data>${xmlEsc(data)}</Data>
        <Numero>${xmlEsc(numero)}</Numero>
        ${ fa.bolloVirtuale ? `
          <DatiBollo>
            <BolloVirtuale>SI</BolloVirtuale>
            <ImportoBollo>${num2(fa.importoBollo || 2)}</ImportoBollo>
          </DatiBollo>
        ` : ``}
      </DatiGeneraliDocumento>
    </DatiGenerali>
    <DatiBeniServizi>
      ${righe.map((r,i)=>{
        const qty = Number(r.qta||0);
        const pr  = Number(r.prezzo||0);
        const scp = Number(r.sconto||r.scontoPerc||0);
        const iva = Number(r.iva||0);
        const rowBase = qty*pr*(1-(scp/100));
        return `<DettaglioLinee>
          <NumeroLinea>${i+1}</NumeroLinea>
          <Descrizione>${xmlEsc(r.descrizione||r.desc||'Riga')}</Descrizione>
          ${qty?`<Quantita>${qty}</Quantita>`:''}
          <PrezzoUnitario>${num2(pr)}</PrezzoUnitario>
          <PrezzoTotale>${num2(rowBase)}</PrezzoTotale>
          <AliquotaIVA>${num2(iva)}</AliquotaIVA>
        </DettaglioLinee>`;
      }).join('\n')}
        ${riepiloghi.map(r=>`
          <DatiRiepilogo>
        <AliquotaIVA>${num2(r.aliquota)}</AliquotaIVA>
          ${ r.natura ? `<Natura>${xmlEsc(r.natura)}</Natura>` : ``}
          ${ (r.aliquota===0 && r.natura && (fa.rifNormativo||'').trim()) ? `<RiferimentoNormativo>${xmlEsc(fa.rifNormativo)}</RiferimentoNormativo>` : ``}
          <ImponibileImporto>${num2(r.imponibile)}</ImponibileImporto>
          <Imposta>${num2(r.imposta)}</Imposta>
          ${ esigOk ? `<EsigibilitaIVA>${esigOk}</EsigibilitaIVA>` : ``}
          </DatiRiepilogo>
      `).join('\n')}


    </DatiBeniServizi>
        <DatiPagamento>
      <CondizioniPagamento>${condPag}</CondizioniPagamento>
      ${
        (Array.isArray(fa.scadenze) && fa.scadenze.length>0
          ? fa.scadenze
          : [{ data: data, importo: (riepiloghi||[]).reduce((S,x)=>S+x.imponibile+x.imposta,0) }]
        ).map(s=>`
        <DettaglioPagamento>
          <ModalitaPagamento>${modPag}</ModalitaPagamento>
          ${iban?`<IBAN>${xmlEsc(iban)}</IBAN>`:''}
          ${s.data ? `<DataScadenzaPagamento>${xmlEsc(s.data)}</DataScadenzaPagamento>` : ``}
          <ImportoPagamento>${num2(s.importo)}</ImportoPagamento>
        </DettaglioPagamento>
      `).join('')}
    </DatiPagamento>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;
    return xml;
  };

  window.exportFatturaPAXML = function(fa){
    try{
      const xml = window.buildFatturaPAXml(fa);
      const name = (fa.id ? String(fa.id) : 'FATTURA') + '.xml';
      const blob = new Blob([xml], {type:'application/xml'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click(); URL.revokeObjectURL(a.href);
    }catch(e){
      alert('Export XML FatturaPA non riuscito: ' + (e && e.message || e));
    }
  };
})();

// ===== Pre-check FatturaPA (campi minimi) =====
window.canExportFatturaPA = function(fa){
  const reasons = [];
  try{
    const app = JSON.parse(localStorage.getItem('appSettings')||'{}')||{};
    const clienti = JSON.parse(localStorage.getItem('clientiRows')||'[]')||[];
    const cli = clienti.find(c => String(c.id)===String(fa.clienteId)) || {};

    const denAzi = (app.ragioneSociale || app.ragione || '').trim();
    const pivaAzi = String(app.piva || app.pIva || '').replace(/\s/g,'');
    const cfAzi = String(app.cf || app.codiceFiscale || '').trim();
    const sedeAzi = (app.sedeLegale || (app.azienda&&app.azienda.sedeLegale) || '').trim();

    const denCli = (cli.ragione || cli.denominazione || fa.cliente || '').trim();
    const pivaCli = String(cli.piva||'').replace(/\s/g,'');
    const cfCli = String(cli.cf || cli.codiceFiscale || '').trim();
    const sedeCli = (cli.sedeLegale || cli.sedeOperativa || '').trim();

    const bancaInt = (app.bancaIntestatario || app.bankHolder || '') + '';
    const bancaIstit= (app.bancaIstituto   || app.bankName   || '') + '';
    const bancaIban = (app.bancaIban        || app.iban       || '') + '';
    const bancaBic  = (app.bancaBicSwift    || app.bicswift || app.bic || '') + '';


    // Anagrafica azienda
    if (!denAzi) reasons.push('Azienda: Denominazione mancante');
    if (!(pivaAzi || cfAzi)) reasons.push('Azienda: P.IVA o CF mancanti');
    if (!sedeAzi) reasons.push('Azienda: Sede legale mancante');

    // Anagrafica cliente
    if (!denCli) reasons.push('Cliente: Denominazione mancante');
    if (!(pivaCli || cfCli)) reasons.push('Cliente: P.IVA o CF mancanti');
    if (!sedeCli) reasons.push('Cliente: Indirizzo sede mancante');

    // Righe
    const righe = Array.isArray(fa.righe)? fa.righe : [];
    if (!righe.length) reasons.push('Righe: nessuna riga presente');
    righe.forEach((r,idx)=>{
      const okDesc = (r.descrizione||'').trim().length>0;
      const okQta = Number(r.qta||0) > 0;
      if (!okDesc || !okQta) reasons.push(`Riga ${idx+1}: descrizione o quantità non valide`);
    });

  }catch(e){
    reasons.push('Errore verifica preliminare');
  }
  return { ok: reasons.length===0, reasons };
};

// ===== BACKUP/RESTORE JSON =====
(function(){
  if (window.__anima_backup_booted__) return; window.__anima_backup_booted__=true;
    const pick = k => {
    try {
      const raw = localStorage.getItem(k);
      if (!raw) return k.endsWith('Rows') ? [] : {};
      return JSON.parse(raw);
    } catch {
      return k.endsWith('Rows') ? [] : {};
    }
  };

  const KEYS = [
    'appSettings',
    'clientiRows','fornitoriRows',
    'magArticoli','magMovimenti',
    'commesseRows','oreRows',
    'ddtRows','fattureRows',
    'ordiniFornitoriRows',
    ,'counters'
  ];

  function download(name, text, mime='application/json'){
    const blob = new Blob([text], {type:mime});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    a.click(); URL.revokeObjectURL(a.href);
  }

  function ensureArray(x){ return Array.isArray(x) ? x : []; }
  function ensureObject(x){ return (x && typeof x==='object' && !Array.isArray(x)) ? x : {}; }

  // Collisions: se id uguale e già presente, prova a rigenerare id con nextProgressivo dove noto.
  function mergeArrayById(dst, src, series){
    const out = [...ensureArray(dst)];
    const seen = new Set(out.map(r=>String(r.id||'__')));
    (ensureArray(src)).forEach(r=>{
      let item = {...r};
      let id = (item.id!=null) ? String(item.id) : '';
      if (!id || seen.has(id)){
        if (series === 'C') { // commesse
          try { id = window.nextProgressivo ? window.nextProgressivo('C') : (Date.now()+''); } catch { id = (Date.now()+''); }
          item.id = id;
        } else {
          id = id ? (id + '-' + Math.floor(Math.random()*1000)) : (Date.now()+'');
          item.id = id;
        }
      }
      seen.add(String(item.id));
      out.push(item);
    });
    return out;
  }

  window.exportBackupJSON = function(){
    const dump = { __meta:{ ts:new Date().toISOString(), ver:1 } };
    KEYS.forEach(k => dump[k] = pick(k) || (k.endsWith('Rows')?[]:{}));
    download(`ANIMA-backup-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(dump,null,2));
  };

  window.importBackupJSON = function(){
    const inp = document.createElement('input'); inp.type='file'; inp.accept='application/json';
    inp.onchange = ev => {
      const f = ev?.target?.files?.[0]; if(!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try{
          const data = JSON.parse(String(rd.result||'{}'));
          // Merge non distruttivo
          const cur = (k, def)=>{ try{ return JSON.parse(localStorage.getItem(k)||'null') ?? def; }catch{ return def; } };
          const set = (k, v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); window.__anima_dirty = true; }catch{} };

          // AppSettings: merge shallow
          set('appSettings', { ...ensureObject(cur('appSettings',{})), ...ensureObject(data.appSettings||{}) });

          // Progressivi: prendi il max per serie/anno
          (function(){
            const curC = ensureObject(cur('counters', {}));
            const impC = ensureObject(data.counters || {});
            const Y = new Date().getFullYear();

            function maxRec(a, b){
              // se anno diversi, preferisci quello dell’anno corrente; altrimenti max(num)
              if (!a) return b;
              if (!b) return a;
              if (a.year !== b.year) return (b.year === Y) ? b : a;
              return { year: a.year, num: Math.max(Number(a.num||0), Number(b.num||0)) };
            }

            const out = { ...curC };
            Object.keys(impC).forEach(k => {
              out[k] = maxRec(curC[k], impC[k]);
            });

            set('counters', out);
          })();

          // Tabelle array
          set('clientiRows',           mergeArrayById(cur('clientiRows',[]),           data.clientiRows,           null));
          set('fornitoriRows',         mergeArrayById(cur('fornitoriRows',[]),         data.fornitoriRows,         null));
          set('magArticoli',           mergeArrayById(cur('magArticoli',[]),           data.magArticoli,           null));
          set('magMovimenti',          mergeArrayById(cur('magMovimenti',[]),          data.magMovimenti,          null));
          set('commesseRows',          mergeArrayById(cur('commesseRows',[]),          data.commesseRows,          'C')); // usa nextProgressivo('C')
          set('oreRows',               mergeArrayById(cur('oreRows',[]),               data.oreRows,               null));
          set('ddtRows',               mergeArrayById(cur('ddtRows',[]),               data.ddtRows,               null));
          set('fattureRows',           mergeArrayById(cur('fattureRows',[]),           data.fattureRows,           null));
          set('ordiniFornitoriRows',   mergeArrayById(cur('ordiniFornitoriRows',[]),   data.ordiniFornitoriRows,   null));

          alert('Import eseguito. Ricarica la pagina per vedere tutti i dati.');
        }catch(e){ alert('File non valido: ' + (e?.message||e)); }
      };
      rd.readAsText(f);
    };
    inp.click();
  };
})();

// ===== Alias Backup/Ripristino per pulsanti Impostazioni =====
(function(){
  // Alias "Scarica backup" → usa exportBackupJSON
  if (!window.downloadBackup) {
    window.downloadBackup = function(){
      if (window.exportBackupJSON) return window.exportBackupJSON();
      // fallback minimale: scarica tutto LS (se exportBackupJSON non c'è)
      try{
        const dump = {}; for (let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); dump[k] = JSON.parse(localStorage.getItem(k)||'null'); }
        const blob = new Blob([JSON.stringify(dump,null,2)],{type:'application/json'});
        const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`ANIMA-backup-${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(a.href);
      }catch(e){ alert('Backup non riuscito: ' + (e?.message||e)); }
    };
  }

  // Alias "Ripristina da file" → legge il file e applica il MERGE (stessa logica di importBackupJSON)
  if (!window.restoreFromFile) {
    window.restoreFromFile = async function(file){
      try{
        const text = await file.text();
        const data = JSON.parse(text);
        const cur = (k, def)=>{ try{ return JSON.parse(localStorage.getItem(k)||'null') ?? def; }catch{ return def; } };
        const set = (k, v)=>{ try{ localStorage.setItem(k, JSON.stringify(v)); window.__anima_dirty = true; }catch{} };
        const ensureArray = x => Array.isArray(x)?x:[];
        const ensureObject= x => (x && typeof x==='object' && !Array.isArray(x))?x:{};

        function mergeArrayById(dst, src, series){
          const out = [...ensureArray(dst)];
          const seen = new Set(out.map(r=>String(r.id||'__')));
          ensureArray(src).forEach(r=>{
            let item = {...r};
            let id = (item.id!=null) ? String(item.id) : '';
            if (!id || seen.has(id)){
              if (series==='C' && window.nextProgressivo) { id = window.nextProgressivo('C'); item.id=id; }
              else { id = id ? (id + '-' + Math.floor(Math.random()*1000)) : (Date.now()+''+Math.floor(Math.random()*1000)); item.id=id; }
            }
            seen.add(String(item.id));
            out.push(item);
          });
          return out;
        }

        // Merge non distruttivo
        set('appSettings', { ...ensureObject(cur('appSettings',{})), ...ensureObject(data.appSettings||{}) });
        set('clientiRows',         mergeArrayById(cur('clientiRows',[]),         data.clientiRows,         null));
        set('fornitoriRows',       mergeArrayById(cur('fornitoriRows',[]),       data.fornitoriRows,       null));
        set('magArticoli',         mergeArrayById(cur('magArticoli',[]),         data.magArticoli,         null));
        set('magMovimenti',        mergeArrayById(cur('magMovimenti',[]),        data.magMovimenti,        null));
        set('commesseRows',        mergeArrayById(cur('commesseRows',[]),        data.commesseRows,        'C'));
        set('oreRows',             mergeArrayById(cur('oreRows',[]),             data.oreRows,             null));
        set('ddtRows',             mergeArrayById(cur('ddtRows',[]),             data.ddtRows,             null));
        set('fattureRows',         mergeArrayById(cur('fattureRows',[]),         data.fattureRows,         null));
        set('ordiniFornitoriRows', mergeArrayById(cur('ordiniFornitoriRows',[]), data.ordiniFornitoriRows, null));

        alert('Ripristino completato ✅\nRicarica la pagina (Ctrl+F5).');
      }catch(e){ alert('File non valido: ' + (e?.message||e)); }
    };
  }
})();

// ===== Ricezione Ordine Fornitore → Magazzino (blocchi ben chiusi) =====
(function(){
  async function riceviRigaOF(of, rigaIndex){
    try{
      const righe = Array.isArray(of?.righe)? of.righe : [];
      const r = righe[rigaIndex]; if (!r) return;
      const q = Number(r.qta||0), qr = Number(r.qtaRicevuta||0);
      const res = Math.max(0, q-qr);
      if (res <= 0){ alert('Nessun residuo su questa riga.'); return; }

      // Aggiorna ricevuto (qui NON movimentiamo il magazzino: solo ricezione OF)
      r.qtaRicevuta = Number(qr + res);
      // persist
      try{
        const all = JSON.parse(localStorage.getItem('ordiniFornitoriRows')||'[]')||[];
        const idx = all.findIndex(x => String(x.id)===String(of.id));
        if (idx>=0){ all[idx] = of; localStorage.setItem('ordiniFornitoriRows', JSON.stringify(all)); }
      }catch{}
      alert(`Ricevuta riga ${rigaIndex+1} — residuo ${res} pezzi.`);
    }catch(e){
      alert('Errore ricezione riga: '+(e?.message||e));
    }
  }

  // Modale minimale: scegli riga e ricevi
  window.openRicezioneOF = function(of){
    try{
      const righe = Array.isArray(of?.righe)? of.righe : [];
      if (!righe.length) { alert('Nessuna riga nell’ordine.'); return; }
      const elenco = righe.map((r,i)=>{
        const q = Number(r.qta||0), qr=Number(r.qtaRicevuta||0), res=Math.max(0,q-qr);
        return `${i+1}) ${r.codice||'-'} — ${(r.descrizione||'').slice(0,50)} (residuo: ${res})`;
      }).join('\n');
      const ans = prompt(`Seleziona riga da ricevere (1..${righe.length})\n\n${elenco}`, '1');
      if (!ans) return;
      const idx = Number(ans)-1;
      if (!Number.isFinite(idx) || idx<0 || idx>=righe.length) { alert('Indice non valido'); return; }
      return riceviRigaOF(of, idx);
    }catch(e){
      alert('Errore apertura ricezione: '+(e?.message||e));
    }
  };

  // Ricevi tutte le righe con residuo
  window.receiveAllOF = async function(of){
    try{
      const righe = Array.isArray(of?.righe)? of.righe : [];
      for (let i=0;i<righe.length;i++){
        const q = Number(righe[i].qta||0), qr=Number(righe[i].qtaRicevuta||0), res=Math.max(0,q-qr);
        if (res>0) { await riceviRigaOF(of, i); }
      }
    }catch(e){
      alert('Errore ricezione TUTTE le righe: '+(e?.message||e));
    }
  };
})();

// ===== Soft warning Clienti (intercetta lsSet su 'clientiRows') =====
(function(){
  if (window.__lsSet_clientiWarnWrapped__) return;
  window.__lsSet_clientiWarnWrapped__ = true;

  const origLsSet = window.lsSet || function(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); window.__anima_dirty=true; }catch{} };
  window.lsSet = function(k, v){
    // warning soft solo quando salvi l'elenco clienti
    if (k === 'clientiRows') {
      try{
        const arr = Array.isArray(v) ? v : [];
        // segnala se esistono record incompleti (denominazione / piva+cf / sede)
        const bad = arr.filter(c=>{
          const den  = String(c.ragione||c.denominazione||'').trim();
          const piva = String(c.piva||'').replace(/\s/g,'');
          const cf   = String(c.cf||c.codiceFiscale||'').trim();
          const sede = String(c.sedeLegale||c.sedeOperativa||'').trim();
          return !(den && (piva||cf) && sede);
        });
        if (bad.length) {
          (window.toast||alert)(
            `Attenzione: ${bad.length} cliente/i hanno dati incompleti.\n` +
            '• Denominazione\n• P.IVA o CF\n• Sede (legale/operativa)\n' +
            'L’XML SdI sarà bloccato per questi clienti finché non completi i dati.'
          );
        }
      }catch{}
    }
    return origLsSet(k, v);
  };
})();

// ===== PRINT THEME (unico, idempotente) =====
(function(){
  if (window.__print_theme__) return; window.__print_theme__ = true;

  function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  // CSS condiviso per tutti i documenti
  window.getPrintTheme = function(opts={}){
    const ACCENT = opts.accent || '#0f172a';
    const TOTBG  = opts.totBg  || '#0f172a';
    const showHeaderLine = (opts.headerLine ?? true);
    return `
<style>
@page { size: A4; margin: 10mm 8mm; }
*{-webkit-print-color-adjust:exact; print-color-adjust:exact}
html,body{margin:0;padding:0}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;color:#0f172a;font-size:12px}

/* Header */
.hdr{display:flex;justify-content:space-between;align-items:center;gap:14px; ${showHeaderLine?'border-bottom:2px solid '+ACCENT+';':''} padding-bottom:8px; margin-bottom:10px}
.brand{display:flex;align-items:center;gap:12px}
.brand img{height:60px;object-fit:contain}
.az .rs{font-size:18px;font-weight:800;letter-spacing:.2px}
.az .muted{color:#64748b}
.doc{border:1px solid #cbd5e1; border-radius:10px; padding:10px 12px; min-width:210px; text-align:right}
.doc .title{font-weight:800; font-size:12px; letter-spacing:.3px}
.doc .num{font-weight:800; font-size:14px}
.doc .row{margin-top:2px}

/* Tabelle */
table{width:100%; border-collapse:collapse; margin-top:6px}
thead{display:table-header-group}
th,td{border:1px solid #e5e7eb; padding:7px 8px; vertical-align:top}
th{background:#f8fafc; font-weight:700}
.ctr{text-align:center}
.num{text-align:right}
.no-break{page-break-inside:avoid}

/* Footer + totale (coerente) */
.content{margin-bottom:70mm}
.footer{position:fixed; left:8mm; right:8mm; bottom:12mm; display:flex; justify-content:space-between; align-items:flex-end; gap:12px}
.sign{min-width:280px; padding:8px 2px}
.sign .lab{color:#64748b; font-size:12px}
.sign .line{height:26px; border-bottom:1px solid #cbd5e1}
.sign .name{margin-top:6px; font-weight:600}
.tot{min-width:260px; background:${TOTBG}; color:#fff; border-radius:12px; padding:12px 14px; display:flex; justify-content:space-between; align-items:center}
.tot .lab{font-weight:700}
.tot .val{font-weight:900; font-size:16px}

/* Numerazione pagine (single source) */
.pagebox{position:fixed; right:8mm; bottom:8mm; font-size:12px}
.pageNum[data-mode="css"]::after{content: counter(page) " / " counter(pages)}

/* Video: bordi “puliti” */
@media screen{ th,td{border-color:transparent} }
@media print{ th,td{border:1px solid #e5e7eb} }
</style>`;
  };

  // Header brand standard (logo + azienda + box documento)
  window.printBrandHeader = function(app, { title, docId, docDate, logo }){
    const rag   = esc(app.ragioneSociale || app.ragione || app.aziendaNome || '');
    const piva  = esc(app.piva || app.partitaIva || '');
    const sedeL = esc(app.sedeLegale || '');
    const sedeO = esc(app.sedeOperativa || '');
    const tel   = esc(app.telefono || app.phone || '');
    const email = esc(app.email || '');
    const pec   = esc(app.pec || '');
    const logoUrl = logo || app.logoDataUrl || app.logoUrl || app.logo || '';

    return `
<div class="hdr">
  <div class="brand">
    ${logoUrl ? `<img src="${logoUrl}" alt="">` : ``}
    <div class="az">
      <div class="rs">${rag}</div>
      ${sedeL ? `<div class="muted">Sede legale: ${sedeL}</div>` : ``}
      ${sedeO ? `<div class="muted">Sede operativa: ${sedeO}</div>` : ``}
      ${piva  ? `<div class="muted">P.IVA: ${piva}</div>` : ``}
      ${tel   ? `<div class="muted">Tel: ${tel}</div>` : ``}
      ${email ? `<div class="muted">Email: ${email}</div>` : ``}
      ${pec   ? `<div class="muted">PEC: ${pec}</div>` : ``}
    </div>
  </div>
  <div class="doc">
    <div class="title">${esc(title||'DOCUMENTO')}</div>
    <div class="num">${esc(docId||'')}</div>
    <div class="row">Data: <strong>${esc(docDate||'')}</strong></div>
  </div>
</div>`;
  };
})();

window.navigateTo = window.navigateTo || function(name){
  const map = {
    'Impostazioni':'#/impostazioni',
    'Timbratura':'#/timbratura',
    'Commesse':'#/commesse',
    'DDT':'#/ddt'
  };
  const h = map[name] || '#/ddt';
  location.hash = h;
};







