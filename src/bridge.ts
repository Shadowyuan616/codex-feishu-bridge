import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { allowedPath, type Config } from './config.js';
import { Store, stableId, type Binding, type Inbox } from './store.js';
import { card, latestMarkdown, splitMarkdown, type CardAction } from './cards.js';

export interface CodexPort extends EventEmitter {
  request<T=any>(method:string,params?:unknown):Promise<T>;
  respond(id:string|number,result:unknown):void;
  health():unknown;
}
export interface LarkPort {
  sendCard(chat:string,body:Record<string,unknown>,key:string):Promise<string>;
  updateCard(message:string,body:Record<string,unknown>):Promise<void>;
  ensureDirectChat?(user:string,key:string):Promise<string>;
  health():unknown;
}
export type Thread = {id:string;cwd:string;name?:string;preview?:string;status?:{type:string};turns?:any[];updatedAt?:number};
const help = `先选择目录和会话，再直接发送文字。\n\n/dirs — 目录\n/sessions [完整目录] — 会话\n/select <会话ID> — 载入已有会话\n/status — 最新进展与待处理请求\n/interrupt — 中断当前轮次\n/unbind — 取消本对话绑定\n/health — 服务状态\n/help — 菜单\n\n运行中发送的文字会尝试补充给当前轮次。模型设置和权限沿用 Codex 原会话；不会自动放宽权限。`;
const menu:CardAction[] = [{label:'选择目录',command:'/dirs'},{label:'选择会话',command:'/sessions'},{label:'最新进展',command:'/status'},{label:'更多操作',command:'/more'}];
const menuCommands = new Set(['/dirs','/sessions','/status','/more']);
const safeError = (e:unknown) => e instanceof Error ? e.message.slice(0,1000) : '操作失败';
const textId = (s:string) => s.replace(/[\r\n`]/g,' ').slice(0,150);

/** Durable command router. No user text ever passes through a shell. */
export class Bridge {
  private draining = false;
  private flushing = false;
  private polling = false;
  private attached = new Set<string>();
  private dirty = new Set<string>();
  private streams = new Map<string,{turn:string;items:Map<string,string>}>();
  private closing = false;
  private generation = randomBytes(12).toString('hex');
  private liveRequests = new Map<string,string|number>();
  private historyPagination: 'unknown'|'supported'|'unsupported' = 'unknown';
  private timer?:NodeJS.Timeout;
  constructor(readonly config:Config,readonly store:Store,readonly codex:CodexPort,readonly lark:LarkPort) {
    codex.on('notification',(m:string,p:any)=>this.notification(m,p));
    codex.on('serverRequest',(r:any)=>this.serverRequest(r));
    codex.on('disconnect',()=> {
      this.attached.clear();this.liveRequests.clear();this.store.invalidatePending();
      this.generation=randomBytes(12).toString('hex');
    });
  }
  async start() {
    for (const e of this.store.recover()) this.reply(e,'请求结果待核对','服务曾在提交请求时中断。为避免重复执行，没有自动重发。请先查看 /status，再决定是否重新发送。');
    for (const b of this.store.bindings()) {
      try { await this.attach(b); this.dirty.add(b.thread); }
      catch (e) { this.store.putCard(`restore:${b.thread}`,b.chat,card('会话连接待恢复',safeError(e),menu)); }
    }
    this.timer = setInterval(()=>{ void this.tick(); },this.config.pollIntervalMs);
    await this.tick();
  }
  async stop() {
    this.closing=true;if(this.timer)clearInterval(this.timer);
    const deadline=Date.now()+10_000;
    while((this.draining||this.polling||this.flushing)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  }
  receive(e:{id:string;chatId:string;userId:string;text:string;kind:string;messageId?:string}) {
    if (this.closing||!this.config.allowedUsers.includes(e.userId) || e.text.length>50_000) return;
    if(e.kind==='menu'&&!menuCommands.has(e.text))return;
    if(e.kind!=='menu'&&!e.chatId)return;
    if(e.kind==='action'&&(!e.messageId||!this.store.hasReceipt(e.messageId,e.chatId)))return;
    if(['message','action'].includes(e.kind)&&/^oc_[A-Za-z0-9_-]+$/.test(e.chatId))this.store.rememberDirectChat(e.userId,e.chatId);
    if (this.store.ingest(e.kind==='menu'?{...e,chatId:''}:e)) void this.drain();
  }
  async tick() { if(this.closing)return;await this.drain(); await this.poll(); await this.flush(); }
  private reply(e:Inbox,title:string,text:string,actions:CardAction[]=menu) {
    splitMarkdown(text).forEach((part,i)=>this.store.putCard(`reply:${e.id}:${i}`,e.chat,card(`${this.config.host} · ${title}`,part,i===0?actions:[])));
  }
  async drain() {
    if (this.draining||this.closing) return;
    this.draining=true;
    try {
      for (const e of this.store.queued()) {
        if(this.closing)break;
        if (!this.config.allowedUsers.includes(e.user)||(e.kind==='menu'&&!menuCommands.has(e.text))) { this.store.mark(e.id,'rejected'); continue; }
        this.store.mark(e.id,'processing');
        // Ignore even a previously persisted menu destination until it has been
        // resolved from trusted p2p ingress or an Open API message receipt.
        if(e.kind==='menu')e.chat='';
        try {
          if(e.kind==='menu') {
            let chat=this.store.directChat(e.user);
            if(!chat) {
              if(!Number.isFinite(e.created)||Date.now()-e.created>50*60_000)throw new Error('菜单请求已过期，请重新点击菜单');
              if(!this.lark.ensureDirectChat)throw new Error('无法取得单聊会话，请先给机器人发送一条消息');
              chat=await this.lark.ensureDirectChat(e.user,stableId('menu-p2p:'+e.id));
              this.store.rememberDirectChat(e.user,chat);
            }
            this.store.routeMenu(e.id,chat);e.chat=chat;
          }
          await this.route(e); this.store.mark(e.id,'done');
        }
        catch (err) {
          // A lost RPC response is not proof that the model did not receive input.
          const status = this.store.db.prepare('SELECT status FROM inbox WHERE id=?').get(e.id)?.status;
          this.store.mark(e.id,status==='dispatching'?'uncertain':'failed');
          if(e.chat)this.reply(e,status==='dispatching'?'请求结果需核对':'操作未完成',safeError(err)+(status==='dispatching'?'\n\n未自动重试。请先 /status 核对，避免重复执行。':''));
        }
      }
    } finally { this.draining=false; }
    await this.flush();
  }
  private async route(e:Inbox) {
    const text=e.text.trim();
    const at=text.indexOf(' ');
    const command=at<0?text:text.slice(0,at), arg=at<0?'':text.slice(at+1).trim();
    if (['/help','/start','/menu'].includes(command)) { this.reply(e,'菜单',help); return; }
    if(command==='/more') {
      const b=this.store.binding(e.chat,e.user);
      const actions:CardAction[]=[{label:'服务状态',command:'/health'},{label:'使用帮助',command:'/help'}];
      if(b)actions.push({label:'解除绑定',command:`/unbind ${b.thread}`},{label:'中断当前轮次',command:`/interrupt-confirm ${b.thread}`,type:'danger'});
      this.reply(e,'更多操作',b?`当前会话：\`${b.thread}\`\n解除绑定后可选择其他会话；中断操作会先确认当前轮次。`:'选择一个会话后，可以在这里解除绑定或中断当前轮次。',actions);
      return;
    }
    if(command==='/health') { this.reply(e,'服务状态','```json\n'+JSON.stringify({host:this.config.host,codex:this.codex.health(),lark:this.lark.health(),state:this.store.health()},null,2)+'\n```'); return; }
    if(command==='/dirs') {
      const {threads,truncated}=await this.list();
      const dirs=[...new Set(threads.map(t=>t.cwd))];
      this.reply(e,'目录',dirs.map(p=>`- ${p}`).join('\n')+(truncated?'\n\n只扫描了最近 1000 条会话，可用 /sessions 完整目录 直接筛选。':''),dirs.slice(0,15).map((p,i)=>({label:`${i+1}. ${p.split('/').filter(Boolean).slice(-2).join('/')}`,command:`/sessions ${p}`})));
      return;
    }
    if(command==='/sessions'||command==='/page') {
      const match=command==='/page'?/^(\d+)(?: (.*))?$/.exec(arg):null;
      const offset=match?Number(match[1]):0, cwd=match?(match[2]??''):arg;
      if(command==='/page'&&!match) throw new Error('格式：/page 8 /完整目录');
      if(cwd&&!allowedPath(cwd,this.config.allowedRoots)) throw new Error('该目录不在授权范围内或不存在');
      if(offset>1000) throw new Error('分页超出范围，请按目录筛选');
      const {threads,truncated}=await this.list(cwd||undefined);
      const page=threads.slice(offset,offset+8);
      const actions:CardAction[]=page.map((t,i)=>({label:`${i+offset+1}. ${(t.name||t.preview||t.id).slice(0,40)}`,command:`/select ${t.id}`}));
      if(offset+8<threads.length) actions.push({label:'下一页',command:`/page ${offset+8}${cwd?' '+cwd:''}`});
      this.reply(e,'选择会话',page.map(t=>`**${textId(t.name||t.preview||'未命名会话')}**\n目录：${t.cwd}\nID：\`${t.id}\`\n状态：${t.status?.type??'未知'}`).join('\n\n')+(page.length?'':'暂无可见会话')+(truncated?'\n\n列表已截断，请按目录筛选。':''),actions);
      return;
    }
    if(command==='/select') {
      if(!/^[A-Za-z0-9_-]{8,100}$/.test(arg)) throw new Error('请使用菜单中的完整会话 ID');
      const thread=await this.read(arg);
      this.checkThread(thread);
      const before=this.store.binding(e.chat,e.user);
      this.store.bind(e.chat,e.user,thread.id,thread.cwd);
      try { await this.attach(this.store.binding(e.chat,e.user)!); }
      catch(err) {
        this.store.unbind(e.chat,e.user);
        if(before)this.store.bind(before.chat,before.user,before.thread,before.cwd);
        throw err;
      }
      this.reply(e,'已选择会话',`**${textId(thread.name||thread.preview||thread.id)}**\n目录：${thread.cwd}\n现在发送文字即可继续。`);
      await this.refresh(this.store.binding(e.chat,e.user)!,true);
      return;
    }
    if(command==='/unbind') {
      if(arg&&arg!==this.store.binding(e.chat,e.user)?.thread)throw new Error('会话已切换，旧卡片不能解除当前会话的绑定');
      this.store.unbind(e.chat,e.user);
      this.reply(e,'已取消绑定','选择另一个会话即可继续。取消绑定不会中断 Codex 任务。'); return;
    }
    const b=this.store.binding(e.chat,e.user);
    if(!b) { this.reply(e,'请先选择会话',help); return; }
    if(command==='/status') {
      if(arg&&arg!==b.thread)throw new Error('这张卡片属于之前的会话；请重新选择该会话或发送 /status 查看当前会话');
      await this.refresh(b,true,e.id); return;
    }
    if(command==='/approve'||command==='/deny'||command==='/answer') { this.answer(e,b,command,arg); return; }
    if(command==='/interrupt-confirm') {
      if(arg!==b.thread)throw new Error('会话已切换，请从更多操作重新选择中断当前轮次');
      const t=await this.read(b.thread),active=this.active(t);
      if(!active) { this.reply(e,'当前没有运行中的轮次','可直接发送新的指令。'); return; }
      this.reply(e,'确认中断当前轮次',`会话：**${textId(t.name||t.id)}**\n轮次：\`${active.id}\`\n确认后将请求停止这一轮正在进行的任务。`,[
        {label:'确认中断',command:`/interrupt ${b.thread} ${active.id}`,type:'danger'},
        {label:'取消',command:'/more'},
      ]);return;
    }
    if(command==='/interrupt') {
      const [threadId,turnId,...extra]=arg?arg.split(/\s+/):[];
      if(extra.length)throw new Error('中断请求格式无效，请从更多操作重新选择');
      if(threadId&&threadId!==b.thread)throw new Error('会话已切换，旧卡片不能中断当前会话');
      await this.attach(b);
      const t=await this.read(b.thread), active=this.active(t);
      if(!active) { this.reply(e,'当前没有运行中的轮次','可直接发送新的指令。'); return; }
      if(turnId&&turnId!==active.id)throw new Error('该轮次已经结束，旧确认卡片不能中断新轮次');
      this.store.mark(e.id,'dispatching',b.thread);
      await this.codex.request('turn/interrupt',{threadId:b.thread,turnId:active.id});
      this.reply(e,'已请求中断','等待 Codex 返回中断后的状态。'); this.dirty.add(b.thread); return;
    }
    if(text.startsWith('/')) throw new Error('未知指令。发送 /help 查看菜单；普通任务文字请直接发送。');
    if(!text) return;
    await this.attach(b);
    const t=await this.read(b.thread);this.checkThread(t);
    const active=this.active(t);
    if(t.status?.type==='active'&&!active) throw new Error('会话正在运行，但没有取得当前轮次 ID。请刷新 /status 后重试；没有新建另一轮。');
    this.store.mark(e.id,'dispatching',b.thread);
    const input=[{type:'text',text,text_elements:[]}];
    const result=await this.codex.request(active?'turn/steer':'turn/start',active?
      {threadId:b.thread,expectedTurnId:active.id,input}:{threadId:b.thread,input});
    this.reply(e,active?'已补充当前轮次':'已提交指令',`会话：${textId(t.name||t.id)}\n轮次：${result.turn?.id??result.turnId??active?.id??'已接收'}\n进展会自动更新到状态卡片。`);
    this.dirty.add(b.thread);
  }
  private checkThread(t:Thread) { if(!t?.id||!allowedPath(t.cwd,this.config.allowedRoots)) throw new Error('该会话的工作目录不在授权范围内或不存在'); }
  private async list(cwd?:string):Promise<{threads:Thread[];truncated:boolean}> {
    const threads:Thread[]=[];let cursor:string|undefined;
    for(let page=0;page<10;page++) {
      const r=await this.codex.request('thread/list',{limit:100,sortKey:'updated_at',sortDirection:'desc',modelProviders:[],sourceKinds:['cli','vscode','appServer','exec'],...(cwd?{cwd}:{}),...(cursor?{cursor}:{})});
      threads.push(...(r.data as Thread[]).filter(t=>allowedPath(t.cwd,this.config.allowedRoots)));
      cursor=r.nextCursor??undefined;if(!cursor)return {threads,truncated:false};
    }
    return {threads,truncated:true};
  }
  private async read(id:string):Promise<Thread> {
    const {thread}=await this.codex.request<{thread:Thread}>('thread/read',{threadId:id});
    if(this.historyPagination!=='unsupported') {
      try {
        const page=await this.codex.request<{data:any[]}>('thread/turns/list',{
          threadId:id,limit:2,sortDirection:'desc',itemsView:'full',
        });
        if(!Array.isArray(page.data)) throw new Error('Codex 返回了无效的会话历史分页');
        this.historyPagination='supported';
        // Existing renderers expect oldest-first history and use .at(-1).
        return {...thread,turns:[...page.data].reverse()};
      } catch(error) {
        const rpc=error as {code?:number;message?:string};
        const unavailable=rpc.code===-32601 ||
          (rpc.code===-32600 && /unknown (?:variant|method)/i.test(rpc.message??'') &&
           (rpc.message??'').includes('thread/turns/list'));
        if(!unavailable) throw error;
        this.historyPagination='unsupported';
      }
    }
    // Old servers lack pagination; only explicit method absence permits fallback.
    const legacy=await this.codex.request<{thread:Thread}>('thread/read',{threadId:id,includeTurns:true});
    return legacy.thread;
  }
  private active(t:Thread) { return [...(t.turns??[])].reverse().find((turn:any)=>turn.status==='inProgress'); }
  private async attach(b:Binding) {
    if(this.attached.has(b.thread))return;
    const thread=await this.read(b.thread);this.checkThread(thread);
    await this.codex.request('thread/resume',{threadId:b.thread,excludeTurns:true});
    this.attached.add(b.thread);
  }
  async refresh(b:Binding,force=false,requestId?:string) {
    const t=await this.read(b.thread); this.checkThread(t);
    const turns=t.turns??[], latest=turns.at(-1);
    const items=latest?.items??[];
    const messages=items.filter((x:any)=>x.type==='agentMessage').map((x:any)=>String(x.text??''));
    // A new turn can be running tools before its first reply. Keep the most
    // recent available assistant reply visible while that turn is in progress.
    const assistantItems=turns.flatMap(turn=>(turn.items??[]).filter((x:any)=>x.type==='agentMessage'));
    const ops=items.filter((x:any)=>['commandExecution','fileChange','mcpToolCall','webSearch'].includes(x.type)).slice(-5).map((x:any)=>`- ${x.type} · ${x.status??'已记录'}`);
    const live=this.streams.get(b.thread);
    const liveText=live&&live.turn===latest?.id?[...live.items.entries()].filter(([id,text])=>!assistantItems.some((x:any)=>x.id===id&&String(x.text??'').includes(text))).map(([,text])=>text).join('\n\n'):'';
    const displayed=[assistantItems.map((x:any)=>String(x.text??'')).join('\n\n'),liveText?`**正在输出**\n${liveText}`:''].filter(Boolean).join('\n\n')||'暂无新的模型回复';
    const heading=`**${textId(t.name||t.preview||t.id)}**\n目录：${t.cwd}\n会话：\`${t.id}\`\n状态：${latest?.status??t.status?.type??'未知'}${ops.length?'\n\n'+ops.join('\n'):''}\n\n`;
    const notice='（以下为截至最新回复的最近内容，较早内容已省略。）\n\n';
    const budget=12_000-Buffer.byteLength(heading,'utf8');
    let window=latestMarkdown(displayed,budget);
    if(window.truncated)window=latestMarkdown(displayed,budget-Buffer.byteLength(notice,'utf8'));
    const body=heading+(window.truncated?notice:'')+window.markdown;
    const fp=stableId(body);
    if(force||fp!==b.fingerprint) {
      const pending=this.store.pendingFor(b.thread);
      const progress=card(`${this.config.host} · 最新进展`,body,[
        {label:'刷新',command:`/status ${b.thread}`},{label:'中断当前轮次',command:`/interrupt-confirm ${b.thread}`,type:'danger'},{label:'切换会话',command:'/sessions'}]);
      this.store.putCard(`status:${b.thread}`,b.chat,progress);
      // A manual request gets a new message at the bottom of the conversation.
      // The event-derived key also makes a crash/retry reuse its original send.
      if(requestId)this.store.putCard(`reply:${requestId}:0`,b.chat,progress);
      // Every complete answer part has a stable key and survives restarts.
      if(latest?.id&&latest.status!=='inProgress') {
        splitMarkdown(messages.join('\n\n')).filter(Boolean).forEach((part,i)=>this.store.putCard(`answer:${b.thread}:${latest.id}:${i}`,b.chat,card(`${this.config.host} · 回答 ${i+1}`,part)));
      } else if(window.truncated) {
        this.store.putCard(`overflow:${b.thread}`,b.chat,card('内容较长','最新进展卡片已按模型最新回复向前截取，优先展示最近内容。完整回复仍将在轮次结束后分卡片送达。'));
      }
      for(const p of pending)this.renderPending(p.token);
      this.store.fingerprint(b.chat,b.user,fp);
    }
  }
  async poll() {
    if(this.polling||this.closing)return;this.polling=true;
    try {
      for(const b of this.store.bindings()) {
        if(this.closing)break;
        try { await this.attach(b);await this.refresh(b);this.dirty.delete(b.thread); }
        catch { /* Keep last acknowledged card; /status surfaces precise RPC failure. */ }
      }
    } finally { this.polling=false; }
  }
  private notification(method:string,p:any) {
    if(this.closing)return;
    if(method==='serverRequest/resolved') { this.store.resolveRequest(`${this.generation}:${JSON.stringify(p.requestId)}`);return; }
    if(!p?.threadId)return;
    if(!this.store.bindings().some(b=>b.thread===p.threadId))return;
    this.dirty.add(p.threadId);
    if(method==='item/agentMessage/delta') {
      const live=this.streams.get(p.threadId)??{turn:p.turnId,items:new Map<string,string>()};
      if(live.turn!==p.turnId){live.turn=p.turnId;live.items.clear();}
      const id=String(p.itemId??'current');
      live.items.set(id,((live.items.get(id)??'')+String(p.delta??'')).slice(-100_000));this.streams.set(p.threadId,live);
    }
    if(method==='turn/completed') { this.streams.delete(p.threadId);void this.poll().then(()=>this.flush()); }
  }
  private serverRequest(r:{id:string|number;method:string;params:any}) {
    if(this.closing)return;
    const thread=r.params?.threadId;
    const b=this.store.bindings().find(x=>x.thread===thread);
    if(!b)return;
    const p=this.store.pending({token:randomBytes(8).toString('hex'),requestId:`${this.generation}:${JSON.stringify(r.id)}`,method:r.method,thread,chat:b.chat,user:b.user,params:JSON.stringify(r.params),status:'pending'});
    if(p.status!=='pending')return;
    this.liveRequests.set(p.token,r.id);
    this.renderPending(p.token);void this.flush();
  }
  private renderPending(token:string) {
    const p=this.store.getPending(token);if(!p||p.status!=='pending')return;
    const params=JSON.parse(p.params);
    let body=`会话：\`${p.thread}\`\n类型：${p.method}\n\n`,actions:CardAction[]=[];
    if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(p.method)) {
      body+=`理由：${params.reason??'未提供'}\n\n${params.command??JSON.stringify(params.commandActions??params.changes??{})}\n\n仅批准这一次请求。`;
      actions=[{label:'允许本次',command:`/approve ${token}`,type:'primary'},{label:'拒绝',command:`/deny ${token}`,type:'danger'}];
    } else if(p.method==='item/tool/requestUserInput') {
      const qs=params.questions??[];
      body+=qs.map((q:any)=>`**${q.header??q.id}**\n${q.question}\n${(q.options??[]).map((o:any)=>`- ${o.label}: ${o.description}`).join('\n')}`).join('\n\n');
      body+=`\n\n回复格式：/answer ${token} `+JSON.stringify(Object.fromEntries(qs.map((q:any)=>[q.id,{answers:['你的回答']}])));
      if(qs.length===1)actions=(qs[0].options??[]).map((o:any)=>({label:o.label,command:`/answer ${token} ${JSON.stringify({[qs[0].id]:{answers:[o.label]}})}`}));
    } else {
      body+='此交互暂未实现。请在连接同一 Codex daemon 的终端中处理；服务没有自动批准或伪造回答。';
    }
    const parts=splitMarkdown(body);
    parts.forEach((part,i)=>this.store.putCard(`pending:${token}:${i}`,p.chat,card(`${this.config.host} · 等待你的操作`,part,i===parts.length-1?actions:[])));
  }
  private answer(e:Inbox,b:Binding,command:string,arg:string) {
    const at=arg.indexOf(' '), token=at<0?arg:arg.slice(0,at);
    const p=this.store.getPending(token);
    if(!p||p.status!=='pending'||!this.liveRequests.has(token)||p.chat!==e.chat||p.user!==e.user||p.thread!==b.thread)throw new Error('请求已失效或不属于当前会话，请刷新 /status');
    const params=JSON.parse(p.params);
    let result:unknown;
    if(command==='/answer') {
      if(p.method!=='item/tool/requestUserInput')throw new Error('此请求不是问答');
      const answers=JSON.parse(arg.slice(at+1));
      if(!answers||typeof answers!=='object'||Array.isArray(answers))throw new Error('答案必须是按问题 ID 索引的 JSON 对象');
      const ids=(params.questions??[]).map((q:any)=>q.id);
      if(Object.keys(answers).some(k=>!ids.includes(k))||ids.some((id:string)=>!Array.isArray(answers[id]?.answers)||!answers[id].answers.length||answers[id].answers.some((a:unknown)=>typeof a!=='string')))throw new Error('请为每个问题提供字符串 answers 数组');
      result={answers};
    } else {
      if(!['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(p.method))throw new Error('该请求不能通过通用批准按钮处理');
      const decision=command==='/approve'?'accept':'decline';
      if(params.availableDecisions&&!params.availableDecisions.includes(decision))throw new Error('服务端没有提供该选项，请在终端处理');
      result={decision};
    }
    // Reserve before responding: duplicate click cannot authorize a second request.
    this.store.finishPending(token,'responding');this.store.mark(e.id,'dispatching',b.thread);
    this.codex.respond(this.liveRequests.get(token)!,result);
    this.liveRequests.delete(token);
    this.store.finishPending(token);
    this.store.putCard(`pending:${token}:0`,p.chat,card(`${this.config.host} · 已提交操作`,command==='/answer'?'已提交回答，等待 Codex 继续。':command==='/approve'?'已允许本次请求。':'已拒绝本次请求。'));
    this.reply(e,'已处理','结果已提交给当前 Codex 连接。');
  }
  async flush() {
    if(this.flushing||this.closing)return;this.flushing=true;
    try {
      for(const row of this.store.due()) {
        if(this.closing)break;
        try {
          const body=JSON.parse(row.content);
          const message=row.message?(await this.lark.updateCard(row.message,body),row.message):await this.lark.sendCard(row.chat,body,stableId(row.key));
          if(!message)throw new Error('missing_message_receipt');
          this.store.sent(row,message);
        } catch { this.store.retry(row,'delivery_failed'); }
      }
    } finally {this.flushing=false;}
  }
}
