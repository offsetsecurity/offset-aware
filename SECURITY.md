# Security Policy

## Reporting a vulnerability

Email **security@offsetsecurity.net** with:

- what the problem is and what it lets someone do,
- the version you are running (see `package.json`, or the foot of Aware's menu),
- how to reproduce it, and
- any proof-of-concept.

Please do not open a public issue for a security report.

**What we do:** acknowledge within 3-5 business days, assess within 10 business
days, and fix or document a way round it within 90 days for anything confirmed.
We will credit you by name if you want that.

## How Aware is built

- HTTPS always. It makes its own certificate on the first run. An
  administrator replaces it with the company's own under Settings → HTTPS
  certificate: it is checked first (the key must match, it must be in date,
  RSA keys under 2048 bits are refused) and used without a restart. Plain
  `http://` on the same port is redirected to `https://`.
- Passwords hashed with bcrypt. Sign-in is rate limited per address.
- Sessions in their own database, signed with `SESSION_SECRET`, which the
  portal refuses to start without in production. Every sign-in gets a new
  session; removing an account or resetting its password ends its sessions.
- Admin and staff are separate roles, checked on every request, not in the page.
- A change sent from another website is refused.
- Quizzes are marked by the server. The answers never reach a browser, and a
  course cannot be finished by telling the server it was.
- Course videos are only for people who are signed in.
- On Windows, the data folder and the settings file can be opened only by
  administrators of the server. In Docker, Aware runs as an unprivileged user
  and cannot change its own code.
- It runs entirely on your server. Nothing is sent anywhere, and it needs no
  internet connection to work. The only outbound traffic is the reminder email
  it sends through the SMTP server you configure.

`docs/SECURITY_ASSESSMENT.md` records how each release is tested, what was
found and what was done about it. Each release carries a software bill of
materials (`offset-aware-<version>.sbom.cdx.json`).

## What is in scope

Aware itself: the server, the admin screens, the staff screens, the
installer and the Docker image in this repository.

Not in scope: your own SMTP server, your reverse proxy, the operating system it
runs on, or a machine that someone already has administrator access to.
