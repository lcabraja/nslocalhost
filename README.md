# nslocalhost

Vite plugin that maps a project hostname such as `projectname.localhost` to the actual port Vite selected at startup.

Vite still binds to a free local port. `nslocalhost` registers that port with a local Caddy reverse proxy, so the browser URL can stay stable:

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

## Notes

The plugin updates Caddy through `POST /load` after reading the current config from `GET /config`. It only manages one Caddy HTTP server, named `nslocalhost` by default, and it replaces routes for the same hostname.

Use `.localhost` unless you have a reason not to. Browsers reserve it for loopback, so `projectname.localhost` works without editing `/etc/hosts`.
