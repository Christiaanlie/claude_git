(function () {
  'use strict';
  const VERSION = '1.1.0';
  const KEY = 'taxstatements.v1';
  const P = window.StatementParser;
  const CATS = P.CATS;
  const CAT_ORDER = ['in', 'out', 'interestEarned', 'interestCharged', 'interestPaidOut', 'excluded'];
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------- State ----------------
  const defaults = { tyMonth: 2, tyDay: 1, dateOrder: 'auto', currency: '', ty: null };
  let state = { settings: Object.assign({}, defaults), files: [], txns: {} };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      state = { settings: Object.assign({}, defaults, s.settings), files: s.files || [], txns: s.txns || {} };
    }
  } catch (e) { /* storage unavailable: run in-memory */ }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { toast('Could not save on this device (storage full or private mode).'); }
  }

  // ---------------- Tax year helpers ----------------
  const S = () => state.settings;
  const pad = (n) => String(n).padStart(2, '0');
  function tyStartYearOf(dateStr) {
    const y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7) - 1, d = +dateStr.slice(8, 10);
    return (m > S().tyMonth || (m === S().tyMonth && d >= S().tyDay)) ? y : y - 1;
  }
  function tyBounds(sy) {
    const start = `${sy}-${pad(S().tyMonth + 1)}-${pad(S().tyDay)}`;
    const end = `${sy + 1}-${pad(S().tyMonth + 1)}-${pad(S().tyDay)}`; // exclusive
    return { start, end };
  }
  function tyLabel(sy) {
    if (S().tyMonth === 0 && S().tyDay === 1) return `Tax year ${sy}`;
    return `Tax year ${sy}/${String((sy + 1) % 100).padStart(2, '0')}`;
  }
  function fmtDate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
  }
  function tyRangeText(sy) {
    const b = tyBounds(sy);
    const last = new Date(+b.end.slice(0, 4), +b.end.slice(5, 7) - 1, +b.end.slice(8, 10) - 1);
    return `${fmtDate(b.start)} – ${last.getDate()} ${MONTH_NAMES[last.getMonth()]} ${last.getFullYear()}`;
  }
  function currentTY() {
    if (S().ty) return S().ty;
    // year with most transactions, else the last completed tax year
    const counts = {};
    Object.values(state.txns).forEach((t) => { const y = tyStartYearOf(t.date); counts[y] = (counts[y] || 0) + 1; });
    const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    if (best) return +best;
    const today = new Date();
    return tyStartYearOf(`${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`) - 1;
  }
  const fallbackYearFor = (m, d) => {
    const sy = currentTY();
    return (m > S().tyMonth || (m === S().tyMonth && d >= S().tyDay)) ? sy : sy + 1;
  };

  // ---------------- Money ----------------
  const nf = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (v) => {
    const c = S().currency ? S().currency + (S().currency.length > 1 ? ' ' : '') : '';
    return (v < 0 ? '−' : '') + c + nf.format(Math.abs(v));
  };

  const catOf = (t) => t.cat || P.classify(t);

  function txnsInTY(sy) {
    const b = tyBounds(sy);
    return Object.entries(state.txns)
      .filter(([, t]) => t.date >= b.start && t.date < b.end)
      .map(([id, t]) => Object.assign({ id }, t))
      .sort((a, b2) => (a.date < b2.date ? -1 : a.date > b2.date ? 1 : 0));
  }

  function totals(list) {
    const r = { in: 0, out: 0, interestEarned: 0, interestPaidOut: 0, interestCharged: 0, excluded: 0, n: {} };
    for (const t of list) {
      const c = catOf(t);
      r[c] += Math.abs(t.amount);
      r.n[c] = (r.n[c] || 0) + 1;
    }
    return r;
  }

  // ---------------- Import ----------------
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const prog = $('progress');
    prog.classList.remove('hidden');
    const msgs = [];
    let added = 0, dupes = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      prog.textContent = `Reading ${i + 1} of ${files.length}: ${f.name}…`;
      try {
        if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') await loadPdfJs();
        const list = await P.parseFile(f, {
          dateOrder: S().dateOrder,
          fallbackYearFor,
          getPassword: (wrong) => window.prompt(`${wrong ? 'Wrong password. ' : ''}"${f.name}" is password protected. Enter the password (often your ID number or account number):`)
        });
        if (!list.length) { msgs.push(`⚠️ ${f.name}: no transactions found.`); continue; }
        const fileId = 'f' + Date.now().toString(36) + i;
        const seen = {};
        let fa = 0;
        for (const t of list) {
          const base = hash(`${t.date}|${t.amount.toFixed(2)}|${t.desc.toLowerCase().replace(/[^a-z0-9]/g, '')}`);
          seen[base] = (seen[base] || 0) + 1;
          const id = base + '.' + seen[base];
          const ex = state.txns[id];
          if (ex) { if (!ex.sources.includes(fileId)) ex.sources.push(fileId); dupes++; }
          else { state.txns[id] = Object.assign({}, t, { sources: [fileId] }); added++; fa++; }
        }
        const dates = list.map((t) => t.date).sort();
        state.files.push({ id: fileId, name: f.name, addedAt: Date.now(), count: list.length, from: dates[0], to: dates[dates.length - 1] });
        msgs.push(`✓ ${f.name}: ${list.length} transactions`);
      } catch (e) {
        console.error(e);
        msgs.push(`⚠️ ${f.name}: ${e && e.message ? e.message : 'could not be read.'}`);
      }
    }
    // On first import, jump to the tax year that has the most data
    S().ty = S().ty || currentTY();
    save();
    prog.innerHTML = msgs.map(esc).join('<br>') + (dupes ? `<br><span class="muted">${dupes} duplicate transaction(s) from overlapping statements were skipped.</span>` : '');
    renderAll();
  }

  let pdfPromise = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve();
    if (pdfPromise) return pdfPromise;
    pdfPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/pdf.min.js';
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; res(); };
      s.onerror = () => { pdfPromise = null; rej(new Error('Could not load the PDF reader.')); };
      document.head.appendChild(s);
    });
    return pdfPromise;
  }

  function removeFile(fileId) {
    for (const [id, t] of Object.entries(state.txns)) {
      t.sources = t.sources.filter((s) => s !== fileId);
      if (!t.sources.length) delete state.txns[id];
    }
    state.files = state.files.filter((f) => f.id !== fileId);
    save(); renderAll();
  }

  // ---------------- Rendering ----------------
  let view = 'statements';
  let filter = 'all';
  let query = '';

  function renderHeader() {
    const sy = currentTY();
    $('tyTitle').textContent = tyLabel(sy);
    $('tyRange').textContent = tyRangeText(sy);
  }

  function renderStatements() {
    const sy = currentTY();
    const list = txnsInTY(sy);
    const byMonth = {};
    list.forEach((t) => { const k = t.date.slice(0, 7); byMonth[k] = (byMonth[k] || 0) + 1; });
    let html = '', covered = 0;
    for (let i = 0; i < 12; i++) {
      const mi = (S().tyMonth + i) % 12;
      const y = sy + (S().tyMonth + i >= 12 ? 1 : 0);
      const k = `${y}-${pad(mi + 1)}`;
      const n = byMonth[k] || 0;
      if (n) covered++;
      html += `<div class="month ${n ? 'ok' : 'missing'}"><div class="m-name">${MONTH_NAMES[mi]} ${String(y).slice(2)}</div><div class="m-sub">${n ? n + ' txns' : 'missing'}</div></div>`;
    }
    $('months').innerHTML = html;
    $('coverCount').textContent = `· ${covered} of 12`;

    const files = state.files.slice().sort((a, b) => (a.from < b.from ? -1 : 1));
    $('files').innerHTML = files.length ? files.map((f) => `
      <div class="row">
        <div><div class="row-t">${esc(f.name)}</div><div class="row-s">${f.count} transactions · ${fmtDate(f.from)} – ${fmtDate(f.to)}</div></div>
        <button class="x-btn" data-remove="${esc(f.id)}" aria-label="Remove ${esc(f.name)}">Remove</button>
      </div>`).join('') : '<div class="empty">No statements yet. Tap the green box above to add them.</div>';
  }

  function renderSummary() {
    const sy = currentTY();
    const list = txnsInTY(sy);
    const t = totals(list);
    $('sumIn').textContent = money(t.in);
    $('sumOut').textContent = money(t.out);
    $('sumInN').textContent = `${t.n.in || 0} transactions`;
    $('sumOutN').textContent = `${t.n.out || 0} transactions`;
    $('sumNet').textContent = money(t.in - t.out);
    $('intEarned').textContent = money(t.interestEarned);
    $('intPaidOut').textContent = money(t.interestPaidOut);
    $('intCharged').textContent = money(t.interestCharged);

    // Did the bank pay interest to you, and when?
    const paid = list.filter((x) => catOf(x) === 'interestEarned');
    const nPaid = paid.length;
    $('intStatus').textContent = nPaid
      ? `✓ Yes, the bank paid you interest ${nPaid === 1 ? 'once' : nPaid + ' times'}`
      : '✗ No interest was paid to you';
    $('intNote').textContent = nPaid
      ? 'Total for this tax year. This amount is kept out of "Money received".'
      : 'No interest payments were found in the statements for this tax year.';
    const byM = {};
    paid.forEach((x) => { const k = x.date.slice(0, 7); (byM[k] = byM[k] || []).push(x); });
    $('intMonths').innerHTML = Object.keys(byM).sort().map((k) => {
      const items = byM[k];
      const sum = items.reduce((s, x) => s + Math.abs(x.amount), 0);
      const sub = items.map((x) => `${fmtDate(x.date)} · ${esc(x.desc)}`).join('<br>');
      return `<div class="row"><div><div class="row-t">${MONTH_NAMES[+k.slice(5) - 1]} ${k.slice(0, 4)}</div><div class="row-s">${sub}</div></div><div class="row-a pos">+${money(sum)}</div></div>`;
    }).join('');

    const review = list.filter((x) => x.uncertain && !x.cat).length;
    const rb = $('reviewBanner');
    rb.classList.toggle('hidden', !review);
    rb.textContent = `⚠️ ${review} transaction(s) could not be read with certainty as money in or out. Tap to review.`;

    const rows = [];
    for (let i = 0; i < 12; i++) {
      const mi = (S().tyMonth + i) % 12;
      const y = sy + (S().tyMonth + i >= 12 ? 1 : 0);
      const k = `${y}-${pad(mi + 1)}`;
      const mt = totals(list.filter((x) => x.date.slice(0, 7) === k));
      rows.push(`<tr><td>${MONTH_NAMES[mi]} ${String(y).slice(2)}</td><td class="pos">${nf.format(mt.in)}</td><td class="neg">${nf.format(mt.out)}</td><td class="pos">${mt.interestEarned ? nf.format(mt.interestEarned) : '–'}</td></tr>`);
    }
    rows.push(`<tr class="total"><td>Total</td><td class="pos">${nf.format(t.in)}</td><td class="neg">${nf.format(t.out)}</td><td class="pos">${nf.format(t.interestEarned)}</td></tr>`);
    $('monthRows').innerHTML = rows.join('');
  }

  function renderTxns() {
    const sy = currentTY();
    const all = txnsInTY(sy);
    const chips = [['all', 'All'], ['in', 'Received'], ['out', 'Spent'], ['interestEarned', 'Interest paid to you'], ['interestCharged', 'Interest charged'], ['interestPaidOut', 'Interest moved out'], ['review', 'Needs review'], ['excluded', 'Excluded']];
    const count = (k) => k === 'all' ? all.length : k === 'review' ? all.filter((t) => t.uncertain && !t.cat).length : all.filter((t) => catOf(t) === k).length;
    $('chips').innerHTML = chips.map(([k, l]) => `<button class="chip ${filter === k ? 'active' : ''}" data-filter="${k}">${l} ${count(k)}</button>`).join('');
    const q = query.toLowerCase();
    const list = all.filter((t) => (filter === 'all' || (filter === 'review' ? t.uncertain && !t.cat : catOf(t) === filter)) && (!q || t.desc.toLowerCase().includes(q)));
    if (!list.length) { $('txnList').innerHTML = '<div class="card"><div class="empty">No transactions here.</div></div>'; return; }
    const groups = {};
    list.forEach((t) => { (groups[t.date.slice(0, 7)] = groups[t.date.slice(0, 7)] || []).push(t); });
    $('txnList').innerHTML = Object.keys(groups).sort().map((k) => {
      const g = groups[k];
      const sum = g.reduce((s, t) => s + (catOf(t) === 'excluded' ? 0 : t.amount), 0);
      return `<div class="group-h"><span>${MONTH_NAMES[+k.slice(5) - 1]} ${k.slice(0, 4)}</span><span>${money(sum)}</span></div>
        <div class="card list">${g.map((t) => {
          const c = catOf(t);
          const cls = c === 'in' || c === 'interestEarned' ? 'pos' : c === 'excluded' ? 'muted' : 'neg';
          const tags = (c.startsWith('interest') ? `<span class="tag int">${CATS[c]}</span>` : c === 'excluded' ? '<span class="tag">Excluded</span>' : '')
            + (t.uncertain && !t.cat ? '<span class="tag warn">check</span>' : '') + (t.cat ? '<span class="tag">edited</span>' : '');
          return `<div class="row tap" data-txn="${esc(t.id)}"><div><div class="row-t">${esc(t.desc)}</div><div class="row-s">${tags}${fmtDate(t.date)}</div></div><div class="row-a ${cls}">${c === 'in' || c === 'interestEarned' ? '+' : c === 'excluded' ? '' : '−'}${money(Math.abs(t.amount)).replace('−', '')}</div></div>`;
        }).join('')}</div>`;
    }).join('');
  }

  function renderSettings() {
    const key = `${S().tyMonth}-${S().tyDay}`;
    const sel = $('tyPreset');
    const has = Array.from(sel.options).some((o) => o.value === key);
    sel.value = has ? key : 'custom';
    $('customTy').classList.toggle('hidden', has);
    $('tyDay').value = S().tyDay;
    $('tyMonth').value = S().tyMonth;
    $('dateOrder').value = S().dateOrder;
    $('currency').value = S().currency;
    $('ver').textContent = VERSION;
  }

  function renderAll() {
    renderHeader();
    renderStatements();
    renderSummary();
    renderTxns();
    renderSettings();
  }

  function show(v) {
    view = v;
    document.querySelectorAll('.view').forEach((el) => el.classList.toggle('hidden', el.id !== 'view-' + v));
    document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    window.scrollTo(0, 0);
  }

  // ---------------- Sheet (category picker) ----------------
  function openTxnSheet(id) {
    const t = state.txns[id];
    if (!t) return;
    const cur = catOf(t);
    const auto = P.classify(t);
    const sheet = $('sheet');
    sheet.innerHTML = `
      <h3>${esc(t.desc)}</h3>
      <div class="sheet-sub">${fmtDate(t.date)} · ${t.amount < 0 ? 'Debit' : 'Credit'} ${money(Math.abs(t.amount))}${t.balance !== undefined ? ' · balance ' + money(t.balance) : ''}</div>
      ${CAT_ORDER.map((c) => `<button class="opt ${c === cur ? 'sel' : ''}" data-cat="${c}">${CATS[c]}${c === auto && c !== cur ? ' <span class="muted">(auto)</span>' : ''}</button>`).join('')}
      ${t.cat ? '<button class="btn secondary cancel" data-cat="__reset">Reset to automatic</button>' : ''}
      <button class="btn secondary cancel" data-cat="__close">Close</button>`;
    sheet.dataset.id = id;
    $('sheetBackdrop').classList.remove('hidden');
  }
  function closeSheet() { $('sheetBackdrop').classList.add('hidden'); }

  // ---------------- Export ----------------
  function csvCell(v) { const s = String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  async function shareCsv(name, rows) {
    const text = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const file = new File([text], name, { type: 'text/csv' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function exportSummary() {
    const sy = currentTY();
    const list = txnsInTY(sy);
    const t = totals(list);
    const rows = [[tyLabel(sy), tyRangeText(sy)], [], ['Category', 'Total', 'Transactions']];
    CAT_ORDER.forEach((c) => rows.push([CATS[c], t[c].toFixed(2), t.n[c] || 0]));
    rows.push(['Net (received - spent)', (t.in - t.out).toFixed(2), '']);
    rows.push([], ['Month', 'Received', 'Spent', 'Interest paid to you', 'Interest charged', 'Interest moved out']);
    for (let i = 0; i < 12; i++) {
      const mi = (S().tyMonth + i) % 12;
      const y = sy + (S().tyMonth + i >= 12 ? 1 : 0);
      const k = `${y}-${pad(mi + 1)}`;
      const m = totals(list.filter((x) => x.date.slice(0, 7) === k));
      rows.push([`${MONTH_NAMES[mi]} ${y}`, m.in.toFixed(2), m.out.toFixed(2), m.interestEarned.toFixed(2), m.interestCharged.toFixed(2), m.interestPaidOut.toFixed(2)]);
    }
    rows.push([], ['Interest transactions']);
    rows.push(['Date', 'Description', 'Amount', 'Category']);
    list.filter((x) => catOf(x).startsWith('interest')).forEach((x) => rows.push([x.date, x.desc, x.amount.toFixed(2), CATS[catOf(x)]]));
    shareCsv(`tax-summary-${sy}.csv`, rows);
  }
  function exportTxns() {
    const sy = currentTY();
    const rows = [['Date', 'Description', 'Amount', 'Category', 'Balance', 'Source file']];
    const names = Object.fromEntries(state.files.map((f) => [f.id, f.name]));
    txnsInTY(sy).forEach((x) => rows.push([x.date, x.desc, x.amount.toFixed(2), CATS[catOf(x)], x.balance !== undefined ? x.balance.toFixed(2) : '', (x.sources || []).map((s) => names[s]).join(' | ')]));
    shareCsv(`transactions-${sy}.csv`, rows);
  }

  let toastTimer;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  // ---------------- Events ----------------
  $('tyMonth').innerHTML = MONTH_NAMES.map((m, i) => `<option value="${i}">${m}</option>`).join('');
  $('fileInput').addEventListener('change', (e) => { importFiles(e.target.files).finally(() => { e.target.value = ''; }); });
  const dz = $('dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => importFiles(e.dataTransfer.files));
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); if (e.target.closest && !e.target.closest('#dropzone')) importFiles(e.dataTransfer.files); });

  $('tabbar').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.view); });
  $('tyPrev').addEventListener('click', () => { S().ty = currentTY() - 1; save(); renderAll(); });
  $('tyNext').addEventListener('click', () => { S().ty = currentTY() + 1; save(); renderAll(); });
  $('files').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (b && confirm('Remove this statement and its transactions?')) removeFile(b.dataset.remove);
  });
  $('view-summary').addEventListener('click', (e) => {
    const r = e.target.closest('[data-goto]');
    if (r) { filter = r.dataset.goto; renderTxns(); show('txns'); }
  });
  $('reviewBanner').addEventListener('click', () => { filter = 'review'; renderTxns(); show('txns'); });
  $('chips').addEventListener('click', (e) => { const c = e.target.closest('[data-filter]'); if (c) { filter = c.dataset.filter; renderTxns(); } });
  $('search').addEventListener('input', (e) => { query = e.target.value; renderTxns(); });
  $('txnList').addEventListener('click', (e) => { const r = e.target.closest('[data-txn]'); if (r) openTxnSheet(r.dataset.txn); });
  $('sheetBackdrop').addEventListener('click', (e) => {
    if (e.target === $('sheetBackdrop')) return closeSheet();
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    const t = state.txns[$('sheet').dataset.id];
    const c = b.dataset.cat;
    if (c === '__close') return closeSheet();
    if (c === '__reset') delete t.cat;
    else if (c === P.classify(t) && !t.uncertain) delete t.cat;
    else t.cat = c;
    save(); closeSheet(); renderAll();
  });
  $('exportSummary').addEventListener('click', exportSummary);
  $('exportTxns').addEventListener('click', exportTxns);

  $('tyPreset').addEventListener('change', (e) => {
    if (e.target.value === 'custom') { $('customTy').classList.remove('hidden'); return; }
    const [m, d] = e.target.value.split('-').map(Number);
    S().tyMonth = m; S().tyDay = d; S().ty = null; save(); renderAll();
  });
  const customChange = () => {
    const d = Math.min(28, Math.max(1, parseInt($('tyDay').value, 10) || 1));
    S().tyMonth = +$('tyMonth').value; S().tyDay = d; S().ty = null; save(); renderAll();
    $('customTy').classList.remove('hidden'); $('tyPreset').value = 'custom';
  };
  $('tyDay').addEventListener('change', customChange);
  $('tyMonth').addEventListener('change', customChange);
  $('dateOrder').addEventListener('change', (e) => { S().dateOrder = e.target.value; save(); toast('Applies to statements you import from now on.'); });
  $('currency').addEventListener('input', (e) => { S().currency = e.target.value.trim(); save(); renderSummary(); renderTxns(); });
  $('clearAll').addEventListener('click', () => {
    if (!confirm('Delete all imported statements and transactions from this iPhone?')) return;
    state.files = []; state.txns = {}; S().ty = null; save(); $('progress').classList.add('hidden'); renderAll(); toast('All data deleted.');
  });

  renderAll();
  show(view);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
