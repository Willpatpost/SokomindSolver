import {parsePuzzleRows} from '../src/core/index.ts';
import {runExactMoveAStar} from '../src/solver/search/exact-move-astar.ts';
import {runIdaStarSearch} from '../src/solver/search/ida-star.ts';
import {ALL_OFF_EXACT_SEARCH_FEATURES} from '../src/solver/search/exact-search-features.ts';
import {verifySolverSolution} from '../src/solver/verification.ts';
import {compileSearchBoard} from '../src/solver/search/compiled-board.ts';
import {toDenseBoxes} from '../src/solver/search/model.ts';
import {exactRemainingMoves} from '../tests/support/exact-solver-oracle.ts';
const rows=['OOOOOOO','OO    O','O    RO','O  XSXO','O   OSO','OOOOOOO'];
const board=parsePuzzleRows(rows); const request={board,snapshot:{puzzleId:'audit-forced',robot:board.initialRobot,boxes:board.initialBoxes,moves:0,pushes:0,solved:false},objective:{kind:'moves'}};
const context=()=>({signal:new AbortController().signal,reportProgress:()=>{},now:()=>performance.now()});
for(const [name,fn,options] of [['default A*',runExactMoveAStar,undefined],['A* forced off',runExactMoveAStar,{features:{forcedPushMacros:false}}],['default IDA*',runIdaStarSearch,undefined],['all off A*',runExactMoveAStar,{features:ALL_OFF_EXACT_SEARCH_FEATURES}]]) {
const result=await fn(request,context(),options); console.log(JSON.stringify({name,status:result.status,solution:result.solution,proof:result.proof,metrics:result.metrics,valid:result.status==='solved'?verifySolverSolution(request,result.solution):undefined}));}
const compiled=compileSearchBoard(board); console.log(JSON.stringify({oracle:exactRemainingMoves(compiled,compiled.cellAt(board.initialRobot.row,board.initialRobot.column),toDenseBoxes(compiled,board.initialBoxes))}));
