// Depo Takip — tek telefonda, sunucusuz çalışan stok takibi (Android + iPhone).
// Veriler telefonun içinde (IndexedDB) saklanır.

const ZXING_URL = 'https://fastly.jsdelivr.net/npm/barcode-detector@3/dist/es/ponyfill.min.js';
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
const MAX_SNAPSHOTS = 10;
const SAME_CODE_DELAY = 1000; // aynı barkodun tekrar sayılması için gereken ara (ms)

// ---------- Yardımcılar ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = t => new Date(t).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtTime = t => new Date(t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
const pad = n => String(n).padStart(2, '0');
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// ---------- Kalıcı depolama (IndexedDB) ----------
let dbPromise;
function db() {
  return dbPromise ??= new Promise((res, rej) => {
    const r = indexedDB.open('depo-takip', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kvGet(key) {
  const d = await db();
  return new Promise((res, rej) => {
    const q = d.transaction('kv').objectStore('kv').get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
async function kvSet(key, val) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ---------- Ürün fotoğrafları (ayrı depoda, küçültülmüş JPEG) ----------
const photoURL = {}; // barkod → ekranda gösterilecek adres

function idbEach(store, fn) {
  return db().then(d => new Promise((res, rej) => {
    const req = d.transaction(store).objectStore(store).openCursor();
    req.onsuccess = () => { const c = req.result; if (c) { fn(c.key, c.value); c.continue(); } else res(); };
    req.onerror = () => rej(req.error);
  }));
}
// Asla takılı kalmaz: hata, iptal veya 8 sn zaman aşımında sonuç döner
function idbWrite(store, fn, timeout = 8000) {
  return db().then(d => new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('zaman aşımı')), timeout);
    const ok = () => { clearTimeout(timer); res(); };
    const fail = e => { clearTimeout(timer); rej(e || new Error('kayıt iptal edildi')); };
    try {
      const tx = d.transaction(store, 'readwrite');
      tx.oncomplete = ok;
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error);
      fn(tx.objectStore(store));
    } catch (e) { fail(e); }
  }));
}
// iPhone'da Blob'u doğrudan IndexedDB'ye yazmak takılabiliyor → ham bayt (ArrayBuffer) olarak saklanır
const recToBlob = v => (v instanceof Blob ? v : new Blob([v.data], { type: v.type || 'image/jpeg' }));
const loadPhotos = () => idbEach('photos', (k, v) => { try { photoURL[k] = URL.createObjectURL(recToBlob(v)); } catch {} });
async function photoSet(code, blob) {
  const data = await blob.arrayBuffer();
  await idbWrite('photos', s => s.put({ type: blob.type || 'image/jpeg', data }, code));
  if (photoURL[code]) URL.revokeObjectURL(photoURL[code]);
  photoURL[code] = URL.createObjectURL(blob);
}
async function photoDel(code) {
  await idbWrite('photos', s => s.delete(code));
  if (photoURL[code]) { URL.revokeObjectURL(photoURL[code]); delete photoURL[code]; }
}
async function photoClearAll() {
  await idbWrite('photos', s => s.clear());
  for (const k in photoURL) { URL.revokeObjectURL(photoURL[k]); delete photoURL[k]; }
}

const thumb = (code, cls = 'th') => photoURL[code]
  ? `<img class="${cls}" src="${photoURL[code]}" alt="" loading="lazy">`
  : `<span class="${cls} noimg">📦</span>`;
const codeLabel = p => (p?.noBarcode ? 'Barkodsuz ürün' : esc(p?.barcode ?? ''));

// Fotoğraf çekerken iPhone uygulamayı yeniden başlatırsa yazılanlar kaybolmasın
const DRAFT_KEY = 'depo-taslak';
function saveDraft(d) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...d, t: Date.now() })); } catch {} }
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch {} }
function takeDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    clearDraft();
    return d && Date.now() - d.t < 15 * 60 * 1000 ? d : null;
  } catch { return null; }
}

// Kamerayla fotoğraf çek (veya galeriden seç), 600 px'e küçült
function pickPhoto(onFile) {
  return new Promise(resolve => {
    stopCamera(); // barkod kamerası açıkken telefon kamerası açılamayabilir
    const inp = $('#photo-input');
    inp.value = '';
    inp.onchange = async () => {
      inp.onchange = inp.oncancel = null;
      const f = inp.files[0];
      if (!f) return resolve(null);
      onFile?.();
      try { resolve(await shrinkImage(f)); } catch { toast('Fotoğraf okunamadı', false); resolve(null); }
    };
    inp.oncancel = () => { inp.onchange = inp.oncancel = null; resolve(null); };
    inp.click();
  });
}
async function shrinkImage(file, max = 640) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej()), 'image/jpeg', 0.72));
  } finally { URL.revokeObjectURL(url); }
}
const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

// ---------- Durum ----------
// product:  { barcode, name, qty, createdAt }
// movement: { id, type: 'in' | 'sale' | 'adj', barcode, name, amount, date, saleId? }
// cart:     [{ barcode, qty }]   — tamamlanmamış satış (uygulama kapansa da kaybolmaz)
const freshState = () => ({ version: 2, products: {}, movements: [], cart: [], settings: { lowLimit: 5 }, lastExport: null, changedSinceExport: false });
let state = freshState();
let lastSnapshotDay = null;

async function loadState() {
  const s = await kvGet('state');
  if (s) state = normalize(s);
  const snaps = (await kvGet('snapshots')) || [];
  lastSnapshotDay = snaps.filter(x => x.auto).at(-1)?.day ?? null;
}

function normalize(s) {
  const f = freshState();
  return { ...f, ...s, settings: { ...f.settings, ...(s.settings || {}) },
    products: s.products || {}, movements: s.movements || [], cart: Array.isArray(s.cart) ? s.cart : [] };
}

function persist() {
  kvSet('state', state).catch(e => toast('Kaydedilemedi: ' + e.message, false));
  if (lastSnapshotDay !== dayKey()) snapshot(true);
}

async function snapshot(auto, label = '') {
  const snaps = (await kvGet('snapshots')) || [];
  snaps.push({ day: dayKey(), time: Date.now(), auto, label, data: JSON.stringify(state) });
  while (snaps.length > MAX_SNAPSHOTS) snaps.shift();
  await kvSet('snapshots', snaps);
  if (auto) lastSnapshotDay = dayKey();
}

function commit() {
  state.changedSinceExport = true;
  persist();
  render();
}

// ---------- Stok işlemleri ----------
function addStock(barcode, name, amount, extra = {}) {
  let p = state.products[barcode];
  if (!p) p = state.products[barcode] = { barcode, name, qty: 0, createdAt: Date.now(), ...extra };
  p.qty += amount;
  const m = { id: uid(), type: 'in', barcode, name: p.name, amount, date: Date.now() };
  state.movements.push(m);
  commit();
  return m;
}

function adjust(p, newQty) {
  const diff = newQty - p.qty;
  if (!diff) return;
  p.qty = newQty;
  state.movements.push({ id: uid(), type: 'adj', barcode: p.barcode, name: p.name, amount: diff, date: Date.now() });
  commit();
}

function undoMovement(id) {
  const i = state.movements.findIndex(m => m.id === id);
  if (i < 0) return;
  const m = state.movements[i];
  const p = state.products[m.barcode];
  if (p) p.qty = m.type === 'sale' ? p.qty + m.amount : Math.max(0, p.qty - m.amount);
  state.movements.splice(i, 1);
  commit();
  toast('İşlem geri alındı', true);
}

// ---------- Satış (sepet) ----------
const cartItems = () => state.cart.filter(i => state.products[i.barcode] && i.qty > 0);

const cartQty = code => state.cart.find(i => i.barcode === code)?.qty || 0;

function cartSet(code, qty) {
  const p = state.products[code];
  if (!p) return;
  qty = Math.max(0, Math.floor(qty) || 0);
  if (qty > p.qty) {
    beep(false);
    toast(p.qty ? `${p.name}: stokta sadece ${p.qty} adet var` : `${p.name} stokta yok`, false);
    qty = p.qty;
  }
  state.cart = state.cart.filter(i => i.barcode !== code);
  if (qty > 0) state.cart.push({ barcode: code, qty });
  navigator.vibrate?.(20);
  persist();
  renderSale();
}

function checkout() {
  const items = cartItems();
  if (!items.length) return toast('Satılan ürün işaretlenmedi', false);
  for (const i of items) {
    const p = state.products[i.barcode];
    if (i.qty > p.qty) return toast(`${p.name}: stokta sadece ${p.qty} adet var`, false);
  }
  const saleId = uid(), date = Date.now();
  let total = 0;
  for (const i of items) {
    const p = state.products[i.barcode];
    p.qty -= i.qty;
    total += i.qty;
    state.movements.push({ id: uid(), type: 'sale', saleId, barcode: p.barcode, name: p.name, amount: i.qty, date });
  }
  state.cart = [];
  commit();
  beep(true);
  toast(`Satış tamamlandı: ${items.length} çeşit, ${total} adet`, true, 'sale:' + saleId);
}

function cancelSale(saleId) {
  const ms = state.movements.filter(m => m.saleId === saleId);
  if (!ms.length) return;
  for (const m of ms) { const p = state.products[m.barcode]; if (p) p.qty += m.amount; }
  state.movements = state.movements.filter(m => m.saleId !== saleId);
  commit();
  toast('Satış iptal edildi, ürünler stoğa geri eklendi', true);
}

// Satışları fiş fişe grupla (eski kayıtlarda saleId yoksa her hareket ayrı fiş)
function salesGroups(filterFn = () => true) {
  const groups = new Map();
  for (const m of state.movements) {
    if (m.type !== 'sale' || !filterFn(m)) continue;
    const key = m.saleId || m.id;
    if (!groups.has(key)) groups.set(key, { id: key, date: m.date, items: [] });
    groups.get(key).items.push(m);
  }
  return [...groups.values()].sort((a, b) => b.date - a.date);
}

// ---------- Geri bildirim ----------
let audioCtx;
function beep(ok = true) {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime, len = ok ? 0.12 : 0.35;
    o.type = ok ? 'sine' : 'square';
    o.frequency.value = ok ? 1700 : 280;
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(g).connect(audioCtx.destination);
    o.start(t); o.stop(t + len);
  } catch {}
  navigator.vibrate?.(ok ? 60 : [90, 60, 90]); // Android titreşimi
}
document.addEventListener('pointerdown', () => { try { audioCtx ??= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch {} }, { once: true });

let toastTimer;
function toast(text, ok = true, undoId = null) {
  const el = $('#toast');
  el.className = 'toast ' + (ok ? 'ok' : 'err');
  el.innerHTML = `<span>${esc(text)}</span>` + (undoId ? `<button data-undo="${esc(undoId)}">Geri al</button>` : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), undoId ? 7000 : 3500);
}
$('#toast').addEventListener('click', e => {
  const id = e.target.closest('[data-undo]')?.dataset.undo;
  if (id) id.startsWith('sale:') ? cancelSale(id.slice(5)) : undoMovement(id);
  $('#toast').hidden = true;
});

// ---------- Android geri tuşu ----------
// Pencere açıkken geri tuşu pencereyi kapatır; başka sekmedeyken Özet'e döner.
let ignorePop = false;
window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop = false; return; }
  if (sheet.open) { sheet.close(); return; }
  if (activeTab !== 'summary') showTab('summary', true);
});

// ---------- Alt pencere (dialog) ----------
const sheet = $('#sheet');
let sheetHandler = null;
function openSheet(html, handler, focusSel) {
  $('#sheet-body').innerHTML = html;
  sheetHandler = handler;
  scanPaused = true;
  if (!sheet.open) { sheet.showModal(); history.pushState({ nav: 'sheet' }, ''); }
  if (focusSel) setTimeout(() => $(focusSel, sheet)?.focus(), 60);
}
function closeSheet() { if (sheet.open) sheet.close(); }
sheet.addEventListener('close', () => {
  scanPaused = false;
  sheetHandler = null;
  clearDraft();
  if (activeTab === 'stock' && document.visibilityState === 'visible') startCamera();
  if (history.state?.nav === 'sheet') { ignorePop = true; history.back(); }
});
sheet.addEventListener('click', e => {
  if (e.target === sheet) { // sadece pencerenin dışına dokununca kapat
    const r = sheet.getBoundingClientRect();
    if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) closeSheet();
    return;
  }
  const step = e.target.closest('[data-step]');
  if (step) {
    const inp = $('#amount', sheet);
    const v = (parseInt(inp.value, 10) || 0) + Number(step.dataset.step);
    inp.value = Math.min(Number(inp.max) || 99999, Math.max(Number(inp.min) || 0, v));
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'close') return closeSheet();
  sheetHandler?.(act, e.target.closest('[data-act]'));
});
sheet.addEventListener('submit', e => { e.preventDefault(); sheetHandler?.('save'); });

// ---------- Barkod okununca ----------
function handleCode(raw) {
  const code = String(raw).trim();
  if (!code) return;
  if (activeTab === 'stock') { beep(true); openStockSheet(code); }
}

function photoBox(code, pendingUrl, small = false) {
  const url = pendingUrl || photoURL[code];
  return `<div class="ph-big${small ? ' small' : ''}" data-act="photo">
    <img id="sheet-photo" src="${url || ''}" alt=""${url ? '' : ' hidden'}>
    <span id="ph-empty"${url ? ' hidden' : ''}>📷 Fotoğraf çek</span>
    <span class="ph-edit"${url ? '' : ' hidden'}>📷 Değiştir</span></div>`;
}
function showPhotoInSheet(blob) {
  const img = $('#sheet-photo', sheet);
  if (!img) return;
  img.src = URL.createObjectURL(blob);
  img.hidden = false;
  $('#ph-empty', sheet).hidden = true;
  $('.ph-edit', sheet).hidden = false;
}

function openStockSheet(code, opts = {}) {
  const p = state.products[code];
  const noBarcode = p ? !!p.noBarcode : !!opts.noBarcode;
  let pending = opts.photo || null;
  let saving = false;
  let html = `<form><h2>Stok Girişi</h2><div class="code">${noBarcode ? 'Barkodsuz ürün' : esc(code)}</div>
    ${photoBox(code, pending ? URL.createObjectURL(pending) : null, true)}`;
  if (p) html += `<div class="pname">${esc(p.name)}</div><div>Mevcut stok: <b>${p.qty}</b></div>`;
  else html += `<label for="new-name">Yeni ürün — adı</label><input id="new-name" autocomplete="off" placeholder="Örn. Çay 1 kg" value="${esc(opts.name || '')}">`;
  html += `<label for="amount">Eklenecek adet</label>
    <div class="stepper"><button type="button" data-step="-1">−</button>
    <input id="amount" type="number" inputmode="numeric" value="${Number(opts.amount) || 1}" min="1" max="99999">
    <button type="button" data-step="1">+</button></div>
    <button type="submit" class="primary">Stoğa Ekle</button>
    <button type="button" class="ghost" data-act="close">Vazgeç</button></form>`;

  openSheet(html, async act => {
    if (saving) return;
    if (act === 'photo') {
      saveDraft({ code, noBarcode, name: $('#new-name', sheet)?.value || '', amount: $('#amount', sheet).value });
      const label = $('#ph-empty', sheet);
      const b = await pickPhoto(() => { label.hidden = false; label.textContent = '⏳ Fotoğraf işleniyor…'; });
      label.textContent = '📷 Fotoğraf çek';
      if (b) { pending = b; showPhotoInSheet(b); } else if (!$('#sheet-photo', sheet)?.getAttribute('src')) label.hidden = false;
      return;
    }
    if (act !== 'save') return;
    const amount = parseInt($('#amount', sheet).value, 10);
    if (!(amount >= 1)) return toast('Geçerli bir adet girin', false);
    const name = p ? p.name : $('#new-name', sheet).value.trim();
    if (!name) { $('#new-name', sheet).focus(); return toast('Ürün adını yazın', false); }
    saving = true;
    // Önce stoğu kaydet — fotoğraf ne olursa olsun ekleme yapılır
    const m = addStock(code, name, amount, noBarcode ? { noBarcode: true } : {});
    closeSheet();
    toast(`${name}: +${amount} • Stok: ${state.products[code].qty}`, true, m.id);
    if (pending) {
      photoSet(code, pending)
        .then(() => render())
        .catch(e => toast(`Ürün eklendi ama fotoğraf kaydedilemedi (${e.message}). Ürünler'den tekrar ekleyebilirsiniz.`, false));
    }
  }, p || opts.name ? null : '#new-name');
}

// Barkodu olmayan ürün: önce fotoğraf, sonra ad ve adet
async function addWithoutBarcode() {
  const code = 'F' + Date.now().toString(36).toUpperCase();
  saveDraft({ code, noBarcode: true });
  const b = await pickPhoto(() => toast('⏳ Fotoğraf işleniyor…', true));
  if (!b) { clearDraft(); if (activeTab === 'stock') startCamera(); return; }
  openStockSheet(code, { photo: b, noBarcode: true });
}

// Kayıtlı ürünü fotoğrafından seçip stok ekle (barkodsuz ürünler için)
function openPickList() {
  const prods = Object.values(state.products).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  openSheet(`<h2>Ürün seç</h2>
    <input id="pick-search" type="search" placeholder="Ürün adı ara" autocomplete="off">
    <div class="grid">${prods.length ? prods.map(p => `<button type="button" class="tile" data-act="pick" data-b="${esc(p.barcode)}" data-name="${esc(p.name.toLocaleLowerCase('tr'))}">
      ${thumb(p.barcode, 'tile-img')}<span class="tn">${esc(p.name)}</span><span class="sub">Stok: ${p.qty}</span></button>`).join('')
      : '<div class="empty">Henüz ürün yok</div>'}</div>
    <button type="button" class="ghost" data-act="close">Vazgeç</button>`, (act, el) => {
    if (act === 'pick') openStockSheet(el.dataset.b);
  });
  $('#pick-search', sheet).addEventListener('input', e => {
    const q = e.target.value.trim().toLocaleLowerCase('tr');
    $$('.tile', sheet).forEach(t => (t.hidden = q && !t.dataset.name.includes(q)));
  });
}

// ---------- Kamera ve barkod okuma ----------
const video = $('#video');
const frame = document.createElement('canvas');
const fctx = frame.getContext('2d', { willReadFrequently: true });
let stream = null, scanning = false, scanPaused = false, lastCode = '', lastTime = 0, track = null;
let detectorPromise = null;

function getDetector() {
  return detectorPromise ??= (async () => {
    // Android Chrome'un yerleşik okuyucusu (en hızlısı)
    if ('BarcodeDetector' in window) {
      try {
        const sup = await window.BarcodeDetector.getSupportedFormats();
        if (sup.includes('ean_13')) return new window.BarcodeDetector({ formats: FORMATS.filter(f => sup.includes(f)) });
      } catch {}
    }
    // Yoksa ZXing (WebAssembly) — iPhone'da bu kullanılır
    const mod = await import(ZXING_URL);
    const det = new mod.BarcodeDetector({ formats: FORMATS });
    const c = document.createElement('canvas'); c.width = c.height = 32;
    await det.detect(c); // WASM'ı şimdiden yükle ki ilk okutma beklemesin
    return det;
  })().catch(e => { detectorPromise = null; throw e; });
}

function camMsg(text) {
  const el = $('#cam-msg');
  el.hidden = !text;
  el.textContent = text || '';
}

const isScanTab = t => t === 'stock';

async function startCamera() {
  if (stream) { video.play().catch(() => {}); if (!scanning) { scanning = true; scanLoop(); } return; }
  if (!navigator.mediaDevices?.getUserMedia) {
    camMsg('Kamera için sayfanın HTTPS adresinden açılması gerekiyor. Barkodu aşağıdan elle girebilirsiniz.');
    return;
  }
  camMsg('Kamera açılıyor…');
  let s;
  try {
    s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
  } catch (e) {
    camMsg(e.name === 'NotAllowedError'
      ? (isIOS ? 'Kamera izni verilmedi. Ayarlar > Safari > Kamera bölümünden izin verin, uygulamayı kapatıp açın.'
               : 'Kamera izni verilmedi. Adres çubuğundaki kilit simgesi > İzinler > Kamera > İzin ver (veya Ayarlar > Uygulamalar > Chrome > İzinler).')
      : 'Kamera açılamadı: ' + e.message);
    return;
  }
  if (stream || !isScanTab(activeTab) || document.visibilityState !== 'visible') { s.getTracks().forEach(t => t.stop()); return; }
  stream = s;
  video.srcObject = stream;
  await video.play().catch(() => {});
  if (stream !== s) return; // bu arada kamera kapatıldıysa (ör. fotoğraf çekmeye geçildi) dur
  setupTrackTools();
  camMsg('Barkod okuyucu hazırlanıyor…');
  try { await getDetector(); camMsg(''); }
  catch { camMsg('Barkod okuyucu yüklenemedi. İlk açılışta internet gerekir; bağlantıyı kontrol edip sekmeyi yeniden açın. Elle giriş çalışır.'); return; }
  if (stream !== s) return;
  if (!scanning) { scanning = true; scanLoop(); }
}

function stopCamera() {
  scanning = false;
  stream?.getTracks().forEach(t => t.stop());
  stream = null; track = null;
  video.srcObject = null;
  $('#torch').classList.remove('on');
  $('#zoom').classList.remove('on');
}

function setupTrackTools() {
  if (!stream) return;
  track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities?.() || {};
  $('#torch').hidden = !caps.torch;
  $('#zoom').hidden = !(caps.zoom && caps.zoom.max >= 1.5);
  if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
}
$('#torch').onclick = async e => {
  const btn = e.currentTarget, on = !btn.classList.contains('on');
  try { await track.applyConstraints({ advanced: [{ torch: on }] }); btn.classList.toggle('on', on); } catch {}
};
$('#zoom').onclick = async e => {
  const btn = e.currentTarget, on = !btn.classList.contains('on');
  try { await track.applyConstraints({ advanced: [{ zoom: on ? Math.min(2, track.getCapabilities().zoom.max) : 1 }] }); btn.classList.toggle('on', on); } catch {}
};

// Sadece ekrandaki çerçevenin içini, küçültülmüş olarak okur → çok daha hızlı
function grabScanArea() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const box = $('#cam').getBoundingClientRect(), sb = $('#cam .scanbox').getBoundingClientRect();
  if (!box.width) return null;
  const s = Math.max(box.width / vw, box.height / vh); // object-fit: cover ölçeği
  const ox = (box.width - vw * s) / 2, oy = (box.height - vh * s) / 2;
  const padX = sb.width * 0.08, padY = sb.height * 0.25;
  let sx = (sb.left - box.left - padX - ox) / s, sy = (sb.top - box.top - padY - oy) / s;
  let sw = (sb.width + padX * 2) / s, sh = (sb.height + padY * 2) / s;
  sx = Math.max(0, sx); sy = Math.max(0, sy);
  sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
  const scale = Math.min(1, 960 / sw);
  frame.width = Math.round(sw * scale); frame.height = Math.round(sh * scale);
  fctx.drawImage(video, sx, sy, sw, sh, 0, 0, frame.width, frame.height);
  return frame;
}

async function scanLoop() {
  while (scanning) {
    if (!scanPaused && video.readyState >= 2) {
      try {
        const img = grabScanArea();
        if (img) {
          const det = await getDetector();
          const codes = await det.detect(img);
          const code = codes[0]?.rawValue;
          if (code && !scanPaused) {
            const now = Date.now();
            if (code !== lastCode || now - lastTime > SAME_CODE_DELAY) handleCode(code);
            lastCode = code; lastTime = now;
          }
        }
      } catch (e) { console.warn(e); }
    }
    await new Promise(r => requestAnimationFrame(r));
  }
}

$$('form.manual').forEach(f => f.addEventListener('submit', e => {
  e.preventDefault();
  const inp = f.elements.code;
  handleCode(inp.value);
  inp.value = '';
  if (activeTab === 'stock') inp.blur();
}));

// ---------- Sekmeler ----------
const TITLES = { summary: 'Özet', sale: 'Satış', stock: 'Stok Girişi', products: 'Ürünler', backup: 'Yedek & Ayarlar' };
let activeTab = 'summary';

function showTab(name, fromPop = false) {
  if (!fromPop) {
    if (name !== 'summary' && history.state?.nav !== 'tab') history.pushState({ nav: 'tab' }, '');
    else if (name === 'summary' && history.state?.nav === 'tab') { ignorePop = true; history.back(); }
  }
  activeTab = name;
  $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $('#title').textContent = TITLES[name];
  if (isScanTab(name)) {
    $(`#tab-${name} .cam-slot`).appendChild($('#cam')); // tek kamera, iki ekranda
    lastCode = '';
    startCamera();
  } else {
    stopCamera();
  }
  if (name === 'backup') renderBackup();
  renderSale();
  window.scrollTo(0, 0);
}
$('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b && b.dataset.tab !== activeTab) showTab(b.dataset.tab); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stopCamera();
  else if (isScanTab(activeTab) && !sheet.open) startCamera();
});

// ---------- Uygulama olarak yükleme (Android) ----------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  renderSummary();
  if (activeTab === 'backup') renderBackup();
});
window.addEventListener('appinstalled', () => { installPrompt = null; renderSummary(); toast('Uygulama yüklendi', true); });
async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  renderSummary();
}

// ---------- Ekranlar ----------
function needsBackup() {
  if (!state.changedSinceExport || !state.movements.length) return false;
  return !state.lastExport || Date.now() - state.lastExport > 24 * 3600 * 1000;
}

function movementRow(m, showName = true) {
  const cls = m.type === 'sale' ? 'sale' : m.type === 'in' ? 'in' : 'adj';
  const sign = m.type === 'sale' ? `−${m.amount}` : (m.amount > 0 ? `+${m.amount}` : `${m.amount}`);
  const label = m.type === 'sale' ? 'Satış' : m.type === 'in' ? 'Giriş' : 'Sayım düzeltme';
  return `<div class="row"><div>${showName ? esc(m.name) + '<br>' : ''}<span class="sub">${label} • ${fmtDate(m.date)}</span></div><div class="qty ${cls}">${sign}</div></div>`;
}

function renderSummary() {
  const prods = Object.values(state.products);
  const lim = state.settings.lowLimit;
  const today = dayKey();
  const sales = state.movements.filter(m => m.type === 'sale');
  const todaySales = sales.filter(m => dayKey(m.date) === today);
  const soldToday = todaySales.reduce((a, m) => a + m.amount, 0);
  const receiptsToday = new Set(todaySales.map(m => m.saleId || m.id)).size;
  const soldTotal = sales.reduce((a, m) => a + m.amount, 0);
  const totalStock = prods.reduce((a, p) => a + p.qty, 0);
  const soldBy = {};
  for (const m of sales) soldBy[m.barcode] = (soldBy[m.barcode] || 0) + m.amount;
  const low = prods.filter(p => p.qty <= lim).sort((a, b) => a.qty - b.qty);
  const byName = [...prods].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  const recent = state.movements.slice(-15).reverse();

  $('#tab-summary').innerHTML = `
    ${installPrompt && !isStandalone() ? `<div class="banner"><span>📲 Uygulamayı telefona yükleyin, internetsiz çalışsın.</span><button data-act="install">Yükle</button></div>` : ''}
    ${needsBackup() ? `<div class="banner"><span>💾 ${state.lastExport ? 'Son yedek ' + fmtDate(state.lastExport) : 'Henüz yedek alınmadı'}.</span><button data-act="export">Yedek al</button></div>` : ''}
    <div class="stats">
      <div class="stat"><small>Ürün çeşidi</small><b>${prods.length}</b></div>
      <div class="stat"><small>Toplam stok</small><b>${totalStock}</b></div>
      <div class="stat"><small>Bugün satılan</small><b>${soldToday}</b><small>${receiptsToday} satış</small></div>
      <div class="stat"><small>Toplam satılan</small><b>${soldTotal}</b></div>
    </div>
    <div class="card"><h3>Az kalanlar (≤ ${lim})</h3>
      ${low.length ? low.map(p => `<div class="row"><span>${esc(p.name)}</span><span class="qty ${p.qty === 0 ? 'zero' : 'low'}">${p.qty}</span></div>`).join('') : '<div class="empty">Az kalan ürün yok</div>'}
    </div>
    <div class="card"><h3>Ürün bazında</h3>
      ${byName.length ? byName.map(p => `<div class="row"><span>${esc(p.name)}</span><span class="right"><b>Kalan: ${p.qty}</b><br><span class="sub">Satılan: ${soldBy[p.barcode] || 0}</span></span></div>`).join('') : '<div class="empty">Henüz ürün yok. “Stok Girişi” sekmesinden barkod okutarak ekleyin.</div>'}
    </div>
    <div class="card"><h3>Son hareketler</h3>
      ${recent.length ? recent.map(m => movementRow(m)).join('') : '<div class="empty">Henüz hareket yok</div>'}
    </div>`;
}

function renderSale() {
  const q = $('#sale-search').value.trim().toLocaleLowerCase('tr');
  const prods = Object.values(state.products)
    .filter(p => !q || p.name.toLocaleLowerCase('tr').includes(q) || p.barcode.includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  $('#sale-list').innerHTML = prods.length
    ? `<div class="list">${prods.map(p => {
        const n = cartQty(p.barcode), b = esc(p.barcode);
        return `<div class="row${n ? ' picked' : ''}${p.qty === 0 ? ' out' : ''}"><div class="pl">${thumb(p.barcode)}<div><span class="pn">${esc(p.name)}</span><br><span class="sub">${p.qty ? 'Stok: ' + p.qty : 'Stokta yok'}</span></div></div>
          <div class="mini"><button data-cart="-1" data-b="${b}"${n ? '' : ' disabled'}>−</button><b data-setqty="${b}">${n}</b><button data-cart="1" data-b="${b}"${n >= p.qty ? ' disabled' : ''}>+</button></div></div>`;
      }).join('')}</div>`
    : `<div class="empty">${q ? 'Sonuç yok' : 'Henüz ürün yok. Ürünleri “Stok Girişi” sekmesinden barkod okutarak ekleyin.'}</div>`;

  const items = cartItems();
  const total = items.reduce((a, i) => a + i.qty, 0);
  const show = activeTab === 'sale' && items.length > 0;
  $('#checkout-bar').hidden = !show;
  document.body.classList.toggle('has-cart', show);
  $('#co-count').textContent = `${total} adet`;
  $('#co-sub').textContent = `${items.length} çeşit ürün`;
  renderTodaySales();
}
$('#sale-search').addEventListener('input', renderSale);

function renderTodaySales() {
  const today = dayKey();
  const groups = salesGroups(m => dayKey(m.date) === today);
  $('#today-sales').innerHTML = `<div class="card"><h3>Bugünkü satışlar</h3>
    ${groups.length ? groups.map(g => {
      const qty = g.items.reduce((a, m) => a + m.amount, 0);
      const names = g.items.map(m => m.name).join(', ');
      return `<div class="row click" data-sale="${esc(g.id)}"><div>${fmtTime(g.date)} • ${g.items.length} çeşit<br><span class="sub">${esc(names.length > 60 ? names.slice(0, 60) + '…' : names)}</span></div><div class="qty sale">${qty}</div></div>`;
    }).join('') : '<div class="empty">Bugün henüz satış yok</div>'}
  </div>`;
}

function openSaleDetail(id) {
  const g = salesGroups().find(x => x.id === id);
  if (!g) return;
  const qty = g.items.reduce((a, m) => a + m.amount, 0);
  openSheet(`<h2>Satış</h2><div class="code">${fmtDate(g.date)}</div>
    ${g.items.map(m => `<div class="row"><span>${esc(m.name)}</span><span class="qty sale">${m.amount}</span></div>`).join('')}
    <div class="cart-total"><span>${g.items.length} çeşit</span><span>${qty} adet</span></div>
    <button type="button" class="danger" data-act="cancel-sale">Satışı iptal et (stoğa geri ekle)</button>
    <button type="button" class="ghost" data-act="close">Kapat</button>`, act => {
    if (act !== 'cancel-sale') return;
    if (!confirm('Bu satış iptal edilsin mi? Ürünler stoğa geri eklenir.')) return;
    closeSheet();
    if (g.items[0].saleId) cancelSale(g.id); else undoMovement(g.id);
  });
}

function renderProducts() {
  const q = $('#search').value.trim().toLocaleLowerCase('tr');
  const prods = Object.values(state.products)
    .filter(p => !q || p.name.toLocaleLowerCase('tr').includes(q) || p.barcode.includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  const lim = state.settings.lowLimit;
  $('#product-list').innerHTML = prods.length
    ? `<div class="list">${prods.map(p => `<div class="row" data-open="${esc(p.barcode)}"><div class="pl">${thumb(p.barcode)}<div>${esc(p.name)}<br><span class="sub">${codeLabel(p)}</span></div></div><div class="qty ${p.qty === 0 ? 'zero' : p.qty <= lim ? 'low' : ''}">${p.qty}</div></div>`).join('')}</div>`
    : `<div class="empty">${q ? 'Sonuç yok' : 'Henüz ürün yok. “Stok Girişi” sekmesinden barkod okutun.'}</div>`;
}
$('#search').addEventListener('input', renderProducts);
$('#product-list').addEventListener('click', e => { const r = e.target.closest('[data-open]'); if (r) openProduct(r.dataset.open); });

function openProduct(barcode) {
  const p = state.products[barcode];
  if (!p) return;
  const sold = state.movements.filter(m => m.type === 'sale' && m.barcode === barcode).reduce((a, m) => a + m.amount, 0);
  const hist = state.movements.filter(m => m.barcode === barcode).slice(-30).reverse();
  openSheet(`<form>
    <h2>${esc(p.name)}</h2><div class="code">${codeLabel(p)}</div>
    ${photoBox(barcode)}
    ${photoURL[barcode] ? '<button type="button" class="ghost" data-act="del-photo" style="margin-top:0">Fotoğrafı kaldır</button>' : ''}
    <div>Kalan: <b>${p.qty}</b> • Toplam satılan: <b>${sold}</b></div>
    <label for="edit-name">Ürün adı</label><input id="edit-name" value="${esc(p.name)}" autocomplete="off">
    <label for="amount">Stok (sayım düzeltmesi)</label>
    <div class="stepper"><button type="button" data-step="-1">−</button>
      <input id="amount" type="number" inputmode="numeric" value="${p.qty}" min="0" max="999999">
      <button type="button" data-step="1">+</button></div>
    <p class="hint">Sayım sonrası düzeltme içindir, satış olarak sayılmaz.</p>
    <button type="submit" class="primary">Kaydet</button>
    <button type="button" class="ghost" data-act="close">Kapat</button>
    <h3 style="margin-top:18px">Geçmiş</h3>
    ${hist.length ? hist.map(m => movementRow(m, false)).join('') : '<div class="empty">Hareket yok</div>'}
    <button type="button" class="danger" data-act="delete">Ürünü sil</button>
  </form>`, async act => {
    if (act === 'photo') {
      const b = await pickPhoto(() => toast('⏳ Fotoğraf işleniyor…', true));
      if (!b) return;
      try { await photoSet(barcode, b); toast('Fotoğraf kaydedildi', true); }
      catch (e) { toast('Fotoğraf kaydedilemedi: ' + e.message, false); }
      render();
      openProduct(barcode);
      return;
    }
    if (act === 'del-photo') {
      if (!confirm('Fotoğraf kaldırılsın mı?')) return;
      await photoDel(barcode);
      render();
      openProduct(barcode);
      return;
    }
    if (act === 'delete') {
      if (!confirm(`"${p.name}" silinsin mi? Satış geçmişi korunur.`)) return;
      delete state.products[barcode];
      photoDel(barcode).catch(() => {});
      state.cart = state.cart.filter(i => i.barcode !== barcode);
      commit(); closeSheet();
      toast('Ürün silindi', true);
      return;
    }
    if (act !== 'save') return;
    const name = $('#edit-name', sheet).value.trim();
    const qty = parseInt($('#amount', sheet).value, 10);
    if (!name) return toast('Ürün adı boş olamaz', false);
    if (!(qty >= 0)) return toast('Geçerli bir stok girin', false);
    p.name = name;
    if (qty !== p.qty) adjust(p, qty); else commit();
    closeSheet();
    toast('Kaydedildi', true);
  });
}

async function renderBackup() {
  const snaps = ((await kvGet('snapshots')) || []).slice().reverse();
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const saveHint = isIOS
    ? 'Açılan menüde <b>“Dosyalara Kaydet” → iCloud Drive</b> seçin. Geri yüklerken <b>Dosyalar</b> ekranından bu dosyayı seçin (iCloud Drive veya Bu iPhone\'da klasörüne bakın).'
    : 'Açılan menüde <b>Google Drive</b>\'ı seçin; menü çıkmazsa dosya <b>İndirilenler</b> klasörüne kaydedilir, oradan Drive\'a yükleyin.';
  $('#tab-backup').innerHTML = `
    ${installPrompt && !isStandalone() ? `<div class="card"><h3>Uygulama</h3><button class="primary" data-act="install">📲 Telefona Yükle</button></div>` : ''}
    <div class="card"><h3>Yedek dosyası</h3>
      <div>Son yedek: <b>${state.lastExport ? fmtDate(state.lastExport) : 'hiç alınmadı'}</b></div>
      <button class="primary" data-act="export">Yedeği Kaydet</button>
      <p class="hint">${saveHint} Telefon bozulsa veya kaybolsa bile bu dosyayla her şey geri gelir. Değişiklik varsa uygulama her gün hatırlatır.</p>
      <button data-act="import">Yedek Dosyasından Geri Yükle</button>
    </div>
    <div class="card"><h3>Otomatik günlük kopyalar</h3>
      <p class="hint">Uygulama her gün kendi içinde bir kopya tutar (son ${MAX_SNAPSHOTS}). Yanlış bir işlemden sonra geri dönmek içindir; telefon kaybına karşı yukarıdaki yedek dosyası gerekir.</p>
      ${snaps.length ? snaps.map((s, i) => {
        let info = ''; try { const d = JSON.parse(s.data); info = `${Object.keys(d.products || {}).length} ürün, ${(d.movements || []).length} hareket`; } catch {}
        return `<div class="row"><div>${fmtDate(s.time)}${s.label ? ' • ' + esc(s.label) : ''}<br><span class="sub">${info}</span></div><button data-act="restore-snap" data-i="${snaps.length - 1 - i}">Geri yükle</button></div>`;
      }).join('') : '<div class="empty">Henüz kopya yok</div>'}
    </div>
    <div class="card"><h3>Excel</h3>
      <button data-act="csv-products">Stok listesini indir (CSV)</button>
      <button data-act="csv-moves">Tüm hareketleri indir (CSV)</button>
    </div>
    <div class="card"><h3>Ayarlar</h3>
      <label class="row" style="border:0"><span>Az stok sınırı</span><input id="low-limit" type="number" inputmode="numeric" min="0" value="${state.settings.lowLimit}" style="width:90px;text-align:center"></label>
      <p class="hint">Depolama: ${persisted ? 'kalıcı ✓' : 'standart'} • ${Object.keys(state.products).length} ürün, ${state.movements.length} hareket.<br>Uygulamayı her zaman ana ekrandaki simgeden açın; tarayıcı sekmesindeki kopya ayrı veri tutabilir.</p>
    </div>`;
  $('#low-limit').addEventListener('change', e => {
    const v = parseInt(e.target.value, 10);
    if (v >= 0) { state.settings.lowLimit = v; persist(); render(); }
  });
}

function render() {
  renderSummary();
  renderSale();
  renderProducts();
}

// ---------- Yedekleme ----------
// Dosyayı telefonun paylaş menüsüyle kaydet (iPhone: Dosyalara Kaydet, Android: Drive vb.)
async function shareOrDownload(filename, text, mime) {
  if (navigator.share && navigator.canShare) {
    // iPhone bazı dosya türlerini paylaşmaz; sırayla başka türleri dene
    for (const type of [mime, 'text/plain', 'application/octet-stream']) {
      const file = new File([text], filename, { type });
      if (!navigator.canShare({ files: [file] })) continue;
      try { await navigator.share({ files: [file] }); return true; }
      catch (e) { if (e.name === 'AbortError') return false; break; }
    }
  }
  if (isIOS && isStandalone()) {
    // Ana ekran uygulamasında indirme, dosyayı sayfa olarak açıp uygulamayı kilitliyor
    toast('Paylaşım menüsü açılamadı, tekrar deneyin', false);
    return false;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new File([text], filename, { type: mime }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}

const stamp = () => { const d = new Date(); return `${dayKey()}-${pad(d.getHours())}${pad(d.getMinutes())}`; };

// 1) Yedeği hazırla  2) Kullanıcı "Kaydet"e basınca paylaş menüsünü aç
// (iPhone, paylaş menüsünü sadece doğrudan bir dokunuşla açtırıyor)
async function exportBackup() {
  const photos = {};
  const blobs = [];
  await idbEach('photos', (k, v) => blobs.push([k, recToBlob(v)]));
  for (const [k, b] of blobs) photos[k] = await blobToDataURL(b);
  const data = JSON.stringify({ app: 'depo-takip', exportedAt: new Date().toISOString(), state, photos });
  const filename = `depo-yedek-${stamp()}.json`;
  const hint = isIOS
    ? 'Açılan menüde <b>“Dosyalara Kaydet”</b> → <b>iCloud Drive</b> → <b>Kaydet</b>. Geri yüklerken dosyayı oradan seçeceksiniz.'
    : 'Açılan menüde <b>Drive</b>\'ı seçin. Menü çıkmazsa dosya <b>İndirilenler</b> klasörüne kaydedilir.';
  openSheet(`<h2>Yedek hazır</h2>
    <div class="code">${esc(filename)}</div>
    <div>${Object.keys(state.products).length} ürün • ${state.movements.length} hareket • ${blobs.length} fotoğraf • ${Math.max(1, Math.round(data.length / 1024))} KB</div>
    <button type="button" class="primary big" data-act="share">📤 ${isIOS ? 'Dosyalara Kaydet' : 'Kaydet / Paylaş'}</button>
    <p class="hint">${hint}</p>
    <button type="button" class="ghost" data-act="close">Kapat</button>`, async act => {
    if (act !== 'share') return;
    const ok = await shareOrDownload(filename, data, 'application/json');
    if (!ok) return;
    state.lastExport = Date.now();
    state.changedSinceExport = false;
    persist(); render();
    if (activeTab === 'backup') renderBackup();
    closeSheet();
    toast('Yedek kaydedildi', true);
  });
}

async function replaceState(newState, label) {
  await snapshot(false, label);
  state = normalize(newState);
  persist(); render(); renderBackup();
}

$('#import-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const parsed = JSON.parse(await f.text());
    const s = parsed.state ?? parsed;
    if (!s || typeof s.products !== 'object' || !Array.isArray(s.movements)) throw new Error();
    if (!confirm(`Yedekte ${Object.keys(s.products).length} ürün ve ${s.movements.length} hareket var. Telefondaki mevcut veriler bununla değiştirilecek (öncesi otomatik kopyalanır). Devam edilsin mi?`)) return;
    if (parsed.photos && typeof parsed.photos === 'object') {
      await photoClearAll();
      for (const [k, url] of Object.entries(parsed.photos)) {
        try { await photoSet(k, await (await fetch(url)).blob()); } catch {}
      }
    }
    await replaceState(s, 'Geri yükleme öncesi');
    toast('Yedek geri yüklendi', true);
  } catch {
    toast('Bu dosya geçerli bir yedek değil', false);
  }
});

function csv(rows) {
  return '﻿' + rows.map(r => r.map(v => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(';')).join('\r\n');
}

// Pencere dışındaki düğmeler
document.addEventListener('click', async e => {
  const cartBtn = e.target.closest('[data-cart]');
  if (cartBtn) return cartSet(cartBtn.dataset.b, cartQty(cartBtn.dataset.b) + Number(cartBtn.dataset.cart));
  const qtyEl = e.target.closest('[data-setqty]');
  if (qtyEl) {
    const code = qtyEl.dataset.setqty, p = state.products[code];
    const v = prompt(`${p.name} — kaç adet satıldı? (Stok: ${p.qty})`, cartQty(code) || '');
    if (v !== null && v.trim() !== '') cartSet(code, parseInt(v, 10));
    return;
  }
  const saleRow = e.target.closest('[data-sale]');
  if (saleRow) return openSaleDetail(saleRow.dataset.sale);

  const b = e.target.closest('[data-act]');
  if (!b || b.closest('dialog')) return;
  const act = b.dataset.act;
  if (act === 'export') exportBackup();
  else if (act === 'install') installApp();
  else if (act === 'checkout') checkout();
  else if (act === 'nobarcode') addWithoutBarcode();
  else if (act === 'pick-list') openPickList();
  else if (act === 'clear-cart') {
    if (confirm('İşaretlenen adetler sıfırlansın mı?')) { state.cart = []; persist(); renderSale(); }
  }
  else if (act === 'import') $('#import-file').click();
  else if (act === 'restore-snap') {
    const snaps = (await kvGet('snapshots')) || [];
    const s = snaps[Number(b.dataset.i)];
    if (!s || !confirm(`${fmtDate(s.time)} tarihli kopyaya dönülsün mü? (Şu anki durum da kopyalanır.)`)) return;
    await replaceState(JSON.parse(s.data), 'Kopyaya dönmeden önce');
    toast('Kopya geri yüklendi', true);
  } else if (act === 'csv-products') {
    const sold = {};
    for (const m of state.movements) if (m.type === 'sale') sold[m.barcode] = (sold[m.barcode] || 0) + m.amount;
    const rows = [['Barkod', 'Ürün', 'Kalan', 'Satılan']].concat(
      Object.values(state.products).sort((a, b) => a.name.localeCompare(b.name, 'tr')).map(p => [p.barcode, p.name, p.qty, sold[p.barcode] || 0]));
    shareOrDownload(`stok-${stamp()}.csv`, csv(rows), 'text/csv');
  } else if (act === 'csv-moves') {
    const T = { in: 'Giriş', sale: 'Satış', adj: 'Sayım düzeltme' };
    const rows = [['Tarih', 'İşlem', 'Barkod', 'Ürün', 'Adet']].concat(
      state.movements.map(m => [new Date(m.date).toLocaleString('tr-TR'), T[m.type], m.barcode, m.name, m.amount]));
    shareOrDownload(`hareketler-${stamp()}.csv`, csv(rows), 'text/csv');
  }
});

// ---------- Başlat ----------
(async function init() {
  try { await loadState(); } catch (e) { toast('Veriler okunamadı: ' + e.message, false); }
  try { await loadPhotos(); } catch {}
  const draft = takeDraft();
  if (draft) {
    showTab('stock');
    openStockSheet(draft.code, draft);
    toast('Fotoğraf çekilirken uygulama yeniden başladı. Yazdıklarınız korundu, fotoğrafı tekrar çekin.', false);
  }
  render();
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Okuyucuyu arka planda hazırla ki tarama ekranı anında açılsın
  if (navigator.onLine) getDetector().catch(() => {});
})();
