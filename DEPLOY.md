# Getting it online

Two accounts, both free, about twenty minutes. At the end you have a URL you
can open on any phone, and every entry backed up off the device.

| | What it does | Cost at your scale |
|---|---|---|
| **Cloudflare Pages** | Serves the app on an HTTPS URL | $0 |
| **Supabase** | Stores a copy of every change | $0 |

---

## Is it really free forever?

Nobody can promise another company's pricing forever, so here is what is
actually true, including the parts that are not simply "yes".

**Cloudflare Pages** — the free plan has unlimited requests and unlimited
bandwidth, capped at 500 builds a month. You will use maybe five. It
explicitly permits commercial use.

**Supabase** — the free plan gives 500 MB of database and 50,000 monthly
active users. One kiosk generates about **2 MB a year**, so you would reach
500 MB somewhere around the year 2276. Commercial use is permitted.

**The one catch worth knowing:** a free Supabase project **pauses after seven
days with no activity**. Using the app daily keeps it awake, so in practice
this never fires — but if you go on holiday for two weeks, the project
pauses and sync fails until you click "Restore" in the dashboard. The app
keeps working the whole time; it just queues. Nothing is lost.

**Why not Vercel**, which the earlier notes suggested: Vercel's free Hobby
plan is licensed for *personal, non-commercial* use. The kiosk is a business,
so this app does not qualify. Cloudflare's free plan has no such restriction.
That is the only reason for the switch — technically either would work.

**Your exit is cheap**, which is the part that actually protects you. The
device holds everything; the cloud is a copy. If either service changes its
terms you export a backup file from the app, point it somewhere else, and
lose nothing.

---

## Part 1 — Put the app online (10 minutes)

### 1. Build it

```bash
cd d:\maki\web
npm run build
```

This writes `dist/`. Check it contains `history.json` — that file is your
real trading history, it is gitignored on purpose, and it gets there by
being built locally rather than by a server pulling your repo. (If it is
missing, run `python tools/export_web_history.py` from `d:\maki` first.)

### 2. Deploy it

The very first time only, sign the command line in to Cloudflare and create
the project:

```bash
npx wrangler login
npx wrangler pages project create maki-kiosk --production-branch=main
```

After that, and for every update from then on, it is one command:

```bash
cd d:\maki\web
npm run deploy
```

It builds, uploads, then **waits until the real address is serving the new
build** before it says anything, and ends with:

```
  Live at  https://maki-kiosk.pages.dev   (build 7c938a34e53e)
```

### The app has ONE address: https://maki-kiosk.pages.dev

Bookmark it, install it from it (**Share → Add to Home Screen**), and never
use any other.

Cloudflare also publishes every single deploy at a throwaway address of its
own -- `https://6f5b0e9d.maki-kiosk.pages.dev` and so on -- and running
`wrangler pages deploy` by hand prints that one. **Do not open those.** A
browser keeps data per address, so each one is a separate, empty copy of the
app: whatever you enter there is saved *there* and is invisible from the real
address. That is what made a morning's entries look lost. A throwaway address
also freezes that one build forever, so an app installed from one never
updates.

`npm run deploy` never shows a throwaway address, and the app itself puts a
red warning on every screen if it is ever opened at one, with a button to save
a backup of whatever was entered there.

**If you entered data on a throwaway address:** open that same address, go
to Setup → Backup file → Export, then open https://maki-kiosk.pages.dev and
use Setup → Backup file → Restore with that file. Entries are merged, never
overwritten.

`_redirects` and `_headers` in `web/public/` are already configured — SPA
routing, immutable caching for hashed assets and fonts, and `no-cache` on
`sw.js` so a deploy is actually picked up.

---

## Part 2 — Add the backup (10 minutes)

Until this is done, everything lives in one browser on one phone. Losing the
phone loses the year.

### 3. Create the project

[supabase.com](https://supabase.com) → **New project**.

- Name it anything.
- **Save the database password it generates** — you will not need it for the
  app, but you will need it if you ever want to connect directly.
- Pick the region closest to Maryland (**East US**).

Wait about two minutes for it to provision.

### 4. Create the table

**SQL Editor** → **New query** → paste the whole of **`db/schema_cloud.sql`**
→ **Run**.

That is the only file you need. The others in `db/` are the analysis
pipeline's warehouse, which runs on your machine against the spreadsheet
extract — the app never touches those tables.

It creates **one table**. That is not a shortcut: the log is append-only and
every row carries the id the device generated, so the server needs no merge
logic and no schema that has to stay in step with the app. Adding a field to
the app later changes the JSON inside a column and needs no migration.

You should see `Success. No rows returned`.

### 5. Turn on email sign-in

**Authentication → Sign In / Providers → Email**:

- **Enable Email provider**: on
- **Confirm email**: on
- **Secure email change**: on

Then **Authentication → URL Configuration**:

- **Site URL**: `https://maki-kiosk.pages.dev` (your URL from step 2)
- **Redirect URLs** → Add URL: `https://maki-kiosk.pages.dev/**`

The `/**` matters. Without it the sign-in link bounces you to a default page
instead of back into the app.

> No password means none to forget at 5am and none to leak. Supabase's built-in
> email sender is rate-limited to a handful of messages an hour, which is
> plenty — you sign in once per device and the session refreshes itself.

### 6. Get the two values Supabase gives you

You need a **Project URL** and an **anon key**.

**Project URL** — look at your browser's address bar. It reads
`https://supabase.com/dashboard/project/abcdefghijklmnop`. That last chunk is
your project ref, and the URL is simply:

```
https://abcdefghijklmnop.supabase.co
```

**anon key** — in the dashboard, the green **Connect** button at the top, or
**Project Settings → API Keys**. Copy the one labelled **`anon` / `public`**.
It is a long string starting `eyJ`.

> **Not** the `service_role` key. That one bypasses row-level security
> entirely. If you ever paste it anywhere near this app, rotate it.

### 7. Bake them into the build

Pasting a 220-character key into a phone is miserable, and you are already
building on this machine — so put them in a file instead and the app arrives
already pointed at your project.

Create `web/.env.local`:

```
VITE_SUPABASE_URL=https://abcdefghijklmnop.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIs...
```

No quotes, no spaces around the `=`. This file is gitignored.

Then rebuild and redeploy:

```bash
cd d:\maki\web
npm run deploy
```

Both values are public by design and are *meant* to ship inside the app: the
anon key grants nothing without a signed-in session, and the row-level
security policy from step 4 is what actually protects the data — every row is
stamped with your user id and no other account can read it.

### 8. Sign in

On your phone, open the app → **Setup → Cloud sync**.

Because the credentials are already in the build, the screen opens at
**"2 · Sign in"** with a single email field. (If it instead shows *"1 · Point
it at your project"* with two boxes, the env file did not make it into the
build — check the filename is exactly `.env.local`, inside `web/`, and rebuild.)

Type your email → **Email me a link** → open that email **on the same phone**
and tap the link. It bounces back into the app, signed in.

### 9. Check it worked

In the app: **Setup → Cloud sync → Sync now**. It should say how many changes
it sent.

Then in Supabase: **Table Editor → app_mutations**. You should see rows.

If you see rows, you are done.

> **Adding a second device later** — a laptop, a spare phone — needs no
> rebuild. Open the same URL on it, go to **Setup → Cloud sync**, sign in with
> the same email. It pulls everything down.
>
> If you ever want to point the app at a *different* Supabase project without
> rebuilding, **Change project** on that screen reveals the two boxes and
> anything you type there overrides what was baked in.

---

## What syncs, and what to do if it does not

Everything durable goes up: the entry log, day confirmations, templates, the
menu, ingredients, recipes, and settings. **Theme is deliberately excluded** —
dark on the phone at 5am and light on a laptop at noon is the right outcome,
not a conflict.

There is no merge step, and that is by design rather than by luck:

- push the same change twice → primary-key collision → ignored
- pull a change that started here → matched on its id → ignored
- edit the same day on two devices → both rows kept, later one wins
- lose connection mid-push → the queue is still there, sent in batches on
  reconnect, and whatever already landed stays landed

**A failed sync is never data loss.** The device keeps everything.

**"Sync failed" but the numbers are all there.** That is the design working.
Check Cloud sync → Sync now for the actual error, and keep working meanwhile.

**Sign-in link does nothing.** The redirect URL in step 5 must match your
deployed URL exactly, including `https://` and the `/**`.

**A deploy didn't take.** This used to be a real problem and is now handled:
`npm run build` stamps a build id into `sw.js`, so the file differs whenever
the app differs. The installed app re-checks on launch, whenever it comes back
to the foreground, and hourly — and when it finds a newer build it shows
**"A newer version is ready · Update now"** above the tab bar.

It asks rather than reloading on its own, because a reload part-way through
counting a case would lose whatever had been typed and not yet confirmed.
IndexedDB survives a reload; a half-filled form does not.

If you ever need to force it: close the app completely and reopen it.

**Everything 404s after step 4.** PostgREST caches the schema. Re-run the last
line of `schema_cloud.sql`: `notify pgrst, 'reload schema';`

---

## Until Part 2 is done — and after it, anyway

**Setup → Backup file → Export.** One file, the whole database. Do it
once a week. It is the only thing between a lost phone and a lost year, and it
stays true even with sync working: a backup you hold is not subject to
anyone's terms of service.

---

## Running it locally

```bash
cd d:\maki\web
npm run dev -- --host      # prints a LAN address for your phone
```

Hot reload, no service worker. For the real offline behaviour, build and
preview instead:

```bash
npm run build && npx vite preview --port 4173 --host
```

`npm run flow` walks the whole morning loop against a running preview and
checks that what gets written is what was attested — worth running after any
change to the entry screens.
