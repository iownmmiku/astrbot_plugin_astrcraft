'use strict';
/** Execute the actual frontend under delayed HTTP/bridge responses. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../pages/control/app.js'), 'utf8');

function harness(bridge = null) {
  const nodes = new Map(), fetches = [], timers = new Map();
  let storageReads = 0, sequence = 0;
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const value = {id, open:false, hidden:false, value:'', textContent:'', disabled:false,
      dataset:{}, style:{}, children:[], listeners:{}, classList:{toggle(){},add(){}},
      addEventListener(name,fn){this.listeners[name]=fn;}, querySelector(){return node(id+'-button');},
      replaceChildren(...children){this.children=children;this.textContent='';},
      append(...children){this.children.push(...children);}, prepend(...children){this.children.unshift(...children);},
      setAttribute(){},removeAttribute(){},showModal(){this.open=true;},close(){this.open=false;}};
    nodes.set(id,value);return value;
  }
  const context = vm.createContext({window:{AstrBotPluginPage:bridge},
    document:{getElementById:node,querySelectorAll(){return [];},querySelector(){return node('generic');},
      createElement(){return node('created-'+ ++sequence);},createTextNode(text){return {textContent:text};},
      addEventListener(){},hidden:false},
    sessionStorage:{getItem(){storageReads++;return '';},removeItem(){storageReads++;},setItem(){storageReads++;}},
    AbortController,Map,Set,URL,Date,Number,String,Boolean,JSON,Promise,Error,console,
    setTimeout(fn){const id=++sequence;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},
    location:{hostname:'localhost'},fetch(url,options){return new Promise((resolve,reject)=>fetches.push({url,options,resolve,reject}));}});
  vm.runInContext(source,context);
  return {context,nodes,fetches,timers,read:code=>vm.runInContext(code,context),storage:()=>storageReads};
}
const snapshot = (label='safe') => ({state:{connected:true,inventory:[],username:label},
  plugin:{username:label,server:'test:25566',emergency_stopped:false},engine_running:true,
  life:null,engine:null,goal:null,viewer:null,events:[],jobs:[],errors:[],version:'test'});
const reply = (data,status=200) => ({ok:status<400,status,json:async()=>data});
const flush = async () => {for(let i=0;i<8;i++)await Promise.resolve();};

async function main() {
  let checks=0;
  {
    const h=harness();h.read("token='secret';globalThis.reading=poll();");
    h.nodes.get('logout').listeners.click();
    h.fetches[0].resolve(reply(snapshot('old private position')));
    await h.context.reading;
    assert.equal(h.read('state'),null);assert.equal(h.read('token'),'');
    assert.equal(h.nodes.get('login-dialog').open,true);assert.equal(h.nodes.get('hero-server').textContent,'—');
    assert.equal(h.read('pending.size'),0);checks++;
  }
  {
    const h=harness();h.read("token='old';globalThis.reading=poll();");
    h.nodes.get('logout').listeners.click();h.read("$('token-input').value='new';");
    const logging=h.nodes.get('login-form').listeners.submit({preventDefault(){},currentTarget:h.nodes.get('login-form')});
    h.fetches[0].resolve(reply({error:'old expired'},401));await h.context.reading;
    assert.equal(h.read('token'),'new');assert.equal(h.fetches[1].options.headers.Authorization,'Bearer new');
    h.fetches[1].resolve(reply(snapshot('new session')));await logging;
    assert.equal(h.read('state.plugin.username'),'new session');assert.equal(h.nodes.get('login-dialog').open,false);checks++;
  }
  {
    const h=harness();h.read("token='secret';globalThis.action=act('say','private chat');");
    h.nodes.get('logout').listeners.click();h.fetches[0].resolve(reply({id:'old-job'}));await h.context.action;
    assert.equal(h.read('pending.size'),0);assert.equal(h.nodes.get('toast').hidden,true);checks++;
  }
  {
    const h=harness();h.read("token='secret';state="+JSON.stringify(snapshot())+";state.sampled_at=50;pending.set('new',{at:100});tasks();");
    assert.equal(h.read('pending.size'),1);
    h.read("state.sampled_at=101;tasks();");assert.equal(h.read('pending.size'),0);checks++;
  }
  {
    let resolveState, calls=[];
    const bridge={ready:async()=>({pluginName:'astrbot_plugin_astrcraft'}),
      apiGet(endpoint){calls.push(endpoint);return new Promise(resolve=>resolveState=resolve);},
      apiPost(endpoint,body){calls.push({endpoint,body});return Promise.resolve({id:'native-job'});}};
    const h=harness(bridge);await flush();resolveState(snapshot('native'));await flush();
    assert.equal(h.storage(),0);assert.equal(h.fetches.length,0);assert.equal(h.read('nativeReady'),true);
    assert.equal(h.nodes.get('login-dialog').open,false);assert.equal(h.nodes.get('logout').hidden,true);
    assert.deepEqual(calls,['state']);
    h.read("globalThis.action=act('stop');");await flush();resolveState(snapshot('native'));await h.context.action;
    assert.equal(calls[1].endpoint,'action');assert.equal(calls[1].body.action,'stop');checks++;
  }
  console.log(`全部通过（${checks} 个会话与 bridge 竞态场景）`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
