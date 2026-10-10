# Offset Aware Security Assessment

Security assessment report · Version 1.0

Offset Aware: security awareness training for staff, on the customer's own
server. The assessment covered: a check of every route for every role, attack
scans as an outsider, as a member of staff and as an administrator, browser
attack tests, code analysis with CodeQL and Semgrep, a secrets scan, package and
container checks, a component list (SBOM), a review of the Windows installer and
service, and an OWASP ASVS checklist.

| | |
| --- | --- |
| Prepared by | Offset Security |
| Contact | info@offsetsecurity.net |
| Assessment date | 10 October 2026 |
| Version assessed | Offset Aware 1.3.0 |
| Report version | 1.0 |

**Overall result: no open critical, high or medium issues.** The assessment
found fifteen issues: three high, four medium and eight low. Twelve are fixed
and re-tested in this release. Two low-severity design choices are accepted,
with reasons. One low-severity item is open and waits on a fix from Docker: it
is in the optional updater image only. Every route was checked for every role:
none lets the wrong person in. Two OWASP ASVS items remain open: multi-factor
sign-in and a breached-password check.

| 15 | 12 | 46 | 0 | 0 |
| --- | --- | --- | --- | --- |
| issues found | fixed and re-tested | routes checked for every role | secrets in the code | known vulnerable components in Aware and its Docker image |

## 1. Scope

| Product | Version assessed |
| --- | --- |
| Offset Aware | 1.3.0, as released with the fixes below |

Offset Aware runs on Node.js 24 with Express and SQLite, and serves one web
page. In scope: the source code, the shipped components, the running
application (as an outsider, as a member of staff and as an administrator), the
Docker images, the Windows installer and service scripts, and the build
pipeline. Not in scope: the customer's own servers, networks and mail server.

## 2. How the assessment was done

| Activity | Tool | What it covered | Result |
| --- | --- | --- | --- |
| Access-control matrix | Automated test | 46 routes: 41 need a sign-in (37 of them an administrator), 5 are public by design. 41 signed-out refusals and 37 staff refusals | No route lets the wrong person in |
| Attack checks | Automated test, 36 checks | Training claimed without doing it, quiz answers, course files, cross-site requests, sessions, cookies, headers, uploads, injection, password rules, sign-in limits | 10 failed before the fixes. After: 35 pass; the one that does not is the accepted inline-script policy (AW-13) |
| Dynamic scan by role | OWASP ZAP 2.17.0: spider, passive and active scan | As an outsider, and every route attacked as an outsider, as staff and as an administrator | No vulnerability. Over a hundred attack strings sent as an administrator were stored as plain text; the database was intact and nobody gained a role. One SQL injection alert was checked by hand and ruled out (section 4). Two missing headers and three loose error answers were tightened (AW-12); the inline-script policy is accepted (AW-13) |
| Browser attack tests | Playwright 1.63, real browser | A script payload in a person's name and ID, then every administrator screen; a formula in a name, then the export; the quiz taken on screen, wrongly and rightly | No script ran. The formula stayed text. The server did the marking |
| Deep code analysis | GitHub CodeQL 2.27.2, security-extended queries | The server, the page, the installer and updater scripts, the tests | 35 alerts before. 2 genuine (AW-05, AW-08) and several hardening items, fixed. 19 remain, all ruled out (section 4) |
| Static analysis | Semgrep 1.179.0 | 49 source files, the Dockerfile and the build pipeline | 18 alerts before. After: 2, both ruled out (section 4) |
| Secrets scan | Gitleaks 8.30.1 | The code and its Git history | None. One alert, ruled out (section 4) |
| Docker image scan | Trivy 0.75.0 | The image as built, every layer | Before: 33 known vulnerabilities (18 high). After: 0 |
| Docker configuration | Trivy configuration checks | The Dockerfile | 27 of 27 checks passed |
| Component list (SBOM) | npm and Trivy, CycloneDX format | 181 components in the application; 187 in the Docker image | 0 known vulnerabilities |
| Component audit | npm audit, Trivy | The lockfile every build installs from | 0 |
| Windows service and permissions | Manual review and icacls tests | Installer, service, data-folder and settings-file permissions | 1 genuine issue (AW-02), fixed |
| Regression tests | Playwright | 63 automated tests, 12 of them new security tests | All passing |

Severity: **Critical** (exploitable now with serious impact), **High** (a
realistic path to account or data compromise, or to false training records),
**Medium** (weakens a protection, or needs other conditions), **Low**
(hardening), **Informational**. All dynamic tests ran on throwaway copies, never
on a customer installation.

## 3. Findings

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| AW-01 | High | Staff could record training as passed without doing it | Fixed |
| AW-02 | High | Windows data folder open to every local user, and the settings file readable | Fixed |
| AW-03 | High | Upload component with known flaws | Fixed |
| AW-04 | Medium | Quiz answers and course files open without signing in | Fixed |
| AW-05 | Medium | Changes accepted from other websites | Fixed |
| AW-06 | Medium | Docker image carried build tools with known flaws | Fixed |
| AW-07 | Medium | Update script downloaded and ran unchecked code | Fixed |
| AW-08 | Low | Sessions were not renewed at sign-in, and outlived the account | Fixed |
| AW-09 | Low | Sign-in: timing, no per-account limit, short passwords allowed | Fixed |
| AW-10 | Low | Build pipeline: typed input run as a command; actions not pinned | Fixed |
| AW-11 | Low | Spreadsheet formula injection in the starting-passwords download | Fixed |
| AW-12 | Low | Smaller hardening items | Fixed |
| AW-13 | Low | Content Security Policy permits inline scripts and styles | Accepted |
| AW-14 | Low | "Video watched" is taken on the browser's word | Accepted |
| AW-15 | Low | Docker's own compose tool, in the optional updater image, has known flaws | Open |

### AW-01 · Staff could record training as passed without doing it

High · Fixed

**What was wrong.** Three things let any signed-in member of staff finish any
course without taking it. The quiz was marked in the browser, and the server
recorded whatever score the browser reported. The answers were in the page for
anyone to read. And a route left over from an earlier design accepted any file
and recorded the course as completed; no screen used it, but it still answered.
For a product whose purpose is evidence that staff were trained, this is the
most serious finding.

**Fix.** The server now keeps the answers and does the marking. The page is
given the questions without the answers, in a fresh order each time, and sends
back what the person chose. The routes that accepted a reported score, and the
upload route, are removed. Every attempt, passed or failed, is recorded as
marked by the server.

**Verified by.** Attack checks that report a perfect score and upload a file:
both are refused and the course stays incomplete. A browser test takes the quiz
on screen, fails it with wrong answers, then passes it with right ones.

### AW-02 · Windows data folder open to every local user

High · Fixed

**Affects.** The Windows installer.

**What was wrong.** The installer gave the built-in Users group change rights
on the data folder under ProgramData. That folder holds the database (staff
names, email addresses and password hashes), the live sign-in sessions and the
private key of the HTTPS certificate. The settings file, which holds the secret
that signs the sign-in cookie, sat in Program Files, where every local user can
read. Anyone who could sign in to the server, even without administrator
rights, could copy the records, edit the database to make themselves an
administrator, or forge a sign-in.

**Fix.** The installer no longer opens the folder. A new script grants full
control to SYSTEM and Administrators only, removes Users, Authenticated Users,
Everyone and CREATOR OWNER from the folder and everything in it, and stops
inheriting wider rights from ProgramData. It does the same for the settings
file. It runs on every install and upgrade, so existing installations are
closed too. Well-known security IDs are used, so it works on Windows in any
language.

**Verified by.** The script was run on a throwaway folder that started with
the old, open permissions. Afterwards only SYSTEM and Administrators remained
on the folder, on the files already in it, and on a file created later.

### AW-03 · Upload component with known flaws

High · Fixed

**What was wrong.** The component that handles file uploads (multer 1.4.5) had
eleven published advisories, most of them ways to crash or stall the server
with a malformed upload. Uploading needed a sign-in.

**Fix.** Updated to multer 2.4.0. The only upload Aware still takes is the
staff list, from an administrator; it is read from memory and never written to
disk.

**Verified by.** Trivy and npm audit report no known vulnerabilities in the
lockfile or the image.

### AW-04 · Quiz answers and course files open without signing in

Medium · Fixed

**What was wrong.** The training folder was served to anyone who knew the
address, signed in or not: the videos, and the quiz files of every course pack,
which contain the answers.

**Fix.** Course videos, subtitles and summaries now need a sign-in. Quiz files
and job lists are never sent to a browser at all, to anyone.

**Verified by.** Tests ask for a video and a quiz file signed out (refused),
and for the quiz file as staff and as an administrator under five different
spellings of its name (not found each time).

### AW-05 · Changes accepted from other websites

Medium · Fixed

**What was wrong.** Aware relied on the browser's SameSite cookie setting alone
to stop another website from sending requests in a signed-in person's name
(cross-site request forgery). CodeQL flagged the missing check.

**Fix.** Every request that changes something must come from Aware's own
pages. The server reads where the browser says the request was sent from
(`Sec-Fetch-Site`, and `Origin` for older browsers) and refuses anything sent
by another site, whatever cookie it carries.

**Verified by.** Tests send the same change marked as cross-site, as a sibling
site, and with a foreign origin: all refused. From Aware itself: accepted.

### AW-06 · Docker image carried build tools with known flaws

Medium · Fixed

**What was wrong.** The image included npm and related build tools from its
base image. Nothing in Aware runs them, but they carried 21 known
vulnerabilities, and one operating-system package was behind by a fix.

**Fix.** The build tools are removed from the image and the operating-system
packages are brought up to date when it is built. The application's files in
the image are now owned by root, so the running application, which runs as an
unprivileged user, cannot change its own code.

**Verified by.** Trivy scan of the built image: 33 known vulnerabilities
before, 0 after. Components in the image: 344 before, 187 after.

### AW-07 · Update script downloaded and ran unchecked code

Medium · Fixed

**Affects.** Installations made from the zip file. Not Docker, and not the
Windows installer.

**What was wrong.** On those installations the "Install update" button ran a
script that fetched the newest code from the internet and installed it with
full system rights, without checking what it had fetched.

**Fix.** The script is removed. Outside Docker, Aware never fetches and runs
new code by itself: the page says where to download the new installer. In
Docker, updates still go through the separate updater container, which takes
the image published for that release.

### AW-08 · Sessions were not renewed at sign-in, and outlived the account

Low · Fixed

**What was wrong.** Signing in kept the session the browser already had, so a
session planted beforehand would become a signed-in one (session fixation).
A session also stayed valid for up to eight hours after its account was
removed or its password reset. The cookie used the framework's default name.

**Fix.** Every sign-in starts a new session. Each request checks that the
account still exists and has not had its password reset; if not, the session
ends there. The cookie has its own name and is always marked Secure, HttpOnly
and SameSite.

**Verified by.** Tests check the cookie's settings, and that a signed-in
person is refused on their very next request after being removed.

### AW-09 · Sign-in hardening

Low · Fixed

**What was wrong.** An unknown ID was refused faster than a wrong password, so
valid IDs could be told apart by timing. Wrong passwords were limited per
network address only, not per account. New passwords needed only 8 characters.

**Fix.** An unknown ID now takes as long to refuse as a wrong password. Ten
wrong passwords for one ID in fifteen minutes lock that ID for the rest of the
fifteen minutes, wherever the attempts come from. New passwords need 12
characters.

**Verified by.** An attack check sends wrong passwords for one ID: the
eleventh is refused as locked, while another ID still gets the ordinary answer.

### AW-10 · Build pipeline

Low · Fixed

**What was wrong.** In the release pipeline, the version typed into a form was
pasted into a script, where it could have run as a command. Only people with
write access to the repository can use that form. The third-party build
actions were named by version labels their publishers can move.

**Fix.** The typed version is passed as data and checked before use. Every
action is pinned to the exact commit it was checked at.

### AW-11 · Spreadsheet formula injection in the starting-passwords download

Low · Fixed

**What was wrong.** After a staff list is imported, the administrator can
download the starting passwords as a spreadsheet. A name starting with `=`,
`+`, `-` or `@` was written unchanged, and a spreadsheet would run it as a
formula. The training history export already guarded against this; this
download did not.

**Fix.** Such values are prefixed with an apostrophe, so they stay text.

### AW-12 · Smaller hardening items

Low · Fixed

- The API as a whole now has a ceiling on requests per address, not only the
  sign-in.
- Line breaks are stripped from anything written to the log, so nobody can
  forge a log line.
- Errors tell the caller only what they can act on. A garbled request or
  upload is answered as a bad request; an unexpected error goes to the log,
  not to the browser.
- The session secret written by the installers now comes from Windows'
  cryptographic random generator.
- Two response headers were added: one switching off the browser's device
  features (camera, microphone, location and so on), which Aware does not use,
  and one stopping the page loading anything from another site.
- An address that does not exist now answers "not found" instead of the page.
- A sign-out, like any other change, is refused if sent from another site.

### AW-13 · Content Security Policy permits inline scripts and styles

Low · Accepted

**Reason for accepting.** The page's scripts and click handlers are written
into the page itself, which needs `script-src 'unsafe-inline'`. Everything else
is locked to the application: no outside scripts, styles, fonts, connections or
framing. The protection against injected scripts is therefore the escaping of
everything a person can type, and the browser attack tests confirm that a
script payload in a name or ID is shown as text on every screen and never
runs. Moving the scripts out of the page, so the policy can refuse inline
scripts, is recommended for a later release (section 8).

### AW-14 · "Video watched" is taken on the browser's word

Low · Accepted

**Reason for accepting.** A browser cannot prove that a person watched a
video. Aware records that the video finished because the page says so. The
control that counts is the quiz, which is now marked on the server (AW-01): a
course is complete only when the quiz is passed as well.

### AW-15 · Docker's compose tool in the updater image

Low · Open

**Affects.** The optional updater container only (Docker installations that
turn on in-app updates). Not the Aware image.

**What is open.** The updater includes Docker's own command-line and compose
tools, taken from Docker's official image. Trivy reports known vulnerabilities
in the compose tool's Go libraries (4 high, 7 medium, 1 low by their published
ratings). The newest compose release (5.6.0) still contains them, so there is
no fixed version to move to yet.

**Why it is rated low here.** The updater serves no page and listens on no
port. It runs the compose tool only against the local Docker service and the
image registry, over HTTPS. Reaching these flaws would need control of one of
those.

**Plan.** The image is rebuilt from Docker's current tools at every release,
so the fix arrives with the first release after Docker publishes it.

## 4. Alerts investigated and ruled out

| Alert | Tool | Where | Why it is not a vulnerability |
| --- | --- | --- | --- |
| Cookie middleware without CSRF protection | CodeQL | Session set-up | CodeQL looks for a token. Aware checks where each request was sent from instead (AW-05), which OWASP accepts, and the tests confirm cross-site changes are refused. |
| Path depends on a user-provided value | CodeQL | Reading a course's quiz file | The course ID must match a strict pattern (lower-case letters, digits and hyphens) and belong to an installed course before it is used in a file name. |
| Property name depends on a user-provided value | CodeQL | Saving who a course is for | The name is a course ID that has already been checked against the installed courses. |
| Loop over user-controlled length (2) | CodeQL | Reading the imported staff list | Administrator only, and the file is limited to 5 MB. |
| Log entry depends on a user-provided value (3) | CodeQL | Request log and log writer | Line breaks are now stripped before writing (AW-12). CodeQL does not recognise that form of the fix. |
| File may have changed since it was checked (5) | CodeQL | Log files, certificate files and the updater's note at start-up | These check that the product's own files exist, in folders only the product and administrators can write to. |
| Write to file depends on untrusted data (4) | CodeQL | Log writer; saving an uploaded HTTPS certificate; the update request | Each is the feature working as intended, for an administrator, writing to a fixed file name. The certificate is validated before it is kept. |
| Route is not rate-limited | CodeQL | Serving the page itself | A small static page. The API behind it is rate-limited. |
| Misleading regular expression | CodeQL | One test file | A test's own pattern; not part of the product. |
| Session cookie has no domain / no expires (2) | Semgrep | Session set-up | Leaving the domain unset limits the cookie to the exact host, which is the stricter choice. The lifetime is set (8 hours) by `maxAge`. |
| Generic API key | Gitleaks | `PASSWORD_LETTERS` in the server | The alphabet that starting passwords are drawn from, not a key. |
| SQL injection | ZAP | The reminder history, `limit` in the address | The scanner sent two SQL conditions and saw different answers. The value is turned into a whole number and passed to the database as a parameter, never as SQL. Sent again by hand, both conditions, and a `DROP TABLE`, gave the identical single row. The answers differed during the scan because the scan itself was adding rows to that history. |
| Source code disclosure, SQL (2) | ZAP | Staff lists read by an administrator | The scanner saw the text `DROP TABLE users`. It is a test person's name, put there by the attack checks and stored as text, being shown back. No code is disclosed. |
| Server error and error disclosure (3) | ZAP | "Send test email" | When the mail server cannot be reached, the administrator who pressed the button is shown the mail server's own message, so they can correct the settings. Administrators only. |
| Mail server address can be any host | ZAP | Email settings | Only an administrator can set it, and pointing Aware at the company's mail server is its purpose. |
| Suspicious comments; timestamp disclosure; cache-control and "modern web application" notes | ZAP | The page and its PDF library | Informational notes from the scanner. The comments hold nothing sensitive; the "timestamps" are numbers inside a library. |

## 5. Access-control matrix

An automated check lists every route the server registers and who may use it,
then tries each one as each kind of caller. On the assessed version it
confirmed:

- Only 5 routes answer without signing in: sign-in, the first-run check,
  first-administrator setup, the forced change of a starting password, and
  sign-out.
- All 41 other routes refuse a signed-out caller.
- All 37 administrator routes refuse a signed-in member of staff.
- First-administrator setup refuses once an administrator exists, so it cannot
  be used to take over a running installation.
- A member of staff cannot create accounts, read other people's records, or
  reach any file outside the course files they are allowed to watch.
- Every route that changes something refuses a request sent from another
  website.

## 6. OWASP ASVS 4.0.3 checklist

A summary against the Application Security Verification Standard, level 2, with
the evidence for each area.

| Area | Status | Evidence |
| --- | --- | --- |
| V1 Architecture | Met | Role checks on every route, on the server; data folder closed to ordinary users (AW-02); Docker image runs unprivileged and cannot change its own code. |
| V2 Authentication: password storage and rules | Met | bcrypt hashing; 12-character minimum; rate limits per address and per account (AW-09); random starting passwords that must be changed at first sign-in. |
| V2.1.7 Breached-password check | Open | Passwords are not checked against a list of known breached passwords. Aware runs offline, so this needs a bundled list. |
| V2.8 Multi-factor sign-in | Open | No second factor (such as an authenticator app) yet. Required at ASVS level 2. |
| V3 Session management | Met | New session at every sign-in; HttpOnly, SameSite and Secure cookie; sign-out, removal and password reset end the session on the server (AW-08). |
| V4 Access control | Met | Full route-by-role matrix (section 5); ZAP scans as each role. |
| V5 Validation and encoding | Met | Parameterised SQL; script payloads shown as text; CSV formula guard (AW-11). |
| V6 Cryptography | Met | The stored mail password is encrypted with AES-256-GCM with full-length tags; secrets come from a cryptographic random generator. |
| V7 Errors and logging | Partly | Errors reveal nothing internal and log lines cannot be forged (AW-12). The log records administrator actions on accounts, certificates and settings, but there is not yet a full audit trail of every sign-in and change. |
| V8 Data protection | Met | API answers are never cached; the imported staff list is not kept on disk; data folder closed (AW-02). |
| V9 Communications | Met | HTTPS always, with the customer's own certificate once uploaded; plain HTTP is redirected; HSTS. |
| V10 Malicious code | Partly | Secrets scan clean; no code is fetched at run time (AW-07); course packs are checked against a SHA-256 before use. The Windows installer is not yet code-signed. |
| V11 Business logic | Met | Quizzes marked on the server; a course cannot be completed by claiming it (AW-01). |
| V12 Files | Met | One upload (the staff list): type and size limited, read from memory, never stored or served. |
| V13 API | Met | Cross-site changes refused on every route (AW-05); JSON only; unknown addresses answer "not found". |
| V14 Configuration | Met | Content Security Policy (inline scripts accepted, AW-13); 0 vulnerable components in Aware and its image; SBOM with every release; Dockerfile checks passed; build actions pinned (AW-10). |

## 7. Limits of this assessment

- This is an automated assessment with expert review of every alert. It does
  not replace a manual penetration test by an independent firm.
- The Windows permission fix was tested on a throwaway folder, not by running
  the finished installer on a clean Windows machine. The installer is built by
  the release pipeline.
- The Windows service still runs as the system account. It works, and the
  data is closed to ordinary users, but a less privileged account is better
  practice (section 8).
- The installer was not scanned with an antivirus engine and is not yet
  code-signed.
- Sending real email was not tested: the tests point Aware at a closed port so
  nothing is ever sent.

## 8. Recommendations

- **Add multi-factor sign-in** (an authenticator app) to meet ASVS level 2 in
  full. Banks and healthcare customers often ask for it.
- **Add a breached-password check** with a bundled list, so it works offline.
- **Move the page's scripts into files**, so the Content Security Policy can
  refuse inline scripts (AW-13).
- **Run the Windows service as a less privileged account** (LOCAL SERVICE),
  as the other Offset products do.
- **Add a full audit trail** of sign-ins and administrator changes.
- **Rebuild the updater image** as soon as Docker publishes a fixed compose
  tool (AW-15).
- **Commission an independent penetration test** before a bank or hospital
  deployment.
- **Code-sign the Windows installer**, scan it with a multi-engine service,
  and turn on GitHub code scanning, secret scanning and Dependabot.

## Appendix: results before and after the fixes

| Check | Before | After |
| --- | --- | --- |
| Attack checks failing | 10 of 30 | 1 of 36 (accepted, AW-13) |
| Known vulnerabilities in the Docker image (Trivy) | 33 (18 high) | 0 |
| Known vulnerabilities in the lockfile (Trivy, npm audit) | 11 | 0 |
| Components in the Docker image | 344 | 187 |
| CodeQL alerts | 35 | 19, all ruled out |
| Semgrep alerts | 18 | 2, both ruled out |
| Secrets found (Gitleaks) | 0 | 0 |
| Dockerfile checks passed (Trivy) | 27 of 27 | 27 of 27 |
| Automated tests | 51 passed | 63 passed |

The component list (SBOM) is published with the release as
`offset-aware-1.3.0.sbom.cdx.json`.

Offset Security · info@offsetsecurity.net · Assessment of 10 October 2026 · Report version 1.0
