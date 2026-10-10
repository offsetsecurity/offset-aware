# Integration API — Design Specification

**Status:** Superseded on 2026-09-19. The decision is a standalone portal with
no link to another product.
Kept for the record. · **Version:** 0.1 · **Scope:** Inbound, read-only

This document specifies a machine-to-machine (M2M) API that lets another
on-premise system **read** compliance and training data from the ISO Training
Portal. It is a design proposal — no code has been written yet.

---

## 1. Goals & non-goals

**Goals**
- Let a trusted internal system (e.g. an HRIS, GRC platform, or SIEM) pull
  employee training-completion status on a schedule or on demand.
- Authenticate callers without a browser session (no cookies, no login form).
- Keep the machine-facing surface small, explicit, and separately auditable
  from the existing browser API.

**Non-goals (this version)**
- No write access — the peer tool cannot create users, mark completions, or
  change settings. (Inbound-write and outbound-webhooks are deferred; see §9.)
- No per-employee OAuth or user-delegated access. This is a service-to-service
  key, acting with read access to compliance data.

---

## 2. Design principles (grounded in the current app)

Aware is already an Express JSON API (`server.js`). This spec adds to it
rather than rebuilding:

| Existing building block | Reused for the integration API |
|---|---|
| `requireAdmin` guard pattern (`server.js:216`) | New `requireApiKey` guard, same shape |
| `settings` key/value table (`server.js:204`) | Stores the hashed API key |
| AES helpers + `crypto` (`server.js:19-42`) | Key hashing / constant-time compare |
| `express-rate-limit` (`server.js:102`) | A dedicated limiter for the API namespace |
| `helmet`, `trust proxy`, HTTPS (`server.js:70,79,737`) | Unchanged — API inherits them |

**Separation:** all integration endpoints live under a distinct namespace,
`/api/integration/v1/*`, so they never share middleware or accidental exposure
with the browser routes under `/api/*`.

---

## 3. Authentication

**Scheme:** static bearer token (API key) sent on every request.

```
Authorization: Bearer <api-key>
```

- The key is generated in the **admin UI** (reusing the existing admin settings
  screen and the `POST /api/admin/smtp`-style save pattern).
- Only a **hash** of the key is persisted, in `settings` under
  `key = 'integration_api_key_hash'`. The raw key is shown **once** at creation
  and never stored or logged.
- Verification uses `crypto.timingSafeEqual` against the stored hash to avoid
  timing attacks.
- Rotating the key = generate a new one (overwrites the hash); the old key stops
  working immediately.

**Proposed middleware (illustrative, not final):**

```js
const requireApiKey = (req, res, next) => {
    const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!provided) return res.status(401).json({ error: 'Missing API key' });
    const providedHash = sha256(provided);              // Buffer
    if (storedHash && providedHash.length === storedHash.length
        && crypto.timingSafeEqual(providedHash, storedHash)) {
        return next();
    }
    return res.status(403).json({ error: 'Invalid API key' });
};
```

> **Why not reuse `requireAdmin`?** That guard reads `req.session.role`, which
> only exists after an interactive cookie login. A peer tool has no session, so
> it needs a token guard instead.

---

## 4. Endpoints (v1)

All paths are prefixed `/api/integration/v1`. All responses are JSON. All
require `requireApiKey`.

### 4.1 `GET /health`
Liveness + auth check. Returns portal version and server time. Useful for the
peer tool to validate its key and connectivity before syncing.

```json
{ "status": "ok", "version": "1.0.0", "server_time": "2026-07-13T09:00:00Z" }
```

### 4.2 `GET /training-status`
The primary endpoint: every employee and their per-module completion status.
This mirrors the data already assembled by `GET /api/admin/records`
(`server.js:376`), reshaped for machine consumption.

**Query parameters (optional)**

| Param | Type | Meaning |
|---|---|---|
| `emp_id` | string | Return a single employee instead of all |
| `module` | string | Filter to one module (see §5 for valid IDs) |
| `status` | string | Filter to `completed` / `pending` |
| `updated_since` | ISO-8601 date | Only records changed on/after this date (for incremental sync) |

**Response**

```json
{
  "generated_at": "2026-07-13T09:00:00Z",
  "count": 2,
  "employees": [
    {
      "emp_id": "E1001",
      "name": "Asha Rao",
      "email": "asha.rao@example.com",
      "modules": {
        "infosec":       { "status": "completed", "completion_date": "2026-06-30" },
        "phishing":      { "status": "completed", "completion_date": "2026-07-02" },
        "privacy":       { "status": "pending",   "completion_date": null },
        "incident":      { "status": "pending",   "completion_date": null },
        "secure_coding": { "status": "pending",   "completion_date": null }
      }
    }
  ]
}
```

### 4.3 `GET /employees`
Roster only (no training data): `emp_id`, `name`, `email`. For systems that just
need to reconcile who exists in Aware.

> **Deliberately excluded from v1:** certificate file downloads, password fields,
> SMTP settings, and anything under `/api/admin/*`. The integration surface
> exposes compliance status only.

---

## 5. Data model reference

Backed by the existing SQLite schema (`server.js:171-208`):

- **users** — `emp_id`, `name`, `email`, `role` (only `role = 'employee'` is
  returned).
- **training_records** — `module_id`, `status` (`pending` | `completed`),
  `completion_date`.

**Valid `module_id` values** (from `server.js:393-397`):
`infosec`, `phishing`, `privacy`, `incident`, `secure_coding`.

An employee with no record for a module is reported as `pending` with a null
date, so the peer tool always sees all five modules per employee.

---

## 6. Errors

Consistent JSON envelope, standard HTTP status codes:

| Status | When | Body |
|---|---|---|
| 200 | Success | data |
| 400 | Bad query param (e.g. unknown `module`) | `{ "error": "..." }` |
| 401 | Missing `Authorization` header | `{ "error": "Missing API key" }` |
| 403 | Invalid key | `{ "error": "Invalid API key" }` |
| 429 | Rate limit exceeded | `{ "error": "Too many requests" }` |
| 500 | Server/DB error | `{ "error": "..." }` |

---

## 7. Security considerations

- **Transport:** HTTPS only (the server already runs TLS with a self-signed
  cert, `server.js:737`). The peer tool must trust that cert or be given an
  internal CA-signed one.
- **Network scope:** the server binds `0.0.0.0`. For an internal API, restrict
  reach by firewalling the port to the peer tool's IP, keeping both on a trusted
  VLAN, or (if co-located) binding the listener to localhost.
- **Rate limiting:** a dedicated limiter on the namespace (separate budget from
  the 10-attempt login limiter) to prevent a misbehaving client from starving
  the browser app.
- **Least privilege:** read-only, compliance-fields-only, one key. No key = no
  access; the API is entirely inert until an admin generates a key.
- **Auditability:** log each authenticated integration call (key id, path, IP)
  to `runtime.log` so access is traceable. Never log the key itself.
- **No secrets in URLs:** the key travels in the `Authorization` header, never a
  query string.

---

## 8. Versioning & compatibility

- Path-versioned (`/v1`). Breaking changes ship as `/v2`; `/v1` keeps working.
- Additive fields (new keys in the JSON) are **not** breaking and can land in
  `/v1`.

---

## 9. Deferred / future (out of scope for v1)

- **Inbound write** — e.g. the peer tool syncing the employee roster in. Would
  add `POST /employees` under the same key, plus input validation.
- **Outbound webhooks** — Aware POSTing to a configured URL when an
  employee completes a module. Complementary to this pull API for near-real-time
  sync.
- **Multiple keys / scopes** — per-integration keys with distinct read scopes,
  if more than one external system connects.

---

## 10. Open questions for review

1. **Peer system:** what is the other tool, and does it prefer pull (polling) or
   would it also want push (webhooks) later?
2. **Fields:** is per-module `status` + `completion_date` enough, or does the
   consumer need certificate metadata / uploaded-at timestamps too?
3. **Identity:** is `emp_id` the shared key between the two systems, or does the
   peer tool match on `email`?
4. **Network topology:** same host, same LAN, or across segments? This decides
   the bind address and firewall story in §7.
5. **Key management:** single shared key acceptable for v1, or is per-consumer
   key rotation needed from day one?
