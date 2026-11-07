/*
 * Statement parsing + classification.
 * Everything runs on-device; no data ever leaves the phone.
 *
 * Output of every parser: array of raw transactions
 *   { date: 'YYYY-MM-DD', desc: string, amount: signed number (+ in, - out),
 *     balance?: number, uncertain?: boolean, hint?: 'interest' }
 */
(function (global) {
  'use strict';

  // ---------- Month names (English + Afrikaans + Dutch) ----------
  const MONTHS = {
    jan: 0, january: 0, januarie: 0, januari: 0,
    feb: 1, february: 1, februarie: 1, februari: 1,
    mar: 2, march: 2, mrt: 2, maart: 2, maa: 2,
    apr: 3, april: 3,
    may: 4, mei: 4,
    jun: 5, june: 5, junie: 5, juni: 5,
    jul: 6, july: 6, julie: 6, juli: 6,
    aug: 7, august: 7, augustus: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, okt: 9, oktober: 9,
    nov: 10, november: 10,
    dec: 11, december: 11, des: 11, desember: 11
  };
  const MON_RE = '(?:' + Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|') + ')\\.?';

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const validYMD = (y, m, d) => {
    if (m < 0 || m > 11 || d < 1 || d > 31) return false;
    const dt = new Date(y || 2000, m, d);
    return dt.getMonth() === m && dt.getDate() === d;
  };
  const fixYear = (y) => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);

  // Date patterns, each anchored at the start. Returns {y?, m, d, len}
  const DATE_PATTERNS = [
    // 2025-03-14, 2025/03/14, 2025.03.14
    { re: /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?![\d])/, fn: (a) => ({ y: +a[1], m: +a[2] - 1, d: +a[3] }) },
    // 20250314 (OFX / some CSV)
    { re: /^(\d{4})(\d{2})(\d{2})(?=\D|$)/, fn: (a) => ({ y: +a[1], m: +a[2] - 1, d: +a[3] }) },
    // 14/03/2025, 14-03-25, 03/14/2025 (order decided later)
    { re: /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?![\d])/, fn: (a) => ({ a: +a[1], b: +a[2], y: fixYear(+a[3]), ambiguous: true }) },
    // 14 Mar 2025, 14-Mar-25, 14 March, 14Mar
    { re: new RegExp('^(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-/.]*(' + MON_RE + ')(?:[\\s\\-/.,]+(\\d{4}|\\d{2})(?![\\d:]))?', 'i'),
      fn: (a) => ({ d: +a[1], m: MONTHS[a[2].toLowerCase().replace('.', '')], y: a[3] ? fixYear(+a[3]) : undefined }) },
    // Mar 14, 2025 / March 14
    { re: new RegExp('^(' + MON_RE + ')[\\s\\-/.]+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?![\\d])', 'i'),
      fn: (a) => ({ m: MONTHS[a[1].toLowerCase().replace('.', '')], d: +a[2], y: a[3] ? +a[3] : undefined }) },
    // 14/03 (no year)
    { re: /^(\d{1,2})[/.](\d{1,2})(?![\d/.])/, fn: (a) => ({ a: +a[1], b: +a[2], ambiguous: true }) }
  ];

  function matchDate(str) {
    const s = String(str).trim();
    for (const p of DATE_PATTERNS) {
      const a = s.match(p.re);
      if (a) {
        const r = p.fn(a);
        r.len = a[0].length;
        if (r.ambiguous) return r;
        if (r.m === undefined || isNaN(r.m)) continue;
        if (!validYMD(r.y, r.m, r.d)) continue;
        return r;
      }
    }
    return null;
  }

  // Decide day/month order from a set of ambiguous dates.
  function detectDateOrder(tokens, preferred) {
    if (preferred === 'DMY' || preferred === 'MDY') return preferred;
    let dmy = 0, mdy = 0;
    for (const t of tokens) {
      if (!t || !t.ambiguous) continue;
      if (t.a > 12 && t.b <= 12) dmy++;
      else if (t.b > 12 && t.a <= 12) mdy++;
    }
    return mdy > dmy ? 'MDY' : 'DMY';
  }

  function resolveDate(tok, order) {
    if (!tok) return null;
    let { y, m, d } = tok;
    if (tok.ambiguous) {
      if (order === 'MDY') { m = tok.a - 1; d = tok.b; } else { d = tok.a; m = tok.b - 1; }
    }
    if (!validYMD(y, m, d)) return null;
    return { y, m, d };
  }

  // ---------- Amounts ----------
  const AMT_CORE = '\\(?[-+]?\\s?(?:(?:ZAR|USD|GBP|EUR|AUD|NZD|CAD|CHF|NAD|BWP|INR)\\s?|[$€£¥₹R]\\s?)?[-+]?(?:\\d{1,3}(?:[,\\u00a0 .\\u2019\']\\d{3})+|\\d+)[.,]\\d{2}\\)?(?:\\s?-)?(?:\\s?(?:CR|DR|Cr|Dr|cr|dr)\\b)?';
  const AMT_FULL = new RegExp('^' + AMT_CORE + '$');
  const AMT_TAIL = new RegExp('(?:^|\\s)(' + AMT_CORE + ')$');

  /** Parse a money string. Returns {value, abs, sign} where sign is -1/+1 if explicit, 0 if unknown. */
  function parseAmount(raw, requireDecimals) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') return isFinite(raw) ? { value: raw, abs: Math.abs(raw), sign: raw < 0 ? -1 : 0 } : null;
    let s = String(raw).trim();
    if (!s) return null;
    let sign = 0;
    const crdr = s.match(/\s*(cr|dr|credit|debit)\.?$/i);
    if (crdr) { sign = /^c/i.test(crdr[1]) ? 1 : -1; s = s.slice(0, crdr.index); }
    if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
    s = s.replace(/^(ZAR|USD|GBP|EUR|AUD|NZD|CAD|CHF|NAD|BWP|INR)\s?/i, '').replace(/[$€£¥₹R\s '’]/g, '');
    if (/^-|-$/.test(s)) { sign = -1; s = s.replace(/-/g, ''); }
    if (/^\+/.test(s)) { if (!sign) sign = 1; s = s.slice(1); }
    // European decimal comma: 1.234,56 or 12,34
    if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    if (requireDecimals ? !/^\d+\.\d{2}$/.test(s) : !/^\d+(\.\d+)?$/.test(s)) return null;
    const abs = parseFloat(s);
    if (!isFinite(abs)) return null;
    return { value: sign < 0 ? -abs : abs, abs, sign };
  }

  // ---------- Classification ----------
  const CATS = {
    in: 'Money received',
    out: 'Money spent',
    interestEarned: 'Interest paid to you',
    interestPaidOut: 'Interest moved out',
    interestCharged: 'Interest charged',
    excluded: 'Excluded'
  };

  const INTEREST_RE = /\binterest\b|\bint\.?\s?(?:pd|paid|earned|cr|dr|credit|debit|capitali[sz]ed|received)\b|\brente\b|\bint\s+on\b|\bcredit\s+int\b|\bdebit\s+int\b|\bzinsen?\b/i;
  const NOT_INTEREST_RE = /interest[-\s]?free|no\s+interest|0%\s*interest/i;
  const PAYOUT_RE = /pay\s?-?out|paid\s+out|payout|transfer(?:red)?\s+(?:to|out)|uitbetaal|uitbetaling|to\s+(?:linked|nominated|main|current|cheque|savings)\s+acc|interest\s+(?:transfer|trf|tfr)|\btrf\b|\btfr\b|sweep/i;
  const CHARGE_RE = /debit\s+int|overdraft|o\/d|\bod\s+int|loan|bond|mortgage|credit\s+card|charged|finance\s+charge|late|arrears|penalty|dr\s+int|int(?:erest)?\s+dr/i;

  function isInterest(desc, hint) {
    if (hint === 'interest') return true;
    return INTEREST_RE.test(desc) && !NOT_INTEREST_RE.test(desc);
  }

  /** Auto-classify a transaction from its sign and description. */
  function classify(t) {
    const desc = t.desc || '';
    if (isInterest(desc, t.hint)) {
      if (t.amount >= 0) return 'interestEarned';
      if (PAYOUT_RE.test(desc) && !CHARGE_RE.test(desc)) return 'interestPaidOut';
      return 'interestCharged';
    }
    return t.amount >= 0 ? 'in' : 'out';
  }

  const CREDIT_WORDS = /\b(deposit|salary|salaris|payroll|wages|received|refund|reversal|cashback|credit\s+transfer|transfer\s+from|from\s+acc|inward|incoming|dividend|magtap\s+krediet|krediet|cash\s+dep|eft\s+cr|payment\s+received|interest\s+(?:earned|received|credit|paid\s+to\s+you)|credit\s+interest)\b/i;
  const DEBIT_WORDS = /\b(purchase|pos|card|debit\s+order|withdrawal|atm|fee|charge|payment\s+to|transfer\s+to|eft\s+dr|airtime|fuel|debit)\b/i;

  // ---------- Balance-based sign resolution ----------
  // Works whether the statement is oldest-first or newest-first.
  function resolveSignsByBalance(list, openingBalance) {
    if (!list.length) return;
    const first = list[0].date, last = list[list.length - 1].date;
    const reverse = first > last; // newest first
    const ordered = reverse ? list.slice().reverse() : list;
    let prev = reverse ? null : openingBalance;
    for (let i = 0; i < ordered.length; i++) {
      const t = ordered[i];
      if (t.sign === 0 && t.balance !== undefined && prev !== null && prev !== undefined) {
        const diff = +(t.balance - prev).toFixed(2);
        if (Math.abs(Math.abs(diff) - t.abs) < 0.011) t.sign = diff >= 0 ? 1 : -1;
      }
      if (t.sign === 0 && t.balance !== undefined && (prev === null || prev === undefined)) {
        // Look ahead: next balance - amount relationship (balance before first row)
        const nx = ordered[i + 1];
        if (nx && nx.balance !== undefined && nx.sign !== 0) {
          // can't infer for this row without previous balance; leave for fallback
        }
      }
      if (t.balance !== undefined) prev = t.balance;
    }
  }

  function finalize(list, conv) {
    // conv: document-level convention: {crOnly, minusOnly}
    for (const t of list) {
      if (t.sign === 0) {
        if (conv && conv.crOnly) t.sign = -1; // only credits are marked "Cr" (e.g. FNB)
        else if (conv && conv.minusOnly) t.sign = 1; // only debits marked with "-"
        else if (CREDIT_WORDS.test(t.desc)) { t.sign = 1; t.uncertain = true; }
        else { t.sign = -1; t.uncertain = !DEBIT_WORDS.test(t.desc); }
      }
    }
    return list.map((t) => {
      const out = {
        date: t.date,
        desc: (t.desc || '').replace(/\s+/g, ' ').trim() || '(no description)',
        amount: +(t.sign * t.abs).toFixed(2)
      };
      if (t.balance !== undefined) out.balance = t.balance;
      if (t.uncertain) out.uncertain = true;
      if (t.hint) out.hint = t.hint;
      return out;
    }).filter((t) => t.amount !== 0);
  }

  // ---------- Year inference for dates printed without a year ----------
  function makeYearResolver(fullDates, fallbackYearFor) {
    const times = fullDates.map((d) => new Date(d.y, d.m, d.d).getTime()).filter(isFinite).sort((a, b) => a - b);
    const lo = times.length ? times[0] - 45 * 864e5 : null;
    const hi = times.length ? times[times.length - 1] + 45 * 864e5 : null;
    return function (m, d) {
      if (lo !== null) {
        const y0 = new Date(lo).getFullYear(), y1 = new Date(hi).getFullYear();
        for (let y = y0; y <= y1; y++) {
          const t = new Date(y, m, d).getTime();
          if (t >= lo && t <= hi) return y;
        }
      }
      return fallbackYearFor ? fallbackYearFor(m, d) : new Date().getFullYear();
    };
  }

  // ---------- CSV ----------
  function parseCSVRows(text) {
    text = text.replace(/^﻿/, '');
    const sample = text.split(/\r?\n/).slice(0, 30).join('\n');
    const delims = [',', ';', '\t', '|'];
    let delim = ',', best = -1;
    for (const d of delims) {
      const n = sample.split('\n').map((l) => l.split(d).length - 1);
      const score = n.filter((x) => x > 0).length * 10 + Math.min(...n.filter((x) => x > 0).concat([0]));
      if (score > best) { best = score; delim = d; }
    }
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x));
  }

  const H = {
    date: /date|datum|posted|when/i,
    desc: /desc|narrat|detail|particular|memo|payee|reference|transaction|beskrywing|omschrijving|naam|name|merchant|text/i,
    amount: /^(amount|amt|value|bedrag|transaction amount|amount \(.*\)|bedrag \(.*\))$|amount/i,
    debit: /debit|withdraw|money out|paid out|out$|^out|spent|outflow|payments?$|uitgawe|af$/i,
    credit: /credit|deposit|money in|paid in|in$|^in|received|inflow|receipts?$|inkomste|bij$/i,
    balance: /balan|saldo/i
  };

  function csvToTxns(text, opts) {
    const rows = parseCSVRows(text);
    if (!rows.length) return [];
    // Find header row
    let hi = -1, map = null;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const r = rows[i].map((x) => x.toLowerCase());
      const m = { date: -1, desc: [], amount: -1, debit: -1, credit: -1, balance: -1 };
      r.forEach((h, j) => {
        if (!h || h.length > 40) return;
        if (H.balance.test(h)) { if (m.balance < 0) m.balance = j; return; }
        if (H.date.test(h) && !/time/i.test(h)) { if (m.date < 0) m.date = j; return; }
        if (/^(cr\/dr|dr\/cr|debit\/credit|credit\/debit|d\/c|c\/d)$/i.test(h)) { m.ind = j; return; }
        if (/^(type|transaction type|trn ?type|tran type)$/i.test(h)) { m.type = j; return; }
        if (/^(debit amount|debit|withdrawals?|money out|paid out|out|debits|uitgawes?|af)$/i.test(h) || (H.debit.test(h) && !H.credit.test(h) && !/amount$/.test(h))) { if (m.debit < 0) m.debit = j; return; }
        if (/^(credit amount|credit|deposits?|money in|paid in|in|credits|inkomste|bij)$/i.test(h) || (H.credit.test(h) && !H.debit.test(h) && !/amount$/.test(h))) { if (m.credit < 0) m.credit = j; return; }
        if (H.amount.test(h)) { if (m.amount < 0) m.amount = j; return; }
        if (H.desc.test(h)) { if (m.desc.length < 3) m.desc.push(j); }
      });
      if (m.date >= 0 && (m.amount >= 0 || m.debit >= 0 || m.credit >= 0)) { hi = i; map = m; break; }
    }
    const body = hi >= 0 ? rows.slice(hi + 1) : rows;
    if (!map) map = inferColumns(body);
    if (!map) throw new Error('Could not find date and amount columns in this CSV.');

    // Value-based CR/DR indicator column detection
    if (map.ind === undefined) {
      const ncol = Math.max(...body.slice(0, 50).map((r) => r.length));
      for (let j = 0; j < ncol; j++) {
        const vals = body.slice(0, 50).map((r) => (r[j] || '').toLowerCase()).filter(Boolean);
        if (vals.length > 2 && vals.every((v) => /^(cr|dr|c|d|credit|debit)$/.test(v))) { map.ind = j; break; }
      }
    }

    const dateToks = body.map((r) => matchDate(r[map.date] || ''));
    const order = detectDateOrder(dateToks, opts && opts.dateOrder);
    const list = [];
    let hasNeg = false;
    body.forEach((r, i) => {
      const dt = resolveDate(dateToks[i], order);
      if (!dt) return;
      let y = dt.y;
      if (y === undefined) y = opts && opts.fallbackYearFor ? opts.fallbackYearFor(dt.m, dt.d) : new Date().getFullYear();
      const desc = map.desc.length ? map.desc.map((j) => r[j]).filter(Boolean).join(' · ')
        : r.filter((x, j) => j !== map.date && j !== map.amount && j !== map.balance && !parseAmount(x) && !matchDate(x)).join(' ');
      let a = null, sign = 0;
      if (map.amount >= 0 && r[map.amount]) {
        a = parseAmount(r[map.amount]);
        if (a) sign = a.sign;
      }
      if (!a || a.abs === 0) {
        const d = map.debit >= 0 ? parseAmount(r[map.debit]) : null;
        const c = map.credit >= 0 ? parseAmount(r[map.credit]) : null;
        if (c && c.abs) { a = c; sign = 1; } else if (d && d.abs) { a = d; sign = -1; }
      }
      if (!a || !a.abs) return;
      if (map.ind !== undefined && r[map.ind]) sign = /^c/i.test(r[map.ind]) ? 1 : -1;
      if (sign < 0) hasNeg = true;
      const bal = map.balance >= 0 ? parseAmount(r[map.balance]) : null;
      const hint = map.type !== undefined && /^int/i.test(r[map.type] || '') ? 'interest' : undefined;
      list.push({ date: iso(y, dt.m, dt.d), desc, abs: a.abs, sign, balance: bal ? bal.value : undefined, hint });
    });
    // Single signed amount column: unsigned values are credits when negatives exist.
    if (map.amount >= 0 && map.debit < 0 && map.credit < 0 && map.ind === undefined && hasNeg) {
      list.forEach((t) => { if (t.sign === 0) t.sign = 1; });
    }
    resolveSignsByBalance(list, undefined);
    return finalize(list, null);
  }

  function inferColumns(body) {
    const sample = body.slice(0, 40);
    if (!sample.length) return null;
    const ncol = Math.max(...sample.map((r) => r.length));
    let date = -1, amounts = [], descCol = -1, descLen = 0;
    for (let j = 0; j < ncol; j++) {
      const vals = sample.map((r) => r[j] || '').filter(Boolean);
      if (!vals.length) continue;
      const dates = vals.filter((v) => matchDate(v)).length;
      const nums = vals.filter((v) => parseAmount(v)).length;
      if (date < 0 && dates / vals.length > 0.7) { date = j; continue; }
      if (nums / vals.length > 0.7) { amounts.push(j); continue; }
      const avg = vals.reduce((s, v) => s + v.length, 0) / vals.length;
      if (avg > descLen) { descLen = avg; descCol = j; }
    }
    if (date < 0 || !amounts.length) return null;
    return { date, desc: descCol >= 0 ? [descCol] : [], amount: amounts[0], debit: -1, credit: -1, balance: amounts.length > 1 ? amounts[amounts.length - 1] : -1 };
  }

  // ---------- OFX / QFX ----------
  function ofxToTxns(text) {
    const tag = (blk, name) => { const m = blk.match(new RegExp('<' + name + '>([^<\\r\\n]*)', 'i')); return m ? m[1].trim() : ''; };
    const blocks = text.split(/<STMTTRN>/i).slice(1);
    const list = [];
    for (const b of blocks) {
      const dt = tag(b, 'DTPOSTED') || tag(b, 'DTUSER');
      const m = dt.match(/^(\d{4})(\d{2})(\d{2})/);
      if (!m) continue;
      const amt = parseFloat(tag(b, 'TRNAMT').replace(',', '.'));
      if (!isFinite(amt) || amt === 0) continue;
      const type = tag(b, 'TRNTYPE').toUpperCase();
      const name = tag(b, 'NAME'), memo = tag(b, 'MEMO');
      const desc = [name, memo && memo !== name ? memo : ''].filter(Boolean).join(' · ') || type;
      list.push({ date: `${m[1]}-${m[2]}-${m[3]}`, desc, abs: Math.abs(amt), sign: amt < 0 ? -1 : 1, hint: type === 'INT' || type === 'DIV' && /interest/i.test(desc) ? 'interest' : undefined });
    }
    return finalize(list, null);
  }

  // ---------- QIF ----------
  function qifToTxns(text, opts) {
    const recs = text.split(/^\^\s*$/m);
    const raw = [];
    for (const r of recs) {
      const lines = r.split(/\r?\n/);
      let d = null, amt = null, p = '', memo = '';
      for (const l of lines) {
        const k = l[0], v = l.slice(1).trim();
        if (k === 'D') d = v.replace(/'/g, '/');
        else if (k === 'T' || k === 'U') amt = amt || parseAmount(v);
        else if (k === 'P') p = v;
        else if (k === 'M') memo = v;
      }
      if (d && amt) raw.push({ tok: matchDate(d), amt, desc: [p, memo].filter(Boolean).join(' · ') });
    }
    const order = detectDateOrder(raw.map((r) => r.tok), opts && opts.dateOrder || 'MDY');
    const list = [];
    for (const r of raw) {
      const dt = resolveDate(r.tok, order);
      if (!dt) continue;
      const y = dt.y !== undefined ? dt.y : (opts && opts.fallbackYearFor ? opts.fallbackYearFor(dt.m, dt.d) : new Date().getFullYear());
      list.push({ date: iso(y, dt.m, dt.d), desc: r.desc, abs: r.amt.abs, sign: r.amt.value < 0 ? -1 : 1 });
    }
    return finalize(list, null);
  }

  // ---------- PDF ----------
  const SKIP_RE = /closing\s+balance|balance\s+carried|carried\s+forward|\bc\/f\b|^total|\btotals?\b|sub-?total|page\s+\d+\s+of|statement\s+(?:date|period|no)|available\s+balance|afsluitingsaldo/i;
  const OPEN_RE = /opening\s+balance|balance\s+brought\s+forward|brought\s+forward|balance\s+b\/?f|\bb\/f\b|previous\s+balance|balance\s+forward|beginsaldo|openingsaldo|start\s+balance/i;

  const HEAD = {
    debit: /^(debits?|debit amount|withdrawals?|money out|paid out|out|payments?|charges|uitbetalings?|debiete?)(\s*\(.*\))?$/i,
    credit: /^(credits?|credit amount|deposits?|money in|paid in|in|receipts?|krediete?|inbetalings?)(\s*\(.*\))?$/i,
    balance: /^(balance|running balance|saldo|balans)(\s*\(.*\))?$/i,
    amount: /^(amount|transaction amount|bedrag)(\s*\(.*\))?$/i,
    date: /^(date|transaction date|posting date|datum|trans date|value date)$/i,
    desc: /^(description|details|transaction details|narrative|particulars|beskrywing|transaction)$/i,
    type: /^(type|trans(?:action)? type|code)$/i
  };

  async function pdfToLines(data, getPassword) {
    const lib = global.pdfjsLib;
    if (!lib) throw new Error('PDF engine failed to load.');
    const task = lib.getDocument({ data, isEvalSupported: false, useSystemFonts: true });
    task.onPassword = (update, reason) => {
      const pw = getPassword ? getPassword(reason === 2) : null;
      if (pw === null || pw === undefined) { task.destroy(); return; }
      update(pw);
    };
    const pdf = await task.promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      let items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({
        str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || it.height || 8
      }));
      // Some banks (e.g. Lloyds) embed invisible screen-reader text: zero-width "." after each
      // cell and hidden column labels like "Money In (£)" / "blank." above every value.
      // Drop (near) zero-width text whenever the page also has normal, visible text.
      // Visible text is several points wide per character; hidden text is ~0.
      const visible = (it) => it.w / Math.max(1, it.str.length) > 0.5;
      if (items.some(visible)) items = items.filter(visible);
      // group by y
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = [];
      for (const it of items) {
        const tol = Math.max(2, it.h * 0.4);
        let line = lines.find((l) => Math.abs(l.y - it.y) <= tol);
        if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
        line.items.push(it);
      }
      lines.sort((a, b) => b.y - a.y);
      for (const l of lines) {
        l.items.sort((a, b) => a.x - b.x);
        const cells = [];
        for (const it of l.items) {
          const cw = it.str.length ? it.w / it.str.length : it.h * 0.5;
          const last = cells[cells.length - 1];
          const gap = last ? it.x - last.x1 : Infinity;
          if (last && gap < Math.max(cw * 1.6, 2.5)) {
            last.text += (gap > cw * 0.2 && !/\s$/.test(last.text) && !/^\s/.test(it.str) ? ' ' : '') + it.str;
            last.x1 = it.x + it.w;
          } else cells.push({ text: it.str, x0: it.x, x1: it.x + it.w });
        }
        cells.forEach((c) => { c.text = c.text.replace(/\s+/g, ' ').trim(); });
        l.cells = cells.filter((c) => c.text);
        delete l.items;
      }
      pages.push(lines);
    }
    return pages;
  }

  /** Split a cell into leading date, description text and trailing amounts. */
  function tokenizeCell(cell) {
    const out = [];
    let text = cell.text;
    const width = Math.max(1, cell.x1 - cell.x0);
    const per = width / Math.max(1, text.length);
    if (AMT_FULL.test(text)) return [{ kind: 'amt', text, x0: cell.x0, x1: cell.x1 }];
    let start = 0;
    const dt = matchDate(text);
    if (dt && (text.length === dt.len || /\s/.test(text[dt.len]))) {
      out.push({ kind: 'date', tok: dt, text: text.slice(0, dt.len), x0: cell.x0, x1: cell.x0 + dt.len * per });
      start = dt.len;
    }
    let rest = text.slice(start);
    const tails = [];
    let m;
    while ((m = rest.match(AMT_TAIL))) {
      const s = rest.length - m[1].length;
      tails.unshift({ kind: 'amt', text: m[1], x0: cell.x0 + (start + s) * per, x1: cell.x0 + (start + rest.length) * per });
      rest = rest.slice(0, s).replace(/\s+$/, '');
    }
    if (rest.trim()) out.push({ kind: 'text', text: rest.trim(), x0: cell.x0 + start * per, x1: cell.x0 + (start + rest.length) * per });
    return out.concat(tails);
  }

  function linesToTxns(pages, opts) {
    // First pass: tokenise and collect dates for order + year inference
    const allTok = [];
    const full = [];
    let crCount = 0, drCount = 0, minusCount = 0;
    for (const lines of pages) for (const l of lines) {
      l.toks = [].concat(...l.cells.map(tokenizeCell));
      for (const t of l.toks) {
        if (t.kind === 'date') allTok.push(t.tok);
        if (t.kind === 'amt') {
          if (/\bcr\b/i.test(t.text)) crCount++;
          else if (/\bdr\b/i.test(t.text)) drCount++;
          else if (/-|\(/.test(t.text)) minusCount++;
        }
      }
      // full dates anywhere in the line text (e.g. "Statement period 1 March 2025 to 31 March 2025")
      const joined = l.cells.map((c) => c.text).join(' ');
      const re = new RegExp('(\\d{1,2}(?:st|nd|rd|th)?[\\s\\-/.]*' + MON_RE + '[\\s\\-/.,]+\\d{4}|\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4})', 'ig');
      let mm;
      while ((mm = re.exec(joined))) { const t = matchDate(mm[1]); if (t) full.push(t); }
    }
    const order = detectDateOrder(allTok.concat(full), opts && opts.dateOrder);
    const fullResolved = full.map((t) => resolveDate(t, order)).filter((d) => d && d.y);
    const yearFor = makeYearResolver(fullResolved, opts && opts.fallbackYearFor);

    const list = [];
    let cols = null; // header columns {debit:xc, credit:xc, balance:xc, amount:xc}
    let opening;
    let lastDate = null;
    let lastTxn = null;
    let contCount = 0;
    for (const lines of pages) {
      for (const l of lines) {
        // header detection
        const hdr = {};
        let hits = 0;
        for (const c of l.cells) {
          for (const k of Object.keys(HEAD)) {
            if (HEAD[k].test(c.text)) { hdr[k] = (c.x0 + c.x1) / 2; hdr[k + 'R'] = c.x1; hits++; break; }
          }
        }
        if (hits >= 2 && (hdr.debit !== undefined || hdr.credit !== undefined || hdr.balance !== undefined || hdr.amount !== undefined)) {
          cols = hdr; lastTxn = null; continue;
        }
        const toks = l.toks;
        const dateTok = toks.find((t) => t.kind === 'date' && toks.indexOf(t) <= 1);
        const amts = toks.filter((t) => t.kind === 'amt').map((t) => Object.assign({}, t, parseAmount(t.text, true))).filter((a) => a.abs !== undefined);
        // A separate "Type" column (e.g. Lloyds: DEB, TFR, FPO, INT) is not part of the description.
        const isTypeCell = (t) => cols && cols.type !== undefined && t.kind === 'text' && t.text.length <= 6 &&
          Math.abs(t.x0 - (cols.type - (cols.typeR - cols.type))) < 12;
        const typeTok = toks.find(isTypeCell);
        const text = toks.filter((t) => t.kind === 'text' && !isTypeCell(t)).map((t) => t.text).join(' ');
        const joined = l.cells.map((c) => c.text).join(' ');

        if (OPEN_RE.test(joined)) {
          if (amts.length) opening = amts[amts.length - 1].value;
          if (opening !== undefined && !list.length) list.openingBalance = opening;
          lastTxn = null; continue;
        }
        if (SKIP_RE.test(joined)) { lastTxn = null; continue; }

        let date = null;
        if (dateTok) {
          const d = resolveDate(dateTok.tok, order);
          if (d) { date = iso(d.y !== undefined ? d.y : yearFor(d.m, d.d), d.m, d.d); lastDate = date; }
        }
        if (!amts.length) {
          // continuation of previous description
          if (lastTxn && !date && text && contCount < 2 && text.length < 80) { lastTxn.desc += ' ' + text; contCount++; }
          else if (!date) lastTxn = null;
          continue;
        }
        if (!date && !(lastDate && text && lastTxn)) continue; // amounts without context
        if (!date) date = lastDate;

        // Pick transaction amount + balance
        let bal = null, txAmts = amts.slice();
        if (cols && cols.balance !== undefined) {
          const near = (a, k) => Math.min(Math.abs((a.x0 + a.x1) / 2 - cols[k]), Math.abs(a.x1 - cols[k + 'R']));
          const bi = txAmts.findIndex((a) => near(a, 'balance') < 25 && txAmts.every((b) => near(b, 'balance') >= near(a, 'balance')));
          if (bi >= 0 && (txAmts.length > 1 || near(txAmts[bi], 'balance') < 10)) bal = txAmts.splice(bi, 1)[0];
        } else if (txAmts.length >= 2) {
          bal = txAmts.pop();
        }
        if (!txAmts.length) continue;
        const a = txAmts.find((x) => x.abs > 0) || txAmts[0];
        if (!a.abs) continue;
        let sign = a.sign || 0;
        if (!sign && cols && (cols.debit !== undefined || cols.credit !== undefined)) {
          const xc = (a.x0 + a.x1) / 2;
          const dd = cols.debit !== undefined ? Math.min(Math.abs(xc - cols.debit), Math.abs(a.x1 - cols.debitR)) : Infinity;
          const dc = cols.credit !== undefined ? Math.min(Math.abs(xc - cols.credit), Math.abs(a.x1 - cols.creditR)) : Infinity;
          if (dd !== dc) a.colSign = dd < dc ? -1 : 1;
        }
        const t = { date, desc: text, abs: a.abs, sign, colSign: a.colSign, balance: bal ? bal.value : undefined };
        if (typeTok && /^int/i.test(typeTok.text)) t.hint = 'interest';
        list.push(t);
        lastTxn = t; contCount = 0;
      }
    }
    // Balance first (most reliable), then column position, then conventions.
    resolveSignsByBalance(list, list.openingBalance);
    list.forEach((t) => { if (!t.sign && t.colSign) t.sign = t.colSign; });
    const conv = { crOnly: crCount > 0 && drCount === 0 && crCount < 1e9, minusOnly: minusCount > 0 && crCount === 0 && drCount === 0 };
    // Cr-only convention only makes sense if balance cells aren't the only Cr items; keep it as a fallback.
    return finalize(list, conv);
  }

  async function pdfToTxns(data, opts) {
    const pages = await pdfToLines(data, opts && opts.getPassword);
    const textCount = pages.reduce((s, p) => s + p.length, 0);
    if (!textCount) throw new Error('This PDF has no readable text (it may be a scanned image). Please download a CSV or OFX export from your bank instead.');
    return linesToTxns(pages, opts);
  }

  // ---------- Entry point ----------
  async function parseFile(file, opts) {
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.pdf') || file.type === 'application/pdf') {
      const buf = new Uint8Array(await file.arrayBuffer());
      return pdfToTxns(buf, opts);
    }
    const text = await file.text();
    if (/<OFX>|OFXHEADER|<STMTTRN>/i.test(text)) return ofxToTxns(text);
    if (/^!Type:/im.test(text)) return qifToTxns(text, opts);
    return csvToTxns(text, opts);
  }

  global.StatementParser = {
    parseFile, csvToTxns, ofxToTxns, qifToTxns, linesToTxns, classify, CATS,
    _internal: { parseAmount, matchDate, tokenizeCell, parseCSVRows }
  };
})(typeof window !== 'undefined' ? window : globalThis);
