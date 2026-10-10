/**
 * The updater: a separate container beside the portal.
 *
 * A container cannot replace itself - it would be swapping the image it is
 * running inside - so installing an update is somebody else's job. This is
 * that somebody. It holds the Docker socket, which is the same as holding the
 * machine, so it serves no page, listens on nothing, and reads exactly two
 * things from outside: a request the portal leaves in a volume mounted
 * read-only here, and the portal's own releases page.
 *
 * An update is a change of image. The new version is pulled, the portal is
 * recreated from it, and if it does not come back answering as itself the old
 * image goes back. The data volume is never touched by any of it.
 *
 * How this differs from the Offset GRC products: theirs verify an Ed25519
 * signature over a release manifest before installing anything. This one
 * trusts ghcr.io over TLS instead. That is a real difference and it is written
 * down rather than glossed: the GRC products are also downloaded as .exe files
 * over plain links, where a signature is the only defence; the portal's update
 * path is a registry pull and nothing else.
 */
const { execFile } = require("node:child_process");
const { readFile, writeFile, mkdir, rm } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");

const INSTALL = process.env.UPDATER_INSTALL_DIR || "/install";
const REQUESTS = process.env.UPDATER_REQUEST_DIR || "/updates/request";
const STATUS = process.env.UPDATER_STATUS_DIR || "/updates/status";
const IMAGE = process.env.UPDATER_IMAGE_NAME || "ghcr.io/offsetsecurity/offset-aware";
const SERVICE = "portal";
const POLL_MS = 10_000;
const HEALTH_TIMEOUT_MS = 180_000;

const requestFile = path.join(REQUESTS, "update.json");
const statusFile = path.join(STATUS, "status.json");

const run = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { cwd: INSTALL, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); return; }
      resolve(String(stdout).trim());
    });
  });

const compose = (...args) => run("docker", ["compose", "--project-directory", INSTALL, ...args]);

async function say(state, message, extra = {}) {
  const status = { state, message, at: new Date().toISOString(), ...extra };
  await mkdir(STATUS, { recursive: true });
  await writeFile(statusFile, JSON.stringify(status, null, 2));
  console.log(`[updater] ${state}: ${message}`);
}

/**
 * The image the portal is running now, by digest.
 *
 * By digest and not by tag, because a tag is a label somebody can move: after
 * an update, `:1.0.2` may well point at something else. A rollback has to name
 * the exact image that was working ten seconds ago.
 */
async function currentImage() {
  const ids = await compose("ps", "-q", SERVICE);
  const id = ids.split("\n")[0];
  if (!id) return "";
  const out = await run("docker", ["inspect", "--format", "{{.Image}}", id]);
  return out.trim();
}

/** What .env says a setting is now, or "" if it does not say. */
async function getEnv(key) {
  const file = path.join(INSTALL, ".env");
  if (!existsSync(file)) return "";
  const text = await readFile(file, "utf8");
  const line = text.split(/\r?\n/).filter((l) => new RegExp(`^\\s*${key}\\s*=`).test(l)).pop();
  return line ? line.slice(line.indexOf("=") + 1).trim() : "";
}

/** Replaces one line in .env, or adds it. Nothing else in the file moves. */
async function setEnv(key, value) {
  const file = path.join(INSTALL, ".env");
  const text = existsSync(file) ? await readFile(file, "utf8") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // Every line kept as it is, comments and blanks included: this file is read
  // by a person as often as by compose.
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (at === -1) lines.push(`${key}=${value}`);
  else lines[at] = `${key}=${value}`;
  await writeFile(file, lines.join(eol));
}

/** Waits for Docker's own health check on the portal to go green. */
async function healthy() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const ids = await compose("ps", "-q", SERVICE);
      const id = ids.split("\n")[0];
      if (id) {
        const state = await run("docker", [
          "inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", id,
        ]);
        if (state === "healthy" || state === "running") return true;
        if (state === "unhealthy") return false;
      }
    } catch {
      /* the container is being replaced: keep waiting */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

/**
 * The line of a failure worth showing somebody.
 *
 * compose writes its progress to stderr, so the first line of a failed pull is
 * "Image ... Pulling" - true, and useless. The line that says what actually
 * happened is further down.
 */
function explain(err) {
  const text = String((err && (err.stderr || err.message)) || err);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const telling = lines.find((l) => /not found|manifest unknown|denied|unauthorized|no such|error/i.test(l));
  return telling || lines[lines.length - 1] || "Unknown error.";
}

async function install(version) {
  const target = `${IMAGE}:${version}`;
  // What to go back to: what .env said, because that is readable by whoever
  // opens the file next. The running image's id is the fallback, for a .env
  // that never named an image at all.
  const previousSetting = await getEnv("PORTAL_IMAGE");
  const previous = previousSetting || (await currentImage());
  await say("working", `Installing ${version}.`, { version });

  try {
    await setEnv("PORTAL_IMAGE", target);
    await say("working", "Downloading the new version.", { version });
    await compose("pull", SERVICE);

    await say("working", "Restarting the portal.", { version });
    await compose("up", "-d", SERVICE);

    await say("working", "Waiting for it to answer.", { version });
    if (await healthy()) {
      await say("done", `Updated to ${version}.`, { version });
      return;
    }

    // It came up and did not answer. Put back exactly what was running.
    await say("working", "It did not start. Putting the old version back.", { version });
    if (previous) {
      await setEnv("PORTAL_IMAGE", previous);
      await compose("up", "-d", SERVICE);
      await healthy();
    }
    await say("failed", `${version} did not start, so the previous version was put back.`, { version });
  } catch (err) {
    const reason = explain(err);
    if (previous) {
      try {
        await setEnv("PORTAL_IMAGE", previous);
        await compose("up", "-d", SERVICE);
      } catch { /* nothing more to try; the message below is what a person reads */ }
    }
    await say("failed", `The update failed and the previous version was put back. ${reason.split("\n")[0]}`, { version });
  }
}

async function main() {
  await say("idle", "Waiting for an update to be asked for.");
  for (;;) {
    try {
      if (existsSync(requestFile)) {
        const raw = await readFile(requestFile, "utf8");
        // The request volume is read-only here on purpose: the portal may ask,
        // but must not be able to reach anything this container writes. So the
        // request is not deleted - it is remembered by version instead.
        const request = JSON.parse(raw);
        const done = existsSync(statusFile) ? JSON.parse(await readFile(statusFile, "utf8")) : {};
        const already = done.version === request.version && (done.state === "done" || done.state === "failed");
        if (request.version && !already) await install(String(request.version));
      }
    } catch (err) {
      console.error("[updater]", err && err.message ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
