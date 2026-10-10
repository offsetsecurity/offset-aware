# Offset Aware

**Security awareness training for every employee**, running on your own
server. No cloud account, no third party, nothing leaves your network.

People sign in, watch the training and pass a quiz. Training runs out after
12 months (or whatever you set) and they are asked to do it again. You get a
record of who has done what and when, which is what an auditor asks for:
ISO 27001 clause 7.2 and control 6.3, SAMA 3.1.6 and 3.1.7, HIPAA
164.308(a)(5), and NIST awareness and training.

Offset Aware was called the ISO Training Portal. Upgrading keeps your data.

## What is in it

46 training videos in four packs. You choose which packs to install. Each video
has a quiz (80% to pass), switchable subtitles and a one-page summary.

| Pack | For | Courses |
|---|---|---|
| ISO 27001 | Any organisation working to ISO/IEC 27001:2022 | 13 |
| HIPAA | Vendors handling US health data for clients (business associates) | 7 |
| SAMA, banks | Banks regulated by the Saudi Central Bank | 19 |
| SAMA, finance companies | Finance companies regulated by the Saudi Central Bank | 7 |

You decide who each pack applies to: everyone, chosen people, or nobody. The
people it applies to take its all-staff courses. Role courses, such as those
for developers, HR, the board, auditors or fraud and AML teams, are added by
the jobs you give each person. Training is ticked when a person is added, or
for many people at once. The full list is in `docs/COURSE_CATALOGUE.md`.

Five shorter starter modules come with it as well: information security,
phishing, data privacy, incident reporting and secure coding (OWASP).

Plus:

- **Training that runs out**, 12 months after it is done unless you choose
  6, 24, 36 months or never, with the date shown for every module
- **A full history** of every completion, downloadable as a spreadsheet
- **Automatic reminders**: one email per module, 30, 15, 7 and 3 days before
  it is due, on the day, then daily. When it is overdue, up to four people
  (the administrator, their manager, their manager's manager, top management)
  are told in turn, each copying in the levels above
- **Staff import** from a spreadsheet, so you do not add hundreds by hand
- **Reminder emails** to whoever has not finished, over your own SMTP server
- **An admin screen** with the whole record, and a download of it
- **HTTPS**, with a certificate it makes for itself on the first run. Upload
  your company's own under **Settings → HTTPS certificate** and browsers stop
  saying "Not secure". It costs nothing

## Installing it

| You run | Read |
|---|---|
| Windows | `docs/install-page.md` - run `OffsetAware-x.y.z-setup.exe` and follow it |
| Windows, older route | `INSTALLATION.txt` - unzip, run `setup.bat`, fill in the wizard |
| Docker | `DEPLOYMENT.md` - `compose.yaml` and `env.example` in `deploy/docker` |

The Windows installer brings its own Node.js, so the server needs no other
software.

> **The internet is needed once, during installation.** The installer asks
> which training modules you want and downloads only those videos, from
> Offset Security's release page. That is the only time Offset Aware uses the
> internet: after setup it runs entirely on your server. On a server with no
> internet, untick them all and copy the videos in afterwards - Settings in
> Aware shows where.

Docker needs nothing but Docker. The image is built from the `Dockerfile` in
`deploy/docker`, or pulled from this repository's packages:

```
ghcr.io/offsetsecurity/offset-aware:latest
```

Whichever you use: **the first person to open Aware becomes the
administrator**, so open it yourself straight after installing.

## Where it installs, and where the data lives

On Windows, two folders, and only the second one matters to you:

```
C:\Program Files\Offset Security\Offset Aware     the program
C:\ProgramData\Offset Security\ISO Training Portal       your data
```

The data folder holds the database, the sessions, the HTTPS certificate and
the logs. Only administrators of the server can open it. The program folder can be replaced or
reinstalled at any time without touching it.

The folder you unzipped into is only a staging area and can be deleted.

On Docker, the same data lives in the `data` volume.

**Back up the data folder, or the volume.** Nothing in it can be recovered from
anywhere else.

Installs made before this ships keep their database beside the program. Running
`setup.bat` again moves it across for you.

## The rest of the documentation

| | |
|---|---|
| `docs/ADMIN_GUIDE.md` | Running it day to day |
| `docs/USER_MANUAL.md` | What staff see |
| `docs/RUNBOOK.md` | When something goes wrong |
| `docs/ARCHITECTURE.md` | How it is put together |
| `docs/SECURITY_ASSESSMENT.md` | How it was security tested, what was found and what was fixed |
| `docs/INTEGRATION_API.md` | Reading the records from elsewhere |
| `DEPLOYMENT.md` | Docker, reverse proxies, certificates |

## Licence

Closed source. Free to use under the licence in `LICENSE.md`. It may not be
modified, re-branded, sold, or run as a service for other companies.

---

**Offset Security** — Offset Risk. Enable Growth.
