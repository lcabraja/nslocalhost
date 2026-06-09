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
export declare function defineNsLocalhostConfig(options: NsLocalhostNextOptions): NsLocalhostNextConfig;
export declare function nsLocalhostMiddleware(options?: NsLocalhostNextOptions): (request: NsLocalhostNextRequest, event?: NsLocalhostNextEvent) => Response | undefined;
export default nsLocalhostMiddleware;
//# sourceMappingURL=next.d.ts.map