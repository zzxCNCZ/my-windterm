import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const cargoPackage = read('src-tauri/Cargo.toml').split(/^\[/m)[1];
const npmLock = JSON.parse(read('package-lock.json'));
const versions = [
  JSON.parse(read('src-tauri/tauri.conf.json')).version,
  JSON.parse(read('package.json')).version,
  npmLock.version,
  npmLock.packages[''].version,
  cargoPackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
];
const version = versions[0];
const tag = process.env.RELEASE_TAG || (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : '');
if (!/^\d+\.\d+\.\d+$/.test(version) || versions.some(candidate => candidate !== version) || (tag && tag !== version)) {
  throw new Error(`Version mismatch: application versions ${versions.join(', ')}; Git tag ${tag || '(none)'}.`);
}
console.log(`My WindTerm ${version}: release versions match.`);
