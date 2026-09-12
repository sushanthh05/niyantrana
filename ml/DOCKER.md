# Running the inference service in Docker

Docker Desktop on this machine is a **user-level install**, so `docker` is not on
the default Git Bash PATH:

```bash
export PATH="/c/Users/swami/AppData/Local/Programs/DockerDesktop/resources/bin:$PATH"
```

That directory also holds `docker-credential-desktop.exe`; without it on PATH
the build fails at `FROM python:3.13-slim` with
`error getting credentials`.

## Build and run

```bash
cd ml
docker build -t niyantrana-inference:v2 .

# --memory=512m --cpus=0.5 mirrors the Render free tier.
docker run -d --name niy --memory=512m --memory-swap=512m --cpus=0.5 \
  -p 8113:8000 niyantrana-inference:v2

curl -s localhost:8113/health
docker stats niy --no-stream
docker logs niy
```

With a Gemini key, `/recommend` becomes live:

```bash
docker run -d --name niy -p 8113:8000 -e GEMINI_API_KEY=... niyantrana-inference:v2
```

## Measured on this image

| | |
|---|---|
| Image size | **627 MB** (was 947 MB) |
| Memory under load | **144.9 MiB / 512 MiB (28%)** |
| `/predict` latency, 84 days of history | **54-66 ms** |
| Cold start to first healthy response | **5.4 s** at 0.5 CPU |
| OOM kills at 512 MB | none |

Cold start includes the functional probe loading both model bundles, so once
`/health` returns 200 the service is genuinely warm rather than merely running.

## Verifying the health check actually works

```bash
docker run -d --name broken -p 8114:8000 \
  -e RISK_ENGINE_PATH=/app/models/gone.joblib niyantrana-inference:v2
curl -s -o /dev/null -w "%{http_code}\n" localhost:8114/health   # 503
```
