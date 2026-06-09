const DEFAULT_ADMIN_URL = "http://127.0.0.1:2019";
const DEFAULT_CADDY_SERVER = "nslocalhost";
const DEFAULT_DOMAIN = "localhost";
const DEFAULT_PROBE_PATH = "/__nslocalhost_probe";
const registrations = new Map();
export function nsLocalhostMiddleware(options = {}) {
    return (request, event) => {
        const settings = resolveOptions(options);
        const probeResponse = maybeHandleProbe(request, settings);
        if (probeResponse) {
            return probeResponse;
        }
        if (!settings.enabled) {
            return;
        }
        const registration = ensureRegistered(request, settings);
        if (event?.waitUntil) {
            event.waitUntil(registration);
        }
        else {
            void registration;
        }
        return;
    };
}
export default nsLocalhostMiddleware;
function resolveOptions(options) {
    const host = options.host ?? buildPublicHost(resolveName(options.name), options.domain);
    const probeToken = options.probeToken ?? `nslocalhost:${host}`;
    const publicScheme = options.publicScheme ?? "http";
    return {
        name: options.name ?? host.split(".")[0] ?? "app",
        host,
        domain: options.domain ?? DEFAULT_DOMAIN,
        publicScheme,
        publicPort: options.publicPort ?? (publicScheme === "https" ? 443 : 80),
        caddyAdminUrl: options.caddyAdminUrl ?? DEFAULT_ADMIN_URL,
        caddyServerName: options.caddyServerName ?? DEFAULT_CADDY_SERVER,
        listen: options.listen ?? [":80"],
        upstreamHost: options.upstreamHost ?? "",
        probePath: normalizeProbePath(options.probePath ?? DEFAULT_PROBE_PATH),
        probeToken,
        enabled: options.enabled ?? isDevelopment(),
        warn: options.warn ?? ((message) => console.warn(message)),
    };
}
async function ensureRegistered(request, options) {
    const upstream = resolveUpstream(request, options);
    if (!upstream) {
        options.warn(`[nslocalhost] ${options.host} was not registered because the current request host does not expose a local dev port. Open the direct Next dev URL once, for example http://localhost:3000.`);
        return;
    }
    const key = `${options.host}->${upstream.dial}`;
    let registration = registrations.get(key);
    if (!registration) {
        registration = registerAndVerify(options, upstream.dial);
        registrations.set(key, registration);
    }
    await registration;
}
async function registerAndVerify(options, upstreamDial) {
    try {
        await registerCaddyRoute({
            adminUrl: options.caddyAdminUrl,
            serverName: options.caddyServerName,
            listen: options.listen,
            host: options.host,
            upstreamDial,
        });
    }
    catch (error) {
        options.warn(`[nslocalhost] could not register ${options.host} -> http://${upstreamDial}: ${formatError(error)}`);
        return;
    }
    const probeUrl = buildProbeUrl(options);
    try {
        const response = await fetch(probeUrl, {
            cache: "no-store",
            headers: {
                "x-nslocalhost-probe": options.probeToken,
            },
        });
        const token = response.headers.get("x-nslocalhost-probe");
        if (!response.ok || token !== options.probeToken) {
            options.warn(`[nslocalhost] ${options.host} was registered, but the Caddy probe did not reach this Next middleware. Probe ${probeUrl} returned ${response.status}.`);
            return;
        }
        console.info(`[nslocalhost] ${options.publicScheme}://${formatPublicHost(options)} -> http://${upstreamDial}`);
    }
    catch (error) {
        options.warn(`[nslocalhost] ${options.host} was registered, but the Caddy probe failed at ${probeUrl}: ${formatError(error)}`);
    }
}
async function registerCaddyRoute(input) {
    const config = await getCaddyConfig(input.adminUrl);
    const servers = ensureHttpServers(config);
    const server = servers[input.serverName] ?? {};
    const existingRoutes = Array.isArray(server.routes) ? server.routes : [];
    server.listen = Array.isArray(server.listen) && server.listen.length > 0
        ? server.listen
        : input.listen;
    server.routes = [
        createReverseProxyRoute(input.host, input.upstreamDial),
        ...existingRoutes.filter((route) => !routeMatchesHost(route, input.host)),
    ];
    servers[input.serverName] = server;
    await loadCaddyConfig(input.adminUrl, config);
}
async function getCaddyConfig(adminUrl) {
    const response = await fetch(caddyUrl(adminUrl, "/config"), {
        cache: "no-store",
    });
    if (!response.ok) {
        throw new Error(`Caddy Admin API returned ${response.status} while reading /config`);
    }
    return await response.json();
}
async function loadCaddyConfig(adminUrl, config) {
    const response = await fetch(caddyUrl(adminUrl, "/load"), {
        method: "POST",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify(config),
    });
    if (!response.ok) {
        throw new Error(`Caddy Admin API returned ${response.status} while loading config: ${await response.text()}`);
    }
}
function maybeHandleProbe(request, options) {
    const url = request.nextUrl ?? new URL(request.url);
    if (url.pathname !== options.probePath) {
        return;
    }
    const requestToken = request.headers.get("x-nslocalhost-probe")
        ?? url.searchParams.get("token");
    if (requestToken !== options.probeToken) {
        return new Response("not found", { status: 404 });
    }
    return new Response("ok", {
        headers: {
            "cache-control": "no-store",
            "x-nslocalhost-probe": options.probeToken,
        },
    });
}
function resolveUpstream(request, options) {
    const hostHeader = request.headers.get("host");
    if (!hostHeader) {
        return;
    }
    const parsed = parseHostHeader(hostHeader);
    if (!parsed?.port || parsed.hostname === options.host) {
        return;
    }
    const upstreamHost = options.upstreamHost || normalizeLoopbackHost(parsed.hostname);
    return {
        dial: `${upstreamHost}:${parsed.port}`,
    };
}
function parseHostHeader(hostHeader) {
    try {
        const url = new URL(`http://${hostHeader}`);
        const port = url.port ? Number.parseInt(url.port, 10) : undefined;
        if (port !== undefined && !Number.isInteger(port)) {
            return;
        }
        return {
            hostname: url.hostname,
            port,
        };
    }
    catch {
        return;
    }
}
function createReverseProxyRoute(host, upstreamDial) {
    return {
        match: [{ host: [host] }],
        handle: [
            {
                handler: "reverse_proxy",
                upstreams: [{ dial: upstreamDial }],
            },
        ],
        terminal: true,
    };
}
function routeMatchesHost(route, host) {
    return route.match?.some((matcher) => matcher.host?.includes(host)) ?? false;
}
function ensureHttpServers(config) {
    config.apps ??= {};
    config.apps.http ??= {};
    config.apps.http.servers ??= {};
    return config.apps.http.servers;
}
function buildProbeUrl(options) {
    const url = new URL(`${options.publicScheme}://${formatPublicHost(options)}${options.probePath}`);
    url.searchParams.set("token", options.probeToken);
    return url.toString();
}
function formatPublicHost(options) {
    const isDefaultPort = (options.publicScheme === "http" && options.publicPort === 80)
        || (options.publicScheme === "https" && options.publicPort === 443);
    return isDefaultPort
        ? options.host
        : `${options.host}:${options.publicPort}`;
}
function buildPublicHost(name, domain = DEFAULT_DOMAIN) {
    const cleanDomain = domain.replace(/^\.+|\.+$/g, "");
    return `${name}.${cleanDomain}`;
}
function resolveName(name) {
    const resolved = sanitizeHostLabel(name ?? "");
    if (!resolved) {
        throw new Error("nslocalhost Next middleware requires either name or host");
    }
    return resolved;
}
function sanitizeHostLabel(name) {
    return name
        .toLowerCase()
        .replace(/^@/, "")
        .replace(/\//g, "-")
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
}
function normalizeLoopbackHost(hostname) {
    if (hostname === "localhost" || hostname === "0.0.0.0" || hostname === "::") {
        return "127.0.0.1";
    }
    if (hostname.includes(":") && !hostname.startsWith("[")) {
        return `[${hostname}]`;
    }
    return hostname;
}
function normalizeProbePath(path) {
    return path.startsWith("/") ? path : `/${path}`;
}
function caddyUrl(adminUrl, pathname) {
    const url = new URL(adminUrl);
    url.pathname = pathname;
    return url.toString();
}
function isDevelopment() {
    return typeof process === "undefined" || process.env.NODE_ENV !== "production";
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
