import {parsePuzzleRows} from '../src/core/index.ts';
import {runExactMoveAStar} from '../src/solver/search/exact-move-astar.ts';
const board=parsePuzzleRows(['OOOOOOOOOO','ORX    S O','OOOOOOOOOO']);
const context=()=>({signal:new AbortController().signal,reportProgress:()=>{},now:()=>performance.now()});
const request={board,snapshot:{puzzleId:'audit-memory',robot:board.initialRobot,boxes:board.initialBoxes,moves:0,pushes:0,solved:false},objective:{kind:'moves'},limits:{maxMemoryBytes:20000}};
for(const features of [undefined,{forcedPushMacros:false}]) {
 const r=await runExactMoveAStar(request,context(),{features});console.log(JSON.stringify({features:features??'default',limit:request.limits.maxMemoryBytes,status:r.status,moves:r.solution?.moves,reason:r.reason,detail:r.detail,estimated:r.metrics.counters.estimatedMemoryBytes,forced:r.metrics.counters.forcedPushMacroApplications}));
}
