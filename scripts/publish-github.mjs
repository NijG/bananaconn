// Publish the release to GitHub Releases, where installed apps look first
// (src/store.ts UPDATE_URL = https://github.com/<owner>/<repo>/releases/latest/download/).
//
//   node scripts/publish-github.mjs <owner/repo> [notes file]
//
// The signed latest.json and the installers are made by publish-update.mjs
// into a staging folder, then uploaded as the assets of release v<version>.
// "releases/latest/download/<name>" always serves the newest release, so the
// manifest and its installers are found under one address.
// Needs the GitHub CLI, signed in by the user: gh auth login.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [repo, notesFile] = process.argv.slice(2);
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error("usage: node scripts/publish-github.mjs <owner/repo> [notes file]");
  process.exit(2);
}
const gh = (...args) => execFileSync("gh", args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
try {
  gh("auth", "status");
} catch {
  console.error("GitHub CLI (gh) is missing or not signed in: install it and run gh auth login");
  process.exit(2);
}

const { version, productName } = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const stage = path.join(root, "src-tauri", "target", "release", "bundle", `github-${version}`);
fs.rmSync(stage, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(root, "scripts", "publish-update.mjs"), stage, ...(notesFile ? [notesFile] : [])], { stdio: "inherit" });

// The manifest goes last: a client that sees it can already fetch the installers.
const files = [`${productName}_${version}_x64-setup.exe`, `${productName}_${version}_x64_en-US.msi`, "latest.json"]
  .map((f) => path.join(stage, f))
  .filter((f) => fs.existsSync(f));
const tag = `v${version}`;
let exists = true;
try {
  gh("release", "view", tag, "--repo", repo);
} catch {
  exists = false;
}
if (exists) {
  gh("release", "upload", tag, ...files, "--repo", repo, "--clobber");
} else {
  // The release page is public: its text is the English notes when there are any.
  const english = notesFile && notesFile.replace(/\.txt$/i, ".en.txt");
  const page = english && fs.existsSync(english) ? english : notesFile;
  const notes = page ? ["--notes-file", page] : ["--notes", ""];
  gh("release", "create", tag, ...files.slice(0, -1), "--repo", repo, "--title", `${productName}. ${tag}`, ...notes);
  gh("release", "upload", tag, files[files.length - 1], "--repo", repo);
}
console.log(`published ${tag} to https://github.com/${repo}/releases/tag/${tag}`);
