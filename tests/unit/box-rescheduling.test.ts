import assert from "node:assert/strict";
import {test} from "node:test";
import {createSession, stepSnapshot, type Direction, type GameSnapshot} from "../../src/core/index.ts";
import {search} from "../../src/solver/implementations/sokomind-engine/engine.generated.js";
import {solutionFromLegacyPath, toLegacyState} from "../../src/solver/implementations/sokomind-solver.ts";
import {verifySolverSolution} from "../../src/solver/verification.ts";

const session = createSession({id:"reschedule-oracle",title:"Reschedule oracle",difficulty:"tutorial",boxes:2,
  rows:["OOOOOOO","O  R  O","O A a O","O B b O","O     O","OOOOOOO"]});
const request = {board:session.board,snapshot:session.snapshot,objective:{kind:"moves" as const}};
const incumbent = [..."LLDDRRUULDLDDRULURR"].map(code => ({L:"Left",R:"Right",U:"Up",D:"Down"})[code]!);
const position = (snapshot:GameSnapshot,index:number) => JSON.stringify(snapshot.boxes[index].position);
function events(path:readonly string[]) {
  let snapshot=request.snapshot;
  const result:Array<{index:number;from:string;to:string}>=[];
  for(const move of path){const next=stepSnapshot(request.board,snapshot,move.toLowerCase() as Direction);
    assert.ok(next.moved);
    if(next.pushed){const index=snapshot.boxes.findIndex(box=>box.id===next.pushedBoxId);
      result.push({index,from:position(snapshot,index),to:position(next.snapshot,index)});}
    snapshot=next.snapshot;
  }
  assert.ok(snapshot.solved);return result;
}
// Independent primitive-move BFS oracle, with no heuristic or push macros.
function oracle(selected:number) {
  const fixed=events(incumbent).filter(event=>event.index!==selected);
  const queue=[{snapshot:request.snapshot,phase:0}],seen=new Set<string>();
  for(let i=0;i<queue.length;i++){
    const current=queue[i];if(current.snapshot.solved)return current.snapshot.moves;
    for(const direction of ["up","down","left","right"] as const){
      const next=stepSnapshot(request.board,current.snapshot,direction);if(!next.moved)continue;
      let phase=current.phase;
      if(next.pushed){const index=current.snapshot.boxes.findIndex(box=>box.id===next.pushedBoxId);
        if(index!==selected){const expected=fixed[phase];
          if(!expected||index!==expected.index||position(current.snapshot,index)!==expected.from||position(next.snapshot,index)!==expected.to)continue;
          phase++;
        }
      }
      const key=JSON.stringify([phase,next.snapshot.robot,next.snapshot.boxes.map(box=>box.position)]);
      if(seen.has(key))continue;seen.add(key);queue.push({snapshot:next.snapshot,phase});
    }
  }
  throw new Error("Oracle did not solve fixture");
}
test("box rescheduling matches a primitive-move oracle and preserves the other push chain",()=>{
  for(const selected of [0,1]){
    const result=search({algorithm:"solution-box-reschedule",state:toLegacyState(request),solutionPath:incumbent,
      rescheduleBoxIndices:[selected],rescheduleRounds:1,maxVisited:10000,maxGenerated:40000});
    assert.ok(result.path);assert.equal(result.path.length,oracle(selected));
    if(selected===0)assert.ok(result.path.length<incumbent.length);
    const fixed=(path:readonly string[])=>events(path).filter(event=>event.index!==selected);
    assert.deepEqual(fixed(result.path),fixed(incumbent));
    const solution=solutionFromLegacyPath(request,result.path);
    assert.ok(solution&&verifySolverSolution(request,solution).valid);
  }
});
test("exhausted rescheduling budgets preserve a verified incumbent",()=>{
  for(const options of [{maxVisited:0},{maxGenerated:0},{rescheduleMaxMs:0},{rescheduleRounds:0},{maxMemoryBytes:1}]){
    const result=search({algorithm:"solution-box-reschedule",state:toLegacyState(request),solutionPath:incumbent,...options});
    assert.equal(result.status,"solved");assert.ok(result.path&&result.path.length<=incumbent.length);assert.equal(result.visited,0);
    events(result.path);
  }
  const bounded=search({algorithm:"solution-box-reschedule",state:toLegacyState(request),solutionPath:incumbent,maxVisited:1,maxGenerated:1});
  assert.ok((bounded.visited??0)<=1);assert.ok((bounded.generated??0)<=1);assert.ok(bounded.path);
  events(bounded.path);
});
test("an incomplete or illegal incumbent cannot become a claimed solution",()=>{
  for(const path of [[],["Up"],["invented"]]){
    const result=search({algorithm:"solution-box-reschedule",state:toLegacyState(request),solutionPath:path});
    assert.equal(result.status,"failed");assert.equal(result.path,null);
  }
});
