// Exact A* within a restricted repair space: keep all other box pushes in order,
// and choose this box's entire schedule freely. Reference routes are excluded.
import assert from "node:assert/strict";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {PUZZLE_BY_ID} from "../src/catalog/puzzles.ts";
import {createSession, stepSnapshot} from "../src/core/index.ts";
import {solutionFromLegacyPath} from "../src/solver/implementations/sokomind-solver.ts";
import {verifySolverSolution} from "../src/solver/verification.ts";
const args = new Map(process.argv.slice(2).map(arg => arg.replace(/^--/, "").split("=")));
const totalStarted=performance.now();
assert.ok([...args.keys()].every(k => ["route","label","max-expanded","input","tag","orientation"].includes(k)));
const routeName = args.get("route") || "discovery", label = args.get("label") || "H";
assert.ok(["discovery","rewrite"].includes(routeName));
assert.match(label,/^[A-Z]$/);
const maxExpanded = Number(args.get("max-expanded") || 300000);
assert.ok(Number.isSafeInteger(maxExpanded) && maxExpanded > 0 && maxExpanded <= 1000000);
const evidence = JSON.parse(readFileSync("docs/benchmarks/grand-hall-route-diagnosis.json", "utf8"));
let route = evidence.routes.find(r => r.name === routeName);
const orientation=args.get("orientation")||"identity";assert.ok(["identity","mirror","rotate"].includes(orientation));
const rows=orientation==="mirror" ? PUZZLE_BY_ID.huge.rows.map(row=>[...row].reverse().join("")) : orientation==="rotate"
  ? [...PUZZLE_BY_ID.huge.rows].reverse().map(row=>[...row].reverse().join("")) : PUZZLE_BY_ID.huge.rows;
const session = createSession({...PUZZLE_BY_ID.huge,rows});
const request = {board: session.board,snapshot: session.snapshot,objective: {kind:"moves"}};
{
  const input=args.has("input") ? JSON.parse(readFileSync(args.get("input"),"utf8")) : null;
  if(input){assert.equal(input.verified,true);assert.equal(input.status,"solved");assert.ok(!input.orientation||input.orientation==="identity","Input must use original coordinates");}
  const codes=[...(input?.actionLog ?? route.actionLog)].map(code=>orientation==="identity" ? code :
    ({L:"R",R:"L",U:orientation==="rotate"?"D":"U",D:orientation==="rotate"?"U":"D"})[code]);
  const moveNames={U:"Up",D:"Down",L:"Left",R:"Right"}, path=codes.map(code=>moveNames[code]);
  const converted=solutionFromLegacyPath(request,path);assert.ok(converted&&verifySolverSolution(request,converted).valid);
  const pushTrace=[];let snapshot=request.snapshot;
  for(const move of path){const next=stepSnapshot(request.board,snapshot,move.toLowerCase());
    if(next.pushed){const before=snapshot.boxes.find(box=>box.id===next.pushedBoxId),after=next.snapshot.boxes.find(box=>box.id===next.pushedBoxId);
      pushTrace.push({boxId:before.id,from:`${before.position.row},${before.position.column}`,to:`${after.position.row},${after.position.column}`});}
    snapshot=next.snapshot;
  }
  route={moves:converted.moves,actionLog:codes.join(""),pushTrace};
}
const tag=args.get("tag")||routeName;assert.match(tag,/^[a-z0-9-]+$/);
const movable = session.snapshot.boxes.filter(box => box.label === label);
assert.equal(movable.length,1,"Select a unique typed box");
const selected = movable[0], key = p => `${p.row},${p.column}`;
const cells = session.board.floor.map(key), ids = new Map(cells.map((cell,index) => [cell,index])), size = cells.length;
const ds = [[-1,0],[1,0],[0,-1],[0,1]], names = ["Up","Down","Left","Right"], opposite = [1,0,3,2];
const edges = cells.map(cell => {const [y,x] = cell.split(",").map(Number);return ds.map(([dy,dx]) => ids.get(`${y+dy},${x+dx}`) ?? -1);});
const target = ids.get(key(session.board.goals.find(goal => goal.label === label).position));
const fixed = route.pushTrace.filter(event => event.boxId !== selected.id).map(event => {
  const from = ids.get(event.from), to = ids.get(event.to), direction = edges[from].indexOf(to);
  assert.ok(direction >= 0);
  return {id:event.boxId,from,to,direction,support:edges[from][opposite[direction]]};
});
const positions = new Map(session.snapshot.boxes.filter(box => box.id !== selected.id).map(box => [box.id,ids.get(key(box.position))]));
const masks = [];
for (let phase = 0; phase <= fixed.length; phase++) {
  const mask = new Uint8Array(size); for (const cell of positions.values()) mask[cell] = 1;
  masks.push(mask);
  if (phase < fixed.length) {assert.equal(positions.get(fixed[phase].id),fixed[phase].from);positions.set(fixed[phase].id,fixed[phase].to);}
}
function walk(start, phase, box = -1, parents = false) {
  const d = new Int16Array(size).fill(-1), parent = parents ? new Int16Array(size).fill(-1) : null;
  const queue = new Int16Array(size); let count = 1; queue[0] = start; d[start] = 0;
  for (let i=0;i<count;i++) for (const next of edges[queue[i]]) {
    if (next<0 || d[next]>=0 || next===box || masks[phase][next]) continue;
    d[next]=d[queue[i]]+1; if(parent)parent[next]=queue[i];queue[count++]=next;
  }
  return {d,parent};
}
// Reverse single-box pushes ignore other boxes, giving an admissible lower bound.
const boxDistance = new Int16Array(size).fill(-1), queue=[target];boxDistance[target]=0;
for(let i=0;i<queue.length;i++)for(let dir=0;dir<4;dir++){
  const previous=edges[queue[i]][dir];
  if(previous<0 || edges[previous][dir]<0 || boxDistance[previous]>=0)continue;
  boxDistance[previous]=boxDistance[queue[i]]+1;queue.push(previous);
}
// Fixed pushes impose keeper travel even if the selected box is absent.
// Do not add box pushes to this travel bound: those movements can overlap.
const remaining = new Float64Array(fixed.length+1);
const supportDistances = fixed.map((event,phase)=>walk(event.support,phase).d);
for(let phase=fixed.length-1;phase>=1;phase--){
  const distance=supportDistances[phase][fixed[phase-1].from];assert.ok(distance>=0);
  remaining[phase]=1+distance+remaining[phase+1];
}
const heuristic = node => {
  if(boxDistance[node.box]<0)return Infinity;
  const pushes=fixed.length-node.phase+boxDistance[node.box];
  if(node.phase===fixed.length)return pushes;
  const distance=supportDistances[node.phase][node.robot];
  return distance<0 ? Infinity : Math.max(pushes,distance+1+remaining[node.phase+1]);
};
const heap=[];
function put(node){let i=heap.length;heap.push(node);while(i){const p=(i-1)>>1;if(heap[p].f<=node.f)break;heap[i]=heap[p];i=p;}heap[i]=node;}
function pop(){const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(2*i+1<heap.length){let c=2*i+1;if(c+1<heap.length&&heap[c+1].f<heap[c].f)c++;if(heap[c].f>=last.f)break;heap[i]=heap[c];i=c;}heap[i]=last;}return first;}
const identity=node=>(node.phase*size+node.box)*size+node.robot;
const root={phase:0,box:ids.get(key(selected.position)),robot:ids.get(key(session.snapshot.robot)),g:0,parent:null};
root.f=heuristic(root);put(root);
const best=new Map([[identity(root),0]]);
let expanded=0,generated=0,solution=null,peak=1;
const started=performance.now(), deadline=started+120000;
while(heap.length && expanded<maxExpanded && performance.now()<deadline){
  const node=pop();if(best.get(identity(node))!==node.g)continue;
  if(node.f>=route.moves)break;
  if(node.phase===fixed.length&&node.box===target){solution=node;break;}
  expanded++;
  const reachable=walk(node.robot,node.phase,node.box).d;
  const add=(phase,box,robot,support,direction)=>{
    if(support<0||reachable[support]<0)return;
    const child={phase,box,robot,g:node.g+reachable[support]+1,parent:node,support,direction};
    const id=identity(child);if((best.get(id)??Infinity)<=child.g)return;
    child.f=child.g+heuristic(child);if(child.f>=route.moves)return;
    best.set(id,child.g);put(child);generated++;
  };
  if(node.phase<fixed.length){const event=fixed[node.phase];
    if(node.box!==event.to && !masks[node.phase][event.to])add(node.phase+1,node.box,event.from,event.support,event.direction);
  }
  for(let dir=0;dir<4;dir++){
    const to=edges[node.box][dir],support=edges[node.box][opposite[dir]];
    if(to>=0&&!masks[node.phase][to])add(node.phase,to,node.box,support,dir);
  }
  peak=Math.max(peak,heap.length);
}
let path,solutionPushes;
if(solution){
  const chain=[];for(let node=solution;node.parent;node=node.parent)chain.push(node);chain.reverse();path=[];
  for(const child of chain){
    const node=child.parent,{parent}=walk(node.robot,node.phase,node.box,true),steps=[];
    for(let cell=child.support;cell!==node.robot;cell=parent[cell]){assert.ok(parent[cell]>=0);steps.push(names[edges[parent[cell]].indexOf(cell)]);}
    path.push(...steps.reverse(),names[child.direction]);
  }
  assert.equal(path.length,solution.g);
  const converted=solutionFromLegacyPath(request,path);
  assert.ok(converted&&verifySolverSolution(request,converted).valid);
  solutionPushes=converted.pushes;
  const observed=[];let snapshot=request.snapshot;
  for(const move of path){const transition=stepSnapshot(request.board,snapshot,move.toLowerCase());
    if(transition.pushed&&transition.pushedBoxId!==selected.id){
      const before=snapshot.boxes.find(box=>box.id===transition.pushedBoxId),after=transition.snapshot.boxes.find(box=>box.id===transition.pushedBoxId);
      observed.push([before.id,ids.get(key(before.position)),ids.get(key(after.position))]);
    }
    snapshot=transition.snapshot;
  }
  assert.deepEqual(observed,fixed.map(event=>[event.id,event.from,event.to]),"Other box pushes changed");
}
const result={schemaVersion:1,route:routeName,label,orientation,sourceMoves:route.moves,inputArtifact:args.get("input"),
  sourceActionLogSha256:createHash("sha256").update(route.actionLog).digest("hex"),
  scriptSha256:createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
  node:process.version,capturedAt:new Date().toISOString(),maxExpanded,preparationMs:started-totalStarted,
  elapsedMs:performance.now()-started,totalMs:performance.now()-totalStarted,
  expanded,generated,peak,methodology:"A* over fixed other-box pushes and unrestricted selected-box pushes; shortest keeper travel; original route cost upper bound; no reference input",
  status:solution?"solved":expanded>=maxExpanded?"state-budget":performance.now()>=deadline?"time-budget":"no-improvement-in-restricted-space",
  optimalWithinFixedOtherPushes:Boolean(solution),verified:Boolean(solution),moves:path?.length,pushes:solutionPushes,
  actionLog:path?.map(move=>move[0]).join("")};
const outDir="results/rescheduling";mkdirSync(outDir,{recursive:true});
writeFileSync(`${outDir}/grand-hall-reschedule-${tag}-${label}.json`,JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({...result,actionLog:undefined}));
