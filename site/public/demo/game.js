/* TOKENTOWN — cidade de pixel que cresce (sem parar) com os tokens da IA.
   No app (Electron) lê o USO REAL do Claude Code via window.tt.onUsage e devolve o
   retrato da cidade ao main via window.tt.sendCity. No navegador (sem window.tt)
   simula um fluxo calmo só pra preview.

   Camadas de jogo (todas CALMAS, zero pressão):
   - TEMPORADAS de 28 dias (calendário global); tokens acumulam na temporada.
   - MARCOS ambientais: 6 marcos que se desbloqueiam sozinhos e enfeitam a cena.
   - CONSTRUÇÃO AUTOMÁTICA: a cada 150k tokens a cidade ganha, SOZINHA, uma estrutura
     especial (sorteio ponderado). O backlog acumulado é drenado devagar (1 a cada
     ~4,5s) pra cidade crescer visivelmente, não estourar de uma vez.
   - POPULAÇÃO: número de moradores DERIVADO da cidade (cada prédio/estrutura abriga
     gente). Substitui "moradores" (subagentes) no display; subagentes seguem contados
     internamente e vão pro placar como `residents`.
   - DISTRITOS/ERA: a cada ~2M tokens a cidade muda sutilmente de era (tons/altura).
   - VONTADES: desejos carinhosos dos moradores, cumpridos sozinhos pelos auto-builds.
   - RECREIO: joguinho de plataforma (só enquanto o agente está AO VIVO). */
(function () {
  "use strict";
  var reduce = matchMedia('(prefers-reduced-motion:reduce)').matches;
  function clamp01(x){ return x < 0 ? 0 : x > 1 ? 1 : x; }
  function ss(x){ x = clamp01(x); return x*x*(3 - 2*x); }
  function hx(h){ h = h.replace('#',''); return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; }
  function mix(a,b,t){ var A=hx(a),B=hx(b);
    return 'rgb('+((A[0]+(B[0]-A[0])*t)|0)+','+((A[1]+(B[1]-A[1])*t)|0)+','+((A[2]+(B[2]-A[2])*t)|0)+')'; }

  // ---------- temporadas (MESMA fórmula do main.js e do placar web) ----------
  var SEASON_EPOCH = Date.UTC(2026, 6, 1);   // 01/07/2026 00:00 UTC (nascimento do jogo)
  var SEASON_MS = 28 * 86400000;             // 28 dias
  function localSeasonId(){ return Math.floor((Date.now() - SEASON_EPOCH) / SEASON_MS); }
  function localDaysLeft(){ var end = SEASON_EPOCH + (localSeasonId()+1)*SEASON_MS;
    return Math.max(0, Math.ceil((end - Date.now())/86400000)); }
  var seasonId = null, daysLeft = null;

  // ---------- fonte de tokens ----------
  var SIM_BURN = 1600;            // tokens/seg simulados (só no navegador) — ritmo VIVO na vitrine
  var TOK_PER_BUILD_SIM  = 4000;  // ~1 prédio a cada ~2,5s no preview (= TOK_PER_BUILD_SIM/SIM_BURN)
  var TOK_PER_BUILD_REAL = 6000;  // um prédio a cada ~6k tokens reais gerados
  var SIM_PRICE_PER_MTOK = 6;     // preço médio (US$/1M) só pro custo simulado do preview
  var SPECIAL_STEP = 150000;      // a cada 150k tokens da temporada -> 1 estrutura especial
  var ERA_STEP = 2000000;         // a cada ~2M tokens -> a cidade muda de era/bairro
  // agState: 'live' (agente trabalhando) | 'decision' (esperando a MEL autorizar/responder)
  // | 'idle' (turno fechado de verdade). Vem do main via IPC (payload.state); payload.live
  // segue existindo como booleano de compat (main antigo). liveNow = (agState === 'live').
  var real = false, realTotal = 0, liveNow = true, agState = 'live', simTokens = 0, residents = 0, realCost = 0;
  function tokens(){ return real ? realTotal : simTokens; }
  function tokPerBuild(){ return real ? TOK_PER_BUILD_REAL : TOK_PER_BUILD_SIM; }
  function era(){ return Math.floor(tokens() / ERA_STEP); }

  var SUF = ['','k','M','B','T'];
  // en-US (demo): decimal PONTO, casando com o site do placar. >=1M -> sempre
  // 1 casa (27.2M; 1.3M), some ".0" (2M). milhares -> 1 casa só quando <10 (4.7k).
  function fmt(n){ if(!(n>=1000)) return Math.floor(n>0?n:0).toString();
    var t=0, x=n; while(x>=1000 && t<SUF.length-1){ x/=1000; t++; }
    var s = (t>=2) ? x.toFixed(1).replace(/\.0$/,'')
                   : (x<10 ? x.toFixed(1) : String(Math.floor(x)));
    return s + SUF[t]; }
  // população: en-US com ponto decimal (ex.: 12.4k). Uma casa quando < 100 no sufixo.
  function fmtPop(n){ n = Math.max(0, Math.floor(n||0)); if(n<1000) return String(n);
    var t=0, x=n; while(x>=1000 && t<SUF.length-1){ x/=1000; t++; }
    var s = (x<100) ? x.toFixed(1) : String(Math.round(x));
    if(s.slice(-2)==='.0') s = s.slice(0,-2);
    return s + SUF[t]; }
  function fmtCost(v){ return '≈ $' + (v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }

  var $ = function(id){ return document.getElementById(id); };
  var elTok=$('tok'), elBuilds=$('builds'), elPop=$('pop'),
      elLive=$('live'), elLiveTxt=$('liveTxt'), elCost=$('cost'),
      elSeason=$('season'), elWish=$('wish'), elNote=$('note'), elRecreio=$('recreio');
  // LED/texto do topo em 3 estados: ao vivo (teal), sua decisão (âmbar discreto —
  // o agente está esperando a Mel autorizar/responder), ocioso (apagado).
  function setState(st){
    if(elLive){ elLive.classList.toggle('off', st==='idle'); elLive.classList.toggle('decision', st==='decision'); }
    if(elLiveTxt) elLiveTxt.textContent = st==='live' ? 'agent live' : (st==='decision' ? 'your call' : 'idle');
    // botão do recreio só aparece quando o agente está AO VIVO (ou já jogando).
    if(elRecreio) elRecreio.hidden = !(st==='live' || mode==='recreio');
  }

  // ---------- canvas ----------
  var cv = $('scene'), ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  var W=256, H=144, BASE=112; // linha d'água / base dos prédios
  function R(x,y,w,h,c){ ctx.fillStyle=c; ctx.fillRect(x|0,y|0,w|0,h|0); }

  // SKY_D = DIA de verdade (topo azul-claro suave -> horizonte quente). Antes o "dia"
  // era uma paleta de fim-de-tarde (roxo/âmbar) que nunca clareava — o meio do ciclo
  // (mix dia↔noite) já entrega o pôr-do-sol; os extremos agora são dia CLARO e noite cheia.
  var SKY_D=['#8ec6ea','#a3d0ea','#bcd8e6','#d2dde2','#e6dcc8','#f2d3a2','#f7e2ac'];
  var SKY_N=['#12112e','#1a1638','#241d44','#33254f','#45305c','#5c3b60','#7a4c62'];
  // paleta de CORPO ampliada (mais variedade de fachada dentro do tom calmo noturno).
  var BODY=['#3b3450','#463a5c','#524565','#5c4a62','#6a4e64','#413a58','#4a4368','#57406a','#623f5e','#3f4a60'];
  var ROOF=['#7a4a63','#864f5e','#6b4a70','#8a5a5a','#734867','#7d5a4e','#5a6a7a','#8a6a4a'];

  // ---------- PRNG semeado (mulberry32) — deixa o layout da cidade REPRODUTÍVEL ----------
  function seededRand(seed){ // devolve uma função rng() determinística
    return function(){ seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var x = Math.imul(seed ^ (seed>>>15), 1 | seed);
      x = (x + Math.imul(x ^ (x>>>7), 61 | x)) ^ x;
      return ((x ^ (x>>>14)) >>> 0) / 4294967296; };
  }

  // ---------- estado persistido por TEMPORADA (localStorage: tt-city-s{N}) ----------
  function defaultStore(){
    return {
      seed: (Math.random()*0xffffffff)>>>0, // semente da cidade (layout reprodutível)
      marcos: {},     // id do marco -> true (desbloqueado)
      specials: [],   // estruturas especiais já erguidas (auto-build), em ordem
      wish: null,     // vontade atual {id,text} ou null
      wishDone: {}    // vontades já cumpridas (não repetem na temporada)
    };
  }
  var store = defaultStore();
  function storeKey(){ return 'tt-city-s' + seasonId; }
  function loadStore(){
    try { var raw = localStorage.getItem(storeKey());
      if(raw){ return Object.assign(defaultStore(), JSON.parse(raw)); } } catch(e){}
    return defaultStore();
  }
  function saveStore(){ try { localStorage.setItem(storeKey(), JSON.stringify(store)); } catch(e){} }

  // ---------- catálogo de estruturas especiais (13 tipos) ----------
  // ids ASCII (viram chaves do retrato da cidade -> placar). Rótulos com acento à parte.
  var TYPE_LABEL = { parque:'parque', torre:'torre', cais:'cais', biblioteca:'biblioteca',
    mirante:'mirante', praca:'praça', estacao:'estação', mercado:'mercado', coreto:'coreto',
    museu:'museu', ponte:'ponte', jardim:'jardim vertical', chamine:'chaminé' };
  var SPECIAL_DIM = {
    parque:{w:26,h:18}, torre:{w:16,h:78}, cais:{w:24,h:12},
    biblioteca:{w:24,h:34}, mirante:{w:16,h:44}, praca:{w:26,h:12},
    estacao:{w:32,h:24}, mercado:{w:26,h:22}, coreto:{w:18,h:16},
    museu:{w:28,h:32}, ponte:{w:34,h:10}, jardim:{w:16,h:42}, chamine:{w:18,h:54}
  };
  // população que cada especial abriga + bônus de "qualidade" (parque/praça atraem gente).
  var SPECIAL_POP = { parque:0, praca:0, cais:8, torre:120, biblioteca:22, mirante:6,
    estacao:40, mercado:30, coreto:4, museu:26, ponte:0, jardim:12, chamine:10 };
  var SPECIAL_QUALITY = { parque:44, praca:26, jardim:18, coreto:8 };
  // nota carinhosa por tipo (some sozinha; no máx 1 a cada ~20s — não uma por prédio).
  var TYPE_NOTE = {
    parque:'⟡ um parque novo abriu na cidade', torre:'⟡ uma torre nova rasgou o céu',
    cais:'⟡ um novo cais surgiu na orla', biblioteca:'⟡ uma biblioteca abriu as portas',
    mirante:'⟡ um mirante novo na orla', praca:'⟡ uma praça nova ganhou vida',
    estacao:'⟡ a estação nova recebeu o primeiro trem', mercado:'⟡ um mercado novo abriu as bancas',
    coreto:'⟡ um coreto novo apareceu na praça', museu:'⟡ um museu novo abriu a exposição',
    ponte:'⟡ uma ponte nova cruzou a água', jardim:'⟡ um jardim vertical floresceu na fachada',
    chamine:'⟡ uma chaminé nova fuma ao longe'
  };
  // pool ponderado (comuns aparecem mais; torre é rara).
  var POOL = [ ['parque',12],['praca',11],['mercado',10],['cais',9],['coreto',8],
    ['biblioteca',7],['mirante',7],['jardim',6],['museu',5],['estacao',5],
    ['ponte',4],['chamine',4],['torre',3] ];
  var POOL_TOTAL = 0; for(var _p=0;_p<POOL.length;_p++) POOL_TOTAL += POOL[_p][1];
  // sorteio DETERMINÍSTICO pelo índice k (mesma cidade -> mesma sequência de especiais).
  function pickSpecialType(k){
    var x = seededRand((store.seed ^ Math.imul(k+1, 0x27d4eb2f)) >>> 0)() * POOL_TOTAL, acc=0;
    for(var i=0;i<POOL.length;i++){ acc += POOL[i][1]; if(x < acc) return POOL[i][0]; }
    return POOL[POOL.length-1][0];
  }

  // ---------- MARCOS ambientais (desbloqueiam sozinhos) ----------
  // kind 'tok' compara tokens; 'pop' compara população derivada da cidade.
  var MARCOS = [
    { id:'garden',     kind:'tok', at:100000,  note:'⟡ um jardim floresceu na orla' },
    { id:'ferry',      kind:'tok', at:300000,  note:'⟡ uma balsa começou a cruzar a água' },
    { id:'lighthouse', kind:'tok', at:1000000, note:'⟡ o farol chegou' },
    { id:'towers',     kind:'tok', at:3000000, note:'⟡ o bairro das torres começou a subir' },
    { id:'festival',   kind:'pop', at:4000,    note:'⟡ lanternas de festival no cais' },
    { id:'fireworks',  kind:'pop', at:120000,  note:'⟡ fogos passaram a enfeitar a noite' }
  ];

  // ---------- VONTADES dos moradores (cumpridas sozinhas pelos auto-builds) ----------
  function hasSpecial(t){ return store.specials.indexOf(t) >= 0; }
  var WISHES = [
    { id:'green',   text:'os moradores queriam um respiro verde na cidade…',
      show:function(){ return builtNormals>=8 && !hasSpecial('parque') && !hasSpecial('praca'); },
      done:function(){ return hasSpecial('parque') || hasSpecial('praca'); } },
    { id:'library', text:'andam sonhando com uma biblioteca…',
      show:function(){ return population>=2000 && !hasSpecial('biblioteca'); },
      done:function(){ return hasSpecial('biblioteca'); } },
    { id:'pier',    text:'queriam ver o cais iluminado à noite…',
      show:function(){ return hasSpecial('cais') && !store.marcos.festival; },
      done:function(){ return !!store.marcos.festival; } }
  ];

  // ---------- cidade (prédios normais + estruturas especiais) ----------
  var city=[], frontier=2, builtNormals=0, camX=0, snapCam=false;

  // prédio NORMAL determinístico pelo índice + era: mesmo seed+i+era -> mesmo prédio.
  function genNormal(i){
    var e = era();
    var r = seededRand((store.seed ^ Math.imul(i+1, 0x9e3779b9)) >>> 0);
    var w = 12 + Math.floor(r()*16);                 // 12-27
    var wave = Math.sin(i*0.7)*10;
    var h = 24 + Math.floor(r()*34) + Math.max(0, wave) + Math.min(e,8); // era adensa/eleva
    var landmark = (i % 9 === 4);
    if(landmark){ h = Math.max(h,58); w = Math.max(w,16); }
    if(store.marcos && store.marcos.towers) h += 14; // marco: bairro das torres
    var styles = ['flat','parapet','peaked','antenna','watertank','flat','parapet','flat'];
    var roofStyle = styles[Math.floor(r()*styles.length)];
    var balcony = !landmark && r()<0.30;
    var sign = !landmark && r()<0.14;
    var tank = roofStyle!=='watertank' && !landmark && r()<0.12;
    var bi = (i + e) % BODY.length;                  // era desloca o tom do corpo
    var win=[], cols=Math.max(1,Math.floor((w-4)/5)), rows=Math.max(1,Math.floor((h-10)/6));
    for(var rr=0;rr<rows;rr++) for(var c=0;c<cols;c++) win.push(makeWin(r, 3+c*5, 5+rr*6));
    // ---- PERSONALIDADE (determinística por prédio, PRÉ-COMPUTADA — nada recalculado por frame).
    // Stream de rand PRÓPRIA (não mexe no r() da arte -> layout/janelas acesas seguem idênticos).
    // REGRA DE OURO: detalhe em CACHOS — só ~1 em cada 3 prédios é "o detalhado"; os vizinhos
    // ficam simples (sorteio por ÍNDICE garante que dois vizinhos nunca sejam ambos detalhados).
    var dr = seededRand((store.seed ^ Math.imul(i+1, 0xc2b2ae35)) >>> 0);
    var detailed = !landmark && (((i % 3) + 3) % 3 === (store.seed % 3));
    var wsr = dr();
    var winShape = wsr < 0.62 ? 'std' : wsr < 0.81 ? 'narrow' : 'square'; // 2x3 / 1x2 estreita / 2x2 quadrada
    var persona = 'comum', pr2 = dr();
    if(detailed){ persona = pr2 < 0.30 ? 'biblioteca' : pr2 < 0.55 ? 'mercado' : 'comum'; }
    if(persona === 'biblioteca') winShape = 'arch';                        // biblioteca -> janelas arqueadas
    if(detailed && persona !== 'mercado'){                                 // ar-condicionado em ~10% das janelas
      for(var wi=0; wi<win.length; wi++){ if(((wi*7 + i*13) % 10) === 0) win[wi].ac = true; } }
    return { kind:'normal', idx:i, wx:0, w:w, h:h, gap:(w + 1 + Math.floor(r()*3)),
             body:BODY[bi], roof:ROOF[(i + (e>>1)) % ROOF.length], win:win,
             landmark:landmark, roofStyle:roofStyle, balcony:balcony, sign:sign, tank:tank, rise:0,
             persona:persona, winShape:winShape, detailed:detailed };
  }
  function genSpecial(type){
    var d = SPECIAL_DIM[type] || {w:20,h:20};
    return { kind:'special', type:type, wx:0, w:d.w, h:d.h, rise:0 };
  }
  // reconstrói só a CAUDA visível (não gera milhares de prédios ao retomar temporada).
  function rebuildCity(){
    city = []; frontier = 2; builtNormals = 0;
    var target = 2 + Math.floor(tokens()/tokPerBuild());
    builtNormals = Math.max(0, target - 26); // materializa ~26 prédios recentes
    var guard = 0;
    while((builtNormals < target || frontier < W*0.55) && guard < 44){
      var b = genNormal(builtNormals); b.wx = frontier; b.rise = 1; city.push(b);
      frontier += b.gap; builtNormals++; guard++;
    }
    builtNormals = Math.max(builtNormals, target);
    // recoloca as ÚLTIMAS especiais na orla (as antigas já rolaram pra história da cidade).
    var recent = store.specials.slice(-4);
    for(var i=0;i<recent.length;i++){ var s = genSpecial(recent[i]); s.wx = frontier; s.rise = 1;
      city.push(s); frontier += s.w + 2; }
    popNormals = 0; popNormalIdx = 0; // pop de normais recomeça a soma no próximo tick
    markerWX = {};                    // marcos de chão recolocados na ponta do frontier reconstruído
    snapCam = true;
  }
  // ergue AGORA uma estrutura especial na fronteira (à direita) e registra no store.
  function pushSpecial(type){
    var s = genSpecial(type); s.wx = frontier; city.push(s);
    frontier += s.w + 2; store.specials.push(type);
  }

  // ---------- POPULAÇÃO derivada da cidade (determinística) ----------
  var population = 0, popNormals = 0, popNormalIdx = 0;
  // pop de UM prédio normal — stream de rand própria (independe da arte/era p/ ser
  // estável e somável de forma incremental). casa 4-12, prédio 14-42, torre 60-150.
  function popForNormal(i){
    var r = seededRand((store.seed ^ Math.imul(i+1, 0x85ebca6b)) >>> 0);
    var kind = (i % 9 === 4) ? 'tower' : (r() < 0.42 ? 'tall' : 'low');
    if(kind==='tower') return 60 + Math.floor(r()*90);
    if(kind==='tall')  return 14 + Math.floor(r()*28);
    return 4 + Math.floor(r()*8);
  }
  function accruePop(){ while(popNormalIdx < builtNormals){ popNormals += popForNormal(popNormalIdx); popNormalIdx++; } }
  function recomputePop(){
    accruePop();
    var ps = 0;
    for(var i=0;i<store.specials.length;i++){ var t=store.specials[i];
      ps += (SPECIAL_POP[t]||0) + (SPECIAL_QUALITY[t]||0); }
    population = popNormals + ps;
  }

  // ---------- partículas / elementos transitórios ----------
  var LAMPS=[20,72,124,176,228], TREES=[46,150,206];
  var BACKPAT=[]; for(var q=0;q<48;q++) BACKPAT.push(10 + Math.floor(Math.random()*18));
  var dust=[], motes=[], hearts=[], fireworks=[];
  var birds=[{x:200,y:30},{x:212,y:34}];
  var clouds=[{x:40,y:22,w:26,s:0.06},{x:170,y:14,w:20,s:0.04}];
  var ferryX = -24;

  // ---------- notas de marco / construção (some sozinha em ~8s) ----------
  var noteQueue=[], noteUntil=0, lastNote=0;
  function showNote(txt){ noteQueue.push(txt); }
  function maybeNote(now, type){
    if(now - lastNote < 20000) return;          // no máx 1 nota a cada ~20s
    lastNote = now;
    showNote(TYPE_NOTE[type] || ('⟡ ' + (TYPE_LABEL[type]||type) + ' novo na orla'));
  }

  // ---------- recompensa visual (coraçõezinhos subindo ~2s) ----------
  function spawnReward(x){ var cx=(x==null)?128:x;
    for(var i=0;i<6;i++) hearts.push({ x:cx + (Math.random()*30-15), y:BASE-10, age:0, life:38+Math.random()*22 }); }

  // ---------- CONSTRUÇÃO AUTOMÁTICA: drena o backlog devagar (1 a cada ~4,5s) ----------
  var DRAIN_MS = 4500, lastDrain = -99999;
  function drainSpecials(now){
    var owed = Math.floor(tokens() / SPECIAL_STEP);
    if(store.specials.length >= owed) return;      // nada devendo
    if(now - lastDrain < DRAIN_MS) return;         // ainda no intervalo do gotejo
    lastDrain = now;
    var type = pickSpecialType(store.specials.length);
    pushSpecial(type);            // ergue na fronteira + registra no store
    saveStore();
    spawnReward();                // luzinhas discretas
    maybeNote(now, type);         // nota rara
  }

  // ---------- marcos: desbloqueio automático ----------
  function evalMarcos(){
    for(var i=0;i<MARCOS.length;i++){ var m=MARCOS[i]; if(store.marcos[m.id]) continue;
      var hit = (m.kind==='tok') ? tokens()>=m.at : (m.kind==='pop' ? population>=m.at : residents>=m.at);
      if(hit){ store.marcos[m.id]=true; saveStore(); showNote(m.note);
        if(m.id==='festival'||m.id==='fireworks'||m.id==='lighthouse') spawnReward(); }
    }
  }
  // ---------- vontades: mostra uma; cumpre sozinha quando a condição se resolve ----------
  function evalWishes(){
    if(store.wish){
      for(var i=0;i<WISHES.length;i++){ if(WISHES[i].id===store.wish.id){
        if(WISHES[i].done()){ store.wishDone[store.wish.id]=true; store.wish=null; spawnReward(); saveStore(); }
        return; } }
      return;
    }
    for(var j=0;j<WISHES.length;j++){ var wd=WISHES[j];
      if(store.wishDone[wd.id]) continue;
      if(wd.show()){ store.wish={ id:wd.id, text:wd.text }; saveStore(); break; }
    }
  }

  // ---------- retrato da cidade pro placar (via IPC tt.sendCity) ----------
  function marcosList(){ var a=[]; for(var id in store.marcos){ if(store.marcos[id]) a.push(id); } return a; }
  function cityTypes(){ var m={}; for(var i=0;i<store.specials.length;i++){ var t=store.specials[i]; m[t]=(m[t]||0)+1; } return m; }
  function citySnapshot(){
    return { v:1, seed:(store.seed>>>0), buildings:builtNormals, pop:Math.round(population),
             types:cityTypes(), marcos:marcosList(), era:era() };
  }
  var lastCitySig='', lastCitySent=0;
  function maybeSendCity(now){
    if(!(window.tt && window.tt.sendCity)) return;
    var sig = builtNormals + '|' + store.specials.length + '|' + era() + '|' + marcosList().length;
    if((sig!==lastCitySig && now-lastCitySent>2000) || now-lastCitySent>60000){
      lastCitySig = sig; lastCitySent = now;
      try { window.tt.sendCity(citySnapshot()); } catch(e){}
    }
  }

  // ---------- HUD (temporada / vontade / nota) ----------
  function updateHud(now){
    if(elSeason && seasonId!=null)
      elSeason.textContent = 'temporada ' + seasonId + ' · faltam ' + (daysLeft==null?'—':daysLeft) + 'd';
    if(elWish){ if(store.wish){ elWish.textContent = store.wish.text; elWish.hidden=false; } else elWish.hidden=true; }
    if(elNote){
      if(now < noteUntil){ /* nota ativa */ }
      else { if(elNote.textContent){ elNote.hidden=true; elNote.textContent=''; }
        if(noteQueue.length){ elNote.textContent = noteQueue.shift(); elNote.hidden=false; noteUntil = now + 8000; } }
    }
  }

  // ---------- temporada: iniciar / trocar suavemente ----------
  function initSeason(sid){
    seasonId = sid; store = loadStore();
    dust=[]; motes=[]; hearts=[]; fireworks=[]; ferryX=-24; noteQueue=[]; noteUntil=0;
    lastDrain=-99999; lastNote=0; lastCitySig=''; lastCitySent=0;
    mode='city'; rc=null;   // nunca inicia numa temporada dentro do recreio
    saveStore();            // trava a semente da temporada já no início (layout persiste)
    rebuildCity();
    recomputePop();
  }
  var fadeDir=0, fadeT=0, pendingSeason=null; // virada de temporada em runtime -> despedida calma
  function beginSeasonFarewell(sid){ if(fadeDir) return; pendingSeason=sid; fadeDir=1; fadeT=0; }

  // ---------- entrada de dados ----------
  if (window.tt && window.tt.onUsage) {
    real = true; liveNow = false; agState = 'idle'; // até o 1º poll chegar, mostra ocioso
    window.tt.onUsage(function (d) {
      realTotal = d.total || 0; realCost = d.cost || 0;
      agState = d.state || (d.live ? 'live' : 'idle'); // compat: main antigo só manda o booleano
      liveNow = (agState === 'live');
      var nr = d.residents || 0;
      if (nr > residents && residents > 0) {              // um subagente novo chegou
        for (var i = 0; i < Math.min(4, nr - residents); i++)
          motes.push({ x: 40 + Math.random()*170, y: BASE - 4, age: 0, life: 55 + Math.random()*35 });
      }
      residents = nr;
      if (d.daysLeft != null) daysLeft = d.daysLeft;
      var sid = (d.seasonId != null) ? d.seasonId : localSeasonId();
      if (seasonId === null) initSeason(sid);
      else if (sid !== seasonId) {                            // virou a temporada com o app aberto
        // a despedida (fade) e o initSeason só rodam em draw(), que NÃO roda no
        // recreio. Sai do recreio pra a virada acontecer na hora (a cidade inteira,
        // e a seed do próprio recreio, estão sendo trocadas) — senão a temporada
        // ficaria presa mostrando "temporada VELHA · faltam Nd (novo)".
        if (mode === 'recreio') exitRecreio();
        beginSeasonFarewell(sid);
      }
    });
  }

  // ---------- RELÓGIO REAL: o céu segue a HORA LOCAL da Mel (substitui o ciclo de ~9min) ----------
  // clockFn é INJETÁVEL nos testes headless (window.__env.setClock); em produção = hora local real.
  var clockFn = function(){ return new Date(); };
  function hourOf(d){ return d.getHours() + d.getMinutes()/60 + d.getSeconds()/3600; }
  // CURVA DO CÉU por HORA — contínua (interpolação suave por minuto, sem degraus):
  //  madrugada 0-5h30 noite plena · 5h30-8h amanhecer (gradiente) · 8-18h dia claro ·
  //  18-20h30 entardecer dourado · 20h30+ noite. n=0 dia claro (SKY_D) -> n=1 noite (SKY_N).
  function hourToNight(h){
    if(h < 5.5)  return 1;                     // madrugada: noite plena
    if(h < 8)    return 1 - ss((h - 5.5)/2.5); // amanhecer 5h30->8h: 1 -> 0
    if(h < 18)   return 0;                     // dia claro
    if(h < 20.5) return ss((h - 18)/2.5);      // entardecer dourado 18h->20h30: 0 -> 1 (o meio já é o pôr-do-sol)
    return 1;                                  // noite
  }
  function nightPhase(){ return hourToNight(hourOf(clockFn())); }
  var curHour = 12, snowCap = false;           // atualizados a cada draw (a hora manda nas janelas/clima)

  // ---------- "a cidade dorme com você": cada janela tem sua HORA DE DORMIR ----------
  // perfil determinístico por janela (mesma seed -> mesma rotina, estável entre reaberturas).
  // onAt = acende ao entardecer (17h18-19h -> a maioria acesa às 19h); owl = ~8% viram a noite
  // (só corujas na madrugada); bed = dorme entre 23h e 2h. FONTE ÚNICA da distribuição (genNormal
  // e o teste headless leem daqui). A população/contadores NÃO mudam — é só a LUZ.
  function makeWin(r, dx, dy){ return { dx:dx, dy:dy, lvl:r(), onAt:17.3 + r()*1.7, owl:r()<0.08, bed:23 + r()*3 }; }
  function litWin(hour, w){
    var hn = hour < 6 ? hour + 24 : hour;      // madrugada (0-6h) = continuação da noite (24-30h)
    if(w.owl) return hn >= w.onAt && hn < 29.5;    // coruja: acesa até ~5h30 (29.5)
    return hn >= w.onAt && hn < w.bed;             // demais: apagam na sua hora de dormir; de dia, apagadas
  }

  // ---------- CLIMA: episódios ocasionais e DETERMINÍSTICOS por janela de tempo real ----------
  // sem Math.random no gatilho -> estável entre reaberturas do app. seed da chuva = floor(unixHora/2h).
  var curWeather = { rain:0, fog:0, snow:0 }, wCacheKey = null;
  function weatherAt(d){
    var ms = d.getTime(), hour = hourOf(d), month = d.getMonth();
    // CHUVA: ~25% das janelas de 2h têm chuva de 10-20min (fade suave de 3min nas bordas).
    var win = Math.floor(ms / 7200000), wr = seededRand((win ^ 0x1b873593) >>> 0);
    var rains = wr() < 0.25, startOff = 5 + wr()*95, dur = 10 + wr()*10, rain = 0;
    if(rains){ var minsIn = (ms - win*7200000)/60000, into = minsIn - startOff, left = startOff + dur - minsIn;
      if(into >= 0 && left > 0) rain = clamp01(Math.min(into/3, left/3, 1)); }
    // NEBLINA: manhã 6-9h, nem toda manhã (~40%, determinístico por DIA), pico ~7h24.
    var fog = 0;
    if(hour >= 6 && hour < 9){ var day = Math.floor(ms/86400000), fgr = seededRand((day ^ 0x85ebca6b) >>> 0);
      if(fgr() < 0.4){ fog = clamp01(1 - Math.abs(hour - 7.4)/1.6) * (0.55 + fgr()*0.35); } }
    // NEVE: SÓ dezembro (mês 11). Pra expandir p/ jan/fev depois, troque por: (month===11 || month<=1).
    var snow = (month === 11) ? 1 : 0;
    return { rain:rain, fog:fog, snow:snow };
  }
  function updateWeather(d){
    var key = Math.floor(d.getTime()/30000);   // recomputa no máx a cada 30s (barato, roda o dia todo)
    if(key !== wCacheKey){ wCacheKey = key; curWeather = weatherAt(d); }
    return curWeather;
  }

  function drawBackline(n){
    var hz = mix('#2c2744','#191430',n), p = camX*0.4, base = Math.floor(p/12);
    for(var j=-1;j<W/12+2;j++){
      var ti = base + j, h = BACKPAT[((ti % BACKPAT.length)+BACKPAT.length)%BACKPAT.length];
      R(j*12 - (p - base*12), BASE-h, 11, h, hz);
    }
  }
  function drawNormal(b, sx, n){
    var ease = b.rise<1 ? 1-Math.pow(1-b.rise,3) : 1;
    var hh = b.h*ease, top = BASE-hh;
    R(sx, top, b.w, hh, b.body);
    R(sx, top, 1, hh, mix(b.body,'#ffffff',0.10));        // quina iluminada
    R(sx+b.w-1, top, 1, hh, mix(b.body,'#000000',0.22));  // quina sombreada
    if(ease > 0.9){
      if(b.landmark){ R(sx-1,top-6,b.w+2,6,b.roof); R(sx+b.w/2-1,top-11,2,5,b.roof); R(sx+b.w/2-2,top-3,4,4,'#ffe6a8'); }
      else {
        switch(b.roofStyle){
          case 'parapet': R(sx-1,top-2,b.w+2,2,b.roof); R(sx-1,top-2,1,2,mix(b.roof,'#fff',0.2)); break;
          case 'peaked':  R(sx+2,top-3,b.w-4,3,b.roof); R(sx+b.w/2-2,top-5,4,2,b.roof); break;
          case 'antenna': { R(sx,top-2,b.w,2,b.roof);
            // VENTO: a ponta da antena balança com FASE/VELOCIDADE próprias (dessincronizada do varal).
            var amx=sx+(b.w>>1), asway=reduce?0:Math.round(Math.sin(t*(0.0016+(b.idx%3)*0.0005) + b.idx*1.3));
            R(amx, top-5, 1, 4, mix(b.roof,'#fff',0.15));            // base do mastro (reta)
            R(amx+asway, top-9, 1, 4, mix(b.roof,'#fff',0.15));      // parte de cima balança ao vento
            R(amx+asway, top-10, 1, 1, '#ff8a6a'); break; }          // luz na ponta
          case 'watertank': R(sx,top-2,b.w,2,b.roof); R(sx+b.w-7,top-6,5,4,mix(b.body,'#000',0.2)); R(sx+b.w-6,top-8,3,2,mix(b.body,'#000',0.1)); break;
          default: R(sx,top-2,b.w,2,b.roof);
        }
        if(b.tank){ R(sx+2,top-5,4,3,mix(b.body,'#000',0.25)); R(sx+2,top-6,4,1,mix(b.body,'#000',0.1)); }
      }
      // janelas seguem a HORA REAL: acendem ao entardecer, apagam na hora de dormir de cada uma.
      // JANELAS COM PERSONALIDADE (tudo já pré-computado em genNormal): padrão varia por seed
      // (2x3 / 1x2 estreita / 2x2 quadrada), biblioteca tem janelas ARQUEADAS (1px de arco),
      // e prédios detalhados ganham ar-condicionado pendurado (~10% das janelas).
      var yb = BASE-b.h, shp = b.winShape || 'std', offc = mix(b.body,'#000000',0.35);
      for(var i=0;i<b.win.length;i++){ var wn=b.win[i], on = litWin(curHour, wn),
          wc = on ? (wn.lvl<0.3?'#fff0c0':'#ffcf7a') : offc, wy = yb+wn.dy;
        if(shp==='arch'){ R(sx+wn.dx, wy, 3, 3, wc);
          R(sx+wn.dx, wy, 1, 1, offc); R(sx+wn.dx+2, wy, 1, 1, offc); }   // cantos apagados = arco de 1px
        else if(shp==='narrow'){ R(sx+wn.dx, wy, 1, 3, wc); }
        else if(shp==='square'){ R(sx+wn.dx, wy, 2, 2, wc); }
        else R(sx+wn.dx, wy, 2, 3, wc);                                   // 2x3 padrão
        if(wn.ac){ R(sx+wn.dx, wy+3, 2, 1, mix(b.body,'#000',0.10));      // caixinha 2x1 de ar-condicionado
          R(sx+wn.dx, wy+4, 1, 1, mix('#9ab0c0',b.body,0.5)); } }         // pingo
      // CORNIJA: friso 1px mais claro a cada ~5 andares (só prédios ALTOS detalhados).
      if(b.detailed && b.h>44){ var cclr=mix(b.body,'#ffffff',0.14);
        for(var cf=top+10; cf<BASE-4; cf+=30) R(sx, cf|0, b.w, 1, cclr); }
      // VITRINE larga no térreo (mercado): acende de dia (loja aberta).
      if(b.detailed && b.persona==='mercado'){ var vy=BASE-6, vlit=(curHour>=8 && curHour<21);
        R(sx+1, vy, b.w-2, 5, mix('#2a2230','#141018',n));                // moldura da vitrine
        R(sx+2, vy+1, b.w-4, 3, vlit ? '#ffe0a0' : mix(b.body,'#000',0.22)); // vidro largo
        for(var vk=sx+3; vk<sx+b.w-2; vk+=4) R(vk|0, vy+1, 1, 3, mix(b.body,'#000',0.35)); // montantes
        R(sx+1, vy-1, b.w-2, 1, mix(b.roof,'#000',0.05)); }               // testeira
      if(b.balcony){ var by=top+Math.floor(hh*0.5); ctx.globalAlpha=0.5; R(sx, by, b.w, 1, mix(b.body,'#000',0.4)); ctx.globalAlpha=1; }
      if(b.sign && n>0.4){ R(sx+2, top+4, Math.min(b.w-4,6), 2, n>0.5?'#7fc7bf':'#4a6a72'); } // letreiro pixel discreto
      if(curWeather.rain>0){ ctx.globalAlpha=0.22*curWeather.rain; R(sx, top, b.w, 1, '#cfe0f0'); ctx.globalAlpha=1; } // telhado molhado
    }
    if(snowCap){ R(sx, BASE-hh-2, b.w, 1, '#eef4fc'); }   // coroa de neve fininha no telhado (só dezembro)
  }
  // estruturas especiais — cada tipo com arte própria e distinta.
  function drawSpecial(b, sx, n){
    var ease = b.rise<1 ? 1-Math.pow(1-b.rise,3) : 1, k, hh, top;
    switch(b.type){
      case 'parque': {
        var gc = mix('#4f7355','#2f4740',n);
        R(sx, BASE-6, b.w, 6, gc);                                  // gramado
        for(k=0;k<2;k++){ var tx=sx+6+k*13;
          R(tx+1,BASE-13,2,8,mix('#4a3a3a','#2a2230',n));
          R(tx-2,BASE-19,8,7,gc); R(tx-1,BASE-21,6,3,gc); }
        R(sx+b.w/2-3, BASE-5, 6, 2, mix('#8a6a3a','#3a2e2a',n));    // banco
        R(sx+b.w/2-3, BASE-3, 1, 3, mix('#5a4530','#2a221e',n));
        R(sx+b.w/2+2, BASE-3, 1, 3, mix('#5a4530','#2a221e',n));
        break; }
      case 'torre': {
        hh = b.h*ease; top = BASE-hh; var bt = mix('#4a4166','#241d3e',n);
        R(sx, top, b.w, hh, bt); R(sx, top, 1, hh, mix(bt,'#ffffff',0.12));
        R(sx, top-2, b.w, 2, mix('#8a6a9a','#4a3a5a',n));
        R(sx+b.w/2-1, top-6, 2, 4, mix('#6a5a7a','#3a2e4a',n));
        R(sx+b.w/2-1, top-7, 2, 1, '#ff9a6a');                      // luz de topo
        if(ease>0.9){ var rws=Math.floor((hh-8)/6), cls=Math.max(1,Math.floor((b.w-4)/5));
          for(var ry=0;ry<rws;ry++) for(var cx=0;cx<cls;cx++) R(sx+3+cx*5, top+5+ry*6, 2, 3, '#ffcf7a'); }
        break; }
      case 'cais': {
        var pc = mix('#8a6a3a','#3a2e2a',n);
        R(sx, BASE-3, b.w, 3, pc);                                  // deque
        for(k=0;k<b.w;k+=4) R(sx+k, BASE, 1, 8, mix('#5a4530','#241c1a',n)); // estacas na água
        R(sx, BASE, b.w, 1, pc);
        var bx=sx+b.w-9;                                            // barquinho
        R(bx, BASE+9, 8, 2, mix('#8a4a4a','#4a2a34',n));
        R(bx+4, BASE+4, 1, 5, mix('#caa','#556',n));
        R(bx+4, BASE+4, 3, 3, mix('#e0d0b0','#6a6a8a',n));
        break; }
      case 'biblioteca': {
        hh = b.h*ease; top = BASE-hh; var bd = mix('#5a4a5a','#2e2440',n);
        R(sx, top, b.w, hh, bd); R(sx, top, 1, hh, mix(bd,'#fff',0.1));
        R(sx-1, top-2, b.w+2, 2, mix('#a07a5a','#5a4030',n));       // cornija
        if(ease>0.9){ for(k=0;k<3;k++){ var wx2=sx+3+k*Math.floor((b.w-4)/3);
          R(wx2, top+5, 4, hh-10, '#ffdf9a');                       // janelões dourados
          R(wx2, top+4, 4, 1, mix('#a07a5a','#5a4030',n)); }
          R(sx+b.w/2-2, BASE-6, 4, 6, mix('#6a4a3a','#2a1e1a',n)); } // porta
        break; }
      case 'mirante': {
        hh = b.h*ease; top = BASE-hh; var pl = mix('#6a5a6a','#342a40',n);
        R(sx+b.w/2-2, top+6, 4, hh-6, pl);                          // mastro
        R(sx-1, top+2, b.w+2, 5, mix('#7a6a7a','#3a2e44',n));       // plataforma
        for(k=0;k<b.w+2;k+=3) R(sx-1+k, top-1, 1, 3, mix('#9a8aa0','#4a3e58',n)); // guarda-corpo
        R(sx-1, top-1, b.w+2, 1, mix('#9a8aa0','#4a3e58',n));
        R(sx+b.w/2-1, top-3, 2, 2, '#ffe6a8');                      // luzinha
        break; }
      case 'praca': {
        var pv = mix('#6a5f6a','#332a3e',n);
        R(sx, BASE-4, b.w, 4, pv);                                  // piso
        var fx=sx+b.w/2;                                            // fonte
        R(fx-3, BASE-7, 6, 3, mix('#8a8a9a','#3a3a52',n));
        R(fx-1, BASE-10, 2, 3, mix('#aad0e0','#4a5a7a',n));
        R(sx+3, BASE-10, 1, 6, mix('#5a4a55','#2a2230',n));         // lampião
        R(sx+2, BASE-12, 3, 3, n>0.32?'#ffdf9a':'#4a4258');
        break; }
      case 'estacao': {
        hh = b.h*ease; top = BASE-hh; var eb = mix('#4e4258','#28203a',n);
        R(sx, top, b.w, hh, eb); R(sx, top, 1, hh, mix(eb,'#fff',0.1));
        R(sx-1, top-3, b.w+2, 3, mix('#8a6a5a','#4a3436',n));       // beiral
        if(ease>0.9){
          R(sx+b.w/2-3, top-9, 6, 6, mix('#c9b08a','#5a4a3a',n));   // relógio
          R(sx+b.w/2, top-6, 1, 3, mix('#2a2230','#000',0));
          for(k=0;k<3;k++) R(sx+3+k*Math.floor((b.w-4)/3), top+4, 4, hh-8, '#ffdf9a'); // arcos
          R(sx, BASE-2, b.w, 2, mix('#6a5a55','#2a2230',n)); }      // plataforma
        break; }
      case 'mercado': {
        hh = b.h*ease; top = BASE-hh; var mb = mix('#54455e','#2a2038',n);
        R(sx, top, b.w, hh, mb);
        if(ease>0.9){ for(k=0;k<Math.max(1,Math.floor((b.w-2)/6));k++) R(sx+2+k*6, top+4, 3, hh-14, '#ffe0a0'); }
        R(sx-1, BASE-8, b.w+2, 3, mix('#8a5a5a','#4a2a34',n));      // toldo
        var awn=['#c9736f','#e0c07a']; for(k=0;k<b.w+2;k+=3) R(sx-1+k, BASE-8, 2, 3, mix(awn[(k/3)&1],'#3a2e2e',n<0.4?0.4:0));
        R(sx+2, BASE-5, b.w-4, 5, mix('#6a5548','#2a221e',n));      // bancas
        break; }
      case 'coreto': {
        var cb = mix('#6a5a6a','#332a40',n);
        R(sx+2, BASE-9, b.w-4, 9, mix('#5a4a55','#2a2230',n));      // base
        for(k=0;k<4;k++) R(sx+2+k*Math.floor((b.w-4)/3), BASE-9, 1, 9, mix('#8a7a8a','#4a3e50',n)); // colunas
        R(sx, BASE-13, b.w, 4, mix('#8a5a6a','#4a2a3a',n));         // teto
        R(sx+b.w/2-1, BASE-16, 2, 3, cb);                          // ponta
        R(sx+b.w/2-1, BASE-17, 2, 1, '#ffe6a8');
        break; }
      case 'museu': {
        hh = b.h*ease; top = BASE-hh; var ub = mix('#5a4e5e','#2c2440',n);
        R(sx, top+4, b.w, hh-4, ub);
        R(sx-1, top, b.w+2, 5, mix('#b0a08a','#5a5040',n));         // frontão
        R(sx+b.w/2-1, top+1, 2, 2, mix('#8a7a6a','#4a4030',n));
        if(ease>0.9){ for(k=0;k<Math.max(2,Math.floor((b.w-2)/5));k++) R(sx+2+k*5, top+6, 3, hh-8, mix('#cbb89a','#6a5e4a',n)); } // colunas
        R(sx+b.w/2-3, BASE-7, 6, 7, mix('#4a3a3a','#241c1a',n));    // portal
        break; }
      case 'ponte': {
        var pb = mix('#6a5a6a','#2e2640',n);
        R(sx, BASE-2, b.w, 3, pb);                                  // tabuleiro
        R(sx, BASE+1, 2, 8, pb); R(sx+b.w-2, BASE+1, 2, 8, pb);     // pilares
        for(k=4;k<b.w-4;k+=5) R(sx+k, BASE-6, 1, 4, mix('#8a7a8a','#4a3e50',n)); // cabos
        R(sx+2, BASE-6, b.w-4, 1, mix('#8a7a8a','#4a3e50',n));      // corrimão
        if(n>0.4){ for(k=4;k<b.w-4;k+=8) R(sx+k, BASE-3, 1, 1, '#ffdf9a'); } // luzes
        break; }
      case 'jardim': {
        hh = b.h*ease; top = BASE-hh; var jb = mix('#3f5a48','#20342a',n);
        R(sx, top, b.w, hh, jb); R(sx, top, 1, hh, mix(jb,'#fff',0.1));
        if(ease>0.9){ var fl=['#e08aa0','#f2d07a','#c98ac4'];
          for(var yy=top+3; yy<BASE-2; yy+=5){ for(var xx=sx+2; xx<sx+b.w-1; xx+=4){
            var fk=((xx+yy)|0);                 // sx é fracionário (câmera lerpada) -> trunca p/ índice inteiro
            R(xx, yy, 2, 2, mix('#6aa07a','#2f4740',n));
            if((fk&7)===0) R(xx, yy, 1, 1, mix(fl[((fk%3)+3)%3],'#3a3a52',n*0.5)); } } }
        break; }
      case 'chamine': {
        hh = b.h*ease; top = BASE-hh; var cf = mix('#4a4250','#242030',n);
        R(sx+b.w/2-3, top, 6, hh, cf);                              // duto
        R(sx+b.w/2-4, top, 8, 3, mix('#7a4a4a','#3a2434',n));       // topo
        R(sx, BASE-10, b.w, 10, mix('#3f3a4a','#201c2a',n));        // galpão
        R(sx, BASE-10, b.w, 1, mix('#5a5060','#2a2436',n));
        if(!reduce && n<0.6){ ctx.globalAlpha=0.25; for(k=0;k<3;k++) R(sx+b.w/2-2+k, top-4-k*3, 3, 2, mix('#c0b0b8','#4a4458',n)); ctx.globalAlpha=1; }
        break; }
      default: R(sx, BASE-10, b.w, 10, mix('#524565','#241d3e',n));
    }
  }

  // ---------- marcos ANCORADOS NO MUNDO: pertencem à costa (rolam com a cidade) ----------
  // Cada marco de chão vive numa coordenada de MUNDO na ponta da costa. Quando a cidade
  // cresce e ele ia sair pela esquerda, a cidade "constrói um novo" na ponta atual (o
  // antigo rola pra fora com os prédios). Antes ficavam pregados em coordenada de TELA
  // (farol sempre no mesmo lugar) — parecia adesivo.
  var markerWX = {}; // id do marco -> x de MUNDO do marco atual (null/undefined = recolocar)
  function placeMarker(id, ahead){ markerWX[id] = frontier + ahead; } // na ponta, à frente do último prédio
  function groundMarker(id, ahead, drawFn, renote){
    if(!store.marcos[id]) return;
    if(markerWX[id]==null) placeMarker(id, ahead);
    var sx = markerWX[id] - camX;
    if(sx < -34){ placeMarker(id, ahead); sx = markerWX[id] - camX; if(renote) showNote(renote); }
    drawFn(sx);
  }
  function drawGarden(n, gx){
    var gy=BASE-5, gc=mix('#4f7355','#2f4740',n), fl=['#e08aa0','#f2d07a','#c98ac4','#e0a06a'];
    R(gx, gy, 30, 5, gc);
    for(var k=0;k<9;k++) R(gx+2+k*3, gy-2, 1, 2, mix(fl[k%4],'#4a3a5a', n*0.55));
  }
  function drawFerry(n, dt){
    if(!reduce) ferryX += 0.11*(dt*0.06); if(ferryX>W+22) ferryX=-24;
    var fy=BASE+15, hull=mix('#6a5a7a','#2e2440',n);
    R(ferryX, fy, 20, 4, hull);
    R(ferryX+3, fy-4, 14, 4, mix('#8a7a9a','#3e3452',n));
    R(ferryX+8, fy-9, 2, 5, mix('#aaaacc','#556',n));
    if(n>0.4){ R(ferryX+18, fy-1, 1, 1, '#ff8a6a'); R(ferryX, fy-1, 1, 1, '#8affa0'); }
    ctx.globalAlpha=0.2; R(ferryX-6, fy+2, 6, 1, mix('#cfe0f0','#3a4568',n)); ctx.globalAlpha=1;
  }
  function drawLighthouse(n, t, lx){
    var lh=44, lt=BASE-lh;
    // quebra-mar: molhe de pedras + estacas entrando na água -> o farol PERTENCE à ponta.
    var rock=mix('#5a5060','#241c26',n);
    R(lx-3, BASE, 14, 2, rock);                                  // molhe na linha d'água
    R(lx-4, BASE+2, 16, 2, mix(rock,'#000',0.22));
    for(var kk=0; kk<14; kk+=3) R(lx-3+kk, BASE+4, 1, 3, mix('#4a4050','#181420',n)); // estacas
    R(lx, lt, 8, lh, mix('#d8d2d0','#5a5468',n));               // torre
    for(var k=0;k<lh;k+=8) R(lx, lt+k, 8, 3, mix('#c05a5a','#5a2a3a',n)); // faixas
    R(lx-1, lt-3, 10, 4, mix('#8a8a9a','#3a3a52',n));           // base da lanterna
    R(lx+1, lt-8, 6, 5, n>0.35?'#fff2c0':'#6a6a8a');            // lanterna
    R(lx-1, lt-10, 10, 2, mix('#7a4a5a','#3a2438',n));          // teto
    if(n>0.4){                                                  // feixe girando (só de noite)
      var ba=Math.sin(t*0.0012), cxb=lx+4, cyb=lt-5;
      ctx.globalAlpha=0.16*n; ctx.fillStyle='#fff2c0';
      ctx.beginPath(); ctx.moveTo(cxb,cyb);
      ctx.lineTo(cxb-64, cyb-10+ba*26); ctx.lineTo(cxb-64, cyb+10+ba*26); ctx.closePath(); ctx.fill();
      ctx.globalAlpha=1;
    }
  }
  function drawFestival(n, t){
    var ly=BASE+2, cols=['#f2b47a','#e08aa0','#7fc7bf','#ffd79a'];
    ctx.globalAlpha=0.3; R(0, ly-1, W, 1, mix('#6a5a55','#2a2230',n)); ctx.globalAlpha=1; // fio
    for(var k=0;k<W;k+=16){ var sw=Math.sin(t*0.001 + k)*1;
      R(k+6, ly+sw, 2, 3, mix(cols[(k/16)&3], '#3a2e44', n<0.35?0.45:0)); }
  }
  // FIX: fogos VISÍVEIS toda noite quando destravado (pop>=120k). Antes eram raros
  // demais (random 0,6%/quadro, só com n>0.55) e minúsculos (1px). Agora: ao ENTRAR na
  // noite dispara uma salva de 2-3 rajadas coloridas e espaçadas, maiores (2x2), com
  // reflexo suave na água. Determinístico o bastante pra um teste headless conferir.
  var FW_NIGHT=0.6, fwWasNight=false, fwBudget=0, fwNextAt=0;
  var FW_COL=['#ffd479','#ff9ec4','#8ad8ff']; // âmbar / rosa / ciano (paleta calma)
  function drawFireworks(n, t, dt){
    var night = n > FW_NIGHT;
    if(night && !fwWasNight){ fwBudget = 2 + (Math.random()<0.5?1:0); fwNextAt = t + 500; } // 2-3 por noite
    fwWasNight = night;
    if(night && fwBudget>0 && t>=fwNextAt && fireworks.length<3){
      fireworks.push({ x:34+Math.random()*(W-68), y:20+Math.random()*28, age:0, hue:Math.floor(Math.random()*3) });
      fwBudget--; fwNextAt = t + 2400 + Math.random()*1600;
    }
    for(var fw=fireworks.length-1; fw>=0; fw--){ var f=fireworks[fw]; f.age+=dt*0.05;
      if(f.age>18){ fireworks.splice(fw,1); continue; }
      var rad=f.age*1.15, al=Math.max(0,1-f.age/18), col=FW_COL[f.hue%3];
      ctx.globalAlpha=al*0.9;
      for(var pa=0;pa<10;pa++){ var ang=pa/10*6.283;
        R(f.x+Math.cos(ang)*rad, f.y+Math.sin(ang)*rad, 2, 2, col); }   // rajada colorida
      R(f.x, f.y-1, 2, 2, '#fff2c8');                                     // núcleo claro
      // reflexo na água (espelhado abaixo da linha d'água, comprimido e mais fraco)
      ctx.globalAlpha=al*0.25;
      for(var pr=0;pr<10;pr++){ var a2=pr/10*6.283, ry=BASE + (BASE-(f.y+Math.sin(a2)*rad))*0.14;
        if(ry>BASE) R(f.x+Math.cos(a2)*rad, ry, 1, 1, col); }
      ctx.globalAlpha=1;
    }
  }

  var t=0;

  // ============================================================================
  // CLIMA (partículas) + HABITANTES — tudo POOLED e com CAP (o app roda o dia inteiro;
  // arrays NUNCA crescem sem poda). reduce -> clima estático, sem partículas nem motion.
  // ============================================================================
  // ---- CHUVA: traços diagonais finos + gotas na água (a cena fica MOLHADA em draw()) ----
  var MAX_RAIN = 64, rainP = [], RAIN_COL = '#a9c4e0';
  function drawRain(rain, dt){
    var target = (reduce || rain<=0) ? 0 : Math.floor(MAX_RAIN * rain);
    while(rainP.length < target) rainP.push({ x:Math.random()*W, y:Math.random()*BASE, sp:1.3+Math.random()*0.9 });
    if(rainP.length > target) rainP.length = target;
    for(var i=0;i<rainP.length;i++){ var p=rainP[i];
      p.y += p.sp*(dt*0.16); p.x += p.sp*(dt*0.05);        // cai na diagonal (vento leve)
      if(p.x > W) p.x -= W;
      if(p.y > BASE){ R((p.x)|0, (BASE + Math.random()*3)|0, 1, 1, RAIN_COL); p.y = -3; p.x = Math.random()*W; } // respinga na água
      R(p.x|0, p.y|0, 1, 3, RAIN_COL);                     // traço fino
    }
  }
  // ---- NEBLINA: bandas horizontais translúcidas com parallax lento sobre a orla/água ----
  var fogOff = 0;
  function drawFog(fog, dt, n){
    if(fog<=0) return;
    if(!reduce) fogOff += dt*0.004;
    var cc = mix('#c8d4dc','#5a6478', n);                  // a neblina segue o dia/noite
    for(var b=0;b<3;b++){ var y = BASE - 12 + b*7, ox = (fogOff*(0.5+b*0.25)) % 44;
      ctx.globalAlpha = fog*(0.5 - b*0.10); R(-((ox)|0), y, W+48, 4, cc); }
    ctx.globalAlpha = 1;
  }
  // ---- NEVE: flocos devagar (a coroa branca nos telhados sai em drawNormal via snowCap) ----
  var MAX_SNOW = 48, snowP = [], SNOW_COL = '#eaf2fb';
  function drawSnow(snow, dt){
    var target = (reduce || snow<=0) ? 0 : MAX_SNOW;
    while(snowP.length < target) snowP.push({ x:Math.random()*W, y:Math.random()*BASE, dr:0.18+Math.random()*0.22, ph:Math.random()*6.28 });
    if(snowP.length > target) snowP.length = target;
    for(var i=0;i<snowP.length;i++){ var p=snowP[i];
      p.y += p.dr*(dt*0.10); p.ph += 0.03; p.x += Math.sin(p.ph)*0.25;    // desce balançando
      if(p.y > BASE){ p.y = -1; p.x = Math.random()*W; }
      R(p.x|0, p.y|0, 1, 1, SNOW_COL); }
  }

  // ---- PEDESTRES: pontinhos 2px na orla; densidade segue a HORA; alguns param no cais ----
  var MAX_PED = 12, peds = [], PED_COL = ['#c9b2c4','#9aa6c0','#b0a0b8'];
  function pedTarget(hour){                                // orla movimentada de dia/entardecer, vazia de madrugada
    if(hour < 5.5) return 0; if(hour < 8) return 2; if(hour < 11) return 5;
    if(hour < 18) return 8;  if(hour < 20.5) return 9; if(hour < 23) return 4; return 1;
  }
  function updatePeds(hour, dt){
    var target = Math.min(MAX_PED, reduce ? Math.min(2, pedTarget(hour)) : pedTarget(hour));
    if(peds.length < target && (reduce || Math.random() < 0.05)){
      var dir = Math.random()<0.5?1:-1;
      peds.push({ x: dir>0? -2 : W+2, dir:dir, sp:0.10+Math.random()*0.22, pause:0, nextP:1200+Math.random()*2600,
        col:PED_COL[(Math.random()*PED_COL.length)|0], bob:Math.random()*6.28 });
    }
    for(var i=peds.length-1;i>=0;i--){ var p=peds[i];
      if(!reduce){
        if(p.pause>0){ p.pause -= dt; }                    // parou no cais/na grade
        else { p.x += p.dir*p.sp*(dt*0.06); p.nextP -= dt;
          if(p.nextP<=0){ p.nextP = 1600+Math.random()*3000; if(Math.random()<0.35) p.pause = 700+Math.random()*1800; } }
        p.bob += dt*0.01;
      }
      if(p.x < -4 || p.x > W+4 || peds.length > target + 2){ peds.splice(i,1); }
    }
  }
  function drawPeds(){
    for(var i=0;i<peds.length;i++){ var p=peds[i], px=p.x|0, step=(!reduce && p.pause<=0 && Math.sin(p.bob)>0)?1:0;
      R(px, BASE-3, 1, 2, p.col);                          // corpo 2px
      R(px, BASE-4, 1, 1, mix(p.col,'#000',0.2));          // cabecinha
      R(px, BASE-1, 1, 1, step? mix(p.col,'#000',0.35) : p.col); // "passo"
    }
  }

  // ---- GATOS nos telhados: sentam, mexem o rabo, trocam de telhado; 1-3 no máx ----
  var MAX_CAT = 3, cats = [], CAT_COL = '#2b2436';
  function roofCandidate(){                                // reservoir sampling num telhado normal visível
    var cand=null, seen=0;
    for(var i=0;i<city.length;i++){ var b=city[i];
      if(b.kind!=='normal' || b.rise<1) continue; var sx=b.wx-camX;
      if(sx>12 && sx<W-14 && b.h>16){ seen++; if(Math.random()<1/seen) cand=b; } }
    return cand;
  }
  function updateCats(hour, dt){
    var want = hour<5.5 ? 1 : 2;                           // menos de madrugada
    for(var i=cats.length-1;i>=0;i--){ var c=cats[i];
      if(city.indexOf(c.b)<0 || (c.b.wx - camX) < 6){ cats.splice(i,1); continue; } // telhado saiu da tela
      if(!reduce){ c.tail += dt*0.005; c.timer -= dt;
        if(c.timer<=0){ var nb=roofCandidate(); if(nb){ c.b=nb; c.off=3+Math.random()*Math.max(4,nb.w-6); } c.timer=6000+Math.random()*10000; } }
    }
    if(cats.length < Math.min(MAX_CAT, want)){ var b=roofCandidate();
      if(b) cats.push({ b:b, off:3+Math.random()*Math.max(4,b.w-6), tail:Math.random()*6.28, timer:6000+Math.random()*10000 }); }
  }
  function drawCats(){
    for(var i=0;i<cats.length;i++){ var c=cats[i]; if(city.indexOf(c.b)<0) continue;
      var sx=(c.b.wx - camX + c.off)|0, ry=(BASE - c.b.h - 1)|0;
      R(sx, ry-2, 3, 2, CAT_COL);                          // corpo sentado
      R(sx, ry-3, 1, 1, CAT_COL); R(sx+2, ry-3, 1, 1, CAT_COL); // orelhas
      var tw = (!reduce && Math.sin(c.tail)>0) ? 1 : 0;
      R(sx+3, ry-3-tw, 1, 2, CAT_COL);                     // rabo balançando
    }
  }

  // ---- VARAL entre prédios vizinhos: fio + roupinhas balançando; SOME quando chove ----
  var MAX_VARAL = 2, varalCount = 0, VARAL_CLOTHES = ['#d9a3a8','#a9c0d0','#e0cf9a'];
  function drawVarais(rain){
    varalCount = 0;
    if(rain > 0.05) return;                                // recolheram na chuva!
    for(var i=0;i<city.length-1 && varalCount<MAX_VARAL;i++){ var a=city[i], b=city[i+1];
      if(a.kind!=='normal' || b.kind!=='normal' || a.rise<1 || b.rise<1) continue;
      if((a.idx % 4)!==1) continue;                        // esparso (não em todo prédio)
      var ax=a.wx+a.w-camX, bx=b.wx-camX; if(bx-ax>7 || ax<0 || bx>W) continue; // vizinhos e visíveis
      var y = (BASE - Math.min(a.h,b.h)*0.6)|0, wlen = Math.max(1,(bx-ax)|0);
      ctx.globalAlpha=0.55; R(ax|0, y, wlen, 1, '#6a5f6a'); ctx.globalAlpha=1;   // fio
      // VENTO dessincronizado: cada roupinha balança com FASE (i,k) e VELOCIDADE próprias —
      // frequências distintas das antenas dos telhados (não sobem/descem em sincronia).
      for(var k=0;k<3;k++){ var baseCx=ax + (bx-ax)*(0.25+k*0.25),
          vs=Math.sin(t*(0.0022 + (k%2)*0.0007) + i*0.9 + k*2.1),
          hsway=reduce?0:Math.round(vs), sw=(!reduce && vs>0)?1:0;
        R((baseCx+hsway)|0, y+1, 2, 2+sw, VARAL_CLOTHES[k%3]); }   // roupinhas 2-3px, balançando ao vento
      varalCount++;
    }
  }

  // ---- TREM: a cada 4-8min cruza a orla (rente à água); janelas acesas à noite ----
  var train = null, trainNextAt = 12000;
  function updateTrain(dt){
    if(reduce) return;
    if(!train && t >= trainNextAt){ var dir = Math.random()<0.5?1:-1;
      train = { x: dir>0? -60 : W+60, dir:dir, sp:0.9+Math.random()*0.4, cars:2+((Math.random()*2)|0) }; }
    if(train){ train.x += train.dir*train.sp*(dt*0.06);
      if(train.x < -70 || train.x > W+70){ train=null; trainNextAt = t + 240000 + Math.random()*240000; } } // 4-8min
  }
  function drawTrain(night){
    if(!train) return; var y = BASE-7, x = train.x|0, len = train.cars*13, dir = train.dir;
    R(x, y+5, len, 1, mix('#2a2636','#0e0c18',0.3));       // trilho/sombra rente à orla
    for(var c=0;c<train.cars;c++){ var cxp = x + c*13, body = c===0? '#5a4e64':'#4a4560';
      R(cxp, y, 12, 5, body); R(cxp, y, 12, 1, mix(body,'#fff',0.12));
      for(var w2=0;w2<2;w2++) R(cxp+2+w2*5, y+2, 3, 2, night? '#ffdf9a' : mix(body,'#000',0.25)); } // janelas
    R(x, y-1, 12, 1, '#6a5a72');                           // teto da locomotiva
    if(night) R(dir>0? x+len-1 : x, y+2, 1, 1, '#ffcf7a'); // farol
  }

  // ---- DIRIGÍVEL raro: a cada 30-60min cruza o céu devagar; letreiro "TOKENTOWN" piscando ----
  var blimp = null, blimpNextAt = 60000;
  function updateBlimp(dt){
    if(reduce) return;
    if(!blimp && t >= blimpNextAt){ var dir = Math.random()<0.5?1:-1;
      blimp = { x: dir>0? -70 : W+70, y: 16+Math.random()*16, dir:dir, sp:0.28+Math.random()*0.12 }; }
    if(blimp){ blimp.x += blimp.dir*blimp.sp*(dt*0.06);
      if(blimp.x < -74 || blimp.x > W+74){ blimp=null; blimpNextAt = t + 1800000 + Math.random()*1800000; } } // 30-60min
  }
  function drawBlimp(night){
    if(!blimp) return; var x=blimp.x|0, y=blimp.y|0, blink = (Math.floor(t*0.004)%2===0);
    var body = night? '#6a5f7a' : '#8a7f96';
    R(x, y, 22, 8, body); R(x+2, y-1, 18, 1, mix(body,'#fff',0.15));
    R(x-1, y+3, 1, 2, body); R(x+22, y+3, 1, 2, body);     // envelope (bico e cauda)
    R(x+8, y+8, 6, 2, mix(body,'#000',0.3));               // gôndola
    var lit = night ? '#ffe6a8' : '#f2b47a';               // letreiro piscando; à noite brilha
    if(blink){ ctx.globalAlpha = night?1:0.9; ctx.font='bold 6px monospace'; ctx.textAlign='left'; ctx.textBaseline='top';
      ctx.fillStyle = lit; ctx.fillText('TOKENTOWN', x+1, y+2);
      if(night){ ctx.globalAlpha=0.22; R(x, y, 22, 8, '#ffe6a8'); }
      ctx.globalAlpha=1; ctx.textBaseline='alphabetic'; }
  }

  function draw(dt){
    t += dt;
    var now = clockFn(); curHour = hourOf(now);
    var wthr = updateWeather(now); snowCap = wthr.snow > 0;
    var n = hourToNight(curHour);
    updatePeds(curHour, dt); updateCats(curHour, dt); updateTrain(dt); updateBlimp(dt);

    if(seasonId!=null){
      // gera prédios a partir dos tokens — sem teto; salto grande (retomada) -> snap.
      var target = 2 + Math.floor(tokens() / tokPerBuild());
      if(target - builtNormals > 60){ rebuildCity(); }
      else { var made=0; while(builtNormals < target && made < 8){
        var nb = genNormal(builtNormals); nb.wx = frontier; city.push(nb);
        frontier += nb.gap; builtNormals++; made++;
        dust.push({ wx:nb.wx+nb.w/2, age:0 }); } }
    }
    // câmera segue a fronteira; prédios antigos deslizam pra esquerda e são descartados.
    var camTarget = Math.max(0, frontier - W*0.72);
    if(snapCam){ camX = camTarget; snapCam=false; }
    else camX += (camTarget - camX) * Math.min(1, dt*0.004);
    while(city.length>3 && (city[0].wx + city[0].w - camX) < -60) city.shift();

    // céu
    var bandH = Math.ceil(BASE/SKY_D.length);
    for(var i=0;i<SKY_D.length;i++) R(0, i*bandH, W, bandH+1, mix(SKY_D[i], SKY_N[i], n));
    // estrelas
    var sa = ss((n-0.3)/0.7);
    if(sa>0){ ctx.globalAlpha=sa;
      for(var s=0;s<26;s++){ var stx=(s*61)%W, sty=(s*37)%70; if(((t*0.002+s)|0)%5!==0) R(stx,sty,1,1,'#fff'); }
      ctx.globalAlpha=1; }
    // sol -> lua
    var sunY=18+n*30, sunX=210;
    ctx.globalAlpha=0.5; R(sunX-9,sunY-9,26,26,mix('#ffe9b0','#5a5f8a',n)); ctx.globalAlpha=1;
    R(sunX-4,sunY-4,16,16, mix('#fff2c8','#cfd6ff',n));
    ctx.globalAlpha=0.5*(1-n*0.7); R(0,BASE-16,W,16, mix('#f4c88a','#7a4c62',n)); ctx.globalAlpha=1;
    // nuvens
    for(var c=0;c<clouds.length;c++){ var cl=clouds[c]; if(!reduce) cl.x+=cl.s*(dt*0.06); if(cl.x>W+30) cl.x=-30;
      ctx.globalAlpha=0.5-n*0.25; var cc=mix('#e0b0a8','#3a3358',n);
      if(wthr.rain>0) cc=mix(cc,'#2a2a38',0.5*wthr.rain); // nuvens escurecem um tom na chuva
      R(cl.x,cl.y,cl.w,3,cc); R(cl.x+3,cl.y-2,cl.w-8,3,cc); R(cl.x+6,cl.y+2,cl.w-4,2,cc); ctx.globalAlpha=1; }
    // DIRIGÍVEL raro cruzando o céu, atrás do skyline
    drawBlimp(n>0.4);
    // silhueta distante (parallax)
    drawBackline(n);
    // prédios da frente (normais + especiais)
    for(var f=0;f<city.length;f++){ var b=city[f]; if(b.rise<1) b.rise=Math.min(1,b.rise+dt/480);
      var sx=b.wx-camX; if(sx>W || sx+b.w<0) continue;
      if(b.kind==='special') drawSpecial(b,sx,n); else drawNormal(b,sx,n); }
    // MARCO: jardim na orla — ancorado no mundo (rola com a cidade; renasce na ponta)
    groundMarker('garden', 24, function(sx){ drawGarden(n, sx); });
    // HABITANTES nos telhados: gatos + varais entre prédios vizinhos (varal some na chuva)
    drawCats(); drawVarais(wthr.rain);
    // TREM cruzando a orla (rente à água), janelas acesas à noite
    drawTrain(n>0.4);
    // árvores e postes (primeiro plano fixo)
    for(var tr=0;tr<TREES.length;tr++){ var tx=TREES[tr]; R(tx+1,BASE-8,2,8,mix('#4a3a3a','#2a2230',n));
      var gc=mix('#4f7355','#2f4740',n); R(tx-2,BASE-14,8,7,gc); R(tx-1,BASE-16,6,3,gc); }
    var lampOn = n>0.32;
    for(var l=0;l<LAMPS.length;l++){ var lx=LAMPS[l]; R(lx,BASE-11,1,11,mix('#5a4a55','#2a2230',n));
      R(lx-1,BASE-13,3,3, lampOn?'#ffdf9a':'#4a4258');
      if(lampOn){ ctx.globalAlpha=0.35; R(lx-3,BASE-15,7,7,'#ffdf9a');
        if(wthr.rain>0){ ctx.globalAlpha=0.25*wthr.rain; R(lx-4,BASE-18,9,11,'#ffdf9a'); } // halo molhado no poste
        ctx.globalAlpha=1; } }
    // PEDESTRES na orla (primeiro plano)
    drawPeds();
    // água
    R(0,BASE,W,1, mix('#c9a06a','#4a3a55',n));
    R(0,BASE+1,W,H-BASE-1, mix('#3a4a6a','#141230',n));
    R(0,BASE+1,W,10, mix('#4a5a7a','#1c1838',n));
    // reflexos (só dos prédios normais) — na CHUVA ficam mais intensos e longos (cena molhada)
    var wet = wthr.rain;
    ctx.globalAlpha=0.30 + 0.22*wet;
    for(var rf=0;rf<city.length;rf++){ var rb=city[rf]; if(rb.kind!=='normal' || rb.rise<0.9) continue;
      var rsx=rb.wx-camX; if(rsx>W || rsx+rb.w<0) continue;
      R(rsx, BASE+1, rb.w, Math.min(rb.h*(1+0.4*wet),H-BASE-1), rb.body); }
    ctx.globalAlpha=1;
    ctx.globalAlpha=0.4-n*0.15; R(sunX+2,BASE+1,6,H-BASE-1, mix('#ffe9b0','#8a90c8',n)); ctx.globalAlpha=1;
    if(!reduce){ for(var sh=0;sh<3;sh++){ var sy=BASE+6+((t*0.01+sh*9)%(H-BASE-6));
      ctx.globalAlpha=0.12; R(0,sy,W,1,mix('#cfe0f0','#3a4568',n)); ctx.globalAlpha=1; } }
    // NEBLINA de manhã sobre a orla/água (bandas com parallax lento)
    drawFog(wthr.fog, dt, n);
    // MARCO: farol num quebra-mar na ponta da costa — ancorado no mundo; quando some pela
    // esquerda, a cidade ergue um farol novo na ponta atual (o antigo rola pra fora).
    groundMarker('lighthouse', 44, function(sx){ drawLighthouse(n, t, sx); }, '⟡ um novo farol se ergueu na ponta');
    // MARCO: balsa cruzando a água
    if(store.marcos.ferry) drawFerry(n, dt);
    // MARCO: lanternas de festival na orla
    if(store.marcos.festival) drawFestival(n, t);
    // poeira nos prédios novos
    for(var d=dust.length-1;d>=0;d--){ var du=dust[d]; du.age+=dt*0.05; if(du.age>10){ dust.splice(d,1); continue; }
      ctx.globalAlpha=0.5-du.age*0.05; R(du.wx-camX-3, BASE-2-du.age, 6, 2, '#8a7b8a'); ctx.globalAlpha=1; }
    // luzinhas de subagente novo subindo
    for(var mi=motes.length-1;mi>=0;mi--){ var mo=motes[mi]; mo.age+=dt*0.05; mo.y-=0.16*dt*0.06+0.15;
      if(mo.age>mo.life){ motes.splice(mi,1); continue; }
      var mf=mo.age/mo.life; ctx.globalAlpha=Math.max(0,1-mf);
      R(mo.x, mo.y, 1, 1, mf<0.5?'#ffe6a8':'#ffcf7a');
      if(mf<0.3){ ctx.globalAlpha=0.3; R(mo.x-1,mo.y,3,1,'#ffe6a8'); R(mo.x,mo.y-1,1,3,'#ffe6a8'); }
      ctx.globalAlpha=1; }
    // recompensa: coraçõezinhos discretos (construção nova / vontade cumprida)
    for(var hi=hearts.length-1;hi>=0;hi--){ var hz=hearts[hi]; hz.age++; hz.y-=0.4;
      if(hz.age>hz.life){ hearts.splice(hi,1); continue; }
      ctx.globalAlpha=Math.max(0,1-hz.age/hz.life); var hc='#e08aa0';
      R(hz.x,hz.y,1,1,hc); R(hz.x+2,hz.y,1,1,hc); R(hz.x-1,hz.y+1,5,1,hc); R(hz.x,hz.y+2,3,1,hc); R(hz.x+1,hz.y+3,1,1,hc);
      ctx.globalAlpha=1; }
    // passarinhos ao entardecer
    if(n<0.6){ ctx.globalAlpha=0.6*(1-n);
      for(var bi=0;bi<birds.length;bi++){ var bd=birds[bi]; if(!reduce) bd.x-=0.05*dt*0.06; if(bd.x<-4) bd.x=W+Math.random()*20;
        R(bd.x,bd.y,1,1,'#2a2440'); R(bd.x-1,bd.y-1,1,1,'#2a2440'); R(bd.x+1,bd.y-1,1,1,'#2a2440'); }
      ctx.globalAlpha=1; }
    // MARCO: fogos na noite (2-3 rajadas por noite, com reflexo na água)
    if(store.marcos.fireworks) drawFireworks(n, t, dt);
    // CLIMA em primeiro plano: chuva (traços + gotas) e neve (flocos) sobre tudo
    drawRain(wthr.rain, dt);
    drawSnow(wthr.snow, dt);

    // virada de temporada em runtime: despedida calma (fade) e recomeço
    if(fadeDir){
      fadeT += dt;
      if(fadeDir===1){ var a=Math.min(1,fadeT/2200); ctx.globalAlpha=a; R(0,0,W,H,'#0a0710'); ctx.globalAlpha=1;
        if(fadeT>=2200){ initSeason(pendingSeason); fadeDir=2; fadeT=0; } }
      else { var a2=1-Math.min(1,fadeT/2200); ctx.globalAlpha=a2; R(0,0,W,H,'#0a0710'); ctx.globalAlpha=1;
        if(fadeT>=2200){ fadeDir=0; } }
    }
  }

  // ============================================================================
  // RECREIO — "Mario na nossa cidade": um platformer de CONTROLE TOTAL (só AO VIVO).
  // Você anda ←→ e pula (espaço/↑) sobre OS TELHADOS da própria cidade, com física
  // de plataforma clássica: aceleração/atrito, gravidade, pulo de altura variável
  // (segurar = pulo maior), coyote time (~80ms) e input buffer (~100ms). Os vãos
  // entre prédios são buracos REAIS — cair = perde e volta suave pro início (recorde
  // salvo). No caminho: tokens dourados no ar e sobre telhados, caixas de cache
  // (bloco ?) que soltam +tokens quando batidas por baixo, e "bugs" que dá pra pisar.
  // Agente OCIOSO -> PAUSA "o agente terminou". Agente esperando DECISÃO -> PAUSA
  // NA HORA com painel âmbar "precisa da sua decisão". ESC/botão volta pra cidade.
  //
  // DESAFIOS (ethos: desafio sim, frustração não — perder = reset suave igual queda):
  //  · bug agora MACHUCA no toque de LADO (perde) e continua STOMPÁVEL por cima (+token);
  //  · ANDAIMES/ELEVADORES móveis sobre vãos largos — pousar CARREGA a jogadora (herda a
  //    velocidade da plataforma, o clássico); horizontais vão-e-voltam, verticais sobem-descem;
  //  · ANTENAS/DUTOS no telhado — sólidos de lado (bloqueiam, NÃO matam; pula por cima);
  //  · DRONE de patrulha (senoidal na altura de pulo) — tocar MATA, NÃO é stompável (perigo aéreo), raro;
  //  · BALANCEAMENTO por distância (determinístico pela seed): ~10 telhados suaves como hoje e a
  //    dificuldade cresce devagar (mais vãos largos/móveis/bugs, e drones só depois). Ver rcSpec().
  //
  // ZOOM (FIX "o personagem é um borrão"): o recreio renderiza o MUNDO com câmera
  // 2x (RZ) — o canvas segue 256×144, mas cada px de mundo vira 2×2 na tela, como
  // um NES com tiles grandes. A janela visível é 128×72 de mundo; a física roda em
  // unidades de MUNDO (vãos/alturas reproporcionados) e a jogadora tem 5×8 de mundo
  // = sprite EFETIVO de 10×16 px na tela (~11% da altura, proporção de Mario).
  // A cidade calma (modo normal) fica intocada em 1x.
  // ============================================================================
  var mode = 'city', rc = null, rcBest = 0, rcAuto = false;
  try { rcBest = parseInt(localStorage.getItem('tt-recreio-best'), 10) || 0; } catch(e){}
  // física em UNIDADES DE MUNDO (px de mundo por quadro de ~16ms; k=dt/16).
  // JUMP -3.0 c/ GRAV 0.30 => ápice ~15 de mundo (30px de tela ≈ 21% da altura, pulo
  // de Mario); alcance máx do pulo = MAXRUN*(2*3/0.3) = 28 de mundo (vãos <= ~17).
  var RZ=2, RVIEW=W/RZ /*128*/, RBASE=60 /*linha d'água do recreio (mundo)*/, RWATER=68,
      GRAV=0.30, JUMP=-3.0, JUMPCUT=0.45, ACC=0.22, FRIC=0.20, MAXRUN=1.4,
      COYOTE=80, BUFFER=100, ANCHOR=42, PW=5, PH=8, LEDGE=2 /*perdão de beirada no POUSO (mundo)*/;
  var keys = { left:false, right:false };   // ESTADO das teclas (segurar = anda contínuo)

  // BALANCEAMENTO por distância -> [0..1] (0 = suave; sobe devagar depois de ~6 telhados).
  function rcDiff(di){ return Math.max(0, Math.min(1, (di - 6) / 30)); }
  // ESPECIFICAÇÃO DETERMINÍSTICA de 1 telhado gerado. É a ÚNICA fonte de verdade da
  // dificuldade: rcGenSeg constrói as entidades a partir dela e os testes a leem direto
  // (window.__rc.spec) p/ asseverar "dificuldade cresce com a distância" por faixa de bi.
  // di = rc.bi-40 (0 = 1º telhado gerado). Todos os sorteios são SEMPRE tirados (sem
  // curto-circuito) p/ a sequência ser estável e a rampa, previsível.
  function rcSpec(seedn, bi){
    var di = bi - 40, d = rcDiff(di);
    var r = seededRand((seedn ^ Math.imul(bi+9, 0x9e3779b9)) >>> 0);
    var w = 20 + Math.floor(r()*20);         // telhado 20-39 de mundo (40-78px na tela)
    var top = 32 + Math.floor(r()*10);       // altura 32-41 (diferença <= 9 -> pulável, ápice 15)
    var tokR=r(), blkR=r(), bugR=r(), obR=r(), obH=r(), obK=r(),
        drR=r(), drA=r(), drO=r(), drP=r(), drD=r(), wideR=r(), gapW=r(), mvR=r(), mvK=r(), mvD=r();
    var tok   = tokR < 0.55;
    var block = blkR < 0.26;
    var bug   = (w > 26) && (bugR < 0.12 + 0.20*d);                 // + frequente com a distância
    var obst  = (di >= 5 && w > 22 && obR < 0.10 + 0.22*d)          // antena/duto a partir de di>=5
      ? { oh: 5 + Math.floor(obH*3), kind: obK < 0.5 ? 'ant' : 'duct' } : null;
    var drone = (di >= 10 && drR < 0.08 + 0.12*d)                   // aéreo, raro, só depois de 10
      ? { amp: 5 + Math.floor(drA*4), off: 14 + Math.floor(drO*7), ph: drP*6.283, dir: drD<0.5?1:-1, spd: 0.5 + 0.4*d } : null;
    var wide  = wideR < (0.35 + 0.40*d);                           // vãos largos crescem c/ a distância
    var gap   = wide ? (11 + Math.floor(gapW*(4 + Math.floor(3*d)))) : (4 + Math.floor(gapW*4));
    if(gap > 17) gap = 17;                                         // SEMPRE pulável sem ajuda (alcance ~28)
    var mover = (wide && di >= 8 && gap >= 11 && mvR < (0.30 + 0.30*d))   // móvel sobre vão largo (bônus)
      ? { kind: (mvK < 0.5 && gap >= 14) ? 'h' : 'v', dir: mvD<0.5?1:-1, spd: (mvK<0.5&&gap>=14) ? 0.5+0.3*d : 0.4+0.3*d } : null;
    // CHECKPOINT (bandeirinha) a cada ~15 telhados — derivado de (seedn,bi) SEM tocar no stream
    // r() acima (rampa de dificuldade intacta). Fase pela seed; nunca no começo (di<15).
    var flag = (di >= 15) && ((di % 15) === (seedn % 15));
    // ESCUDO DE CACHE: ~25% dos blocos ? soltam o computadorzinho no lugar do token. Hash
    // INDEPENDENTE (não consome r()) -> determinístico e sem alterar nenhuma outra spec.
    var shield = block && (seededRand((seedn ^ Math.imul(bi+31, 0x85ebca6b)) >>> 0)() < 0.25);
    return { w:w, top:top, tok:tok, block:block, bug:bug, obst:obst, drone:drone, gap:gap, wide:wide, mover:mover,
             flag:flag, shield:shield };
  }
  function rcGenSeg(){                       // constrói 1 telhado + itens + desafios a partir da spec
    var s = rcSpec(rc.seedn, rc.bi), x = rc.frontierX, w = s.w, top = s.top;
    // VITRINE: com o auto-piloto dirigindo, o terreno é sempre FOLGADO — vãos curtos, sem
    // andaimes e telhados quase nivelados -> todo pulo é trivial (zero quedas). A dificuldade
    // CHEIA (vãos largos, andaimes, desníveis, drones) volta no instante que o visitante assume.
    if(rcAuto){
      if(s.gap>8) s.gap=8; s.mover=null;
      var pv = rc.plats.length ? rc.plats[rc.plats.length-1].top : top;
      top = Math.max(pv-3, Math.min(pv+3, top));
    }
    rc.plats.push({ x:x, w:w, top:top, thin:false });
    var cx = x + (w>>1);
    if(s.tok)   rc.toks.push({ x:cx, y:top-8, got:false });
    if(s.block) rc.blocks.push({ x:cx-6, w:12, y:top-20, h:8, used:false, shield:s.shield });
    if(s.flag)  rc.flags.push({ x:x + Math.min(8, w>>1), platX:x, top:top, bi:rc.bi, raised:false });
    if(s.bug)   rc.bugs.push({ x0:x+4, x1:x+w-4, x:x+6, dir:1, top:top, dead:false });
    if(s.obst)  rc.obst.push({ x:cx+3, w:3, y:top-s.obst.oh, h:s.obst.oh, kind:s.obst.kind });
    if(s.drone && !rcAuto) rc.drones.push({ x0:x-2, x1:x+w+2, x:x+(w>>1), dir:s.drone.dir,
      baseY:top-s.drone.off, y:top-s.drone.off, amp:s.drone.amp, ph:s.drone.ph, spd:s.drone.spd });
    rc.frontierX = x + w;
    if(s.mover){ var g=s.gap, mw=8, mx=rc.frontierX + Math.max(1, Math.floor((g-mw)/2));
      if(s.mover.kind==='h') rc.movers.push({ kind:'h', x:mx, y:top+2, w:mw, dx:0, dy:0,
        a:rc.frontierX+1, b:rc.frontierX+g-mw-1, dir:s.mover.dir, spd:s.mover.spd });
      else rc.movers.push({ kind:'v', x:mx, y:top+1, w:mw, dx:0, dy:0,
        a:top-6, b:top+8, dir:s.mover.dir, spd:s.mover.spd }); }
    rc.frontierX += s.gap; rc.bi++;
  }
  function rcGen(){ while(rc.frontierX < rc.camX + RVIEW + 50) rcGenSeg(); }
  function rcClean(){
    while(rc.plats.length>3 && rc.plats[0].x + rc.plats[0].w < rc.camX - 30) rc.plats.shift();
    while(rc.toks.length   && rc.toks[0].x   < rc.camX - 30) rc.toks.shift();
    while(rc.blocks.length && rc.blocks[0].x + rc.blocks[0].w < rc.camX - 30) rc.blocks.shift();
    while(rc.bugs.length   && rc.bugs[0].x1  < rc.camX - 30) rc.bugs.shift();
    while(rc.movers.length && rc.movers[0].x + rc.movers[0].w < rc.camX - 30) rc.movers.shift();
    while(rc.obst.length   && rc.obst[0].x  + rc.obst[0].w  < rc.camX - 30) rc.obst.shift();
    while(rc.drones.length && rc.drones[0].x1 < rc.camX - 30) rc.drones.shift();
    while(rc.flags.length  && rc.flags[0].platX < rc.camX - 30) rc.flags.shift();
    while(rc.items.length  && rc.items[0].x   < rc.camX - 30) rc.items.shift();
  }
  // monta o nível: um INTRO determinístico (on-ramp gentil + testável) e segue com
  // a cidade gerada pela seed. Recomeça daqui a cada queda. Coordenadas de MUNDO.
  function rcBuild(){
    rc.plats=[]; rc.toks=[]; rc.blocks=[]; rc.bugs=[]; rc.fx=[]; rc.movers=[]; rc.obst=[]; rc.drones=[];
    rc.flags=[]; rc.items=[]; rc.cp=null; rc.shield=false; rc.iframes=0; rc.squashT=0; rc.glitchT=0;
    rc.frontierX=0; rc.bi=40; rc.score=0; rc.vx=0; rc.vy=0; rc.camX=0; rc.onMover=null; rc.deadMsg='';
    rc.dead=false; rc.deadT=0; rc.coyote=0; rc.buffer=0; rc.jumpHeld=false; rc.introT=0; rc.facing=1;
    rc.plats.push({ x:0,  w:64, top:40, thin:false });     // P0: telhado-berço largo
    rc.plats.push({ x:6,  w:14, top:30, thin:true  });     // sacada suspensa (one-way) sobre o berço
    rc.blocks.push({ x:36, w:12, y:20, h:8, used:false }); // bloco ? (caixa de cache)
    rc.toks.push({ x:22, y:32, got:false });                // token no ar (pega andando)
    rc.plats.push({ x:78, w:34, top:36, thin:false });      // P1 depois de um vão real (64..78)
    rc.toks.push({ x:95, y:28, got:false });
    rc.plats.push({ x:126, w:30, top:42, thin:false });     // P2 depois de outro vão (112..126)
    rc.frontierX = 156;
    rcGen();
    rc.px = 12; rc.py = 40; rc.onGround = true;              // nasce sobre P0
  }
  // RESSURGE no ÚLTIMO CHECKPOINT (bandeira) mantendo os tokens — regenera o mundo a partir do
  // bi da bandeira (geração determinística pela seed) e recoloca a jogadora em cima daquele telhado.
  function rcRespawn(){
    rc.plats=[]; rc.toks=[]; rc.blocks=[]; rc.bugs=[]; rc.fx=[]; rc.movers=[]; rc.obst=[]; rc.drones=[];
    rc.flags=[]; rc.items=[]; rc.shield=false; rc.iframes=0; rc.squashT=0; rc.glitchT=0;
    rc.vx=0; rc.vy=0; rc.onMover=null; rc.dead=false; rc.deadT=0; rc.coyote=0; rc.buffer=0;
    rc.jumpHeld=false; rc.facing=1;                          // rc.score PRESERVADO (tokens mantidos)
    rc.bi = rc.cp.bi; rc.frontierX = rc.cp.platX;
    rc.px = rc.cp.platX + 6; rc.py = rc.cp.top; rc.onGround = true;
    rc.camX = Math.max(0, rc.px - ANCHOR);                    // câmera ANTES do rcGen -> mundo já nasce ao redor
    rcGen();
    for(var i=0;i<rc.flags.length;i++) if(rc.flags[i].bi===rc.cp.bi){ rc.flags[i].raised=true; break; } // já hasteada
    if(rcAuto) rc.iframes = 1000;   // vitrine: respawn com folga p/ o auto-piloto não travar num hazard colado no checkpoint
  }
  function startRecreio(){
    if(mode==='recreio') return;
    if(real && !liveNow) return;                 // só entra AO VIVO
    if(seasonId==null && real) return;
    mode='recreio';
    rc = { t:0, seedn:((store && store.seed) ? store.seed : ((Math.random()*1e9)|0)) };
    rcBuild();
    if(elRecreio) elRecreio.textContent = '◼ sair';
    // foco de teclado pra janela (frameless às vezes não entrega keydown); o clique
    // no canvas (rcJump abaixo) é a rede de segurança se o foco falhar.
    try { if(typeof window!=='undefined' && window.focus) window.focus(); } catch(e){}
    try { if(cv && cv.focus) cv.focus(); } catch(e){}
  }
  function exitRecreio(){ mode='city'; rc=null; snapCam=true; keys.left=keys.right=false;
    if(elRecreio) elRecreio.textContent='▶ recreio'; }
  // HOOK HEADLESS (inócuo em produção): expõe a geração determinística e o estado do recreio
  // p/ os testes asseverarem pouso de beirada e a curva de dificuldade por faixa de distância.
  try { if(typeof window!=='undefined') window.__rc = {
    spec: rcSpec, diff: rcDiff,
    state: function(){ return rc; },                         // estado vivo (arrays de entidades)
    land: function(px, pf, ft, l){ return rcLanding(px, pf, ft, l); } }; } catch(e){}

  // HOOK HEADLESS do MODO CIDADE (inócuo em produção): injeta o relógio e expõe a curva do
  // céu, a rotina das janelas ("a cidade dorme com você"), o clima determinístico e os
  // contadores (CAP) dos habitantes — pros testes dirigirem a HORA/DATA sem DOM real.
  try { if(typeof window!=='undefined') window.__env = {
    setClock: function(fn){ clockFn = fn; wCacheKey = null; },  // injeta a hora local (limpa o cache do clima)
    night: function(){ return nightPhase(); },
    nightAtHour: function(h){ return hourToNight(h); },
    weather: function(){ return updateWeather(clockFn()); },
    weatherAt: function(ms){ return weatherAt(new Date(ms)); },
    // fração de janelas ACESAS numa hora (amostra a MESMA distribuição de makeWin/litWin).
    litFraction: function(hour, n){ var r=seededRand(0x51ed270b), lit=0; n=n||4000;
      for(var i=0;i<n;i++){ if(litWin(hour, makeWin(r,0,0))) lit++; } return lit/n; },
    counts: function(){ return { pedestres:peds.length, gatos:cats.length, flocos:snowP.length, gotas:rainP.length, varais:varalCount }; },
    // JANELAS COM PERSONALIDADE: gera um prédio normal e desenha-o (rise=1) p/ os testes
    // asseverarem forma/vitrine/arco por classe de prédio (persona/winShape são determinísticos).
    seed: function(){ return store.seed; },
    makeNormal: function(i){ return genNormal(i); },
    drawNormalAt: function(b, sx, nn){ b.rise=1; drawNormal(b, sx, nn); }
  }; } catch(e){}

  function rcDoJump(){ rc.vy=JUMP; rc.onGround=false; rc.onMover=null; rc.coyote=0; rc.squashT=18; } // agachadinha de antecipação (1 frame, sem atrasar o input)
  function rcJump(){ if(!rc || rc.dead || (real && !liveNow)) return;
    if(rc.onGround || rc.coyote>0) rcDoJump(); else rc.buffer=BUFFER; }  // buffer: pulo bufferizado
  // ATTRACT MODE (SÓ na vitrine do site, nunca no app real): um piloto automático
  // joga sozinho — corre pra direita e pula na beirada da superfície em que está,
  // lendo a MESMA geometria de pouso do jogo (rcLanding). Com o terreno folgado da
  // vitrine (vãos curtos, telhados nivelados, bugs/antenas inofensivos, sem quique de
  // pisão), o arco sempre cai no miolo do próximo telhado -> travessia impecável.
  // Qualquer toque do visitante (tecla/clique no canvas) chama rcTakeover e assume.
  function rcAutoPilot(){
    if(!rc || rc.dead) return;
    keys.right = true; keys.left = false;                 // sempre avança
    if(!rc.onGround) return;                              // só decide pulo no chão
    // Pula SÓ na beirada da SUPERFÍCIE em que está — telhado, bloco ? ou antena/duto (todos
    // são chão elevado: andar pra fora de qualquer um DERRAPA pra além do telhado e cai no vão).
    // Usa a MESMA rotina de pouso do jogo (rcLanding) p/ achar a superfície exata e sua beirada
    // direita, então nenhum tipo de plataforma escapa. Bugs/antenas são inofensivos aqui (não-
    // letais/não-bloqueantes), então só a beirada dispara o pulo — nunca cedo demais.
    var surf = rcLanding(rc.px, rc.py - 0.5, rc.py + 0.5, 0);
    if(surf && (surf.x1 - rc.px) < 6) rcJump();           // beirada à direita -> pula o vão
  }
  function rcTakeover(){                                  // 1ª interação do visitante -> devolve o controle
    if(!rcAuto) return;
    rcAuto = false; keys.left = keys.right = false;
    if(elAutoBadge) elAutoBadge.hidden = true;
  }
  // POEIRINHA (2-3 partículas cinza) — sobem devagar e somem; usada ao pousar e ao arrancar do repouso.
  function rcDust(x, y, spread){ for(var s=0, n=2+((Math.random()*2)|0); s<n; s++)
    rc.fx.push({ x:x + (Math.random()*spread - spread/2), y:y-1, age:0, life:12,
      col:'#9a94a0', vy:-0.14, vx:(Math.random()*0.3 - 0.15) }); }
  // MORTE unificada (queda/bug/drone): recado próprio + salva recorde. Reset suave depois.
  function rcDie(msg){ if(rc.dead) return; rc.dead=true; rc.deadT=0; rc.deadMsg=msg||'you fell';
    if(rc.score>rcBest){ rcBest=rc.score; try{localStorage.setItem('tt-recreio-best',String(rcBest));}catch(e){} } }
  // DANO com ESCUDO: com o computadorzinho ativo, um toque de bug/drone TRAVA E QUEBRA o
  // computador (glitch de 2-3 frames), dá ~1s de invencibilidade (jogadora piscando) e SEGUE
  // VIVA; sem escudo, morre como sempre. (Cair na água NUNCA é salvo pelo escudo — usa rcDie.)
  function rcHurt(msg){
    if(rc.dead || rc.iframes>0) return;
    if(rc.shield){ rc.shield=false; rc.iframes=1000; rc.glitchT=50;   // glitch de 2-3 frames; ~1s invencível
      for(var s=0;s<6;s++) rc.fx.push({ x:rc.px, y:rc.py-6, age:0, life:14, col:(s&1)?'#ff5aa8':'#8ad8ff' });
      return; }
    rcDie(msg);
  }
  // POUSO por SOBREPOSIÇÃO da CAIXA DOS PÉS (largura real, PW) que cruza o topo de cima
  // pra baixo -> devolve a superfície {top, x0, x1, mover}. Plataformas são SÓLIDAS POR
  // CIMA e VAZADAS POR BAIXO (só entram caindo). `ledge` = perdão de beirada (mundo): no
  // POUSO aéreo usamos LEDGE (pega a pontinha do pé / jump quase-curto e faz um snap pra
  // borda); ANDANDO usamos 0 (senão flutuaria além da beirada). Inclui telhados, bloco ?,
  // obstáculos (topo sólido) e plataformas MÓVEIS (p/ carregar a jogadora).
  function rcLanding(px, prevFeet, feet, ledge){
    var best=null, res=null, hx0=px-PW/2, hx1=px+PW/2, L=ledge||0;
    function consider(x0, x1, top, mover){
      if(hx1 > x0 - L && hx0 < x1 + L && prevFeet <= top && feet >= top && (best==null || top < best)){
        best=top; res={ top:top, x0:x0, x1:x1, mover:mover||null }; } }
    for(var i=0;i<rc.plats.length;i++){ var p=rc.plats[i]; consider(p.x, p.x+p.w, p.top, null); }
    for(var b=0;b<rc.blocks.length;b++){ var q=rc.blocks[b]; consider(q.x, q.x+q.w, q.y, null); }
    for(var o=0;o<rc.obst.length;o++){ var ob=rc.obst[o]; consider(ob.x, ob.x+ob.w, ob.y, null); }
    for(var m=0;m<rc.movers.length;m++){ var mv=rc.movers[m]; consider(mv.x, mv.x+mv.w, mv.y, mv); }
    return res;
  }
  function rcStomp(px, prevFeet, feet){       // pisar em cima de um bug: bônus, NUNCA pune
    if(rcAuto) return false;                  // VITRINE: sem quique de pisão — o bounce fraco desviaria o arco do auto-piloto e o faria errar o telhado; o bug já é inofensivo aqui
    var hx0=px-PW/2, hx1=px+PW/2;
    for(var i=0;i<rc.bugs.length;i++){ var bg=rc.bugs[i]; if(bg.dead) continue;
      if(hx1>bg.x0-2 && hx0<bg.x1+2 && prevFeet<=bg.top-3 && feet>=bg.top-3){
        bg.dead=true; rc.score++; rc.vy=JUMP*0.6; rc.onGround=false;
        for(var s=0;s<4;s++) rc.fx.push({ x:bg.x, y:bg.top-3, age:0, life:16 }); return true; } }
    return false;
  }
  function rcBonk(px, prevHead, head){        // bater com a CABEÇA por baixo do bloco ? -> +token
    var hx0=px-PW/2, hx1=px+PW/2;             // (o bloco ? é a EXCEÇÃO: sólido por baixo)
    for(var b=0;b<rc.blocks.length;b++){ var q=rc.blocks[b], bot=q.y+q.h;
      if(hx1>q.x && hx0<q.x+q.w && prevHead>=bot && head<=bot){
        rc.py = bot + PH; rc.vy = 0.4;                       // trava a cabeça e começa a cair
        if(!q.used){ q.used=true;
          if(q.shield){                                      // ESCUDO DE CACHE: sai o computadorzinho (em vez de token)
            rc.items.push({ x:q.x+q.w/2, y:q.y, y0:q.y, restY:q.y-8, age:0 });
            for(var si=0;si<5;si++) rc.fx.push({ x:q.x+q.w/2, y:q.y, age:0, life:18, col:'#8ad8ff' }); }
          else { rc.score++;                                 // bloco comum: token dourado
            for(var s=0;s<5;s++) rc.fx.push({ x:q.x+q.w/2, y:q.y, age:0, life:18 }); } }
        return; } }
  }
  function rcUpdate(dt){
    if(rcAuto) rcAutoPilot();                  // vitrine: piloto automático dirige as teclas
    var k = Math.min(2.2, dt*0.0625);          // dt/16
    rc.t += dt; if(rc.introT<9999) rc.introT += dt;
    if(rc.squashT>0) rc.squashT=Math.max(0, rc.squashT-dt); // squash&stretch / antecipação (peso)
    if(rc.iframes>0) rc.iframes=Math.max(0, rc.iframes-dt); // invencibilidade pós-escudo
    if(rc.glitchT>0) rc.glitchT=Math.max(0, rc.glitchT-dt); // glitch do computador quebrando
    var wasRest = rc.onGround && Math.abs(rc.vx) < 0.05;    // p/ a poeirinha ao ARRANCAR do repouso
    // PLATAFORMAS MÓVEIS: movem PRIMEIRO (guardam dx/dy); quem está EM CIMA é CARREGADO
    // pelo mesmo deslocamento (herda a velocidade da plataforma — o clássico).
    for(var m=0;m<rc.movers.length;m++){ var mv=rc.movers[m], step=mv.spd*mv.dir*k;
      if(mv.kind==='h'){ var ox=mv.x; mv.x+=step; if(mv.x<mv.a){mv.x=mv.a;mv.dir=1;} if(mv.x>mv.b){mv.x=mv.b;mv.dir=-1;} mv.dx=mv.x-ox; mv.dy=0; }
      else { var oy=mv.y; mv.y+=step; if(mv.y<mv.a){mv.y=mv.a;mv.dir=1;} if(mv.y>mv.b){mv.y=mv.b;mv.dir=-1;} mv.dy=mv.y-oy; mv.dx=0; } }
    if(rc.onMover && rc.onGround){ rc.px += rc.onMover.dx; rc.py += rc.onMover.dy; }
    // HORIZONTAL: aceleração + atrito, velocidade máxima (segurar seta = anda contínuo)
    var ax = (keys.right?ACC:0) - (keys.left?ACC:0);
    if(keys.right) rc.facing=1; else if(keys.left) rc.facing=-1; // virada segue a direção
    if(ax) rc.vx += ax*k;
    else if(rc.vx>0) rc.vx = Math.max(0, rc.vx - FRIC*k);
    else if(rc.vx<0) rc.vx = Math.min(0, rc.vx + FRIC*k);
    if(rc.vx> MAXRUN) rc.vx= MAXRUN; if(rc.vx< -MAXRUN) rc.vx=-MAXRUN;
    rc.px += rc.vx*k;
    if(rc.px<2){ rc.px=2; if(rc.vx<0) rc.vx=0; }             // não sai pela borda esquerda
    if(wasRest && Math.abs(rc.vx) > 0.12 && !reduce) rcDust(rc.px - rc.facing*2, rc.py, 2); // arrancou do repouso
    // OBSTÁCULOS de telhado (antena/duto): sólidos de LADO — bloqueiam quando os pés estão
    // ABAIXO do topo deles (não pulou por cima). Só bloqueia, NÃO mata (tropeçar não pune).
    for(var oi=0; !rcAuto && oi<rc.obst.length; oi++){ var o=rc.obst[oi];   // vitrine: não trava a velocidade do auto-piloto
      if(rc.py > o.y + 0.5 && rc.px+PW/2 > o.x && rc.px-PW/2 < o.x+o.w){
        if(rc.vx>0) rc.px = o.x - PW/2; else if(rc.vx<0) rc.px = o.x+o.w + PW/2; rc.vx=0; } }
    // VERTICAL: gravidade
    var wasOn=rc.onGround, prevFeet=rc.py, prevHead=rc.py-PH;
    rc.vy += GRAV*k; rc.py += rc.vy*k;
    var head=rc.py-PH; rc.onGround=false; rc.onMover=null;
    if(rc.vy>=0){                              // caindo -> pisa bug OU pousa em telhado/sacada/bloco/móvel
      if(!rcStomp(rc.px, prevFeet, rc.py)){
        var land = rcLanding(rc.px, prevFeet, rc.py, wasOn?0:LEDGE); // LEDGE só no pouso aéreo
        if(land!=null){ rc.py=land.top; rc.vy=0; rc.onGround=true; rc.onMover=land.mover;
          if(!wasOn) rc.px = Math.max(land.x0-1, Math.min(land.x1+1, rc.px)); } } // snap gentil pra beirada
    } else { rcBonk(rc.px, prevHead, head); } // subindo -> bloco ? é sólido por baixo (bonk)
    // ATERRISSOU: squash de 2-3 frames (1px mais baixa/larga) + poeirinha nos pés (peso).
    if(!wasOn && rc.onGround){ rc.squashT=50; if(!reduce) rcDust(rc.px, rc.py, 3); }
    // COYOTE TIME e INPUT BUFFER (qualidade de vida do pulo)
    if(wasOn && !rc.onGround && rc.vy>=0) rc.coyote=COYOTE;  // saiu ANDANDO da beirada
    else if(!rc.onGround && rc.coyote>0) rc.coyote=Math.max(0, rc.coyote-dt);
    rc.buffer=Math.max(0, rc.buffer-dt);
    if(rc.onGround && rc.buffer>0){ rcDoJump(); rc.buffer=0; }
    // câmera segue a jogadora; cidade se estende à frente e é limpa atrás
    rc.camX = Math.max(0, rc.px - ANCHOR);
    rcGen(); rcClean();
    // coleta de tokens (ar/telhado)
    for(var i=0;i<rc.toks.length;i++){ var tk=rc.toks[i]; if(tk.got) continue;
      if(Math.abs(tk.x-rc.px)<6 && Math.abs(tk.y-(rc.py-5))<9){ tk.got=true; rc.score++;
        for(var s=0;s<4;s++) rc.fx.push({ x:rc.px, y:rc.py-8, age:0, life:16 }); } }
    // COMPUTADORZINHO (escudo): pula pra fora do bloco e paira; pegar = escudo ativo.
    for(var it=rc.items.length-1; it>=0; it--){ var im=rc.items[it]; im.age += dt;
      var pe=Math.min(1, im.age/300);
      im.y = pe<1 ? im.y0 + (im.restY-im.y0)*ss(pe) : im.restY + Math.sin(rc.t*0.006);  // pop e paira
      if(Math.abs(im.x-rc.px)<6 && Math.abs(im.y-(rc.py-4))<8){ rc.shield=true;
        for(var s2=0;s2<5;s2++) rc.fx.push({ x:im.x, y:im.y, age:0, life:16, col:'#8ad8ff' }); rc.items.splice(it,1); continue; }
      if(im.x < rc.camX - 30) rc.items.splice(it,1); }
    // CHECKPOINT: passar pela bandeira grava o ponto de retorno (só avança).
    for(var fi=0;fi<rc.flags.length;fi++){ var fl=rc.flags[fi];
      if(!fl.raised && rc.px >= fl.x){ fl.raised=true; rc.cp={ bi:fl.bi, platX:fl.platX, top:fl.top };
        for(var s3=0;s3<4;s3++) rc.fx.push({ x:fl.x, y:fl.top-9, age:0, life:18 }); } }
    // bugs patrulham o telhado (ida e volta)
    for(var g=0;g<rc.bugs.length;g++){ var bg=rc.bugs[g]; if(bg.dead) continue;
      bg.x += bg.dir*0.4*k; if(bg.x<bg.x0){ bg.x=bg.x0; bg.dir=1; } if(bg.x>bg.x1){ bg.x=bg.x1; bg.dir=-1; } }
    // drones patrulham em VAI-E-VEM com oscilação SENOIDAL na altura de pulo
    for(var d2=0;d2<rc.drones.length;d2++){ var dr=rc.drones[d2];
      dr.x += dr.spd*dr.dir*k; if(dr.x<dr.x0){dr.x=dr.x0;dr.dir=1;} if(dr.x>dr.x1){dr.x=dr.x1;dr.dir=-1;}
      dr.ph += 0.05*k; dr.y = dr.baseY + Math.sin(dr.ph)*dr.amp; }
    // PERIGOS que MATAM (perder = reset suave, igual à queda) — com ESCUDO, o toque quebra o
    // computador e a jogadora segue viva (via rcHurt); a invencibilidade (iframes) ignora os toques.
    //  · bug tocado de LADO (não-stomp: o stomp já matou o bug antes e é pulado aqui);
    if(!rc.dead && !rcAuto && rc.iframes<=0) for(var bi2=0;bi2<rc.bugs.length;bi2++){ var b2=rc.bugs[bi2]; if(b2.dead) continue;
      if(rc.px+PW/2 > b2.x-2 && rc.px-PW/2 < b2.x+2 && rc.py > b2.top-4 && rc.py-PH < b2.top){ rcHurt('a bug got you'); break; } }
    //  · drone (perigo aéreo) em QUALQUER toque — não é stompável.
    if(!rc.dead && !rcAuto && rc.iframes<=0) for(var di2=0;di2<rc.drones.length;di2++){ var d3=rc.drones[di2];
      if(rc.px+PW/2 > d3.x-3 && rc.px-PW/2 < d3.x+3 && rc.py > d3.y-2.5 && rc.py-PH < d3.y+2.5){ rcHurt('a drone got you'); break; } }
    // CAIU num vão -> perde; escudo NÃO salva de cair (só de bug/drone). Volta suave.
    if(rc.py > RWATER) rcDie('you fell');
  }

  // painéis LEGÍVEIS (fundo escuro semi-opaco + borda + texto pixel grande, alto contraste).
  // amber=true -> paleta ÂMBAR (estado "precisa da sua decisão", distinto do "terminou").
  function rcPanel(a, b, amber){
    var bw=210, bh=46, bx=(W-bw)>>1, by=((H-bh)>>1)-2;
    var edge = amber ? '#c9895a' : '#4a3b52', tit = amber ? '#f2b47a' : '#ffd79a',
        sub  = amber ? '#ffd79a' : '#efe6df';
    ctx.globalAlpha=0.9; R(bx,by,bw,bh,'#0a0710'); ctx.globalAlpha=1;
    R(bx,by,bw,1,edge); R(bx,by+bh-1,bw,1,edge); R(bx,by,1,bh,edge); R(bx+bw-1,by,1,bh,edge);
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.font='bold 11px monospace'; ctx.fillStyle=tit; ctx.fillText(a, W/2, by+16);
    if(b){ ctx.font='bold 9px monospace'; ctx.fillStyle=sub; ctx.fillText(b, W/2, by+32); }
  }
  function rcStrip(txt){
    var bw=206, bh=14, bx=(W-bw)>>1, by=H-20;
    ctx.globalAlpha=0.82; R(bx,by,bw,bh,'#0a0710'); ctx.globalAlpha=1;
    R(bx,by,bw,1,'#3a2c48'); R(bx,by+bh-1,bw,1,'#3a2c48');
    ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.font='bold 8px monospace';
    ctx.fillStyle='#ffd79a'; ctx.fillText(txt, W/2, by+bh/2+1);
  }

  // ---------- SPRITE da jogadora (arte própria, nada de Mario) ----------
  // 10x16 px EFETIVOS na tela (mundo 5x8 sob zoom 2x): contorno escuro de 1px em
  // volta (o segredo de leitura dos sprites de NES), cabelo castanho, rosto com
  // olho (pisca no idle), camisa ÂMBAR saturada (#f2a63c — cor ÚNICA na cena, é a
  // âncora que os testes localizam), calça azul, sapatinhos. 3 frames de andar
  // (pernas + braço balançando), pulo com pernas recolhidas. Espelha ao virar.
  // Grade: K contorno, H cabelo, S pele, E olho, T camisa, G camisa clara,
  // D camisa sombra, L calça, B sapato, '.' transparente. Pés = linha 15 = rc.py.
  var RC_PAL = { K:'#1a1420', H:'#5a3a2e', S:'#f0c39a', E:'#241a24', T:'#f2a63c',
                 G:'#ffc966', D:'#c9822e', L:'#4a5a8a', B:'#3a2a26' };
  var RC_HEAD = [
    '...KKKK...',   // 0 topo do cabelo
    '..KHHHHK..',   // 1
    '.KHHHHHHK.',   // 2
    '.KHSSSSHK.',   // 3 franja + rosto
    '.KSSSSESK.',   // 4 olho no lado pra onde olha
    '.KSSSSSSK.'    // 5 queixo
  ];
  function rcFrame(arms, legs, blink){ // monta cabeça + tronco (com braços) + pernas
    var head = RC_HEAD.slice();
    if(blink) head[4] = '.KSSSSSSK.';
    return head.concat([
      '..KTTTTK..',                                  // 6 ombros
      (arms===1?'.KGTTTTDKS':arms===2?'SKGTTTTDK.':arms===3?'SKGTTTTDKS':'.KGTTTTDK.'), // 7
      (arms===1?'SKGTTTTDK.':arms===2?'.KGTTTTDKS':'.KGTTTTDK.'),                        // 8
      '.KSTTTTSK.',                                  // 9 mãozinhas
      '..KTTTTK..'                                   // 10 barra da camisa
    ], legs);
  }
  var RC_IDLE  = rcFrame(0, ['..KLLLLK..','..KLLLLK..','..KLK.KLK.','..KLK.KLK.','..KBBKKBBK'], false);
  var RC_BLINK = rcFrame(0, ['..KLLLLK..','..KLLLLK..','..KLK.KLK.','..KLK.KLK.','..KBBKKBBK'], true);
  var RC_WALK = [
    rcFrame(1, ['..KLLLLK..','..KLLLLK..','.KLK..KLK.','.KLK..KLK.','KBBK..KBBK'], false), // passada aberta
    rcFrame(0, ['..KLLLLK..','..KLLLLK..','...KLLK...','...KLLK...','..KBBBK...'], false), // passagem
    rcFrame(2, ['..KLLLLK..','..KLLLLK..','..KLK.KLK.','..KLK.KLK.','.KBBK.KBBK'], false)  // passada curta
  ];
  var RC_JUMP  = rcFrame(3, ['..KLLLLK..','..KLLLLK..','.KBBK.KBBK','..........','..........'], false); // pernas recolhidas
  // SQUASH & STRETCH de 1px: dw/dh (∈ {-1,0,+1}) esticam/achatam o sprite por interpolação
  // nearest-neighbor da grade 10x16 numa caixa (10+dw)×(16+dh), ancorada nos PÉS. A linha da
  // barra da camisa (âncora dos testes) mapeia sempre pra pés-6, então o Y medido não muda.
  function rcDrawSprite(rows, cx, feetY, face, dw, dh){
    dw=dw||0; dh=dh||0; var TW=10+dw, TH=16+dh, left = Math.round(cx - TW/2), top = Math.round(feetY - TH);
    for(var ry=0; ry<16; ry++){ var row = rows[ry],
        y0=Math.round(ry*TH/16), rh=Math.max(1, Math.round((ry+1)*TH/16)-y0);
      for(var rx=0; rx<10; rx++){
        var ch = row.charAt(face<0 ? 9-rx : rx);   // espelha ao olhar pra esquerda
        if(ch==='.') continue;
        var x0=Math.round(rx*TW/10), rw=Math.max(1, Math.round((rx+1)*TW/10)-x0);
        R(left+x0, top+y0, rw, rh, RC_PAL[ch]);
      } }
  }

  function drawRecreio(dt){
    if(!rc) return;
    // pausa: 'idle' (o agente terminou) OU 'decision' (o agente espera a MEL) —
    // decision chega via IPC e congela NA HORA, no primeiro frame, sem janela de 45s.
    var paused = real ? (agState !== 'live') : false;
    if(!paused){
      // morrer: com bandeira alcançada, volta pro ÚLTIMO CHECKPOINT (mantém tokens);
      // sem bandeira ainda, volta suave pro início (reset da run).
      if(rc.dead){ rc.deadT += dt; if(rc.deadT>1400){ if(rc.cp) rcRespawn(); else rcBuild(); } }
      else rcUpdate(dt);
    }
    var cam = rc.camX;
    // mundo -> tela com ZOOM RZ (2x): 1 px de mundo = 2x2 na tela (câmera mais perto).
    function WR(wx, wy, ww, wh, c){ R((wx-cam)*RZ, wy*RZ, ww*RZ, wh*RZ, c); }
    // fundo noturno + estrelas (skyline aceso)
    var bandH=Math.ceil((RBASE*RZ)/SKY_N.length);
    for(var i=0;i<SKY_N.length;i++) R(0,i*bandH,W,bandH+1, SKY_N[i]);
    ctx.globalAlpha=0.7; for(var s=0;s<26;s++){ var stx=(s*61)%W, sty=(s*37)%58;
      if(((rc.t*0.002+s)|0)%5!==0) R(stx,sty,1,1,'#fff'); } ctx.globalAlpha=1;
    // prédios (colunas até a água) e sacadas finas (one-way) — coordenadas de MUNDO
    for(var p=0;p<rc.plats.length;p++){ var pl=rc.plats[p];
      if(pl.x-cam>RVIEW || pl.x+pl.w-cam<0) continue;
      if(pl.thin){ WR(pl.x, pl.top, pl.w, 1.5, mix(BODY[3],'#000',0.15)); WR(pl.x, pl.top-0.5, pl.w, 0.5, ROOF[2]);
        for(var wxa=pl.x+2; wxa<pl.x+pl.w-2; wxa+=4) WR(wxa, pl.top+0.5, 0.5, 0.5, '#ffcf7a'); }
      else { WR(pl.x, pl.top, pl.w, RBASE-pl.top, BODY[((pl.x/5|0)%BODY.length+BODY.length)%BODY.length]);
        WR(pl.x, pl.top-1, pl.w, 1, ROOF[((pl.x/7|0)%ROOF.length+ROOF.length)%ROOF.length]);
        WR(pl.x, pl.top, 0.5, RBASE-pl.top, mix(BODY[3],'#fff',0.1));
        for(var wy=pl.top+3; wy<RBASE-2; wy+=4.5) for(var wx=pl.x+2; wx<pl.x+pl.w-2; wx+=4)
          WR(wx,wy,1.5,1.5,'#ffcf7a'); } }
    // água
    R(0,RBASE*RZ,W,H-RBASE*RZ, mix('#3a4a6a','#141230',0.72));
    // blocos ? (caixa de cache): dourado quando cheio, apagado depois de usado
    for(var b=0;b<rc.blocks.length;b++){ var q=rc.blocks[b];
      if(q.x-cam>RVIEW || q.x+q.w-cam<0) continue;
      var full=!q.used, bc=full?'#c98a3a':'#3a3450', ec=full?'#ffd479':'#5a5068';
      WR(q.x, q.y, q.w, q.h, bc); WR(q.x, q.y, q.w, 0.5, ec); WR(q.x, q.y, 0.5, q.h, ec);
      WR(q.x+q.w-0.5, q.y, 0.5, q.h, mix(bc,'#000',0.3)); WR(q.x, q.y+q.h-0.5, q.w, 0.5, mix(bc,'#000',0.3));
      if(full){ var qmx=q.x+q.w/2;                     // "?" pixelado (legível no zoom)
        WR(qmx-1.5, q.y+1.5, 3, 1, '#2c1a0a'); WR(qmx+1, q.y+2.5, 1, 1, '#2c1a0a');
        WR(qmx-0.5, q.y+3.5, 1.5, 1, '#2c1a0a'); WR(qmx-0.5, q.y+4.5, 1, 1, '#2c1a0a');
        WR(qmx-0.5, q.y+6, 1, 1, '#2c1a0a'); } }
    // tokens dourados (flutuam de leve)
    for(var ti=0;ti<rc.toks.length;ti++){ var tk=rc.toks[ti]; if(tk.got) continue;
      if(tk.x-cam<-3||tk.x-cam>RVIEW+3) continue;
      var bob=Math.sin(rc.t*0.006+tk.x)*1;
      WR(tk.x-1.5, tk.y-1.5+bob, 3, 3, '#ffd479'); WR(tk.x-0.5, tk.y-1+bob, 1, 1.5, '#fff2c0'); }
    // bugs (besourinho que se pisa)
    for(var g=0;g<rc.bugs.length;g++){ var bg=rc.bugs[g]; if(bg.dead) continue;
      if(bg.x-cam<-4||bg.x-cam>RVIEW+4) continue;
      WR(bg.x-2, bg.top-2.5, 4, 2.5, '#7a9a5a');                    // corpo
      WR(bg.x-1, bg.top-3, 2, 0.5, mix('#7a9a5a','#000',0.25));     // casco
      WR(bg.x+(bg.dir>0?1.5:-2), bg.top-2, 0.5, 0.5, '#241a24');    // olhinho
      WR(bg.x-2.5, bg.top-0.5, 0.5, 0.5, '#3a2e2a'); WR(bg.x+2, bg.top-0.5, 0.5, 0.5, '#3a2e2a'); } // patinhas
    // ANDAIMES/ELEVADORES móveis (limpeza de janela): prancha metálica pendurada por cabos
    for(var mi=0;mi<rc.movers.length;mi++){ var mv=rc.movers[mi];
      if(mv.x-cam>RVIEW || mv.x+mv.w-cam<0) continue;
      WR(mv.x+1, 0, 0.5, mv.y, mix('#8a8f9a','#000',0.4)); WR(mv.x+mv.w-1.5, 0, 0.5, mv.y, mix('#8a8f9a','#000',0.4)); // cabos
      WR(mv.x, mv.y, mv.w, 1.5, '#8a8f9a');                                 // prancha
      WR(mv.x, mv.y, mv.w, 0.5, '#c2c7d0');                                  // brilho do topo
      WR(mv.x, mv.y+1, mv.w, 0.5, mix('#8a8f9a','#000',0.35));               // sombra
      WR(mv.x, mv.y-1.5, 0.5, 1.5, '#6a7078'); WR(mv.x+mv.w-0.5, mv.y-1.5, 0.5, 1.5, '#6a7078'); } // guarda-corpo
    // OBSTÁCULOS de telhado (antena/duto): sólidos, pula-se por cima
    for(var obi=0;obi<rc.obst.length;obi++){ var ob=rc.obst[obi];
      if(ob.x-cam>RVIEW || ob.x+ob.w-cam<0) continue;
      if(ob.kind==='ant'){ WR(ob.x+1, ob.y, 1, ob.h, '#9aa0aa');            // mastro
        WR(ob.x, ob.y+1, 3, 0.5, '#8a90a0'); WR(ob.x+0.5, ob.y+2.5, 2, 0.5, '#8a90a0'); // travessas
        WR(ob.x+0.5, ob.y-1, 1, 1, (Math.floor(rc.t*0.004)%2===0)?'#ff6a6a':'#7a3a3a'); } // luz piscando
      else { WR(ob.x, ob.y, ob.w, ob.h, '#6a6560');                          // duto
        WR(ob.x, ob.y, ob.w, 0.5, '#8a857a'); WR(ob.x, ob.y+ob.h*0.5, ob.w, 0.5, mix('#6a6560','#000',0.3)); } }
    // DRONES (perigo aéreo): corpo escuro + rotores + luz vermelha piscando sob a barriga
    for(var dri=0;dri<rc.drones.length;dri++){ var dr=rc.drones[dri];
      if(dr.x-cam<-4||dr.x-cam>RVIEW+4) continue;
      WR(dr.x-3.5, dr.y-1.5, 2, 0.5, '#8a90a0'); WR(dr.x+1.5, dr.y-1.5, 2, 0.5, '#8a90a0'); // rotores
      WR(dr.x-1, dr.y-1.5, 0.5, 1.5, '#5a5f68'); WR(dr.x+0.5, dr.y-1.5, 0.5, 1.5, '#5a5f68'); // mastros
      WR(dr.x-2, dr.y-0.5, 4, 2, '#3a3f4a'); WR(dr.x-2, dr.y-0.5, 4, 0.5, '#5a606a');         // corpo + brilho
      WR(dr.x-0.5, dr.y+1.5, 1, 0.5, (Math.floor(rc.t*0.006)%2===0)?'#ff5a5a':'#7a3030'); }   // luz
    // CHECKPOINTS: bandeirinha na ponta do telhado — cinza esperando, dourada quando alcançada.
    for(var fj=0;fj<rc.flags.length;fj++){ var fl=rc.flags[fj];
      if(fl.platX-cam>RVIEW || fl.platX+8-cam<0) continue;
      var pole=fl.raised?'#c98a3a':'#6a7078', cloth=fl.raised?'#ffd479':'#9aa6c0',
          fw2=(!reduce && fl.raised && Math.sin(rc.t*0.006+fl.platX)>0)?1:0;
      WR(fl.x, fl.top-8, 0.5, 8, pole);                         // mastro
      WR(fl.x+0.5, fl.top-8, 3+fw2, 2.5, cloth);                // bandeira (tremula quando hasteada)
      WR(fl.x+0.5, fl.top-5.5, 2, 1, mix(cloth,'#000',0.25)); }
    // COMPUTADORZINHO (escudo de cache) pairando: monitor com a telinha acesa.
    for(var ii=0;ii<rc.items.length;ii++){ var im2=rc.items[ii];
      if(im2.x-cam<-4||im2.x-cam>RVIEW+4) continue;
      var scr=(Math.floor(rc.t*0.006)%2===0)?'#9fe6ff':'#7fd0c8';
      WR(im2.x-2, im2.y-2.5, 4, 3, '#3a3f4a');                  // corpo do monitor (~6x5 na tela)
      WR(im2.x-1.5, im2.y-2, 3, 2, scr);                        // telinha acesa
      WR(im2.x-0.5, im2.y+0.5, 1, 1, '#5a606a'); WR(im2.x-1.5, im2.y+1.5, 3, 0.5, '#5a606a'); } // pé + base
    // faíscas / poeirinha (col própria; poeira sobe devagar, dourada = coleta/quebra)
    for(var hi=rc.fx.length-1;hi>=0;hi--){ var hz=rc.fx[hi]; hz.age++;
      hz.y += (hz.vy==null? -0.5 : hz.vy); if(hz.vx) hz.x += hz.vx;
      if(hz.age>hz.life){ rc.fx.splice(hi,1); continue; }
      ctx.globalAlpha=Math.max(0,1-hz.age/hz.life); WR(hz.x,hz.y,1,1, hz.col||'#ffd479'); ctx.globalAlpha=1; }
    // jogadora — sprite 10x16 EFETIVO desenhado em px de TELA (detalhe fino do rosto/
    // contorno não existe na grade de mundo). pés na tela = rc.py * RZ.
    var walking=(keys.left||keys.right)&&rc.onGround, airborne=!rc.onGround;
    var sprFrame = airborne ? RC_JUMP
      : walking ? RC_WALK[Math.floor(rc.t*0.012)%3]
      : ((Math.floor(rc.t/220)%14===0) ? RC_BLINK : RC_IDLE);
    // PESO: aterrissou -> squash (1px mais baixa/larga por 2-3 frames); pico do pulo -> stretch (1px mais alta).
    var dw=0, dh=0;
    if(rc.squashT>0){ dw=1; dh=-1; }
    else if(!rc.onGround && Math.abs(rc.vy)<0.6){ dh=1; }
    rc.sqDW=dw; rc.sqDH=dh;                                     // espelho pros testes
    var blinkOut = rc.iframes>0 && (Math.floor(rc.t*0.02)%2===0); // pisca invencível ~1s
    if(!blinkOut) rcDrawSprite(sprFrame, (rc.px-cam)*RZ, rc.py*RZ, rc.facing<0?-1:1, dw, dh);
    // GLITCH do computador travando/quebrando (2-3 frames de fatias RGB deslocadas sobre a jogadora)
    if(rc.glitchT>0){ var gx=(rc.px-cam)*RZ, gy=(rc.py-11)*RZ; ctx.globalAlpha=0.7;
      R((gx-9+(Math.random()*6-3))|0, gy|0, 20, 2, '#8ad8ff');
      R((gx-7+(Math.random()*6-3))|0, (gy+5)|0, 16, 2, '#ff5aa8');
      R((gx-5+(Math.random()*6-3))|0, (gy+10)|0, 14, 2, '#5a8aff'); ctx.globalAlpha=1; }
    // HUD: tokens coletados + recorde
    ctx.globalAlpha=0.85; R(0,0,W,11,'#0a0710'); ctx.globalAlpha=1;
    ctx.textBaseline='top'; ctx.font='bold 8px monospace';
    ctx.fillStyle='#ffd79a'; ctx.textAlign='left';  ctx.fillText('rooftops · '+rc.score+' tokens', 4, 2);
    ctx.fillStyle='#7fc7bf'; ctx.textAlign='right'; ctx.fillText('best '+rcBest, W-4, 2);
    // ESCUDO ativo: indicador discreto (monitorzinho aceso) no centro do HUD.
    if(rc.shield){ var ix=(W>>1)-3; R(ix,2,6,4,'#2a2f38'); R(ix+1,3,4,2,'#7fd0c8'); R(ix+2,6,2,1,'#4a505a'); }
    // instruções ao entrar (some em ~4s) — faixa legível
    if(rc.introT < 4000 && !paused && !rc.dead) rcStrip(rcAuto ? 'auto-demo · click to take control' : '← → move · space jumps');
    // PAUSA — dois recados DIFERENTES: decisão pendente (âmbar) x agente terminou
    if(paused){
      if(agState==='decision') rcPanel('⏸ needs your call', 'the agent is waiting on you', true);
      else rcPanel('the agent finished', 'back to you');
    }
    else if(rc.dead){
      if(rc.cp) rcPanel(rc.deadMsg || 'you fell', 'back to the checkpoint · tokens kept');
      else rcPanel(rc.deadMsg || 'you fell', 'best ' + rcBest);
    }
    ctx.textAlign='left'; ctx.textBaseline='alphabetic';
  }

  // TECLADO no document. ESTADO das teclas (segurar anda contínuo, não por repetição
  // de evento) e preventDefault em espaço/setas pra janela não rolar/clicar botão.
  if(typeof document!=='undefined' && document.addEventListener){
    document.addEventListener('keydown', function(e){
      if(mode!=='recreio') return;
      if(rcAuto) rcTakeover();                 // vitrine: 1ª tecla assume o controle
      var key=e.key;
      if(key===' '||key==='Spacebar'||key==='ArrowUp'||key==='Up'){
        if(!rc || !rc.jumpHeld) rcJump(); if(rc) rc.jumpHeld=true;
        if(e.preventDefault) e.preventDefault(); }
      else if(key==='ArrowRight'||key==='Right'){ keys.right=true; if(e.preventDefault) e.preventDefault(); }
      else if(key==='ArrowLeft'||key==='Left'){ keys.left=true; if(e.preventDefault) e.preventDefault(); }
      else if(key==='Escape'||key==='Esc'){ exitRecreio(); if(e.preventDefault) e.preventDefault(); }
    });
    document.addEventListener('keyup', function(e){
      if(mode!=='recreio') return;
      var key=e.key;
      if(key===' '||key==='Spacebar'||key==='ArrowUp'||key==='Up'){
        if(rc){ rc.jumpHeld=false; if(rc.vy<0) rc.vy*=JUMPCUT; }   // solta cedo = pulo menor
        if(e.preventDefault) e.preventDefault(); }
      else if(key==='ArrowRight'||key==='Right'){ keys.right=false; }
      else if(key==='ArrowLeft'||key==='Left'){ keys.left=false; }
    });
  }
  if(elRecreio && elRecreio.addEventListener){
    elRecreio.addEventListener('click', function(){ if(mode==='recreio') exitRecreio(); else startRecreio(); });
  }
  // PULO POR CLIQUE/TAP no canvas — o mouse sempre funciona, mesmo que a janela
  // frameless não receba foco de teclado (rede de segurança do foco).
  if(cv && cv.addEventListener){
    cv.addEventListener('pointerdown', function(e){ if(mode==='recreio'){ rcTakeover(); rcJump(); if(e && e.preventDefault) e.preventDefault(); } });
    cv.addEventListener('mousedown',  function(e){ if(mode==='recreio'){ rcTakeover(); rcJump(); if(e && e.preventDefault) e.preventDefault(); } });
  }

  // ---------- CONTROLES DA VITRINE (só existem no demo do site: #autoBadge + toggle
  // "rooftops · city"). Não afetam o app real (esses elementos não existem no overlay).
  var elAutoBadge = $('autoBadge'), elViewRoof = $('viewRoof'), elViewCity = $('viewCity');
  function syncViewButtons(){
    if(elViewRoof) elViewRoof.classList.toggle('on', mode==='recreio');
    if(elViewCity) elViewCity.classList.toggle('on', mode!=='recreio');
    if(elAutoBadge) elAutoBadge.hidden = !(mode==='recreio' && rcAuto);
  }
  function showRooftops(){ if(mode!=='recreio') startRecreio(); syncViewButtons(); }
  function showCity(){ if(mode==='recreio') exitRecreio(); syncViewButtons(); }
  if(elViewRoof && elViewRoof.addEventListener) elViewRoof.addEventListener('click', showRooftops);
  if(elViewCity && elViewCity.addEventListener) elViewCity.addEventListener('click', showCity);

  // ---------- loop ----------
  var last = performance.now(), acc = 0;
  function loop(now){
    var dt = Math.min(70, now-last); last = now;
    if(!real) simTokens += SIM_BURN * (dt/1000);
    acc += dt;
    if(acc >= 120){ acc = 0;
      if(!real) daysLeft = localDaysLeft();
      setState(real ? agState : 'live');
      // camadas de jogo (baratas): população, marcos, vontades, auto-build, placar
      if(seasonId!=null){ recomputePop(); evalMarcos(); evalWishes(); drainSpecials(now); maybeSendCity(now); }
      updateHud(now);
      if(elTok) elTok.innerHTML = fmt(tokens()) + ' <small>tokens</small>';
      if(elCost) elCost.textContent = fmtCost(real ? realCost : simTokens/1e6*SIM_PRICE_PER_MTOK);
      if(elBuilds) elBuilds.textContent = builtNormals;
      if(elPop) elPop.textContent = fmtPop(population);
    }
    if(mode==='recreio' && rc) drawRecreio(dt); else draw(dt);
    requestAnimationFrame(loop);
  }

  // no navegador (preview) não há IPC — inicia a temporada localmente já de cara.
  if(!real){ daysLeft = localDaysLeft(); initSeason(localSeasonId()); }
  setState(real ? 'idle' : 'live');
  // VITRINE: no navegador, abre JÁ nos TELHADOS em auto-play (attract mode) — mostra o
  // platformer logo abaixo de "play on your rooftops"; clique/tecla assume o controle.
  if(!real){ rcAuto = true; startRecreio(); syncViewButtons(); }
  requestAnimationFrame(loop);
})();
