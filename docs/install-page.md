# Installing Offset Aware

Security awareness training for every employee, on your own server. Course
packs for ISO 27001, HIPAA and SAMA (banks, or finance companies), each course
with a video, a quiz and a one-page summary, training that runs out after 12 months
and is done again, staff import from a spreadsheet, reminder emails, and a
full history of who did what and when for your ISO 27001, SAMA, HIPAA or NIST
auditor.

It runs on one machine, inside your network. No cloud account, and no
employee data leaves the building.

> **The internet is needed once: during installation, to download the
> training videos you choose.** That is the only time Offset Aware uses the
> internet. After setup it runs entirely on your server. A server with no
> internet at all can still be set up: see
> [No internet on the server](#no-internet-on-the-server).

## Before you start

| | |
|---|---|
| A server | 64-bit Windows. Docker also runs on Linux |
| A port | One. 3000 unless you choose another |
| A certificate | Not needed. It makes its own, so it always serves HTTPS |
| Internet | **During installation only**, to download the training videos you tick |

---

## Windows

1. Download **OffsetAware-x.y.z-setup.exe** from the release page and run it.
   It is not code-signed yet, so Windows says "Windows protected your PC":
   choose **More info**, then **Run anyway**
2. Accept the licence and choose a port. It fills in one nothing else is using
3. **Training modules.** Tick the course packs you want. Each shows its size.
   The ISO 27001 pack is ticked to start with.

   | Pack | For | Courses | Download |
   |---|---|---|---|
   | ISO 27001 | Any organisation working to ISO 27001 | 13 | 189 MB |
   | HIPAA | Vendors handling US health data for clients | 7 | 133 MB |
   | SAMA, for banks | Banks regulated by SAMA | 19 | 402 MB |
   | SAMA, for finance companies | Finance companies regulated by SAMA | 7 | 58 MB |

   What is in each pack, and who takes which course, is in the
   [course catalogue](COURSE_CATALOGUE.md). The five "Older course" rows are
   the courses earlier versions had; new installs don't need them.

   **This step downloads the ticked packs from Offset Security's release
   page, so the server needs the internet for it. It is the only time Offset
   Aware uses the internet.** Each file is checked before it is used
4. Click **Install**. The videos download, then Offset Aware installs as a
   Windows service, so it starts with the machine
5. The first person to open it creates the administrator account

The shortcut on your desktop opens it. Your staff open the same address from
their own computers.

Your data is kept in:

    C:\ProgramData\Offset Security\ISO Training Portal

The folder kept the product's old name, so upgrades find it. Back it up and
you have backed up every training record.

**To remove it:** Settings, then Apps, then Offset Aware, then Uninstall.
Your training records are left behind on purpose.

### No internet on the server

Untick every module on the **Training modules** page and install. Then, on a
computer that does have the internet:

1. Download the packs you want (the `pack-....zip` files) from the training
   modules page, `github.com/offsetsecurity/offset-aware/releases/tag/courses-2`
2. Copy them to the server and unzip them into the folder
   **Settings → Training modules** shows, keeping the file names
3. Reload Aware. The courses appear straight away

### Adding a module later

Run the installer again and tick it. Your data, port and settings are kept,
and modules already on the server are not downloaded again.

---

## Docker

Docker runs Aware without installing Node.js or anything else on the
machine, and it works the same on Windows and Linux. The Docker image contains
the five original courses. The course packs are not in the Docker image yet:
for ISO 27001, HIPAA or SAMA packs, use the Windows installer for now.

**If you have never used Docker, follow the step-by-step guide instead:
[Offset Aware on Docker](docker-guide.md).** It starts with
installing Docker itself and says what you should see after every command.

The short version, for somebody who knows Docker already:

1. Take `compose.yaml` and `env.example` from `deploy/docker` in the download
2. `cp env.example .env`, then fill in the one secret it asks for
3. Set `PORTAL_URL` to the address your staff will use, and `PORTAL_PORT`
4. `docker compose up -d`

That pulls two images - Aware and its updater - and starts it. Pulling them
needs the internet, once.

```
ghcr.io/offsetsecurity/offset-aware
ghcr.io/offsetsecurity/offset-aware-updater
```

An install made when the images were called `iso-training-portal` moves to
these names as DEPLOYMENT.md describes.

Your data lives in a Docker volume, so it survives stopping and restarting.
`docker compose down` keeps it; `down -v` deletes it, with no undo.

---

## After installing

Open the address in a browser. It serves HTTPS with a certificate it made for
itself, so the browser warns you: choose **Advanced**, then **Proceed**. The
connection is still encrypted.

To stop the warning for everyone, upload your company's own certificate under
**Settings → HTTPS certificate**. Your IT team issues it, for free.

Sign in as the administrator you created, then:

1. **Settings → Email** - point it at your mail server, so it can send
   reminders and password resets
2. **Settings → How long training stays valid** - 12 months unless you choose
   otherwise
3. **Settings → Training modules** - say who each set of training applies
   to: everyone, chosen people, or nobody. On Docker, add the course packs
   you want first, under **Settings → Course packs**
4. **Add people** - import your staff from a spreadsheet, or add them by hand,
   and tick the training that applies to each: a whole set, their **job** (for
   example "IT", "Branch, call centre and collections" or "Board and senior
   management"), or single courses. Change it later with **Training** on the
   Employees screen, or tick several people there and click **Assign training
   to selected**. **Settings → Jobs** lists what each job adds
5. **Tell staff your contacts** - the one-page summaries have blank lines for
   your own contacts, such as where to report fraud, for staff to fill in
   when they print them

Staff sign in, watch each video, pass the quiz after it, and tick the
acknowledgement. You see who has finished, who has not, and whose training
runs out soon.

## Updating it

**Settings** shows the version and checks for a newer one when you click
**Check for updates**. That check asks the internet, and only when you click.

- On Windows, download the new installer and run it. It keeps your database,
  your settings and the training videos already on the server.
- On Docker, **Install update** does it for you, and puts the old version back
  if the new one does not start.

## Getting help

**DEPLOYMENT.md** and **INSTALLATION.txt** come in the download and cover the
rest: certificates, mail, backups, and what to do when something goes wrong.

info@offsetsecurity.net
