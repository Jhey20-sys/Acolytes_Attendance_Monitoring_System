# Altar Servers — Attendance Monitoring System

Two parts, one server:

| | Who | Address | Sample account |
|---|---|---|---|
| **Admin website** | Admin / secretary | `http://localhost:3000` | `altarservers` / `altarservers123` |
| **Mobile app** | Mass leader (user) | `http://<this-computer>:3000/app` | `1stmass` / `1stmass123` (Agusan, First Mass) |

> **Change both sample passwords** after the first login (Settings → accounts).

## Start

```
npm install     (first time only)
npm start
```

The terminal prints the "same Wi-Fi" address for the leader app. If Windows asks whether to allow Node.js on the network, choose **Allow** (Private networks).

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

Everything is stored in `data/db.json`. Use **Settings → Export backup** regularly. The previous version (PIN check-in) is saved in `backup-v2/`.

## Putting it online (optional)

Host on any Node.js host with a persistent disk (VPS, Render/Railway with a disk, or a parish PC with Cloudflare Tunnel), set `DATA_DIR` to the disk, and set **Settings → Link used in QR codes** to the website address. Then re-print the QR cards.

## Theming (tweakcn)

The whole look (colors, font, corner radius, shadows, dark mode) comes from `public/theme.css`, which uses the same variables as shadcn/ui. To restyle the app, design a theme at https://tweakcn.com/editor/theme, click **Code**, copy the `:root { ... }` and `.dark { ... }` blocks into `public/theme.css`, and refresh the page. No restart is needed.

