import type { Plugin } from "vite";
export type NsLocalhostOptions = {
    /**
     * Project label used for the hostname. Defaults to package.json name.
     * Scoped package names such as @acme/web become acme-web.localhost.
     */
    name?: string;
    /**
     * Host suffix. The default is localhost, so a name of "app" becomes
     * app.localhost.
     */
    domain?: string;
    /**
     * Caddy Admin API base URL.
     */
    caddyAdminUrl?: string;
    /**
     * Caddy HTTP server name managed by this plugin.
     */
    caddyServerName?: string;
    /**
     * Listen addresses for the managed Caddy server.
     */
    listen?: string[];
    /**
     * Upstream host for Vite. Keep this on loopback for local development.
     */
    upstreamHost?: string;
    /**
     * Open the public localhost URL after registration.
     */
    open?: boolean;
    /**
     * Remove the registered route when Vite shuts down.
     */
    cleanup?: boolean;
    /**
     * Throw when proxy registration fails. By default Vite keeps running and
     * logs a warning.
     */
    strict?: boolean;
    /**
     * Add Vite HMR defaults for the public host. User-provided HMR settings win.
     */
    hmr?: boolean;
    /**
     * Print route registration messages.
     */
    log?: boolean;
};
export type RegisteredRoute = {
    host: string;
    target: string;
    url: string;
};
export declare function nsLocalhost(options?: NsLocalhostOptions): Plugin;
export default nsLocalhost;
export declare function registerCaddyRoute(input: {
    adminUrl?: string;
    serverName?: string;
    listen?: string[];
    host: string;
    upstreamDial: string;
}): Promise<void>;
export declare function unregisterCaddyRoute(input: {
    adminUrl?: string;
    serverName?: string;
    host: string;
}): Promise<void>;
//# sourceMappingURL=index.d.ts.map