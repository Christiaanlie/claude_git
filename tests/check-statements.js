#!/usr/bin/env node
/*
 * Regression test for the statement parser.
 *
 * Put real PDF statements in tests/private/ (git-ignored, never committed) and run:
 *   node tests/check-statements.js [path/to/pdfjs-dist]
 *
 * For each PDF it compares the parsed money in / money out with the totals the
 * bank prints on page 1 (Lloyds: "Money In £x" / "Money Out £y"), and checks that
 * no transaction was left uncertain and that the Type column (DEB, TFR, ...)
 * is not stuck onto descriptions. Exits non-zero on any failure.
 *
 * pdfjs-dist: uses ./node_modules/pdfjs-dist if present, otherwise pass its path
 * (npm pack pdfjs-dist@3.11.174 && tar xzf pdfjs-dist-3.11.174.tgz -> ./package).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pdfjsDir = process.argv[2] || path.join(root, 'node_modules', 'pdfjs-dist');
global.window = global;
const lib = require(path.join(pdfjsDir, 'legacy', 'build', 'pdf.js'));
global.pdfjsLib = lib;
require(path.join(root, 'docs', 'parsers.js'));

const dir = path.join(__dirname, 'private');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f)).sort() : [];
if (!files.length) { console.log('No PDFs in tests/private/. Nothing to check.'); process.exit(0); }

const money = (s) => parseFloat(s.replace(/[£$€,\s]/g, ''));
const TYPE_LEAK = / (DEB|TFR|FPO|FPI|DD|SO|BGC|CHG|CPT|BP)$/;

(async () => {
  let failed = 0;
  for (const name of files) {
    const data = fs.readFileSync(path.join(dir, name));
    const pdf = await lib.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
    const page1 = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
    const bankIn = page1.match(/Money In\s*\.?\s*(£[\d,]+\.\d\d)/);
    const bankOut = page1.match(/Money Out\s*\.?\s*(£[\d,]+\.\d\d)/);

    const file = { name, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length) };
    const list = await StatementParser.parseFile(file, {});
    const inn = list.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const out = list.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
    const problems = [];
    if (!list.length) problems.push('no transactions found');
    if (!bankIn || !bankOut) problems.push('bank totals not found on page 1 (cannot verify)');
    else {
      if (Math.abs(inn - money(bankIn[1])) > 0.005) problems.push(`money in ${inn.toFixed(2)} != bank ${bankIn[1]}`);
      if (Math.abs(out - money(bankOut[1])) > 0.005) problems.push(`money out ${out.toFixed(2)} != bank ${bankOut[1]}`);
    }
    const unc = list.filter((t) => t.uncertain);
    if (unc.length) problems.push(`${unc.length} uncertain transaction(s)`);
    const leaks = list.filter((t) => TYPE_LEAK.test(t.desc));
    if (leaks.length) problems.push(`type code in description: ${leaks.map((t) => t.desc).join(', ')}`);

    const dates = list.map((t) => t.date).sort();
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name}: ${list.length} txns, ${dates[0]}..${dates[dates.length - 1]}, in ${inn.toFixed(2)}, out ${out.toFixed(2)}`);
    problems.forEach((p) => console.log('       - ' + p));
    if (problems.length) failed++;
  }
  console.log(failed ? `\n${failed} of ${files.length} statement(s) failed.` : `\nAll ${files.length} statement(s) match the bank's totals.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
