# YWAM — Hosted Edition

This is the upgraded, hosted version of your YWAM Contributions. Unlike the original
(a single-file app that only worked in one browser on one device), this is a
real web app with a database, so it can:

- Track **due dates** on money you lend to Missionary
- **Automatically text Missionary** who miss their due date (via Twilio SMS), once a day
- Give each client a **personal link** where they can see their balance and
  mark a loan as paid — which instantly updates their balance in your Contributions

Everything else from the original app is still here: income/expense entries,
the full Contributions with running balance, client profiles, and a dashboard.

---

## 1. What you need before you start

1. **A place to host it.** This guide uses [Railway](https://railway.app)
   because it's the simplest option that supports a persistent database file
   and free/cheap starter tiers. (Render, Fly.io, or a small VPS also work —
   see the notes at the bottom if you'd rather use one of those.)
2. **A Twilio account**, for sending the SMS reminders. Sign up free at
   https://www.twilio.com/try-twilio — a trial account is enough to test with,
   but it can only text phone numbers you've manually verified in the Twilio
   console, and it stamps every message with "Sent from a Twilio trial
   account". For reminders to go to *any* client number without that stamp,
   you'll need to add a small amount of credit and "upgrade" the trial account
   (Twilio walks you through this in their dashboard).
3. Twenty minutes.

---

## 2. Get your Twilio details

Once you have a Twilio account:

1. Go to the [Twilio Console](https://console.twilio.com). On the main
   dashboard you'll see your **Account SID** and **Auth Token** — copy both.
2. Get a Twilio phone number: Console → **Phone Numbers → Buy a number**
   (trial accounts get one free number). Copy it in international format,
   e.g. `+14155238886`.
3. If you're still on a trial account, go to **Phone Numbers → Verified
   Caller IDs** and add the phone number(s) you want to test reminders with —
   Twilio will call or text you a code to confirm you own it.

Keep these three values (Account SID, Auth Token, phone number) handy —
you'll paste them into Railway in step 4.

---

## 3. Deploy to Railway

1. Go to https://railway.app and sign up (GitHub login is easiest).
2. Click **New Project → Deploy from GitHub repo**. If this project isn't in
   a GitHub repo yet: create a new empty repo on GitHub, then upload/push
   everything in this folder to it. (Railway can also deploy from a local
   folder using their CLI — `npm i -g @railway/cli`, then `railway up` from
   inside this folder, if you'd rather skip GitHub.)
3. Once the project is created, open it and go to the **Variables** tab.
   Add these (copy from `.env.example`):

   | Variable | Value |
   |---|---|
   | `ADMIN_PASSWORD` | a password you choose, for logging into your admin panel |
   | `SESSION_SECRET` | any long random string |
   | `BASE_URL` | leave blank for now — you'll fill this in after step 5 |
   | `TWILIO_ACCOUNT_SID` | from step 2 |
   | `TWILIO_AUTH_TOKEN` | from step 2 |
   | `TWILIO_FROM_NUMBER` | your Twilio number, e.g. `+14155238886` |
   | `DEFAULT_COUNTRY_CODE` | `+91` (or your country's code) |
   | `NODE_ENV` | `production` |

4. Go to the **Settings** tab of the service and add a **Volume**
   (Settings → Volumes → **New Volume**). Mount it at `/app/data`. This is
   important: it's what keeps your Missionary, loans, and transactions saved
   permanently instead of being wiped every time the app restarts or
   redeploys.
5. Railway will build and deploy automatically. Once it's live, open
   **Settings → Networking → Generate Domain** to get a public URL like
   `https://YWAM-yourname.up.railway.app`.
6. Go back to **Variables** and set `BASE_URL` to that exact URL (no
   trailing slash). This is only used inside the SMS text so the link it
   sends the client works — everything else works without it.
7. Visit your URL. You should see the sign-in page — log in with the
   `ADMIN_PASSWORD` you set.

**Cost:** Railway's free trial gives you a small amount of usage credit;
after that it's usage-based, typically a few dollars a month for an app this
size. Twilio SMS is pay-as-you-go, roughly ₹0.30–0.80 per SMS in India
(check current pricing at twilio.com/sms/pricing).

---

## 4. Using it

- **New Entry** — same as before: log income or an expense, optionally
  linked to a client.
- **Missionary** — add Missionary with their phone number in international
  format (e.g. `+91 98765 43210`) — the phone number is required for SMS
  reminders to work. Click a client's name to open their profile, which now
  also shows their **personal portal link** — copy it and send it to them
  however you like (WhatsApp, SMS, email).
- **Loans** — this is new. Use it whenever you lend a client money and want
  a due date attached. Set the amount, the date you gave it, and when it's
  due. It shows up in the main Contributions automatically as an expense.
  - If a loan passes its due date unpaid, it's marked **Overdue** on the
    Dashboard and the Loans tab, and YWAM automatically texts the client once
    a day until it's paid (see below).
  - You can record a payment yourself (cash, bank transfer, etc.) with
    **Record payment**, or the client can mark it paid themselves through
    their portal link.
- **Client portal** (the link you send Missionary) — shows the client their
  balance and every loan with its due date and status. If a loan isn't fully
  paid, they can type in how much they paid and submit it — it's recorded
  immediately and reduces what they owe, without needing your login.
- **Settings → SMS reminders** — shows whether Twilio is connected, lets you
  trigger a reminder sweep manually (instead of waiting for the daily
  automatic run), and shows a log of every reminder sent or failed.

### Sending WhatsApp reminders for unpaid yearly contributions (via n8n)

This app doesn't send WhatsApp itself — instead it exposes a small API for an
external automation tool like [n8n](https://n8n.io) to read from and send
WhatsApp messages with. To turn it on:

1. In Railway → **Variables**, add `AUTOMATION_API_KEY` set to a long random
   string (e.g. generate one at https://www.uuidgenerator.net/ — treat it
   like a password).
2. Redeploy. You now have a new endpoint:

   ```
   GET {BASE_URL}/api/automation/unpaid-contributions?year=2026
   Header: x-api-key: <your AUTOMATION_API_KEY>
   ```

   It returns every client who hasn't yet reached the ₹1200 yearly target,
   with a WhatsApp-ready phone number (`whatsapp_phone`, digits only) and a
   ready-made `message` string for each one.
3. Set up the n8n workflow described in the accompanying guide to call this
   endpoint on the schedule you want (e.g. twice a month, at month-end) and
   send each client a WhatsApp message.
4. (Optional) After sending, n8n can call
   `POST {BASE_URL}/api/automation/log-reminder` (same `x-api-key` header,
   body `{ "client_id": "...", "message": "...", "status": "sent" }`) so the
   attempt is recorded in the same reminders log the SMS scheduler uses.

### About the automatic SMS reminders

Once a day (9:00 AM server time by default — change this with the
`REMINDER_CRON` variable), YWAM checks every loan that's past its due date
and not fully paid, and sends one text to that client. It won't send more
than one reminder per loan per day even if you also click "send now"
manually. If Twilio isn't configured, reminders are logged as "failed:
not_configured" instead of silently disappearing, so you can see what
would have gone out.

---

## 5. Files in this project

```
server.js            Entry point — wires everything together
db.js                 Database connection + schema (PostgreSQL)
scheduler.js          Daily cron job that checks overdue loans and sends SMS
routes/
  auth.js             Admin login/logout
  Missionary.js          Client profiles + balances
  transactions.js      Income/expense Contributions + dashboard totals
  loans.js            Lending, due dates, recording payments
  portal.js            Public client-facing account view + "I paid this"
  settings.js         Currency, Twilio status, reminder log, backup export
utils/
  sms.js              Twilio wrapper
  helpers.js           IDs, dates, phone number formatting
public/
  admin/              The admin panel (what you see when logged in)
  portal/              The public client-facing page
data/                  (no longer used — data now lives in Postgres, set
                       via the DATABASE_URL env var — see step 3.4)
```

---

## 6. Running it on your own computer first (optional, to try it out)

```
npm install
cp .env.example .env
# edit .env and at least set ADMIN_PASSWORD
npm start
```
Then open http://localhost:3000. Twilio reminders won't actually send unless
you've filled in the Twilio variables too, but everything else works fully
offline on your machine.

---

## 7. Security notes

- Only one admin password protects the whole admin panel — anyone with the
  password can see and edit everything. Don't share it, and pick something
  you don't reuse elsewhere.
- Each client's portal link contains a long random token instead of a
  predictable ID, so someone can't guess another client's link. If a link
  ever leaks, open that client's profile and click **Regenerate link** to
  invalidate the old one.
- This app does not encrypt data at rest — it relies on Railway's own
  infrastructure security. Don't put anything in Notes/YWAM fields you
  wouldn't want visible to anyone who gained access to your Railway account.

## 8. If you'd rather not use Railway

Any Node.js host works, as long as it gives you a **persistent disk** for the
`data/` folder (without one, all your data resets on every redeploy) and lets
you run a long-lived process for the cron scheduler (not a "serverless
function" platform like Vercel, which won't keep a background job running).
Render.com's paid tier with a persistent disk, Fly.io, or a small VPS
(DigitalOcean/Linode droplet) all work the same way — copy this whole folder
up, run `npm install && npm start`, and set the same environment variables
from `.env.example`.
"# data-entry-app" 
