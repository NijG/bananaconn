// Publish the release installers to the update folder with a signed
// latest.json, so installed apps can update themselves (src-tauri/src/updater.rs).
//
//   node scripts/publish-update.mjs <update folder> [notes file]
//
// The signing key never leaves the build machine:
//   BX_UPDATE_KEY (path of the Ed25519 PEM file).
// latest.json is written last and atomically, so a client never sees a
// manifest whose installer is still being copied.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [target, notesFile] = process.argv.slice(2);
if (!target) {
  console.error("usage: node scripts/publish-update.mjs <update folder> [notes file]");
  process.exit(2);
}
const keyPath = process.env.BX_UPDATE_KEY;
if (!keyPath) {
  console.error("set BX_UPDATE_KEY to the update signing key (an Ed25519 PEM file kept outside the repository)");
  process.exit(2);
}
const key = crypto.createPrivateKey(fs.readFileSync(keyPath));

const { version, productName } = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const bundle = path.join(root, "src-tauri", "target", "release", "bundle");
const nsis = `${productName}_${version}_x64-setup.exe`;
const msi = `${productName}_${version}_x64_en-US.msi`;
const notes = notesFile ? fs.readFileSync(notesFile, "utf8").trim() : "";

fs.mkdirSync(target, { recursive: true });
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const copy = (name, dir) => {
  const src = path.join(bundle, dir, name);
  if (!fs.existsSync(src)) throw new Error(`missing ${src} — run "npx tauri build" first`);
  const tmp = path.join(target, `${name}.part`);
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, path.join(target, name));
  return sha(path.join(target, name));
};

// Release notes in the other screen languages: next to the notes file as
// <name>.<language>.txt (e.g. notes-0725.en.txt, notes-0725.zh-CN.txt).
const notesI18n = {};
if (notesFile) {
  const base = notesFile.replace(/\.txt$/i, "");
  for (const lang of ["de", "en", "es", "fr", "ja", "vi", "zh-CN", "zh-TW"]) {
    const file = `${base}.${lang}.txt`;
    if (fs.existsSync(file)) notesI18n[lang] = fs.readFileSync(file, "utf8").trim();
  }
}

const manifest = { version, nsis, nsisSha256: copy(nsis, "nsis"), msi, msiSha256: copy(msi, "msi"), notes };
// Same text as updater.rs `signed_message`.
const message = ["bananaxterm-update", manifest.version, manifest.nsis, manifest.nsisSha256, manifest.msi, manifest.msiSha256, manifest.notes].join("\n");
manifest.signature = crypto.sign(null, Buffer.from(message), key).toString("base64");
if (Object.keys(notesI18n).length) {
  // updater.rs `signed_message_v2`: the first message, then the translations
  // as compact JSON with sorted keys (as serde_json writes a BTreeMap).
  const sorted = Object.fromEntries(Object.keys(notesI18n).sort().map((k) => [k, notesI18n[k]]));
  manifest.notesI18n = sorted;
  manifest.signatureV2 = crypto.sign(null, Buffer.from(`${message}\nnotes-i18n\n${JSON.stringify(sorted)}`), key).toString("base64");
}

const tmp = path.join(target, "latest.json.part");
fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
fs.renameSync(tmp, path.join(target, "latest.json"));

// Keep the two newest versions next to the manifest (installers of versions
// before the rename carry the previous product name).
const INSTALLER = /^(?:BananaConn|BananaTerm|BananaXterm)_(\d+\.\d+\.\d+)_/;
const versions = fs
  .readdirSync(target)
  .map((f) => INSTALLER.exec(f)?.[1])
  .filter(Boolean)
  .filter((v, i, a) => a.indexOf(v) === i)
  .sort((a, b) => b.split(".").map(Number).reduce((r, n, i) => r || n - a.split(".").map(Number)[i], 0));
for (const old of versions.slice(2)) {
  for (const f of fs.readdirSync(target)) {
    if (INSTALLER.exec(f)?.[1] !== old) continue;
    // Pruning is housekeeping: the release is already published above.
    try {
      fs.rmSync(path.join(target, f));
    } catch (err) {
      console.warn(`could not remove old ${f}: ${err.code ?? err.message}`);
    }
  }
}
console.log(`published v${version} to ${target}`);
