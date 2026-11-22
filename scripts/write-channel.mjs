// usage: write-channel.mjs <powersync> <bun revision> <bun channel> <tag> <aot digest> <jit digest> <upstream sha> <aot image> <jit image> <results root>
// Records a published build in channels/: `latest.json` is what deployments follow, and
// `<powersync version>.json` keeps the newest build of each PowerSync version, for rollbacks.
// `newStorageMigrations` lists the storage migrations this build has that the previous latest
// did not: they run on start and cannot be undone, so a rollback across them is not a tag change.
import fs from 'node:fs';
const [powersync, bun, bunChannel, tag, aotDigest, jitDigest, upstreamSha, aotImage, jitImage, results] = process.argv.slice(2);
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const previous = read('channels/latest.json');
const migrations = fs.readFileSync(`${results}/migrations.txt`, 'utf8').trim().split('\n').filter(Boolean).sort();
// The AOT binary's own build report (scripts/compile.sh): sizes and what --trim removed.
const report = (() => { try { return fs.readFileSync(`${results}/build-report.txt`, 'utf8'); } catch { return ''; } })();
const aotBuild = Object.fromEntries([...report.matchAll(/^(binary_bytes|binary_bytes_untrimmed|trim_saved_bytes|trim_removed|trim_kept)=(\d+)$/gm)].map(([, k, v]) => [k, Number(v)]));
const gate = Object.fromEntries(['mongodb', 'postgresql'].map((s) => [s, read(`${results}/${s}/results/report.json`)?.rows ?? null]));
const entry = {
  powersync, bun, bunChannel, tag, builtAt: new Date().toISOString(), upstreamSha,
  aot: { image: aotImage, ref: `${aotImage}:${tag}`, digest: aotDigest, build: aotBuild },
  jit: { image: jitImage, ref: `${jitImage}:${tag}`, digest: jitDigest },
  storageMigrations: migrations,
  newStorageMigrations: previous ? migrations.filter((m) => !previous.storageMigrations.includes(m)) : [],
  previous: previous && { tag: previous.tag, powersync: previous.powersync, bun: previous.bun },
  gate,
};
fs.mkdirSync('channels', { recursive: true });
fs.writeFileSync('channels/latest.json', JSON.stringify(entry, null, 2) + '\n');
fs.writeFileSync(`channels/${powersync}.json`, JSON.stringify(entry, null, 2) + '\n');
