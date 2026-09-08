// Reproduce the accepted repair chain. All candidates come from production routes.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
const script="scripts/probe-box-rescheduling.mjs";
const summary={schemaVersion:1,capturedAt:new Date().toISOString(),node:process.version,
  scriptSha256:createHash("sha256").update(readFileSync(script)).digest("hex"),
  methodology:"diagnostic H-first repair followed by two alphabetical typed-box sweeps; strict improvements only; no reference input",
  samples:[]};
const started=performance.now();
function run(label,tag,input,route="rewrite"){
  const child=spawnSync(process.execPath,["--experimental-strip-types",script,`--route=${route}`,`--label=${label}`,`--tag=${tag}`,
    ...(input?[`--input=${input}`]:[])],{encoding:"utf8",timeout:130000,windowsHide:true,maxBuffer:1000000});
  assert.equal(child.status,0,child.error?.message||child.stderr);
  const artifact=`docs/benchmarks/grand-hall-reschedule-${tag}-${label}.json`,result=JSON.parse(readFileSync(artifact,"utf8"));
  summary.samples.push({artifact,...result});console.log(`${tag}/${label}: ${result.sourceMoves} -> ${result.moves??result.status}`);
  return {artifact,result};
}
run("H","discovery",undefined,"discovery");
let best;
for(const label of ["A","B","C","D","G","H"]){const sample=run(label,"rewrite");if(label==="H")best=sample;}
assert.ok(best.result.verified);
for(let round=1;round<=2;round++)for(const label of ["A","B","C","D","G","H"]){
  const candidate=run(label,`pass${round}`,best.artifact);
  if(candidate.result.verified){assert.ok(candidate.result.moves<best.result.moves);best=candidate;}
}
summary.bestArtifact=best.artifact;summary.moves=best.result.moves;summary.pushes=best.result.pushes;
summary.wallMs=performance.now()-started;
writeFileSync("docs/benchmarks/grand-hall-rescheduling-summary.json",JSON.stringify(summary,null,2)+"\n");
writeFileSync("docs/benchmarks/grand-hall-rescheduled-solution.txt",best.result.actionLog+"\n");
console.log(JSON.stringify({moves:summary.moves,pushes:summary.pushes,wallMs:summary.wallMs}));
