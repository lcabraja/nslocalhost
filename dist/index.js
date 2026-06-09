import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const DEFAULT_ADMIN_URL = "http://127.0.0.1:2019";
const DEFAULT_CADDY_SERVER = "nslocalhost";
const DEFAULT_DOMAIN = "localhost";
export function nsLocalhost(options = {}) {
    const state = {};
    return {
        name: "nslocalhost",
        apply: "serve",
        config(userConfig) {
            if (options.hmr === false) {
                return;
            }
            const root = path.resolve(userConfig.root ?? process.cwd());
            const host = buildPublicHost(resolveProjectName(root, options.name), options.domain);
            const existingHmr = userConfig.server?.hmr;
            if (existingHmr === false) {
                return;
            }
            return {
                server: {
                    hmr: {
                        host,
                        clientPort: 80,
                        ...(typeof existingHmr === "object" ? existingHmr : {}),
                    },
                },
            };
        },
        configResolved(config) {
            state.config = config;
            state.host = buildPublicHost(resolveProjectName(config.root, options.name), options.domain);
        },
        configureServer(server) {
            const cleanup = options.cleanup ?? true;
            server.httpServer?.once("listening", () => {
                void register(server, state.host ?? "app.localhost", options)
                    .then((route) => {
                    state.registered = route;
                    if (options.log ?? true) {
                        server.config.logger.info(`\n  nslocalhost: ${route.url} -> ${route.target}\n`);
                    }
                    if (options.open ?? true) {
                        openUrl(route.url, server.config.logger.warn);
                    }
                })
                    .catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    if (options.strict) {
                        throw error;
                    }
                    server.config.logger.warn(`nslocalhost: ${message}`);
                });
            });
            if (cleanup) {
                const unregister = () => {
                    if (!state.registered || state.unregistering) {
                        return state.unregistering;
                    }
                    state.unregistering = unregisterCaddyRoute({
                        adminUrl: options.caddyAdminUrl ?? DEFAULT_ADMIN_URL,
                        serverName: options.caddyServerName ?? DEFAULT_CADDY_SERVER,
                        host: state.registered.host,
                    }).catch((error) => {
                        const message = error instanceof Error ? error.message : String(error);
                        server.config.logger.warn(`nslocalhost cleanup: ${message}`);
                    });
                    return state.unregistering;
                };
                server.httpServer?.once("close", () => {
                    void unregister();
                });
                server.watcher.on("close", () => {
                    void unregister();
                });
            }
        },
    };
}
export default nsLocalhost;
export async function registerCaddyRoute(input) {
    const adminUrl = input.adminUrl ?? DEFAULT_ADMIN_URL;
    const serverName = input.serverName ?? DEFAULT_CADDY_SERVER;
    const listen = input.listen ?? [":80"];
    const config = await getCaddyConfig(adminUrl);
    const servers = ensureHttpServers(config);
    const server = servers[serverName] ?? {};
    const existingRoutes = Array.isArray(server.routes) ? server.routes : [];
    server.listen = Array.isArray(server.listen) && server.listen.length > 0
        ? server.listen
        : listen;
    server.routes = [
        createReverseProxyRoute(input.host, input.upstreamDial),
        ...existingRoutes.filter((route) => !routeMatchesHost(route, input.host)),
    ];
    servers[serverName] = server;
    await loadCaddyConfig(adminUrl, config);
}
export async function unregisterCaddyRoute(input) {
    const adminUrl = input.adminUrl ?? DEFAULT_ADMIN_URL;
    const serverName = input.serverName ?? DEFAULT_CADDY_SERVER;
    const config = await getCaddyConfig(adminUrl);
    const servers = config.apps?.http?.servers;
    const server = servers?.[serverName];
    if (!server || !Array.isArray(server.routes)) {
        return;
    }
    const routes = server.routes.filter((route) => !routeMatchesHost(route, input.host));
    if (routes.length === server.routes.length) {
        return;
    }
    server.routes = routes;
    await loadCaddyConfig(adminUrl, config);
}
async function register(server, host, options) {
    const address = server.httpServer?.address();
    if (!isAddressInfo(address)) {
        throw new Error("Vite server address is unavailable.");
    }
    const upstreamHost = options.upstreamHost ?? normalizeUpstreamHost(address.address);
    const upstreamDial = `${upstreamHost}:${address.port}`;
    const target = `http://${upstreamDial}`;
    await registerCaddyRoute({
        adminUrl: options.caddyAdminUrl,
        serverName: options.caddyServerName,
        listen: options.listen,
        host,
        upstreamDial,
    });
    return {
        host,
        target,
        url: `http://${host}`,
    };
}
function buildPublicHost(projectName, domain = DEFAULT_DOMAIN) {
    const cleanDomain = domain.replace(/^\.+|\.+$/g, "");
    return `${projectName}.${cleanDomain}`;
}
function resolveProjectName(root, explicitName) {
    const rawName = explicitName ?? readPackageName(root) ?? path.basename(root);
    const name = sanitizeHostLabel(rawName);
    if (!name) {
        throw new Error("nslocalhost could not resolve a valid project name.");
    }
    return name;
}
function readPackageName(root) {
    const packagePath = path.join(root, "package.json");
    if (!existsSync(packagePath)) {
        return;
    }
    try {
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
        return typeof packageJson.name === "string" ? packageJson.name : undefined;
    }
    catch {
        return;
    }
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
function normalizeUpstreamHost(address) {
    if (address === "::" || address === "0.0.0.0") {
        return "127.0.0.1";
    }
    if (address.includes(":") && !address.startsWith("[")) {
        return `[${address}]`;
    }
    return address;
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
async function getCaddyConfig(adminUrl) {
    const response = await fetch(caddyUrl(adminUrl, "/config"));
    if (!response.ok) {
        throw new Error(`Caddy Admin API returned ${response.status} while reading /config.`);
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
        const body = await response.text();
        throw new Error(`Caddy Admin API returned ${response.status} while loading config: ${body}`);
    }
}
function caddyUrl(adminUrl, pathname) {
    const url = new URL(adminUrl);
    url.pathname = pathname;
    return url.toString();
}
function isAddressInfo(address) {
    return typeof address === "object" && address !== null && typeof address.port === "number";
}
function openUrl(url, warn) {
    const command = os.platform() === "darwin"
        ? "open"
        : os.platform() === "win32"
            ? "cmd"
            : "xdg-open";
    const args = os.platform() === "win32" ? ["/c", "start", "", url] : [url];
    execFile(command, args, (error) => {
        if (error) {
            warn(`nslocalhost: failed to open ${url}: ${error.message}`);
        }
    });
}
