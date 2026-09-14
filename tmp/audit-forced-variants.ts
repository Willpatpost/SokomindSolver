import {parsePuzzleRows} from '../src/core/index.ts';
import {runExactMoveAStar} from '../src/solver/search/exact-move-astar.ts';
import {runIdaStarSearch} from '../src/solver/search/ida-star.ts';
import {classicAStarSolver} from '../src/solver/implementations/classic-solvers.ts';
import {verifySolverSolution} from '../src/solver/verification.ts';
import {isSolverResult} from '../src/solver/validation.ts';
import {collectProofIssues} from '../src/solver/proof.ts';
import {compileSearchBoard} from '../src/solver/search/compiled-board.ts';
import {toDenseBoxes} from '../src/solver/search/model.ts';
import {exactRemainingMoves} from '../tests/support/exact-solver-oracle.ts';
const base=['OOOOOOO','OO    O','O    RO','O  XSXO','O   OSO','OOOOOOO'];
const variants={base,mirror:base.map(r=>[...r].reverse().join('')),rotate180:[...base].reverse().map(r=>[...r].reverse().join(''))};
const context=()=>({signal:new AbortController().signal,reportProgress:()=>{},now:()=>performance.now()});
for (const [variant,rows] of Object.entries(variants)) {
 const board=parsePuzzleRows(rows); const request={board,snapshot:{puzzleId:'audit-forced',robot:board.initialRobot,boxes:board.initialBoxes,moves:0,pushes:0,solved:false},objective:{kind:'moves'}};
 const compiled=compileSearchBoard(board);
 const oracle=exactRemainingMoves(compiled,compiled.cellAt(board.initialRobot.row,board.initialRobot.column),toDenseBoxes(compiled,board.initialBoxes));
 console.log(JSON.stringify({variant,rows,oracle}));
 for(const [name,fn,options] of [['public classic A*',classicAStarSolver.solve,undefined],['A* forced off',runExactMoveAStar,{features:{forcedPushMacros:false}}],['default IDA*',runIdaStarSearch,undefined]]) {
 const r=await fn(request,context(),options);console.log(JSON.stringify({variant,name,status:r.status,moves:r.solution?.moves,pushes:r.solution?.pushes,steps:r.solution?.steps,optimality:r.solution?.optimality,proof:r.proof,replay:r.status==='solved'?verifySolverSolution(request,r.solution).valid:undefined,resultValid:isSolverResult(r),proofIssues:collectProofIssues(r.proof,r.solution),expanded:r.metrics.expandedStates,generated:r.metrics.generatedStates,frontier:r.metrics.counters.frontierSize,forced:r.metrics.counters.forcedPushMacroApplications}));
 }
}
