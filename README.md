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
- **Users & access** works as a tick box grid, one row per person, with Save and Remove on each row, a search box and an "only people with special access" filter. Everyone on the list can view rates, history, fluctuations and book rates. On top of that, each person can have:
  - **Set rate:** publish the ROE, resend or void broadcasts, add book rates
  - **Subsidiaries:** manage subsidiaries, heads of finance, CC lists and test emails
  - **Audit log:** see the audit and email delivery logs
  - **Settings:** change portal settings and rate categories
  - **Admin:** everything above, plus this page
  - **Blocked:** cannot open the portal at all
- The first person to run setup is the **main admin**. Their access is always full and cannot be changed or removed. Nobody can remove their own admin access.
- Changing someone's boxes applies on their next click. Blocking someone ends their session straight away.
- **Audit log** (administrators). Sign ins, failed codes, lockouts, blocked actions, sign outs, every rate published (old rate to new rate), voids, user and subsidiary changes, settings changes and every email sent. You can filter by Access, Changes or Email, search, pick dates and export to CSV. There is also an email delivery log.

**Light and dark mode.** A round button in the bottom left corner switches between light and dark. It follows the device setting until someone picks one, then remembers their choice on that browser.

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

## Set it up (about 10 minutes)

The portal lives in this Apps Script project: <https://script.google.com/home/projects/1Zanme9AFOGdbMCi7STTHqs9DqqTWbm67I3GjSadMoEAQhmAz3Ty6tuf3/edit>

It reads and writes the database sheet ("DATABASE SHEET FOR EXCHANGE RATE WEB PORTAL", ID `1xu7O0dDZmUKZ6Kd7HcswG-QQw4ybACEJOixoGGPcw7w`) whether or not the project is attached to it. To point it at another sheet, add a script property called `SPREADSHEET_ID` in Project Settings.

Emails go out from the account that deploys the portal, so deploy from a Finance account (ideally a shared finance mailbox) that can edit the database sheet.

### Step 1. Put the code in the project

**Option A: paste 3 files (no installs).** The `dist` folder holds the whole portal in three files.

1. Open the project link above. In **Project Settings** (gear icon), tick **Show "appsscript.json" manifest file in editor**.
2. Back in the editor, open `appsscript.json` and replace everything in it with [`dist/appsscript.json`](dist/appsscript.json).
3. Open `Code.gs` and replace everything in it with [`dist/Code.gs`](dist/Code.gs).
4. Click **+ > HTML**, name it `Index` (no extension), and replace its contents with [`dist/Index.html`](dist/Index.html).
5. Make sure those are the only three files. Delete anything else, or Apps Script will complain that things are declared twice.
6. Press **Ctrl + S** to save.

**Option B: push with clasp (for developers).** This repo already has `.clasp.json` pointing at the project.

```bash
npm install -g @google/clasp
clasp login                 # opens Google sign in in your browser
npm run push                # uploads everything in apps-script/
```

The first time, turn on the Apps Script API at <https://script.google.com/home/usersettings>, or the push is refused.

### Step 2. Run setup once

In the editor, pick `setup` in the function list at the top and click **Run**. Google asks you to approve the portal's permissions (edit the database sheet, send email as you, show a menu in the sheet). Approve them. Setup creates the tabs, loads the rate categories, the 8 group companies and the book rates, and makes you the first administrator.

### Step 3. Deploy

1. Click **Deploy > New deployment**. Next to "Select type", click the gear and choose **Web app**.
2. Description: `Finance Portal`. Execute as: **Me**. Who has access: **Anyone with Google account** (or **Anyone within finchglow.com** if every finance user signs in with a Finchglow Google Workspace account).
3. Click **Deploy** and copy the **Web app URL**. That is the portal link to share.

With clasp you can do steps 1 to 3 of this section with `npm run deploy` instead, after running setup once in the editor.

### Step 4. First sign in

Open the portal link, enter your email and type the code you receive. Then go to **Subsidiaries** and add each head of finance email, and to **Users & access** to add the Financial Controller and anyone else who should sign in.

### Updating later

After changing the code, paste the new `dist` files (run `npm run bundle` first if you edited `apps-script/`) or run `npm run push`. Then use **Deploy > Manage deployments**, click the pencil on the existing deployment, set Version to **New version** and click **Deploy**. The portal link stays the same.

### The Finchglow logo

The Holdings logo is built into the portal (`apps-script/Logo.html`, made from `assets/finchglow-logo.png`), so it always shows, with nothing to host.

Emails cannot carry a built-in image, so they load the logo from Google Drive (file `15fH9N_jBGV4J219XrEMcwEKCjFYpdlzy`). Keep that file shared as **Anyone with the link can view**, or the logo will be missing from emails.

- To change the logo, replace `assets/finchglow-logo.png`, run `npm run embed-logo`, copy the new `Logo.html` into the editor, and paste the new image's Drive share link into **Settings > Logo link** for the emails. Drive links are converted to a direct image link automatically.
- If an image cannot load, the portal falls back to the built-in logo, then to a "Finchglow HOLDINGS" text mark, so it never shows a broken image.

### Email limits

Google limits how many people the portal can email per day: about 100 recipients on a personal Gmail account and 1,500 on Google Workspace. Each head of finance, each CC and each sign in code counts as one. The Settings page shows how many are left today. With a handful of subsidiaries and a few broadcasts a day, Workspace is plenty.

## Run it on your computer

You need Node.js 18 or newer.

```bash
npm install
npm test        # 28 tests covering sign in, roles, publishing, emails, voids, analytics, the audit log and the bundle
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
dist/             The same portal as 3 paste-ready files (built by npm run bundle)
dev/              Local preview server, Apps Script simulator, bundler and demo data
test/             Automated tests
assets/           Put the logo here before running npm run embed-logo
```

## Security notes

- Two locks on the door: Google sign in (set by the deployment) and the portal's own allowlist with an emailed code.
- Session tokens are random, kept only in the browser tab, and expire after 4 hours idle or 12 hours in total.
- Each request checks the Users tab again, so role changes and removals apply at once.
- Text typed into the portal that starts with `=`, `+`, `-` or `@` is saved as plain text so it cannot run as a formula in the sheet.
- Give edit access on the Google Sheet only to people who should be able to change the data directly. The portal's access control does not stop anyone who can edit the sheet itself.
