# Tax Statements: an iPhone app for your tax-year bank statements

Add your 12 monthly bank statements and the app shows you, for the tax year:

- **Money received**: everything that came into the account
- **Money spent**: everything that went out
- **Interest earned**: interest the bank credited to you
- **Interest paid out**: earned interest that was transferred out of the account (for example to a linked account)
- **Interest charged**: interest you paid the bank (overdraft, loan)

Interest is kept separate. It is **not** counted in "Money received" or "Money spent".

## Features

- Reads **PDF**, **CSV**, **OFX/QFX** and **QIF** statements. You can pick all 12 at once.
- Supports password-protected PDFs. It asks for the password, which is often your ID or account number.
- A 12-month grid shows which months of the tax year are covered and which are missing.
- Removes duplicate transactions when statements overlap.
- Monthly breakdown table and CSV export (summary and full transaction list) through the iPhone share sheet.
- Tap any transaction to change its category, or mark it *Excluded* (for example a transfer between your own accounts).
- Transactions the app could not read with certainty are flagged **Needs review**.
- Tax-year presets: South Africa (1 Mar), UK (6 Apr), NZ/India (1 Apr), Australia (1 Jul), calendar year, or a custom start date.
- **Private.** Everything runs on the phone. Statements are never uploaded. Data is stored only in the app on your device.
- Works offline once installed.

## Install on your iPhone 12

The app is a Progressive Web App. You install it from Safari, and you don't need the App Store or a Mac.

1. **Publish it once with GitHub Pages:** go to the repository on GitHub, then **Settings → Pages**.
   Set *Source* to **Deploy from a branch**, choose the branch (`main` after merging, or
   `claude/elegant-bohr-fpaiz5`) and the folder **`/docs`**, then **Save**.
   After a minute your app is live at `https://<your-username>.github.io/<repo-name>/`.
   (GitHub Pages on a private repository needs a paid GitHub plan. You can also make the repo public:
   the app code contains no personal data.)
2. On the iPhone, open that address in **Safari**.
3. Tap **Share** (the square with an arrow), then **Add to Home Screen**, then **Add**.
4. Open **Tax Statements** from your Home Screen.

## Using it

1. Download your statements from your banking app or website and save them to the **Files** app (iCloud Drive or On My iPhone).
2. In the app, tap **Add bank statements** and select all 12 files.
3. Check the month grid on the **Statements** tab. All 12 months should be ticked.
4. Open **Summary** to see the totals. Tap an interest line to see the transactions behind it.
5. If there's a **Needs review** banner, tap it and confirm each flagged transaction.
6. Use **Export summary (CSV)** to save or e-mail the results.

**Tip:** if your bank offers a CSV or OFX download, use it. It is more exact than a PDF.
Scanned (image-only) PDFs can't be read.

## How it decides "in" vs "out"

Banks lay out statements differently, so for each transaction the app uses the first rule that applies:

1. An explicit sign on the amount: `-`, `( )`, `Dr`, `Cr`.
2. The running balance. If the balance went **up** by the amount, the money came in.
   *Example:* previous balance 4,549.80, this line 25,000.00, new balance 29,549.80. The difference is +25,000.00, so it is **money received**.
3. Which column the amount sits under (*Debit/Credit*, *Money in/out*, *Withdrawals/Deposits*).
4. The statement's own convention. For example, on statements where only credits carry "Cr", amounts without "Cr" are debits.
5. Words in the description (salary, deposit, refund…). Transactions decided this way are flagged for review.

Interest is detected from words like *interest*, *int pd*, *credit interest* and *rente* (Afrikaans/Dutch).
- Interest coming **in** is classed as **interest earned**.
- Interest going **out** that mentions a payout or transfer is classed as **interest paid out**.
- Any other interest going **out** (overdraft, loan, debit interest) is classed as **interest charged**.

## Project layout

```
docs/                 the app (served by GitHub Pages)
  index.html          screens
  styles.css          iOS-style look, light & dark mode
  app.js              state, tax-year logic, totals, export
  parsers.js          CSV / OFX / QIF / PDF parsing + classification
  sw.js               offline cache
  manifest.webmanifest, icons/
  vendor/             pdf.js 3.11 (Apache-2.0) for reading PDFs
```

The totals help you prepare your tax return. Always check them against your statements and your bank's official
interest certificate (for example IT3(b) in South Africa).
