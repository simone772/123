const $ = (id) => document.getElementById(id);
const state = {
  videos: [],
  password: localStorage.getItem("studio_password") || "",
  currentView: "upload",
  strategy: "media",
  plan: [],
  plannedVideoIds: new Set(),
  variants: 2,
  hasDeepgram: false,
  bands: ["mattina","pranzo","sera"],
  hashtags: localStorage.getItem("studio_hashtags") ?? "#raffaelloluly #traveltech #marketing",
};
const REMOTE_BACKEND = "https://extraordinary-hotteok-8ce22b.netlify.app";
const API_BASE = location.protocol === "file:" ? REMOTE_BACKEND : "";
const defaultStyle = `Italiano naturale. Diretto, concreto, utile.
Frasi brevi. Niente tono corporate.
Una sola idea forte per contenuto.
Hook chiaro nella prima riga.
Tono da consulente esperto ma umano.`;

// ---- Motore di distribuzione (strategie precaricate) ----
// Fasce orarie (l'orario esatto al minuto non conta per l'algoritmo: bastano le fasce)
const BANDS = { mattina:"09:00", pranzo:"13:00", pomeriggio:"17:00", sera:"20:00" };
const BAND_LABEL = { mattina:"Mattina · 9:00", pranzo:"Pranzo · 13:00", pomeriggio:"Pomeriggio · 17:00", sera:"Sera · 20:00" };
const DEFAULT_BANDS = ["mattina","pranzo","sera"];
// Peso per giorno (getDay: 0=dom ... 6=sab)
const DAY_WEIGHT = {0:0.4, 1:0.7, 2:1, 3:1, 4:1, 5:0.7, 6:0.4};
// Compatibilità formato video -> canali (tiktok escluso: account non collegato)
const COMPAT = {
  short_vertical: ["instagram","facebook","youtube","twitter"],
  square: ["facebook","linkedin","twitter"],
  landscape: ["linkedin","twitter","youtube","facebook"],
};
const FAMILY_LABEL = {short_vertical:"Verticale 9:16", square:"Quadrato 1:1", landscape:"Orizzontale 16:9"};
const STRATEGIES = {
  aggressiva: { label:"Aggressiva", crosspostDelayHours:[0,3,6,9,12], maxPerDay:3, slotTypes:["prime","standard","overflow"], maxPerWeek:Infinity },
  media:      { label:"Media",      crosspostDelayHours:[0,2,4,6,8],  maxPerDay:1, slotTypes:["prime"], maxPerWeek:Infinity },
  lenta:      { label:"Lenta",      crosspostDelayHours:[0,4,8,12,16],maxPerDay:1, slotTypes:["prime"], maxPerWeek:4 },
};

function showAuth(id){["setup","login","upload","studio","schedule","queue","settings"].forEach(x=>$(x).classList.toggle("hidden",x!==id))}
function setView(id){
  state.currentView=id;
  ["upload","studio","schedule","queue","settings"].forEach(x=>$(x).classList.toggle("hidden",x!==id));
  document.querySelectorAll(".nav").forEach(b=>b.classList.toggle("active",b.dataset.view===id));
  renderAll();
}
async function api(path, opts={}){
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...opts,
    headers: {"content-type":"application/json","x-app-password":state.password,...(opts.headers||{})}
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw Object.assign(new Error(data.error || "Errore"), {status:res.status, data});
  return data;
}
function platforms(){return [...document.querySelectorAll("#channels input:checked")].map(b=>b.dataset.platform)}
function setTomorrow(){const d=new Date(Date.now()+86400000);$("startDate").value=d.toISOString().slice(0,10)}
function scheduleFor(){return ""}
function escapeHtml(s){return String(s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;")}
function escapeRegex(s){return String(s).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}
function getHashtags(){return (state.hashtags||"").trim()}
// Garantisce che il testo finisca SEMPRE con gli hashtag fissi, senza duplicarli.
// Su X (twitter) tengo solo il primo hashtag (limite 280 caratteri).
function withHashtags(text, platform){
  const tags=getHashtags(); let out=(text||"").trim();
  if(!tags) return out;
  let list=tags.split(/\s+/).filter(Boolean);
  // Rimuovo eventuali occorrenze già presenti di QUALSIASI hashtag fisso
  for(const t of list){ out=out.replace(new RegExp(`\\s*${escapeRegex(t)}(?=\\s|$)`,"gi"),"").trim(); }
  if(platform==="twitter") list=list.slice(0,1);
  if(!list.length) return out;
  return (out?out+"\n\n":"")+list.join(" ");
}
function formatWhen(iso){return iso?new Date(iso).toLocaleString("it-IT",{weekday:"short",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}):"da programmare"}

// ---- Rilevo il formato del video dall'aspect ratio ----
function detectFormat(file){
  return new Promise((resolve)=>{
    try{
      const url=URL.createObjectURL(file);
      const vid=document.createElement("video");
      vid.preload="metadata";
      vid.onloadedmetadata=()=>{
        const w=vid.videoWidth, h=vid.videoHeight; URL.revokeObjectURL(url);
        if(!w||!h) return resolve("short_vertical");
        const r=w/h;
        resolve(r<0.9 ? "short_vertical" : (r<=1.2 ? "square" : "landscape"));
      };
      vid.onerror=()=>{URL.revokeObjectURL(url);resolve("short_vertical")};
      vid.src=url;
    }catch{ resolve("short_vertical"); }
  });
}
function compatibleChannels(v){ return COMPAT[v.formatFamily||"short_vertical"] || COMPAT.short_vertical; }
// Canali compatibili col formato e attivi globalmente (base per la scelta per-video)
function baseChannels(v){
  const active=platforms();
  const compat=compatibleChannels(v).filter(c=>active.includes(c));
  return compat.length ? compat : active;
}
// Canali effettivi del video: base ∩ scelta per-video (se impostata)
function genChannels(v){
  const base=baseChannels(v);
  if(Array.isArray(v.channels)) return base.filter(c=>v.channels.includes(c));
  return base;
}

// ---- buildCalendar: coda deterministica che si riempie in avanti ----
function pad2(n){return String(n).padStart(2,"0")}
function dateKey(d){return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`}
function weekKey(d){const t=new Date(d);const dow=(t.getDay()+6)%7;t.setDate(t.getDate()-dow);t.setHours(0,0,0,0);return dateKey(t)}
function atTime(d,hhmm){const [h,m]=hhmm.split(":").map(Number);const x=new Date(d);x.setHours(h,m,0,0);return x}
function daySlots(channel,strategy,date){
  const weight=DAY_WEIGHT[date.getDay()] ?? 1;
  const max=Math.max(0,Math.round(strategy.maxPerDay*weight));
  if(max===0) return [];
  const chosen=(state.bands&&state.bands.length?state.bands:DEFAULT_BANDS);
  const times=chosen.map(b=>({hhmm:BANDS[b],type:b})).filter(t=>t.hhmm).sort((a,b)=>a.hhmm.localeCompare(b.hhmm));
  return times.slice(0,max);
}
function nextFreeSlot(channel,fromDate,strategy,sched){
  const from=new Date(fromDate);
  for(let i=0;i<400;i++){
    const day=new Date(from); day.setDate(day.getDate()+i);
    const dk=dateKey(day), wk=weekKey(day);
    if((sched.weekCount[channel]?.[wk]||0) >= strategy.maxPerWeek) continue;
    const slots=daySlots(channel,strategy,day);
    const used=sched.dayCount[channel]?.[dk]||0;
    for(let s=used;s<slots.length;s++){
      const when=atTime(day,slots[s].hhmm);
      if(when < from) continue;
      sched.dayCount[channel]=sched.dayCount[channel]||{}; sched.dayCount[channel][dk]=s+1;
      sched.weekCount[channel]=sched.weekCount[channel]||{}; sched.weekCount[channel][wk]=(sched.weekCount[channel][wk]||0)+1;
      return {time:when, slotType:slots[s].type};
    }
  }
  return null;
}
function buildCalendar(videos, strategyKey, activeChannels, opts={}){
  const strategy=STRATEGIES[strategyKey]||STRATEGIES.media;
  const startFrom=opts.startFrom||new Date(Date.now()+3600000);
  const sched={dayCount:{},weekCount:{}};
  const cursor={};
  for(const p of opts.seedPlan||[]){
    const ch=p.channel, t=new Date(p.scheduledTime);
    if(!cursor[ch]||t>cursor[ch]) cursor[ch]=t;
    const dk=dateKey(t), wk=weekKey(t);
    sched.dayCount[ch]=sched.dayCount[ch]||{}; sched.dayCount[ch][dk]=(sched.dayCount[ch][dk]||0)+1;
    sched.weekCount[ch]=sched.weekCount[ch]||{}; sched.weekCount[ch][wk]=(sched.weekCount[ch][wk]||0)+1;
  }
  const ordered=[...videos].sort((a,b)=>(b.priority?1:0)-(a.priority?1:0));
  const out=[];
  for(const v of ordered){
    let channels=compatibleChannels(v).filter(c=>activeChannels.includes(c));
    if(Array.isArray(v.channels)) channels=channels.filter(c=>v.channels.includes(c));
    channels.forEach((channel,i)=>{
      const base=(cursor[channel]&&cursor[channel]>startFrom)?cursor[channel]:startFrom;
      const delayH=strategy.crosspostDelayHours[i] ?? (i*2);
      const from=new Date(base.getTime()+delayH*3600000);
      const slot=nextFreeSlot(channel,from,strategy,sched);
      if(!slot) return;
      const post=(v.posts||[]).find(p=>p.platform===channel)||{};
      out.push({videoId:v.id, videoName:v.name, channel, scheduledTime:slot.time.toISOString(), slotType:slot.slotType, text:post.text||"", title:post.title||"", mediaUrl:v.mediaUrl||"", status:"draft"});
      cursor[channel]=slot.time;
    });
  }
  return out.sort((a,b)=>new Date(a.scheduledTime)-new Date(b.scheduledTime));
}

async function init(){
  $("setupStyle").value=defaultStyle; $("liveStyle").value=defaultStyle; setTomorrow();
  if($("publisherName")) $("publisherName").value="Blotato";
  if($("writerName")) $("writerName").value="Generatore testi da collegare";
  if($("transcriberName")) $("transcriberName").value="Trascrizione da collegare";
  if($("hostingName")) $("hostingName").value="Netlify";
  $("fixedHashtags").value=state.hashtags||"";
  try{
    const s=await api("/status");
    $("liveStyle").value=s.style || defaultStyle;
    $("brandPrompt").value=s.brandPrompt || "";
    $("styleExamples").value=s.styleExamples || "";
    updateExamplesMeta();
    state.hasDeepgram=!!s.hasDeepgram;
    $("deepgramState").textContent=s.hasDeepgram
      ? "Trascrizione collegata: i video vengono trascritti in automatico al caricamento."
      : "Trascrizione non collegata: puoi incollare una key oppure inserire il testo a mano.";
    renderAccounts(s.accounts || {});
    showAuth("upload");
    setView("upload");
  }catch(e){
    if(e.data?.error==="setup_required") showAuth("setup");
    else if(e.status===401) showAuth("login");
    else { showAuth("login"); alert(`Server non raggiungibile: ${e.message}`); }
  }
}

function renderAccounts(accounts){
  const entries=Object.entries(accounts);
  $("accounts").innerHTML = entries.length ? entries.map(([k,v])=>`<span class="account">${k}${v.username?` · ${v.username}`:""}</span>`).join("") : "Nessun account caricato.";
}
function renderAll(){renderUpload();renderStudio();renderQueue();renderCalendarPreview();}
function renderUpload(){
  $("videoList").innerHTML = state.videos.length ? state.videos.map(v=>`<div class="videoRow">
    <div class="thumb"></div>
    <div><strong>${escapeHtml(v.name)}</strong><span class="pill">${escapeHtml(v.status)}</span> ${v.formatFamily?`<span class="pill">${FAMILY_LABEL[v.formatFamily]||v.formatFamily}</span>`:""} <span class="muted">${(v.posts||[]).length} post</span></div>
    <button onclick="removeVideo('${v.id}')">elimina</button>
  </div>`).join("") : "Nessun video caricato.";
}
function renderStudio(){
  $("studioList").innerHTML = state.videos.length ? state.videos.map((v,i)=>{
    const sel=genChannels(v);
    const posts=(v.posts||sel.map(platform=>({platform,text:"",variants:[],variantIndex:0,mediaUrl:v.mediaUrl})));
    v.posts=posts;
    const compat=baseChannels(v);
    const chanChips=compat.length
      ? compat.map(c=>`<button type="button" class="chanChip ${sel.includes(c)?'on':''}" onclick="toggleChannel('${v.id}','${c}')">${c}</button>`).join("")
      : `<span class="muted">Nessun canale attivo compatibile con questo formato. Attiva i social in Impostazioni.</span>`;
    return `<div class="videoBlock">
      <div class="videoTitle"><div class="thumb"></div><div><strong>${escapeHtml(v.name)}</strong><div class="muted">${posts.length} post · ${escapeHtml(v.status)}${v.formatFamily?` · ${FAMILY_LABEL[v.formatFamily]||v.formatFamily}`:""}</div></div></div>
      <div class="chanPick">
        <span class="chanPickLabel">Pubblica su:</span>
        ${chanChips}
      </div>
      <div class="transcriptBox">
        <label>Trascrizione del video</label>
        <textarea placeholder="Trascrizione automatica, oppure incollala qui a mano." onchange="editTranscript('${v.id}',this.value)">${escapeHtml(v.transcript||"")}</textarea>
        <div class="postActions"><div><button onclick="reTranscribe('${v.id}')">↻ Trascrivi di nuovo</button> <button onclick="useTranscriptAsBase('${v.id}')">Usa come testo base</button></div><span>${v.transcript?`${(v.transcript||"").length} caratteri`:"nessuna trascrizione"}</span></div>
      </div>
      ${posts.map((p,j)=>`<div class="postCard">
        <div class="postHead"><strong>${p.platform}</strong><span class="muted">${(p.text||"").length}/2200</span></div>
        ${(p.variants&&p.variants.length>1)?`<div class="variantTabs">${p.variants.map((_,k)=>`<button type="button" class="${k===(p.variantIndex||0)?'on':''}" onclick="pickVariant('${v.id}',${j},${k})">Variante ${k+1}</button>`).join("")}</div>`:""}
        <textarea placeholder="Scrivi qui la caption, oppure usa il generatore testi..." onchange="editPost('${v.id}',${j},this.value)">${escapeHtml(p.text)}</textarea>
        <div class="postActions"><div><button onclick="copyPost('${v.id}',${j})">copia</button></div><span>${p.platform==="youtube"&&p.title?escapeHtml(p.title):""}</span></div>
      </div>`).join("")}
    </div>`;
  }).join("") : "Carica almeno un video.";
}
window.editTranscript=(videoId,value)=>{const v=state.videos.find(x=>x.id===videoId); if(v) v.transcript=value;};
window.pickVariant=(videoId,index,k)=>{const v=state.videos.find(x=>x.id===videoId); const p=v?.posts?.[index]; if(p&&p.variants&&p.variants[k]!==undefined){p.variantIndex=k;p.text=p.variants[k];} renderStudio();};
window.reTranscribe=(videoId)=>{const v=state.videos.find(x=>x.id===videoId); if(v?.mediaUrl) transcribeItem(v); else alert("Manca il video caricato.");};
window.toggleChannel=(videoId,channel)=>{
  const v=state.videos.find(x=>x.id===videoId); if(!v) return;
  const base=baseChannels(v);
  let sel=Array.isArray(v.channels)?v.channels.filter(c=>base.includes(c)):[...base];
  sel = sel.includes(channel) ? sel.filter(c=>c!==channel) : [...sel,channel];
  v.channels=sel;
  // Risincronizzo i post sui canali scelti, conservando i testi già presenti
  const prev=v.posts||[];
  v.posts=base.filter(c=>sel.includes(c)).map(platform=>{
    const ex=prev.find(p=>p.platform===platform);
    return ex || {platform,text:"",variants:[],variantIndex:0,mediaUrl:v.mediaUrl};
  });
  renderStudio();
};
window.useTranscriptAsBase=(videoId)=>{
  const v=state.videos.find(x=>x.id===videoId); if(!v) return;
  const t=(v.transcript||"").trim();
  if(!t) return alert("Non c'è ancora una trascrizione per questo video. Trascrivilo o incollala a mano.");
  const chans=genChannels(v);
  if(!chans.length) return alert("Nessun canale selezionato per questo video.");
  v.posts=chans.map(platform=>{const text=withHashtags(t,platform);return {platform,text,variants:[text],variantIndex:0,mediaUrl:v.mediaUrl};});
  renderStudio();
};
async function transcribeItem(item){
  if(!state.hasDeepgram){ item.status="trascrizione non collegata"; renderAll(); return; }
  item.status="trascrivo…"; renderAll();
  try{
    const out=await api("/transcribe",{method:"POST",body:JSON.stringify({mediaUrl:item.mediaUrl})});
    item.transcript=out.transcript||"";
    item.status=item.transcript?"trascritto":"caricato (nessun parlato rilevato)";
  }catch(e){ item.status=`errore trascrizione: ${e.message}`; }
  renderAll();
}
function renderPlanByDay(plan, withRemove){
  const byDay={};
  for(const p of plan){ const k=p.scheduledTime?dateKey(new Date(p.scheduledTime)):"now"; (byDay[k]=byDay[k]||[]).push(p); }
  return Object.keys(byDay).sort().map(k=>{
    const immediate=k==="now";
    const items=byDay[k].sort((a,b)=>new Date(a.scheduledTime||0)-new Date(b.scheduledTime||0));
    const dlabel=immediate?"Pubblica subito":new Date(k+"T00:00:00").toLocaleDateString("it-IT",{weekday:"long",day:"2-digit",month:"long"});
    return `<div class="calDay"><h3>${dlabel}</h3>${items.map(p=>{
      const time=p.scheduledTime?new Date(p.scheduledTime).toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"}):"subito";
      const st = p.status==="scheduled" ? '<span class="calState ok">✓ programmato</span>'
        : p.status==="error" ? `<span class="calState err" title="${escapeHtml(p.error||"")}">errore</span>`
        : p.status==="sending" ? '<span class="calState">invio…</span>'
        : (withRemove ? `<button onclick="removePlanPost('${p.videoId}','${p.channel}','${p.scheduledTime}')">togli</button>` : '<span></span>');
      return `<div class="calPost"><span class="calTime">${time}</span><span class="calChan">${p.channel}</span><span class="calText">${escapeHtml((p.text||p.videoName||"").slice(0,90))||"—"}</span>${st}</div>`;
    }).join("")}</div>`;
  }).join("");
}
function renderQueue(){
  const plan=state.plan||[];
  if(!plan.length){
    $("queueSummary").textContent="";
    $("queueList").innerHTML='Nessun post in coda. Vai in <button class="linkBtn" data-view-link="schedule">Programmazione</button> e crea il calendario.';
    return;
  }
  const c=plan.reduce((a,p)=>{a[p.status]=(a[p.status]||0)+1;return a},{});
  $("queueSummary").textContent=`${plan.length} post · programmati ${c.scheduled||0} · in bozza ${c.draft||0}${c.error?` · errori ${c.error}`:""}`;
  $("queueList").innerHTML=renderPlanByDay(plan,true);
}
function renderCalendarPreview(){
  const el=$("calendarPreview");
  if(!state.plan?.length){ el.className="stack empty"; el.textContent="Scegli una strategia e premi «Crea calendario» per vedere l'anteprima."; return; }
  el.className="stack";
  el.innerHTML=`<div class="queueSummary muted">${state.plan.length} post pianificati · strategia «${STRATEGIES[state.strategy].label}». Vai in <button class="linkBtn" data-view-link="queue">Coda</button> per inviarli al servizio collegato.</div>`+renderPlanByDay(state.plan,false);
}
window.removePlanPost=(videoId,channel,scheduledTime)=>{
  state.plan=state.plan.filter(p=>!(p.videoId===videoId&&p.channel===channel&&p.scheduledTime===scheduledTime));
  renderCalendarPreview(); renderQueue();
};

document.querySelectorAll(".nav").forEach(b=>b.onclick=()=>setView(b.dataset.view));
document.addEventListener("click",(e)=>{const b=e.target.closest("[data-view-link]");if(b){e.preventDefault();setView(b.dataset.viewLink);}});
$("goStudio").onclick=()=>setView("studio");
$("saveSetup").onclick=async()=>{
  const pwd=$("setupPassword").value.trim();
  if(!pwd) return alert("Scegli una password app.");
  const publisherKey=$("publisherKey").value.trim();
  if(!publisherKey) return alert("Inserisci la key del servizio di pubblicazione. Senza quella non posso caricare o programmare i video.");
  if(!$("codeReadyCheck").checked) return alert("Spunta il controllo sugli adapter backend: se cambi servizio, il codice delle API va adattato.");
  try{
    const r=await fetch(`${API_BASE}/api/setup`,{method:"POST",headers:{"content-type":"application/json","x-app-password":state.password},body:JSON.stringify({
      appPassword: pwd,
      publisherName: $("publisherName").value.trim(),
      writerName: $("writerName").value.trim(),
      transcriberName: $("transcriberName").value.trim(),
      hostingName: $("hostingName").value.trim(),
      anthropicApiKey: $("writerKey").value.trim(),
      blotatoApiKey: publisherKey,
      deepgramApiKey: $("transcriberKey").value.trim(),
      style: $("setupStyle").value
    })});
    if(!r.ok){
      const err=(await r.json().catch(()=>({}))).error;
      throw new Error(err==="already_configured" ? "App già configurata: serve la password attuale per riconfigurarla." : (err || "Setup non riuscito."));
    }
    state.password=pwd;
    localStorage.setItem("studio_password",state.password);
    await init();
  }catch(e){ alert(e.message); }
};
$("loginBtn").onclick=async()=>{state.password=$("loginPassword").value.trim();localStorage.setItem("studio_password",state.password);await init()};
$("files").onchange=async(e)=>{
  for(const file of [...e.target.files]){
    const item={id:crypto.randomUUID(),file,name:file.name,status:"upload in corso",mediaUrl:"",posts:[],formatFamily:"",priority:false,transcript:""};
    state.videos.push(item); renderAll();
    detectFormat(file).then(f=>{item.formatFamily=f;renderAll()});
    try{
      const up=await api("/upload-url",{method:"POST",body:JSON.stringify({filename:file.name})});
      const presignedUrl=up.presignedUrl||up.uploadUrl||up.url;
      const publicUrl=up.publicUrl||up.mediaUrl||up.fileUrl;
      if(!presignedUrl || !publicUrl) throw new Error("Risposta upload inattesa (manca URL di upload o URL pubblico).");
      const put=await fetch(presignedUrl,{method:"PUT",headers:{"content-type":file.type||"video/mp4"},body:file});
      if(!put.ok) throw new Error(`Upload video non riuscito (${put.status})`);
      item.mediaUrl=publicUrl; item.status="caricato";
      item.posts=genChannels(item).map(platform=>({platform,text:"",variants:[],variantIndex:0,mediaUrl:item.mediaUrl}));
      renderAll();
      if(state.hasDeepgram) await transcribeItem(item);
    }catch(err){item.status=`errore upload: ${err.message}`}
    renderAll();
  }
};
window.removeVideo=(id)=>{state.videos=state.videos.filter(v=>v.id!==id);renderAll()};
window.editPost=(videoId,index,value)=>{const v=state.videos.find(x=>x.id===videoId); if(v?.posts?.[index]) v.posts[index].text=value};
window.copyPost=async(videoId,index)=>{const v=state.videos.find(x=>x.id===videoId); await navigator.clipboard.writeText(v?.posts?.[index]?.text||"")};

$("applyBaseText").onclick=()=>{
  const raw=$("baseText").value.trim(); if(!raw) return alert("Scrivi prima un testo base.");
  for(const v of state.videos){ const chans=genChannels(v); if(chans.length) v.posts=chans.map(platform=>{const text=withHashtags(raw,platform);return {platform,text,variants:[text],variantIndex:0,mediaUrl:v.mediaUrl};}); }
  renderAll();
};
$("generateBtn").onclick=async()=>{
  for(const v of state.videos){
    v.status="genero testi…"; renderAll();
    try{
      const note=[$("batchNote").value,$("baseText").value?`Testo base da adattare: ${$("baseText").value}`:""].filter(Boolean).join("\n\n");
      const out=await api("/generate",{method:"POST",body:JSON.stringify({videoName:v.name,note,transcript:v.transcript||"",variants:state.variants,platforms:genChannels(v),style:$("liveStyle").value})});
      v.posts=(out.posts||[]).map(p=>{
        let variants=Array.isArray(p.variants)&&p.variants.length?p.variants:(p.text?[p.text]:[""]);
        variants=variants.map(t=>withHashtags(t,p.platform));
        return {platform:p.platform,variants,variantIndex:0,text:variants[0]||"",title:p.title||"",mediaUrl:v.mediaUrl};
      });
      v.status="pronto";
    }catch(err){v.status=`errore generatore testi: ${err.message}`}
    renderAll();
  }
};
// ---- Strategie + calendario ----
document.querySelectorAll(".strategyCard").forEach(b=>b.onclick=()=>{
  state.strategy=b.dataset.strategy;
  document.querySelectorAll(".strategyCard").forEach(x=>x.classList.toggle("on",x===b));
});
$("makeCalendar").onclick=()=>{
  const ready=state.videos.filter(v=>v.mediaUrl);
  if(!ready.length) return alert("Carica almeno un video (con upload completato) prima di creare il calendario.");
  const start=$("startDate").value ? new Date($("startDate").value+"T00:00:00") : new Date(Date.now()+3600000);
  state.plan=buildCalendar(ready,state.strategy,platforms(),{startFrom:start});
  state.plannedVideoIds=new Set(ready.map(v=>v.id));
  renderCalendarPreview(); renderQueue();
  if(!state.plan.length) alert("Nessun post pianificato: controlla i canali attivi nelle Impostazioni e i formati dei video.");
};
$("appendCalendar").onclick=()=>{
  if(!state.plan?.length) return alert("Prima crea un calendario, poi potrai accodare i video nuovi.");
  const done=state.plannedVideoIds||new Set();
  const fresh=state.videos.filter(v=>v.mediaUrl && !done.has(v.id));
  if(!fresh.length) return alert("Nessun video nuovo da accodare.");
  const added=buildCalendar(fresh,state.strategy,platforms(),{seedPlan:state.plan});
  state.plan=[...state.plan,...added].sort((a,b)=>new Date(a.scheduledTime)-new Date(b.scheduledTime));
  fresh.forEach(v=>done.add(v.id)); state.plannedVideoIds=done;
  renderCalendarPreview(); renderQueue();
  alert(`Accodati ${fresh.length} video (${added.length} post) in fondo alla coda.`);
};

// ---- Invio a blocchi (browser-driven) ----
const CHUNK_SIZE=5, CHUNK_PAUSE_MS=12000;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let publishing=false;
async function runPublish(immediate){
  const pending=(state.plan||[]).filter(p=>p.status==="draft"||p.status==="error");
  if(!pending.length) return alert("Non ci sono post da inviare. Crea il calendario in Programmazione, oppure usa «Pubblica subito».");
  if(publishing) return;
  const verb=immediate?"pubblicare subito":"programmare";
  if(!confirm(`Sto per ${verb} ${pending.length} post sul servizio collegato, a blocchi. Tieni aperta questa scheda finché finisce. Procedo?`)) return;
  publishing=true;
  pending.forEach(p=>p.status="draft");
  const btn=$("publishBtn"); btn.disabled=true; const label=btn.textContent; btn.textContent="Invio in corso…";
  $("progressWrap").classList.remove("hidden");
  const total=pending.length; let done=0, ok=0, err=0, capped=false;
  const chunks=[]; for(let i=0;i<pending.length;i+=CHUNK_SIZE) chunks.push(pending.slice(i,i+CHUNK_SIZE));
  try{
    for(let c=0;c<chunks.length;c++){
      const group=chunks[c];
      group.forEach(p=>p.status="sending"); renderQueue();
      const payload=group.map(p=>({platform:p.channel,text:withHashtags(p.text,p.channel),mediaUrl:p.mediaUrl,scheduledTime:immediate?"":p.scheduledTime,title:p.title}));
      let results;
      try{ const out=await api("/publish",{method:"POST",body:JSON.stringify({posts:payload})}); results=out.results||[]; }
      catch(e){ results=group.map(()=>({ok:false,error:e.message})); }
      group.forEach((p,idx)=>{
        const r=results[idx]||{ok:false,error:"nessuna risposta"};
        if(r.ok){ p.status="scheduled"; p.submissionId=r.submissionId||""; ok++; }
        else{ p.status="error"; p.error=r.error||"errore"; err++; if(/maximum number of scheduled posts/i.test(r.error||"")) capped=true; }
        done++;
      });
      $("progressFill").style.width=Math.round(done/total*100)+"%";
      $("progressText").textContent=`${done}/${total} · ${immediate?"pubblicati":"programmati"} ${ok}${err?` · errori ${err}`:""}`;
      renderQueue();
      if(capped) break;
      if(c<chunks.length-1) await sleep(CHUNK_PAUSE_MS);
    }
    if(capped) alert(`Raggiunto il limite del tuo piano. Inviati ${ok}, rimasti ${total-ok} in bozza. Riprova più tardi o libera spazio.`);
    else alert(`Fatto! ${immediate?"Pubblicati":"Programmati"} ${ok} post${err?`, ${err} con errore (restano in coda, puoi ripremere per riprovare)`:""}.`);
  }catch(e){ alert(`Invio interrotto: ${e.message}`); }
  finally{ publishing=false; btn.disabled=false; btn.textContent=label; renderQueue(); }
}
$("publishBtn").onclick=()=>runPublish(false);
// ---- Pubblica subito (senza calendario): manda ora tutti i post pronti ----
function buildImmediatePlan(){
  const out=[];
  for(const v of state.videos){
    if(!v.mediaUrl) continue;
    for(const channel of genChannels(v)){
      const post=(v.posts||[]).find(p=>p.platform===channel);
      const text=(post?.text||"").trim();
      if(!text) continue;
      out.push({videoId:v.id,videoName:v.name,channel,scheduledTime:"",text,title:post?.title||"",mediaUrl:v.mediaUrl,status:"draft"});
    }
  }
  return out;
}
$("publishNowBtn").onclick=async()=>{
  const plan=buildImmediatePlan();
  if(!plan.length) return alert("Niente da pubblicare: genera o scrivi i testi dei video nello Studio testi e scegli almeno un canale.");
  state.plan=plan;
  state.plannedVideoIds=new Set(state.videos.filter(v=>v.mediaUrl).map(v=>v.id));
  setView("queue");
  await runPublish(true);
};
$("publishTodayBtn").onclick=async()=>{
  const t=$("publishTodayTime").value; if(!t) return alert("Scegli un orario di oggi.");
  const [h,m]=t.split(":").map(Number);
  const when=new Date(); when.setHours(h,m,0,0);
  if(when.getTime()<=Date.now()+60000) return alert("Scegli un orario di oggi ancora da venire (almeno tra qualche minuto).");
  const plan=buildImmediatePlan();
  if(!plan.length) return alert("Niente da pubblicare: genera o scrivi i testi dei video nello Studio testi e scegli almeno un canale.");
  const iso=when.toISOString();
  plan.forEach(p=>p.scheduledTime=iso);
  state.plan=plan;
  state.plannedVideoIds=new Set(state.videos.filter(v=>v.mediaUrl).map(v=>v.id));
  setView("queue");
  await runPublish(false);
};
// ---- Fasce orarie ----
document.querySelectorAll("#bands input").forEach(b=>b.onchange=()=>{
  state.bands=[...document.querySelectorAll("#bands input:checked")].map(x=>x.dataset.band);
  if(!state.bands.length) state.bands=[...DEFAULT_BANDS];
});
$("accountsBtn").onclick=async()=>{const out=await api("/accounts",{method:"POST",body:"{}"});renderAccounts(out.accounts)};
$("diagnosticsBtn").onclick=async()=>{
  const lines=["Diagnostica Studio Autopilot","----------------------------"];
  try{const s=await api("/status");lines.push(`Pubblicazione: ${s.hasBlotato?"collegata":"manca"}`);lines.push(`Generatore testi: ${s.hasClaude?"collegato":"non collegato"}`);lines.push(`Modello/API: ${s.anthropicModel || "da configurare"}`);lines.push(`Trascrizione: ${s.hasDeepgram?"collegata":"opzionale/non collegata"}`);lines.push(`Account salvati: ${Object.keys(s.accounts||{}).join(", ")||"nessuno"}`)}catch(e){lines.push(`Status errore: ${e.message}`)}
  try{const acc=await api("/accounts",{method:"POST",body:"{}"});lines.push(`Account fetch: ${Object.keys(acc.accounts||{}).join(", ")||"nessuno"}`)}catch(e){lines.push(`Account errore: ${e.message}`)}
  $("diagnostics").classList.remove("hidden");$("diagnostics").textContent=lines.join("\n");
};
$("styleFile").onchange=async(e)=>{const file=e.target.files?.[0]; if(file) $("liveStyle").value=await file.text()};
$("saveLiveStyle").onclick=async()=>{await api("/settings",{method:"PATCH",body:JSON.stringify({style:$("liveStyle").value})});alert("Stile salvato.")};

// ---- Varianti, trascrizione, regole editoriali ----
document.querySelectorAll("#variantPick button").forEach(b=>b.onclick=()=>{
  state.variants=+b.dataset.variants;
  document.querySelectorAll("#variantPick button").forEach(x=>x.classList.toggle("on",x===b));
});
$("saveDeepgram").onclick=async()=>{
  const key=$("deepgramKey").value.trim(); if(!key) return alert("Incolla la key del servizio di trascrizione.");
  try{
    const r=await api("/settings",{method:"PATCH",body:JSON.stringify({deepgramApiKey:key})});
    state.hasDeepgram=!!r.hasDeepgram; $("deepgramKey").value="";
    $("deepgramState").textContent="Trascrizione collegata: i video vengono trascritti in automatico al caricamento.";
    alert("Key trascrizione salvata.");
  }catch(e){ alert(e.message); }
};
function updateExamplesMeta(){
  const txt=$("styleExamples").value||"";
  const chars=txt.length;
  const tokens=Math.round(chars/4);        // stima grezza
  const pages=Math.max(0,Math.round(chars/1800)); // ~1800 caratteri a pagina
  const blocks=txt.trim()?txt.split(/\n\s*\n/).filter(b=>b.trim()).length:0;
  $("examplesMeta").textContent=chars?`${blocks} esempi · ${chars.toLocaleString("it-IT")} caratteri · ~${tokens.toLocaleString("it-IT")} token · ~${pages} pag.`:"vuota";
}
$("examplesFile").onchange=async(e)=>{
  const files=[...(e.target.files||[])]; if(!files.length) return;
  const texts=[];
  for(const f of files){ try{ texts.push(await f.text()); }catch{} }
  const add=texts.filter(Boolean).join("\n\n");
  if(add) $("styleExamples").value=($("styleExamples").value ? $("styleExamples").value+"\n\n" : "")+add;
  e.target.value=""; // permette di ricaricare lo stesso file
  updateExamplesMeta();
};
$("clearExamples").onclick=()=>{ if(confirm("Svuotare tutti gli esempi?")){ $("styleExamples").value=""; updateExamplesMeta(); } };
$("styleExamples").addEventListener("input",updateExamplesMeta);
$("saveHashtags").onclick=()=>{
  state.hashtags=$("fixedHashtags").value.trim();
  localStorage.setItem("studio_hashtags",state.hashtags);
  alert(state.hashtags?"Hashtag salvati: verranno aggiunti in fondo a ogni post.":"Hashtag rimossi: nessun hashtag fisso verrà aggiunto.");
};
$("saveBrand").onclick=async()=>{
  try{
    await api("/settings",{method:"PATCH",body:JSON.stringify({brandPrompt:$("brandPrompt").value,styleExamples:$("styleExamples").value})});
    alert("Regole ed esempi salvati. Il generatore testi ne terrà conto nelle prossime generazioni.");
  }catch(e){ alert(e.message); }
};
init();
