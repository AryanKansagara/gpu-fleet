# On-call Health

Shows an engineering manager how hard on-call is hitting each person, and which alerts to fix first. Built for the quarterly on-call review.

**Live:** https://oncall-health.vercel.app

## The pain

Pages arrive through several tools at all hours, a lot of them are flapping, duplicated or resolve on their own, and one person quietly absorbs the swaps and weekends. Nobody has the numbers to argue for change.

## Features

- **Import** PagerDuty incidents CSV and REST API (`/incidents` plus `/log_entries`), Opsgenie alerts CSV, Rootly CSV or JSON:API, or any CSV. Format detection, column mapping and a validation report with line numbers.
- **Per-person load** in each person's timezone and working hours: business hours, evenings, sleep hours (default 22:00 to 07:00) and weekends, plus a 7 x 24 heatmap.
- **Ack and resolve distributions**, **fairness** (Gini and share against a fair share) and a **documented burnout-risk score**.
- **Noise detection**: auto-resolved blips, flapping, duplicates, dependencies, never-acked and non-actionable alerts, ranked with a concrete change and the pages per month it removes. Toggle any fix as a what-if.
- **Rotation simulator** (single, primary/secondary, follow-the-sun), **pay and time off in lieu** with an editable policy, a **printable quarterly report** and CSVs.
- **History**: quarterly or monthly snapshots with a compare view.
- Local-first (IndexedDB). Optional email sign-in syncs teams across devices.
- Three synthetic sample teams.

## Run locally

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # engine tests
npm run build
```

Cloud sync needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env` (see `.env.example`). Without them the app runs in local-only mode.

Built by Aryan Kansagara. Independent project, not affiliated with Rootly.
