import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {BENCHMARK_PROFILES, runBenchmarkSample, selectBenchmarkFixtures} from '../../scripts/solver-v2-benchmark-lib.ts';
const id = process.argv[2] === 'quality' ? 'sokomind-quality' : 'sokomind-fast';
const profile = {...BENCHMARK_PROFILES[id], limits: {...BENCHMARK_PROFILES[id].limits, maxElapsedMs: 30000}};
const result = await runBenchmarkSample(selectBenchmarkFixtures(['huge'])[0], profile);
const output = {methodology: 'One fresh-process production-adapter smoke sample; 30-second shared limit; not a promotable baseline or timing comparison.',
  gitCommit: execFileSync('git', ['rev-parse','HEAD'], {encoding:'utf8', windowsHide:true}).trim(),
  node:process.version, sample:result};
writeFileSync(new URL(`./${id}-sample.json`, import.meta.url), JSON.stringify(output, null, 2));
console.log(JSON.stringify({profile:id, status:result.status, moves:result.moves, pushes:result.pushes,
  elapsedMs:result.elapsedMs, expanded:result.expandedStates, generated:result.generatedStates,
  optimality:result.optimality, verified:result.verified, accepted:result.accepted}));
