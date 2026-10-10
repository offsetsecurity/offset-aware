# Deployment Guide

Aware is a stateful Node/Express app backed by SQLite, with server-side
sessions. It needs **persistent disk** — it will not run on
ephemeral-filesystem hosts (Vercel/Netlify) without migrating the database
to a managed service.

## How it is hardened

- Config comes from environment variables (`dotenv`) — see `.env.example`.
- Session secret read from `SESSION_SECRET` (app refuses to start in production
  if it's unset/default).
- Sessions persisted to `sessions.sqlite` via `connect-sqlite3` (survive restarts).
- Cookie `aware.sid`: `httpOnly`, `secure`, `sameSite=lax`, 8 hours. A new
  session is issued at every sign-in, and a session ends the moment its account
  is removed or has its password reset.
- A change sent from another website is refused (`Sec-Fetch-Site` / `Origin`).
- `trust proxy` enabled for running behind Nginx/Caddy/Render (HTTPS termination).
- `helmet` security headers, including a Content-Security-Policy that keeps out
  outside scripts, connections and framing. Inline scripts are still allowed.
- Sign-in rate-limited (10 attempts / 15 min / address); the API as a whole
  1,200 requests / minute / address.
- Quizzes are marked by the server. Course files need a sign-in; quiz files are
  never sent to a browser.
- The only upload is the staff list (CSV, 5 MB), read from memory and not kept.
- There are no built-in accounts. The first person to open Aware creates the
  administrator; after that the option is gone.

How this was tested is in `docs/SECURITY_ASSESSMENT.md`.

## Setup on the host

1. Copy `.env.example` to `.env` and fill it in:
   - `NODE_ENV=production`
   - `SESSION_SECRET=` a long random string:
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `PORTAL_URL=https://your-domain`
   - `DB_PATH=/data/database.sqlite` (point at your mounted persistent volume)
   - SMTP_* for real credential emails (otherwise Ethereal test links only)
2. `npm install --omit=dev` (or `npm ci`)
3. Run behind a process manager: `pm2 start server.js` or a `systemd` unit.
4. Put a reverse proxy in front for HTTPS (Caddy auto-TLS is simplest):
   proxy `your-domain` → `http://localhost:3000`.

## Host options

- **VPS** (Hetzner/DigitalOcean/Linode) + Caddy — best fit, disk "just works".
- **Render/Fly.io/Railway** + attached **persistent volume** mounted at `/data`.

## Backups

Schedule a regular copy of the data folder off-box
(e.g. a nightly cron to object storage). A disk failure otherwise loses
everything.

## Docker

Aware also runs as one Docker container. The files are in
`deploy/docker/`: the `Dockerfile` that builds the image, `compose.yaml` that
runs it, and `env.example` for its settings.

### Install

1. Make a folder, and put `compose.yaml` and `env.example` in it.
2. Copy `env.example` to `.env` and fill in `SESSION_SECRET` (the file says how
   to make one) and `PORTAL_URL`.
3. Get the image, one of three ways:
   - **Build it** from a copy of this repository:
     `docker build -f deploy/docker/Dockerfile -t offset-aware:1.0.0 .`
   - **Load it** from a file: `docker load -i offset-aware.tar.gz`
   - **Pull it from GitHub** (see below), and set `PORTAL_IMAGE` in `.env` to
     its name.
4. In the folder: `docker compose up -d`
5. Open `https://localhost:3000` (or your `PORTAL_PORT`) and create the
   administrator straight away. The first person to open it becomes the
   administrator.

### Where the data is

Everything Aware writes is in one Docker volume, `offset-aware_data`,
mounted at `/data`: the database, sessions, course packs, the HTTPS
certificate and the logs. Removing the container keeps it. **Never run
`docker compose down -v`**: `-v` deletes the volume and every record in it.

Back it up with:

```bash
docker run --rm -v offset-aware_data:/data -v "$PWD":/out alpine tar czf /out/portal-backup.tar.gz -C /data .
```

### Course packs

The image carries the five starter modules only. The ISO 27001, HIPAA and
SAMA courses are separate downloads, the packs on the
[training modules page](https://github.com/offsetsecurity/offset-aware/releases/tag/courses-2).

Sign in as the administrator, open **Settings → Course packs**, tick the packs
you want and click **Download and install**. Aware fetches each one, checks it
against its published checksum and unpacks it. Nothing restarts. A new pack
applies to nobody until you choose who, under **Settings → Training modules**.

Packs are kept in the data volume, in `/data/training` (the image sets
`TRAINING_DIR` to it), so an update does not lose them and a backup of the
volume includes them.

On a server with no internet, download the packs elsewhere, put them in a
folder called `packs` beside `compose.yaml`, and unzip them into the volume:

```bash
docker run --rm --user root -v "$PWD/packs:/packs:ro" -v offset-aware_data:/data ghcr.io/offsetsecurity/offset-aware:latest sh -c "mkdir -p /data/training ; find /packs -name '*.zip' -exec unzip -o -q {} -d /data/training \; ; chown -R portal:portal /data/training"
```

On Windows Command Prompt, write `"%cd%\packs:/packs:ro"` in place of
`"$PWD/packs:/packs:ro"`. A course counts once its video and its quiz are
both there.

### What is different from the Windows install

- The in-app **Update** button does not work in Docker. To update, get the new
  image and run `docker compose up -d` again. The data stays.
- The port is set by `PORTAL_PORT` in `.env`, not in Aware's settings.
- Forgot the admin password:
  `docker compose exec -it portal node reset_admin_password.js`
- Only the web server is in the image. The Windows service installer is not.

### The HTTPS certificate

Aware makes its own certificate the first time it starts, so browsers
warn until you give it a real one. Sign in as the administrator, open
**Settings → HTTPS certificate**, and upload the `.pfx` file (with its
password) or the certificate and key (`.pem`, `.crt`, `.key`) your IT team
issued. It is used at once; nothing restarts.

It is kept in the data folder, in `certs/uploaded-certificate.json`, so a
backup of the data folder includes the private key. Keep backups as private
as the server. A `.pfx` password is stored encrypted with a key derived from
`SESSION_SECRET`.

If a reverse proxy in front handles HTTPS instead, upload nothing: the proxy's
certificate is the one browsers see.

### The image on GitHub

On GitHub, **Actions → Build a Docker image → Run workflow** builds the image.
So does pushing a version tag: `git tag v1.0.1`, then `git push origin v1.0.1`.
Either way two images are stored as
`ghcr.io/offsetsecurity/offset-aware:<version>` and `:latest`, plus
`…-updater` beside them.

The updater is a second, small container that installs updates when an
administrator asks for one in Aware. A container cannot replace itself -
Aware would be swapping the image it is running inside - so that one does
it: it pulls the new image, restarts Aware, and puts the old image back if
the new one does not answer. Compose starts both, because `env.example` sets
`COMPOSE_PROFILES=updates`. Delete that line if your policy does not allow a
container access to the Docker socket; updating is then a pull and a restart by
hand.
To download it, the machine needs a classic GitHub token with only
**read:packages**:

```bash
docker login ghcr.io -u <your GitHub username>
docker pull ghcr.io/offsetsecurity/offset-aware:latest
docker pull ghcr.io/offsetsecurity/offset-aware-updater:latest
```

### Installed as the ISO Training Portal

Before the rename, the Docker project, its volumes and the images were all
called `iso-training-portal`. The images are no longer published under that
name, so an install made then goes on running but finds no updates until it is
moved to the new names.

Do not swap in the new `compose.yaml` on its own. The project name in it is
`offset-aware`, so Docker would start Aware on new, empty volumes and your
records would seem to be gone (they are not: they are still in
`iso-training-portal_data`).

To move an old install to the new names, in its folder:

```bash
docker compose down
docker volume create offset-aware_data
docker run --rm -v iso-training-portal_data:/from -v offset-aware_data:/to alpine cp -a /from/. /to/
```

`down`, never `down -v`. Then replace `compose.yaml` with the new one, set
`PORTAL_IMAGE=ghcr.io/offsetsecurity/offset-aware:latest` in `.env`, and run
`docker compose up -d`. Compose says the volume was not created by it; that is
expected. Once Aware is up and your records are there, the old volume can be
removed with `docker volume rm iso-training-portal_data`.
