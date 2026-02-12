# Docker Deployment Plan — Tree (Genealogy Viewer)

> Target: self-hosted on a Debian 11 server on a LAN behind a FRITZ!Box 7590,
> managed via **Portainer**.
>
> Admin workstation: Windows 10 IoT Enterprise LTSC 21H2, WSL 2.6.3,
> no Docker Desktop (not supported on this Windows edition).

---

## Table of Contents

1. [Architecture overview](#1-architecture-overview)
2. [What is persistent (survives container replacement)](#2-what-is-persistent)
3. [Container image — build & publish to GHCR](#3-container-image)
4. [Production docker-compose.yml](#4-production-docker-composeyml)
5. [First-time server setup](#5-first-time-server-setup)
6. [Day-to-day operations via Portainer](#6-day-to-day-operations-via-portainer)
7. [Updating to a new version](#7-updating-to-a-new-version)
8. [Backup & restore](#8-backup--restore)
9. [Networking / FRITZ!Box access](#9-networking--fritzbox-access)
10. [Admin workflow from Windows 10 IoT](#10-admin-workflow-from-windows-10-iot)
11. [Security checklist](#11-security-checklist)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│  Debian server (Docker Engine + Portainer)                   │
│                                                              │
│  ┌──────────┐      ┌──────────────┐      ┌───────────────┐  │
│  │ Postgres │◄────►│  Tree API    │◄────►│  Named        │  │
│  │ PostGIS  │      │  (FastAPI)   │      │  volumes      │  │
│  │ 16-3.4   │      │  port 8080   │      │  (media)      │  │
│  └──────────┘      └──────────────┘      └───────────────┘  │
│       │                    │                                 │
│   pgdata vol          exposed to LAN                         │
│   (persistent)        (or reverse-proxied)                   │
└──────────────────────────────────────────────────────────────┘
```

Two containers, three named volumes:

| Container | Image | Volumes |
|-----------|-------|---------|
| **db** | `postgis/postgis:16-3.4` | `tree_pgdata` → `/var/lib/postgresql/data` |
| **api** | `ghcr.io/<you>/tree:latest` | `tree_media` → `/app/media` |

Both the database and the media files live on **named Docker volumes**.
The API container is **stateless** — you can pull a new image and recreate it
without losing anything.

---

## 2. What is persistent

Data that must survive container replacement:

| Data | Location inside container | Named volume | Survives `docker compose up --build`? |
|------|--------------------------|--------------|---------------------------------------|
| PostgreSQL databases (all schemas, users, instances, genealogy data, user notes) | `/var/lib/postgresql/data` | `tree_pgdata` | ✅ Yes |
| Imported media files (originals + thumbnails) | `/app/media/` | `tree_media` | ✅ Yes |
| JWT secret | env var `JWT_SECRET` | N/A (in `.env`) | ✅ Yes (if set in `.env` or Portainer env) |

Data that does **not** need to persist:

| Data | Why |
|------|-----|
| Python packages | Baked into the image |
| Static frontend files | Baked into the image |
| Rate-limit counters | In-memory, reset on restart is fine |
| Import temp files | Cleaned up after import completes |

### Key insight

The current `Dockerfile` copies the entire `api/` directory (including `api/media/`)
into the image. When the container restarts from a fresh image, the old `/app/media`
would be lost. By mounting a **named volume** at `/app/media`, Docker keeps those
files on the host regardless of image changes.

---

## 3. Container image

### 3a. Improved Dockerfile

The current Dockerfile works but needs a few production improvements:

```dockerfile
# ── api/Dockerfile (production) ──────────────────────────────
FROM python:3.12-slim

# System deps for Pillow (thumbnail generation) and psycopg
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libjpeg62-turbo-dev libwebp-dev zlib1g-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first (better layer caching)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . ./

# Create media directory (will be overlaid by the named volume)
RUN mkdir -p /app/media

ENV PORT=8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')" || exit 1

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
```

### 3b. `.dockerignore`

Create `api/.dockerignore` to keep the image small:

```
__pycache__/
*.pyc
.pytest_cache/
.venv/
.env
media/
reports/
*.gpkg
*.gramps
docker-compose*.yml
Dockerfile
```

Note: `media/` is excluded because media files live on the named volume, not in the image.

### 3c. Build and push to GHCR (GitHub Container Registry)

You will build the image in WSL on your Windows machine and push to GHCR,
then Portainer on the Debian server pulls from GHCR.

**One-time setup (WSL):**

```bash
# Install Docker Engine in WSL (not Docker Desktop)
# See: https://docs.docker.com/engine/install/debian/
# After install, start the daemon:
sudo service docker start

# Authenticate to GHCR
echo "<YOUR_GITHUB_PAT>" | docker login ghcr.io -u <YOUR_GITHUB_USERNAME> --password-stdin
```

The GitHub PAT needs the `write:packages` scope.

**Build & push workflow (run from WSL):**

```bash
cd /mnt/c/Users/akortekaas/Documents/GitHub/tree

# Build the image (from repo root, Dockerfile is in api/)
docker build -t ghcr.io/<you>/tree:latest -f api/Dockerfile api/

# Also tag with a version
docker build -t ghcr.io/<you>/tree:v1.0.0 -f api/Dockerfile api/

# Push
docker push ghcr.io/<you>/tree:latest
docker push ghcr.io/<you>/tree:v1.0.0
```

> **Alternative: GitHub Actions CI/CD**
>
> You could add a `.github/workflows/docker.yml` that builds and pushes
> automatically on every push to `main`. This is optional but recommended
> long-term. See [Appendix A](#appendix-a-github-actions-workflow) below.

---

## 4. Production docker-compose.yml

This replaces the current dev-oriented `api/docker-compose.yml` for production use.
Deploy this stack via Portainer.

```yaml
# docker-compose.prod.yml — deploy via Portainer on Debian server
version: "3.8"

services:
  db:
    image: postgis/postgis:16-3.4
    restart: unless-stopped
    environment:
      POSTGRES_DB: genealogy
      POSTGRES_USER: genealogy
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}   # set in .env
    volumes:
      - tree_pgdata:/var/lib/postgresql/data
    # NOT exposed to host — only the api container connects
    networks:
      - tree_internal
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U genealogy -d genealogy"]
      interval: 10s
      timeout: 5s
      retries: 5

  api:
    image: ghcr.io/<you>/tree:latest
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://genealogy:${POSTGRES_PASSWORD}@db:5432/genealogy
      JWT_SECRET: ${JWT_SECRET}                 # set in .env
    volumes:
      - tree_media:/app/media
    ports:
      - "8080:8080"
    networks:
      - tree_internal

volumes:
  tree_pgdata:
    driver: local
  tree_media:
    driver: local

networks:
  tree_internal:
    driver: bridge
```

### `.env` file (on the server, NOT in git)

```env
POSTGRES_PASSWORD=<strong-random-password>
JWT_SECRET=<strong-random-string-64-chars>
```

Generate these once:

```bash
# Generate passwords (run on any Linux/WSL)
openssl rand -base64 32    # → POSTGRES_PASSWORD
openssl rand -base64 48    # → JWT_SECRET
```

---

## 5. First-time server setup

### 5a. Prerequisites on Debian server

Your server already runs Docker (since Portainer is there). Verify:

```bash
docker --version          # should be 20.x+
docker compose version    # should be v2.x
```

### 5b. Authenticate Portainer to GHCR

In Portainer:
1. Go to **Registries** → **Add registry** → **Custom**
2. Registry URL: `ghcr.io`
3. Username: your GitHub username
4. Password: a GitHub PAT with `read:packages` scope
5. Save

This allows Portainer to pull your private images from GHCR.

### 5c. Deploy the stack in Portainer

1. In Portainer, go to **Stacks** → **Add stack**
2. Name: `tree`
3. Paste the `docker-compose.prod.yml` content above
4. Under **Environment variables**, add:
   - `POSTGRES_PASSWORD` = (your generated password)
   - `JWT_SECRET` = (your generated secret)
5. Click **Deploy the stack**

Portainer will create the containers, volumes, and network.

### 5d. First-time database initialization

After the stack is running, you need to create the admin user and instance.
Run these commands via Portainer's **console** (click on the `api` container → Console → `/bin/bash`):

```bash
# Inside the api container:

# Create the admin user (also creates _core schema)
python -m api.admin create-admin \
  --username admin \
  --password 'YourAdminPassword123'

# Create the default instance
python -m api.admin create-instance \
  --slug default \
  --name "Family Tree"

# (Optional) Add the admin to the instance
python -m api.admin add-member \
  --username admin \
  --instance default
```

### 5e. Import your data

After admin setup, open the app in your browser:
1. Navigate to `http://<server-ip>:8080/demo/relationship`
2. Log in with the admin credentials
3. Pick the instance (or auto-redirect for single instance)
4. Open **Options** → **Import** → upload your `.gpkg` file
5. Wait for the import to complete (the overlay shows progress)

Your media files are now stored in the `tree_media` Docker volume and
your genealogy data is in the `tree_pgdata` PostgreSQL volume.

---

## 6. Day-to-day operations via Portainer

### View logs

Portainer → Containers → click `tree-api-1` → **Logs**

### Restart the API

Portainer → Containers → click `tree-api-1` → **Restart**

### Run admin CLI commands

Portainer → Containers → click `tree-api-1` → **Console** → Connect (`/bin/bash`):

```bash
# List users
python -m api.admin list-users

# List instances
python -m api.admin list-instances

# Create a guest
python -m api.admin create-user \
  --username cousin_jan \
  --password Jan12345 \
  --role guest \
  --instance default
```

Alternatively, create guests from the web UI: **Options** → **Guests** (as admin or user).

### Check database

Portainer → Containers → click `tree-db-1` → **Console** → Connect (`/bin/bash`):

```bash
psql -U genealogy -d genealogy

# Check schemas
\dn

# Check tables in the instance schema
SET search_path TO inst_default, _core, public;
\dt

# Count people
SELECT count(*) FROM person;
```

---

## 7. Updating to a new version

This is the core workflow: **pull a new image, recreate the api container, keep all data.**

### From your Windows machine (WSL):

```bash
cd /mnt/c/Users/akortekaas/Documents/GitHub/tree

# Build new image after code changes
docker build -t ghcr.io/<you>/tree:latest -f api/Dockerfile api/
docker push ghcr.io/<you>/tree:latest
```

### On the server (Portainer):

1. Go to **Stacks** → `tree`
2. Click **Pull and redeploy** (or: Editor → **Update the stack** with "Re-pull image" checked)
3. Portainer pulls the new `latest` image and recreates the `api` container
4. The `db` container is unchanged (same image, same volume)
5. ✅ All data preserved — database volume and media volume are untouched

### What actually happens:

```
Before:  api container (old image) ──mount──► tree_media volume
                                              tree_pgdata volume

Update:  old api container is stopped and removed
         new api container is created from new image
         same volumes are re-mounted

After:   api container (NEW image) ──mount──► tree_media volume (unchanged)
                                              tree_pgdata volume (unchanged)
```

### Database migrations

If a new version changes the database schema (new tables/columns):

1. The SQL files use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so they are safe to re-run.
2. After updating, open a console in the api container and re-run the instance creation (it's idempotent):

```bash
python -m api.admin create-instance --slug default --name "Family Tree"
```

This re-applies `schema.sql` to the instance schema, adding any new tables/columns.

---

## 8. Backup & restore

### Database backup

Run from the **db container** console (or via `docker exec` on the server):

```bash
# Full database dump (all schemas, all data)
pg_dump -U genealogy -d genealogy -Fc -f /tmp/genealogy_backup.dump
```

Copy the dump out of the container:

```bash
# On the Debian server:
docker cp tree-db-1:/tmp/genealogy_backup.dump ~/backups/genealogy_$(date +%Y%m%d).dump
```

### Media backup

The media files live in the `tree_media` named volume. Back them up:

```bash
# On the Debian server:
docker run --rm \
  -v tree_media:/data \
  -v ~/backups:/backup \
  alpine tar czf /backup/tree_media_$(date +%Y%m%d).tar.gz -C /data .
```

### Restore database

```bash
# Stop the api container first (via Portainer or CLI)
docker stop tree-api-1

# Drop and recreate the database
docker exec -i tree-db-1 psql -U genealogy -c "DROP DATABASE genealogy;"
docker exec -i tree-db-1 psql -U genealogy -c "CREATE DATABASE genealogy;"

# Restore the dump
docker exec -i tree-db-1 pg_restore -U genealogy -d genealogy < ~/backups/genealogy_20260212.dump

# Start the api container again
docker start tree-api-1
```

### Restore media

```bash
docker run --rm \
  -v tree_media:/data \
  -v ~/backups:/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/tree_media_20260212.tar.gz -C /data"
```

### Automated backups (recommended)

Create a cron job on the Debian server:

```bash
# /etc/cron.d/tree-backup
0 3 * * * root /opt/tree-backup.sh >> /var/log/tree-backup.log 2>&1
```

```bash
#!/bin/bash
# /opt/tree-backup.sh
BACKUP_DIR="$HOME/backups/tree"
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d_%H%M%S)

# Database
docker exec tree-db-1 pg_dump -U genealogy -d genealogy -Fc \
  > "$BACKUP_DIR/db_$STAMP.dump"

# Media
docker run --rm \
  -v tree_media:/data \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf "/backup/media_$STAMP.tar.gz" -C /data .

# Keep only last 7 days
find "$BACKUP_DIR" -name "db_*.dump" -mtime +7 -delete
find "$BACKUP_DIR" -name "media_*.tar.gz" -mtime +7 -delete
```

---

## 9. Networking / FRITZ!Box access

### LAN access (default)

With the compose file above, the app is available at:

```
http://<debian-server-ip>:8080/demo/relationship
```

Anyone on your LAN can reach it.

### Remote access via FRITZ!Box

If you want family members outside your LAN to access it:

**Option A: FRITZ!Box MyFRITZ! + port forwarding**

1. In FRITZ!Box admin (`http://fritz.box`):
   - **Internet** → **Permit Access** → **Port Sharing**
   - Add device: your Debian server
   - Port: external `443` → internal `8080` (TCP)
2. Enable **MyFRITZ!** for a free `<name>.myfritz.net` domain
3. Set up a reverse proxy (Nginx/Caddy) on the server for HTTPS:

```
# Example: Caddy (auto-HTTPS via Let's Encrypt)
# /etc/caddy/Caddyfile
your-domain.myfritz.net {
    reverse_proxy localhost:8080
}
```

If using HTTPS, update the cookie settings in `api/auth.py` to set `Secure=True`.

**Option B: Tailscale / WireGuard VPN (more secure)**

- Install Tailscale on the server and on family members' devices
- No port forwarding needed
- Access via Tailscale IP: `http://100.x.x.x:8080/demo/relationship`
- Simpler and more secure than exposing to the internet

### DNS for LAN

For convenience, assign a hostname on your LAN:
- FRITZ!Box → **Home Network** → **Network** → find your server → set hostname (e.g., `tree-server`)
- Access via `http://tree-server:8080/demo/relationship`

---

## 10. Admin workflow from Windows 10 IoT

Since Docker Desktop is not supported on Windows 10 IoT Enterprise LTSC 21H2,
all Docker operations happen in **WSL** or remotely on the **Debian server**.

### Your admin stations

| Task | Where to do it | How |
|------|----------------|-----|
| **Edit code** | Windows (VS Code) | Normal code editing |
| **Build Docker image** | WSL | `docker build` + `docker push` |
| **Deploy / update** | Portainer (browser) | Pull & redeploy stack |
| **Run admin CLI** | Portainer console | `python -m api.admin ...` |
| **View logs** | Portainer (browser) | Container → Logs |
| **Backup** | SSH to Debian server | `docker exec` / cron |
| **Browse the app** | Windows browser | `http://<server-ip>:8080/...` |
| **Import .gpkg** | Windows browser | Options → Import |

### WSL setup for building images

Since Docker Desktop isn't available, install Docker Engine directly in WSL:

```bash
# In WSL (Debian/Ubuntu):
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

# Add Docker GPG key and repo
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Start Docker daemon (must do this each time you open WSL, or enable systemd)
sudo service docker start

# Add yourself to docker group (then restart WSL)
sudo usermod -aG docker $USER
```

### Build & deploy workflow (step by step)

```
1. Edit code in VS Code on Windows
          │
          ▼
2. Open WSL terminal
     cd /mnt/c/Users/akortekaas/Documents/GitHub/tree
     docker build -t ghcr.io/<you>/tree:latest -f api/Dockerfile api/
     docker push ghcr.io/<you>/tree:latest
          │
          ▼
3. Open Portainer in browser (http://<server-ip>:9000)
     Stacks → tree → Pull and redeploy
          │
          ▼
4. Done — new code is live, all data intact
```

### SSH to the Debian server

For backup management and troubleshooting:

```powershell
# From PowerShell on Windows:
ssh user@<server-ip>

# Or from WSL:
ssh user@<server-ip>
```

---

## 11. Security checklist

- [ ] **Set `JWT_SECRET`** to a strong random value (not the dev default)
- [ ] **Set `POSTGRES_PASSWORD`** to a strong random value (not `genealogy`)
- [ ] **Do not expose port 5432** (Postgres) to the network — it stays on the internal Docker network
- [ ] **Keep `.env` out of git** (already in `.gitignore`)
- [ ] **Set GHCR package visibility** to private if you don't want the image public
- [ ] **Password policy**: All passwords must be ≥8 chars with uppercase + lowercase + digit
- [ ] **If exposing to internet**: Use HTTPS (reverse proxy) and set `Secure` flag on cookies
- [ ] **Portainer**: Set a strong admin password; consider restricting its port to localhost + SSH tunnel

---

## 12. Troubleshooting

### API can't connect to database

```
sqlalchemy.exc.OperationalError: connection refused
```

- Check that the `db` container is healthy: Portainer → Containers → `tree-db-1` → Status
- Check that `DATABASE_URL` uses `db` as hostname (the Docker service name), not `localhost`
- Check logs: Portainer → `tree-db-1` → Logs

### Media files missing after update

- Verify the `tree_media` volume is mounted: `docker inspect tree-api-1 | grep -A5 Mounts`
- If you forgot the volume mount on the first deploy, the files are in an anonymous volume.
  Find it: `docker volume ls` and look for an anonymous volume. Re-import the `.gpkg`.

### Port conflict on 8080

If another service uses 8080, change the port mapping in the compose file:

```yaml
ports:
  - "8090:8080"   # access via :8090, container still listens on 8080
```

### Container keeps restarting

Check logs: Portainer → `tree-api-1` → Logs. Common causes:
- `DATABASE_URL` not set or wrong password
- Database not ready yet (usually resolves with the `depends_on` healthcheck)
- `JWT_SECRET` not set (falls back to dev default with a warning, but works)

### "Private" data showing after reimport

Privacy is re-evaluated from the Gramps data on each import. If you see unexpected
"Private" labels, check birth dates against the privacy cutoff (born ≥ 1946-01-01 or age < 90).

---

## Appendix A: GitHub Actions workflow (optional)

Automate building and pushing the image on every push to `main`:

```yaml
# .github/workflows/docker.yml
name: Build and push Docker image

on:
  push:
    branches: [main]
    paths:
      - 'api/**'
      - 'sql/**'

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: ./api
          file: ./api/Dockerfile
          push: true
          tags: |
            ghcr.io/${{ github.repository_owner }}/tree:latest
            ghcr.io/${{ github.repository_owner }}/tree:${{ github.sha }}
```

Then on the server, Portainer just pulls `latest` — no manual build needed.

---

## Appendix B: Volume locations on disk

If you ever need to access the raw volume data on the Debian server:

```bash
# Find where Docker stores a named volume
docker volume inspect tree_pgdata --format '{{ .Mountpoint }}'
# Usually: /var/lib/docker/volumes/tree_pgdata/_data

docker volume inspect tree_media --format '{{ .Mountpoint }}'
# Usually: /var/lib/docker/volumes/tree_media/_data
```

---

## Appendix C: Complete file changes needed

### Files to create:

| File | Purpose |
|------|---------|
| `api/.dockerignore` | Keep image small |
| `docker-compose.prod.yml` | Production compose (deploy via Portainer) |

### Files to modify:

| File | Change |
|------|--------|
| `api/Dockerfile` | Add system deps, healthcheck, `.dockerignore` awareness |

### Files NOT to change:

| File | Reason |
|------|--------|
| `api/docker-compose.yml` | Keep for local dev |
| Any frontend/backend code | No code changes needed for Docker deployment |
