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
test("live memory stops retained-state growth independently of generous work limits", () => {
  const payload = {algorithm: "solution-box-reschedule", state: toLegacyState(request),
    solutionPath: incumbent, rescheduleBoxIndices: [0], rescheduleRounds: 1,
    maxVisited: 300000, maxGenerated: 2000000};
  const metadata = (result: ReturnType<typeof search>) => result.boxRescheduling as
    {peakEstimatedBytes: number; memoryExhausted: boolean};
  const preflight = search({...payload, maxMemoryBytes: 1});
  // Allow a few retained nodes beyond the measured table/scratch reservation.
  const memoryLimit = metadata(preflight).peakEstimatedBytes + 3 * 768;
  const bounded = search({...payload, maxMemoryBytes: memoryLimit});
  const ample = search({...payload, maxMemoryBytes: memoryLimit + 1024 * 1024});
  assert.equal(metadata(bounded).memoryExhausted, true);
  assert.ok((bounded.generated ?? 0) > 0);
  assert.ok((bounded.visited ?? 0) < payload.maxVisited);
  assert.ok((bounded.generated ?? 0) < payload.maxGenerated);
  assert.equal(metadata(ample).memoryExhausted, false);
  assert.ok((ample.generated ?? 0) > (bounded.generated ?? 0));
  assert.ok(bounded.path && ample.path);
  events(bounded.path); events(ample.path);
});

const repeatedSession = createSession({id:"reschedule-repeated",title:"Repeated labels",difficulty:"tutorial",boxes:2,
  rows:["OOOOOOO","O  R  O","O X S O","O X S O","O     O","OOOOOOO"]});
const repeatedRequest = {board:repeatedSession.board,snapshot:repeatedSession.snapshot,objective:{kind:"moves" as const}};
const repeatedIncumbent = [..."DDDLLUURRDDLLURR"].map(code => ({L:"Left",R:"Right",U:"Up",D:"Down"})[code]!);
test("repair publishes independently replayable improvements before its terminal result",()=>{
  const original = globalThis.postMessage;
  const publications: Array<{path: string[]; visited: number; generated: number}> = [];
  globalThis.postMessage = ((data: {type: string; path?: string[]; visited: number; generated: number}) => {
    if (data.type === "progress" && data.path) publications.push({...data, path: [...data.path]});
  }) as typeof globalThis.postMessage;
  try {
    const result = search({algorithm: "solution-box-reschedule", state: toLegacyState(request),
      solutionPath: incumbent, rescheduleRounds: 2, maxVisited: 10000, maxGenerated: 40000});
    assert.ok(publications.length > 0);
    let previousMoves = incumbent.length;
    for (const publication of publications) {
      const solution = solutionFromLegacyPath(request, publication.path);
      assert.ok(solution && verifySolverSolution(request, solution).valid);
      assert.ok(publication.path.length < previousMoves);
      assert.ok(publication.visited <= 10000 && publication.generated <= 40000);
      previousMoves = publication.path.length;
    }
    assert.equal(previousMoves, result.path?.length);
  } finally {
    globalThis.postMessage = original;
  }
});

test("repeated-label boxes are eligible for rescheduling",()=>{
  const result=search({algorithm:"solution-box-reschedule",state:toLegacyState(repeatedRequest),solutionPath:repeatedIncumbent,
    rescheduleRounds:2,maxVisited:20000,maxGenerated:80000});
  assert.equal(result.status,"solved");
  assert.ok(result.path);
  assert.ok(result.path.length<=repeatedIncumbent.length);
  const solution=solutionFromLegacyPath(repeatedRequest,result.path);
  assert.ok(solution&&verifySolverSolution(repeatedRequest,solution).valid);
  assert.ok((result as Record<string,unknown>).boxRescheduling);
  const rescheduling = (result as Record<string,unknown>).boxRescheduling as {attempts:unknown[]};
  assert.ok(rescheduling.attempts.length>0);
});
test("an incomplete or illegal incumbent cannot become a claimed solution",()=>{
  for(const path of [[],["Up"],["invented"]]){
    const result=search({algorithm:"solution-box-reschedule",state:toLegacyState(request),solutionPath:path});
    assert.equal(result.status,"failed");assert.equal(result.path,null);
  }
});
