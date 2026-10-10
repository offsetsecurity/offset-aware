# Offset Aware on Docker, step by step

This guide assumes you have never used Docker. Every step says what to type
and what you should see afterwards. If what you see does not match, stop and
look at **Something went wrong** at the end - the error is probably listed.

You need: a computer, a mouse, and the ability to open Command Prompt.

Roughly 20 minutes, most of it waiting for downloads.

---

# Part 1. Do you already have Docker?

**1.1** Open Command Prompt.

Press the Windows key, type `cmd`, press Enter. A black window opens with
white text. This is where you type commands.

**1.2** Click inside that black window and type this, then press Enter:

    docker --version

**1.3** Look at what it says.

**If you see something like this**, you have Docker. Skip to Part 3:

    Docker version 29.7.2, build 1a2b3c4

**If you see this**, you do not have it yet. Go to Part 2:

    'docker' is not recognized as an internal or external command

---

# Part 2. Installing Docker

Only if Part 1 said you do not have it.

**2.1** Open your web browser and go to:

    https://www.docker.com/products/docker-desktop

**2.2** Click the **Download for Windows** button.

A file called something like `Docker Desktop Installer.exe` downloads. It is
large - about 600 MB - so this takes a few minutes.

**2.3** When it finishes, double-click that file.

**2.4** A window appears with some tick boxes. Leave them as they are. Click
**OK**.

**2.5** Wait. It installs for a few minutes and then says **Installation
succeeded**. Click **Close and restart** if it offers.

Your computer may restart. That is normal. Let it.

**2.6** After restarting, open Docker Desktop: press the Windows key, type
`Docker`, press Enter.

**2.7** The first time, it shows a licence agreement. Click **Accept**. It may
ask you to sign in or create an account - you can skip that, look for
**Continue without signing in** or just close the sign-in box.

**2.8** Now wait. Look at the bottom-left corner of the Docker Desktop window.
There is a small whale icon and a word next to it.

- **Starting** - wait, it is not ready
- **Running** - ready. This is what you want

The first start can take two or three minutes. Leave it alone until it says
Running.

**2.9** Leave Docker Desktop open. It must be running whenever you use the
portal. It starts by itself when you switch your computer on.

**2.10** Check it worked. Open a **new** Command Prompt - close the old one
first, it will not know about Docker yet - and type:

    docker --version

You should now see a version number. If you do, Docker is installed.

---

# Part 3. Getting Aware's files

**3.1** Download the Offset Aware zip from the release page and unzip it somewhere.

**3.2** Inside it, find the folder `deploy\docker`. It holds two files:

    compose.yaml
    env.example

**3.3** Make a folder to run Aware from. In File Explorer, go to your
C: drive, make a folder called `Offset`, and inside it one called `Portal`.

So you end up with:

    C:\Offset\Portal

**3.4** Copy those two files into it. That folder should now hold exactly:

    compose.yaml
    env.example

---

# Part 4. Your settings file

**4.1** Open Command Prompt (Windows key, `cmd`, Enter).

**4.2** Tell it to work in your new folder. Type this and press Enter:

    cd C:\Offset\Portal

`cd` means "change directory" - it is how you tell the black window which
folder to work in. The text at the left should now end with `Portal>`.

**4.3** Make your own copy of the settings file:

    copy env.example .env

It says **1 file(s) copied.**

Why copy it: `env.example` is the blank one we ship. `.env` is yours, with
your settings in it. Keeping them separate means an update can never
overwrite your settings.

**4.4** Open your copy in Notepad:

    notepad .env

Most of what you see is explanation - every line starting with # is a note to
you and does nothing.

**4.5** Find this line. It has nothing after the equals sign:

    SESSION_SECRET=

This is a password Aware uses internally to keep people signed in. You
never type it again and never tell anyone. It just has to exist, and be long
and random.

**4.6** Leave Notepad open. In Command Prompt, type this and press Enter:

    docker run --rm node:24-alpine node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

The first time, this downloads a small helper - you will see progress bars.
Then it prints one long line of letters and numbers.

That is all it does. It makes one random value and prints it.

**4.7** Copy that line. In Command Prompt you copy by selecting the text with
your mouse and pressing Enter.

**4.8** In Notepad, click right after `SESSION_SECRET=` and paste (Ctrl+V).

**4.9** Now find these two lines and set the address your staff will use:

    PORTAL_URL=https://localhost:3000
    PORTAL_PORT=3000

`PORTAL_PORT` is the door number on the server. `PORTAL_URL` is the address
that goes into the emails Aware sends your staff, so it has to be an
address they can actually reach from their own computers - usually the
server's name or IP, not `localhost`. For example:

    PORTAL_URL=https://training.yourcompany.local:3000
    PORTAL_PORT=3000

If port 3000 is already in use on that machine, change the number in **both**
lines to the same new number.

**4.10** Press Ctrl+S to save, then close Notepad.

**Keep this file safe.** Lose that secret and everyone is signed out.

---

# Part 5. Starting it

**5.1** Make sure Docker Desktop is open and says **Running** at the bottom
left.

**5.2** In Command Prompt, make sure you are in your folder - the text at the
left should end with `Portal>`. If not:

    cd C:\Offset\Portal

**5.3** Type this and press Enter:

    docker compose up -d

**5.4** Wait. The first time this downloads Aware - a few hundred MB - so
give it a few minutes.

**5.5** When it finishes you see lines ending in **Started**:

    Container offset-aware-portal-1   Started
    Container offset-aware-updater-1  Started

Aware is now running. The second container is the updater, which installs
updates later when an administrator asks for one.

---

# Part 6. Opening it

**6.1** Open your web browser and go to:

    https://localhost:3000

Note **https**, not http. Aware always encrypts, even on your own
network.

**6.2** Your browser shows a warning - "Your connection is not private", or
similar.

**This is expected, the first time.** Aware makes its own certificate,
and browsers do not trust a certificate they have not been told about. The
connection is still encrypted.

Click **Advanced**, then **Proceed to localhost (unsafe)**, this once.

To make the warning go away for everyone, ask your IT team for a certificate
for the server's name, issued by your company's own certificate authority. It
costs nothing, and every company computer already trusts it. Then, signed in
as the administrator, open **Settings → HTTPS certificate** and upload it.

**6.3** The first screen asks you to create the administrator account. Fill it
in and submit. Do this straight away - until you do, anyone who can reach the
address could create it instead of you.

**6.4** You are in.

---

# Part 7. Adding the course packs

Aware arrives with five short starter courses. The ISO 27001, HIPAA and SAMA
courses come as separate downloads, called packs, because the videos are
large and most companies want only one or two of them.

| Pack | For | Courses |
|---|---|---|
| ISO 27001 | Any organisation working to ISO 27001 | 13 |
| HIPAA | Vendors handling US health data | 7 |
| SAMA, banks | Banks regulated by SAMA | 19 |
| SAMA, finance companies | Finance companies regulated by SAMA | 7 |

**7.1** In Aware, signed in as the administrator, click **Settings** in the
menu on the left.

**7.2** Scroll down to **Course packs**. Tick the packs you want.

**7.3** Click **Download and install**. A bar shows how far it has got. The
larger packs take a few minutes. You can leave the page; it carries on.

**7.4** When it says **Installed**, scroll up to **Training modules**. Each
new pack has a grey line with its name and **Applies to**. Choose:

- **Everyone**, if all your staff must take it
- **Chosen people**, if only some must. This is what it starts as. You say who
  in Part 8
- **Nobody**, to switch it off for now

Nothing is given to anyone until you choose. That is on purpose: adding the
HIPAA pack does not hand HIPAA to your whole company.

Your packs are kept with the rest of your data, so updating Aware does not
lose them.

**No internet on that machine?** On another computer, download the packs
from:

    https://github.com/offsetsecurity/offset-aware/releases/tag/courses-2

Copy them into a folder called `packs` inside `C:\Offset\Portal`, without
unzipping them. Then, in Command Prompt, in your folder, paste this as one
line and press Enter:

    docker run --rm --user root -v "%cd%\packs:/packs:ro" -v offset-aware_data:/data ghcr.io/offsetsecurity/offset-aware:latest sh -c "mkdir -p /data/training ; find /packs -name '*.zip' -exec unzip -o -q {} -d /data/training \; ; chown -R portal:portal /data/training"

It prints nothing when it works. Reload Aware and the courses are listed.

---

# Part 8. Setting it up for your staff

1. **Settings, SMTP** - point it at your mail server, so it can send
   invitations, reminders and password resets
2. **Add people** - import your staff from a spreadsheet, or add them one at a
   time. For each person, tick the training that applies to them
3. Already added people? On **Employees**, tick them and click **Assign
   training to selected** to give them the same training together
4. Send the invitations

Your staff open the same address from their own computers, sign in, work
through their courses, and take the quiz after each one.

---

# Part 9. The five commands you will use

All of these must be typed in your folder - `cd C:\Offset\Portal` first.

**Is it running?**

    docker compose ps

**Stop it** (your data is kept):

    docker compose down

**Start it again:**

    docker compose up -d

**See what it is doing** (Ctrl+C to stop watching):

    docker compose logs -f portal

**Danger.** This one deletes every training record, with no undo:

    docker compose down -v

The difference is that `-v` on the end. Without it your data is safe. With it
your data is gone. Do not type it unless you mean it.

---

# Part 10. Where your data is

Not in the folder you made. Docker keeps it in its own storage, called a
volume, so stopping and restarting never touches it.

It holds every training record, the course packs, and the
administrator account. Copy it out before you move Aware to another
machine.

---

# Part 11. Updating it

An administrator installs updates from inside Aware: **Settings** shows
the installed version, checks for a newer one, and installs it with a button.

The updater container does the work. It downloads the new version, restarts
Aware, and puts the old version back if the new one does not answer.

Nothing is downloaded or installed until somebody asks for it.

---

# Part 12. Something went wrong

**"'docker' is not recognized as an internal or external command"**

Docker is not installed, or you opened Command Prompt before installing it.
Close the black window, open a new one, try again. Still the same? Go back to
Part 2.

**"Cannot connect to the Docker daemon" or "Docker Desktop is not running"**

Docker Desktop is not open, or has not finished starting. Open it and wait
until the bottom left says **Running**.

**"no configuration file provided: not found"**

You are in the wrong folder. Type:

    cd C:\Offset\Portal

and try again.

**"port is already allocated"**

Something else is using port 3000. Open `notepad .env`, change the number in
both `PORTAL_PORT` and `PORTAL_URL` to the same new number, save, and run
`docker compose up -d` again.

**The browser says the page cannot be reached**

Check it is running with `docker compose ps`. Both lines should say **Up**.
Also check you typed **https**, not http.

**Your staff cannot reach it from their computers**

The address in `PORTAL_URL` has to be one they can reach - the server's name
or IP, not `localhost`, which means "this computer" and is different on every
machine. You may also need to open the port in the server's firewall.

**Still stuck**

Send us this, and we will tell you what it means:

    docker compose logs portal > logs.txt

That writes `logs.txt` in your folder. Email it to info@offsetsecurity.net.

---

# On Linux instead of Windows

The steps are the same. The differences:

- Install Docker with your package manager, or the script at
  https://get.docker.com
- `cp env.example .env` instead of `copy env.example .env`
- `nano .env` instead of `notepad .env`
- In Part 7's command, `"$PWD/packs:/packs:ro"` instead of `"%cd%\packs:/packs:ro"`

Everything else - the same commands, the same order.

---

Offset Security - info@offsetsecurity.net
