# Altar Servers — Attendance Monitoring System

Attendance tracking and Mass-schedule rotation for the Acolytes Ministry (Knights of the Altar), with QR check-in.

Two parts, one server:

| | Who | Address | Sample account |
|---|---|---|---|
| **Admin website** | Admin / secretary | `http://localhost:3000` (or your Render link) | `altarservers` / `altarservers123` |
| **Mobile app** | Mass leader (user) | the same address + `/app` | `1stmass` / `1stmass123` (Agusan, First Mass) |

> **Change both sample passwords** after the first login (Settings → accounts).

## Start

Requires Node.js 18 or newer (20.12+ to read the `.env` file automatically).

```
npm install     (first time only)
npm start
```

The terminal prints the "same Wi-Fi" address for the leader app. If Windows asks whether to allow Node.js on the network, choose **Allow** (Private networks).

### Connect to Supabase (database)

1. In Supabase, open **SQL Editor**, paste `supabase/schema.sql` and run it once. It creates the `app_state` table with row-level security on and no public access.
2. Copy `.env.example` to `.env` and fill in `SUPABASE_SERVICE_ROLE_KEY` (Dashboard → Project Settings → API Keys → `service_role`).
3. Run `npm start`. The terminal shows `Supabase sync: https://…supabase.co`.

`.env` holds a secret key. It is listed in `.gitignore`: never commit it, never put it in `.env.example`, and never use it in the website's code. Without a `.env`, the app still works using only the local data file.

## Admin website

1. **Dashboard** — active / inactive servers, Present / Absent / Excused for the month and for each of the last 6 months, a per-parish breakdown, to-dos (approvals waiting, parishes due for a reshuffle, Masses without a leader account) and notifications.
2. **Roster** — **Add server**: complete name, parish/chapel (Agusan, Tablon, Puerto), role (Elders, Seniors, Juniors). Status is automatic:
   **3 absences in a row → Inactive**, **scanned present again → Active**. Every server has a personal **QR card** (the **QR** button for one card, **Print QR cards** for everyone in the current filter).
   **Import from CSV** adds many servers at once. Columns: `Name`, `Parish` (or `Chapel`), `Role`, and optional `Mass` and `Contact` (use **⬇ Template** for a sample).
   With a `Mass` column (e.g. `1st Mass`, `2`, `8:00 AM`, `Sunday 4:00 PM`), each server is also placed on that Mass's team in their chapel's schedule, starting today.
   Names already in the roster are matched instead of duplicated, and chapels or Masses that don't exist yet are created. Everything is saved to the database (Supabase) like any other change.
3. **Schedule** — each Mass has a team. **Shuffle** each parish separately after the 2nd meeting of the month. The shuffle spreads Elders, Seniors and Juniors evenly and moves people off their previous team.
   You can also move people between teams by hand. Share the schedule with **Save image for Messenger**, **Copy as text**, **Print**, or **Print team QR cards**.
4. **Attendance** — see and change any mark (P / A / E) per parish and date.
   **🗂 Archive / remove logs** opens a panel to clean up old logs (a log is one Mass on one date: its marks and the leader's report). Pick a parish (or all) and a date range, or press **This day**, then:
   **Archive** moves the logs out of Attendance, the Dashboard and Monthly Reports but keeps them, so they can be **downloaded as CSV** or **restored** later; **Delete permanently** erases them (asks twice).
   Archived logs are included in **Settings → Export backup**.
5. **Approvals** — servers who served at a Mass they're not assigned to, with the leader's reason. They count as Present only after approval.
6. **Monthly Reports** — per parish: active and inactive servers with name, parish/chapel, role, and totals of Present / Absent / Excuses. Sort by "Most present" when choosing servers for big occasions. Print or CSV.
7. **Settings** — parishes and Mass times, leader accounts (one per Mass), rules, time zone, admin accounts, backup.

## Mobile app (Mass leader)

1. Log in (Altar Server logo screen). The app shows the leader's Mass and date.
2. **Scan QR card**: shows the server's name, parish and role, and marks them **Present**.
   - Not on this Mass's team → the leader must write a **reason**, and the record stays **pending** until an admin/secretary approves it.
3. **Excuse**: record excuses made *before the day* (pick a future date) or *on the day*.
4. **Submit report**: sends everything to the admin/secretary at once and notifies them. Team members who weren't scanned or excused are marked **Absent**. After that, only admins can change the report.
5. "Choose from list" (multiple choice) is **off** by default so servers must bring their QR card. It can be turned on in Settings → Rules.

**Camera note:** browsers only allow the in-app camera on `https://` or `localhost`. On plain church Wi-Fi (`http://192.168…`), the leader can instead scan the card with the phone's own **Camera app** and tap the link. It opens the leader app and records the server. A leader can also type the code printed under the QR.
Hosting the system on `https://` makes the in-app scanner work.

## Data

- **Supabase** is the main database. The whole ministry database is kept as one JSON row in the `app_state` table. At startup the server loads it from Supabase, and every change is saved back within a second. If Supabase can't be reached, the app keeps working and retries.
- **`data/db.json`** is a local copy, written instantly on every change. It is the only storage when Supabase isn't set up.
- Use **Settings → Export backup** regularly for an extra copy.
- Run **only one server at a time** against the same Supabase project (for example, your Render site *or* your computer, not both). Two servers overwrite each other's changes.

## Putting it online (Render)

The repository includes `render.yaml`, so Render fills in the settings for you:

1. At https://dashboard.render.com, sign in with GitHub and choose **New + → Blueprint**, then select this repository.
2. When asked, enter `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (the same values as in `.env`). Click **Apply**.
3. When the service shows **Live**, open its link: admin website at the link, leader app at the link + `/app`. It works from anywhere, on Wi-Fi or mobile data, and the in-app camera scanner works because the link is `https://`.
4. In the admin website, set **Settings → Link used in QR codes** to the Render link, then re-print the QR cards.

Every push to the `main` branch redeploys automatically. The free plan sleeps after about 15 minutes without visitors, so the first visit afterwards takes 30–60 seconds; data is safe because it lives in Supabase.

Other options: any Node.js host, or a parish computer with Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`). Without Supabase, the host needs a persistent disk; set `DATA_DIR` to it.

## Testing

```
npm test
```

Runs 74 tests with Node's built-in test runner (no extra packages):

- **Unit tests** (`test/unit.test.js`): the admin website's logic without a browser or server: CSV reading and writing, the Mass column, the CSV import with Mass teams, the team shuffle, monthly counts, and date/time helpers.
- **Smoke tests** (`test/smoke.test.js`): start a real copy of the server and go through the main flows over HTTP: pages and logo, admin and leader logins, saving servers and teams, QR scanning, excuses, submitting a report, approvals, the 3-absences rule, QR card links and logout.

The smoke tests run the server from a temporary folder with its own empty data file and Supabase sync **off**, so they never touch the real database.

## Logo and theming

- **Logo:** the Knights of the Altar crest. The source picture is `Logo/Logo.jpg`. The app uses `public/logo.png` (transparent background), `public/logo-icon.png` (home-screen icon) and `public/apple-touch-icon.png` (iPhone icon). To change the logo, replace those three files with square PNGs of the same names.
- **Theme (tweakcn):** the whole look (colors, font, corner radius, shadows, dark mode) comes from `public/theme.css`, which uses the same variables as shadcn/ui. To restyle the app, design a theme at https://tweakcn.com/editor/theme, click **Code**, copy the `:root { ... }` and `.dark { ... }` blocks into `public/theme.css`, and refresh the page. No restart is needed.

## Project files

| Path | What it is |
|---|---|
| `server.js` | The server: logins, API, attendance rules, QR codes, Supabase sync |
| `public/index.html`, `public/app.js`, `public/styles.css` | Admin website |
| `public/leader.html` | Mass leader mobile app |
| `public/theme.css` | Colors and fonts (tweakcn) |
| `supabase/schema.sql` | Creates the Supabase table |
| `.env.example` | Template for `.env` (the key stays blank here) |
| `render.yaml` | Render deployment settings |
| `test/` | Unit and smoke tests |
| `Logo/Logo.jpg` | Original logo picture |
| `data/` | Local data file (not in git) |

