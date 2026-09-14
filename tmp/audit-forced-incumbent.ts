import {parsePuzzleRows} from '../src/core/index.ts';
import {runExactMoveAStar} from '../src/solver/search/exact-move-astar.ts';
import {verifySolverSolution} from '../src/solver/verification.ts';
const board=parsePuzzleRows(['OOOOOOO','OO    O','O    RO','O  XSXO','O   OSO','OOOOOOO']);
const request={board,snapshot:{puzzleId:'audit-incumbent',robot:board.initialRobot,boxes:board.initialBoxes,moves:0,pushes:0,solved:false},objective:{kind:'moves'}};
const context=()=>({signal:new AbortController().signal,reportProgress:()=>{},now:()=>performance.now()});
const baseline=await runExactMoveAStar(request,context());
const nine={...baseline.solution,optimality:'unknown'};
const eleven={...nine,steps:[{direction:'left',kind:'walk'},{direction:'right',kind:'walk'},...nine.steps],moves:11,objectiveScore:11};
for(const solution of [nine,eleven]) {
 const incumbent={solution,cost:solution.moves}; const r=await runExactMoveAStar(request,context(),{incumbent});
 console.log(JSON.stringify({incumbentMoves:incumbent.cost,incumbentReplay:verifySolverSolution(request,solution).valid,resultMoves:r.solution?.moves,proof:r.proof}));
}
