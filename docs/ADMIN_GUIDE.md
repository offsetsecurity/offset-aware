# Offset Aware Administrator Guide

Welcome to the Offset Aware Admin Guide! As an Administrator, you have access to a specialized dashboard to manage the training compliance of your organization.

## 1. Accessing the Dashboard

1. Open the Aware address your IT department gave you, for example `https://training.yourcompany.local:3000`. It ends in the port chosen when Aware was installed: 3000 unless they picked another.
2. Log in using your Administrator Username and Password.
3. Upon logging in, you will be redirected to the **Admin Dashboard** instead of the standard employee training view.

## 2. Managing the Employee Directory

The **Employees** tab gives you a bird's-eye view of your entire organization's training progress.

### Viewing Status
You can see at a glance who has finished everything. The badge reads `Up to date` (green) once all of that person's required courses are done, and `Not done` until then. Each person's required courses are those of the training that applies to them, plus the courses their jobs add. It reads `Nothing assigned` for someone who has not been given any, and a yellow note at the top counts those people. The **Training Status** tab shows each person's courses separately.

### Who does which training
Training comes in sets: the built-in courses, and each course pack (ISO 27001, HIPAA, SAMA). In **Settings → Training modules** each set applies to **Everyone**, to **Chosen people**, or to **Nobody**. A set starts as Chosen people, so adding the HIPAA pack does not give HIPAA to the whole company.

- **One person**: choose their training when you add them, or later with **Training** beside their name on this screen. Each set of training is a card: switch it on with **Applies**, open it to choose the person's job, and under that pick single courses by hand if you need to. The bar underneath adds up how many courses it comes to.
- **Many people**: tick them in the left-hand column and click **Assign training to selected**. The search box and the filter above the list narrow it first - type a job, a set of training or part of a name, or choose **No training to do yet** - and the box at the top ticks everyone shown. Ticks stay while you search again, so several groups can be gathered before assigning. Choose **Add to what they have** or **Take away**. Only what you tick changes; each person keeps the rest of their own list.
- **Everybody**: set the training to **Everyone** in Settings.

A server that already had staff before this choice existed keeps every set on Everyone, so nobody's training changed when it was updated.

### Jobs
Give each person their job when you add them, or later with **Training** on this screen. A person can have more than one. A job also brings the set it belongs to: a SAMA job means the SAMA all-staff courses too. Each job adds the courses for that job: "Branch, call centre and collections" adds the branch and fraud-tracks courses, for example. **Settings → Jobs** lists every job and what it adds, and the [course catalogue](COURSE_CATALOGUE.md) has the full list. When you import from a spreadsheet, put the job names in an optional fourth column, separated by `;`. An optional fifth column, Training, takes the names of the sets that apply to the person. A job name with a comma in it goes in double quotes, which a spreadsheet does for you when it saves as CSV.

**Uploading a list again** adds nobody twice. For a person already here, a filled-in Job or Training cell replaces what they had and an empty one leaves it alone; their name, email and password are not touched. So a list imported without training can be given it later: fill in the columns and upload it again. A name that is not recognised is left out and listed after the import.

### Password Resets
If an employee forgets their password:
1. Open **Settings**. **Reset someone's password** is the first card.
2. Enter the person's **Employee ID** and the **email on their account**. Both have to match, so the wrong person is never reset. For someone with no email on their account, leave the email empty.
3. Click **Reset password**. Aware makes a new starting password for them and shows it to you once, with a Copy button. It is a one-time password: the person is made to choose their own the next time they sign in.
4. If email is set up (see Section 4), the person is sent the new password. If it is not, no email reaches them, so you must tell them the password yourself.

## 3. Provisioning New Users

### One person

1. Open the **Provisioning** tab.
2. Under **Provision Single Employee**, fill in **Employee ID**, **Full Name** and **Email Address**. The Employee ID must be unique.
3. Under **Training**, switch on the sets that apply to the person and choose their job. The bar underneath says how many courses they will be asked to do.
4. Click **Provision Account**.

If email is set up (see Section 4), the person is sent their sign-in details.

### A whole list

On the same tab, **Bulk Import (CSV)** takes a file with three columns: `Employee ID`, `Name` and `Email`, and two optional ones, `Job` and `Training`. Click **Integrate**. Importing does not send any email, so tell people their Employee ID yourself.

### The starting password

Every account, added singly or imported, gets a starting password of its own: twelve letters and digits, emailed to the person when email is set up, and shown to you once (for an import, as a list you can download). The first time the person signs in they are made to choose their own password before they can go any further. It must be at least 8 characters, and different from the starting one.

**Ask people to sign in soon after you add them.** Until they do, anyone who knows their Employee ID could sign in with the starting password.

Accounts added this way are always employees. The first administrator is created when Aware is first opened, and there is no screen for adding another.

## 4. Email settings (SMTP)

Without email, Aware still works, but it cannot send password resets or
training reminders. When you add an employee it shows you their temporary
password on screen instead, and you have to pass it on yourself.

To turn email on, open the **Settings** tab. You will see **SMTP Configuration**
and a yellow warning that email is not configured. Fill in the form and click
**Save Configuration**. The warning goes away.

| Field | What it is |
|---|---|
| **SMTP Host** | The mail server's address |
| **SMTP Port** | 465 or 587. See the tick box below |
| **SMTP User** | The username for that mail server. For some providers this is *not* an email address |
| **SMTP Password** | The password, an app password, or an API key |
| **Send Emails As** | The address the emails appear to come from |
| **Use Secure Connection** | **Tick it for port 465. Untick it for port 587** |

### Using Resend (recommended)

A mail service built for this is more reliable than a company mailbox: no
multi-factor prompts to get past, and far less chance of landing in spam.

1. Create an account at resend.com.
2. In **Domains**, add your company's domain and add the DNS records it shows
   you. Wait until it says verified.
3. In **API Keys**, create a key. "Sending access" is enough. Copy it now: it is
   only shown once, and starts with `re_`.
4. Back in Aware's **Settings** tab, enter:

   | Field | Value |
   |---|---|
   | SMTP Host | `smtp.resend.com` |
   | SMTP Port | `465` |
   | SMTP User | `resend` (the word itself, not your email address) |
   | SMTP Password | the API key from step 3 |
   | Send Emails As | an address on the domain you verified, such as `training@yourcompany.com` |
   | Use Secure Connection | ticked |

5. Click **Save Configuration**.

Resend refuses to send from an address on a domain you have not verified. If
everything saves without complaint and no email ever arrives, that is almost
always the reason.

### Using your own mail server instead

| | Microsoft 365 | Gmail |
|---|---|---|
| SMTP Host | `smtp.office365.com` | `smtp.gmail.com` |
| SMTP Port | `587` | `587` |
| Use Secure Connection | **unticked** | **unticked** |
| SMTP User | the full mailbox address | the full Gmail address |
| SMTP Password | the mailbox password, or an app password | an **app password**, not the account password |

Both usually need an app password, because the ordinary password is blocked
by multi-factor authentication. Microsoft 365 also has to have "Authenticated
SMTP" switched on for that mailbox, which is off by default in many tenants.

### Checking that it works

In the **Settings** tab, **Send test email** sits beside **Save Configuration**.
It sends a message to **your own administrator account's email address**, using
the settings you have saved, and shows how it went just below the buttons. Save
first, then test.

If nothing arrives, the reason is in the mail log:

```
C:\ProgramData\Offset Security\ISO Training Portal\logs\smtp.log
```

The usual causes, in the order to check them:

| What you see | The cause |
|---|---|
| "wrong version number" or a connection that hangs | The tick box and port disagree. 465 ticked, 587 unticked |
| "Invalid login" or "authentication failed" | Wrong user or password. For Resend the user is `resend` |
| Saved, test says sent, nothing arrives | The domain in **Send Emails As** is not verified with your provider. Check the spam folder as well |
| "Could not connect" | The server cannot reach the mail host. A firewall may be blocking the port outbound |

## 5. Training modules, and the one time Aware uses the internet

**The training videos are downloaded when you ask for them. That is the only
time Offset Aware uses the internet.** The course packs are ISO 27001, HIPAA,
SAMA for banks and SAMA for finance companies. The Windows installer lists
them with their sizes and downloads the ones you tick; **Settings → Course
packs** does the same at any time, and is how packs are added on Docker. Each
comes from Offset Security's release page and is checked against its published
checksum before it is used. Otherwise Aware runs entirely on your server and
nothing about your staff or their training is sent anywhere. The [course catalogue](COURSE_CATALOGUE.md) lists
every course in every pack.

- **Settings → Training modules** shows which courses are on this server.
  First, on each set's grey line, who it applies to: **Everyone**, **Chosen
  people** or **Nobody**. Then, for each course: **Everyone it applies to**,
  **By job** (the people whose job adds it, plus anyone you add by hand), or
  **Optional**. Staff see only the courses on this server, and only those
  count towards being fully trained.
- **To add a pack later**, tick it under **Settings → Course packs** and click
  **Download and install**. It applies to nobody until you choose who.
- **On a server with no internet**, untick everything while installing. Then
  download the packs on another computer from the training modules page
  (`github.com/offsetsecurity/offset-aware/releases/tag/courses-2`) and unzip
  them into the folder Settings shows, keeping their file names.
- **Check for updates**, in Settings, also asks the internet - only when you
  click it.

The quiz questions come with the packs, and there is no screen for changing
them.

## 6. When training runs out

A finished module counts for 12 months, then the person does it again. Change
the period in **Settings**, under **How long training stays valid**: 6, 12, 24
or 36 months, or never.

- **Employees** shows the totals across the top: fully trained, due again in
  the next 30 days, and run out.
- **Training status** shows the date every module runs out, in amber in its
  last 30 days. Filter it to **Running out in 30 days** or **Has run out**.
- When a module runs out, the person sees **Run out** and has to watch the
  video and pass the quiz again. Until then they are not fully trained, and
  **Reminders** includes them.
- **Download history (CSV)**, on **Training status**, lists every time anybody
  finished a module, with the date and the date it ran out. Give it to your
  auditor.

### Automatic reminders and escalation

Under **Escalation**, turn on **Send reminders automatically** and choose the
hour. Email has to be set up in **Settings** first.

- **The person** gets an email 30, 15, 7 and 3 days before a module is due,
  on the day, and every day after until it is done. **Every module is its own
  email**: three modules due is three emails.
- A module is **due** when it runs out. Something never done is due 30 days
  after the person was added.
- **Once it is overdue**, up to four people are told in turn: the
  administrator, the administrator's manager, their manager, and top
  management. By default that is after 1, 7, 15 and 30 days overdue, and you
  can change each number. A level is told when it is reached, then every
  7 days until the module is done. Leave a level empty to skip it.
- Every email up the chain **copies in everyone above** and says who else has
  been told, so nobody is left wondering.
- **What was sent**, at the bottom of the screen, lists every email and
  whether it arrived. It is the answer when an auditor asks whether people
  were chased.

## 7. Quizzes and who has failed

Each employee has the all-staff courses, plus the courses their jobs add. For each one they watch the video to the end, take the quiz, and tick the acknowledgement. **80% or more passes.** A course counts as complete when the video and the quiz are both done.

If someone scores under 80%, the quiz closes and says **You did not pass**, with their score. **Retake quiz** opens a fresh one with the questions in a new order. After three failures in a row on the same module, they are asked to watch the video again before trying again.

Every attempt is recorded. On the **Training Status** tab, a cross with a note under it, such as `2 failed · last 60%`, means the person has tried and not yet passed. A cross with no note means they have not tried. Choose **Failed a quiz** in the filter to list only those people.

## 8. Locked out of the administrator account

If the only administrator has forgotten their password:

- **On Windows:** open the Start menu, find **Offset Security**, and click **Reset administrator password**. Accept the permission prompt, then enter the administrator's Employee ID and a new password of at least 8 characters.
- **On Docker:** run `docker compose exec portal node reset_admin_password.js` and answer the same two questions.

It works only for administrator accounts, and it cannot show you the old password.

## 9. Stopping the "Not secure" warning

At first Aware uses a certificate it made for itself. The connection is
encrypted, but browsers do not trust that certificate, so they say "Not
secure" and people have to click past a warning.

To fix it for everyone:

1. **Ask your IT team for a certificate** for the name people type to reach
   Aware, such as `training.yourcompany.local`, issued by your company's
   own certificate authority. It costs nothing, and every company computer
   already trusts it. Ask for a `.pfx` file with a password, or for a
   certificate and key as `.pem` / `.crt` and `.key` files.
2. Sign in as the administrator and open **Settings**.
3. Under **HTTPS certificate**, choose the file or files, type the password
   if there is one, and click **Upload certificate**.

It is checked before it is used. A wrong password, a key that does not belong
to the certificate, or an expired certificate is refused, with the reason. A
certificate for a different name, a self-signed one, or one about to expire is
shown to you first, with **Use it anyway** and **Cancel**.

Once saved it is in use straight away. Nothing restarts. Reload the page to
see the padlock. Old `http://` links are sent on to `https://`.

**Each year**, upload the renewed certificate the same way. The card shows the
date it expires, and warns 30 days before.

**Remove uploaded certificate** puts Aware's own certificate back.

The certificate is kept in the data folder, so a backup of that folder
includes its private key. Keep backups private.
