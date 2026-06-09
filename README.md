# nslocalhost

Local dev helper that maps a project hostname such as `projectname.localhost` to the actual port your framework selected at startup.

The dev server still binds to a free local port. `nslocalhost` registers that port with a local Caddy reverse proxy, so the browser URL can stay stable:

```text
http://projectname.localhost -> http://127.0.0.1:5173
```

## Install

```sh
bun add -D nslocalhost
```

For local development from this checkout:

```sh
bun add -D ~/source/lcabraja/nslocalhost
```

## Start Caddy

Caddy must be running locally with the Admin API enabled. This repo includes a bootstrap config at `caddy/bootstrap.json` with the admin listener on `127.0.0.1:2019` and an empty `nslocalhost` HTTP server on port `80`.

```sh
bun run caddy:start
```

Port `80` usually requires elevated privileges. If you do not want Caddy to bind to `80`, copy `caddy/bootstrap.json`, change the listen address to `":8080"`, configure the plugin with `listen: [":8080"]`, and visit `http://projectname.localhost:8080`.

## Install Caddy As A macOS Service

The package can install the bundled Caddy bootstrap config as a macOS LaunchDaemon. It does not install Caddy itself. The command only proceeds when `caddy` is already available in `PATH`, or when you pass an explicit executable with `--path-to-caddy`.

From a project that already has `nslocalhost` installed:

```sh
bunx nslocalhost
```

As a one-shot command from GitHub:

```sh
bunx --package git+https://github.com/lcabraja/nslocalhost.git nslocalhost
```

If Caddy is not in `PATH`:

```sh
bunx --package git+https://github.com/lcabraja/nslocalhost.git nslocalhost --path-to-caddy /opt/homebrew/bin/caddy
```

If port `80` is already occupied by another process, stop that process or choose a different public listener port:

```sh
bunx --package git+https://github.com/lcabraja/nslocalhost.git nslocalhost --port 8080
```

The command is idempotent:

```text
nslocalhost: setup is already complete
nslocalhost: setup initiating...
nslocalhost: setup complete
nslocalhost: something is already listening on port 80. Stop it, or choose another port with --port <port>.
```

The installer writes:

```text
/Library/Application Support/nslocalhost/caddy/bootstrap.json
/Library/LaunchDaemons/dev.nslocalhost.caddy.plist
/var/log/nslocalhost-caddy.log
/var/log/nslocalhost-caddy.error.log
```

To stop and remove the service manually:

```sh
sudo launchctl bootout system /Library/LaunchDaemons/dev.nslocalhost.caddy.plist
sudo rm /Library/LaunchDaemons/dev.nslocalhost.caddy.plist
sudo rm -rf "/Library/Application Support/nslocalhost"
```

## Vite Usage

```ts
import { defineConfig } from "vite";
import { nsLocalhost } from "nslocalhost";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 3000,
    strictPort: false,
    open: false,
  },
  plugins: [
    nsLocalhost({
      name: "projectname",
    }),
  ],
});
```

When Vite starts, it can choose `3000`, `3001`, `3002`, or any other available port. The browser opens the stable URL:

```text
http://projectname.localhost
```

## Next.js Usage

Next.js does not use Vite plugin hooks. Use the `nslocalhost/next` middleware helper instead.

Your normal dev script stays normal:

```json
{
  "nslocalhost": {
    "subdomain": "projectname",
    "domain": "localhost"
  },
  "scripts": {
    "dev": "next dev"
  }
}
```

`domain` is optional and defaults to `localhost`.

Create one shared local config file:

```ts
// nslocalhost.config.ts
import { defineNsLocalhostConfig } from "nslocalhost/next";
import packageJson from "./package.json";

export const localdev = defineNsLocalhostConfig({
  packageJson,
  caddyAdminUrl: "http://127.0.0.1:2019",
  publicPort: 80,
});
```

Add `middleware.ts` at the root of your Next app, or inside `src` if your app uses `src`:

```ts
import { nsLocalhostMiddleware } from "nslocalhost/next";
import { localdev } from "./nslocalhost.config";

export const middleware = nsLocalhostMiddleware(localdev);

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

Add the dev origin to `next.config.ts`:

```ts
import type { NextConfig } from "next";
import { localdev } from "./nslocalhost.config";

const nextConfig: NextConfig = {
  allowedDevOrigins: [localdev.host],
};

export default nextConfig;
```

Then run:

```sh
bun run dev
```

Open the direct Next URL once, for example:

```text
http://localhost:3000
```

The middleware will infer the current dev server port from that request, register this route in Caddy, and verify it by requesting a probe URL through Caddy:

```text
http://projectname.localhost/__nslocalhost_probe
```

Only the configured middleware answers that probe with the expected token. If Caddy is not running, cannot load config, points to the wrong upstream, or the public hostname does not reach this Next middleware, the dev server console prints a warning prefixed with `[nslocalhost]`.

## Astro Usage

Astro is built with Vite, so use the Vite plugin through Astro's `vite` config field:

```js
import { defineConfig } from "astro/config";
import { nsLocalhost } from "nslocalhost";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 4321,
    open: false,
    allowedHosts: ["projectname.localhost"],
  },
  vite: {
    plugins: [
      nsLocalhost({
        name: "projectname",
      }),
    ],
  },
});
```

Astro automatically tries the next available port when the configured port is already busy.

## Options

```ts
type NsLocalhostOptions = {
  name?: string;
  domain?: string;
  caddyAdminUrl?: string;
  caddyServerName?: string;
  listen?: string[];
  upstreamHost?: string;
  open?: boolean;
  cleanup?: boolean;
  strict?: boolean;
  hmr?: boolean;
  log?: boolean;
};
```

- `name`: hostname prefix. Defaults to `package.json` name.
- `domain`: hostname suffix. Defaults to `localhost`.
- `caddyAdminUrl`: defaults to `http://127.0.0.1:2019`.
- `caddyServerName`: defaults to `nslocalhost`.
- `listen`: Caddy listen addresses. Defaults to `[":80"]`.
- `upstreamHost`: upstream host used for Vite. Defaults to Vite's actual bound host, normalized to loopback for wildcard binds.
- `open`: open the public URL after registration. Defaults to `true`.
- `cleanup`: unregister the hostname when Vite shuts down. Defaults to `true`.
- `strict`: fail the Vite startup if Caddy registration fails. Defaults to `false`.
- `hmr`: add HMR defaults for the public host. Defaults to `true`.
- `log`: print the registered route. Defaults to `true`.

## Next Middleware Options

```ts
type NsLocalhostNextOptions = {
  packageJson?: {
    name?: unknown;
    nslocalhost?: {
      subdomain?: unknown;
      domain?: unknown;
    };
  };
  name?: string;
  subdomain?: string;
  host?: string;
  domain?: string;
  publicScheme?: "http" | "https";
  publicPort?: number;
  caddyAdminUrl?: string;
  caddyServerName?: string;
  listen?: string[];
  upstreamHost?: string;
  probePath?: string;
  probeToken?: string;
  enabled?: boolean;
  warn?: (message: string) => void;
};
```

- `packageJson`: consuming app package metadata. Reads `nslocalhost.subdomain`, `nslocalhost.domain`, and then `name` as fallback.
- `name`: hostname prefix. Overrides `packageJson.nslocalhost.subdomain`.
- `subdomain`: hostname prefix. Overrides `packageJson.nslocalhost.subdomain`.
- `host`: full public hostname, for example `projectname.localhost`.
- `domain`: hostname suffix used with `subdomain` or `name`. Overrides `packageJson.nslocalhost.domain` and defaults to `localhost`.
- `publicScheme`: public Caddy scheme used for verification. Defaults to `http`.
- `publicPort`: public Caddy port used for verification. Defaults to `80`.
- `caddyAdminUrl`: Caddy Admin API. Defaults to `http://127.0.0.1:2019`.
- `caddyServerName`: Caddy server name. Defaults to `nslocalhost`.
- `listen`: Caddy listen addresses used if the server does not exist yet. Defaults to `[":80"]`.
- `upstreamHost`: override the upstream host registered with Caddy.
- `probePath`: route used to verify that Caddy reaches this middleware. Defaults to `/__nslocalhost_probe`.
- `probeToken`: explicit probe token. Defaults to a deterministic route token.
- `enabled`: keep running without registering when false. Defaults to development only.
- `warn`: custom warning function. Defaults to `console.warn`.

## Notes

The plugin updates Caddy through `POST /load` after reading the current config from `GET /config`. It only manages one Caddy HTTP server, named `nslocalhost` by default, and it replaces routes for the same hostname.

Use `.localhost` unless you have a reason not to. Browsers reserve it for loopback, so `projectname.localhost` works without editing `/etc/hosts`.
