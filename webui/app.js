"use strict";
const $ = (id) => document.getElementById(id);
const names = {overview:["世界总览","看看她在哪里，正在想什么，又准备去做什么。"],tasks:["行动与目标","了解她的计划，也可以一起决定下一步。"],inventory:["随身背包","走过的路，采集的物资，都装在这里。"],events:["世界记录","那些聊天、发现与行动，组成她的日常。"]};
const statuses = {running:"进行中",done:"已完成",failed:"失败",cancelled:"已中断",paused:"已暂停",idle:"待命",abandoned:"已放弃",queued:"排队中"};
const actions = {connect:"进服",disconnect:"退服",stop:"急停",resume:"继续",pause:"暂停",abandon:"放弃目标",goal:"指派目标",say:"游戏发言",viewer:"开启观战"};
const dimensions = {overworld:"主世界","minecraft:overworld":"主世界",the_nether:"下界",nether:"下界","minecraft:the_nether":"下界",the_end:"末地",end:"末地","minecraft:the_end":"末地"};
let token = "", state = null, timer = null, toastTimer = null, polling = false;
const pending = new Map();
try { token = sessionStorage.getItem("astrcraft-token") || ""; } catch (_) { /* Private browser storage can be disabled. */ }
function text(id, value) { $(id).textContent = value == null || value === "" ? "—" : String(value); }
function element(tag, className, content) { const node = document.createElement(tag); if(className) node.className = className; if(content != null) node.textContent = String(content); return node; }
function number(value) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function clock(at) { return at ? new Date(at * 1000).toLocaleTimeString("zh-CN",{hour12:false}) : "—"; }
function toast(message, error=false) { $("toast").textContent=message; $("toast").classList.toggle("error",error); $("toast").hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$("toast").hidden=true,5500); }
function notice(message) { $("notice").hidden=!message; $("notice").textContent=message; }
function login(message="") { clearTimeout(timer); token=""; try{sessionStorage.removeItem("astrcraft-token");}catch(_){} if(!$("login-dialog").open)$("login-dialog").showModal(); $("login-shade").hidden=true; $("login-error").hidden=!message; $("login-error").textContent=message; text("connection-label","等待登录"); $("connection-dot").className="dot"; updateButtons(); }
function loggedIn() { $("login-dialog").close(); $("login-shade").hidden=true; $("token-input").value=""; }
async function request(path, options={}) {
  const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),13000);
  try {
    const response=await fetch(path,{...options,headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json",...(options.headers||{})},signal:controller.signal,cache:"no-store"});
    const data=await response.json();
    if(!response.ok){ if(response.status===401)login(data.error); throw new Error(data.error||`HTTP ${response.status}`); }
    return data;
  } catch(error) { if(error.name==="AbortError")throw new Error("控制台响应超时"); throw error; }
  finally {clearTimeout(timeout);}
}
function setPage(page) {
  if(!names[page])return;
  document.querySelectorAll("[data-panel]").forEach(node=>node.hidden=node.dataset.panel!==page);
  document.querySelectorAll(".nav-item").forEach(node=>{const active=node.dataset.page===page;node.classList.toggle("active",active); if(active)node.setAttribute("aria-current","page");else node.removeAttribute("aria-current");});
  $("page-title").replaceChildren(document.createTextNode(names[page][0]),element("span","title-dot","."));text("page-subtitle",names[page][1]);
}
function updateButtons() {
  const busy=pending.size>0 || state?.jobs?.some(job=>job.status==="running");
  const connected=Boolean(state?.state?.connected && state?.engine_running);
  document.querySelectorAll("[data-action]").forEach(button=>{
    const action=button.dataset.action;
    button.disabled=!token || (busy && !["stop","disconnect"].includes(action)) || (["viewer"].includes(action)&&!connected);
  });
  ["goal-form","chat-form"].forEach(id=>$(id).querySelector("button[type=submit]").disabled=!token||busy||!connected|| (id==="goal-form"&&state?.plugin?.emergency_stopped));
}
function bar(id, value, max=20) { $(id).style.width=`${number(value)==null?0:Math.max(0,Math.min(100,value/max*100))}%`; }
function eventLabel(event) {
  const data=event.data||{};
  if(event.event==="chat")return `${data.username||data.sender||"玩家"}：${data.message||data.text||""}`;
  if(event.event==="task.finished")return `${data.name||data.task_id||"任务"} · ${statuses[data.status]||data.status||"结束"}${data.error?` · ${data.error}`:""}`;
  const labels={"bot.spawn":"她进入了世界","bot.respawn":"她重新出生了","bot.death":"她倒下了","bot.disconnect":"游戏连接断开","bot.kicked":"被服务器断开","bot.hurt":"她受伤了","bot.hungry":"需要补充食物","bot.world_changed":"她切换了世界","bot.world_ready":"新世界已就绪","discover.mob":"发现了新的生物","discover.item":"获得了新的物品","discover.landmark":"发现了新的地点","tool.broken":"工具损坏","viewer.started":"观战服务启动"};
  const detail=data.reason||data.message||data.name||data.item||data.mob||"";
  return `${labels[event.event]||event.event||"世界事件"}${detail?` · ${typeof detail==="object"?JSON.stringify(detail):detail}`:""}`.slice(0,700);
}
function events() {
  const records=[...(state?.events||[])].reverse();
  [["recent-events",records.slice(0,4)],["all-events",records.filter(e=>$("event-filter").value==="all"||e.event?.startsWith($("event-filter").value))]].forEach(([id,list])=>{
    const container=$(id);container.replaceChildren();
    if(!list.length){container.append(element("p","empty","暂无对应事件。启用 forward_engine_events 后会记录引擎动态。"));return;}
    for(const record of list){const row=element("div","event-row");const time=element("time","",clock(record.at));
      if(id==="recent-events")row.append(element("span","event-text",eventLabel(record)),time);
      else row.append(time,element("span","event-type",record.event),element("span","event-text",eventLabel(record)));
      container.append(row);
    }
  });
}
function steps(id, list, current=-1, completed=false) {
  const container=$(id);container.replaceChildren();
  if(!list.length){container.append(element("li","empty",id==="life-plan"?"暂无待执行的自主计划。":"尚未指派目标。"));return;}
  list.forEach((step,index)=>{const done=completed||index<current;const li=element("li",done?"done":index===current?"current":"");li.append(element("span","step-number",done?"✓":String(index+1).padStart(2,"0")));const body=element("div","",step.label||step.skill);if(step.why)body.append(element("small","",step.why));li.append(body);container.append(li);});
}
function tasks() {
  const goal=state.goal||{}, list=goal.steps||[], count=Math.min(goal.index||0,list.length);
  text("goal-title",goal.title||"暂无长期目标");text("task-goal-title",goal.title||"暂无长期目标");
  text("goal-detail",goal.title?`${statuses[goal.status]||goal.status} · 已完成 ${count} / ${list.length} 步`:"她会按自主生活逻辑安排接下来的行动。");
  text("goal-status",goal.title?statuses[goal.status]||goal.status:"无目标");bar("goal-meter",count,list.length||1);
  steps("goal-steps",list,goal.index,goal.status==="done");steps("life-plan",state.life?.plan||[]);
  $("goal-error").hidden=!goal.error;text("goal-error",goal.error);
  const queue=[state.engine?.current_task,...(state.engine?.queue||[])].filter(Boolean);
  text("queue-count",`${state.engine?.queued??0} 个排队`);$("engine-tasks").replaceChildren();
  if(!queue.length)$("engine-tasks").append(element("p","empty",state.engine?"当前没有引擎任务。":"引擎任务尚未读取。"));
  for(const task of queue){const row=element("div","task-row");row.append(element("span","",task.name||task.task_id),element("small","",`${statuses[task.status]||task.status||"待执行"} · ${task.detail||""}`));$("engine-tasks").append(row);}
  $("jobs").replaceChildren();
  for(const job of [...(state.jobs||[])].reverse()){
    const row=element("div",`job-row ${job.status}`);row.append(element("time","",clock(job.at)),element("small","",actions[job.action]||job.action),element("span","",job.message),element("small","",statuses[job.status]||job.status));$("jobs").append(row);
    if(job.status!=="running" && pending.has(job.id)){
      const form=pending.get(job.id);pending.delete(job.id);toast(job.message,job.status==="failed");
      if(job.status==="done" && form?.input && $(form.input).value.trim()===form.text)$(form.input).value="";
    }
  }
  if(!state.jobs?.length)$("jobs").append(element("p","empty","尚未从控制台发出操作。"));
}
function itemKind(name) {
  if(/pickaxe|axe|sword|shovel|hoe|bow|shield/.test(name))return ["tool","⚒"];
  if(/beef|pork|bread|apple|chicken|carrot|potato|mutton|salmon|cod|berry/.test(name))return ["food","◒"];
  if(/ingot|ore|coal|diamond|raw_/.test(name))return ["ore","◆"];
  if(/log|planks|stick|wood/.test(name))return ["wood","▥"];
  return ["block","▧"];
}
function inventory() {
  const game=state?.state||{}, list=game.inventory||[], query=$("item-filter").value.trim().toLowerCase(), available=game.connected&&Array.isArray(game.inventory);
  const slots=new Map(list.map(item=>[item.slot,item]));
  text("inventory-detail",available?`${list.length} 个已使用槽位 · 手持 ${game.held_item?.display||game.held_item?.name||"空手"} · 图标为物品类别示意`:"背包尚未读取；空槽图仅表示布局。");
  [["inventory-main",9,36],["inventory-hotbar",36,45]].forEach(([id,start,end])=>{
    const container=$(id);container.replaceChildren();
    for(let i=start;i<end;i++){
      const item=slots.get(i), matches=item&&`${item.name} ${item.display||""}`.toLowerCase().includes(query);
      const selected=start===36 && game.held_item?.slot===i-36;
      const slot=element("div",`slot ${item?"filled":""} ${selected?"highlight":""} ${query&&!matches?"dim":""}`);slot.setAttribute("role","img");
      const title=item?`${item.display||item.name} (${item.name}) ×${item.count}${item.durability_pct!=null?` · 耐久 ${item.durability_pct}%`:""}`:available?"空槽位":"尚未读取";
      slot.title=title;slot.setAttribute("aria-label",`槽位 ${i}：${title}`);
      if(start===36)slot.append(element("span","slot-index",i-35));
      if(item){const [kind,glyph]=itemKind(item.name);slot.dataset.kind=kind;slot.append(element("span","item-glyph",glyph),element("span","slot-count",item.count),element("span","slot-name",item.display||item.name));}
      container.append(slot);
    }
  });
  $("item-results").replaceChildren();$("item-results").hidden=!query;
  if(query){const found=list.filter(item=>`${item.name} ${item.display||""}`.toLowerCase().includes(query));for(const item of found)$("item-results").append(element("span","",`${item.display||item.name} ×${item.count}`));if(!found.length)$("item-results").append(element("span","","没有匹配物品"));}
  $("equipment").replaceChildren();
  const armor=new Map((Array.isArray(game.armor)?game.armor:[]).map(item=>[item.slot,item]));
  const gear={主手:game.held_item,helmet:armor.get("helmet"),chestplate:armor.get("chestplate"),leggings:armor.get("leggings"),boots:armor.get("boots")};
  for(const [slot,item] of Object.entries(gear)){
    const labels={head:"头部",helmet:"头盔",chest:"胸甲",chestplate:"胸甲",legs:"护腿",leggings:"护腿",feet:"靴子",boots:"靴子",offhand:"副手"};
    const row=element("div","equipment-row",item?.display||item?.name||(available?"未装备":"尚未读取"));row.prepend(element("small","",labels[slot]||slot));$("equipment").append(row);
  }
}
function render() {
  const s=state.state||{}, p=state.plugin, life=state.life, ready=Boolean(state.engine_running&&s.connected);
  const stopped=p.emergency_stopped || state.engine?.emergency_stopped;
  text("version",`ASTRCRAFT / V${state.version}`);text("connection-label","控制台已连接");text("connection-detail",`上次同步 ${clock(state.sampled_at)}`);$("connection-dot").className="dot online";
  text("refresh-state",`已同步 ${clock(state.observed_at)}`);text("game-status",stopped?"急停中":ready?"已进入世界":state.engine_running?"游戏未连接":"引擎未运行");$("game-dot").className=ready&&!stopped?"dot online":"dot bad";
  text("mode-label",stopped?"EMERGENCY STOP · 已急停":ready?"IN THE WORLD · 世界已连接":"WAITING · 等待进服");
  text("hero-title",stopped?"先停一下，\n再继续冒险。":ready?`${s.username||p.username}，\n正在她的世界里。`:"她的冒险，\n从这里开始。");$("hero-title").classList.add("pre-wrap");
  text("hero-description",stopped?"她已保持暂停。确认环境后，点击继续游玩恢复行动。":life?.hold_reason||"点击进入服务器，开始她的自主生活。");
  text("hero-server",`${p.username} @ ${p.server}`);
  const daytime=number(s.time_of_day);text("world-clock",daytime==null?"世界时间 —":`世界时间 ${Math.floor(((daytime/1000)+6)%24).toString().padStart(2,"0")}:${Math.floor((daytime%1000)*60/1000).toString().padStart(2,"0")}`);
  const health=ready?number(s.health):null, food=ready?number(s.food):null; text("health",health);text("max-health",`/ ${ready?s.max_health??20:"—"}`);text("food",food);bar("health-meter",health,s.max_health||20);bar("food-meter",food);
  text("health-status",health==null?"未读取":health<=6?"需要恢复":"生命状态");text("food-status",food==null?"未读取":food<=6?"需要补给":"饱食状态");
  text("dimension",ready?(dimensions[s.dimension]||s.dimension||"未知维度"):"未知维度");text("coordinates",ready&&s.position?[s.position.x,s.position.y,s.position.z].map(v=>number(v)==null?"—":Math.floor(v)).join(" / "):"— / — / —");
  text("standing",ready?`脚下 ${s.standing_on||"未知"}${s.in_water?" · 在水中":""}${s.in_lava?" · 在岩浆中":""}`:"脚下地形尚未读取");text("xp",ready?s.xp?.level:null);text("weather",ready&&typeof s.is_raining==="boolean"?(s.is_raining?"下雨":"晴朗"):"—");text("environment",`光照 ${ready?s.light??"—":"—"} · 延迟 ${ready?s.ping??"—":"—"}${ready&&number(s.ping)!=null?" ms":""}`);
  text("activity",life?.activity||"暂无近期决策");text("reason",life?.reason||life?.hold_reason||"自主生活系统未初始化");text("intention",life?.intention||"尚未形成持续打算");text("life-tag",stopped?"已急停":life?.paused?"已暂停":life?.running?"自主生活":"待命");text("plan-count",life?`自主计划还剩 ${life.plan.length} 步`:"生活系统未初始化");text("hold-reason",life?.hold_reason);text("life-summary",life?.summary);
  const viewer=state.viewer;$("viewer-link").hidden=!viewer?.running;
  document.querySelector('[data-action="viewer"]').hidden=Boolean(viewer?.running);
  if(viewer?.running){try{const url=new URL(viewer.url);if(url.protocol==="http:"&&url.port){url.hostname=location.hostname;$("viewer-link").href=url.href;}else $("viewer-link").hidden=true;}catch(_){$("viewer-link").hidden=true;}}
  notice(state.errors.join("\n"));tasks();inventory();events();updateButtons();
}
async function poll() {
  if(!token||polling)return;clearTimeout(timer);polling=true;
  try{state=await request("/api/state");loggedIn();render();}
  catch(error){if(token){notice(`同步中断：${error.message}。页面保留上次数据，暂不能确认最新状态。`);text("connection-label","同步中断");text("refresh-state","数据可能已过期");$("connection-dot").className="dot bad";}}
  finally{polling=false;if(token)timer=setTimeout(poll,document.hidden?10000:2000);}
}
async function act(action, content="", input=null) {
  try{const job=await request("/api/action",{method:"POST",body:JSON.stringify({action,text:content})});pending.set(job.id,{input,text:content});toast(`${actions[action]}已提交，正在执行…`);updateButtons();await poll();}
  catch(error){toast(error.message,true);}
}
document.querySelectorAll("[data-page]").forEach(button=>button.addEventListener("click",()=>setPage(button.dataset.page)));
document.querySelectorAll("[data-action]").forEach(button=>button.addEventListener("click",()=>act(button.dataset.action)));
document.querySelectorAll("[data-suggestion]").forEach(button=>button.addEventListener("click",()=>{$("goal-input").value=button.dataset.suggestion;$("goal-input").focus();}));
$("login-form").addEventListener("submit",async event=>{event.preventDefault();token=$("token-input").value.trim();const button=event.currentTarget.querySelector("button");button.disabled=true;try{state=await request("/api/state");try{sessionStorage.setItem("astrcraft-token",token);}catch(_){}loggedIn();render();timer=setTimeout(poll,2000);}catch(error){$("login-error").textContent=error.message;$("login-error").hidden=false;}finally{button.disabled=false;}});
$("goal-form").addEventListener("submit",event=>{event.preventDefault();const value=$("goal-input").value.trim();if(value)act("goal",value,"goal-input");else toast("请填写目标内容",true);});
$("chat-form").addEventListener("submit",event=>{event.preventDefault();const value=$("chat-input").value.trim();if(value)act("say",value,"chat-input");else toast("请填写聊天内容",true);});
$("item-filter").addEventListener("input",inventory);$("event-filter").addEventListener("change",events);
$("refresh").addEventListener("click",poll);$("logout").addEventListener("click",()=>{pending.clear();login();});
$("login-dialog").addEventListener("cancel",event=>event.preventDefault());
$("mobile-logout").addEventListener("click",()=>{pending.clear();login();});
document.addEventListener("visibilitychange",()=>{if(!document.hidden)poll();});
updateButtons();if(token)poll();else login();
