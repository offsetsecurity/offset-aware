# Architecture Overview: Offset Aware

## High-Level Architecture

Offset Aware is a lightweight, on-premise Enterprise web application built entirely on Node.js and SQLite. It is designed to be easily deployed inside corporate networks without requiring external cloud database dependencies.

### System Diagram

```mermaid
graph TD
    %% User Interfaces
    User([Corporate Employee]) --> |HTTPS:3000| WebUI[Frontend UI (HTML/CSS/JS)]
    Admin([IT Administrator]) --> |HTTPS:3000| AdminUI[Admin Dashboard]

    %% Web Tier
    subgraph "Application Server (Node.js)"
        WebUI --> |REST API| Express[Express.js API Router]
        AdminUI --> |REST API| Express
        Express --> |Session/Auth| Auth[Auth Controller (bcrypt)]
        Express --> |SMTP/TCP| Mail[Nodemailer (SMTP Client)]
    end

    %% Data Tier
    subgraph "Local Storage"
        Auth --> |Read/Write| DB[(SQLite Database)]
        Express --> |File I/O| Uploads[Local File System (Uploads)]
        Express --> |File I/O| Logs[Local File System (Logs)]
    end

    %% Infrastructure
    subgraph "Windows Host Environment"
        WinSvc[node-windows Service] --> |Manages Lifecycle| Express
    end

    %% External
    Mail -.-> |Send Emails| CorporateSMTP[Corporate Mail Server]
```

## Component Breakdown

### 1. Frontend (Client-Side)
- **Technology**: Vanilla HTML, CSS, and Client-Side JavaScript.
- **Routing**: Single-page application (SPA) feel achieved through standard DOM manipulation and AJAX requests to the backend API.
- **Assets**: CSS and JavaScript are served statically from the `/public` directory.

### 2. Backend (Server-Side)
- **Technology**: Node.js utilizing the `express` framework.
- **Security**: 
  - Express sessions are managed using `express-session` with a dynamically generated `SESSION_SECRET` stored in the `.env` file.
  - HTTPS is enforced. Aware generates a self-signed certificate (`cert.pem`, `key.pem`) on first run; an administrator uploads the company's own under Settings → HTTPS certificate (`tls.js`), and it is used at once. Plain HTTP on the same port is redirected to HTTPS.
- **Authentication**: User passwords are securely hashed using `bcrypt` before storage.

### 3. Database (Data-Tier)
- **Technology**: SQLite3.
- **Schema**:
  - `employees`: Stores user credentials, names, emails, roles (Admin vs User), and training completion status.
  - `sessions`: Ephemeral table used by `connect-sqlite3` to persist user login sessions across server restarts.
- **Benefit**: Requires zero external infrastructure (no PostgreSQL or MySQL servers needed). The database is entirely contained within the `database.sqlite` file.

### 4. Background Service
- **Technology**: `node-windows`.
- **Purpose**: Wraps the Node.js process into a native Windows Service (`isotrainingportal.exe`). This ensures the application automatically boots up when the host server restarts and runs silently in the background without an active user session.

### 5. Email Integration
- **Technology**: `nodemailer`.
- **Purpose**: Connects to the customer's internal corporate SMTP server (e.g., Microsoft Exchange, Office 365, Google Workspace) to dispatch automated password reset emails and system notifications.
