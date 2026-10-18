// Run scripts/ui-server.mjs first. Uses a temporary SDK service and simulated sends only.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const executable = join(homedir(), 'AppData/Roaming/npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe');
const url = (await readFile(new URL('../.local/ui-url.txt', import.meta.url), 'utf8')).trim();
function browser(args, input) {
  const result = spawnSync(executable, ['--session', 'clearpane-check', ...args], { input, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const output = (result.stdout + result.stderr).replace(/token=[^&\s"<>]+/g, 'token=<REDACTED>');
  if (result.status !== 0 || result.error) throw new Error(output || result.error?.message);
  return output;
}
browser(['set', 'viewport', '800', '700']);
browser(['open', new URL('/ui-check', url).href]);
const setup = `window.testUrl = ${JSON.stringify(url)};`;
const output = browser(['eval', '--stdin'], setup + String.raw`
(async () => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const wait = async predicate => {
    for (let i = 0; i < 120; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 50)); }
    throw new Error('UI wait timed out');
  };
  const frameUrl = id => { const u = new URL(window.testUrl); u.searchParams.set('conversationId', id); return u.href; };
  document.body.innerHTML = '<iframe id="pane" style="width:100%;height:640px;border:0"></iframe>';
  document.body.style.margin = '0';
  const frame = document.getElementById('pane');
  const load = async id => { frame.src = frameUrl(id); await wait(() => {
    try { return frame.contentWindow.sidecar?.conversationId === id && !frame.contentDocument.getElementById('open').disabled; } catch { return false; }
  }); return frame.contentWindow; };
  let win = await load('ui-A');
  const readCache = async id => (await (await win.sidecar.fetch('/api/session/read', {method:'POST',body:JSON.stringify({conversationId:id})})).json());
  const seed = { path:'D:/ui-fixture.md', document:{path:'D:/ui-fixture.md',name:'ui-fixture.md',
    text:'# Latest preview\n\n' + ('A paragraph for comments.\n\n'.repeat(100)) + '\n' + String.fromCharCode(96).repeat(3) + 'mermaid\ngraph TD\nA-->B\n' + String.fromCharCode(96).repeat(3),
    checkedAt:'2026-10-13T00:00:00Z'}, revision:2,error:null,
    draft:{path:'D:/ui-fixture.md',quote:'draft quote',revision:2,conversationId:'ui-A',valid:true},
    comments:['first','second'].map(quote=>({path:'D:/ui-fixture.md',quote,revision:2,conversationId:'ui-A',valid:true,comment:'comment '+quote,sourceChanged:false})),
    sending:false,uncertain:false,commentText:'unfinished draft',instruction:'execute',scrollTop:220 };
  const old = await readCache('ui-A');
  const saved = await win.sidecar.fetch('/api/session/write',{method:'POST',body:JSON.stringify({conversationId:'ui-A',version:old.version,state:seed})});
  assert(saved.ok,'seed failed');
  // Recreate the iframe without a pagehide write from the empty setup page.
  frame.remove();
  const next = document.createElement('iframe'); next.id='pane2'; next.style.cssText='width:100%;height:640px;border:0';
  document.body.append(next);
  next.src=frameUrl('ui-A');
  await wait(()=>next.contentWindow.sidecar?.conversationId==='ui-A' && !next.contentDocument.getElementById('open').disabled);
  win=next.contentWindow;
  let doc=win.document;
  await wait(()=>doc.querySelector('.diagram svg'));
  assert(doc.getElementById('preview').textContent.includes('Latest preview'),'preview missing');
  assert(doc.getElementById('comment').value==='unfinished draft','draft missing');
  assert(doc.getElementById('batch-instruction').value==='execute','instruction missing');
  assert(doc.getElementById('batch-count').textContent==='2','batch missing');
  assert(win.CSS.highlights.get('comments').size===0 && !doc.querySelector('.comment-marker'),'legacy snapshots guessed selection positions');
  assert(Math.abs(doc.getElementById('reader').scrollTop-220)<3,'scroll missing');
  assert(!doc.querySelector('.read-only'),'read-only badge remains');
  assert(doc.querySelector('.header-strip .brand'),'brand position');
  doc.getElementById('settings-toggle').click();
  doc.getElementById('typography').open=true;
  doc.getElementById('reader').focus();
  doc.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert(!doc.getElementById('typography').open && doc.getElementById('header-content').hidden,'Esc settings collapse');
  doc.getElementById('settings-toggle').click(); doc.getElementById('typography').open=true;
  next.style.display='none';
  await wait(()=>doc.getElementById('open').disabled);
  assert(!doc.getElementById('typography').open,'hidden settings remains open');
  assert(doc.getElementById('comment').value==='unfinished draft','hidden draft lost');
  next.style.display='block'; await wait(()=>!doc.getElementById('open').disabled);
  assert(doc.getElementById('batch-count').textContent==='2','hidden batch lost');
  assert(Math.abs(doc.getElementById('reader').scrollTop-220)<3,'hidden scroll lost');
  doc.getElementById('comment').value='edited draft';doc.getElementById('comment').dispatchEvent(new win.Event('input',{bubbles:true}));
  await new Promise(r=>setTimeout(r,180));
  const a=await readCache('ui-A');assert(a.state.commentText==='edited draft','edited draft cache');
  next.src=frameUrl('ui-B');
  await wait(()=>next.contentWindow.sidecar?.conversationId==='ui-B' && !next.contentDocument.getElementById('open').disabled);
  assert(next.contentDocument.getElementById('preview').hidden,'B has A preview');
  next.src=frameUrl('ui-A');
  await wait(()=>next.contentWindow.sidecar?.conversationId==='ui-A' && !next.contentDocument.getElementById('open').disabled);
  win=next.contentWindow;doc=win.document;
  assert(doc.getElementById('comment').value==='edited draft','A recreation failed');
  assert(doc.getElementById('batch-count').textContent==='2','A batch recreation');
  for (const mode of ['light','dark','system']) {
    const select=doc.getElementById('color-mode');select.value=mode;select.dispatchEvent(new win.Event('change',{bubbles:true}));
    assert(doc.documentElement.dataset.colorMode===mode,'theme failed');
  }
  for (const width of [800,320,256,213]) {
    next.style.width=width+'px';await new Promise(r=>setTimeout(r,50));
    doc.getElementById('settings-toggle').click();
    assert(doc.documentElement.scrollWidth<=width,'horizontal overflow '+width);
    assert(doc.querySelector('#typography summary').getBoundingClientRect().width<100,'settings occupies own full row '+width);
  }
  next.style.width='800px';
  const originalFetch=win.sidecar.fetch;
  let finishRead;
  win.sidecar.fetch=(path,options)=>path==='/api/read' ? new Promise(resolve=>{finishRead=resolve;}) : originalFetch(path,options);
  doc.getElementById('refresh').click();
  await wait(()=>!!finishRead);
  next.style.display='none';await wait(()=>doc.getElementById('open').disabled);
  finishRead(new win.Response(JSON.stringify({...seed.document,text:'# stale read'}),{status:200,headers:{'Content-Type':'application/json'}}));
  next.style.display='block';await wait(()=>!doc.getElementById('open').disabled);
  assert(doc.getElementById('preview').textContent.includes('Latest preview'),'late read overwrote preview');
  assert(doc.getElementById('comment').value==='edited draft','paused read destroyed draft');
  win.sidecar.fetch=async(path,options)=>path==='/api/session/write' ? new win.Response(JSON.stringify({error:'simulated cache failure'}),{status:500}) : originalFetch(path,options);
  doc.getElementById('comment').value='failure preserved';doc.getElementById('comment').dispatchEvent(new win.Event('input',{bubbles:true}));
  await wait(()=>doc.getElementById('status').textContent.includes('状态未缓存'));
  assert(doc.getElementById('comment').value==='failure preserved','cache failure lost text');
  win.sidecar.fetch=originalFetch;
  doc.getElementById('comment').dispatchEvent(new win.Event('input',{bubbles:true}));
  await new Promise(r=>setTimeout(r,150));
  let sends=0;win.sidecar.agent.sendMessage=async(message,id)=>{sends++;assert(id==='ui-A','wrong send target');assert(message.includes('comment first'),'send content');return {};};
  doc.getElementById('show-batch').click();doc.getElementById('batch-form').requestSubmit();
  await wait(()=>doc.getElementById('batch-count').textContent==='0');
  assert(sends===1,'send count');
  const final=await readCache('ui-A');assert(final.state.comments.length===0 && final.state.instruction==='','send cache not cleared');
  const unknown={...seed,sending:true};
  const v=await readCache('ui-uncertain');
  await win.sidecar.fetch('/api/session/write',{method:'POST',body:JSON.stringify({conversationId:'ui-uncertain',version:v.version,state:{...unknown,
    draft:{...unknown.draft,conversationId:'ui-uncertain'},comments:unknown.comments.map(c=>({...c,conversationId:'ui-uncertain'}))}})});
  next.src=frameUrl('ui-uncertain');
  await wait(()=>next.contentWindow.sidecar?.conversationId==='ui-uncertain' && !next.contentDocument.getElementById('open').disabled);
  doc=next.contentDocument;
  assert(doc.getElementById('send-batch').disabled && !doc.getElementById('unlock-batch').hidden,'recreated send did not lock');
  next.src=frameUrl('ui-A');
  await wait(()=>next.contentWindow.sidecar?.conversationId==='ui-A' && !next.contentDocument.getElementById('open').disabled);
  win=next.contentWindow;doc=win.document;
  const liveFetch=win.sidecar.fetch;
  win.sidecar.fetch=(path,options)=>path==='/api/read' ? Promise.resolve(new win.Response(JSON.stringify(seed.document),{status:200})) : liveFetch(path,options);
  doc.getElementById('refresh').click();await wait(()=>!doc.getElementById('refresh').disabled);
  const selectQuote=()=>{
    const range=doc.createRange();range.selectNodeContents(doc.querySelector('#preview p'));
    win.getSelection().removeAllRanges();win.getSelection().addRange(range);
    doc.dispatchEvent(new win.Event('selectionchange'));
    doc.getElementById('select-comment').click();
  };
  doc.getElementById('settings-toggle').click();doc.getElementById('resume-comment').click();doc.getElementById('cancel-comment').click();
  selectQuote();doc.getElementById('comment').value='new UI comment';doc.getElementById('comment').dispatchEvent(new win.Event('input',{bubbles:true}));
  doc.getElementById('comment-form').requestSubmit();
  assert(doc.getElementById('batch-count').textContent==='1','actual selection/add flow');
  assert(win.CSS.highlights.get('comments').size===1,'persistent highlight missing');
  let annotationSends=0;
  win.sidecar.agent.sendMessage=async()=>{annotationSends++;return {error:'simulated rejection'};};
  const addRange=(start,end=start)=>{
    const range=doc.createRange();range.setStart(start.firstChild,0);range.setEnd(end.firstChild,end.firstChild.length);
    win.getSelection().removeAllRanges();win.getSelection().addRange(range);
    doc.dispatchEvent(new win.Event('selectionchange'));doc.getElementById('select-comment').click();
    doc.getElementById('comment').value='annotation '+doc.getElementById('show-batch').textContent;
    doc.getElementById('comment').dispatchEvent(new win.Event('input',{bubbles:true}));
    doc.getElementById('comment-form').requestSubmit();
  };
  const reader=doc.getElementById('reader');
  reader.scrollTop=0;reader.dispatchEvent(new win.Event('scroll'));
  addRange(doc.querySelectorAll('#preview p')[1]);
  addRange(doc.querySelectorAll('#preview p')[1]);
  addRange(doc.querySelectorAll('#preview p')[2],doc.querySelectorAll('#preview p')[3]);
  assert(win.CSS.highlights.get('comments').size===4,'multiple/cross-paragraph highlights missing');
  const ranges=[...win.CSS.highlights.get('comments')];
  assert(ranges[1].startContainer.parentElement===doc.querySelectorAll('#preview p')[1],'duplicate text matched wrong paragraph');
  assert(ranges[3].startContainer.parentElement!==ranges[3].endContainer.parentElement,'cross-paragraph range lost');
  doc.getElementById('reader').focus();doc.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  reader.scrollTop=0;reader.dispatchEvent(new win.Event('scroll'));
  const buttons=[...doc.querySelectorAll('.comment-marker')];
  assert(!buttons[1].hidden && !buttons[2].hidden,'visible markers hidden');
  assert(Math.abs(buttons[1].getBoundingClientRect().top-buttons[2].getBoundingClientRect().top)>=28,'overlapping marker buttons');
  buttons[1].click();
  assert(doc.getElementById('batch-dialog').open && doc.activeElement.id==='batch-comment-1','marker did not focus exact comment');
  doc.activeElement.value='edited via pencil';doc.activeElement.dispatchEvent(new win.Event('input',{bubbles:true}));
  await new Promise(r=>setTimeout(r,150));
  assert((await readCache('ui-A')).state.comments[1].comment==='edited via pencil','pencil edit not cached');
  doc.getElementById('close-batch').click();
  for(const mode of ['light','dark']){
    doc.getElementById('color-mode').value=mode;doc.getElementById('color-mode').dispatchEvent(new win.Event('change',{bubbles:true}));
    assert(win.getComputedStyle(doc.getElementById('preview'),'::highlight(comments)').backgroundColor!=='rgba(0, 0, 0, 0)','invisible highlight '+mode);
  }
  for(const width of [320,256,213]){
    next.style.width=width+'px';await new Promise(r=>setTimeout(r,60));
    assert(doc.documentElement.scrollWidth<=width,'annotation overflow '+width);
    for(const button of doc.querySelectorAll('.comment-marker:not([hidden])')){
      const box=button.getBoundingClientRect();assert(box.left>=0 && box.right<=width,'marker out of viewport '+width);
    }
  }
  next.style.width='800px';await new Promise(r=>setTimeout(r,60));
  reader.scrollTop=1000;reader.dispatchEvent(new win.Event('scroll'));
  assert([...doc.querySelectorAll('.comment-marker')].every(button=>button.hidden),'offscreen markers remain');
  reader.scrollTop=0;reader.dispatchEvent(new win.Event('scroll'));
  next.style.display='none';await wait(()=>doc.getElementById('open').disabled);
  next.style.display='block';await wait(()=>!doc.getElementById('open').disabled);
  assert(win.CSS.highlights.get('comments').size===4,'hidden/return lost highlights');
  win.sidecar.conversationId='ui-B';doc.dispatchEvent(new win.Event('selectionchange'));
  await wait(()=>doc.getElementById('preview').hidden && !doc.getElementById('open').disabled);
  assert(win.CSS.highlights.get('comments').size===0 && !doc.querySelector('.comment-marker'),'B inherited annotations');
  win.sidecar.conversationId='ui-A';doc.dispatchEvent(new win.Event('selectionchange'));
  await wait(()=>!doc.getElementById('preview').hidden && !doc.getElementById('open').disabled);
  assert(win.CSS.highlights.get('comments').size===4,'conversation restore lost highlights');
  doc.getElementById('refresh').click();await wait(()=>!doc.getElementById('refresh').disabled);
  assert(win.CSS.highlights.get('comments').size===4,'unchanged refresh removed highlights');
  doc.getElementById('show-batch').click();doc.getElementById('batch-form').requestSubmit();
  await wait(()=>doc.getElementById('batch-warning').textContent.includes('拒绝'));
  assert(win.CSS.highlights.get('comments').size===4,'rejected send removed highlights');
  assert(annotationSends===1,'opened/added/edited comments sent messages');
  doc.getElementById('batch-list').children[1].querySelector('button').click();
  assert(win.CSS.highlights.get('comments').size===3,'delete did not clear one highlight');
  doc.getElementById('clear-batch').click();doc.getElementById('close-batch').click();
  assert(win.CSS.highlights.get('comments').size===0 && !doc.querySelector('.comment-marker'),'clear did not remove annotations');
  addRange(doc.querySelector('#preview p'));
  win.sidecar.fetch=(path,options)=>path==='/api/read' ? Promise.resolve(new win.Response(JSON.stringify({...seed.document,text:seed.document.text+'\nchanged'}),{status:200})) : liveFetch(path,options);
  doc.getElementById('refresh').click();await wait(()=>!doc.getElementById('refresh').disabled);
  assert(win.CSS.highlights.get('comments').size===0 && doc.getElementById('batch-count').textContent==='1','changed refresh did not retain comment and remove stale range');
  doc.getElementById('show-batch').click();doc.getElementById('clear-batch').click();doc.getElementById('close-batch').click();
  win.sidecar.fetch=(path,options)=>path==='/api/read' ? Promise.resolve(new win.Response(JSON.stringify(seed.document),{status:200})) : liveFetch(path,options);
  doc.getElementById('refresh').click();await wait(()=>!doc.getElementById('refresh').disabled);
  addRange(doc.querySelectorAll('#preview p')[1]);
  await new Promise(r=>setTimeout(r,150));
  const anchorState=(await readCache('ui-A')).state;
  const uncertainVersion=await readCache('ui-uncertain-anchor');
  await win.sidecar.fetch('/api/session/write',{method:'POST',body:JSON.stringify({conversationId:'ui-uncertain-anchor',version:uncertainVersion.version,
    state:{...anchorState,sending:true,comments:anchorState.comments.map(c=>({...c,conversationId:'ui-uncertain-anchor'}))}})});
  next.src=frameUrl('ui-uncertain-anchor');
  await wait(()=>next.contentWindow.sidecar?.conversationId==='ui-uncertain-anchor' && !next.contentDocument.getElementById('open').disabled);
  assert(next.contentWindow.CSS.highlights.get('comments').size===1 && next.contentDocument.querySelector('.comment-marker').disabled,'uncertain marker not locked');
  next.src=frameUrl('ui-A');
  await wait(()=>next.contentWindow.sidecar?.conversationId==='ui-A' && !next.contentDocument.getElementById('open').disabled);
  win=next.contentWindow;doc=win.document;
  assert(win.CSS.highlights.get('comments').size===1,'iframe recreation lost anchor');
  assert([...win.CSS.highlights.get('comments')][0].startContainer.parentElement===doc.querySelectorAll('#preview p')[1],'recreated duplicate range wrong');
  let finishSend;
  win.sidecar.agent.sendMessage=()=>new Promise(resolve=>{finishSend=resolve;});
  doc.getElementById('show-batch').click();doc.getElementById('batch-form').requestSubmit();
  await wait(()=>!!finishSend);
  assert(doc.querySelector('.comment-marker').disabled,'sending marker not locked');
  win.sidecar.conversationId='ui-B';
  doc.dispatchEvent(new win.Event('selectionchange'));
  await wait(()=>!doc.getElementById('open').disabled && doc.getElementById('preview').hidden);
  finishSend({});await new Promise(r=>setTimeout(r,200));
  assert(doc.getElementById('batch-count').textContent==='0','late send affected B');
  const late=await readCache('ui-A');assert(late.state.comments.length===0,'late send did not clear original A');
  win.sidecar.conversationId='ui-A';doc.dispatchEvent(new win.Event('selectionchange'));
  await wait(()=>!doc.getElementById('preview').hidden && !doc.getElementById('open').disabled);
  assert(doc.getElementById('preview').textContent.includes('Latest preview'),'same iframe conversation restore');
  assert(win.CSS.highlights.get('comments').size===0 && !doc.querySelector('.comment-marker'),'successful send did not clear annotations');
  win.sidecar.fetch=liveFetch;
  doc.getElementById('header').dispatchEvent(new win.Event('pointerenter'));
  doc.getElementById('typography').open=true;
  doc.getElementById('color-mode').focus();
  assert(!doc.getElementById('header-content').hidden,'final header not expanded');
  return 'PASS: persistent/cross-paragraph/duplicate highlights, pencil editing, marker overlap/scroll/themes/widths, anchor cache/recreation/isolation, changed/unchanged refresh, deletion/clear/send lifecycle and existing session checks';
})()`);
console.log(output.trim());
browser(['screenshot', resolve('.local/session-layout.png')]);
