import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, configPath } from './config.js';
import { Store } from './store.js';
import { CodexClient } from './codex.js';
import { SocketCodexClient } from './codex-socket.js';
import { LarkCli } from './lark.js';
import { Bridge } from './bridge.js';
import { acquireInstanceLock } from './instance-lock.js';

const log=(event:string,details?:unknown)=>console.log(JSON.stringify({time:new Date().toISOString(),event,...(details?{details}:{})}));
const args=process.argv.slice(2), index=args.indexOf('--config');
if(args.includes('--help')) {
  console.log('codex-feishu-bridge [--config /absolute/config.local.json] [--check-config | --doctor | --health]');process.exit(0);
}
if(index>=0&&!args[index+1])throw new Error('--config requires a file');
const config=loadConfig(configPath(index>=0?args[index+1]:undefined));
if(args.includes('--check-config')) {console.log(JSON.stringify({valid:true,host:config.host}));process.exit(0);}
if(args.includes('--health')) {
  const status=JSON.parse(readFileSync(join(config.stateDir,'health.json'),'utf8'));
  const stale=Date.now()-Date.parse(status.time)>60_000;
  console.log(JSON.stringify({...status,stale},null,2));process.exit(stale?1:0);
}
const codex=config.codex.socketPath?new SocketCodexClient({socketPath:config.codex.socketPath}):new CodexClient(config.codex);
if(args.includes('--doctor')) {
  const exec=promisify(execFile);
  try {
    const {stdout}=await exec(config.lark.binary,['--version'],{timeout:10_000,cwd:config.lark.cwd});
    await codex.start();
    const list=await codex.request<{data:unknown[]}>('thread/list',{limit:1});
    console.log(JSON.stringify({host:config.host,codex:codex.health(),larkVersion:stdout.trim(),threadListReadable:Array.isArray(list.data),note:'只读协议探测；未验证飞书事件权限或发送消息。'},null,2));
  } finally {await codex.stop();}
  process.exit(0);
}

process.umask(0o077);
mkdirSync(config.stateDir,{recursive:true,mode:0o700});chmodSync(config.stateDir,0o700);
const releaseInstanceLock=acquireInstanceLock(config.stateDir);
const store=new Store(join(config.stateDir,'state.sqlite'));
const lark=new LarkCli(config.lark,log);
const bridge=new Bridge(config,store,codex,lark);
let closing=false;
let healthTimer:NodeJS.Timeout|undefined;
let shutdownPromise:Promise<void>|undefined;
function shutdown(code=0):Promise<void> {
  if(shutdownPromise)return shutdownPromise;
  closing=true;
  if(healthTimer)clearInterval(healthTimer);
  shutdownPromise=(async()=>{
    let exitCode=code;
    const bounded=async(stage:string,operation:()=>void|Promise<void>,limit:number)=>{
      let timer:NodeJS.Timeout|undefined;
      try {
        await Promise.race([
          Promise.resolve().then(operation).catch(()=>{exitCode=1;log('bridge.shutdown_stage_failed',{stage});}),
          new Promise<void>(resolve=>{timer=setTimeout(()=>{log('bridge.shutdown_stage_timeout',{stage});resolve();},limit);}),
        ]);
      } finally {if(timer)clearTimeout(timer);}
    };
    // First prevent new work and allow bounded completion, then disconnect our
    // transports. Any request still dispatching is reconciled as uncertain at boot.
    await bounded('bridge',()=>bridge.stop(),10_000);
    await bounded('lark',()=>lark.stop(),4_000);
    await bounded('codex',()=>codex.stop(),3_000);
    await bounded('bridge-settle',()=>bridge.stop(),2_000);
    try {releaseInstanceLock();}
    catch {exitCode=1;log('bridge.instance_lock_release_failed');}
    process.exit(exitCode);
  })();
  return shutdownPromise;
}
process.once('SIGTERM',()=>{void shutdown();});process.once('SIGINT',()=>{void shutdown();});
process.once('uncaughtException',()=>{log('bridge.uncaught_exception');void shutdown(1);});
process.once('unhandledRejection',()=>{log('bridge.unhandled_rejection');void shutdown(1);});
codex.on('disconnect',()=>{if(!closing){log('codex.disconnected');void shutdown(1);}});
try {
  await codex.start();
  if(closing)await shutdown();
  await bridge.start();
  if(closing)await shutdown();
  await lark.start(event=>bridge.receive(event));
  if(closing)await shutdown();
  const health=()=>{
    const value={time:new Date().toISOString(),pid:process.pid,host:config.host,codex:codex.health(),lark:lark.health(),state:store.health()};
    writeFileSync(join(config.stateDir,'health.tmp'),JSON.stringify(value),{mode:0o600});
    renameSync(join(config.stateDir,'health.tmp'),join(config.stateDir,'health.json'));
    const consumers=(value.lark as {consumers?:{permanent:boolean}[]}).consumers;
    if(consumers?.some(x=>x.permanent)){log('lark.permanent_failure');void shutdown(1);}
  };
  health();healthTimer=setInterval(health,10_000);
  log('bridge.ready',{host:config.host});
} catch {log('bridge.start_failed');await shutdown(1);}
