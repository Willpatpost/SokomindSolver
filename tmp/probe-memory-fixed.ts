import {parsePuzzleRows} from '../src/core/index.ts';
import {runExactMoveAStar} from '../src/solver/search/exact-move-astar.ts';
const board=parsePuzzleRows(['OOOOOOOOOO','ORX    S O','OOOOOOOOOO']);const req={board,snapshot:{puzzleId:'mem-probe',robot:board.initialRobot,boxes:board.initialBoxes,moves:0,pushes:0,solved:false},objective:{kind:'moves'}};
const ctx=()=>({signal:new AbortController().signal,reportProgress:()=>{},now:()=>performance.now()});
const root=await runExactMoveAStar({...req,limits:{maxExpandedStates:0}},ctx()); const bytes=root.metrics.counters.estimatedMemoryBytes;
console.log(JSON.stringify({root:root.metrics}));
for(const delta of [0,180,200,280,320,400,1000]) {
 const result=await runExactMoveAStar({...req,limits:{maxMemoryBytes:bytes+delta}},ctx());console.log(JSON.stringify({delta,status:result.status,reason:result.reason,metrics:result.metrics}));
}
