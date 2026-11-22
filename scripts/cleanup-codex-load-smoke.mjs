import {createDesktopCleanup} from '../src/cleanup-desktop.mjs';import {codexDomainForThread} from '../src/codex-domain.mjs';
import {pageThreadUnsubscribeGuard,pageCleanupCommit,RELEASE_GUARD_INTERNALS} from '../src/codex-ipc.mjs';import {makeView} from './cleanup-codex-renderer-fixture.mjs';
import {createServer} from 'node:http';import {spawn} from 'node:child_process';import readline from 'node:readline';import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';
const root=path.resolve(process.argv[2]??'.runtime/verification/agent-auto-cleanup/codex/load-benchmark'),home=path.join(root,'home'),work=path.join(root,'work'),temp=path.join(root,'temp');for(const p of [home,work,temp])await mkdir(p,{recursive:true});
let releaseLoad;const loadGate=new Promise(resolve=>{releaseLoad=resolve});let loadWaiting=false;const requests=[];let nextResponse=0;const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;let q;try{q=JSON.parse(body)}catch{q={}};const id='resp_'+(++nextResponse),text=JSON.stringify(q.input??[]),tools=(q.tools??[]).map(t=>t.name??t.function?.name);requests.push({id,url:req.url,tools,rawTools:q.tools,keys:Object.keys(q),input:text.slice(-12000)});const ns=(q.tools??[]).find(x=>x.type==='namespace' && x.tools?.some(t=>t.name==='spawn_agent'));const tool=ns?'spawn_agent':tools.find(x=>x==='spawn_agent'||x?.endsWith('.spawn_agent')); const already=(q.input??[]).some(x=>x.type==='function_call_output');const depth=text.includes('DEPTH_ONE')?'one':text.includes('DEPTH_ZERO')?'zero':'other';const spawn=tool&&!already&&(depth==='zero'||depth==='one');
 const response={id,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:q.model??'fixture',output:[],usage:{input_tokens:10,output_tokens:10,total_tokens:20}};
 const ev=(name,data)=>res.write(`event: ${name}\ndata: ${JSON.stringify({type:name,...data})}\n\n`);
 if(text.includes('LOAD_FIXTURE')){loadWaiting=true;await loadGate;}res.writeHead(200,{'content-type':'text/event-stream'});ev('response.created',{response:{...response,status:'in_progress'}});ev('response.in_progress',{response:{...response,status:'in_progress'}});
 if(spawn){const callId='call_'+id,args=JSON.stringify({task_name:depth==='zero'?'level_one':'level_two',fork_turns:'none',message:depth==='zero'?'DEPTH_ONE spawn one child':'DEPTH_TWO finish immediately'}),item={id:'fc_'+id,type:'function_call',status:'completed',name:tool,...(ns?{namespace:ns.name}:{}),call_id:callId,arguments:args};ev('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',arguments:''}});ev('response.function_call_arguments.delta',{item_id:item.id,output_index:0,delta:args});ev('response.function_call_arguments.done',{item_id:item.id,output_index:0,arguments:args});ev('response.output_item.done',{output_index:0,item});response.output=[item];}
 else {const item={id:'msg_'+id,type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'fixture complete',annotations:[]}]};ev('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});ev('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});ev('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:'fixture complete'});ev('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:'fixture complete'});ev('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part:item.content[0]});ev('response.output_item.done',{output_index:0,item});response.output=[item];}ev('response.completed',{response});res.end();});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await writeFile(path.join(home,'config.toml'),`model = "gpt-5.4"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nenv_key = "CODEX_FAKE_MODEL_KEY"\nwire_api = "responses"\n[features]\nmulti_agent = true\nmulti_agent_v2 = false\n[agents]\nmax_threads = 8\nmax_depth = 3\n`);
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(KEY|TOKEN|SECRET|PASSWORD|^CODEX_|^OPENAI_)/i.test(key)));Object.assign(env,{CODEX_HOME:home,TEMP:temp,TMP:temp,CODEX_FAKE_MODEL_KEY:'fixture'});
const child=spawn('codex',['app-server'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',x=>stderr+=x);let seq=0;const pending=new Map(),events=[];readline.createInterface({input:child.stdout}).on('line',line=>{try{const x=JSON.parse(line);if(pending.has(x.id)){pending.get(x.id)(x);pending.delete(x.id)}else events.push(x)}catch{}});
const rpc=(method,params={})=>new Promise(resolve=>{const id=++seq;let timer=setTimeout(()=>{pending.delete(id);resolve({timeout:true})},15000);pending.set(id,x=>{clearTimeout(timer);resolve(x)});child.stdin.write(JSON.stringify({id,method,params})+'\n')});
const out={root,home,work,groups:{},cases:[],renderer:'controlled stand-in; native JSON-RPC to isolated app-server',version:null};
const native=async(method,params)=>{const response=await rpc(method,params);if(response.error||response.timeout)throw Error(method+':'+JSON.stringify(response));return response.result};
const kinds=['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown'];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function create(label){const result=await native('thread/start',{cwd:work,approvalPolicy:'never',sandbox:'workspace-write'}),id=result.thread.id;await native('turn/start',{threadId:id,input:[{type:'text',text:label}]});return id}
async function nodesOf(rootId){const queue=[rootId],seen=new Set(queue);for(const parentThreadId of queue){for(const archived of [false,true]){const page=await native('thread/list',{parentThreadId,archived,limit:100,useStateDbOnly:true,sourceKinds:kinds});if(page.nextCursor)throw Error('children-truncated');for(const c of page.data){if(seen.has(c.id))throw Error('duplicate-child');seen.add(c.id);queue.push(c.id)}}}return queue}
async function waitFor(check,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){const v=await check();if(v)return v;await pause(100)}throw Error('timeout:'+label)}
async function settled(id,count){return waitFor(async()=>{try{const ids=await nodesOf(id);if(ids.length!==count)return false;for(const id of ids){const thread=(await native('thread/read',{threadId:id,includeTurns:false})).thread;if(!['idle','notLoaded'].includes(thread.status.type))return false;const turns=await native('thread/turns/list',{threadId:id,itemsView:'summary',limit:100});if(turns.nextCursor||turns.data.some(t=>!['completed','failed','interrupted'].includes(t.status)))return false;}return ids}catch{return false}},'tree-settle-'+count)}
const stateDirectory=path.join(root,'state');await mkdir(stateDirectory,{recursive:true});
let caseCalls=[];
const baseCall=async(_w,r)=>{const start=performance.now(),response=await rpc(r.method,r.params);caseCalls.push({method:r.method,start,end:performance.now(),error:response.error});return response};
const guardedCall=(w,r,t)=>r.method==='futureaide/cleanup/delete'?pageCleanupCommit(w,r,t,baseCall):baseCall(w,r,t);
const request=async(method,params,options={})=>{
 if(method!=='futureaide/cleanup/delete')return native(method,params);
 if(options.canRelease?.()!==true)return {status:'notSent',reason:'gate'};
 for(const id of [...params.treeIds.filter(x=>x!==params.threadId),params.threadId]){
   const view=makeView(id),token='bench-'+id;
   const prepared=await pageThreadUnsubscribeGuard(view.win,guardedCall,view.load,RELEASE_GUARD_INTERNALS,id,null,15000,{handoffToken:token});if(prepared.status!=='observed')return prepared;
   if(options.canRelease?.()!==true)return {status:'notSent',reason:'gate'};
   const action=id===params.threadId?{id:'bench-delete',method:'futureaide/cleanup/delete',params}:{method:'futureaide/cleanup/check',params:{threadId:id}};
   const result=await pageThreadUnsubscribeGuard(view.win,guardedCall,view.load,RELEASE_GUARD_INTERNALS,id,action,15000,{skipRoleRead:true,handoffToken:token,checkedAt:Date.now()});
   if(id===params.threadId||result.status!=='checked')return result;
 }
};
const adapter=createDesktopCleanup({stateDirectory,nativeRequest:request});
async function scenario(group,shape,index,controlId,loadId){
 const id=await create(shape==='tree'?'DEPTH_ZERO spawn two levels':'ordinary single fixture');const ids=await settled(id,shape==='tree'?3:1);
 const thread=(await native('thread/read',{threadId:id,includeTurns:false})).thread,domain=await codexDomainForThread(thread);if(!domain)throw Error('domain-unavailable');
 const record={target:'codex-desktop',workspace:work},state={binding:{sessionId:id,owned:true,codexDomain:domain},tree:{nodes:ids.map(sessionId=>({sessionId}))},requests:{}};
 const inspection=await adapter.inspect(record,state);if(inspection.running!==false)throw Error('inspection:'+JSON.stringify(inspection));
 const controlBefore=await native('thread/read',{threadId:controlId,includeTurns:false});
 const loadBefore=loadId?(await native('thread/read',{threadId:loadId,includeTurns:false})).thread.status.type:null;if(loadId&&loadBefore!=='active')throw Error('load-not-active:'+loadBefore);
 caseCalls=[];const result=await adapter.remove(record,state,inspection,{mode:'first',canDelete:()=>true});if(!result.removed)throw Error('delete:'+JSON.stringify(result));
 const deleteAt=caseCalls.findLastIndex(call=>call.method==='thread/delete');if(deleteAt<1||caseCalls[deleteAt-1].method!=='thread/read')throw Error('read-delete-sequence');
 const finalReadToSubmit=caseCalls[deleteAt].start-caseCalls[deleteAt-1].end,submitToAck=caseCalls[deleteAt].end-caseCalls[deleteAt].start;
 const controlAfter=await native('thread/read',{threadId:controlId,includeTurns:false});const loadAfter=loadId?(await native('thread/read',{threadId:loadId,includeTurns:false})).thread.status.type:null;if(loadId&&loadAfter!=='active')throw Error('load-stopped:'+loadAfter);
 const deletedEvents=events.filter(e=>e.method==='thread/deleted'&&ids.includes(e.params?.threadId)).map(e=>e.params.threadId);
 if(ids.some(node=>!deletedEvents.includes(node)))throw Error('cascade-event-missing');
 out.cases.push({group,shape,index,id,ids,controlId,controlPresentBefore:!!controlBefore.thread,controlPresentAfter:!!controlAfter.thread,loadId,loadBefore,loadAfter,finalReadToSubmit,submitToAck,result,deletedEvents,calls:caseCalls});
 console.log(JSON.stringify({group,shape,index,finalReadToSubmit,submitToAck}));
}
try {
 await native('initialize',{clientInfo:{name:'cleanup-load-benchmark',version:'1'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
 const controlId=await create('independent control fixture');await settled(controlId,1);out.controlId=controlId;
 for(const shape of ['single','tree'])for(let i=0;i<5;i++)await scenario('idle',shape,i+1,controlId,null);
 const loadId=await create('LOAD_FIXTURE independent task');out.loadId=loadId;
 await waitFor(async()=>{if(!loadWaiting)return false;try{return (await native('thread/read',{threadId:loadId,includeTurns:false})).thread.status.type==='active'}catch{return false}},'load-active');
 for(const shape of ['single','tree'])for(let i=0;i<5;i++)await scenario('busy',shape,i+1,controlId,loadId);
 releaseLoad();await waitFor(()=>events.some(e=>e.method==='turn/completed'&&e.params?.threadId===loadId),'load-natural-completion',30000);
 out.loadCompleted=events.findLast(e=>e.method==='turn/completed'&&e.params?.threadId===loadId)?.params.turn.status;
}catch(error){out.error=String(error.stack??error);releaseLoad();process.exitCode=1}
finally{
 for(const group of ['idle','busy'])for(const shape of ['single','tree']){const rows=out.cases.filter(x=>x.group===group&&x.shape===shape);const summary={count:rows.length};for(const field of ['finalReadToSubmit','submitToAck']){const nums=rows.map(x=>x[field]).sort((a,b)=>a-b);summary[field]={median:nums.length?nums[Math.floor(nums.length/2)]:null,max:nums.length?nums.at(-1):null}}out.groups[`${group}-${shape}`]=summary}
 out.events=events.filter(e=>['thread/deleted','turn/completed'].includes(e.method));out.stderr=stderr;await writeFile(path.join(root,'result.json'),JSON.stringify(out,null,2));child.stdin.end();child.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify({groups:out.groups,loadCompleted:out.loadCompleted,error:out.error}));
}

