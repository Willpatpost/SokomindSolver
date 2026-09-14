import {configureSearchScheduler} from '../src/solver/search/scheduling.ts';
configureSearchScheduler(()=>Promise.resolve());
import {parsePuzzleRows} from '../src/core/index.ts';
import {runExactMoveAStar} from '../src/solver/search/exact-move-astar.ts';
import {ALL_OFF_EXACT_SEARCH_FEATURES} from '../src/solver/search/exact-search-features.ts';
import {compileSearchBoard} from '../src/solver/search/compiled-board.ts';
import {toDenseBoxes} from '../src/solver/search/model.ts';
import {exactRemainingMoves} from '../tests/support/exact-solver-oracle.ts';
const context=()=>({signal:new AbortController().signal,reportProgress:()=>{},now:()=>performance.now()});
let seed=918273; const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296;};
let solved=0;
for(let n=0;n<15000;n++) {
 const h=6,w=7; const grid=Array.from({length:h},(_,r)=>Array.from({length:w},(_,c)=>r===0||c===0||r===h-1||c===w-1||rnd()<0.16?'O':' '));
 const free=[];for(let r=1;r<h-1;r++)for(let c=1;c<w-1;c++)if(grid[r][c]===' ')free.push([r,c]);
 if(free.length<5)continue;
 for(const v of ['R','X','X','S','S']) {const ix=Math.floor(rnd()*free.length); const [r,c]=free.splice(ix,1)[0]; grid[r][c]=v;}
 const rows=grid.map(r=>r.join(''));let board;try{board=parsePuzzleRows(rows);}catch{continue;}
 const request={board,snapshot:{puzzleId:'forced-audit',robot:board.initialRobot,boxes:board.initialBoxes,moves:0,pushes:0,solved:false},objective:{kind:'moves'},limits:{maxExpandedStates:5000,maxElapsedMs:500}};
 const control=await runExactMoveAStar(request,context(),{features:ALL_OFF_EXACT_SEARCH_FEATURES});
 if(control.status!=='solved') continue; solved++;
 const test=await runExactMoveAStar(request,context(),{features:{...ALL_OFF_EXACT_SEARCH_FEATURES,forcedPushMacros:true}});
 if(test.status!=='solved'||control.solution.moves!==test.solution.moves) {
   const compiled=compileSearchBoard(board);const oracle=exactRemainingMoves(compiled,compiled.cellAt(board.initialRobot.row,board.initialRobot.column),toDenseBoxes(compiled,board.initialBoxes));
   console.log(JSON.stringify({n,rows,control,test,oracle},null,2));break;
 }
 if(n%250===0)console.log(JSON.stringify({n,solved}));
 if(n===14999) console.log(JSON.stringify({done:true,n,solved}));
}

