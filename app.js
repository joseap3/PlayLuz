// ═══════════════════════════════════════════════════
//  PlayLuz v2.0 — Full Featured PWA Music Player
// ═══════════════════════════════════════════════════

// ─── State ─────────────────────────────────────────
const S = {
  songs:[], playlists:[], favorites:[], ratings:{}, history:[],
  currentSong:null, queue:[], queueIdx:-1,
  playing:false, shuffle:false, repeat:0,
  volume:0.8, muted:false, progress:0, duration:0,
  crossfade:3, crossfadeActive:false,
  tab:'home', theme:'light',
  searchQ:'', searchRes:[], searching:false,
  selMode:false, selected:new Set(),
  modal:null, notification:null,
  installPrompt:null, installed:false,
  sleepTimer:null,
  eq:{bass:0,mid:0,treble:0},
  bpm:0, bpmAnalyzing:false,
  dynColor:'#7B2FFF',
  xpTotal:0,
  statsData:[],
  vizMode:0, // 0=bars,1=wave,2=circle
  tunerActive:false, tunerNote:'—', tunerFreq:0, tunerCents:0,
  pianoOctave:4,
  pomodoroActive:false, pomodoroTime:25*60, pomodoroMode:'work',
  dataArray:null, analyser:null,
};

// ─── Audio Engine ───────────────────────────────────
const AE = {
  el: new window.Audio(),
  el2: new window.Audio(), // for crossfade
  ctx:null, analyser:null, src:null, src2:null,
  gain:null, gain2:null, bass:null, mid:null, treble:null,
  micStream:null, micSrc:null, micAnalyser:null,

  init(){
    this.el.volume = S.volume;
    this.el2.volume = 0;
    const bind = (el, primary) => {
      el.addEventListener('timeupdate', () => { if(primary){S.progress=el.currentTime;S.duration=el.duration||0;UI.updateProgress()} });
      el.addEventListener('ended', () => { if(primary) App.onEnd() });
      el.addEventListener('loadedmetadata', () => { if(primary){S.duration=el.duration;UI.updateProgress()} });
      el.addEventListener('play', () => { if(primary){S.playing=true;UI.updatePlayBtn();UI.startVizLoop()} });
      el.addEventListener('pause', () => { if(primary){S.playing=false;UI.updatePlayBtn()} });
      el.addEventListener('error', () => { if(primary) UI.notify('Erro ao carregar áudio','error') });
    };
    bind(this.el, true);
    bind(this.el2, false);
  },

  initCtx(){
    if(this.ctx) return;
    this.ctx = new(window.AudioContext||window.webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    S.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    S.analyser = this.analyser;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = S.volume;
    this.bass = this.ctx.createBiquadFilter(); this.bass.type='lowshelf'; this.bass.frequency.value=200;
    this.mid = this.ctx.createBiquadFilter(); this.mid.type='peaking'; this.mid.frequency.value=1000;
    this.treble = this.ctx.createBiquadFilter(); this.treble.type='highshelf'; this.treble.frequency.value=4000;
    this.src = this.ctx.createMediaElementSource(this.el);
    this.src.connect(this.bass);
    this.bass.connect(this.mid);
    this.mid.connect(this.treble);
    this.treble.connect(this.analyser);
    this.analyser.connect(this.gain);
    this.gain.connect(this.ctx.destination);
    // second source for crossfade
    this.gain2 = this.ctx.createGain();
    this.gain2.gain.value = 0;
    this.src2 = this.ctx.createMediaElementSource(this.el2);
    this.src2.connect(this.gain2);
    this.gain2.connect(this.ctx.destination);
  },

  load(song, el=this.el){ if(!song?.fileData) return; el.src=song.fileData; el.load() },
  play(el=this.el){ if(this.ctx?.state==='suspended') this.ctx.resume(); return el.play() },
  pause(el=this.el){ el.pause() },
  seek(t){ this.el.currentTime=t },
  setVol(v){ S.volume=v; this.el.volume=v; if(this.gain) this.gain.gain.value=v },
  setEQ(band,val){
    this.initCtx();
    if(band==='bass') this.bass.gain.value=val;
    if(band==='mid') this.mid.gain.value=val;
    if(band==='treble') this.treble.gain.value=val;
    S.eq[band]=val;
  },
  getFreq(){ if(!this.analyser) return null; this.analyser.getByteFrequencyData(S.dataArray); return S.dataArray },
  getTime(){ if(!this.analyser) return null; this.analyser.getByteTimeDomainData(S.dataArray); return S.dataArray },

  // Crossfade to next
  async crossfadeTo(song, onDone){
    if(!S.crossfade || !this.ctx){ onDone(); return }
    this.initCtx();
    this.load(song, this.el2);
    this.el2.volume = 1;
    await this.play(this.el2);
    const dur = S.crossfade * 1000;
    const steps = 30, interval = dur/steps;
    let step = 0;
    const fade = setInterval(()=>{
      step++;
      const t = step/steps;
      this.gain.gain.value = Math.max(0, (1-t) * S.volume);
      this.gain2.gain.value = t * S.volume;
      if(step >= steps){
        clearInterval(fade);
        this.pause(this.el);
        // swap sources
        [this.el.src, this.el2.src] = [this.el2.src, this.el.src];
        this.el.currentTime = this.el2.currentTime;
        this.gain.gain.value = S.volume;
        this.gain2.gain.value = 0;
        this.el2.pause();
        onDone();
      }
    }, interval);
  },

  // BPM Detection via autocorrelation
  analyzeBPM(){
    return new Promise(res=>{
      if(!S.dataArray){ res(0); return }
      this.analyser.fftSize = 2048;
      const buf = new Float32Array(this.analyser.fftSize);
      this.analyser.getFloatTimeDomainData(buf);
      const sr = this.ctx.sampleRate;
      // autocorrelation
      let best=-1, bestLag=0;
      for(let lag=Math.floor(sr/200); lag<Math.floor(sr/50); lag++){
        let sum=0;
        for(let i=0; i<buf.length-lag; i++) sum += buf[i]*buf[i+lag];
        if(sum>best){ best=sum; bestLag=lag }
      }
      const bpm = bestLag>0 ? Math.round(60*sr/bestLag) : 0;
      this.analyser.fftSize = 512;
      S.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      res(bpm);
    });
  },

  // Dominant color from cover
  getDynColor(song){
    if(!song?.cover) return '#7B2FFF';
    return new Promise(res=>{
      const img = new Image();
      img.crossOrigin='anonymous';
      img.onload=()=>{
        const c=document.createElement('canvas'); c.width=c.height=8;
        const ctx=c.getContext('2d'); ctx.drawImage(img,0,0,8,8);
        const d=ctx.getImageData(0,0,8,8).data;
        let r=0,g=0,b=0,n=0;
        for(let i=0;i<d.length;i+=4){ r+=d[i];g+=d[i+1];b+=d[i+2];n++ }
        r=Math.round(r/n); g=Math.round(g/n); b=Math.round(b/n);
        res(`rgb(${r},${g},${b})`);
      };
      img.onerror=()=>res('#7B2FFF');
      img.src=song.cover;
    });
  },

  // Tuner via microphone
  async startTuner(){
    try{
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      this.micStream = stream;
      const actx = this.ctx || new(window.AudioContext||window.webkitAudioContext)();
      if(!this.ctx){ this.ctx=actx }
      this.micAnalyser = actx.createAnalyser();
      this.micAnalyser.fftSize = 2048;
      this.micSrc = actx.createMediaStreamSource(stream);
      this.micSrc.connect(this.micAnalyser);
      S.tunerActive = true;
      this._tunerLoop();
      return true;
    } catch(e){ return false }
  },

  stopTuner(){
    S.tunerActive=false;
    if(this.micStream) this.micStream.getTracks().forEach(t=>t.stop());
    this.micStream=null;
  },

  _tunerLoop(){
    if(!S.tunerActive) return;
    const buf = new Float32Array(2048);
    this.micAnalyser.getFloatTimeDomainData(buf);
    const freq = this._autoCorrelate(buf, this.ctx.sampleRate);
    if(freq>0){
      const noteInfo = this._freqToNote(freq);
      S.tunerNote = noteInfo.note; S.tunerFreq = Math.round(freq); S.tunerCents = noteInfo.cents;
      UI.updateTuner();
    }
    setTimeout(()=>this._tunerLoop(), 100);
  },

  _autoCorrelate(buf, sr){
    const SIZE=buf.length; const MAX_SAMPLES=Math.floor(SIZE/2);
    let best=-1, bestT=0;
    const rms=Math.sqrt(buf.reduce((s,v)=>s+v*v,0)/SIZE);
    if(rms<0.01) return -1;
    for(let t=2;t<MAX_SAMPLES;t++){
      let ac=0; for(let i=0;i<MAX_SAMPLES;i++) ac+=buf[i]*buf[i+t];
      if(ac>best){ best=ac; bestT=t }
    }
    return sr/bestT;
  },

  _freqToNote(freq){
    const NOTES=['Dó','Dó#','Ré','Ré#','Mi','Fá','Fá#','Sol','Sol#','Lá','Lá#','Si'];
    const A4=440, MIDI_A4=69;
    const midi = 12*(Math.log2(freq/A4))+MIDI_A4;
    const noteIdx = Math.round(midi)%12;
    const octave = Math.floor(Math.round(midi)/12)-1;
    const cents = Math.round((midi - Math.round(midi))*100);
    return { note: NOTES[((noteIdx%12)+12)%12]+octave, cents };
  },

  // Piano tone synthesis
  playNote(freq){
    this.initCtx();
    const osc=this.ctx.createOscillator();
    const env=this.ctx.createGain();
    osc.connect(env); env.connect(this.ctx.destination);
    osc.type='triangle'; osc.frequency.value=freq;
    env.gain.setValueAtTime(0,this.ctx.currentTime);
    env.gain.linearRampToValueAtTime(0.5,this.ctx.currentTime+0.01);
    env.gain.exponentialRampToValueAtTime(0.01,this.ctx.currentTime+1.5);
    osc.start(); osc.stop(this.ctx.currentTime+1.5);
  }
};

// ─── App Logic ──────────────────────────────────────
const App = {
  async init(){
    await window.PlayLuzDB.init();
    AE.init();
    await this.loadData();
    UI.init();
    this.registerSW();
    this.checkInstalled();
    window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();S.installPrompt=e;UI.showInstallBanner()});
    window.addEventListener('appinstalled',()=>{S.installed=true;UI.hideInstallBanner()});
    const theme = await window.PlayLuzDB.getSetting('theme','light');
    UI.applyTheme(theme);
    const tab = await window.PlayLuzDB.getSetting('lastTab','home');
    UI.switchTab(tab);
    S.xpTotal = await window.PlayLuzDB.getTotalXP();
  },

  async loadData(){
    S.songs = await window.PlayLuzDB.getSongs();
    S.playlists = await window.PlayLuzDB.getPlaylists();
    S.favorites = await window.PlayLuzDB.getFavorites();
    S.ratings = await window.PlayLuzDB.getAllRatings();
    S.history = await window.PlayLuzDB.getHistory(50);
    S.statsData = await window.PlayLuzDB.getStats(30);
  },

  registerSW(){ if('serviceWorker'in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{}) },
  checkInstalled(){
    if(window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone) S.installed=true;
  },

  async playSong(song, queue=null, idx=0){
    if(!song) return;
    const prev = S.currentSong;
    S.currentSong = song;
    if(queue){ S.queue=queue; S.queueIdx=idx }
    AE.initCtx();
    // Dynamic color from cover
    if(song.cover){ AE.getDynColor(song).then(c=>{ S.dynColor=c; UI.applyDynColor(c) }) }
    else { S.dynColor='#7B2FFF'; UI.applyDynColor('#7B2FFF') }
    if(S.crossfade && prev){
      AE.crossfadeTo(song, ()=>{});
    } else {
      AE.load(song);
      await AE.play();
    }
    await window.PlayLuzDB.addHistory(song.id);
    await window.PlayLuzDB.incrementPlayCount(song.id);
    // Track daily stats
    const today = new Date().toISOString().split('T')[0];
    const existing = S.statsData.find(s=>s.date===today)||{date:today,plays:0,minutes:0};
    existing.plays = (existing.plays||0)+1;
    await window.PlayLuzDB.saveStats(today, existing);
    S.favorites = await window.PlayLuzDB.getFavorites();
    UI.updateNowPlaying();
    UI.updateMiniPlayer();
    UI.showPlayerBar();
    this.setupMediaSession(song);
    // XP for listening
    await window.PlayLuzDB.addXP('listen',5,'Ouviu uma música');
    S.xpTotal = await window.PlayLuzDB.getTotalXP();
  },

  setupMediaSession(song){
    if(!('mediaSession'in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title:song.title||'Desconhecido', artist:song.artist||'Artista', album:song.album||'',
      artwork: song.cover?[{src:song.cover,sizes:'512x512',type:'image/jpeg'}]:[]
    });
    ['play','pause'].forEach(a=>navigator.mediaSession.setActionHandler(a,()=>this.togglePlay()));
    navigator.mediaSession.setActionHandler('nexttrack',()=>this.next());
    navigator.mediaSession.setActionHandler('previoustrack',()=>this.prev());
  },

  togglePlay(){ S.playing ? AE.pause() : (AE.initCtx(), AE.play()) },

  next(){
    if(!S.queue.length) return;
    let idx = S.shuffle ? Math.floor(Math.random()*S.queue.length) : (S.queueIdx+1)%S.queue.length;
    S.queueIdx=idx; this.playSong(S.queue[idx],null,idx);
  },

  prev(){
    if(AE.el.currentTime>3){ AE.seek(0); return }
    if(!S.queue.length) return;
    let idx = S.shuffle ? Math.floor(Math.random()*S.queue.length) : (S.queueIdx-1+S.queue.length)%S.queue.length;
    S.queueIdx=idx; this.playSong(S.queue[idx],null,idx);
  },

  onEnd(){
    if(S.repeat===2){ AE.seek(0); AE.play(); return }
    if(S.repeat===1||S.queueIdx<S.queue.length-1) this.next();
    else { S.playing=false; UI.updatePlayBtn() }
  },

  async addFiles(files){
    const added=[];
    for(const file of files){
      const song = await this.readFile(file);
      const id = await window.PlayLuzDB.addSong(song);
      added.push({...song,id});
    }
    S.songs = await window.PlayLuzDB.getSongs();
    await window.PlayLuzDB.addXP('import', added.length*10, `Importou ${added.length} músicas`);
    S.xpTotal = await window.PlayLuzDB.getTotalXP();
    UI.renderView(S.tab);
    UI.notify(`✅ ${added.length} música(s) adicionada(s)!`,'success');
    return added;
  },

  readFile(file){
    return new Promise(res=>{
      const reader = new FileReader();
      reader.onload = async e=>{
        const fileData = e.target.result;
        const song = {
          title: file.name.replace(/\.[^.]+$/,'').replace(/[-_]/g,' '),
          artist:'Artista Desconhecido', album:'', genre:'', year:'', bpm:0,
          duration:0, fileData, fileName:file.name, fileSize:file.size, cover:null,
        };
        // Try ID3 metadata via audio element duration + embedded tags
        try{
          const tags = await this.readID3Tags(fileData, file);
          Object.assign(song, tags);
        }catch(e){}
        res(song);
      };
      reader.readAsDataURL(file);
    });
  },

  readID3Tags(dataUrl, file){
    return new Promise(res=>{
      const audio = new window.Audio();
      audio.src = dataUrl;
      const t = setTimeout(()=>res({duration:0}), 4000);
      audio.addEventListener('loadedmetadata',()=>{ clearTimeout(t); res({duration:audio.duration||0}) });
      audio.addEventListener('error',()=>{ clearTimeout(t); res({duration:0}) });
    });
  },

  async search(q){
    if(!q.trim()){ S.searchRes=[]; S.searching=false; UI.renderView('search'); return }
    S.searching=true;
    S.searchRes = await window.PlayLuzDB.searchSongs(q);
    S.searching=false;
    UI.renderView('search');
  },

  async toggleFav(id){
    const isFav = await window.PlayLuzDB.toggleFavorite(id);
    S.favorites = await window.PlayLuzDB.getFavorites();
    UI.updateFavBtns(id, isFav);
    UI.notify(isFav?'❤️ Adicionado aos favoritos':'💔 Removido dos favoritos','info');
    if(isFav){ await window.PlayLuzDB.addXP('favorite',2,'Favoritou uma música'); S.xpTotal=await window.PlayLuzDB.getTotalXP() }
    return isFav;
  },

  async setRating(songId, stars){
    await window.PlayLuzDB.setRating(songId, stars);
    S.ratings = await window.PlayLuzDB.getAllRatings();
    UI.renderView(S.tab);
    UI.notify(`${'⭐'.repeat(stars)} Avaliação salva!`,'success');
  },

  async createPlaylist(name,desc){
    const id = await window.PlayLuzDB.addPlaylist(name,desc);
    S.playlists = await window.PlayLuzDB.getPlaylists();
    await window.PlayLuzDB.addXP('playlist',15,'Criou uma playlist');
    S.xpTotal = await window.PlayLuzDB.getTotalXP();
    UI.renderView(S.tab);
    UI.notify(`📋 Playlist "${name}" criada!`,'success');
    return id;
  },

  async deletePlaylist(id){
    await window.PlayLuzDB.deletePlaylist(id);
    S.playlists = await window.PlayLuzDB.getPlaylists();
    UI.renderView(S.tab); UI.notify('Playlist removida','info');
  },

  async addToPlaylist(plId, songIds){
    await window.PlayLuzDB.addSongsToPlaylist(plId, songIds);
    S.selMode=false; S.selected.clear();
    UI.notify(`${songIds.length} música(s) adicionada(s)!`,'success');
    UI.renderView(S.tab);
  },

  setSleepTimer(min){
    if(S.sleepTimer) clearTimeout(S.sleepTimer);
    if(!min){ UI.notify('⏱ Timer cancelado','info'); return }
    S.sleepTimer = setTimeout(()=>{ AE.pause(); UI.notify('😴 Pausado pelo timer','info') }, min*60000);
    UI.notify(`⏱ Pausar em ${min} minutos`,'success');
  },

  shuffleAll(){
    if(!S.songs.length){ UI.notify('Adicione músicas primeiro!','error'); return }
    const q = [...S.songs].sort(()=>Math.random()-0.5);
    this.playSong(q[0],q,0);
  },

  // Smart Playlists
  getSmartPlaylist(type){
    switch(type){
      case 'top': return [...S.songs].sort((a,b)=>(b.playCount||0)-(a.playCount||0)).slice(0,20);
      case 'recent': return [...S.songs].sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).slice(0,20);
      case 'fav': return S.songs.filter(s=>S.favorites.includes(s.id));
      case 'rated': return S.songs.filter(s=>(S.ratings[s.id]||0)>=4).sort((a,b)=>(S.ratings[b.id]||0)-(S.ratings[a.id]||0));
      case 'unplayed': return S.songs.filter(s=>!(s.playCount>0));
      default: return S.songs;
    }
  },

  // Export / Import backup
  exportBackup(){
    const data = {
      version:2, exportedAt:new Date().toISOString(),
      songs: S.songs.map(s=>({...s,fileData:undefined})), // metadata only, no audio data
      playlists: S.playlists, favorites: S.favorites, ratings: S.ratings,
    };
    const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='playluz-backup.json'; a.click();
    URL.revokeObjectURL(url);
    UI.notify('📦 Backup exportado!','success');
  },

  async importBackup(file){
    const text = await file.text();
    const data = JSON.parse(text);
    if(data.version!==2){ UI.notify('Formato de backup inválido','error'); return }
    UI.notify(`Importando ${data.songs?.length||0} músicas...`,'info');
    // Merge playlists
    for(const pl of (data.playlists||[])){ await window.PlayLuzDB.addPlaylist(pl.name,pl.description) }
    await this.loadData();
    UI.renderView(S.tab);
    UI.notify('✅ Backup importado com sucesso!','success');
  },

  // Pomodoro
  startPomodoro(workMin=25, breakMin=5){
    if(S.pomodoroActive){ clearInterval(S._pomTimer); S.pomodoroActive=false; UI.updatePomodoro(); return }
    S.pomodoroActive=true; S.pomodoroMode='work'; S.pomodoroTime=workMin*60;
    S._pomTimer = setInterval(()=>{
      S.pomodoroTime--;
      if(S.pomodoroTime<=0){
        if(S.pomodoroMode==='work'){ S.pomodoroMode='break'; S.pomodoroTime=breakMin*60; UI.notify('☕ Pausa!','success') }
        else { S.pomodoroMode='work'; S.pomodoroTime=workMin*60; UI.notify('💪 Foco!','info') }
      }
      UI.updatePomodoro();
    },1000);
  },
};

// ─── Learning Module ─────────────────────────────────
const Learn = {
  genres:['Rock','Pop','Jazz','Blues','Classical','Electronic','Hip-Hop','R&B','Country','Reggae','Samba','Funk','MPB','Forró','Bossa Nova'],
  notes:['Dó','Ré','Mi','Fá','Sol','Lá','Si'],
  noteFreqs:{Dó:261.63,Ré:293.66,Mi:329.63,Fá:349.23,Sol:392.00,Lá:440.00,Si:493.88},
  chords:{'Dó maior':'C-E-G','Ré maior':'D-F#-A','Mi maior':'E-G#-B','Fá maior':'F-A-C','Sol maior':'G-B-D','Lá maior':'A-C#-E','Lá menor':'A-C-E','Mi menor':'E-G-B','Ré menor':'D-F-A','Sol menor':'G-Bb-D'},
  facts:['🎵 A música ativa mais partes do cérebro do que qualquer outra atividade humana.','🎸 Jimi Hendrix nunca aprendeu a ler partituras musicais.','🎹 Mozart compôs sua primeira sinfonia com apenas 8 anos.','🎺 O jazz nasceu em Nova Orleans no início do século XX.','🥁 A bateria é um dos instrumentos mais antigos, datando de 6.000 a.C.','🎻 Um violino profissional pode custar mais de um milhão de dólares.','🎵 Ouvir música enquanto se exercita aumenta o desempenho em até 20%.','🎤 Happy Birthday é a música mais cantada em inglês no mundo.','🎵 O som viaja 4x mais rápido na água do que no ar.','🎸 Os Beatles venderam mais de 600 milhões de discos.','🎵 Estudar música melhora habilidades matemáticas e de leitura.','🎹 O piano tem 88 teclas — de 27,5 Hz a 4.186 Hz.','🥁 Beethoven era surdo quando compôs sua 9ª Sinfonia.','🎷 O saxofone foi inventado em 1846 por Adolphe Sax.','🎵 A nota Lá (440Hz) é o padrão mundial de afinação desde 1939.'],
  pianoKeys:[
    {note:'Dó',freq:261.63,black:false},{note:'Dó#',freq:277.18,black:true},
    {note:'Ré',freq:293.66,black:false},{note:'Ré#',freq:311.13,black:true},
    {note:'Mi',freq:329.63,black:false},{note:'Fá',freq:349.23,black:false},
    {note:'Fá#',freq:369.99,black:true},{note:'Sol',freq:392.00,black:false},
    {note:'Sol#',freq:415.30,black:true},{note:'Lá',freq:440.00,black:false},
    {note:'Lá#',freq:466.16,black:true},{note:'Si',freq:493.88,black:false},
  ],
  rhythmPatterns:[
    {name:'4/4 Rock',pattern:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0],bpm:120},
    {name:'3/4 Valsa',pattern:[1,0,0,1,0,0,1,0,0],bpm:90},
    {name:'Samba',pattern:[1,0,1,1,0,1,0,1,1,0,1,0],bpm:100},
    {name:'Bossa Nova',pattern:[1,0,1,0,1,1,0,1,0,1,0,1],bpm:80},
  ],
  getDailyFact(){ return this.facts[new Date().getDate()%this.facts.length] },
  startQuiz(){
    const withGenre = S.songs.filter(s=>s.genre);
    if(withGenre.length<4) return null;
    const song = withGenre[Math.floor(Math.random()*withGenre.length)];
    const wrong = this.genres.filter(g=>g!==song.genre).sort(()=>Math.random()-0.5).slice(0,3);
    const opts = [song.genre,...wrong].sort(()=>Math.random()-0.5);
    return {song,question:`Qual o gênero de "${song.title}"?`,opts,correct:song.genre};
  },
  getGenreInfo(g){
    const m={Rock:{e:'🎸',desc:'Surgiu nos anos 50 misturando blues, country e R&B. Caracterizado por guitarras elétricas distorcidas.',bpm:'120-160',mood:'Energético',origin:'EUA'},Jazz:{e:'🎷',desc:'Nascido em Nova Orleans, combina improvisação, síncope e harmonia complexa.',bpm:'60-200',mood:'Sofisticado',origin:'EUA'},Classical:{e:'🎻',desc:'Tradição musical europeia dos séculos XVIII-XIX com estruturas formais elaboradas.',bpm:'40-180',mood:'Contemplativo',origin:'Europa'},Electronic:{e:'🎛️',desc:'Produzida com sintetizadores e computadores, criada a partir dos anos 70.',bpm:'120-180',mood:'Dançante',origin:'Europa/EUA'},Samba:{e:'🥁',desc:'Ritmo brasileiro afro-descendente, símbolo do carnaval. Nascido no Rio de Janeiro.',bpm:'80-100',mood:'Alegre',origin:'Brasil'},MPB:{e:'🎵',desc:'Música Popular Brasileira dos anos 60, síntese de várias tradições musicais.',bpm:'60-120',mood:'Poético',origin:'Brasil'},'Bossa Nova':{e:'🎶',desc:'Fusão de samba e jazz criada nos anos 50 no Rio de Janeiro por João Gilberto.',bpm:'70-100',mood:'Suave',origin:'Brasil'},Forró:{e:'🪗',desc:'Ritmo nordestino brasileiro com acordeão, zabumba e triângulo.',bpm:'90-130',mood:'Festivo',origin:'Brasil'}};
    return m[g]||{e:'🎵',desc:'Um gênero musical único com suas próprias características.',bpm:'?',mood:'Variado',origin:'?'};
  },
  getXPLevel(xp){
    const levels=[{min:0,name:'Iniciante',icon:'🎵'},{min:50,name:'Aprendiz',icon:'🎸'},{min:150,name:'Músico',icon:'🎹'},{min:350,name:'Virtuoso',icon:'🎺'},{min:700,name:'Maestro',icon:'🎼'},{min:1200,name:'Lenda',icon:'🏆'}];
    let level=levels[0];
    for(const l of levels){ if(xp>=l.min) level=l }
    const next=levels[levels.indexOf(level)+1];
    return {...level,xp,next:next||null,progress:next?Math.round(((xp-level.min)/(next.min-level.min))*100):100};
  }
};


// ─── UI Layer ─────────────────────────────────────────
const UI = {
  vizLoopId:null,

  init(){
    document.getElementById('app').innerHTML = this.tplShell();
    this.injectCSS();
    this.bindGlobal();
  },

  tplShell(){
    return `
    <div class="shell">
      <div id="installBanner" class="install-banner hidden">
        <span>📲 Instalar PlayLuz</span>
        <button onclick="App.installPWA()" class="btn-install">Instalar</button>
        <button onclick="UI.hideInstallBanner()" class="btn-close-x">✕</button>
      </div>
      <div class="main-area" id="mainArea">
        <div id="viewWrap"></div>
      </div>
      ${this.tplPlayerBar()}
      ${this.tplNav()}
      <div id="overlay" class="overlay hidden"></div>
      <div id="notif" class="notif hidden"></div>
    </div>`;
  },

  tplPlayerBar(){
    return `<div class="pbar hidden" id="pbar">
      <div class="pbar-prog">
        <div class="pbar-fill" id="pbarFill"></div>
        <input type="range" class="pbar-range" id="pbarRange" min="0" max="100" value="0" step="0.1"
          oninput="AE.seek((this.value/100)*S.duration)">
      </div>
      <div class="pbar-main">
        <div class="pbar-info" onclick="UI.openFullPlayer()">
          <div class="pbar-cover" id="pbarCover">
            <canvas id="miniViz" class="mini-viz" width="52" height="52"></canvas>
          </div>
          <div class="pbar-text">
            <div class="pbar-title" id="pbarTitle">—</div>
            <div class="pbar-artist" id="pbarArtist">Selecione uma música</div>
          </div>
        </div>
        <div class="pbar-ctrls">
          <button class="cbtn hbtn" id="miniHeart" onclick="S.currentSong&&App.toggleFav(S.currentSong.id)">♡</button>
          <button class="cbtn" onclick="App.prev()">⏮</button>
          <button class="cbtn playbtn" id="playBtn" onclick="App.togglePlay()">▶</button>
          <button class="cbtn" onclick="App.next()">⏭</button>
          <button class="cbtn" onclick="UI.openFullPlayer()">⬆</button>
        </div>
      </div>
    </div>`;
  },

  tplNav(){
    const tabs=[{id:'home',ic:'⌂',lb:'Início'},{id:'library',ic:'♫',lb:'Biblioteca'},{id:'search',ic:'⌕',lb:'Buscar'},{id:'playlists',ic:'☰',lb:'Playlists'},{id:'stats',ic:'📊',lb:'Stats'},{id:'learn',ic:'✦',lb:'Aprender'}];
    return `<nav class="nav" id="nav">
      ${tabs.map(t=>`<button class="nbtn${S.tab===t.id?' active':''}" id="nb-${t.id}" onclick="UI.switchTab('${t.id}')"><span class="nic">${t.ic}</span><span class="nlb">${t.lb}</span></button>`).join('')}
      <button class="nbtn" onclick="UI.toggleTheme()" title="Tema">
        <span class="nic" id="themeIc">${S.theme==='dark'?'☀':'🌙'}</span>
        <span class="nlb" id="themeLb">${S.theme==='dark'?'Claro':'Escuro'}</span>
      </button>
    </nav>`;
  },

  switchTab(tab){
    S.tab=tab;
    document.querySelectorAll('.nbtn').forEach(b=>b.classList.remove('active'));
    document.getElementById(`nb-${tab}`)?.classList.add('active');
    window.PlayLuzDB.setSetting('lastTab',tab);
    this.renderView(tab);
  },

  renderView(tab){
    const w=document.getElementById('viewWrap');
    if(!w) return;
    if(tab==='home') w.innerHTML=this.vHome();
    else if(tab==='library') w.innerHTML=this.vLibrary();
    else if(tab==='search'){ w.innerHTML=this.vSearch(); setTimeout(()=>{if(!S.searchQ)document.getElementById('sInput')?.focus()},100) }
    else if(tab==='playlists') w.innerHTML=this.vPlaylists();
    else if(tab==='stats') w.innerHTML=this.vStats();
    else if(tab==='learn') w.innerHTML=this.vLearn();
  },

  // ── HOME ──
  vHome(){
    const top=[...S.songs].sort((a,b)=>(b.playCount||0)-(a.playCount||0)).slice(0,8);
    const recent=[...S.songs].sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).slice(0,8);
    const h=new Date().getHours();
    const greet=h<12?'🌅 Bom dia':h<18?'☀️ Boa tarde':'🌙 Boa noite';
    const lvl=Learn.getXPLevel(S.xpTotal);
    return `<div class="view">
      <div class="home-hdr">
        <div class="greet">${greet}</div>
        <h1 class="home-logo">PlayLuz</h1>
        <div class="fact-pill">${Learn.getDailyFact()}</div>
      </div>
      <div class="xp-bar-wrap" onclick="UI.showXPModal()">
        <div class="xp-info"><span class="xp-icon">${lvl.icon}</span><span class="xp-name">${lvl.name}</span><span class="xp-pts">${S.xpTotal} XP</span></div>
        <div class="xp-track"><div class="xp-fill" style="width:${lvl.progress}%"></div></div>
        ${lvl.next?`<div class="xp-next">Próximo: ${lvl.next.name} em ${lvl.next.min-S.xpTotal} XP</div>`:'<div class="xp-next">Nível máximo! 🏆</div>'}
      </div>
      <div class="qa-grid">
        <button class="qa-btn" onclick="App.shuffleAll()"><span>⚡</span>Aleatório</button>
        <button class="qa-btn" onclick="UI.openAddMusic()"><span>＋</span>Adicionar</button>
        <button class="qa-btn" onclick="UI.openSmartPlaylists()"><span>✨</span>Smart</button>
        <button class="qa-btn" onclick="UI.showFavs()"><span>❤</span>Favoritos</button>
      </div>
      ${top.length?`<div class="home-sec"><div class="sec-hdr"><h2>🔥 Mais Tocadas</h2></div><div class="hscroll">${top.map((s,i)=>this.tplCard(s,top,i)).join('')}</div></div>`:''}
      ${recent.length?`<div class="home-sec"><div class="sec-hdr"><h2>🆕 Recentes</h2><button onclick="UI.switchTab('library')">Ver tudo →</button></div><div class="hscroll">${recent.map((s,i)=>this.tplCard(s,recent,i)).join('')}</div></div>`:''}
      ${S.playlists.length?`<div class="home-sec"><div class="sec-hdr"><h2>📋 Playlists</h2><button onclick="UI.switchTab('playlists')">Ver tudo →</button></div><div class="hscroll">${S.playlists.slice(0,4).map(p=>this.tplPLCard(p)).join('')}</div></div>`:''}
      ${!S.songs.length?`<div class="empty"><div class="empty-ic">🎵</div><h2>Bem-vindo ao PlayLuz!</h2><p>Adicione músicas para começar</p><button class="btn-pri" onclick="UI.openAddMusic()">Adicionar Músicas</button></div>`:''}
    </div>`;
  },

  tplCard(song,queue,idx){
    const isFav=S.favorites.includes(song.id);
    const isPlay=S.currentSong?.id===song.id&&S.playing;
    const c=this.songColor(song.id);
    const stars=S.ratings[song.id]||0;
    return `<div class="scard${isPlay?' playing':''}" data-id="${song.id}" onclick="App.playSong(State_getSong(${song.id}),${JSON.stringify(queue.map(s=>s.id))}.map(id=>State_getSong(id)).filter(Boolean),${idx})">
      <div class="scard-cov" style="background:linear-gradient(135deg,${c}44,${c}22)">
        ${song.cover?`<img src="${song.cover}" class="cov-img">`:`<div class="cov-lt" style="color:${c}">${(song.title||'?')[0].toUpperCase()}</div>`}
        ${isPlay?'<div class="play-anim"><span></span><span></span><span></span></div>':''}
      </div>
      <div class="scard-ttl">${this.esc(song.title||'Sem título')}</div>
      <div class="scard-art">${this.esc(song.artist||'Artista')}</div>
      ${stars?`<div class="scard-stars">${'⭐'.repeat(stars)}</div>`:''}
    </div>`;
  },

  tplPLCard(pl){
    return `<div class="plcard" onclick="UI.openPL(${pl.id})"><div class="plcard-cov">🎵</div><div class="plcard-nm">${this.esc(pl.name)}</div></div>`;
  },

  tplRow(song,queue,idx,showChk=false){
    const isFav=S.favorites.includes(song.id);
    const isPlay=S.currentSong?.id===song.id&&S.playing;
    const checked=S.selected.has(song.id);
    const c=this.songColor(song.id);
    const stars=S.ratings[song.id]||0;
    const play=`App.playSong(State_getSong(${song.id}),${JSON.stringify(queue.map(s=>s.id))}.map(id=>State_getSong(id)).filter(Boolean),${idx})`;
    return `<div class="srow${isPlay?' playing':''}${checked?' sel':''}" data-id="${song.id}">
      ${showChk?`<label class="chk-wrap"><input type="checkbox" ${checked?'checked':''} onchange="UI.toggleSel(${song.id},this.checked)"><span class="chkmark"></span></label>`:''}
      <div class="row-cov" style="background:linear-gradient(135deg,${c}33,${c}11)" onclick="${play}">
        ${song.cover?`<img src="${song.cover}" class="cov-img">`:`<div class="row-lt" style="color:${c}">${(song.title||'?')[0].toUpperCase()}</div>`}
        ${isPlay?'<div class="row-play"><span></span><span></span><span></span></div>':''}
      </div>
      <div class="row-info" onclick="${play}">
        <div class="row-ttl">${this.esc(song.title||'Sem título')}</div>
        <div class="row-sub">${this.esc(song.artist||'Artista')}${song.genre?` · <span class="gtag">${song.genre}</span>`:''}${stars?` · ${'⭐'.repeat(stars)}`:''}${song.bpm?` · <span class="btag">${song.bpm}bpm</span>`:''}</div>
      </div>
      <div class="row-meta">
        <span class="rdur">${this.fmtTime(song.duration||0)}</span>
        <button class="icn hbtn${isFav?' fav':''}" onclick="App.toggleFav(${song.id})">${isFav?'❤':'♡'}</button>
        <button class="icn" onclick="UI.openSongMenu(${song.id})">⋯</button>
      </div>
    </div>`;
  },

  // ── LIBRARY ──
  vLibrary(){
    const sm=S.selMode;
    const sorted=[...S.songs].sort((a,b)=>(a.title||'').localeCompare(b.title||''));
    return `<div class="view">
      <div class="vhdr">
        <h1>Biblioteca</h1>
        <div class="hdr-acts">
          ${sm&&S.selected.size>0?`<button class="btn-ac" onclick="UI.openAddToPL()">+ Playlist (${S.selected.size})</button><button class="btn-gh" onclick="UI.cancelSel()">Cancelar</button>`:`<button class="icn" onclick="UI.toggleSel()" title="Selecionar">☑</button><button class="icn" onclick="UI.openAddMusic()" title="Adicionar">＋</button>`}
        </div>
      </div>
      <div class="lib-stats">${S.songs.length} músicas · ${this.fmtTime(S.songs.reduce((a,s)=>a+(s.duration||0),0))}</div>
      ${!S.songs.length?`<div class="empty"><div class="empty-ic">🎶</div><p>Biblioteca vazia</p><button class="btn-pri" onclick="UI.openAddMusic()">Adicionar Músicas</button></div>`:`<div class="slist">${sorted.map((s,i)=>this.tplRow(s,sorted,i,sm)).join('')}</div>`}
    </div>`;
  },

  // ── SEARCH ──
  vSearch(){
    const sm=S.selMode;
    return `<div class="view">
      <div class="srch-hdr">
        <div class="srch-box">
          <span class="srch-ic">⌕</span>
          <input id="sInput" type="text" placeholder="Buscar músicas, artistas, gêneros..." value="${this.esc(S.searchQ)}"
            oninput="S.searchQ=this.value;App.search(this.value)">
          ${S.searchQ?`<button class="clr-srch" onclick="S.searchQ='';App.search('');document.getElementById('sInput').value=''">✕</button>`:''}
        </div>
        ${sm?`<div class="sel-acts">${S.selected.size>0?`<button class="btn-ac" onclick="UI.openAddToPL()">+ Playlist (${S.selected.size})</button>`:''}<button class="btn-gh" onclick="UI.cancelSel()">Cancelar</button></div>`:(S.searchRes.length>0?`<button class="icn" onclick="UI.toggleSearchSel()">☑</button>`:'')}
      </div>
      ${!S.searchQ?`<div class="genre-wrap"><h3 class="genre-ttl">Gêneros</h3><div class="genre-chips">${Learn.genres.map(g=>`<button class="gchip" onclick="S.searchQ='${g}';App.search('${g}');document.getElementById('sInput').value='${g}'">${g}</button>`).join('')}</div></div>`:''}
      ${S.searching?'<div class="loading">🔍 Buscando...</div>':''}
      ${S.searchRes.length?`<div class="srch-cnt">${S.searchRes.length} resultado(s)</div>${S.searchRes.map((s,i)=>this.tplRow(s,S.searchRes,i,sm)).join('')}`:(S.searchQ&&!S.searching?`<div class="empty small"><div class="empty-ic">🔍</div><p>Nenhum resultado para "${this.esc(S.searchQ)}"</p></div>`:'')}
    </div>`;
  },

  // ── PLAYLISTS ──
  vPlaylists(){
    const smart=[{id:'top',name:'🔥 Mais Tocadas'},{id:'recent',name:'🆕 Adicionadas Recentemente'},{id:'fav',name:'❤️ Favoritas'},{id:'rated',name:'⭐ Bem Avaliadas'},{id:'unplayed',name:'🎵 Não Tocadas'}];
    return `<div class="view">
      <div class="vhdr"><h1>Playlists</h1><button class="icn" onclick="UI.openCreatePL()">＋</button></div>
      <div class="sec-lbl">✨ Smart Playlists</div>
      <div class="smart-grid">${smart.map(sp=>`<button class="smart-btn" onclick="UI.playSmart('${sp.id}')"><span>${sp.name}</span><span class="smart-cnt">${App.getSmartPlaylist(sp.id).length}</span></button>`).join('')}</div>
      <div class="sec-lbl" style="margin-top:16px">📋 Minhas Playlists</div>
      ${!S.playlists.length?`<div class="empty small"><p>Nenhuma playlist criada</p><button class="btn-pri" onclick="UI.openCreatePL()">Criar Playlist</button></div>`:`<div class="pl-list">${S.playlists.map(p=>`<div class="pl-item"><div class="pl-item-cov" onclick="UI.openPL(${p.id})">🎵</div><div class="pl-item-inf" onclick="UI.openPL(${p.id})"><div class="pl-item-nm">${this.esc(p.name)}</div><div class="pl-item-ds">${this.esc(p.description||'')}</div></div><div class="pl-item-acts"><button class="icn" onclick="UI.openPL(${p.id})">▶</button><button class="icn danger" onclick="UI.confirmDelPL(${p.id},'${this.esc(p.name)}')">🗑</button></div></div>`).join('')}</div>`}
    </div>`;
  },

  // ── STATS ──
  vStats(){
    const hist=S.history;
    const topSongs=[...S.songs].sort((a,b)=>(b.playCount||0)-(a.playCount||0)).slice(0,5);
    const totalPlays=S.songs.reduce((a,s)=>a+(s.playCount||0),0);
    const totalMin=Math.round(S.songs.reduce((a,s)=>a+(s.playCount||0)*(s.duration||0),0)/60);
    const genres={};
    S.songs.forEach(s=>{ if(s.genre&&s.playCount>0) genres[s.genre]=(genres[s.genre]||0)+s.playCount });
    const topGenre=Object.entries(genres).sort((a,b)=>b[1]-a[1])[0];
    const artists={};
    S.songs.forEach(s=>{ if(s.artist&&s.playCount>0) artists[s.artist]=(artists[s.artist]||0)+s.playCount });
    const topArtist=Object.entries(artists).sort((a,b)=>b[1]-a[1])[0];
    const lvl=Learn.getXPLevel(S.xpTotal);
    return `<div class="view">
      <div class="vhdr"><h1>📊 Estatísticas</h1><button class="btn-gh" style="width:auto;padding:6px 12px" onclick="App.exportBackup()">📦 Backup</button></div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-n">${totalPlays}</div><div class="stat-l">Reproduções</div></div>
        <div class="stat-card"><div class="stat-n">${totalMin}</div><div class="stat-l">Minutos ouvidos</div></div>
        <div class="stat-card"><div class="stat-n">${S.songs.length}</div><div class="stat-l">Músicas</div></div>
        <div class="stat-card"><div class="stat-n">${S.favorites.length}</div><div class="stat-l">Favoritos</div></div>
      </div>
      <div class="stat-highlight">
        ${topGenre?`<div class="hl-item"><span class="hl-lbl">🎸 Gênero favorito</span><span class="hl-val">${topGenre[0]}</span></div>`:''}
        ${topArtist?`<div class="hl-item"><span class="hl-lbl">🎤 Artista favorito</span><span class="hl-val">${topArtist[0]}</span></div>`:''}
      </div>
      ${topSongs.length?`<div class="sec-lbl">🏆 Músicas Mais Tocadas</div><div class="top-songs">${topSongs.map((s,i)=>`<div class="top-row"><span class="top-n">${i+1}</span><div class="top-inf"><div class="top-ttl">${this.esc(s.title||'Sem título')}</div><div class="top-sub">${this.esc(s.artist||'Artista')}</div></div><span class="top-ct">${s.playCount||0}×</span></div>`).join('')}</div>`:''}
      <div class="sec-lbl">✦ Progresso XP</div>
      <div class="xp-detail">
        <div class="xp-level-big">${lvl.icon} ${lvl.name}</div>
        <div class="xp-pts-big">${S.xpTotal} XP total</div>
        <div class="xp-track" style="height:12px;border-radius:6px"><div class="xp-fill" style="width:${lvl.progress}%"></div></div>
        ${lvl.next?`<div class="xp-next">${lvl.next.min-S.xpTotal} XP para ${lvl.next.name}</div>`:'<div class="xp-next">🏆 Nível máximo alcançado!</div>'}
      </div>
      <div class="sec-lbl">📅 Histórico Recente</div>
      <div class="hist-list">${hist.slice(0,10).map(h=>{ const s=S.songs.find(x=>x.id===h.songId); if(!s) return ''; const d=new Date(h.playedAt); return `<div class="hist-row" onclick="App.playSong(State_getSong(${s.id}),S.songs,S.songs.findIndex(x=>x.id===${s.id}))"><div class="hist-inf"><div class="hist-ttl">${this.esc(s.title||'Sem título')}</div><div class="hist-sub">${this.esc(s.artist||'')} · ${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</div></div></div>`}).filter(Boolean).join('')}</div>
    </div>`;
  },

  // ── LEARN ──
  vLearn(){
    const lvl=Learn.getXPLevel(S.xpTotal);
    return `<div class="view">
      <div class="vhdr"><h1>✦ Aprender</h1><div class="xp-badge">${lvl.icon} ${lvl.name} · ${S.xpTotal}XP</div></div>
      <div class="learn-fact"><div class="lf-ic">💡</div><div class="lf-txt">${Learn.getDailyFact()}</div></div>
      <div class="learn-stats">
        <div class="ls-item"><span>${S.songs.length}</span><small>Músicas</small></div>
        <div class="ls-item"><span>${[...new Set(S.songs.map(s=>s.genre).filter(Boolean))].length}</span><small>Gêneros</small></div>
        <div class="ls-item"><span>${[...new Set(S.songs.map(s=>s.artist).filter(Boolean))].length}</span><small>Artistas</small></div>
      </div>
      <div class="sec-lbl">🎮 Atividades</div>
      <div class="learn-grid">
        <button class="lbtn" onclick="UI.openQuiz()"><div class="lb-ic">🎯</div><div class="lb-nm">Quiz Musical</div><div class="lb-ds">Identifique gêneros</div></button>
        <button class="lbtn" onclick="UI.openFlashcards()"><div class="lb-ic">📚</div><div class="lb-nm">Flashcards</div><div class="lb-ds">Aprenda acordes</div></button>
        <button class="lbtn" onclick="UI.openPiano()"><div class="lb-ic">🎹</div><div class="lb-nm">Piano Virtual</div><div class="lb-ds">Toque notas</div></button>
        <button class="lbtn" onclick="UI.openTuner()"><div class="lb-ic">🎙</div><div class="lb-nm">Afinador</div><div class="lb-ds">Identifica notas</div></button>
        <button class="lbtn" onclick="UI.openRhythm()"><div class="lb-ic">🥁</div><div class="lb-nm">Ritmos</div><div class="lb-ds">Padrões de batida</div></button>
        <button class="lbtn" onclick="UI.openGenreExplorer()"><div class="lb-ic">🌍</div><div class="lb-nm">Gêneros</div><div class="lb-ds">Explore estilos</div></button>
        <button class="lbtn" onclick="UI.openChords()"><div class="lb-ic">🎸</div><div class="lb-nm">Acordes</div><div class="lb-ds">Aprenda formações</div></button>
        <button class="lbtn" onclick="UI.openPomodoro()"><div class="lb-ic">⏱</div><div class="lb-nm">Pomodoro</div><div class="lb-ds">Foco + música</div></button>
      </div>
    </div>`;
  },

  // ── FULL PLAYER ──
  openFullPlayer(){
    if(!S.currentSong) return;
    const song=S.currentSong;
    const isFav=S.favorites.includes(song.id);
    const c=S.dynColor||'#7B2FFF';
    this.openModal(`<div class="fp">
      <div class="fp-bg" style="background:radial-gradient(ellipse at top,${c}33 0%,transparent 60%)"></div>
      <button class="fp-cls" onclick="UI.closeModal()">⌄</button>
      <div class="fp-body">
        <div class="fp-cov-wrap">
          <div class="fp-cov" id="fpCov" style="background:linear-gradient(135deg,${c}55,${c}22)">
            ${song.cover?`<img src="${song.cover}" class="cov-img">`:`<div class="fp-lt" style="color:${c}">${(song.title||'?')[0].toUpperCase()}</div>`}
          </div>
        </div>
        <div class="fp-info">
          <div class="fp-ttl" id="fpTtl">${this.esc(song.title||'Sem título')}</div>
          <div class="fp-art" id="fpArt">${this.esc(song.artist||'Artista')}</div>
          <div class="fp-meta">${song.album?`<span>${this.esc(song.album)}</span>`:''} ${song.genre?`<span class="gtag">${song.genre}</span>`:''} ${song.bpm?`<span class="btag">${song.bpm} BPM</span>`:''}</div>
          <div class="fp-rating">${[1,2,3,4,5].map(n=>`<button class="star-btn${(S.ratings[song.id]||0)>=n?' lit':''}" onclick="App.setRating(${song.id},${n})">★</button>`).join('')}</div>
        </div>
        <div class="fp-prog">
          <input type="range" id="fpRng" min="0" max="100" value="${S.duration?(S.progress/S.duration)*100:0}" step="0.1" oninput="AE.seek((this.value/100)*S.duration)">
          <div class="fp-times"><span id="fpCur">${this.fmtTime(S.progress)}</span><span id="fpDur">${this.fmtTime(S.duration)}</span></div>
        </div>
        <div class="fp-ctrls">
          <button class="fp-btn shuf${S.shuffle?' act':''}" onclick="S.shuffle=!S.shuffle;this.classList.toggle('act')">⇀⇁</button>
          <button class="fp-btn" onclick="App.prev()">⏮</button>
          <button class="fp-btn fp-play" id="fpPlay" onclick="App.togglePlay()">${S.playing?'⏸':'▶'}</button>
          <button class="fp-btn" onclick="App.next()">⏭</button>
          <button class="fp-btn rep${S.repeat?' act':''}" id="fpRep" onclick="UI.cycleRepeat(this)">↺${S.repeat===2?'1':''}</button>
        </div>
        <div class="fp-extras">
          <button class="fp-xbtn${isFav?' act':''}" id="fpFav" onclick="App.toggleFav(${song.id})">${isFav?'❤':'♡'} Favoritar</button>
          <button class="fp-xbtn" onclick="UI.openEQ()">🎛 EQ</button>
          <button class="fp-xbtn" onclick="UI.openSleepTimer()">⏱ Timer</button>
          <button class="fp-xbtn" onclick="UI.analyzeBPM()">🥁 BPM</button>
          <button class="fp-xbtn" onclick="UI.cycleViz()">👁 Viz</button>
        </div>
        <div class="fp-vol"><span>🔈</span><input type="range" id="volRng" min="0" max="1" step="0.01" value="${S.volume}" oninput="AE.setVol(parseFloat(this.value))"><span>🔊</span></div>
        <canvas id="fpViz" class="fp-viz" width="400" height="90"></canvas>
      </div>
    </div>`, true);
    this.startVizLoop();
  },

  cycleRepeat(btn){ S.repeat=(S.repeat+1)%3; btn.classList.toggle('act',S.repeat>0); btn.innerHTML=`↺${S.repeat===2?'1':''}` },
  cycleViz(){ S.vizMode=(S.vizMode+1)%3; const modes=['Barras','Onda','Circular']; UI.notify(`Visualizador: ${modes[S.vizMode]}`,'info') },

  async analyzeBPM(){
    UI.notify('🥁 Analisando BPM...','info');
    AE.initCtx();
    setTimeout(async()=>{
      const bpm=await AE.analyzeBPM();
      S.bpm=bpm;
      if(S.currentSong&&bpm>0){
        S.currentSong.bpm=bpm;
        await window.PlayLuzDB.updateSong(S.currentSong);
        S.songs=await window.PlayLuzDB.getSongs();
      }
      UI.notify(`🥁 BPM detectado: ${bpm}`, bpm>0?'success':'error');
      const bpmEl=document.querySelector('.btag');
      if(bpmEl&&bpm>0) bpmEl.textContent=`${bpm} BPM`;
    },500);
  },


  // ── MODALS ──
  openModal(html, fullscreen=false){
    const o=document.getElementById('overlay');
    o.innerHTML=html; o.classList.remove('hidden');
    if(fullscreen) o.classList.add('modal-fs');
    else o.classList.remove('modal-fs');
    o.onclick=e=>{ if(e.target===o) this.closeModal() };
  },
  closeModal(){
    const o=document.getElementById('overlay');
    o.classList.add('hidden'); o.classList.remove('modal-fs'); o.innerHTML='';
    AE.stopTuner();
  },

  openEQ(){
    this.openModal(`<div class="mcard">
      <div class="mhdr"><h2>🎛️ Equalizador</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="eq-sliders">
        ${[['bass','🔊 Grave',S.eq.bass],['mid','〰️ Médio',S.eq.mid],['treble','✦ Agudo',S.eq.treble]].map(([k,l,v])=>`
        <div class="eq-band"><div class="eq-lbl">${l}</div>
          <input type="range" min="-15" max="15" value="${v}" step="1" oninput="AE.setEQ('${k}',parseFloat(this.value));document.getElementById('eqv-${k}').textContent=this.value">
          <div class="eq-val" id="eqv-${k}">${v}</div></div>`).join('')}
      </div>
      <div class="eq-preset-lbl">Presets</div>
      <div class="preset-row">${[['Normal',[0,0,0]],['Bass Boost',[12,2,-2]],['Treble Boost',[-2,2,12]],['Pop',[4,2,4]],['Rock',[8,2,6]],['Jazz',[4,0,6]]].map(([n,v])=>`<button class="preset-btn" onclick="UI.applyEQ(${JSON.stringify(v)})">${n}</button>`).join('')}</div>
      <div class="cf-row"><div class="cf-lbl">🌊 Crossfade</div><input type="range" id="cfRng" min="0" max="12" value="${S.crossfade}" step="1" oninput="S.crossfade=parseInt(this.value);document.getElementById('cfVal').textContent=this.value+'s'"><div class="cf-val" id="cfVal">${S.crossfade}s</div></div>
      <button class="btn-pri" onclick="UI.closeModal()">Fechar</button>
    </div>`);
  },

  applyEQ([bass,mid,treble]){
    AE.setEQ('bass',bass); AE.setEQ('mid',mid); AE.setEQ('treble',treble);
    document.querySelectorAll('.eq-band input').forEach((el,i)=>{ el.value=[bass,mid,treble][i] });
    document.getElementById('eqv-bass').textContent=bass;
    document.getElementById('eqv-mid').textContent=mid;
    document.getElementById('eqv-treble').textContent=treble;
  },

  openSleepTimer(){
    this.openModal(`<div class="mcard">
      <div class="mhdr"><h2>⏱ Timer de Sono</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="timer-grid">${[5,10,15,20,30,45,60,90,120].map(m=>`<button class="timer-btn" onclick="App.setSleepTimer(${m});UI.closeModal()">${m} min</button>`).join('')}</div>
      <button class="btn-gh" onclick="App.setSleepTimer(0);UI.closeModal()">Cancelar Timer</button>
    </div>`);
  },

  openAddMusic(){
    this.openModal(`<div class="mcard add-music-modal">
      <div class="mhdr"><h2>Adicionar Músicas</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="add-opts">
        <label class="add-opt" for="fInp"><div class="add-opt-ic">📁</div><div><div class="add-opt-ttl">Seus Arquivos</div><div class="add-opt-ds">MP3, WAV, OGG, FLAC, M4A, AAC</div></div><input type="file" id="fInp" multiple accept="audio/*" style="display:none" onchange="UI.handleFiles(this.files)"></label>
        <div class="add-opt dz" id="dz"><div class="add-opt-ic">⬇</div><div><div class="add-opt-ttl">Arraste Arquivos</div><div class="add-opt-ds">Solte aqui</div></div></div>
      </div>
      <div id="addProg" class="add-prog hidden"><div class="add-prog-bar"><div class="add-prog-fill" id="addFill"></div></div><div id="addTxt">Adicionando...</div></div>
    </div>`);
    setTimeout(()=>{
      const dz=document.getElementById('dz');
      if(!dz) return;
      dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('dz-over')});
      dz.addEventListener('dragleave',()=>dz.classList.remove('dz-over'));
      dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('dz-over');UI.handleFiles(e.dataTransfer.files)});
    },100);
  },

  async handleFiles(files){
    if(!files?.length) return;
    const p=document.getElementById('addProg'); const fill=document.getElementById('addFill'); const txt=document.getElementById('addTxt');
    if(p) p.classList.remove('hidden');
    let done=0;
    for(const file of files){
      const song=await App.readFile(file);
      await window.PlayLuzDB.addSong(song);
      done++;
      if(fill) fill.style.width=`${(done/files.length)*100}%`;
      if(txt) txt.textContent=`Adicionando ${done} de ${files.length}...`;
    }
    S.songs=await window.PlayLuzDB.getSongs();
    this.closeModal();
    this.renderView(S.tab);
    await window.PlayLuzDB.addXP('import',done*10,`Importou ${done} músicas`);
    S.xpTotal=await window.PlayLuzDB.getTotalXP();
    this.notify(`✅ ${done} música(s) adicionada(s)!`,'success');
  },

  openCreatePL(){
    this.openModal(`<div class="mcard">
      <div class="mhdr"><h2>Nova Playlist</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="mform"><input id="plNm" type="text" class="minp" placeholder="Nome da playlist" maxlength="50"><textarea id="plDs" class="mtxt" placeholder="Descrição (opcional)" rows="2" maxlength="200"></textarea></div>
      <div class="macts"><button class="btn-pri" onclick="UI.submitCreatePL()">Criar</button><button class="btn-gh" onclick="UI.closeModal()">Cancelar</button></div>
    </div>`);
    setTimeout(()=>document.getElementById('plNm')?.focus(),100);
  },

  async submitCreatePL(){
    const name=document.getElementById('plNm')?.value?.trim();
    const desc=document.getElementById('plDs')?.value?.trim();
    if(!name){ this.notify('Digite um nome','error'); return }
    await App.createPlaylist(name,desc);
    this.closeModal();
  },

  async openPL(id){
    const pl=S.playlists.find(p=>p.id===id); if(!pl) return;
    const songs=await window.PlayLuzDB.getPlaylistSongs(id);
    this.openModal(`<div class="mcard pl-detail">
      <div class="mhdr"><div><h2>${this.esc(pl.name)}</h2>${pl.description?`<div class="pl-ds-sm">${this.esc(pl.description)}</div>`:''}</div><button onclick="UI.closeModal()">✕</button></div>
      <div class="pl-detail-acts">
        <button class="btn-pri" onclick="UI.playPL(${id})" ${!songs.length?'disabled':''}>▶ Tocar Tudo</button>
        <button class="btn-gh" onclick="UI.addSongsToPLMode(${id})">＋ Adicionar</button>
      </div>
      ${songs.length?`<div class="pl-slist">${songs.map((s,i)=>`<div class="pl-srow"><div class="pl-sinf" onclick="UI.closeModal();App.playSong(State_getSong(${s.id}),${JSON.stringify(songs.map(x=>x.id))}.map(id=>State_getSong(id)).filter(Boolean),${i})"><span class="pl-snum">${i+1}</span><div><div class="pl-sttl">${this.esc(s.title||'Sem título')}</div><div class="pl-ssub">${this.esc(s.artist||'Artista')}</div></div></div><button class="icn danger" onclick="UI.removeSongFromPL(${id},${s.id})">−</button></div>`).join('')}</div>`:`<div class="empty small"><p>Nenhuma música</p></div>`}
    </div>`);
  },

  async playPL(id){ const songs=await window.PlayLuzDB.getPlaylistSongs(id); if(songs.length){ this.closeModal(); App.playSong(songs[0],songs,0) } },

  async removeSongFromPL(plId,songId){
    await window.PlayLuzDB.removeSongFromPlaylist(plId,songId);
    this.notify('Música removida','info');
    this.openPL(plId);
  },

  playSmart(type){
    const q=App.getSmartPlaylist(type);
    if(!q.length){ this.notify('Nenhuma música nesta categoria','error'); return }
    App.playSong(q[0],q,0);
    this.notify(`▶ ${q.length} músicas`,'success');
  },

  openAddToPL(){
    const ids=[...S.selected];
    if(!ids.length){ this.notify('Selecione músicas primeiro','error'); return }
    this.openModal(`<div class="mcard">
      <div class="mhdr"><h2>Adicionar à Playlist</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="msub">${ids.length} música(s) selecionada(s)</div>
      ${S.playlists.length?`<div class="pl-sel-list">${S.playlists.map(p=>`<button class="pl-sel-item" onclick="App.addToPlaylist(${p.id},[${ids.join(',')}]);UI.closeModal()">🎵 ${this.esc(p.name)}</button>`).join('')}</div>`:`<div class="empty small"><p>Crie uma playlist primeiro</p></div>`}
      <button class="btn-pri" style="margin-top:10px" onclick="UI.openCreatePL()">+ Nova Playlist</button>
    </div>`);
  },

  openSongMenu(id){
    const song=S.songs.find(s=>s.id===id); if(!song) return;
    const isFav=S.favorites.includes(id);
    const stars=S.ratings[id]||0;
    this.openModal(`<div class="mcard song-menu">
      <div class="mhdr"><div><div style="font-weight:700">${this.esc(song.title||'Sem título')}</div><div style="color:var(--muted);font-size:.85rem">${this.esc(song.artist||'Artista')}</div></div><button onclick="UI.closeModal()">✕</button></div>
      <div class="rating-row">${[1,2,3,4,5].map(n=>`<button class="star-btn${stars>=n?' lit':''}" onclick="App.setRating(${id},${n});UI.closeModal()">★</button>`).join('')}<span style="font-size:.8rem;color:var(--muted);margin-left:8px">${stars?stars+' estrelas':'Avaliar'}</span></div>
      <div class="menu-acts">
        <button class="mact" onclick="App.playSong(State_getSong(${id}),S.songs,S.songs.findIndex(s=>s.id===${id}));UI.closeModal()">▶ Tocar</button>
        <button class="mact" onclick="App.toggleFav(${id});UI.closeModal()">${isFav?'💔 Remover Favorito':'❤ Adicionar Favorito'}</button>
        <button class="mact" onclick="UI.closeModal();UI.openAddSongToPL(${id})">+ Adicionar à Playlist</button>
        <button class="mact" onclick="UI.openSongInfo(${id})">ℹ Informações</button>
        <button class="mact" onclick="UI.openEditSong(${id})">✏ Editar</button>
        <button class="mact" onclick="UI.analyzeSongBPM(${id})">🥁 Analisar BPM</button>
        <button class="mact danger" onclick="UI.confirmDelSong(${id})">🗑 Remover</button>
      </div>
    </div>`);
  },

  openAddSongToPL(songId){
    this.openModal(`<div class="mcard">
      <div class="mhdr"><h2>Adicionar à Playlist</h2><button onclick="UI.closeModal()">✕</button></div>
      ${S.playlists.length?`<div class="pl-sel-list">${S.playlists.map(p=>`<button class="pl-sel-item" onclick="App.addToPlaylist(${p.id},[${songId}]);UI.closeModal()">🎵 ${this.esc(p.name)}</button>`).join('')}</div>`:`<div class="empty small"><p>Nenhuma playlist criada</p></div>`}
      <button class="btn-pri" style="margin-top:10px" onclick="UI.openCreatePL()">+ Nova Playlist</button>
    </div>`);
  },

  openSongInfo(id){
    const s=S.songs.find(x=>x.id===id); if(!s) return;
    this.openModal(`<div class="mcard">
      <div class="mhdr"><h2>ℹ Informações</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="info-grid">${[['Título',s.title],['Artista',s.artist],['Álbum',s.album],['Gênero',s.genre],['Ano',s.year],['BPM',s.bpm||'—'],['Duração',UI.fmtTime(s.duration||0)],['Reproduções',s.playCount||0],['Arquivo',s.fileName]].filter(([,v])=>v).map(([k,v])=>`<div class="info-row"><span class="ik">${k}</span><span class="iv">${v}</span></div>`).join('')}</div>
      <button class="btn-pri" onclick="UI.closeModal()">Fechar</button>
    </div>`);
  },

  openEditSong(id){
    const s=S.songs.find(x=>x.id===id); if(!s) return;
    this.openModal(`<div class="mcard">
      <div class="mhdr"><h2>✏ Editar</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="mform">
        ${[['eTitle','Título',s.title],['eArtist','Artista',s.artist],['eAlbum','Álbum',s.album],['eGenre','Gênero',s.genre],['eYear','Ano',s.year],['eBPM','BPM',s.bpm||'']].map(([id,ph,val])=>`<input type="${id==='eBPM'?'number':'text'}" id="${id}" class="minp" placeholder="${ph}" value="${this.esc(String(val||'')).replace(/"/g,'&quot;')}">`).join('')}
      </div>
      <div class="macts"><button class="btn-pri" onclick="UI.saveEdit(${id})">Salvar</button><button class="btn-gh" onclick="UI.closeModal()">Cancelar</button></div>
    </div>`);
  },

  async saveEdit(id){
    const s=S.songs.find(x=>x.id===id); if(!s) return;
    s.title=document.getElementById('eTitle')?.value||s.title;
    s.artist=document.getElementById('eArtist')?.value||s.artist;
    s.album=document.getElementById('eAlbum')?.value||s.album;
    s.genre=document.getElementById('eGenre')?.value||s.genre;
    s.year=document.getElementById('eYear')?.value||s.year;
    const bpm=parseInt(document.getElementById('eBPM')?.value);
    if(!isNaN(bpm)&&bpm>0) s.bpm=bpm;
    await window.PlayLuzDB.updateSong(s);
    S.songs=await window.PlayLuzDB.getSongs();
    this.closeModal(); this.renderView(S.tab);
    this.notify('✅ Música atualizada!','success');
  },

  confirmDelSong(id){
    const s=S.songs.find(x=>x.id===id);
    this.openModal(`<div class="mcard"><div class="mhdr"><h2>Remover Música</h2></div><p>Remover "<strong>${this.esc(s?.title||'esta música')}</strong>"?</p><div class="macts"><button class="btn-danger" onclick="UI.delSong(${id})">Remover</button><button class="btn-gh" onclick="UI.closeModal()">Cancelar</button></div></div>`);
  },

  async delSong(id){
    await window.PlayLuzDB.deleteSong(id);
    S.songs=await window.PlayLuzDB.getSongs();
    if(S.currentSong?.id===id){ AE.pause(); S.currentSong=null; this.updateMiniPlayer() }
    this.closeModal(); this.renderView(S.tab);
    this.notify('Música removida','info');
  },

  confirmDelPL(id,name){
    this.openModal(`<div class="mcard"><div class="mhdr"><h2>Deletar Playlist</h2></div><p>Deletar "<strong>${this.esc(name)}</strong>"?</p><div class="macts"><button class="btn-danger" onclick="App.deletePlaylist(${id});UI.closeModal()">Deletar</button><button class="btn-gh" onclick="UI.closeModal()">Cancelar</button></div></div>`);
  },

  showFavs(){
    const favSongs=S.songs.filter(s=>S.favorites.includes(s.id));
    this.openModal(`<div class="mcard pl-detail">
      <div class="mhdr"><h2>❤ Favoritos (${favSongs.length})</h2><button onclick="UI.closeModal()">✕</button></div>
      ${favSongs.length?`<button class="btn-pri" onclick="App.playSong(State_getSong(${favSongs[0].id}),${JSON.stringify(favSongs.map(s=>s.id))}.map(id=>State_getSong(id)).filter(Boolean),0);UI.closeModal()">▶ Tocar Favoritos</button><div class="pl-slist">${favSongs.map((s,i)=>`<div class="pl-srow"><div class="pl-sinf" onclick="UI.closeModal();App.playSong(State_getSong(${s.id}),${JSON.stringify(favSongs.map(x=>x.id))}.map(id=>State_getSong(id)).filter(Boolean),${i})"><span class="pl-snum">${i+1}</span><div><div class="pl-sttl">${this.esc(s.title||'Sem título')}</div><div class="pl-ssub">${this.esc(s.artist||'Artista')}</div></div></div></div>`).join('')}</div>`:`<div class="empty small"><div class="empty-ic">♡</div><p>Nenhum favorito ainda</p></div>`}
    </div>`);
  },


  // ── LEARNING MODALS ──
  openQuiz(){
    const q=Learn.startQuiz();
    if(!q){ this.notify('Adicione músicas com gênero definido!','error'); return }
    this.openModal(`<div class="mcard quiz-modal">
      <div class="mhdr"><h2>🎯 Quiz Musical</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="quiz-q">${this.esc(q.question)}</div>
      <div class="quiz-opts">${q.opts.map(o=>`<button class="quiz-opt" onclick="UI.answerQuiz(this,'${this.esc(o)}','${this.esc(q.correct)}')">${this.esc(o)}</button>`).join('')}</div>
      <div class="quiz-res hidden" id="qRes"></div>
    </div>`);
  },

  async answerQuiz(btn,answer,correct){
    document.querySelectorAll('.quiz-opt').forEach(b=>b.disabled=true);
    const ok=answer===correct;
    btn.classList.add(ok?'correct':'wrong');
    if(!ok) document.querySelectorAll('.quiz-opt').forEach(b=>{ if(b.textContent.trim()===correct) b.classList.add('correct') });
    const r=document.getElementById('qRes'); r.classList.remove('hidden');
    if(ok){ await window.PlayLuzDB.addXP('quiz',20,'Quiz correto!'); S.xpTotal=await window.PlayLuzDB.getTotalXP() }
    r.innerHTML=`<div class="${ok?'quiz-win':'quiz-lose'}">${ok?'🎉 Correto! +20 XP!':'❌ Era: '+correct}</div><button class="btn-pri" onclick="UI.closeModal();setTimeout(()=>UI.openQuiz(),200)">Próxima →</button>`;
  },

  openFlashcards(){
    const entries=Object.entries(Learn.chords);
    const [name,notes]=entries[Math.floor(Math.random()*entries.length)];
    this.openModal(`<div class="mcard fc-modal">
      <div class="mhdr"><h2>📚 Flashcards</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="fc" id="fc" onclick="document.getElementById('fcInner').classList.toggle('flipped')">
        <div class="fc-inner" id="fcInner">
          <div class="fc-front"><div class="fc-cat">Acorde</div><div class="fc-txt">${name}</div><div class="fc-hint">Toque para revelar</div></div>
          <div class="fc-back"><div class="fc-cat">Notas</div><div class="fc-txt">${notes}</div></div>
        </div>
      </div>
      <div class="fc-acts">
        <button class="btn-gh" onclick="UI.closeModal();setTimeout(()=>UI.openFlashcards(),200)">Próximo Card →</button>
      </div>
    </div>`);
  },

  openPiano(){
    const keys=Learn.pianoKeys;
    const whites=keys.filter(k=>!k.black);
    const ww=44, bw=28, bh=90, wh=140;
    let pianoHTML=`<div class="piano-wrap"><div class="piano" id="piano" style="position:relative;height:${wh+10}px;width:${whites.length*ww}px;user-select:none">`;
    let wx=0;
    const whitePositions={};
    whites.forEach((k,i)=>{ whitePositions[k.note]=i; pianoHTML+=`<div class="pkey white" style="left:${i*ww}px;width:${ww-2}px;height:${wh}px" onclick="AE.playNote(${k.freq*Math.pow(2,S.pianoOctave-4)});UI.flashKey(this)" data-note="${k.note}"><span class="pnote">${k.note}</span></div>` });
    let bx=0;
    keys.forEach((k,i)=>{
      if(k.black){
        const prev=keys[i-1];
        const prevIdx=whitePositions[prev?.note]||0;
        pianoHTML+=`<div class="pkey black" style="left:${prevIdx*ww+ww-bw/2}px;width:${bw}px;height:${bh}px;z-index:2" onclick="event.stopPropagation();AE.playNote(${k.freq*Math.pow(2,S.pianoOctave-4)});UI.flashKey(this)" data-note="${k.note}"></div>`;
      }
    });
    pianoHTML+=`</div></div>`;
    this.openModal(`<div class="mcard piano-modal">
      <div class="mhdr"><h2>🎹 Piano Virtual</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="octave-row"><button class="icn" onclick="S.pianoOctave=Math.max(2,S.pianoOctave-1);UI.openPiano()">◀</button><span>Oitava ${S.pianoOctave}</span><button class="icn" onclick="S.pianoOctave=Math.min(6,S.pianoOctave+1);UI.openPiano()">▶</button></div>
      <div class="piano-scroll">${pianoHTML}</div>
      <div class="note-guide"><h3>Notas desta oitava</h3><div class="ng-grid">${keys.filter(k=>!k.black).map(k=>`<div class="ng-item" onclick="AE.playNote(${k.freq*Math.pow(2,S.pianoOctave-4)})"><div class="ng-note">${k.note}</div><div class="ng-freq">${Math.round(k.freq*Math.pow(2,S.pianoOctave-4))}Hz</div></div>`).join('')}</div></div>
    </div>`);
  },

  flashKey(el){ el.classList.add('pressed'); setTimeout(()=>el.classList.remove('pressed'),300) },

  async openTuner(){
    this.openModal(`<div class="mcard tuner-modal">
      <div class="mhdr"><h2>🎙 Afinador</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="tuner-body" id="tunerBody">
        <div class="tuner-note" id="tunerNote">—</div>
        <div class="tuner-freq" id="tunerFreq">0 Hz</div>
        <div class="tuner-meter"><div class="meter-scale"><div class="meter-center"></div><div class="meter-needle" id="meterNeedle"></div></div></div>
        <div class="tuner-cents" id="tunerCents">0 cents</div>
        <div class="tuner-status" id="tunerStatus">Iniciando microfone...</div>
      </div>
      <button class="btn-gh" onclick="UI.closeModal()">Fechar</button>
    </div>`);
    AE.initCtx();
    const ok = await AE.startTuner();
    const statusEl=document.getElementById('tunerStatus');
    if(ok&&statusEl) statusEl.textContent='🎙 Ouvindo... Toque uma nota!';
    else if(statusEl) statusEl.textContent='❌ Microfone não disponível';
  },

  updateTuner(){
    const n=document.getElementById('tunerNote');
    const f=document.getElementById('tunerFreq');
    const c=document.getElementById('tunerCents');
    const nd=document.getElementById('meterNeedle');
    if(n) n.textContent=S.tunerNote;
    if(f) f.textContent=`${S.tunerFreq} Hz`;
    if(c) c.textContent=`${S.tunerCents>0?'+':''}${S.tunerCents} cents`;
    if(nd){ const pct=50+(S.tunerCents/50)*50; nd.style.left=`${Math.max(5,Math.min(95,pct))}%`; nd.style.background=Math.abs(S.tunerCents)<10?'#00CC66':'#FF4444' }
    if(n){ n.style.color=Math.abs(S.tunerCents)<10?'#00CC66':'var(--text)' }
  },

  openRhythm(){
    const pattern=Learn.rhythmPatterns[0];
    let cur=0, active=false, intv=null;
    const startStop=()=>{
      active=!active;
      const btn=document.getElementById('rhythmBtn');
      if(btn) btn.textContent=active?'⏹ Parar':'▶ Tocar';
      if(active){
        cur=0;
        const ms=Math.round(60000/(pattern.bpm*4));
        intv=setInterval(()=>{
          const beats=document.querySelectorAll('.beat');
          beats.forEach((b,i)=>b.classList.toggle('on',i===cur));
          if(pattern.pattern[cur]){ AE.initCtx(); const o=AE.ctx.createOscillator(),g=AE.ctx.createGain(); o.connect(g); g.connect(AE.ctx.destination); o.frequency.value=cur%4===0?800:600; g.gain.setValueAtTime(.3,AE.ctx.currentTime); g.gain.exponentialRampToValueAtTime(.001,AE.ctx.currentTime+.05); o.start(); o.stop(AE.ctx.currentTime+.05) }
          cur=(cur+1)%pattern.pattern.length;
        },ms);
      } else { clearInterval(intv); document.querySelectorAll('.beat').forEach(b=>b.classList.remove('on')) }
    };
    const patHTML=pattern.pattern.map((_,i)=>`<div class="beat${_%4===0?' beat-acc':''}" data-i="${i}"></div>`).join('');
    this.openModal(`<div class="mcard">
      <div class="mhdr"><h2>🥁 Ritmos</h2><button onclick="clearInterval(window._rhythmIntv);UI.closeModal()">✕</button></div>
      <div class="rhythm-pats">${Learn.rhythmPatterns.map((p,i)=>`<button class="rpat-btn${i===0?' act':''}">${p.name}</button>`).join('')}</div>
      <div class="beats-row" id="beatsRow">${patHTML}</div>
      <div class="rhythm-ctrl">
        <button class="btn-pri" id="rhythmBtn" onclick="(${startStop.toString()})()">▶ Tocar</button>
      </div>
      ${[['4/4','O compasso mais comum. 4 batidas por compasso. Rock, pop, blues.'],['3/4','3 batidas. Som de valsa. Muito usado no jazz.'],['Samba','Ritmo brasileiro afro-descendente. Caracterizado pelo surdo e pandeiro.'],['Bossa Nova','Fusão de samba e jazz. Batida syncopada de violão.']].map(([n,d])=>`<div class="rhythm-info"><div class="ri-name">${n}</div><div class="ri-desc">${d}</div></div>`).join('')}
    </div>`);
  },

  openGenreExplorer(){
    const genres=['Rock','Jazz','Samba','MPB','Electronic','Classical','Bossa Nova','Forró'];
    this.openModal(`<div class="mcard">
      <div class="mhdr"><h2>🌍 Gêneros Musicais</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="genre-exp">${genres.map(g=>{ const i=Learn.getGenreInfo(g); return `<div class="ge-card" onclick="UI.showGenre('${g}')"><div class="ge-em">${i.e}</div><div class="ge-nm">${g}</div><div class="ge-md">${i.mood}</div></div>` }).join('')}</div>
    </div>`);
  },

  showGenre(g){
    const i=Learn.getGenreInfo(g);
    const mySongs=S.songs.filter(s=>s.genre===g);
    this.openModal(`<div class="mcard">
      <div class="mhdr"><h2>${i.e} ${g}</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="gd-desc">${i.desc}</div>
      <div class="gd-stats"><div class="gd-s"><span>⚡ BPM</span><strong>${i.bpm}</strong></div><div class="gd-s"><span>😊 Mood</span><strong>${i.mood}</strong></div><div class="gd-s"><span>🌍 Origem</span><strong>${i.origin}</strong></div><div class="gd-s"><span>🎵 Suas</span><strong>${mySongs.length}</strong></div></div>
      ${mySongs.length?`<button class="btn-pri" onclick="App.playSong(State_getSong(${mySongs[0].id}),${JSON.stringify(mySongs.map(s=>s.id))}.map(id=>State_getSong(id)).filter(Boolean),0);UI.closeModal()">▶ Tocar ${g}</button>
      <div class="gd-songs">${mySongs.slice(0,5).map(s=>`<div class="gd-song" onclick="App.playSong(State_getSong(${s.id}),${JSON.stringify(mySongs.map(x=>x.id))}.map(id=>State_getSong(id)).filter(Boolean),${mySongs.indexOf(s)});UI.closeModal()">▶ ${this.esc(s.title||'Sem título')}</div>`).join('')}</div>`:''}
      <button class="btn-gh" onclick="UI.openGenreExplorer()">← Voltar</button>
    </div>`);
  },

  openChords(){
    this.openModal(`<div class="mcard">
      <div class="mhdr"><h2>🎸 Acordes</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="chords-list">${Object.entries(Learn.chords).map(([name,notes])=>`<div class="chord-row"><div class="ch-nm">${name}</div><div class="ch-nt">${notes}</div></div>`).join('')}</div>
      <div class="chord-tip">Acordes são combinações de notas tocadas simultaneamente. Maiores soam alegres; menores, melancólicos.</div>
    </div>`);
  },

  openPomodoro(){
    this.openModal(`<div class="mcard">
      <div class="mhdr"><h2>⏱ Pomodoro Musical</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="pom-body" id="pomBody">
        <div class="pom-mode" id="pomMode">${S.pomodoroActive?(S.pomodoroMode==='work'?'💪 Foco':'☕ Pausa'):'Pronto'}</div>
        <div class="pom-time" id="pomTime">${UI.fmtTime(S.pomodoroTime)}</div>
        <div class="pom-desc" id="pomDesc">${S.pomodoroActive?(S.pomodoroMode==='work'?'Concentre-se na música':'Descanse um pouco'):'Configure e inicie'}</div>
      </div>
      <div class="pom-cfg">
        <div class="pom-row"><label>Foco (min)</label><input type="number" id="pomWork" value="25" min="1" max="60" class="minp" style="width:70px"></div>
        <div class="pom-row"><label>Pausa (min)</label><input type="number" id="pomBreak" value="5" min="1" max="30" class="minp" style="width:70px"></div>
      </div>
      <button class="btn-pri" id="pomBtn" onclick="App.startPomodoro(parseInt(document.getElementById('pomWork').value),parseInt(document.getElementById('pomBreak').value));UI.updatePomodoro()">${S.pomodoroActive?'⏹ Parar':'▶ Iniciar'}</button>
      <div class="pom-tip">Técnica Pomodoro: 25 min de foco + 5 min de pausa. Com música, melhora concentração em até 40%!</div>
    </div>`);
  },

  updatePomodoro(){
    const m=document.getElementById('pomMode');
    const t=document.getElementById('pomTime');
    const d=document.getElementById('pomDesc');
    const btn=document.getElementById('pomBtn');
    if(m) m.textContent=S.pomodoroActive?(S.pomodoroMode==='work'?'💪 Foco':'☕ Pausa'):'Pronto';
    if(t) t.textContent=this.fmtTime(S.pomodoroTime);
    if(d) d.textContent=S.pomodoroActive?(S.pomodoroMode==='work'?'Concentre-se na música':'Descanse um pouco'):'Configure e inicie';
    if(btn) btn.textContent=S.pomodoroActive?'⏹ Parar':'▶ Iniciar';
  },

  showXPModal(){
    const lvl=Learn.getXPLevel(S.xpTotal);
    const levels=[[0,'🎵','Iniciante'],[50,'🎸','Aprendiz'],[150,'🎹','Músico'],[350,'🎺','Virtuoso'],[700,'🎼','Maestro'],[1200,'🏆','Lenda']];
    this.openModal(`<div class="mcard">
      <div class="mhdr"><h2>✦ Seu Progresso</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="xp-modal-hero"><div class="xpm-icon">${lvl.icon}</div><div class="xpm-name">${lvl.name}</div><div class="xpm-pts">${S.xpTotal} XP</div></div>
      <div class="xp-track" style="height:10px;border-radius:5px;margin:12px 0"><div class="xp-fill" style="width:${lvl.progress}%"></div></div>
      ${lvl.next?`<div class="xp-next">Faltam ${lvl.next.min-S.xpTotal} XP para ${lvl.next.icon} ${lvl.next.name}</div>`:''}
      <div class="xp-levels">${levels.map(([min,ic,nm])=>`<div class="xp-lev${S.xpTotal>=min?' reached':''}"><span>${ic}</span><small>${nm}</small><small class="xp-lev-pts">${min}XP</small></div>`).join('')}</div>
      <div class="xp-tips"><div class="xp-tip-ttl">Como ganhar XP</div>${[['▶ Ouvir música','5 XP'],['❤ Favoritar','2 XP'],['📋 Criar playlist','15 XP'],['🎯 Quiz correto','20 XP'],['📁 Importar músicas','10 XP/música']].map(([a,x])=>`<div class="xp-tip-row"><span>${a}</span><span class="xp-badge">${x}</span></div>`).join('')}</div>
    </div>`);
  },

  openSmartPlaylists(){
    const smart=[{id:'top',name:'🔥 Mais Tocadas',desc:'As músicas que você mais ouviu'},{id:'recent',name:'🆕 Recentes',desc:'Adicionadas nos últimos dias'},{id:'fav',name:'❤️ Favoritas',desc:'Tudo que você favoritou'},{id:'rated',name:'⭐ Bem Avaliadas',desc:'4 e 5 estrelas'},{id:'unplayed',name:'🎵 Não Tocadas',desc:'Músicas que ainda não ouviu'}];
    this.openModal(`<div class="mcard">
      <div class="mhdr"><h2>✨ Smart Playlists</h2><button onclick="UI.closeModal()">✕</button></div>
      <div class="smart-list">${smart.map(sp=>`<div class="smart-item"><div class="si-inf"><div class="si-nm">${sp.name}</div><div class="si-ds">${sp.desc} · ${App.getSmartPlaylist(sp.id).length} músicas</div></div><button class="btn-ac" onclick="UI.playSmart('${sp.id}');UI.closeModal()">▶</button></div>`).join('')}</div>
    </div>`);
  },

  async analyzeSongBPM(id){
    UI.notify('🥁 Analisando BPM...','info');
    const song=S.songs.find(s=>s.id===id);
    if(song?.fileData){
      AE.initCtx(); AE.load(song);
      await AE.play(); AE.pause();
      setTimeout(async()=>{
        const bpm=await AE.analyzeBPM();
        if(bpm>0){ song.bpm=bpm; await window.PlayLuzDB.updateSong(song); S.songs=await window.PlayLuzDB.getSongs(); UI.notify(`🥁 BPM: ${bpm}`,'success'); UI.closeModal() }
        else UI.notify('Não foi possível detectar o BPM','error');
      },500);
    }
  },

  addSongsToPLMode(plId){
    this.closeModal();
    S.selMode=true; S.selected.clear();
    UI.switchTab('library');
    setTimeout(()=>{
      const addBtn=document.querySelector('.btn-ac');
      if(addBtn){ addBtn.onclick=()=>{ App.addToPlaylist(plId,[...S.selected]); S.selMode=false; S.selected.clear(); UI.openPL(plId) } }
    },100);
  },


  // ── VISUALIZER ──
  startVizLoop(){
    if(this.vizLoopId) cancelAnimationFrame(this.vizLoopId);
    const draw=()=>{
      this.vizLoopId=requestAnimationFrame(draw);
      this.drawMiniViz();
      this.drawFullViz();
    };
    draw();
  },

  drawMiniViz(){
    const c=document.getElementById('miniViz'); if(!c) return;
    const ctx=c.getContext('2d'), W=c.width, H=c.height;
    ctx.clearRect(0,0,W,H);
    const data=AE.getFreq(); if(!data) return;
    const bars=20, bw=W/bars;
    const col=S.dynColor||'#7B2FFF';
    for(let i=0;i<bars;i++){
      const v=data[Math.floor(i*data.length/bars)]/255;
      const h=v*H;
      ctx.fillStyle=col;
      ctx.globalAlpha=0.8;
      ctx.fillRect(i*bw+1,H-h,bw-2,h);
    }
    ctx.globalAlpha=1;
  },

  drawFullViz(){
    const c=document.getElementById('fpViz'); if(!c) return;
    const ctx=c.getContext('2d'), W=c.width, H=c.height;
    ctx.clearRect(0,0,W,H);
    const col=S.dynColor||'#7B2FFF';
    if(S.vizMode===0){ // Bars
      const data=AE.getFreq(); if(!data) return;
      const bars=64, bw=W/bars;
      for(let i=0;i<bars;i++){
        const v=data[Math.floor(i*data.length/bars)]/255;
        const h=v*H*0.9;
        const grd=ctx.createLinearGradient(0,H,0,H-h);
        grd.addColorStop(0,col);
        grd.addColorStop(1,'#00F0FF');
        ctx.fillStyle=grd;
        ctx.beginPath();
        if(ctx.roundRect) ctx.roundRect(i*bw+1,H-h,bw-2,h,2);
        else ctx.rect(i*bw+1,H-h,bw-2,h);
        ctx.fill();
      }
    } else if(S.vizMode===1){ // Wave
      const data=AE.getTime(); if(!data) return;
      ctx.strokeStyle=col; ctx.lineWidth=2;
      ctx.beginPath();
      data.forEach((v,i)=>{
        const x=i*(W/data.length);
        const y=(v/255)*H;
        i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
      });
      ctx.stroke();
    } else { // Circle
      const data=AE.getFreq(); if(!data) return;
      const cx=W/2, cy=H/2, r=30;
      ctx.strokeStyle=col; ctx.lineWidth=1.5;
      for(let i=0;i<data.length;i++){
        const angle=(i/data.length)*Math.PI*2;
        const len=(data[i]/255)*(H/2-r);
        ctx.beginPath();
        ctx.moveTo(cx+Math.cos(angle)*r, cy+Math.sin(angle)*r);
        ctx.lineTo(cx+Math.cos(angle)*(r+len), cy+Math.sin(angle)*(r+len));
        ctx.stroke();
      }
    }
  },

  // ── UPDATES ──
  updateNowPlaying(){
    const s=S.currentSong; if(!s) return;
    const fpTtl=document.getElementById('fpTtl');
    const fpArt=document.getElementById('fpArt');
    const fpPlay=document.getElementById('fpPlay');
    const fpFav=document.getElementById('fpFav');
    if(fpTtl) fpTtl.textContent=s.title||'Sem título';
    if(fpArt) fpArt.textContent=s.artist||'Artista';
    if(fpPlay) fpPlay.textContent=S.playing?'⏸':'▶';
    if(fpFav){ const isFav=S.favorites.includes(s.id); fpFav.innerHTML=`${isFav?'❤':'♡'} Favoritar`; fpFav.classList.toggle('act',isFav) }
  },

  updateMiniPlayer(){
    const s=S.currentSong;
    const t=document.getElementById('pbarTitle');
    const a=document.getElementById('pbarArtist');
    const h=document.getElementById('miniHeart');
    const cov=document.getElementById('pbarCover');
    if(t) t.textContent=s?s.title||'Sem título':'—';
    if(a) a.textContent=s?s.artist||'Artista':'Selecione uma música';
    if(h&&s) h.textContent=S.favorites.includes(s.id)?'❤':'♡';
    if(cov&&s?.cover){
      let img=cov.querySelector('.mini-cover-img');
      if(!img){ img=document.createElement('img'); img.className='mini-cover-img'; img.style.cssText='position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:10px'; cov.appendChild(img) }
      img.src=s.cover;
    }
  },

  showPlayerBar(){ document.getElementById('pbar')?.classList.remove('hidden') },

  updatePlayBtn(){
    const b=document.getElementById('playBtn');
    const fp=document.getElementById('fpPlay');
    if(b) b.textContent=S.playing?'⏸':'▶';
    if(fp) fp.textContent=S.playing?'⏸':'▶';
  },

  updateProgress(){
    const pct=S.duration?(S.progress/S.duration)*100:0;
    const fill=document.getElementById('pbarFill');
    const range=document.getElementById('pbarRange');
    const fpRng=document.getElementById('fpRng');
    const fpCur=document.getElementById('fpCur');
    const fpDur=document.getElementById('fpDur');
    if(fill) fill.style.width=`${pct}%`;
    if(range) range.value=pct;
    if(fpRng) fpRng.value=pct;
    if(fpCur) fpCur.textContent=this.fmtTime(S.progress);
    if(fpDur) fpDur.textContent=this.fmtTime(S.duration);
  },

  updateFavBtns(id,isFav){
    document.querySelectorAll(`[data-id="${id}"] .hbtn`).forEach(b=>{ b.textContent=isFav?'❤':'♡'; b.classList.toggle('fav',isFav) });
    const mh=document.getElementById('miniHeart');
    if(mh&&S.currentSong?.id===id) mh.textContent=isFav?'❤':'♡';
    const fpFav=document.getElementById('fpFav');
    if(fpFav&&S.currentSong?.id===id){ fpFav.innerHTML=`${isFav?'❤':'♡'} Favoritar`; fpFav.classList.toggle('act',isFav) }
  },

  applyDynColor(color){
    document.documentElement.style.setProperty('--dyn',color);
    const meta=document.getElementById('themeMetaColor');
    if(meta&&S.theme==='dark') meta.content=color;
  },

  applyTheme(theme){
    S.theme=theme;
    document.documentElement.setAttribute('data-theme',theme);
    window.PlayLuzDB.setSetting('theme',theme);
    const meta=document.getElementById('themeMetaColor');
    if(meta) meta.content=theme==='dark'?'#050810':'#F5F7FF';
    const ic=document.getElementById('themeIc');
    const lb=document.getElementById('themeLb');
    if(ic) ic.textContent=theme==='dark'?'☀':'🌙';
    if(lb) lb.textContent=theme==='dark'?'Claro':'Escuro';
  },

  toggleTheme(){
    const t=S.theme==='dark'?'light':'dark';
    this.applyTheme(t);
    this.notify(t==='dark'?'🌙 Modo Escuro':'☀️ Modo Claro','info');
  },

  showInstallBanner(){ if(!S.installed) document.getElementById('installBanner')?.classList.remove('hidden') },
  hideInstallBanner(){ document.getElementById('installBanner')?.classList.add('hidden') },

  notify(msg,type='info'){
    const n=document.getElementById('notif'); if(!n) return;
    n.textContent=msg; n.className=`notif ${type}`;
    n.classList.remove('hidden');
    clearTimeout(this._nt);
    this._nt=setTimeout(()=>n.classList.add('hidden'),3000);
  },

  toggleSel(idOrEvent, checked){
    if(typeof idOrEvent==='object'||idOrEvent===undefined){ // toggle mode
      S.selMode=!S.selMode;
      if(!S.selMode) S.selected.clear();
      this.renderView(S.tab); return;
    }
    if(checked) S.selected.add(idOrEvent); else S.selected.delete(idOrEvent);
    const hdr=document.querySelector('.hdr-acts .btn-ac');
    if(hdr) hdr.textContent=`+ Playlist (${S.selected.size})`;
  },

  toggleSearchSel(){
    S.selMode=!S.selMode;
    if(!S.selMode) S.selected.clear();
    this.renderView('search');
  },

  cancelSel(){ S.selMode=false; S.selected.clear(); this.renderView(S.tab) },

  bindGlobal(){
    document.addEventListener('keydown',e=>{
      if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
      if(e.code==='Space'){ e.preventDefault(); App.togglePlay() }
      if(e.code==='ArrowRight') App.next();
      if(e.code==='ArrowLeft') App.prev();
      if(e.code==='KeyM'){ S.muted=!S.muted; AE.el.muted=S.muted }
    });
    // Swipe gestures
    let tx=0, ty=0;
    document.addEventListener('touchstart',e=>{ tx=e.touches[0].clientX; ty=e.touches[0].clientY },{ passive:true });
    document.addEventListener('touchend',e=>{
      const dx=e.changedTouches[0].clientX-tx;
      const dy=e.changedTouches[0].clientY-ty;
      if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)&&S.currentSong){
        if(dx<0) App.next(); else App.prev();
      }
    },{ passive:true });
  },

  fmtTime(s){ if(!s||isNaN(s)) return '0:00'; return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}` },
  esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') },
  songColor(id){ const cs=['#7B2FFF','#FF2F7B','#2FFFB4','#FFB42F','#2F9BFF','#FF6B2F','#B42FFF']; return cs[(id||0)%cs.length] },
};

// Helper: get song from state
function State_getSong(id){ return S.songs.find(s=>s.id===id) }

// Install PWA
App.installPWA=async function(){
  if(S.installPrompt){ S.installPrompt.prompt(); const{outcome}=await S.installPrompt.userChoice; if(outcome==='accepted'){ S.installed=true; UI.hideInstallBanner() } S.installPrompt=null }
};


// ─── CSS ─────────────────────────────────────────────
UI.injectCSS = function(){
  const s=document.createElement('style');
  s.textContent=`
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root,[data-theme="light"]{
  --bg:#F5F7FF;--bg2:#FFFFFF;--bg3:#EEF1FA;--bg4:#E2E7F5;
  --acc:#6B1FEF;--acc2:#0090CC;--acc3:#E0215A;--dyn:#6B1FEF;
  --text:#0D1117;--muted:#5A6480;--border:#D0D8EE;
  --nav-h:64px;--pbar-h:72px;
  --r:16px;--rs:10px;
  --font:'Syne',sans-serif;--mono:'Space Mono',monospace;
  --shadow:0 2px 12px rgba(0,0,0,.07);
}
[data-theme="dark"]{
  --bg:#050810;--bg2:#0d1117;--bg3:#141a24;--bg4:#1a2235;
  --acc:#7B2FFF;--acc2:#00F0FF;--acc3:#FF2F7B;
  --text:#F0F4FF;--muted:#8892AA;--border:#1e2a3d;
  --shadow:0 2px 12px rgba(0,0,0,.4);
}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:var(--font)}
.shell{height:100vh;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
.main-area{flex:1;overflow-y:auto;overflow-x:hidden;padding-bottom:calc(var(--pbar-h) + var(--nav-h) + env(safe-area-inset-bottom));scroll-behavior:smooth}
.main-area::-webkit-scrollbar{width:3px}.main-area::-webkit-scrollbar-thumb{background:var(--acc);border-radius:3px}
.view{padding:12px 14px 8px;max-width:600px;margin:0 auto}

/* HOME */
.home-hdr{text-align:center;padding:16px 0 12px}
.greet{font-size:.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:2px;margin-bottom:4px}
.home-logo{font-size:2rem;font-weight:800;background:linear-gradient(135deg,var(--dyn),var(--acc2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.fact-pill{margin-top:10px;background:var(--bg3);border:1px solid var(--border);border-left:3px solid var(--dyn);padding:9px 12px;border-radius:var(--rs);font-size:.8rem;color:var(--muted);line-height:1.5;text-align:left}
.xp-bar-wrap{background:var(--bg3);border:1px solid var(--border);border-radius:var(--rs);padding:10px 14px;margin:10px 0;cursor:pointer;transition:border-color .2s}
.xp-bar-wrap:active{border-color:var(--acc)}
.xp-info{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.xp-icon{font-size:1.1rem}.xp-name{font-size:.85rem;font-weight:700}.xp-pts{font-size:.8rem;color:var(--muted);margin-left:auto;font-family:var(--mono)}
.xp-track{height:6px;background:var(--bg4);border-radius:3px;overflow:hidden}
.xp-fill{height:100%;background:linear-gradient(90deg,var(--acc),var(--acc2));border-radius:3px;transition:width .5s}
.xp-next{font-size:.72rem;color:var(--muted);margin-top:4px}
.qa-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0 16px}
.qa-btn{background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:12px 6px;display:flex;flex-direction:column;align-items:center;gap:5px;cursor:pointer;color:var(--text);font-family:var(--font);font-size:.72rem;font-weight:600;transition:all .15s}
.qa-btn:active{transform:scale(.95);border-color:var(--acc)}.qa-btn span:first-child{font-size:1.3rem}
.home-sec{margin-bottom:20px}.sec-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.sec-hdr h2{font-size:1rem;font-weight:700}.sec-hdr button{background:none;border:none;color:var(--acc);font-size:.78rem;cursor:pointer;font-family:var(--font)}
.hscroll{display:flex;gap:12px;overflow-x:auto;padding-bottom:6px;scrollbar-width:none}.hscroll::-webkit-scrollbar{display:none}
.sec-lbl{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:8px}

/* CARDS */
.scard{flex:0 0 120px;cursor:pointer;transition:transform .15s}.scard:active{transform:scale(.95)}
.scard.playing .scard-cov{box-shadow:0 0 16px var(--dyn)}
.scard-cov{width:120px;height:120px;border-radius:var(--r);display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.cov-img{width:100%;height:100%;object-fit:cover;border-radius:inherit}
.cov-lt,.row-lt,.fp-lt{font-size:2rem;font-weight:800}
.scard-ttl{font-size:.82rem;font-weight:700;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scard-art{font-size:.72rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scard-stars{font-size:.7rem;margin-top:2px}
.plcard{flex:0 0 110px;cursor:pointer}
.plcard-cov{width:110px;height:110px;border-radius:var(--r);background:linear-gradient(135deg,var(--acc)44,var(--bg3));display:flex;align-items:center;justify-content:center;font-size:2rem}
.plcard-nm{font-size:.8rem;font-weight:600;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* SONG ROW */
.vhdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-top:6px}
.vhdr h1{font-size:1.5rem;font-weight:800}
.hdr-acts{display:flex;gap:6px;align-items:center}
.lib-stats{font-size:.78rem;color:var(--muted);margin-bottom:10px;display:flex;gap:14px}
.slist{display:flex;flex-direction:column;gap:1px}
.srow{display:flex;align-items:center;gap:8px;padding:7px 6px;border-radius:var(--rs);transition:background .1s;position:relative}
.srow:active{background:var(--bg3)}.srow.playing{background:var(--bg3)}.srow.sel{background:#6B1FEF18;border:1px solid var(--acc)}
.row-cov{width:44px;height:44px;flex-shrink:0;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;position:relative;overflow:hidden}
.row-info{flex:1;min-width:0;cursor:pointer}
.row-ttl{font-size:.88rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-sub{font-size:.74rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-meta{display:flex;align-items:center;gap:3px;flex-shrink:0}
.rdur{font-size:.72rem;color:var(--muted);font-family:var(--mono);min-width:34px;text-align:right}
.gtag{background:var(--bg4);border:1px solid var(--border);border-radius:20px;padding:0 6px;font-size:.65rem;color:var(--muted)}
.btag{background:#FF6B2F22;border:1px solid #FF6B2F44;border-radius:20px;padding:0 6px;font-size:.65rem;color:#FF6B2F}
.play-anim,.row-play{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;padding-bottom:4px;gap:2px;background:#00000066}
.play-anim span,.row-play span{width:3px;background:var(--acc2);border-radius:2px;animation:eq .8s ease-in-out infinite}
.play-anim span:nth-child(1),.row-play span:nth-child(1){height:8px}.play-anim span:nth-child(2),.row-play span:nth-child(2){height:14px;animation-delay:.2s}.play-anim span:nth-child(3),.row-play span:nth-child(3){height:10px;animation-delay:.4s}
@keyframes eq{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.3)}}

/* SEARCH */
.srch-hdr{padding-top:6px;margin-bottom:10px;display:flex;flex-direction:column;gap:8px}
.srch-box{display:flex;align-items:center;background:var(--bg3);border:1px solid var(--border);border-radius:40px;padding:0 14px;gap:8px}
.srch-ic{font-size:1rem;color:var(--muted)}
#sInput{flex:1;background:none;border:none;outline:none;color:var(--text);font-family:var(--font);font-size:.92rem;padding:11px 0}
.clr-srch{background:none;border:none;color:var(--muted);cursor:pointer;font-size:.85rem}
.genre-wrap{margin-top:8px}.genre-ttl{font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.genre-chips{display:flex;flex-wrap:wrap;gap:7px}
.gchip{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:5px 12px;color:var(--text);font-family:var(--font);font-size:.78rem;cursor:pointer;transition:all .15s}
.gchip:active{background:var(--acc);color:#fff;border-color:var(--acc)}
.srch-cnt{font-size:.78rem;color:var(--muted);margin-bottom:8px}
.sel-acts{display:flex;gap:8px}
.loading{text-align:center;padding:20px;color:var(--muted)}

/* PLAYLISTS */
.smart-grid{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
.smart-btn{background:var(--bg3);border:1px solid var(--border);border-radius:var(--rs);padding:12px 14px;display:flex;justify-content:space-between;align-items:center;color:var(--text);font-family:var(--font);font-size:.88rem;font-weight:600;cursor:pointer;transition:border-color .15s}
.smart-btn:active{border-color:var(--acc)}.smart-cnt{font-size:.78rem;color:var(--muted);font-family:var(--mono)}
.pl-list{display:flex;flex-direction:column;gap:6px}
.pl-item{display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--r)}
.pl-item-cov{width:52px;height:52px;flex-shrink:0;border-radius:10px;background:linear-gradient(135deg,var(--acc)44,var(--bg4));display:flex;align-items:center;justify-content:center;font-size:1.4rem;cursor:pointer}
.pl-item-inf{flex:1;min-width:0;cursor:pointer}.pl-item-nm{font-size:.9rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pl-item-ds{font-size:.75rem;color:var(--muted)}
.pl-item-acts{display:flex;gap:4px}

/* STATS */
.stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:14px}
.stat-card{background:var(--bg3);border-radius:var(--rs);padding:12px;text-align:center;border:1px solid var(--border)}
.stat-n{font-size:1.6rem;font-weight:800;color:var(--acc)}.stat-l{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.stat-highlight{background:var(--bg3);border-radius:var(--rs);padding:12px;margin-bottom:14px;display:flex;flex-direction:column;gap:8px}
.hl-item{display:flex;justify-content:space-between;align-items:center}
.hl-lbl{font-size:.82rem;color:var(--muted)}.hl-val{font-size:.9rem;font-weight:700}
.top-songs{display:flex;flex-direction:column;gap:4px;margin-bottom:14px}
.top-row{display:flex;align-items:center;gap:10px;padding:8px;background:var(--bg3);border-radius:var(--rs)}
.top-n{font-size:.85rem;font-weight:700;color:var(--acc);min-width:18px;font-family:var(--mono)}
.top-inf{flex:1;min-width:0}.top-ttl{font-size:.88rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.top-sub{font-size:.74rem;color:var(--muted)}
.top-ct{font-size:.78rem;color:var(--muted);font-family:var(--mono);white-space:nowrap}
.xp-detail{background:var(--bg3);border-radius:var(--rs);padding:14px;margin-bottom:14px;text-align:center}
.xp-level-big{font-size:1.2rem;font-weight:700;margin-bottom:4px}.xp-pts-big{font-size:1rem;color:var(--acc);font-family:var(--mono);margin-bottom:10px}
.hist-list{display:flex;flex-direction:column;gap:2px}
.hist-row{padding:8px;border-radius:var(--rs);cursor:pointer;transition:background .1s}.hist-row:active{background:var(--bg3)}
.hist-ttl{font-size:.88rem;font-weight:600}.hist-sub{font-size:.74rem;color:var(--muted)}

/* LEARN */
.learn-fact{background:linear-gradient(135deg,var(--acc)22,var(--acc2)11);border:1px solid var(--acc);border-radius:var(--r);padding:14px;display:flex;align-items:flex-start;gap:10px;margin-bottom:14px}
.lf-ic{font-size:1.6rem;flex-shrink:0}.lf-txt{font-size:.88rem;line-height:1.5}
.learn-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
.ls-item{background:var(--bg3);border-radius:var(--rs);padding:10px;text-align:center;border:1px solid var(--border)}
.ls-item span{display:block;font-size:1.4rem;font-weight:800;color:var(--acc)}.ls-item small{font-size:.72rem;color:var(--muted)}
.learn-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.lbtn{background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:14px 12px;text-align:left;cursor:pointer;color:var(--text);font-family:var(--font);transition:all .15s}
.lbtn:active{border-color:var(--acc);transform:scale(.97)}.lb-ic{font-size:1.4rem;margin-bottom:6px}.lb-nm{font-size:.88rem;font-weight:700}.lb-ds{font-size:.72rem;color:var(--muted);margin-top:2px}
.xp-badge{background:var(--acc)22;border:1px solid var(--acc);border-radius:20px;padding:4px 10px;font-size:.76rem;color:var(--acc);font-weight:600}

/* PLAYER BAR */
.pbar{position:fixed;bottom:calc(var(--nav-h) + env(safe-area-inset-bottom));left:0;right:0;z-index:100;background:rgba(245,247,255,.93);backdrop-filter:blur(16px);border-top:1px solid var(--border);box-shadow:0 -2px 12px rgba(0,0,0,.06)}
[data-theme="dark"] .pbar{background:rgba(5,8,16,.92);box-shadow:0 -2px 12px rgba(0,0,0,.4)}
.pbar.hidden{display:none}
.pbar-prog{height:3px;background:var(--bg4);position:relative}
.pbar-fill{height:100%;background:linear-gradient(90deg,var(--dyn),var(--acc2));transition:width .1s linear}
.pbar-range{position:absolute;top:-8px;left:0;width:100%;height:18px;opacity:0;cursor:pointer}
.pbar-main{display:flex;align-items:center;padding:7px 10px;gap:8px;height:var(--pbar-h)}
.pbar-info{flex:1;display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer}
.pbar-cover{width:46px;height:46px;border-radius:10px;background:var(--bg3);flex-shrink:0;position:relative;overflow:hidden}
.mini-viz{position:absolute;top:0;left:0;width:100%;height:100%;border-radius:10px}
.pbar-text{flex:1;min-width:0}
.pbar-title{font-size:.88rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pbar-artist{font-size:.72rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pbar-ctrls{display:flex;align-items:center;gap:2px}
.cbtn{background:none;border:none;color:var(--text);font-size:1.05rem;padding:7px;cursor:pointer;border-radius:50%;line-height:1;transition:background .1s}
.cbtn:active{background:var(--bg3)}
.playbtn{background:var(--acc)!important;width:38px;height:38px;display:flex;align-items:center;justify-content:center;border-radius:50%;font-size:.95rem;color:#fff}
.hbtn.fav{color:var(--acc3)}

/* NAV */
.nav{position:fixed;bottom:0;left:0;right:0;height:calc(var(--nav-h) + env(safe-area-inset-bottom));display:flex;background:rgba(245,247,255,.96);backdrop-filter:blur(16px);border-top:1px solid var(--border);padding-bottom:env(safe-area-inset-bottom);z-index:101;overflow-x:auto;scrollbar-width:none}
.nav::-webkit-scrollbar{display:none}
[data-theme="dark"] .nav{background:rgba(5,8,16,.96)}
.nbtn{flex:1;min-width:52px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;background:none;border:none;color:var(--muted);cursor:pointer;font-family:var(--font);padding:6px 2px;transition:color .15s;position:relative;white-space:nowrap}
.nbtn.active{color:var(--acc)}
.nbtn.active::before{content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);width:28px;height:2px;background:var(--acc);border-radius:0 0 3px 3px}
.nic{font-size:1.2rem;line-height:1}.nlb{font-size:.58rem;font-weight:600;text-transform:uppercase;letter-spacing:.3px}

/* MODAL/OVERLAY */
.overlay{position:fixed;inset:0;background:rgba(13,17,23,.4);backdrop-filter:blur(4px);z-index:200;display:flex;align-items:flex-end;justify-content:center;padding:14px}
[data-theme="dark"] .overlay{background:rgba(0,0,0,.6)}
.overlay.hidden{display:none}
.overlay.modal-fs{padding:0;align-items:stretch}
.mcard{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r) var(--r) 0 0;padding:14px;width:100%;max-height:88vh;overflow-y:auto;animation:slideUp .2s ease-out;box-shadow:0 -8px 32px rgba(0,0,0,.1)}
[data-theme="dark"] .mcard{box-shadow:none}
@keyframes slideUp{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}
.mhdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:10px}
.mhdr h2{font-size:1.05rem;font-weight:700;flex:1}.mhdr button{background:none;border:none;color:var(--muted);font-size:1.1rem;cursor:pointer;padding:4px;border-radius:8px}
.mform{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
.minp{background:var(--bg3);border:1px solid var(--border);border-radius:var(--rs);padding:11px 12px;color:var(--text);font-family:var(--font);font-size:.92rem;outline:none;width:100%}
.minp:focus{border-color:var(--acc)}
.mtxt{background:var(--bg3);border:1px solid var(--border);border-radius:var(--rs);padding:11px 12px;color:var(--text);font-family:var(--font);font-size:.88rem;outline:none;width:100%;resize:none}
.macts{display:flex;flex-direction:column;gap:8px}.msub{font-size:.82rem;color:var(--muted);margin-bottom:10px}
.menu-acts{display:flex;flex-direction:column;gap:1px}
.mact{background:none;border:none;color:var(--text);font-family:var(--font);font-size:.92rem;padding:13px;text-align:left;border-radius:var(--rs);cursor:pointer;transition:background .1s}
.mact:active{background:var(--bg3)}.mact.danger{color:var(--acc3)}
.pl-sel-list{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.pl-sel-item{background:var(--bg3);border:1px solid var(--border);border-radius:var(--rs);padding:12px;text-align:left;color:var(--text);font-family:var(--font);font-size:.88rem;cursor:pointer;display:flex;align-items:center;gap:8px;transition:border-color .15s}
.pl-sel-item:active{border-color:var(--acc)}
.pl-detail-acts{display:flex;gap:8px;margin-bottom:12px}
.pl-slist{display:flex;flex-direction:column;gap:2px;max-height:52vh;overflow-y:auto}
.pl-srow{display:flex;align-items:center;gap:8px;padding:8px;border-radius:var(--rs);transition:background .1s}
.pl-srow:active{background:var(--bg3)}.pl-sinf{display:flex;align-items:center;gap:8px;flex:1;cursor:pointer;min-width:0}
.pl-snum{color:var(--muted);font-size:.78rem;min-width:18px;font-family:var(--mono)}.pl-sttl{font-size:.88rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pl-ssub{font-size:.74rem;color:var(--muted)}
.pl-ds-sm{font-size:.78rem;color:var(--muted);margin-top:2px}

/* FULL PLAYER */
.fp{position:relative;width:100%;height:100%;background:var(--bg);overflow-y:auto;animation:slideIn .3s ease-out}
@keyframes slideIn{from{transform:translateY(100%)}to{transform:translateY(0)}}
.fp-bg{position:fixed;inset:0;pointer-events:none}
.fp-cls{position:fixed;top:calc(10px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:5px 24px;color:var(--muted);font-size:1.1rem;cursor:pointer;z-index:2}
.fp-body{position:relative;z-index:1;padding:calc(54px + env(safe-area-inset-top)) 20px calc(20px + env(safe-area-inset-bottom));max-width:480px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.fp-cov-wrap{display:flex;justify-content:center}
.fp-cov{width:min(260px,72vw);height:min(260px,72vw);border-radius:22px;display:flex;align-items:center;justify-content:center;box-shadow:0 16px 48px color-mix(in srgb,var(--dyn) 30%,transparent)}
.fp-lt{font-size:3.5rem;font-weight:800}
.fp-info{text-align:center}.fp-ttl{font-size:1.3rem;font-weight:800;margin-bottom:3px}.fp-art{font-size:.95rem;color:var(--muted)}
.fp-meta{display:flex;justify-content:center;gap:8px;margin-top:5px;flex-wrap:wrap}
.fp-rating{display:flex;justify-content:center;gap:4px;margin-top:8px}
.star-btn{background:none;border:none;color:var(--border);font-size:1.4rem;cursor:pointer;transition:color .15s;padding:2px}
.star-btn.lit{color:#FFB800}
.fp-prog input[type=range]{-webkit-appearance:none;width:100%;height:4px;background:var(--bg4);border-radius:4px;outline:none}
.fp-prog input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--dyn);cursor:pointer}
.fp-times{display:flex;justify-content:space-between;font-size:.74rem;color:var(--muted);font-family:var(--mono);margin-top:4px}
.fp-ctrls{display:flex;align-items:center;justify-content:center;gap:12px}
.fp-btn{background:none;border:none;color:var(--text);cursor:pointer;font-size:1.3rem;padding:10px;border-radius:50%;transition:all .15s}
.fp-btn:active{background:var(--bg3);transform:scale(.9)}.fp-btn.act{color:var(--dyn)}
.fp-play{background:var(--dyn)!important;width:60px;height:60px;display:flex;align-items:center;justify-content:center;border-radius:50%;font-size:1.4rem;color:#fff!important;box-shadow:0 8px 20px color-mix(in srgb,var(--dyn) 40%,transparent)}
.fp-extras{display:flex;gap:7px;flex-wrap:wrap;justify-content:center}
.fp-xbtn{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:7px 14px;color:var(--text);font-family:var(--font);font-size:.78rem;cursor:pointer;transition:all .15s}
.fp-xbtn:active{border-color:var(--acc)}.fp-xbtn.act{color:var(--acc3);border-color:var(--acc3)}
.fp-vol{display:flex;align-items:center;gap:8px;font-size:.95rem}
.fp-vol input[type=range]{flex:1;-webkit-appearance:none;height:4px;background:var(--bg4);border-radius:4px}
.fp-vol input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--acc2);cursor:pointer}
.fp-viz{width:100%;height:90px;border-radius:var(--rs);background:var(--bg3)}

/* BUTTONS */
.btn-pri{background:var(--acc);color:#fff;border:none;border-radius:var(--rs);padding:12px 18px;font-family:var(--font);font-size:.9rem;font-weight:700;cursor:pointer;width:100%;transition:all .15s}
.btn-pri:active{transform:scale(.97)}.btn-pri:disabled{opacity:.4;cursor:not-allowed}
.btn-gh{background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:var(--rs);padding:12px 18px;font-family:var(--font);font-size:.9rem;font-weight:600;cursor:pointer;width:100%;transition:all .15s}
.btn-gh:active{border-color:var(--acc)}
.btn-ac{background:var(--acc)22;color:var(--acc);border:1px solid var(--acc);border-radius:20px;padding:5px 12px;font-family:var(--font);font-size:.78rem;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap}
.btn-ac:active{background:var(--acc);color:#fff}
.btn-danger{background:var(--acc3)22;color:var(--acc3);border:1px solid var(--acc3);border-radius:var(--rs);padding:12px 18px;font-family:var(--font);font-size:.9rem;font-weight:700;cursor:pointer;width:100%}
.icn{background:none;border:none;color:var(--muted);font-size:.95rem;padding:5px;cursor:pointer;border-radius:8px;transition:color .1s;font-family:var(--font)}
.icn:active{color:var(--text)}.icn.danger{color:var(--acc3)}

/* CHECKBOXES */
.chk-wrap{position:relative;width:22px;height:22px;flex-shrink:0;cursor:pointer}
.chk-wrap input{opacity:0;position:absolute;width:0;height:0}
.chkmark{position:absolute;inset:0;background:var(--bg3);border:2px solid var(--border);border-radius:6px;transition:all .15s}
.chk-wrap input:checked~.chkmark{background:var(--acc);border-color:var(--acc)}
.chk-wrap input:checked~.chkmark::after{content:'✓';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:.7rem;font-weight:700}

/* EQ MODAL */
.eq-sliders{display:flex;flex-direction:column;gap:12px;margin-bottom:14px}
.eq-band{display:flex;align-items:center;gap:8px}
.eq-lbl{width:80px;font-size:.82rem;font-weight:600;flex-shrink:0}
.eq-band input[type=range]{flex:1;-webkit-appearance:none;height:4px;background:var(--bg4);border-radius:4px}
.eq-band input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--acc2);cursor:pointer}
.eq-val{width:28px;text-align:right;font-size:.76rem;font-family:var(--mono);color:var(--muted)}
.eq-preset-lbl{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.preset-row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
.preset-btn{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:6px 12px;color:var(--text);font-family:var(--font);font-size:.78rem;cursor:pointer;transition:border-color .15s}
.preset-btn:active{border-color:var(--acc)}
.cf-row{display:flex;align-items:center;gap:8px;margin-bottom:14px}
.cf-lbl{font-size:.85rem;font-weight:600;width:90px;flex-shrink:0}
.cf-row input[type=range]{flex:1;-webkit-appearance:none;height:4px;background:var(--bg4);border-radius:4px}
.cf-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--acc);cursor:pointer}
.cf-val{width:28px;font-size:.76rem;font-family:var(--mono);color:var(--muted);text-align:right}

/* TIMER */
.timer-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
.timer-btn{background:var(--bg3);border:1px solid var(--border);border-radius:var(--rs);padding:13px;color:var(--text);font-family:var(--font);font-size:.88rem;font-weight:600;cursor:pointer;transition:all .15s}
.timer-btn:active{background:var(--acc);color:#fff;border-color:var(--acc)}

/* ADD MUSIC */
.add-opts{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.add-opt{display:flex;align-items:center;gap:12px;padding:13px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--rs);cursor:pointer;transition:border-color .15s}
.add-opt:active,.add-opt:hover{border-color:var(--acc)}
.add-opt-ic{font-size:1.5rem;flex-shrink:0}.add-opt-ttl{font-size:.88rem;font-weight:700}.add-opt-ds{font-size:.74rem;color:var(--muted);margin-top:2px}
.dz-over{border-color:var(--acc)!important;background:var(--acc)11!important}
.add-prog{display:flex;flex-direction:column;gap:5px;margin-top:10px}.add-prog.hidden{display:none}
.add-prog-bar{height:5px;background:var(--bg4);border-radius:3px;overflow:hidden}
.add-prog-fill{height:100%;background:linear-gradient(90deg,var(--acc),var(--acc2));transition:width .2s}

/* QUIZ */
.quiz-q{font-size:.95rem;font-weight:700;margin-bottom:14px;line-height:1.4}
.quiz-opts{display:flex;flex-direction:column;gap:7px;margin-bottom:12px}
.quiz-opt{background:var(--bg3);border:2px solid var(--border);border-radius:var(--rs);padding:13px;color:var(--text);font-family:var(--font);font-size:.88rem;text-align:left;cursor:pointer;transition:all .15s}
.quiz-opt:active{border-color:var(--acc)}.quiz-opt.correct{border-color:#00CC66;background:#00CC6622;color:#00CC66}.quiz-opt.wrong{border-color:var(--acc3);background:var(--acc3)22;color:var(--acc3)}
.quiz-res{text-align:center;padding:10px 0}.quiz-win{color:#00CC66;font-weight:700;margin-bottom:10px}.quiz-lose{color:var(--acc3);font-weight:700;margin-bottom:10px}

/* FLASHCARD */
.fc{perspective:1000px;height:170px;cursor:pointer;margin-bottom:14px}
.fc-inner{position:relative;width:100%;height:100%;transform-style:preserve-3d;transition:transform .5s}
.fc-inner.flipped{transform:rotateY(180deg)}
.fc-front,.fc-back{position:absolute;inset:0;backface-visibility:hidden;border-radius:var(--r);padding:20px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}
.fc-front{background:linear-gradient(135deg,var(--acc)44,var(--bg3));border:1px solid var(--acc)}
.fc-back{transform:rotateY(180deg);background:linear-gradient(135deg,var(--acc2)33,var(--bg3));border:1px solid var(--acc2)}
.fc-cat{font-size:.7rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted)}.fc-txt{font-size:1.3rem;font-weight:800;text-align:center}.fc-hint{font-size:.72rem;color:var(--muted)}

/* PIANO */
.piano-scroll{overflow-x:auto;padding-bottom:8px;scrollbar-width:none;margin-bottom:14px}.piano-scroll::-webkit-scrollbar{display:none}
.piano-wrap{display:inline-block;padding:4px}
.pkey{position:absolute;border-radius:0 0 6px 6px;cursor:pointer;transition:filter .1s;display:flex;align-items:flex-end;justify-content:center;padding-bottom:6px}
.pkey.white{background:#fff;border:1px solid #ccc;z-index:1}.pkey.white:active,.pkey.white.pressed{filter:brightness(.85);background:#e0e0ff}
.pkey.black{background:#1a1a2e;z-index:2}.pkey.black:active,.pkey.black.pressed{filter:brightness(1.5)}
.pnote{font-size:.6rem;color:#666;font-family:var(--mono)}
.octave-row{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:10px;font-size:.9rem;font-weight:600}
.note-guide h3{font-size:.82rem;font-weight:700;margin-bottom:8px;color:var(--muted)}
.ng-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
.ng-item{background:var(--bg3);border-radius:var(--rs);padding:8px 4px;text-align:center;cursor:pointer;transition:background .1s}
.ng-item:active{background:var(--acc);color:#fff}
.ng-note{font-size:.8rem;font-weight:700}.ng-freq{font-size:.62rem;color:var(--muted);font-family:var(--mono)}

/* TUNER */
.tuner-body{text-align:center;padding:16px 0}
.tuner-note{font-size:3rem;font-weight:800;font-family:var(--mono);margin-bottom:6px;transition:color .2s}
.tuner-freq{font-size:1rem;color:var(--muted);font-family:var(--mono);margin-bottom:14px}
.tuner-meter{margin:0 auto;width:90%;max-width:300px;margin-bottom:8px}
.meter-scale{position:relative;height:8px;background:var(--bg4);border-radius:4px;overflow:visible}
.meter-center{position:absolute;left:50%;top:-4px;width:2px;height:16px;background:var(--acc);transform:translateX(-50%)}
.meter-needle{position:absolute;top:-6px;width:4px;height:20px;border-radius:2px;background:#FF4444;transform:translateX(-50%);transition:left .1s,background .2s}
.tuner-cents{font-size:.85rem;color:var(--muted);font-family:var(--mono);margin-bottom:6px}
.tuner-status{font-size:.8rem;color:var(--muted)}

/* RHYTHM */
.rhythm-pats{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.rpat-btn{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:5px 12px;color:var(--text);font-family:var(--font);font-size:.78rem;cursor:pointer}
.rpat-btn.act{background:var(--acc);color:#fff;border-color:var(--acc)}
.beats-row{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:14px;justify-content:center}
.beat{width:28px;height:28px;border-radius:6px;background:var(--bg4);border:1px solid var(--border);transition:all .1s}
.beat.on{background:var(--acc);border-color:var(--acc);transform:scale(1.1)}
.beat.beat-acc.on{background:var(--acc3);border-color:var(--acc3)}
.rhythm-ctrl{margin-bottom:14px}
.rhythm-info{padding:10px;background:var(--bg3);border-radius:var(--rs);margin-bottom:6px}
.ri-name{font-size:.88rem;font-weight:700;margin-bottom:3px}.ri-desc{font-size:.78rem;color:var(--muted);line-height:1.4}

/* GENRE EXPLORER */
.genre-exp{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.ge-card{background:var(--bg3);border:1px solid var(--border);border-radius:var(--rs);padding:12px 8px;text-align:center;cursor:pointer;transition:border-color .15s}
.ge-card:active{border-color:var(--acc)}.ge-em{font-size:1.5rem;margin-bottom:4px}.ge-nm{font-size:.82rem;font-weight:700}.ge-md{font-size:.7rem;color:var(--muted);margin-top:2px}
.gd-desc{font-size:.88rem;line-height:1.6;margin-bottom:12px;color:var(--muted)}
.gd-stats{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.gd-s{background:var(--bg3);border-radius:var(--rs);padding:8px 10px;flex:1;min-width:60px;text-align:center;display:flex;flex-direction:column;gap:2px}
.gd-s span{font-size:.7rem;color:var(--muted)}.gd-s strong{font-size:.88rem;font-weight:700}
.gd-songs{margin:10px 0}.gd-song{padding:7px;cursor:pointer;color:var(--acc);font-size:.85rem;border-radius:6px}
.gd-song:active{background:var(--bg3)}

/* CHORDS */
.chords-list{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
.chord-row{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg3);border-radius:var(--rs)}
.ch-nm{font-size:.88rem;font-weight:700}.ch-nt{font-size:.82rem;color:var(--acc2);font-family:var(--mono)}
.chord-tip{font-size:.8rem;color:var(--muted);line-height:1.5;background:var(--bg3);border-radius:var(--rs);padding:10px}

/* POMODORO */
.pom-body{text-align:center;padding:16px 0;margin-bottom:12px}
.pom-mode{font-size:.9rem;font-weight:700;color:var(--acc);margin-bottom:6px}
.pom-time{font-size:3rem;font-weight:800;font-family:var(--mono);margin-bottom:6px}
.pom-desc{font-size:.82rem;color:var(--muted)}
.pom-cfg{display:flex;gap:12px;margin-bottom:12px;align-items:center;justify-content:center}
.pom-row{display:flex;align-items:center;gap:6px;font-size:.85rem}
.pom-tip{font-size:.78rem;color:var(--muted);line-height:1.5;margin-top:10px;padding:10px;background:var(--bg3);border-radius:var(--rs)}

/* XP MODAL */
.xp-modal-hero{text-align:center;padding:12px 0}
.xpm-icon{font-size:3rem;margin-bottom:8px}.xpm-name{font-size:1.3rem;font-weight:800}.xpm-pts{font-size:1rem;color:var(--acc);font-family:var(--mono)}
.xp-levels{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin:14px 0}
.xp-lev{display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 10px;border-radius:var(--rs);border:1px solid var(--border);opacity:.5;min-width:54px;text-align:center}
.xp-lev.reached{opacity:1;border-color:var(--acc);background:var(--acc)11}
.xp-lev span{font-size:1.1rem}.xp-lev small{font-size:.65rem;font-weight:600}.xp-lev-pts{color:var(--muted)!important}
.xp-tips{background:var(--bg3);border-radius:var(--rs);padding:12px}
.xp-tip-ttl{font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:8px}
.xp-tip-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:.82rem}
.xp-badge{background:var(--acc)22;color:var(--acc);border-radius:20px;padding:2px 8px;font-size:.72rem;font-weight:700}

/* SMART LIST */
.smart-list{display:flex;flex-direction:column;gap:6px}
.smart-item{background:var(--bg3);border:1px solid var(--border);border-radius:var(--rs);padding:12px;display:flex;align-items:center;gap:10px}
.si-inf{flex:1;min-width:0}.si-nm{font-size:.9rem;font-weight:700}.si-ds{font-size:.76rem;color:var(--muted)}

/* SONG INFO */
.info-grid{display:flex;flex-direction:column;gap:5px;margin-bottom:14px}
.info-row{display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--border)}
.ik{font-size:.76rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}.iv{font-size:.85rem;text-align:right;max-width:60%}
.rating-row{display:flex;align-items:center;gap:4px;margin-bottom:12px}

/* INSTALL BANNER */
.install-banner{background:linear-gradient(90deg,var(--acc)22,var(--acc2)11);border-bottom:1px solid var(--acc);padding:9px 14px;display:flex;align-items:center;gap:8px;font-size:.82rem;font-weight:600;z-index:50}
.install-banner.hidden{display:none}.btn-install{background:var(--acc);color:#fff;border:none;border-radius:20px;padding:5px 14px;font-family:var(--font);font-size:.76rem;font-weight:700;cursor:pointer;margin-left:auto}
.btn-close-x{background:none;border:none;color:var(--muted);font-size:.95rem;cursor:pointer;padding:3px}

/* NOTIFICATION */
.notif{position:fixed;top:calc(14px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);background:var(--bg3);border:1px solid var(--border);border-radius:var(--rs);padding:9px 18px;font-size:.82rem;font-weight:600;z-index:300;white-space:nowrap;box-shadow:var(--shadow);animation:nfIn .2s ease-out}
.notif.hidden{display:none}.notif.success{border-color:#00CC66;color:#00CC66}.notif.error{border-color:var(--acc3);color:var(--acc3)}.notif.info{border-color:var(--acc);color:var(--acc)}
@keyframes nfIn{from{transform:translateX(-50%) translateY(-8px);opacity:0}to{transform:translateX(-50%) translateY(0);opacity:1}}

/* EMPTY */
.empty{text-align:center;padding:36px 16px;display:flex;flex-direction:column;align-items:center;gap:10px}
.empty.small{padding:18px}.empty-ic{font-size:2.8rem}
.empty h2{font-size:1.1rem;font-weight:700}.empty p{color:var(--muted);font-size:.88rem}

@media(min-width:600px){
  .qa-grid{grid-template-columns:repeat(4,1fr)}
  .learn-grid{grid-template-columns:repeat(4,1fr)}
  .stats-grid{grid-template-columns:repeat(4,1fr)}
}
`;
  document.head.appendChild(s);
};

// ── INIT ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>App.init());
