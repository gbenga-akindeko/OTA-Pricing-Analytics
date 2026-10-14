# Finchglow Holdings Finance One-Stop Portal

A web portal for the Group Finance team. The CFO or Financial Controller publishes the rate of exchange (ROE), and the portal emails it straight away to the head of finance at every subsidiary. Everyone with access sees the current rates, how they have moved, and the full history. Every sign in and every change is recorded.

It runs on Google Apps Script with your Google Sheet as the database, so there is no server to host or pay for.

## What is in version 1

**Exchange rates**
- **Dashboard.** Current ROE for USD, POUNDS and EURO by category, the change against the previous rate, a 30 day movement chart and the most recent broadcasts. One click copies the rates in the exact WhatsApp layout you use today.
- **Rate fluctuations.** Pick 7 days, 30 days, 90 days, 6 months or 1 year. For each currency and category you get the start rate, current rate, change, high, low, how many times it moved, the biggest single move and how far the ROE sits above the book rate. There is a daily chart and a CSV export.
- **Publish ROE** (CFO and Financial Controller only). The form starts with today's rates so you only change what moved. Clear a box to leave a category out (for example Corporate - Link). You see a live preview of the broadcast before sending. If a rate jumps by more than 10% the portal asks you to confirm, which catches typos like 14,000 instead of 1,400.
- **ROE history.** Every broadcast with the change on each line. You can resend an email, void a mistake (the record stays for audit) or export to CSV.
- **Book rates.** The Rate Log from your workbook. New entries can use the same OANDA cross-rate maths as the "currency conv" tab: `ROUNDDOWN(USD / cross, 2)`.

**Emails**
- Each active subsidiary gets its own email addressed to its head of finance, with that subsidiary's CC list.
- An optional internal copy list (CFO, treasury) gets one copy of every broadcast.
- Each email is logged as sent or failed. A failed address does not stop the rest.

**Access control and audit**
- Only people listed in Users can sign in. They enter their work email and get a 6 digit code by email that lasts 10 minutes. Five wrong codes locks that code.
- Three roles: **Administrator (CFO)** can do everything, **Rate Setter (Financial Controller)** publishes rates, **Viewer** (heads of finance and others) can see rates and history.
- Turning a user off ends their session immediately.
- **Audit log** (administrators). Sign ins, failed codes, lockouts, blocked actions, sign outs, every rate published (old rate to new rate), voids, user and subsidiary changes, settings changes and every email sent. You can filter by Access, Changes or Email, search, pick dates and export to CSV. There is also an email delivery log.

**Coming soon** (already in the menu): BSP tracking, Receivables, Credit control and Invoices.

## How the Google Sheet is laid out

`setup` creates these tabs if they are missing and never deletes anything. Do not rename the tabs or the header row.

| Tab | What it holds |
| --- | --- |
| Settings | Company name, logo link, broadcast note, email options |
| Users | Who can sign in, their role and whether they are active |
| Subsidiaries | Each group company, its type, head of finance email and CC list |
| Rate Categories | The lines on each broadcast (USD Agent / Direct, and so on) and their order |
| ROE Publications | One row per broadcast |
| ROE Log | One row per rate line, easy to pivot or chart in Sheets |
| Rate Log | Book rates (same columns as your Exchange Rate Log workbook) |
| Email Log | Every email sent and whether it went through |
| Audit Log | Every sign in, change and email, with a category column |

Setup also adds the group companies from the onboarding guide: the 6 subsidiaries (Finchglow Travels, FCM Travel Solutions, Finchglow Holidays, Travelden, Lagos Aviation Academy, Finchglobal) and the 2 affiliates (Finchair, Prysm Investment). They have no emails yet. A company starts receiving ROE emails as soon as its head of finance email is filled in. The affiliates start paused; switch them on if they should get the ROE too.

If the sheet has no Rate Log yet, setup fills it with the four dated rows from *Exchange Rate Log - 2026.xlsx*. If you already have a Rate Log tab with the same headers, it is used as it is. Rows without a date (like C/F RATE) are skipped.

## Set it up (about 15 minutes)

Use a Google account that belongs to Finance, such as a shared finance mailbox, because emails go out from the account that deploys the portal.

1. Open the database sheet: <https://docs.google.com/spreadsheets/d/1xu7O0dDZmUKZ6Kd7HcswG-QQw4ybACEJOixoGGPcw7w/edit>
2. Go to **Extensions > Apps Script**.
3. In the editor, open **Project Settings** (gear icon) and tick **Show "appsscript.json" manifest file in editor**.
4. Copy each file from the `apps-script` folder of this repo into the editor with the same name:
   - Script files: `Code`, `Config`, `Db`, `Auth`, `Rates`, `Analytics`, `Email`, `Admin`, `Setup` (paste the `.js` content into a script file of that name)
   - HTML files: `Index`, `Styles`, `Client`, `Logo`
   - Replace the contents of `appsscript.json` with the one in this repo.
5. Choose the `setup` function in the toolbar and click **Run**. Approve the permissions when Google asks. You are now the first administrator.
6. Click **Deploy > New deployment**, choose **Web app**, and set:
   - Execute as: **Me**
   - Who has access: **Anyone with Google account**, or **Anyone within [your domain]** if all finance staff use Finchglow Google Workspace accounts.
7. Copy the web app link. That is the portal. Share it with your team.
8. Sign in, then go to **Subsidiaries** and fill in the head of finance email for each company, and **Users & access** to add the Financial Controller and anyone else who needs to sign in.

When you change the code later, use **Deploy > Manage deployments > Edit > New version** so the link stays the same.

**Prefer the command line?** Install [clasp](https://github.com/google/clasp), run `clasp login`, then `clasp clone <scriptId> --rootDir apps-script` once (the script ID is in Project Settings). After that, `npm run push` uploads the code.

### The Finchglow logo

The portal and the emails load the Holdings logo from Google Drive (file `15fH9N_jBGV4J219XrEMcwEKCjFYpdlzy`). For this to work the file must be shared as **Anyone with the link can view**, because email apps and staff outside your Google account fetch it without signing in.

- To use a different logo, paste its Drive share link (or any https image link) into **Settings > Logo link**. Drive links are converted to a direct image link automatically.
- If the logo cannot load, the portal shows a "Finchglow HOLDINGS" text mark in the brand colours instead, so the page never shows a broken image.
- To build the logo into the portal itself instead, save it as `assets/finchglow-logo.png`, run `npm run embed-logo` and copy the new `apps-script/Logo.html` into the editor. Emails still use the Settings link.

### Email limits

Google limits how many people the portal can email per day: about 100 recipients on a personal Gmail account and 1,500 on Google Workspace. Each head of finance, each CC and each sign in code counts as one. The Settings page shows how many are left today. With a handful of subsidiaries and a few broadcasts a day, Workspace is plenty.

## Run it on your computer

You need Node.js 18 or newer.

```bash
npm install
npm test        # 22 tests covering sign in, roles, publishing, emails, voids, analytics and the audit log
npm run dev     # preview at http://localhost:8080 with demo data
```

In the preview, sign in as `cfo@finchglow.com`. The sign in code is printed in the terminal instead of being emailed. The preview runs the real portal code against an in-memory copy of the sheet (see `dev/gas-runtime.mjs`), so what you see is what Apps Script will do. The demo subsidiaries and people are placeholders.

## Project layout

```
apps-script/      Everything that goes into Apps Script
  Code.js         Web app entry point and the list of actions each role may call
  Auth.js         Email code sign in, sessions and role checks
  Rates.js        Publishing, history, voids and book rates
  Analytics.js    Fluctuation figures for the dashboards
  Email.js        ROE emails, sign in codes, test emails
  Admin.js        Users, subsidiaries, categories, settings, audit and email logs
  Setup.js        First time setup
  Config.js       Tab layout, roles, default settings and categories
  Db.js           Reading and writing the sheet
  Index.html, Styles.html, Client.html, Logo.html   The portal itself
dev/              Local preview server, Apps Script simulator and demo data
test/             Automated tests
assets/           Put the logo here before running npm run embed-logo
```

## Security notes

- Two locks on the door: Google sign in (set by the deployment) and the portal's own allowlist with an emailed code.
- Session tokens are random, kept only in the browser tab, and expire after 4 hours idle or 12 hours in total.
- Each request checks the Users tab again, so role changes and removals apply at once.
- Text typed into the portal that starts with `=`, `+`, `-` or `@` is saved as plain text so it cannot run as a formula in the sheet.
- Give edit access on the Google Sheet only to people who should be able to change the data directly. The portal's access control does not stop anyone who can edit the sheet itself.
