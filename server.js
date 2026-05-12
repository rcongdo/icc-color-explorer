const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = __dirname;
const publicDir = path.join(root, "public");
const helperSource = path.join(root, "cmyk-to-lab.swift");
const helperBin = path.join(root, ".build", "cmyk-to-lab");
const moduleCache = path.join(root, ".swift-cache");
const uploadedProfilesDir = path.join(root, "uploaded-profiles");

const profileRoots = [
  "/System/Library/ColorSync/Profiles",
  "/Library/ColorSync/Profiles",
  path.join(process.env.HOME || "", "Library/ColorSync/Profiles"),
].filter(Boolean);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function ensureHelper() {
  fs.mkdirSync(path.dirname(helperBin), { recursive: true });
  fs.mkdirSync(moduleCache, { recursive: true });
  const sourceTime = fs.statSync(helperSource).mtimeMs;
  const binTime = fs.existsSync(helperBin) ? fs.statSync(helperBin).mtimeMs : 0;
  if (binTime >= sourceTime) return;

  const result = spawnSync(
    "swiftc",
    [helperSource, "-o", helperBin],
    {
      cwd: root,
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache },
      encoding: "utf8",
    }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || "Unable to build the ColorSync helper.");
  }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    if (entry.isFile() && /\.(icc|icm)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function listProfiles() {
  const seen = new Set();
  const systemProfiles = profileRoots
    .flatMap((dir) => walk(dir))
    .filter((profilePath) => {
      const label = path.basename(profilePath);
      return /cmyk|swop|gracol|fogra|coated|uncoated|flexo/i.test(label);
    })
    .map((profilePath) => {
      const label = path.basename(profilePath, path.extname(profilePath));
      return { label, path: profilePath };
    })
    .filter((profile) => {
      const key = profile.label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const uploadedProfiles = walk(uploadedProfilesDir)
    .map((profilePath) => ({
      label: `${path.basename(profilePath, path.extname(profilePath))} (uploaded)`,
      path: profilePath,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return [...uploadedProfiles, ...systemProfiles];
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) request.destroy();
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function readBinaryBody(request, limit = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        request.destroy();
        reject(new Error("Profile file is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function safeProfileName(name) {
  const fallback = `profile-${Date.now()}.icc`;
  const base = path.basename(name || fallback).replace(/[^a-z0-9._ -]/gi, "_");
  if (!/\.(icc|icm)$/i.test(base)) return `${base}.icc`;
  return base;
}

function convertColor(payload) {
  ensureHelper();
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(helperBin, [], {
      cwd: root,
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Color conversion timed out."));
    }, 3000);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(stderr.trim() || "Color conversion failed."));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("The ColorSync helper returned unreadable data."));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function send(response, status, value, type = "application/json; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  if (Buffer.isBuffer(value) || typeof value === "string") {
    response.end(value);
    return;
  }
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/api/profiles") {
      send(response, 200, { profiles: listProfiles() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/convert") {
      const body = await readBody(request);
      const payload = JSON.parse(body);
      const result = await convertColor(payload);
      send(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/upload-profile") {
      const originalName = request.headers["x-profile-name"];
      const fileName = safeProfileName(Array.isArray(originalName) ? originalName[0] : originalName);
      fs.mkdirSync(uploadedProfilesDir, { recursive: true });
      const body = await readBinaryBody(request);
      if (body.length === 0) throw new Error("Dropped profile was empty.");
      const target = path.join(uploadedProfilesDir, `${Date.now()}-${fileName}`);
      fs.writeFileSync(target, body);
      send(response, 200, {
        profile: {
          label: `${path.basename(target, path.extname(target)).replace(/^[0-9]+-/, "")} (uploaded)`,
          path: target,
        },
      });
      return;
    }

    const filePath = url.pathname === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, url.pathname);
    if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath)) {
      send(response, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    send(response, 200, fs.readFileSync(filePath), mime[path.extname(filePath)] || "application/octet-stream");
  } catch (error) {
    send(response, 500, { error: error.message });
  }
});

const port = Number(process.env.PORT || 4173);
ensureHelper();
server.listen(port, "127.0.0.1", () => {
  console.log(`CMYK Lab app running at http://127.0.0.1:${port}`);
});
