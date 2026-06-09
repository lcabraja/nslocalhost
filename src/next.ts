type CaddyRoute = {
  handle?: Array<Record<string, unknown>>;
  match?: Array<{ host?: string[] } & Record<string, unknown>>;
  terminal?: boolean;
  [key: string]: unknown;
};

type CaddyServer = {
  listen?: string[];
  routes?: CaddyRoute[];
  [key: string]: unknown;
};

type CaddyConfig = {
  apps?: {
    http?: {
      servers?: Record<string, CaddyServer>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type NsLocalhostNextRequest = Request & {
  nextUrl?: URL;
};

export type NsLocalhostNextEvent = {
  waitUntil?: (promise: Promise<unknown>) => void;
};

export type NsLocalhostNextOptions = {
  /**
   * Consuming app package metadata. Reads nslocalhost.subdomain,
   * nslocalhost.domain, and name.
   */
  packageJson?: NsLocalhostPackageJson;

  /**
   * Project label used for the hostname. Overrides packageJson.nslocalhost.subdomain.
   */
  name?: string;

  /**
   * Project label used for the hostname. Overrides packageJson.nslocalhost.subdomain.
   */
  subdomain?: string;

  /**
   * Full public hostname, for example projectname.localhost.
   */
  host?: string;

  /**
   * Host suffix used with name. Defaults to localhost.
   */
  domain?: string;

  /**
   * Public URL scheme used for route verification. Defaults to http.
   */
  publicScheme?: "http" | "https";

  /**
   * Public Caddy listener port used for route verification. Defaults to 80.
   */
  publicPort?: number;

  /**
   * Caddy Admin API base URL.
   */
  caddyAdminUrl?: string;

  /**
   * Caddy HTTP server name managed by this helper.
   */
  caddyServerName?: string;

  /**
   * Listen addresses used if the Caddy server does not exist yet.
   */
  listen?: string[];

  /**
   * Override the upstream host registered with Caddy.
   */
  upstreamHost?: string;

  /**
   * Route used to verify that Caddy reaches this middleware.
   */
  probePath?: string;

  /**
   * Explicit probe token. Defaults to a deterministic route token.
   */
  probeToken?: string;

  /**
   * Keep running without registering when false. Defaults to development only.
   */
  enabled?: boolean;

  /**
   * Print warnings when registration or verification fails.
   */
  warn?: (message: string) => void;
};

export type NsLocalhostPackageJson = {
  name?: unknown;
  nslocalhost?: {
    subdomain?: unknown;
    domain?: unknown;
  };
};

export type NsLocalhostNextConfig = NsLocalhostNextOptions & {
  /**
   * Resolved public hostname prefix, for example projectname.
   */
  subdomain: string;

  /**
   * Resolved public hostname suffix, for example localhost.
   */
  domain: string;

  /**
   * Resolved public hostname, for example projectname.localhost.
   */
  host: string;
};

type RegisterInput = {
  adminUrl: string;
  serverName: string;
  listen: string[];
  host: string;
  upstreamDial: string;
};

const DEFAULT_ADMIN_URL = "http://127.0.0.1:2019";
const DEFAULT_CADDY_SERVER = "nslocalhost";
const DEFAULT_DOMAIN = "localhost";
const DEFAULT_PROBE_PATH = "/__nslocalhost_probe";

const registrations = new Map<string, Promise<void>>();

export function defineNsLocalhostConfig(
  options: NsLocalhostNextOptions,
): NsLocalhostNextConfig {
  const naming = resolveNaming(options);

  return {
    ...options,
    name: options.name ?? naming.subdomain,
    subdomain: options.subdomain ?? options.name ?? naming.subdomain,
    domain: options.domain ?? naming.domain,
    host: options.host ?? buildPublicHost(naming.subdomain, naming.domain),
  };
}

export function nsLocalhostMiddleware(options: NsLocalhostNextOptions = {}) {
  return (
    request: NsLocalhostNextRequest,
    event?: NsLocalhostNextEvent,
  ): Response | undefined => {
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
    } else {
      void registration;
    }

    return;
  };
}

export default nsLocalhostMiddleware;

function resolveOptions(options: NsLocalhostNextOptions): Required<NsLocalhostNextOptions> {
  const config = defineNsLocalhostConfig(options);
  const host = config.host;
  const probeToken = options.probeToken ?? `nslocalhost:${host}`;
  const publicScheme = options.publicScheme ?? "http";

  return {
    packageJson: options.packageJson ?? {},
    name: config.name ?? config.subdomain,
    subdomain: config.subdomain,
    host,
    domain: config.domain ?? DEFAULT_DOMAIN,
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

async function ensureRegistered(
  request: NsLocalhostNextRequest,
  options: Required<NsLocalhostNextOptions>,
): Promise<void> {
  const upstream = resolveUpstream(request, options);

  if (!upstream) {
    options.warn(
      `[nslocalhost] ${options.host} was not registered because the current request host does not expose a local dev port. Open the direct Next dev URL once, for example http://localhost:3000.`,
    );
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

async function registerAndVerify(
  options: Required<NsLocalhostNextOptions>,
  upstreamDial: string,
): Promise<void> {
  try {
    await registerCaddyRoute({
      adminUrl: options.caddyAdminUrl,
      serverName: options.caddyServerName,
      listen: options.listen,
      host: options.host,
      upstreamDial,
    });
  } catch (error: unknown) {
    options.warn(
      `[nslocalhost] could not register ${options.host} -> http://${upstreamDial}: ${formatError(error)}`,
    );
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
      options.warn(
        `[nslocalhost] ${options.host} was registered, but the Caddy probe did not reach this Next middleware. Probe ${probeUrl} returned ${response.status}.`,
      );
      return;
    }

    console.info(`[nslocalhost] ${options.publicScheme}://${formatPublicHost(options)} -> http://${upstreamDial}`);
  } catch (error: unknown) {
    options.warn(
      `[nslocalhost] ${options.host} was registered, but the Caddy probe failed at ${probeUrl}: ${formatError(error)}`,
    );
  }
}

async function registerCaddyRoute(input: RegisterInput): Promise<void> {
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

async function getCaddyConfig(adminUrl: string): Promise<CaddyConfig> {
  const response = await fetch(caddyUrl(adminUrl, "/config"), {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Caddy Admin API returned ${response.status} while reading /config`);
  }

  return await response.json() as CaddyConfig;
}

async function loadCaddyConfig(adminUrl: string, config: CaddyConfig): Promise<void> {
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

function maybeHandleProbe(
  request: NsLocalhostNextRequest,
  options: Required<NsLocalhostNextOptions>,
): Response | undefined {
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

function resolveUpstream(
  request: NsLocalhostNextRequest,
  options: Required<NsLocalhostNextOptions>,
): { dial: string } | undefined {
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

function parseHostHeader(hostHeader: string): { hostname: string; port?: number } | undefined {
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
  } catch {
    return;
  }
}

function createReverseProxyRoute(host: string, upstreamDial: string): CaddyRoute {
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

function routeMatchesHost(route: CaddyRoute, host: string): boolean {
  return route.match?.some((matcher) => matcher.host?.includes(host)) ?? false;
}

function ensureHttpServers(config: CaddyConfig): Record<string, CaddyServer> {
  config.apps ??= {};
  config.apps.http ??= {};
  config.apps.http.servers ??= {};
  return config.apps.http.servers;
}

function buildProbeUrl(options: Required<NsLocalhostNextOptions>): string {
  const url = new URL(`${options.publicScheme}://${formatPublicHost(options)}${options.probePath}`);
  url.searchParams.set("token", options.probeToken);
  return url.toString();
}

function formatPublicHost(options: Required<NsLocalhostNextOptions>): string {
  const isDefaultPort = (options.publicScheme === "http" && options.publicPort === 80)
    || (options.publicScheme === "https" && options.publicPort === 443);

  return isDefaultPort
    ? options.host
    : `${options.host}:${options.publicPort}`;
}

function buildPublicHost(name: string, domain = DEFAULT_DOMAIN): string {
  const cleanDomain = domain.replace(/^\.+|\.+$/g, "");
  return `${name}.${cleanDomain}`;
}

function resolveName(name: string | undefined): string {
  const resolved = sanitizeHostLabel(name ?? "");

  if (!resolved) {
    throw new Error("nslocalhost Next middleware requires either name or host");
  }

  return resolved;
}

function resolveNaming(options: NsLocalhostNextOptions): { subdomain: string; domain: string } {
  const packageConfig = options.packageJson?.nslocalhost;
  const rawSubdomain = options.subdomain
    ?? options.name
    ?? stringValue(packageConfig?.subdomain)
    ?? stringValue(options.packageJson?.name)
    ?? options.host?.split(".")[0];
  const subdomain = sanitizeHostLabel(rawSubdomain ?? "");

  if (!subdomain) {
    throw new Error("nslocalhost Next middleware requires packageJson.nslocalhost.subdomain, packageJson.name, name, subdomain, or host");
  }

  return {
    subdomain,
    domain: options.domain ?? stringValue(packageConfig?.domain) ?? DEFAULT_DOMAIN,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sanitizeHostLabel(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/\//g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function normalizeLoopbackHost(hostname: string): string {
  if (hostname === "localhost" || hostname === "0.0.0.0" || hostname === "::") {
    return "127.0.0.1";
  }

  if (hostname.includes(":") && !hostname.startsWith("[")) {
    return `[${hostname}]`;
  }

  return hostname;
}

function normalizeProbePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function caddyUrl(adminUrl: string, pathname: string): string {
  const url = new URL(adminUrl);
  url.pathname = pathname;
  return url.toString();
}

function isDevelopment(): boolean {
  return typeof process === "undefined" || process.env.NODE_ENV !== "production";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
