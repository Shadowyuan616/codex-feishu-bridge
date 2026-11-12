export type PrivacyFinding={path:string;line:number;rule:string};
const rules:[string,RegExp][]=[
  ['feishu-app-id',/\bcli_[a-f0-9]{12,}\b/gi],
  ['feishu-identity',/\b(?:ou|oc|on|om)_(?:x)?[a-f0-9]{20,}\b/gi],
  ['session-id',/\b01[a-f0-9]{6}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi],
  ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['credential',/\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/g],
  ['credential-value',/["']?(?:app_?secret|client_?secret|access_?token|refresh_?token|api_?key|password)["']?\s*[:=]\s*["'](?!REPLACE|YOUR_|EXAMPLE|\$\{|<)[A-Za-z0-9_./+=-]{20,}["']/gi],
  ['personal-home',/\/(?:Users|home)\/(?!YOUR_USER\b|USER\b|example\b|bridge-user\b)[A-Za-z0-9_.-]+/g],
  ['private-mount',/\/mnt\/(?:shared-storage[^\s"'`]*|afs-plm[^\s"'`]*)/g],
  ['deployment-host',/\b[htd]-pjlab\b/g],
  ['private-ip',/\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g],
];
const privateFile=/(?:^|\/)(?:\.env(?:\..+)?|config\.local\.[^/]+|bot-menu(?:-\d+)?\.local\.json|bridge\.env|auth\.json|state\.sqlite[^/]*|[^/]+\.(?:pem|key|p12|pfx|log|bundle)|\.lark-cli(?:\/.*)?|\.codex(?:\/.*)?)$/i;

/** Findings deliberately contain locations and rule names, never matched values. */
export function scanPrivacy(path:string,content:string):PrivacyFinding[] {
  const found:PrivacyFinding[]=[];
  const exampleEnv=/^\.env\.(?:example|template)$/i.test(path.split('/').at(-1)??'');
  if(privateFile.test(path)&&!exampleEnv)found.push({path,line:1,rule:'private-runtime-file'});
  if(content.includes('\0'))return found;
  for(const [index,line] of content.split('\n').entries()) {
    for(const [rule,pattern] of rules) {pattern.lastIndex=0;if(pattern.test(line))found.push({path,line:index+1,rule});}
    // Preserve third-party copyright/contact notices and reserved example domains.
    if(!path.startsWith('vendor/'))for(const match of line.matchAll(/[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      const domain=match[0].slice(match[0].lastIndexOf('@')+1).toLowerCase();
      if(!['users.noreply.github.com','example.com','example.org','example.net','example.invalid'].includes(domain)) {
        found.push({path,line:index+1,rule:'personal-email'});break;
      }
    }
  }
  return found;
}
