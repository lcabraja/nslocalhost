#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DEFAULT_ADMIN_URL } from "./index.js";

type InstallCaddyOptions = {
  pathToCaddy?: string;
  label: string;
  configPath: string;
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
};

const DEFAULT_CADDY_LABEL = "dev.nslocalhost.caddy";
const DEFAULT_CADDY_CONFIG_PATH = "/Library/Application Support/nslocalhost/caddy/bootstrap.json";
const DEFAULT_CADDY_PLIST_PATH = `/Library/LaunchDaemons/${DEFAULT_CADDY_LABEL}.plist`;
const DEFAULT_CADDY_STDOUT_PATH = "/var/log/nslocalhost-caddy.log";
const DEFAULT_CADDY_STDERR_PATH = "/var/log/nslocalhost-caddy.error.log";

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`nslocalhost: ${message}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  await installCaddyMacos(parseArgs(process.argv.slice(2)));
}

async function installCaddyMacos(options: InstallCaddyOptions): Promise<void> {
  if (os.platform() !== "darwin") {
    throw new Error("only supports macOS.");
  }

  const caddyPath = resolveCaddyPath(options.pathToCaddy);
  const bundledConfigPath = getBundledCaddyConfigPath();
  const plist = createLaunchDaemonPlist({
    caddyPath,
    configPath: options.configPath,
    label: options.label,
    stderrPath: options.stderrPath,
    stdoutPath: options.stdoutPath,
  });
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "nslocalhost-caddy-"));

  try {
    const tempConfigPath = path.join(tempDir, "bootstrap.json");
    const tempPlistPath = path.join(tempDir, `${options.label}.plist`);

    writeFileSync(tempConfigPath, readFileSync(bundledConfigPath, "utf8"));
    writeFileSync(tempPlistPath, plist);

    await sudo("install", ["-d", "-m", "0755", path.dirname(options.configPath)]);
    await sudo("install", ["-m", "0644", tempConfigPath, options.configPath]);
    await sudo("install", ["-m", "0644", tempPlistPath, options.plistPath]);
    await sudo("launchctl", ["bootout", "system", options.plistPath], { allowFailure: true });
    await sudo("launchctl", ["bootstrap", "system", options.plistPath]);
    await sudo("launchctl", ["enable", `system/${options.label}`]);
    await sudo("launchctl", ["kickstart", "-k", `system/${options.label}`]);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }

  console.log(`nslocalhost: installed ${options.label}`);
  console.log(`nslocalhost: caddy: ${caddyPath}`);
  console.log(`nslocalhost: config: ${options.configPath}`);
  console.log(`nslocalhost: logs: ${options.stdoutPath}, ${options.stderrPath}`);
  console.log(`nslocalhost: admin API: ${DEFAULT_ADMIN_URL}`);
}

function parseArgs(args: string[]): InstallCaddyOptions {
  const options: InstallCaddyOptions = {
    label: DEFAULT_CADDY_LABEL,
    configPath: DEFAULT_CADDY_CONFIG_PATH,
    plistPath: DEFAULT_CADDY_PLIST_PATH,
    stdoutPath: DEFAULT_CADDY_STDOUT_PATH,
    stderrPath: DEFAULT_CADDY_STDERR_PATH,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--path-to-caddy") {
      options.pathToCaddy = readValue(args, ++index, arg);
    } else if (arg === "--label") {
      options.label = readValue(args, ++index, arg);
      options.plistPath = `/Library/LaunchDaemons/${options.label}.plist`;
    } else if (arg === "--config-path") {
      options.configPath = readValue(args, ++index, arg);
    } else if (arg === "--plist-path") {
      options.plistPath = readValue(args, ++index, arg);
    } else if (arg === "--stdout-path") {
      options.stdoutPath = readValue(args, ++index, arg);
    } else if (arg === "--stderr-path") {
      options.stderrPath = readValue(args, ++index, arg);
    } else {
      throw new Error(`unknown option "${arg}".`);
    }
  }

  return options;
}

function resolveCaddyPath(explicitPath?: string): string {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);

    if (!isExecutableFile(resolved)) {
      throw new Error(`--path-to-caddy does not point to an executable file: ${resolved}`);
    }

    return resolved;
  }

  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

  for (const dir of pathDirs) {
    const candidate = path.join(dir, "caddy");

    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  throw new Error("caddy was not found in PATH. Install Caddy or pass --path-to-caddy /absolute/path/to/caddy.");
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stats = statSync(candidate);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function getBundledCaddyConfigPath(): string {
  const scriptPath = fileURLToPath(import.meta.url);
  const bundledConfigPath = path.resolve(path.dirname(scriptPath), "..", "caddy", "bootstrap.json");

  if (!existsSync(bundledConfigPath)) {
    throw new Error(`bundled Caddy config was not found at ${bundledConfigPath}`);
  }

  return bundledConfigPath;
}

function createLaunchDaemonPlist(input: {
  caddyPath: string;
  configPath: string;
  label: string;
  stderrPath: string;
  stdoutPath: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapePlist(input.caddyPath)}</string>
    <string>run</string>
    <string>--config</string>
    <string>${escapePlist(input.configPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapePlist(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(input.stderrPath)}</string>
</dict>
</plist>
`;
}

function escapePlist(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function sudo(command: string, args: string[], options: { allowFailure?: boolean } = {}): Promise<void> {
  const result = await runCommand("/usr/bin/sudo", [command, ...args]);

  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(`sudo ${command} ${args.join(" ")} failed with exit code ${result.code}`);
  }
}

function runCommand(command: string, args: string[]): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code });
    });
  });
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function printHelp(): void {
  console.log(`nslocalhost

Installs the bundled nslocalhost Caddy bootstrap config as a macOS LaunchDaemon.

Usage:
  nslocalhost [options]

Options:
  --path-to-caddy <path>     Caddy executable to use. Required when caddy is not in PATH.
  --label <label>            LaunchDaemon label. Defaults to ${DEFAULT_CADDY_LABEL}.
  --config-path <path>       Installed config path. Defaults to ${DEFAULT_CADDY_CONFIG_PATH}.
  --plist-path <path>        Installed plist path. Defaults to ${DEFAULT_CADDY_PLIST_PATH}.
  --stdout-path <path>       stdout log path. Defaults to ${DEFAULT_CADDY_STDOUT_PATH}.
  --stderr-path <path>       stderr log path. Defaults to ${DEFAULT_CADDY_STDERR_PATH}.
`);
}
