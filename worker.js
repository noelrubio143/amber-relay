/**
 * Amber VPN community relay -- Cloudflare Worker.
 *
 * This is what RelayPublisher.java (every ordinary app user's device) POSTs
 * to when someone taps "Create SSH Account" / "Create VLESS Account" on the
 * self-service screen. It's the ONLY thing that turns a self-served account
 * into an entry on the public Community Servers list for every user -- if
 * this Worker is missing, misconfigured, or throwing, self-service accounts
 * get created fine on the VPS but never show up in Community Servers (and
 * the app shows "Relay error: HTTP 500" or similar).
 *
 * WHY A RELAY AT ALL (instead of the app calling the GitHub API straight,
 * the way the admin's GitHub Sync screen does): a GitHub token with write
 * access would have to ship inside the APK for every user's device to use
 * it directly, and anyone can decompile an APK and read that token out.
 * Routing through this Worker means the ONLY secret inside the APK is
 * RELAY_KEY, which can only be used to hit this one narrow endpoint --
 * never a real GitHub credential.
 *
 * ---- DEPLOY STEPS ----
 * 1. Cloudflare dashboard -> Workers & Pages -> Create -> Create Worker.
 * 2. Paste this whole file in as the Worker's code, replacing the default.
 * 3. Settings -> Variables and Secrets, add:
 *      RELAY_KEY     (secret) -- must exactly match RELAY_KEY in
 *                                 app/src/main/java/org/econetvpn/xyz/config/RelayPublisher.java
 *                                 Current value in the app:
 *                                 b96ea8ee410c3883ec95886a51ea5fd0e11df307b00898e0
 *      GITHUB_TOKEN  (secret) -- a GitHub fine-grained token scoped to ONLY
 *                                 the one community-list repo, with ONLY
 *                                 "Contents: Read and write" permission.
 *      GITHUB_OWNER  (var)    -- e.g. noelrubio143
 *      GITHUB_REPO   (var)    -- e.g. myvpnnew
 *      GITHUB_PATH   (var)    -- e.g. update
 *                                 (same owner/repo/path RemoteCommunityConfig.java's
 *                                  CONFIG_URL and the admin's GitHub Sync section point at)
 * 4. Deploy. Confirm the Worker's URL matches RELAY_URL in RelayPublisher.java
 *    exactly (https://amber-relay.amber2.workers.dev) -- if Cloudflare gave
 *    you a different subdomain, either rename the Worker to "amber-relay" on
 *    the "amber2" subdomain, or update RELAY_URL in RelayPublisher.java to
 *    match what Cloudflare actually gave you and rebuild the app.
 * 5. Test: create an account from the app's self-service screen, then check
 *    this Worker's "Logs" tab (real-time logs) in the Cloudflare dashboard
 *    while you do it -- any error will show up there with a real stack trace,
 *    instead of just "HTTP 500" on the phone.
 */

const MAX_ENTRIES = 500; // simple abuse cap; raise/lower as you like

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const relayKey = request.headers.get("X-Relay-Key");
    if (!relayKey || relayKey !== env.RELAY_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response("Bad JSON body", { status: 400 });
    }

    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label) {
      return new Response("Missing label", { status: 400 });
    }

    let entry;
    if (body.serverType === "ssh") {
      if (!body.host || !body.port || !body.username || !body.password) {
        return new Response("Missing SSH fields (host/port/username/password)", { status: 400 });
      }
      entry = {
        label,
        serverType: "ssh",
        host: String(body.host),
        port: String(body.port),
        username: String(body.username),
        password: String(body.password),
        enabled: true,
      };
    } else if (body.serverType === "v2ray") {
      if (!body.v2rayLink) {
        return new Response("Missing v2rayLink", { status: 400 });
      }
      entry = {
        label,
        serverType: "v2ray",
        v2rayLink: String(body.v2rayLink),
        enabled: true,
      };
    } else {
      return new Response("Unknown serverType (expected \"ssh\" or \"v2ray\")", { status: 400 });
    }

    const owner = env.GITHUB_OWNER;
    const repo = env.GITHUB_REPO;
    const path = env.GITHUB_PATH;
    const token = env.GITHUB_TOKEN;
    if (!owner || !repo || !path || !token) {
      return new Response(
          "Worker misconfigured: missing one of GITHUB_OWNER / GITHUB_REPO / GITHUB_PATH / GITHUB_TOKEN",
          { status: 500 });
    }

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const ghHeaders = {
      "Authorization": `token ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "amber-relay-worker",
    };

    // 1. Read the current file (so we can merge, not overwrite, and get its sha).
    let sha = null;
    let root = {};
    const getResp = await fetch(apiUrl, { headers: ghHeaders });
    if (getResp.status === 404) {
      root = {};
    } else if (getResp.ok) {
      const meta = await getResp.json();
      sha = meta.sha;
      try {
        const decoded = decodeURIComponent(escape(atob(meta.content.replace(/\n/g, ""))));
        root = JSON.parse(decoded);
      } catch (e) {
        root = {};
      }
    } else {
      const errText = await getResp.text();
      return new Response(`GitHub read failed: HTTP ${getResp.status} -- ${errText}`, { status: 502 });
    }

    if (typeof root.announcement !== "string") root.announcement = "";
    if (!Array.isArray(root.servers)) root.servers = [];

    let replaced = false;
    root.servers = root.servers.map((o) => {
      if (o && o.label === label) {
        replaced = true;
        return entry;
      }
      return o;
    });
    if (!replaced) {
      if (root.servers.length >= MAX_ENTRIES) {
        return new Response("Too many community entries -- ask the admin to clean some up.", { status: 429 });
      }
      root.servers.push(entry);
    }

    // 2. Write the merged file back.
    const newContentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(root, null, 2))));
    const putBody = {
      message: `${replaced ? "Update" : "Add"} community entry: ${label}`,
      content: newContentB64,
    };
    if (sha) putBody.sha = sha;

    const putResp = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(putBody),
    });

    if (!putResp.ok) {
      const errText = await putResp.text();
      return new Response(`GitHub commit failed: HTTP ${putResp.status} -- ${errText}`, { status: 502 });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};
