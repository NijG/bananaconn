// Publish release v<version>, built by GitHub Actions (.github/workflows/release.yml),
// to GitHub Releases, where installed apps look first (src/store.ts UPDATE_URL =
// https://github.com/<owner>/<repo>/releases/latest/download/), and optionally
// to an update folder (a NAS) with the very same installers.
//
//   node scripts/publish-github.mjs <owner/repo> [notes file] [--nas <update folder>]
//
// 1. Pushing the tag v<version> makes the workflow attach the installers to a
//    draft release.
// 2. This script downloads them and verifies their build provenance: built by
//    that workflow of <owner/repo>, from the tag v<version>, on a GitHub-hosted
//    runner. Anything else is refused.
// 3. latest.json is signed here with the update key (publish-update.mjs; the
//    key never leaves this machine), uploaded last, and the release is
//    published with the English notes.
// Needs the GitHub CLI, signed in by the user: gh auth login.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = args.indexOf("--nas");
const nas = flag >= 0 ? args.splice(flag, 2)[1] : undefined;
const [repo, notesFile] = args;
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || (flag >= 0 && !nas)) {
  console.error("usage: node scripts/publish-github.mjs <owner/repo> [notes file] [--nas <update folder>]");
  process.exit(2);
}
const gh = (...a) => execFileSync("gh", a, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
try {
  gh("auth", "status");
} catch {
  console.error("GitHub CLI (gh) is missing or not signed in: install it and run gh auth login");
  process.exit(2);
}

const { version, productName } = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const tag = `v${version}`;
const installers = [`${productName}_${version}_x64-setup.exe`, `${productName}_${version}_x64_en-US.msi`];

let release;
try {
  release = JSON.parse(gh("release", "view", tag, "--repo", repo, "--json", "isDraft,assets"));
} catch {
  console.error(`release ${tag} not found: push the tag ${tag}, wait for the "Release build" workflow, then run this again`);
  process.exit(1);
}
const names = release.assets.map((a) => a.name);
const missing = installers.filter((n) => !names.includes(n));
if (missing.length) {
  console.error(`release ${tag} has no ${missing.join(", ")} yet: is the "Release build" workflow still running?`);
  process.exit(1);
}

const stage = path.join(root, "src-tauri", "target", "release", "bundle", `github-${version}`);
const ci = path.join(stage, "ci");
const out = path.join(stage, "out");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(ci, { recursive: true });
for (const name of installers) gh("release", "download", tag, "--repo", repo, "--pattern", name, "--dir", ci);

for (const name of installers) {
  gh(
    "attestation", "verify", path.join(ci, name),
    "--repo", repo,
    "--signer-workflow", `${repo}/.github/workflows/release.yml`,
    "--source-ref", `refs/tags/${tag}`,
    "--deny-self-hosted-runners",
  );
  console.log(`verified ${name}: built by ${repo} release.yml from ${tag}`);
}

const publish = (target) =>
  execFileSync(process.execPath, [path.join(root, "scripts", "publish-update.mjs"), target, ...(notesFile ? [notesFile] : []), "--installers", ci], {
    stdio: "inherit",
  });
publish(out);

// The manifest goes last: a client that sees it can already fetch the installers.
gh("release", "upload", tag, path.join(out, "latest.json"), "--repo", repo, "--clobber");
// The release page is public: its text is the English notes when there are any.
const english = notesFile && notesFile.replace(/\.txt$/i, ".en.txt");
const page = english && fs.existsSync(english) ? english : notesFile;
gh("release", "edit", tag, "--repo", repo, ...(page ? ["--notes-file", page] : []), "--draft=false", "--latest");
console.log(`published ${tag} to https://github.com/${repo}/releases/tag/${tag}`);

if (nas) publish(nas);
