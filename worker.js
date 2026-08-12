/**
 * Amber VPN — Community Server relay (Cloudflare Worker)
 * ---------------------------------------------------------------------
 * Purpose: lets SelfServeAccountActivity (which runs on every user's
 * device) add a new entry to the shared "community_servers" list on
 * GitHub, WITHOUT the GitHub token ever being embedded in the APK.
 *
 * The app only ever knows RELAY_KEY (a narrow, worker-only secret).
 * The GitHub token lives ONLY as a Worker secret on Cloudflare and is
 * never sent to, or readable by, any device.
 *
 * ---------------------------------------------------------------------
 * DEPLOY STEPS (Cloudflare dashboard, no local CLI needed):
 *   1. dash.cloudflare.com -> Workers & Pages -> Create -> "Create Worker".
 *   2. Name it (e.g. "amber-relay") -> Deploy the default template first.
 *   3. Click "Edit code", delete everything, paste this whole file, Save & Deploy.
 *   4. Go to Settings -> Variables and Secrets, add these as SECRETS
 *      (not plain text vars):
 *        RELAY_KEY     = must be EXACTLY the same string as
 *                        RELAY_KEY in RelayPublisher.java
 *        GITHUB_TOKEN  = a fine-grained GitHub token, scoped to ONLY
 *                        the one repo below, with ONLY
 *                        "Contents: Read and write" permission
 *        GITHUB_OWNER  = e.g. noelrubio143
 *        GITHUB_REPO   = e.g. myvpnnew
 *        GITHUB_PATH   = must be EXACTLY the same file RemoteCommunityConfig.CONFIG_URL
 *                        points at, e.g. "update"
 *   5. Confirm the Worker's URL (shown at the top of the dashboard, looks
 *      like https://amber-relay.<your-subdomain>.workers.dev) matches
 *      RELAY_URL in RelayPublisher.java EXACTLY.
 *   6. Test: create an account from the app -> should show
 *      "Shared to the community list." instead of "Relay error: HTTP 500".
 * ---------------------------------------------------------------------
 */

const MAX_SERVERS = 200; // hard cap so self-serve spam can't blow up the file forever

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }

    // --- 1. Auth: only the app (holding RELAY_KEY) may call this -------
    const suppliedKey = request.headers.get("X-Relay-Key") || "";
    if (!env.RELAY_KEY || suppliedKey !== env.RELAY_KEY) {
      return json({ error: "unauthorized" }, 401);
    }

    if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO || !env.GITHUB_PATH) {
      return json({ error: "relay is missing GitHub secrets — set them in the Worker's Settings" }, 500);
    }

    // --- 2. Parse + validate the entry the app sent ---------------------
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "bad JSON body" }, 400);
    }

    const label = String(body.label || "").trim();
    const serverType = String(body.serverType || "").toLowerCase();
    if (!label) return json({ error: "label is required" }, 400);

    let entry;
    if (serverType === "v2ray" || serverType === "vless") {
      const v2rayLink = String(body.v2rayLink || "").trim();
      if (!v2rayLink) return json({ error: "v2rayLink is required" }, 400);
      entry = { label, serverType: "v2ray", v2rayLink, enabled: true };
    } else if (serverType === "ssh") {
      const host = String(body.host || "").trim();
      const port = String(body.port || "").trim();
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      if (!host || !port) return json({ error: "host and port are required" }, 400);
      entry = { label, serverType: "ssh", host, port, username, password, enabled: true };
    } else {
      return json({ error: "serverType must be 'ssh' or 'v2ray'" }, 400);
    }

    const apiUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${env.GITHUB_PATH}`;
    const ghHeaders = {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "amber-relay-worker",
    };

    try {
      // --- 3. Read current file (need its sha to update it) -----------
      const getResp = await fetch(apiUrl, { headers: ghHeaders });

      let root = { announcement: "", servers: [] };
      let sha = null;

      if (getResp.status === 200) {
        const meta = await getResp.json();
        sha = meta.sha || null;
        const decoded = meta.content
          ? atob(meta.content.replace(/\n/g, ""))
          : "{}";
        try {
          root = JSON.parse(decoded);
          if (!Array.isArray(root.servers)) root.servers = [];
          if (typeof root.announcement !== "string") root.announcement = "";
        } catch (e) {
          root = { announcement: "", servers: [] };
        }
      } else if (getResp.status !== 404) {
        const t = await getResp.text();
        return json({ error: `GitHub read failed: HTTP ${getResp.status}`, detail: t }, 502);
      }
      // 404 just means the file doesn't exist yet -> start fresh (root stays default).

      // --- 4. Merge: same label updates in place, else append ----------
      const idx = root.servers.findIndex((s) => s && s.label === label);
      if (idx >= 0) {
        root.servers[idx] = entry;
      } else {
        if (root.servers.length >= MAX_SERVERS) {
          return json({ error: `community list is full (max ${MAX_SERVERS}) — ask the admin to prune it` }, 429);
        }
        root.servers.push(entry);
      }

      // --- 5. Commit the updated file back to GitHub --------------------
      const newContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(root, null, 2))));
      const putBody = {
        message: `Self-serve ${idx >= 0 ? "update" : "add"}: ${label}`,
        content: newContentB64,
      };
      if (sha) putBody.sha = sha;

      const putResp = await fetch(apiUrl, {
        method: "PUT",
        headers: { ...ghHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(putBody),
      });

      if (!putResp.ok) {
        const t = await putResp.text();
        return json({ error: `GitHub commit failed: HTTP ${putResp.status}`, detail: t }, 502);
      }

      return json({ ok: true, message: "Shared to the community list." }, 200);
    } catch (e) {
      return json({ error: "relay exception: " + (e && e.message ? e.message : String(e)) }, 500);
    }
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
