// Cut a release: bump the version in lockstep across manifest.json, versions.json,
// and package.json, then commit and create a *bare* git tag (no `v` prefix).
// Obsidian's community store requires the release tag to equal the manifest
// version exactly, so the tag must be e.g. `0.2.0`, not `v0.2.0`.
//
//   Usage:  pnpm run release 0.2.0      (or: node version-bump.mjs 0.2.0)
//   Then:   git push --follow-tags      -> triggers .github/workflows/release.yml
//
// We do bump+commit+tag here rather than via `pnpm version` because pnpm ignores
// `tag-version-prefix` and always tags `v0.2.0`, which the store can't resolve.
import { readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";

const target = process.argv[2];
if (!target || !/^\d+\.\d+\.\d+$/.test(target)) {
  console.error("Usage: pnpm run release <version>   e.g. pnpm run release 0.2.0");
  process.exit(1);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

// Refuse if the tag already exists.
try {
  git("rev-parse", "--verify", "--quiet", `refs/tags/${target}`);
  console.error(`Tag ${target} already exists. Pick a new version, or delete it with: git tag -d ${target}`);
  process.exit(1);
} catch {
  // rev-parse exits non-zero when the tag is absent — that's what we want.
}

const writeJson = (file, obj) => writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = target;
writeJson("manifest.json", manifest);

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[target] = manifest.minAppVersion;
writeJson("versions.json", versions);

// Update package.json's version surgically so its formatting is left untouched.
const pkgRaw = readFileSync("package.json", "utf8");
writeFileSync("package.json", pkgRaw.replace(/("version":\s*")[^"]*(")/, `$1${target}$2`));

// Commit only these three files (pathspec form, so unrelated work isn't swept in),
// then tag the release with the bare version.
git("commit", "manifest.json", "versions.json", "package.json", "-m", `Release ${target}`);
git("tag", target);

console.log(`Released ${target} — bumped manifest.json, versions.json, package.json, committed, and tagged ${target}.`);
console.log(`Push to publish:  git push --follow-tags`);
