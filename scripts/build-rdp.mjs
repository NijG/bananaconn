// Builds the bx-rdp helper and places it where Tauri's externalBin expects it
// (src-tauri/binaries/bx-rdp-<target-triple>.exe). Tauri then copies it next
// to the app executable as bx-rdp.exe in dev builds and installers.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = join(root, "rdp-helper", "Cargo.toml");
const triple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();

execFileSync("cargo", ["build", "--release", "--manifest-path", manifest], { stdio: "inherit" });

const outDir = join(root, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
copyFileSync(join(root, "rdp-helper", "target", "release", "bx-rdp.exe"), join(outDir, `bx-rdp-${triple}.exe`));
console.log(`bx-rdp -> src-tauri/binaries/bx-rdp-${triple}.exe`);
