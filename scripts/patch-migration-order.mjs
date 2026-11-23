// usage: node patch-migration-order.mjs <app dir>
// Makes the storage migrations run in the order of their names, which start with a timestamp.
//
// PowerSync lists its storage migrations with fs.readdir and runs them in the order it gets.
// Node's readdir returns names sorted; Bun's returns them in the order the filesystem keeps
// them. Measured on PowerSync 1.29.1: the JIT image without this patch ran 9 of the Postgres
// storage migrations and 13 of the MongoDB ones out of order, and one build ran
// `snapshot-progress` before `init` and failed on a fresh database. The AOT binary happened
// to list them sorted. Sorting the list gives every runtime the order upstream tests with.
// The gate checks the order (test/compare.mjs).
import path from 'node:path';
import { rewrite, run } from './rewrite.mjs';

run(() => {
  const app = process.argv[2];
  if (!app) throw new Error('usage: patch-migration-order.mjs <app dir>');
  console.log(rewrite(path.join(app, 'packages/service-core/dist/migrations/PowerSyncMigrationManager.js'), {
    name: 'migration-order',
    re: /const files = await fs\.readdir\(migrationsDir\);/,
    to: 'const files = (await fs.readdir(migrationsDir)).sort();',
    done: '(await fs.readdir(migrationsDir)).sort()',
  }));
});
