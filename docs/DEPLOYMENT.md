# Deployment

Three services, ₹0/month:

| Layer | Host | Free-tier reality |
|---|---|---|
| Inference (Python) | Render | 512 MB, sleeps after 15 min idle, ~1 min to wake |
| API (Node) | Render | same |
| Database | MongoDB Atlas M0 | 512 MB, free forever, no card |

Measured: the inference image is **627 MB** and runs at **145 MiB / 512 MiB** with `/predict` at **54–66 ms**.

---

## 0. Before you deploy — two blockers

Run the preflight check:

```bash
cd ml && python scripts/preflight.py
```

It currently reports two files that exist locally but are **not committed**, so
the image builds on your machine and fails on Render's:

```bash
git add ml/Dockerfile ml/.dockerignore ml/requirements-serve.txt \
        ml/data/raw/anuvaad_indb_2024.11.csv render.yaml
git commit -m "Add deployment artifacts"
```

**Why the food CSV must be committed and must not be in LFS.** `ml/.gitattributes`
routes `data/raw/*.csv` to Git LFS. A build host that does not fetch LFS objects
would copy a ~130-byte *pointer stub* instead of the food database — and the
recommender would load 0 foods and carry on quietly. `.gitattributes` now
exempts this one file, and `preflight.py` fails the check if any artifact looks
like a pointer.

---

## 1. MongoDB Atlas

1. `cloud.mongodb.com` → create a free **M0** cluster.
2. **Database Access** → add a user with a strong password.
3. **Network Access** → allow `0.0.0.0/0`. Render's free tier has no static
   outbound IP, so an allowlist is not possible. The database is still protected
   by credentials; if that trade-off is unacceptable, a paid Render plan gives
   static IPs.
4. Copy the SRV string:
   `mongodb+srv://USER:PASSWORD@cluster.xxxxx.mongodb.net/niyantrana`

   Keep `/niyantrana` on the end — without a database name Mongo defaults to
   `test`, and the seeded food collection would be invisible to the API.

---

## 2. Deploy both services

Render dashboard → **New** → **Blueprint** → select this repo. It reads
`render.yaml` and creates both services.

Two values are not in the blueprint and must be pasted in (they are marked
`sync: false`):

| Service | Variable | Value |
|---|---|---|
| `niyantrana-api` | `MONGO_URI` | your Atlas SRV string |
| `niyantrana-api` | `CORS_ORIGIN` | the deployed frontend origin, e.g. `https://niyantrana.pages.dev` |

Optional, on both services: `GEMINI_API_KEY` from `aistudio.google.com`. Without
it, `/api/chat` and `/api/recommend` return **503** and everything else works.

`ML_SERVICE_URL` is wired automatically via `fromService`.

**Deploy the inference service first** — the API's health check depends on it
being reachable.

---

## 3. Seed the food database

Once the API is live, from your machine:

```bash
cd backend2
MONGO_URI="mongodb+srv://..." npm run seed
```

Expect `Seeded 1014 foods`. Food search and meal logging return empty results
until this runs.

---

## 4. Verify

```bash
API=https://niyantrana-api.onrender.com
ML=https://niyantrana-inference.onrender.com

curl -s $ML/health | jq '.status, .artifacts.functional'   # "ok", true
curl -s $API/health | jq '.status, .database'              # "ok", "connected"
```

`artifacts.functional` is the one that matters: it means the models actually
loaded and scored, not merely that the files are present. A build that shipped
broken dependencies once reported `"ok"` on a presence-only check while every
prediction returned 500.

Then the full journey:

```bash
curl -s -c j.txt -X POST $API/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-enough-password"}'
curl -s -c j.txt -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-enough-password"}'
curl -s -b j.txt -X POST $API/api/wearable/demo -H 'Content-Type: application/json' \
  -d '{"days":90,"trend":"improving"}'
curl -s -b j.txt -X POST $API/api/predict -H 'Content-Type: application/json' -d '{}' | jq '.risks, .trajectories[0]'
```

The first `/api/predict` after an idle period takes **up to 75 seconds** — it is
waking the inference service. That is the cold-start retry working, not a hang.

---

## 5. Things that will bite you

**Login succeeds but the user is immediately logged out.**
`TRUST_PROXY` is not set. Render terminates TLS at its proxy, so Express sees
plain `http`, refuses to send a `Secure` cookie, and returns 200 with no
session. Nothing errors anywhere. The blueprint sets it; if you created the
service by hand, add `TRUST_PROXY=true`.

**The frontend gets CORS errors.**
`CORS_ORIGIN` must be the exact scheme and host of the deployed frontend, with
no trailing slash. A wildcard is rejected at boot because it cannot be combined
with credentials.

**The first prediction of the day fails.**
Should not happen — `ML_COLD_START_TIMEOUT_MS` retries once with a 75-second
window. If it does, the inference service is failing to start; check its logs
and `/health`.

**Food search returns nothing.**
The seed step (3) has not run against this database, or `MONGO_URI` is missing
the `/niyantrana` database name.

**A deploy silently serves stale or empty data.**
Run `python ml/scripts/preflight.py`. It checks that every artifact is
committed, is not an LFS pointer, and that the models load and score.

---

## 6. Cold starts, and what to do about them

Free instances sleep after 15 minutes. First request after that: ~1 minute.

- Before showing the app to anyone, open `/health` on both services once.
- A free uptime pinger hitting `/health` every 10 minutes keeps them warm, at
  the cost of instance-hours (750/month/workspace, shared).
- The **GitHub Student Developer Pack** gives DigitalOcean $200 and Azure $100,
  enough for a year of always-on $6/month instances if cold starts become
  annoying.

---

## 7. Local equivalent

Everything above runs locally in Docker:

```bash
docker run -d --name niy-mongo -p 27017:27017 mongo:7
cd ml && docker build -t niyantrana-inference:v2 .
docker run -d --name niy-ml --memory=512m --cpus=0.5 -p 8000:8000 niyantrana-inference:v2

cd ../backend2 && npm install && npm run seed
MONGO_URI=mongodb://127.0.0.1:27017/niyantrana \
SESSION_SECRET=a-long-enough-dev-secret \
ML_SERVICE_URL=http://127.0.0.1:8000 npm start
```

`--memory=512m --cpus=0.5` mirrors the free tier, so an OOM shows up here rather
than in production. See `ml/DOCKER.md` — Docker Desktop is a user-level install
on this machine and needs a PATH export first.
