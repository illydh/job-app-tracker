/** Run one sync from the terminal and print the outcome. */
import { runSync } from "../lib/sync.ts";
import { stats } from "../lib/db.ts";

const result = await runSync();

console.log(`\n  ${result.phase === "error" ? "Sync failed" : "Sync complete"}: ${result.message}`);
console.log(`  fetched ${result.fetched} · prefiltered ${result.prefiltered} · classified ${result.classified} · matched ${result.matched}`);
if (result.errors.length > 0) {
  console.log(`  ${result.errors.length} error(s):`);
  for (const e of result.errors.slice(0, 10)) console.log(`    - ${e}`);
}
console.log(`  totals:`, stats(), "\n");
process.exit(result.phase === "error" ? 1 : 0);
