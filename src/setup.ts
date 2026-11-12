import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateConfig } from './config.js';

const help=`Generate private configuration without starting services or reading credentials.
Usage: npm run configure -- --host dev-a --root /srv/projects --user ou_YOUR_ID
  --socket /absolute/existing/control.sock --state-dir /absolute/local/bridge-state
  [--profile PROFILE] [--output /private/config/directory]
  [--lark-bin /absolute/lark-cli] [--codex-bin /absolute/codex]
  [--python-bin /absolute/python3] [--lark-cwd /existing/workspace]
Repeat --root and --user for multiple allowed directories/operators.
The default output is ~/.config/codex-feishu-bridge. Existing files are never overwritten.
Socket ownership, local storage durability, Feishu subscriptions and delivery still need verification.`;

function executable(name:string,provided?:string):string {
  const choices=provided?[provided]:(process.env.PATH??'').split(delimiter).map(p=>join(p,name));
  for(const p of choices) {
    if(!isAbsolute(p))continue;
    try {accessSync(p,constants.X_OK);if(!lstatSync(realpathSync(p)).isFile())continue;return resolve(p);}catch{}
  }
  throw new Error(`找不到 ${name} 可执行文件，请先安装或提供绝对路径`);
}
const envQuote=(value:string)=>'"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';

export function configure(argv:string[],repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..')):string[] {
  const options=new Map<string,string[]>();
  const keys=['host','root','user','socket','state-dir','profile','output','lark-bin','codex-bin','python-bin','lark-cwd'];
  for(let i=0;i<argv.length;i+=2) {
    const key=argv[i]?.replace(/^--/,''),value=argv[i+1];
    if(!argv[i]?.startsWith('--')||!key||!keys.includes(key)||!value||value.startsWith('--')||/[\r\n\0]/.test(value))throw new Error('参数无效；运行 npm run configure -- --help 查看格式');
    if(options.has(key)&&!['root','user'].includes(key))throw new Error('参数不能重复');
    options.set(key,[...(options.get(key)??[]),value]);
  }
  const get=(key:string)=>options.get(key)?.[0];
  for(const key of ['host','root','user','socket','state-dir'])if(!get(key))throw new Error(`缺少 --${key}`);
  const output=get('output')??join(homedir(),'.config','codex-feishu-bridge');
  if(!isAbsolute(output)||/[\r\n\0]/.test(repo))throw new Error('output 和仓库路径无效');
  const config=validateConfig({host:get('host'),stateDir:get('state-dir'),allowedRoots:options.get('root'),allowedUsers:options.get('user'),
    lark:{binary:executable('lark-cli',get('lark-bin')),...(get('profile')?{profile:get('profile')}:{}),...(get('lark-cwd')?{cwd:get('lark-cwd')}: {})},
    codex:{binary:executable('codex',get('codex-bin')),args:[],socketPath:get('socket')},pollIntervalMs:10000});
  if(!lstatSync(config.codex.socketPath!).isSocket())throw new Error('socket 必须指向已有 daemon 的 Unix socket；未创建或启动任何 daemon');
  if(config.lark.cwd&&(!isAbsolute(config.lark.cwd)||!lstatSync(config.lark.cwd).isDirectory()))throw new Error('lark-cwd 必须是已有目录');
  const python=executable('python3',get('python-bin'));
  const menu=JSON.parse(readFileSync(join(repo,'deploy','bot-menu.example.json'),'utf8'));
  const files=['config.local.json','bridge.env',...config.allowedUsers.map((_,i)=>i?'bot-menu-'+(i+1)+'.local.json':'bot-menu.local.json')];
  if(existsSync(output)) {
    const info=lstatSync(output);
    if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new Error('output 必须是当前用户私有的目录（权限 700），且不能是符号链接');
  }
  for(const name of files) {
    try{lstatSync(join(output,name));throw new Error('已有配置，未覆盖；请选择新的 --output 或手动审核现有配置');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  const env={BRIDGE_PYTHON:python,BRIDGE_NODE:process.execPath,BRIDGE_ROOT:repo,BRIDGE_CONFIG:join(output,'config.local.json'),
    BRIDGE_STATE_DIR:join(config.stateDir,'supervisor'),BRIDGE_LOG_DIR:join(config.stateDir,'logs'),
    PATH:[dirname(process.execPath),dirname(config.lark.binary),dirname(config.codex.binary),'/usr/local/bin','/usr/bin','/bin'].join(':')};
  const payloads=[JSON.stringify(config,null,2)+'\n',Object.entries(env).map(([k,v])=>`${k}=${envQuote(v)}`).join('\n')+'\n',
    ...config.allowedUsers.map(user=>JSON.stringify({...menu,user_id:user},null,2)+'\n')];
  mkdirSync(output,{recursive:true,mode:0o700});
  const created:string[]=[];
  try {
    for(const [i,name] of files.entries()) {const path=join(output,name);writeFileSync(path,payloads[i]!,{flag:'wx',mode:0o600});created.push(path);}
  } catch(error) {for(const path of created)unlinkSync(path);throw error;}
  return created;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  if(process.argv.slice(2).includes('--help'))console.log(help);
  else try {console.log(JSON.stringify({created:configure(process.argv.slice(2)),note:'仅生成配置；尚未安装服务、配置飞书菜单或验证收发。'},null,2));}
  catch(error) {console.error(error instanceof Error?error.message:'配置生成失败');process.exitCode=1;}
}
