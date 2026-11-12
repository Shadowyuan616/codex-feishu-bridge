import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { scanPrivacy, type PrivacyFinding } from './privacy.js';

const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8',maxBuffer:64*1024*1024});
const flags=new Set(process.argv.slice(2));
if([...flags].some(x=>!['--history','--staged'].includes(x))||flags.size>1)throw new Error('Usage: npm run privacy:check -- [--history | --staged]');
const findings:PrivacyFinding[]=[];
let checked=0;
if(flags.has('--history')) {
  if(git('rev-parse','--is-shallow-repository').trim()==='true')throw new Error('历史扫描需要完整克隆；先 git fetch --unshallow');
  const seen=new Set<string>();
  for(const row of git('rev-list','--objects','--all').trim().split('\n')) {
    const at=row.indexOf(' ');if(at<0)continue;
    const oid=row.slice(0,at),path=row.slice(at+1);
    if(seen.has(oid)||git('cat-file','-t',oid).trim()!=='blob')continue;
    seen.add(oid);checked++;findings.push(...scanPrivacy(path,git('cat-file','blob',oid)));
  }
  // Commit messages and author/committer emails are part of published history.
  for(const oid of git('rev-list','--all').trim().split('\n'))if(oid) {
    findings.push(...scanPrivacy(`commit:${oid.slice(0,12)}`,git('show','-s','--format=%B%n%ae%n%ce',oid)));
  }
}else {
  const staged=flags.has('--staged');
  const files=staged?git('diff','--cached','--name-only','--diff-filter=ACMR','-z'):git('ls-files','--cached','--others','--exclude-standard','-z');
  for(const path of new Set(files.split('\0').filter(Boolean))) {
    let content:string;
    if(staged)content=git('show',':'+path);
    else {
      try{const info=lstatSync(path);content=info.isSymbolicLink()?readlinkSync(path):readFileSync(path,'utf8');}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    }
    checked++;findings.push(...scanPrivacy(path,content));
  }
}
const unique=[...new Map(findings.map(f=>[`${f.path}:${f.line}:${f.rule}`,f])).values()];
for(const f of unique)console.error(`${f.path}:${f.line}: ${f.rule} (value redacted)`);
console.log(JSON.stringify({checked,findings:unique.length,scope:flags.has('--history')?'all reachable Git history':flags.has('--staged')?'staged files':'working tree',note:'规则扫描不能保证发现所有秘密；发布前还需独立密钥扫描与人工复核。'}));
process.exitCode=unique.length?1:0;
