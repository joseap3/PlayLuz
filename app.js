// ══════════════════════════════════════════════════
//  PlayLuz — Main Application
// ══════════════════════════════════════════════════

// ─── State ────────────────────────────────────────
const State = {
  songs: [], playlists: [], favorites: [], history: [],
  currentSong: null, currentQueue: [], currentIndex: -1,
  isPlaying: false, isShuffle: false, repeatMode: 0, // 0=off,1=all,2=one
  volume: 0.8, isMuted: false, progress: 0, duration: 0,
  theme: 'light', // 'light' | 'dark'
  currentTab: 'home', currentView: null, viewData: null,
  searchQuery: '', searchResults: [], isSearching: false,
  audioContext: null, analyser: null, dataArray: null,
  eq: { bass: 0, mid: 0, treble: 0 },
  visualizerActive: true, sleepTimer: null,
  learningMode: null, // null | 'quiz' | 'flashcard' | 'identify'
  learningData: {},
  installPrompt: null, isInstalled: false,
  notification: null, modalOpen: null,
  selectionMode: false, selectedSongs: new Set(),
  searchSelectionMode: false,
};

// ─── Audio Engine ──────────────────────────────────
const Audio = {
  el: new window.Audio(),
  ctx: null, analyser: null, src: null,
  gainNode: null, bassFilter: null, midFilter: null, trebleFilter: null,
  nodes: [],

  init() {
    this.el.volume = State.volume;
    this.el.addEventListener('timeupdate', () => {
      State.progress = this.el.currentTime;
      State.duration = this.el.duration || 0;
      UI.updateProgress();
    });
    this.el.addEventListener('ended', () => App.onSongEnd());
    this.el.addEventListener('loadedmetadata', () => {
      State.duration = this.el.duration;
      UI.updateProgress();
    });
    this.el.addEventListener('play', () => { State.isPlaying = true; UI.updatePlayButton(); UI.startVisualizerLoop(); });
    this.el.addEventListener('pause', () => { State.isPlaying = false; UI.updatePlayButton(); });
    this.el.addEventListener('error', () => UI.showNotification('Erro ao carregar áudio', 'error'));
  },

  initContext() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.src = this.ctx.createMediaElementSource(this.el);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    State.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = State.volume;
    // EQ filters
    this.bassFilter = this.ctx.createBiquadFilter(); this.bassFilter.type = 'lowshelf'; this.bassFilter.frequency.value = 200;
    this.midFilter = this.ctx.createBiquadFilter(); this.midFilter.type = 'peaking'; this.midFilter.frequency.value = 1000;
    this.trebleFilter = this.ctx.createBiquadFilter(); this.trebleFilter.type = 'highshelf'; this.trebleFilter.frequency.value = 4000;
    this.src.connect(this.bassFilter);
    this.bassFilter.connect(this.midFilter);
    this.midFilter.connect(this.trebleFilter);
    this.trebleFilter.connect(this.analyser);
    this.analyser.connect(this.gainNode);
    this.gainNode.connect(this.ctx.destination);
    State.analyser = this.analyser;
  },

  load(song) {
    if (!song || !song.fileData) return;
    this.el.src = song.fileData;
    this.el.load();
  },

  play() { if (this.ctx?.state === 'suspended') this.ctx.resume(); return this.el.play(); },
  pause() { this.el.pause(); },
  seek(t) { this.el.currentTime = t; },
  setVolume(v) { this.el.volume = v; if (this.gainNode) this.gainNode.gain.value = v; },
  setEQ(band, val) {
    this.initContext();
    if (band === 'bass') this.bassFilter.gain.value = val;
    if (band === 'mid') this.midFilter.gain.value = val;
    if (band === 'treble') this.trebleFilter.gain.value = val;
    State.eq[band] = val;
  },
  getFreqData() {
    if (!this.analyser) return null;
    this.analyser.getByteFrequencyData(State.dataArray);
    return State.dataArray;
  }
};

// ─── App Logic ─────────────────────────────────────
const App = {
  async init() {
    await window.PlayLuzDB.init();
    Audio.init();
    await this.loadData();
    UI.init();
    this.registerSW();
    this.checkInstalled();
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); State.installPrompt = e; UI.showInstallBanner(); });
    window.addEventListener('appinstalled', () => { State.isInstalled = true; UI.hideInstallBanner(); });
    const savedTheme = await window.PlayLuzDB.getSetting('theme', 'light');
    UI.applyTheme(savedTheme);
    const lastTab = await window.PlayLuzDB.getSetting('lastTab', 'home');
    UI.switchTab(lastTab);
  },

  async loadData() {
    State.songs = await window.PlayLuzDB.getSongs();
    State.playlists = await window.PlayLuzDB.getPlaylists();
    State.favorites = await window.PlayLuzDB.getFavorites();
    State.history = await window.PlayLuzDB.getHistory(20);
  },

  registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  },

  checkInstalled() {
    if (window.matchMedia('(display-mode: standalone)').matches) State.isInstalled = true;
    if (window.navigator.standalone) State.isInstalled = true;
  },

  async playSong(song, queue = null, index = 0) {
    if (!song) return;
    State.currentSong = song;
    if (queue) { State.currentQueue = queue; State.currentIndex = index; }
    Audio.initContext();
    Audio.load(song);
    await Audio.play();
    await window.PlayLuzDB.addHistory(song.id);
    await window.PlayLuzDB.incrementPlayCount(song.id);
    State.favorites = await window.PlayLuzDB.getFavorites();
    UI.updateNowPlaying();
    UI.updateMiniPlayer();
    UI.showPlayerBar();
    if ('mediaSession' in navigator) this.setupMediaSession(song);
  },

  setupMediaSession(song) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || 'Desconhecido',
      artist: song.artist || 'Artista',
      album: song.album || '',
      artwork: song.cover ? [{ src: song.cover, sizes: '512x512', type: 'image/jpeg' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => this.togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => this.togglePlay());
    navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
    navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
  },

  togglePlay() {
    if (State.isPlaying) Audio.pause();
    else { Audio.initContext(); Audio.play(); }
  },

  next() {
    if (State.currentQueue.length === 0) return;
    let idx = State.currentIndex;
    if (State.isShuffle) {
      idx = Math.floor(Math.random() * State.currentQueue.length);
    } else {
      idx = (idx + 1) % State.currentQueue.length;
    }
    State.currentIndex = idx;
    this.playSong(State.currentQueue[idx], null, idx);
  },

  prev() {
    if (Audio.el.currentTime > 3) { Audio.seek(0); return; }
    if (State.currentQueue.length === 0) return;
    let idx = State.isShuffle
      ? Math.floor(Math.random() * State.currentQueue.length)
      : (State.currentIndex - 1 + State.currentQueue.length) % State.currentQueue.length;
    State.currentIndex = idx;
    this.playSong(State.currentQueue[idx], null, idx);
  },

  onSongEnd() {
    if (State.repeatMode === 2) { Audio.seek(0); Audio.play(); return; }
    if (State.repeatMode === 1 || State.currentIndex < State.currentQueue.length - 1) {
      this.next();
    } else {
      State.isPlaying = false; UI.updatePlayButton();
    }
  },

  async addSongs(files) {
    const added = [];
    for (const file of files) {
      const song = await this.readAudioFile(file);
      const id = await window.PlayLuzDB.addSong(song);
      added.push({ ...song, id });
    }
    State.songs = await window.PlayLuzDB.getSongs();
    UI.renderCurrentView();
    UI.showNotification(`${added.length} música(s) adicionada(s)!`, 'success');
    return added;
  },

  readAudioFile(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const fileData = e.target.result;
        const song = {
          title: file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
          artist: 'Artista Desconhecido',
          album: '',
          genre: '',
          year: '',
          duration: 0,
          fileData,
          fileName: file.name,
          fileSize: file.size,
          cover: null,
        };
        // Try reading ID3 tags
        try {
          const meta = await this.readID3(fileData, file.type);
          Object.assign(song, meta);
        } catch(e) {}
        resolve(song);
      };
      reader.readAsDataURL(file);
    });
  },

  readID3(dataUrl, type) {
    return new Promise((resolve, reject) => {
      const audio = new window.Audio();
      audio.src = dataUrl;
      audio.addEventListener('loadedmetadata', () => {
        resolve({ duration: audio.duration });
      });
      audio.addEventListener('error', reject);
      setTimeout(() => resolve({ duration: 0 }), 3000);
    });
  },

  async search(q) {
    if (!q.trim()) { State.searchResults = []; State.isSearching = false; UI.renderSearch(); return; }
    State.isSearching = true;
    const results = await window.PlayLuzDB.searchSongs(q);
    State.searchResults = results;
    State.isSearching = false;
    UI.renderSearch();
  },

  async createPlaylist(name, description = '') {
    const id = await window.PlayLuzDB.addPlaylist(name, description);
    State.playlists = await window.PlayLuzDB.getPlaylists();
    UI.renderCurrentView();
    UI.showNotification(`Playlist "${name}" criada!`, 'success');
    return id;
  },

  async deletePlaylist(id) {
    await window.PlayLuzDB.deletePlaylist(id);
    State.playlists = await window.PlayLuzDB.getPlaylists();
    UI.renderCurrentView();
    UI.showNotification('Playlist removida', 'info');
  },

  async toggleFavorite(songId) {
    const isFav = await window.PlayLuzDB.toggleFavorite(songId);
    State.favorites = await window.PlayLuzDB.getFavorites();
    UI.updateFavoriteButtons(songId, isFav);
    UI.showNotification(isFav ? '❤️ Adicionado aos favoritos' : '💔 Removido dos favoritos', 'info');
    return isFav;
  },

  async addSelectionToPlaylist(playlistId) {
    const ids = [...State.selectedSongs];
    if (!ids.length) return;
    await window.PlayLuzDB.addSongsToPlaylist(playlistId, ids);
    State.selectionMode = false; State.searchSelectionMode = false;
    State.selectedSongs.clear();
    UI.showNotification(`${ids.length} música(s) adicionada(s) à playlist!`, 'success');
    UI.renderCurrentView();
  },

  setSleepTimer(minutes) {
    if (State.sleepTimer) clearTimeout(State.sleepTimer);
    if (!minutes) { UI.showNotification('Timer cancelado', 'info'); return; }
    State.sleepTimer = setTimeout(() => { Audio.pause(); UI.showNotification('😴 Timer de sono ativado', 'info'); }, minutes * 60000);
    UI.showNotification(`⏱️ Pausar em ${minutes} minutos`, 'success');
  },
};

// ─── Learning Module ───────────────────────────────
const Learning = {
  genres: ['Rock', 'Pop', 'Jazz', 'Blues', 'Classical', 'Electronic', 'Hip-Hop', 'R&B', 'Country', 'Reggae', 'Samba', 'Funk', 'MPB', 'Forró'],
  instruments: ['🎸 Guitarra', '🎹 Piano', '🥁 Bateria', '🎺 Trompete', '🎻 Violino', '🎷 Saxofone', '🎸 Baixo', '🎵 Voz', '🪗 Acordeão', '🪘 Percussão'],
  notes: ['Dó', 'Ré', 'Mi', 'Fá', 'Sol', 'Lá', 'Si'],
  chords: {
    'Dó maior': 'C - E - G', 'Ré maior': 'D - F# - A', 'Mi maior': 'E - G# - B',
    'Fá maior': 'F - A - C', 'Sol maior': 'G - B - D', 'Lá maior': 'A - C# - E',
    'Si maior': 'B - D# - F#', 'Lá menor': 'A - C - E', 'Mi menor': 'E - G - B',
  },
  musicFacts: [
    '🎵 A música ativa mais partes do cérebro do que qualquer outra atividade humana.',
    '🎸 Jimi Hendrix nunca aprendeu a ler partituras musicais.',
    '🎹 Mozart compôs sua primeira sinfonia com apenas 8 anos.',
    '🎺 O jazz nasceu em Nova Orleans no início do século XX.',
    '🥁 A bateria é um dos instrumentos mais antigos do mundo, datando de 6.000 a.C.',
    '🎻 Um violino profissional pode custar mais de um milhão de dólares.',
    '🎵 Ouvir música enquanto se exercita pode aumentar o desempenho em até 20%.',
    '🎤 A canção "Happy Birthday" é a mais cantada em inglês do mundo.',
    '🎵 O som viaja 4 vezes mais rápido na água do que no ar.',
    '🎸 A Beatles vendeu mais de 600 milhões de discos em todo o mundo.',
    '🎵 Estudar música melhora habilidades matemáticas e de leitura.',
    '🎹 O piano tem 88 teclas e pode produzir sons de 27,5 Hz a 4.186 Hz.',
  ],

  startQuiz() {
    const songs = State.songs.filter(s => s.genre);
    if (songs.length < 4) return null;
    const song = songs[Math.floor(Math.random() * songs.length)];
    const wrong = this.genres.filter(g => g !== song.genre).sort(() => Math.random() - 0.5).slice(0, 3);
    const options = [song.genre, ...wrong].sort(() => Math.random() - 0.5);
    return { type: 'quiz', song, question: `Qual o gênero de "${song.title}"?`, options, correct: song.genre };
  },

  startFlashcard() {
    const entries = Object.entries(this.chords);
    const [name, notes] = entries[Math.floor(Math.random() * entries.length)];
    return { type: 'flashcard', front: name, back: notes, category: 'Acorde' };
  },

  getDailyFact() {
    const day = new Date().getDate();
    return this.musicFacts[day % this.musicFacts.length];
  },

  getGenreInfo(genre) {
    const info = {
      'Rock': { emoji: '🎸', desc: 'Surgido nos anos 50, mistura blues, country e R&B. Caracterizado por guitarras elétricas distorcidas.', bpm: '120-160', mood: 'Energético' },
      'Jazz': { emoji: '🎷', desc: 'Nascido em Nova Orleans, combina improvisação, síncope e harmonia complexa.', bpm: '60-200', mood: 'Sofisticado' },
      'Classical': { emoji: '🎻', desc: 'Tradição musical europeia dos séculos XVIII-XIX, com estruturas formais elaboradas.', bpm: '40-180', mood: 'Contemplativo' },
      'Electronic': { emoji: '🎛️', desc: 'Produzida com sintetizadores e computadores, criada a partir dos anos 70.', bpm: '120-180', mood: 'Dançante' },
      'Samba': { emoji: '🥁', desc: 'Ritmo brasileiro afro-descendente, símbolo do carnaval. Nascido no Rio de Janeiro.', bpm: '80-100', mood: 'Alegre' },
      'MPB': { emoji: '🎵', desc: 'Música Popular Brasileira dos anos 60, síntese de várias tradições musicais brasileiras.', bpm: '60-120', mood: 'Poético' },
    };
    return info[genre] || { emoji: '🎵', desc: 'Um gênero musical único com suas próprias características.', bpm: '?', mood: 'Variado' };
  }
};

// ─── UI Layer ──────────────────────────────────────
const UI = {
  vizAnimId: null,
  vizCanvas: null,
  vizCtx: null,

  init() {
    this.renderApp();
    this.bindGlobalEvents();
  },

  renderApp() {
    document.getElementById('app').innerHTML = `
      <div class="app-shell">
        ${this.tplInstallBanner()}
        <div class="main-content" id="mainContent">
          <div class="view-container" id="viewContainer"></div>
        </div>
        ${this.tplPlayerBar()}
        ${this.tplBottomNav()}
        <div id="modalOverlay" class="modal-overlay hidden"></div>
        <div id="notification" class="notification hidden"></div>
        <div id="installBanner" class="install-banner hidden"></div>
      </div>
    `;
    this.injectStyles();
    this.switchTab('home');
  },

  tplInstallBanner() {
    return `<div id="installBanner" class="install-banner hidden">
      <span>📲 Instalar PlayLuz</span>
      <button onclick="App.installPWA()" class="btn-install">Instalar</button>
      <button onclick="UI.hideInstallBanner()" class="btn-close-banner">✕</button>
    </div>`;
  },

  tplPlayerBar() {
    return `
    <div class="player-bar hidden" id="playerBar">
      <div class="player-progress-wrap">
        <div class="player-progress-bg" id="progressBg">
          <div class="player-progress-fill" id="progressFill"></div>
          <input type="range" class="progress-range" id="progressRange" min="0" max="100" value="0" step="0.1"
            oninput="Audio.seek((this.value/100)*State.duration)">
        </div>
      </div>
      <div class="player-main">
        <div class="player-info" onclick="UI.openFullPlayer()">
          <div class="player-cover" id="playerCover">
            <canvas class="mini-viz" id="miniViz" width="60" height="60"></canvas>
          </div>
          <div class="player-text">
            <div class="player-title" id="playerTitle">—</div>
            <div class="player-artist" id="playerArtist">Selecione uma música</div>
          </div>
        </div>
        <div class="player-controls">
          <button class="ctrl-btn fav-btn" id="miniHeartBtn" onclick="State.currentSong && App.toggleFavorite(State.currentSong.id)">♡</button>
          <button class="ctrl-btn prev-btn" onclick="App.prev()">⏮</button>
          <button class="ctrl-btn play-btn" id="playBtn" onclick="App.togglePlay()">▶</button>
          <button class="ctrl-btn next-btn" onclick="App.next()">⏭</button>
          <button class="ctrl-btn" onclick="UI.openFullPlayer()">⬆</button>
        </div>
      </div>
    </div>`;
  },

  tplBottomNav() {
    const themeIcon = State.theme === 'dark' ? '☀' : '🌙';
    const tabs = [
      { id: 'home', icon: '⌂', label: 'Início' },
      { id: 'library', icon: '♫', label: 'Biblioteca' },
      { id: 'search', icon: '⌕', label: 'Buscar' },
      { id: 'playlists', icon: '☰', label: 'Playlists' },
      { id: 'learn', icon: '✦', label: 'Aprender' },
    ];
    return `<nav class="bottom-nav" id="bottomNav">
      ${tabs.map(t => `
        <button class="nav-btn${State.currentTab === t.id ? ' active' : ''}" id="nav-${t.id}" onclick="UI.switchTab('${t.id}')">
          <span class="nav-icon">${t.icon}</span>
          <span class="nav-label">${t.label}</span>
        </button>`).join('')}
      <button class="nav-btn theme-toggle-btn" onclick="UI.toggleTheme()" title="Tema">
        <span class="nav-icon">${themeIcon}</span>
        <span class="nav-label">${State.theme === 'dark' ? 'Claro' : 'Escuro'}</span>
      </button>
    </nav>`;
  },

  switchTab(tab) {
    State.currentTab = tab;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const navBtn = document.getElementById(`nav-${tab}`);
    if (navBtn) navBtn.classList.add('active');
    window.PlayLuzDB.setSetting('lastTab', tab);
    this.renderView(tab);
  },

  renderView(tab) {
    const vc = document.getElementById('viewContainer');
    if (!vc) return;
    if (tab === 'home') vc.innerHTML = this.viewHome();
    else if (tab === 'library') vc.innerHTML = this.viewLibrary();
    else if (tab === 'search') { vc.innerHTML = this.viewSearch(); }
    else if (tab === 'playlists') vc.innerHTML = this.viewPlaylists();
    else if (tab === 'learn') vc.innerHTML = this.viewLearn();
    this.bindViewEvents(tab);
  },

  renderCurrentView() { this.renderView(State.currentTab); },

  // ── HOME VIEW ──
  viewHome() {
    const recentSongs = [...State.songs].sort((a,b) => (b.addedAt||0)-(a.addedAt||0)).slice(0,6);
    const topSongs = [...State.songs].sort((a,b) => (b.playCount||0)-(a.playCount||0)).slice(0,6);
    const fact = Learning.getDailyFact();
    const hour = new Date().getHours();
    const greeting = hour < 12 ? '🌅 Bom dia' : hour < 18 ? '☀️ Boa tarde' : '🌙 Boa noite';
    return `
    <div class="view home-view">
      <div class="home-header">
        <div class="greeting">${greeting}</div>
        <h1 class="home-title">PlayLuz</h1>
        <div class="daily-fact">${fact}</div>
      </div>

      <div class="quick-actions">
        <button class="quick-btn shuffle-all" onclick="App.shuffleAll()">
          <span class="qa-icon">⚡</span><span>Aleatório</span>
        </button>
        <button class="quick-btn add-music" onclick="UI.openAddMusic()">
          <span class="qa-icon">＋</span><span>Adicionar</span>
        </button>
        <button class="quick-btn favorites" onclick="UI.showFavorites()">
          <span class="qa-icon">❤</span><span>Favoritos</span>
        </button>
        <button class="quick-btn recent-hist" onclick="UI.showHistory()">
          <span class="qa-icon">◷</span><span>Histórico</span>
        </button>
      </div>

      ${topSongs.length ? `
      <section class="home-section">
        <div class="section-header">
          <h2>🔥 Mais Tocadas</h2>
        </div>
        <div class="song-scroll">
          ${topSongs.map((s,i) => this.tplSongCard(s, topSongs, i)).join('')}
        </div>
      </section>` : ''}

      ${recentSongs.length ? `
      <section class="home-section">
        <div class="section-header">
          <h2>🆕 Adicionadas Recentemente</h2>
          <button onclick="UI.switchTab('library')">Ver tudo →</button>
        </div>
        <div class="song-scroll">
          ${recentSongs.map((s,i) => this.tplSongCard(s, recentSongs, i)).join('')}
        </div>
      </section>` : ''}

      ${State.playlists.length ? `
      <section class="home-section">
        <div class="section-header">
          <h2>📋 Playlists</h2>
          <button onclick="UI.switchTab('playlists')">Ver tudo →</button>
        </div>
        <div class="playlist-scroll">
          ${State.playlists.slice(0,4).map(p => this.tplPlaylistCard(p)).join('')}
        </div>
      </section>` : ''}

      ${State.songs.length === 0 ? `
      <div class="empty-state">
        <div class="empty-icon">🎵</div>
        <h2>Bem-vindo ao PlayLuz!</h2>
        <p>Adicione suas músicas para começar</p>
        <button class="btn-primary" onclick="UI.openAddMusic()">Adicionar Músicas</button>
      </div>` : ''}
    </div>`;
  },

  tplSongCard(song, queue, idx) {
    const isFav = State.favorites.includes(song.id);
    const isPlaying = State.currentSong?.id === song.id && State.isPlaying;
    const colors = ['#7B2FFF','#FF2F7B','#2FFFB4','#FFB42F','#2F7BFF'];
    const color = colors[song.id % colors.length] || colors[0];
    return `
    <div class="song-card${isPlaying ? ' playing' : ''}" data-id="${song.id}" onclick="App.playSong(State.songs.find(s=>s.id===${song.id}),${JSON.stringify(queue.map(s=>({id:s.id})))}.map(r=>State.songs.find(s=>s.id===r.id)),${idx})">
      <div class="song-card-cover" style="background:linear-gradient(135deg,${color}44,${color}22)">
        ${song.cover ? `<img src="${song.cover}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:12px">` : `<div class="cover-letter" style="color:${color}">${(song.title||'?')[0].toUpperCase()}</div>`}
        ${isPlaying ? '<div class="playing-anim"><span></span><span></span><span></span></div>' : ''}
      </div>
      <div class="song-card-info">
        <div class="song-card-title">${this.esc(song.title||'Sem título')}</div>
        <div class="song-card-artist">${this.esc(song.artist||'Artista')}</div>
      </div>
    </div>`;
  },

  tplPlaylistCard(pl) {
    return `
    <div class="playlist-card" onclick="UI.openPlaylist(${pl.id})">
      <div class="pl-card-cover">
        <div class="pl-cover-default">🎵</div>
      </div>
      <div class="pl-card-name">${this.esc(pl.name)}</div>
    </div>`;
  },

  tplSongRow(song, queue, idx, showCheckbox=false) {
    const isFav = State.favorites.includes(song.id);
    const isPlaying = State.currentSong?.id === song.id && State.isPlaying;
    const checked = State.selectedSongs.has(song.id);
    const dur = this.formatTime(song.duration||0);
    const colors = ['#7B2FFF','#FF2F7B','#2FFFB4','#FFB42F','#2F7BFF'];
    const color = colors[song.id % colors.length] || colors[0];
    return `
    <div class="song-row${isPlaying ? ' playing' : ''}${checked ? ' selected' : ''}" data-id="${song.id}">
      ${showCheckbox ? `<label class="song-checkbox">
        <input type="checkbox" ${checked ? 'checked' : ''} onchange="UI.toggleSongSelect(${song.id}, this.checked)">
        <span class="checkmark"></span>
      </label>` : ''}
      <div class="song-row-cover" style="background:linear-gradient(135deg,${color}33,${color}11)" onclick="App.playSong(State.songs.find(s=>s.id===${song.id}),${JSON.stringify(queue.map(s=>({id:s.id})))}.map(r=>State.songs.find(s=>s.id===r.id)),${idx})">
        ${song.cover ? `<img src="${song.cover}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:8px">` : `<div class="row-cover-letter" style="color:${color}">${(song.title||'?')[0].toUpperCase()}</div>`}
        ${isPlaying ? '<div class="row-playing"><span></span><span></span><span></span></div>' : ''}
      </div>
      <div class="song-row-info" onclick="App.playSong(State.songs.find(s=>s.id===${song.id}),${JSON.stringify(queue.map(s=>({id:s.id})))}.map(r=>State.songs.find(s=>s.id===r.id)),${idx})">
        <div class="song-row-title">${this.esc(song.title||'Sem título')}</div>
        <div class="song-row-artist">${this.esc(song.artist||'Artista')} ${song.genre ? `· <span class="genre-tag">${song.genre}</span>` : ''}</div>
      </div>
      <div class="song-row-meta">
        <span class="song-dur">${dur}</span>
        <button class="icon-btn heart-btn${isFav?' fav':''}" onclick="App.toggleFavorite(${song.id})" title="Favorito">${isFav?'❤':'♡'}</button>
        <button class="icon-btn more-btn" onclick="UI.openSongMenu(${song.id})" title="Mais opções">⋯</button>
      </div>
    </div>`;
  },

  // ── LIBRARY VIEW ──
  viewLibrary() {
    const selMode = State.selectionMode;
    return `
    <div class="view library-view">
      <div class="view-header">
        <h1>Biblioteca</h1>
        <div class="header-actions">
          ${selMode && State.selectedSongs.size > 0 ? `
            <button class="btn-accent" onclick="UI.openAddToPlaylistModal()">+ Playlist (${State.selectedSongs.size})</button>
            <button class="btn-ghost" onclick="UI.cancelSelection()">Cancelar</button>
          ` : `
            <button class="icon-btn" onclick="UI.toggleSelectionMode()" title="Selecionar">☑</button>
            <button class="icon-btn" onclick="UI.openAddMusic()" title="Adicionar">＋</button>
          `}
        </div>
      </div>
      ${State.songs.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">🎶</div>
          <p>Sua biblioteca está vazia</p>
          <button class="btn-primary" onclick="UI.openAddMusic()">Adicionar Músicas</button>
        </div>
      ` : `
        <div class="library-stats">
          <span>${State.songs.length} músicas</span>
          <span>${this.formatTime(State.songs.reduce((a,s)=>a+(s.duration||0),0))}</span>
        </div>
        <div class="songs-list" id="songsList">
          ${State.songs.map((s,i) => this.tplSongRow(s, State.songs, i, selMode)).join('')}
        </div>
      `}
    </div>`;
  },

  toggleSelectionMode() {
    State.selectionMode = !State.selectionMode;
    if (!State.selectionMode) State.selectedSongs.clear();
    this.renderCurrentView();
  },

  cancelSelection() {
    State.selectionMode = false; State.searchSelectionMode = false;
    State.selectedSongs.clear();
    this.renderCurrentView();
  },

  toggleSongSelect(id, checked) {
    if (checked) State.selectedSongs.add(id);
    else State.selectedSongs.delete(id);
    // Update header count
    const header = document.querySelector('.header-actions');
    if (header) {
      const cnt = State.selectedSongs.size;
      const addBtn = header.querySelector('.btn-accent');
      if (addBtn) addBtn.textContent = `+ Playlist (${cnt})`;
    }
  },

  // ── SEARCH VIEW ──
  viewSearch() {
    const selMode = State.searchSelectionMode;
    return `
    <div class="view search-view">
      <div class="search-header">
        <div class="search-box">
          <span class="search-icon">⌕</span>
          <input type="text" id="searchInput" placeholder="Buscar músicas, artistas..." value="${this.esc(State.searchQuery)}"
            oninput="State.searchQuery=this.value; App.search(this.value)">
          ${State.searchQuery ? `<button class="clear-search" onclick="State.searchQuery='';App.search('');document.getElementById('searchInput').value=''">✕</button>` : ''}
        </div>
        ${selMode ? `
          <div class="sel-actions">
            ${State.selectedSongs.size > 0 ? `<button class="btn-accent" onclick="UI.openAddToPlaylistModal()">+ Playlist (${State.selectedSongs.size})</button>` : ''}
            <button class="btn-ghost" onclick="UI.cancelSelection()">Cancelar</button>
          </div>` : (State.searchResults.length > 0 ? `<button class="icon-btn" onclick="UI.toggleSearchSelection()" title="Selecionar">☑</button>` : '')}
      </div>
      ${!State.searchQuery ? `
        <div class="search-suggestions">
          <h3>Gêneros</h3>
          <div class="genre-chips">
            ${Learning.genres.map(g => `<button class="genre-chip" onclick="State.searchQuery='${g}';App.search('${g}');document.getElementById('searchInput').value='${g}'">${g}</button>`).join('')}
          </div>
        </div>` : ''}
      ${State.isSearching ? '<div class="loading-state">🔍 Buscando...</div>' : ''}
      ${State.searchResults.length > 0 ? `
        <div class="search-results">
          <div class="results-count">${State.searchResults.length} resultado(s)</div>
          ${State.searchResults.map((s,i) => this.tplSongRow(s, State.searchResults, i, selMode)).join('')}
        </div>` : (State.searchQuery && !State.isSearching ? '<div class="empty-state small"><div class="empty-icon">🔍</div><p>Nenhum resultado</p></div>' : '')}
    </div>`;
  },

  toggleSearchSelection() {
    State.searchSelectionMode = !State.searchSelectionMode;
    if (!State.searchSelectionMode) State.selectedSongs.clear();
    this.renderCurrentView();
  },

  renderSearch() { if (State.currentTab === 'search') this.renderView('search'); },

  // ── PLAYLISTS VIEW ──
  viewPlaylists() {
    return `
    <div class="view playlists-view">
      <div class="view-header">
        <h1>Playlists</h1>
        <button class="icon-btn create-pl-btn" onclick="UI.openCreatePlaylist()">＋</button>
      </div>
      ${State.playlists.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <p>Nenhuma playlist criada</p>
          <button class="btn-primary" onclick="UI.openCreatePlaylist()">Criar Playlist</button>
        </div>
      ` : `
        <div class="playlists-grid">
          ${State.playlists.map(p => `
            <div class="playlist-item">
              <div class="pl-item-cover" onclick="UI.openPlaylist(${p.id})">
                <div class="pl-item-cover-bg">🎵</div>
              </div>
              <div class="pl-item-info">
                <div class="pl-item-name" onclick="UI.openPlaylist(${p.id})">${this.esc(p.name)}</div>
                <div class="pl-item-desc">${this.esc(p.description||'')}</div>
              </div>
              <div class="pl-item-actions">
                <button class="icon-btn" onclick="UI.openPlaylist(${p.id})" title="Abrir">▶</button>
                <button class="icon-btn danger" onclick="UI.confirmDeletePlaylist(${p.id},'${this.esc(p.name)}')" title="Deletar">🗑</button>
              </div>
            </div>`).join('')}
        </div>
      `}
    </div>`;
  },

  // ── LEARN VIEW ──
  viewLearn() {
    const stats = {
      total: State.songs.length,
      genres: [...new Set(State.songs.map(s=>s.genre).filter(Boolean))].length,
      artists: [...new Set(State.songs.map(s=>s.artist).filter(Boolean))].length,
    };
    return `
    <div class="view learn-view">
      <div class="view-header">
        <h1>✦ Aprender Música</h1>
      </div>

      <div class="learn-hero">
        <div class="learn-fact-card">
          <div class="fact-emoji">💡</div>
          <div class="fact-text">${Learning.getDailyFact()}</div>
          <div class="fact-label">Fato do Dia</div>
        </div>
      </div>

      <div class="learn-stats">
        <div class="learn-stat"><span class="stat-n">${stats.total}</span><span class="stat-l">Músicas</span></div>
        <div class="learn-stat"><span class="stat-n">${stats.genres}</span><span class="stat-l">Gêneros</span></div>
        <div class="learn-stat"><span class="stat-n">${stats.artists}</span><span class="stat-l">Artistas</span></div>
      </div>

      <h2 class="learn-section-title">Modos de Aprendizado</h2>
      <div class="learn-modes">
        <button class="learn-mode-btn" onclick="UI.startQuiz()">
          <div class="mode-icon">🎯</div>
          <div class="mode-name">Quiz Musical</div>
          <div class="mode-desc">Teste seus conhecimentos sobre gêneros e artistas</div>
        </button>
        <button class="learn-mode-btn" onclick="UI.startFlashcards()">
          <div class="mode-icon">📚</div>
          <div class="mode-name">Flashcards</div>
          <div class="mode-desc">Aprenda acordes e teoria musical</div>
        </button>
        <button class="learn-mode-btn" onclick="UI.showInstruments()">
          <div class="mode-icon">🎸</div>
          <div class="mode-name">Instrumentos</div>
          <div class="mode-desc">Explore diferentes instrumentos musicais</div>
        </button>
        <button class="learn-mode-btn" onclick="UI.showGenreExplorer()">
          <div class="mode-icon">🌍</div>
          <div class="mode-name">Gêneros</div>
          <div class="mode-desc">Descubra a história de cada gênero</div>
        </button>
      </div>

      <h2 class="learn-section-title">Teoria Musical</h2>
      <div class="theory-grid">
        <div class="theory-card" onclick="UI.showNotes()">
          <div class="theory-icon">🎵</div>
          <div class="theory-title">Notas Musicais</div>
          <div class="theory-desc">Dó, Ré, Mi, Fá, Sol, Lá, Si</div>
        </div>
        <div class="theory-card" onclick="UI.showChords()">
          <div class="theory-icon">🎹</div>
          <div class="theory-title">Acordes</div>
          <div class="theory-desc">Aprenda as formações de acordes básicos</div>
        </div>
        <div class="theory-card" onclick="UI.showRhythms()">
          <div class="theory-icon">🥁</div>
          <div class="theory-title">Ritmos</div>
          <div class="theory-desc">Entenda compassos e batidas</div>
        </div>
      </div>
    </div>`;
  },

  // ── FULL PLAYER ──
  openFullPlayer() {
    if (!State.currentSong) return;
    const song = State.currentSong;
    const isFav = State.favorites.includes(song.id);
    const colors = ['#7B2FFF','#FF2F7B','#2FFFB4','#FFB42F','#2F7BFF'];
    const color = colors[(song.id||0) % colors.length];
    document.getElementById('modalOverlay').innerHTML = `
    <div class="full-player" id="fullPlayer">
      <div class="full-player-bg" style="background:radial-gradient(ellipse at top,${color}33 0%,#050810 60%)"></div>
      <button class="fp-close" onclick="UI.closeModal()">⌄</button>
      <div class="fp-content">
        <div class="fp-cover-wrap">
          <div class="fp-cover" id="fpCover" style="background:linear-gradient(135deg,${color}55,${color}22)">
            ${song.cover ? `<img src="${song.cover}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:24px">` : `<div class="fp-cover-letter" style="color:${color}">${(song.title||'?')[0].toUpperCase()}</div>`}
          </div>
        </div>
        <div class="fp-song-info">
          <div class="fp-title">${this.esc(song.title||'Sem título')}</div>
          <div class="fp-artist">${this.esc(song.artist||'Artista')}</div>
          <div class="fp-meta">${song.album ? `<span>${this.esc(song.album)}</span>` : ''}${song.genre ? `<span class="genre-tag">${song.genre}</span>` : ''}</div>
        </div>
        <div class="fp-progress">
          <input type="range" id="fpRange" min="0" max="100" value="${State.duration ? (State.progress/State.duration)*100 : 0}" step="0.1"
            oninput="Audio.seek((this.value/100)*State.duration)">
          <div class="fp-times">
            <span id="fpCurrent">${this.formatTime(State.progress)}</span>
            <span id="fpDuration">${this.formatTime(State.duration)}</span>
          </div>
        </div>
        <div class="fp-controls">
          <button class="fp-btn shuffle${State.isShuffle?' active':''}" onclick="State.isShuffle=!State.isShuffle;this.classList.toggle('active')" title="Aleatório">⇀⇁</button>
          <button class="fp-btn prev" onclick="App.prev()">⏮</button>
          <button class="fp-btn play" id="fpPlayBtn" onclick="App.togglePlay()">${State.isPlaying?'⏸':'▶'}</button>
          <button class="fp-btn next" onclick="App.next()">⏭</button>
          <button class="fp-btn repeat${State.repeatMode?' active':''}" onclick="UI.cycleRepeat(this)" title="Repetir">↺${State.repeatMode===2?'1':''}</button>
        </div>
        <div class="fp-extras">
          <button class="fp-extra-btn${isFav?' active':''}" id="fpFavBtn" onclick="App.toggleFavorite(${song.id})">
            ${isFav?'❤':'♡'} Favoritar
          </button>
          <button class="fp-extra-btn" onclick="UI.openEQ()">🎛 EQ</button>
          <button class="fp-extra-btn" onclick="UI.openSleepTimer()">⏱ Timer</button>
          <button class="fp-extra-btn" onclick="UI.openSongInfo(${song.id})">ℹ Info</button>
        </div>
        <div class="fp-volume">
          <span>🔈</span>
          <input type="range" id="volRange" min="0" max="1" step="0.01" value="${State.volume}"
            oninput="State.volume=parseFloat(this.value);Audio.setVolume(State.volume)">
          <span>🔊</span>
        </div>
        <canvas id="fpViz" class="fp-visualizer" width="400" height="80"></canvas>
      </div>
    </div>`;
    document.getElementById('modalOverlay').classList.remove('hidden');
    document.getElementById('modalOverlay').classList.add('modal-fullplayer');
    this.startVisualizerLoop();
  },

  cycleRepeat(btn) {
    State.repeatMode = (State.repeatMode + 1) % 3;
    btn.classList.toggle('active', State.repeatMode > 0);
    btn.innerHTML = `↺${State.repeatMode===2?'1':''}`;
  },

  closeModal() {
    const o = document.getElementById('modalOverlay');
    o.classList.add('hidden');
    o.classList.remove('modal-fullplayer');
    o.innerHTML = '';
  },

  // ── EQ MODAL ──
  openEQ() {
    this.openModal(`
      <div class="modal-card eq-modal">
        <div class="modal-header"><h2>🎛️ Equalizador</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="eq-sliders">
          ${[['bass','🔊 Grave',State.eq.bass],['mid','〰️ Médio',State.eq.mid],['treble','✦ Agudo',State.eq.treble]].map(([k,l,v])=>`
          <div class="eq-band">
            <div class="eq-label">${l}</div>
            <input type="range" min="-15" max="15" value="${v}" step="1"
              oninput="Audio.setEQ('${k}',parseFloat(this.value));document.getElementById('eqv-${k}').textContent=this.value">
            <div class="eq-val" id="eqv-${k}">${v}</div>
          </div>`).join('')}
        </div>
        <div class="eq-presets">
          <div class="eq-preset-label">Presets</div>
          ${[['Normal',[0,0,0]],['Bass Boost',[12,2,-2]],['Treble Boost',[-2,2,12]],['Pop',[4,2,4]],['Rock',[8,2,6]]].map(([n,v])=>`
          <button class="preset-btn" onclick="UI.applyEQPreset(${JSON.stringify(v)})">${n}</button>`).join('')}
        </div>
        <button class="btn-primary" onclick="UI.closeModal()">Fechar</button>
      </div>`);
  },

  applyEQPreset([bass, mid, treble]) {
    Audio.setEQ('bass', bass); Audio.setEQ('mid', mid); Audio.setEQ('treble', treble);
    document.querySelectorAll('.eq-band input').forEach((el,i) => {
      el.value = [bass,mid,treble][i];
    });
    document.getElementById('eqv-bass').textContent = bass;
    document.getElementById('eqv-mid').textContent = mid;
    document.getElementById('eqv-treble').textContent = treble;
  },

  // ── SLEEP TIMER MODAL ──
  openSleepTimer() {
    this.openModal(`
      <div class="modal-card">
        <div class="modal-header"><h2>⏱ Timer de Sono</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="timer-options">
          ${[5,10,15,30,45,60,90,120].map(m=>`
          <button class="timer-btn" onclick="App.setSleepTimer(${m});UI.closeModal()">${m} min</button>`).join('')}
        </div>
        <button class="btn-ghost" onclick="App.setSleepTimer(0);UI.closeModal()">Cancelar Timer</button>
      </div>`);
  },

  // ── CREATE PLAYLIST MODAL ──
  openCreatePlaylist() {
    this.openModal(`
      <div class="modal-card">
        <div class="modal-header"><h2>Nova Playlist</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="modal-form">
          <input type="text" id="plName" placeholder="Nome da playlist" class="modal-input" maxlength="50">
          <textarea id="plDesc" placeholder="Descrição (opcional)" class="modal-textarea" rows="2" maxlength="200"></textarea>
        </div>
        <div class="modal-actions">
          <button class="btn-primary" onclick="UI.submitCreatePlaylist()">Criar</button>
          <button class="btn-ghost" onclick="UI.closeModal()">Cancelar</button>
        </div>
      </div>`);
    setTimeout(() => document.getElementById('plName')?.focus(), 100);
  },

  async submitCreatePlaylist() {
    const name = document.getElementById('plName')?.value?.trim();
    const desc = document.getElementById('plDesc')?.value?.trim();
    if (!name) { this.showNotification('Digite um nome para a playlist', 'error'); return; }
    await App.createPlaylist(name, desc);
    this.closeModal();
  },

  // ── ADD MUSIC MODAL ──
  openAddMusic() {
    this.openModal(`
      <div class="modal-card add-music-modal">
        <div class="modal-header"><h2>Adicionar Músicas</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="add-music-options">
          <label class="add-option" for="fileInput">
            <div class="add-opt-icon">📁</div>
            <div class="add-opt-text">
              <div class="add-opt-title">Seus Arquivos</div>
              <div class="add-opt-desc">MP3, WAV, OGG, FLAC, M4A, AAC</div>
            </div>
            <input type="file" id="fileInput" multiple accept="audio/*" style="display:none"
              onchange="UI.handleFileInput(this.files)">
          </label>
          <div class="add-option drop-zone" id="dropZone">
            <div class="add-opt-icon">⬇</div>
            <div class="add-opt-text">
              <div class="add-opt-title">Arraste Arquivos</div>
              <div class="add-opt-desc">Arraste e solte aqui</div>
            </div>
          </div>
        </div>
        <div id="addProgress" class="add-progress hidden">
          <div class="progress-bar-wrap"><div class="progress-bar-fill" id="addProgressFill"></div></div>
          <div id="addProgressText">Adicionando...</div>
        </div>
      </div>`);
    // Bind drop zone
    setTimeout(() => {
      const dz = document.getElementById('dropZone');
      if (!dz) return;
      dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
      dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); UI.handleFileInput(e.dataTransfer.files); });
    }, 100);
  },

  async handleFileInput(files) {
    if (!files?.length) return;
    const prog = document.getElementById('addProgress');
    const fill = document.getElementById('addProgressFill');
    const txt = document.getElementById('addProgressText');
    if (prog) prog.classList.remove('hidden');
    let done = 0;
    for (const file of files) {
      const song = await App.readAudioFile(file);
      await window.PlayLuzDB.addSong(song);
      done++;
      if (fill) fill.style.width = `${(done/files.length)*100}%`;
      if (txt) txt.textContent = `Adicionando ${done} de ${files.length}...`;
    }
    State.songs = await window.PlayLuzDB.getSongs();
    this.closeModal();
    this.renderCurrentView();
    this.showNotification(`✅ ${done} música(s) adicionada(s)!`, 'success');
  },

  // ── OPEN PLAYLIST ──
  async openPlaylist(id) {
    const pl = State.playlists.find(p => p.id === id);
    if (!pl) return;
    const songs = await window.PlayLuzDB.getPlaylistSongs(id);
    this.openModal(`
      <div class="modal-card playlist-detail-modal">
        <div class="modal-header">
          <div>
            <h2>${this.esc(pl.name)}</h2>
            ${pl.description ? `<div class="pl-detail-desc">${this.esc(pl.description)}</div>` : ''}
          </div>
          <button onclick="UI.closeModal()">✕</button>
        </div>
        <div class="pl-detail-actions">
          <button class="btn-primary" onclick="UI.playPlaylist(${id})" ${!songs.length?'disabled':''}>▶ Tocar Tudo</button>
          <button class="btn-ghost" onclick="UI.addSongsToExistingPlaylist(${id})">＋ Adicionar Músicas</button>
        </div>
        ${songs.length ? `
          <div class="pl-songs-list">
            ${songs.map((s,i)=>`
              <div class="pl-song-row">
                <div class="pl-song-info" onclick="UI.closeModal();App.playSong(State.songs.find(x=>x.id===${s.id}),${JSON.stringify(songs.map(x=>({id:x.id})))}.map(r=>State.songs.find(x=>x.id===r.id)),${i})">
                  <span class="pl-song-num">${i+1}</span>
                  <span class="pl-song-title">${this.esc(s.title||'Sem título')}</span>
                  <span class="pl-song-artist">${this.esc(s.artist||'Artista')}</span>
                </div>
                <button class="icon-btn danger" onclick="UI.removeSongFromPlaylist(${id},${s.id})">−</button>
              </div>`).join('')}
          </div>` : '<div class="empty-state small"><p>Nenhuma música nesta playlist</p></div>'}
      </div>`);
  },

  async playPlaylist(id) {
    const songs = await window.PlayLuzDB.getPlaylistSongs(id);
    if (!songs.length) return;
    this.closeModal();
    App.playSong(songs[0], songs, 0);
  },

  async removeSongFromPlaylist(playlistId, songId) {
    await window.PlayLuzDB.removeSongFromPlaylist(playlistId, songId);
    this.openPlaylist(playlistId);
    this.showNotification('Música removida da playlist', 'info');
  },

  // ── ADD TO PLAYLIST MODAL ──
  async openAddToPlaylistModal() {
    const ids = [...State.selectedSongs];
    if (!ids.length) { this.showNotification('Selecione músicas primeiro', 'error'); return; }
    const playlists = State.playlists;
    this.openModal(`
      <div class="modal-card">
        <div class="modal-header"><h2>Adicionar à Playlist</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="modal-subtitle">${ids.length} música(s) selecionada(s)</div>
        ${playlists.length ? `
          <div class="pl-select-list">
            ${playlists.map(p=>`
              <button class="pl-select-item" onclick="App.addSelectionToPlaylist(${p.id});UI.closeModal()">
                <span class="pl-sel-icon">🎵</span>
                <span>${this.esc(p.name)}</span>
              </button>`).join('')}
          </div>` : '<div class="empty-state small"><p>Crie uma playlist primeiro</p></div>'}
        <button class="btn-primary mt" onclick="UI.openCreatePlaylist()">+ Nova Playlist</button>
      </div>`);
  },

  async addSongsToExistingPlaylist(playlistId) {
    // Open library in selection mode targeting this playlist
    this.closeModal();
    State.selectionMode = true;
    State.selectedSongs.clear();
    State.currentTab = 'library';
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('nav-library')?.classList.add('active');
    document.getElementById('viewContainer').innerHTML = this.viewLibrary();
    // Override the add button action
    const addBtn = document.querySelector('.btn-accent');
    if (addBtn) {
      addBtn.onclick = async () => {
        await App.addSelectionToPlaylist(playlistId);
        this.cancelSelection();
        this.openPlaylist(playlistId);
      };
    }
  },

  // ── SONG MENU ──
  openSongMenu(id) {
    const song = State.songs.find(s => s.id === id);
    if (!song) return;
    const isFav = State.favorites.includes(id);
    this.openModal(`
      <div class="modal-card song-menu-modal">
        <div class="modal-header">
          <div>
            <div style="font-weight:700">${this.esc(song.title||'Sem título')}</div>
            <div style="color:var(--muted);font-size:0.85rem">${this.esc(song.artist||'Artista')}</div>
          </div>
          <button onclick="UI.closeModal()">✕</button>
        </div>
        <div class="menu-actions">
          <button class="menu-action" onclick="App.playSong(State.songs.find(s=>s.id===${id}),State.songs,State.songs.findIndex(s=>s.id===${id}));UI.closeModal()">▶ Tocar</button>
          <button class="menu-action" onclick="App.toggleFavorite(${id});UI.closeModal()">${isFav?'💔 Remover Favorito':'❤ Adicionar Favorito'}</button>
          <button class="menu-action" onclick="UI.closeModal();UI.openAddSongToPlaylist(${id})">+ Adicionar à Playlist</button>
          <button class="menu-action" onclick="UI.openSongInfo(${id})">ℹ Ver Informações</button>
          <button class="menu-action" onclick="UI.openEditSong(${id})">✏ Editar</button>
          <button class="menu-action danger" onclick="UI.confirmDeleteSong(${id})">🗑 Remover</button>
        </div>
      </div>`);
  },

  async openAddSongToPlaylist(songId) {
    this.openModal(`
      <div class="modal-card">
        <div class="modal-header"><h2>Adicionar à Playlist</h2><button onclick="UI.closeModal()">✕</button></div>
        ${State.playlists.length ? `
          <div class="pl-select-list">
            ${State.playlists.map(p=>`
              <button class="pl-select-item" onclick="window.PlayLuzDB.addSongsToPlaylist(${p.id},[${songId}]).then(()=>{UI.closeModal();UI.showNotification('Adicionado!','success')})">
                <span class="pl-sel-icon">🎵</span>
                <span>${this.esc(p.name)}</span>
              </button>`).join('')}
          </div>` : '<div class="empty-state small"><p>Crie uma playlist primeiro</p></div>'}
        <button class="btn-primary mt" onclick="UI.openCreatePlaylist()">+ Nova Playlist</button>
      </div>`);
  },

  openSongInfo(id) {
    const song = State.songs.find(s => s.id === id);
    if (!song) return;
    this.openModal(`
      <div class="modal-card">
        <div class="modal-header"><h2>ℹ Informações</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="song-info-grid">
          ${[['Título',song.title],['Artista',song.artist],['Álbum',song.album],['Gênero',song.genre],['Ano',song.year],['Duração',UI.formatTime(song.duration||0)],['Reproduções',song.playCount||0],['Arquivo',song.fileName]].filter(([,v])=>v).map(([k,v])=>`
          <div class="info-row"><span class="info-key">${k}</span><span class="info-val">${v}</span></div>`).join('')}
        </div>
        <button class="btn-primary" onclick="UI.closeModal()">Fechar</button>
      </div>`);
  },

  openEditSong(id) {
    const song = State.songs.find(s => s.id === id);
    if (!song) return;
    this.openModal(`
      <div class="modal-card">
        <div class="modal-header"><h2>✏ Editar Música</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="modal-form">
          <input type="text" id="editTitle" class="modal-input" placeholder="Título" value="${this.esc(song.title||'')}">
          <input type="text" id="editArtist" class="modal-input" placeholder="Artista" value="${this.esc(song.artist||'')}">
          <input type="text" id="editAlbum" class="modal-input" placeholder="Álbum" value="${this.esc(song.album||'')}">
          <input type="text" id="editGenre" class="modal-input" placeholder="Gênero" value="${this.esc(song.genre||'')}">
          <input type="text" id="editYear" class="modal-input" placeholder="Ano" value="${this.esc(song.year||'')}">
        </div>
        <div class="modal-actions">
          <button class="btn-primary" onclick="UI.saveEditSong(${id})">Salvar</button>
          <button class="btn-ghost" onclick="UI.closeModal()">Cancelar</button>
        </div>
      </div>`);
  },

  async saveEditSong(id) {
    const song = State.songs.find(s => s.id === id);
    if (!song) return;
    song.title = document.getElementById('editTitle')?.value || song.title;
    song.artist = document.getElementById('editArtist')?.value || song.artist;
    song.album = document.getElementById('editAlbum')?.value || song.album;
    song.genre = document.getElementById('editGenre')?.value || song.genre;
    song.year = document.getElementById('editYear')?.value || song.year;
    await window.PlayLuzDB.updateSong(song);
    State.songs = await window.PlayLuzDB.getSongs();
    this.closeModal();
    this.renderCurrentView();
    this.showNotification('✅ Música atualizada!', 'success');
  },

  confirmDeleteSong(id) {
    const song = State.songs.find(s => s.id === id);
    this.openModal(`
      <div class="modal-card">
        <div class="modal-header"><h2>Remover Música</h2></div>
        <p>Remover "<strong>${this.esc(song?.title||'esta música')}</strong>" da biblioteca?</p>
        <div class="modal-actions">
          <button class="btn-danger" onclick="UI.deleteSong(${id})">Remover</button>
          <button class="btn-ghost" onclick="UI.closeModal()">Cancelar</button>
        </div>
      </div>`);
  },

  async deleteSong(id) {
    await window.PlayLuzDB.deleteSong(id);
    State.songs = await window.PlayLuzDB.getSongs();
    if (State.currentSong?.id === id) { Audio.pause(); State.currentSong = null; this.updateMiniPlayer(); }
    this.closeModal();
    this.renderCurrentView();
    this.showNotification('Música removida', 'info');
  },

  confirmDeletePlaylist(id, name) {
    this.openModal(`
      <div class="modal-card">
        <div class="modal-header"><h2>Deletar Playlist</h2></div>
        <p>Deletar a playlist "<strong>${this.esc(name)}</strong>"?</p>
        <div class="modal-actions">
          <button class="btn-danger" onclick="App.deletePlaylist(${id});UI.closeModal()">Deletar</button>
          <button class="btn-ghost" onclick="UI.closeModal()">Cancelar</button>
        </div>
      </div>`);
  },

  showFavorites() {
    const favSongs = State.songs.filter(s => State.favorites.includes(s.id));
    this.openModal(`
      <div class="modal-card playlist-detail-modal">
        <div class="modal-header"><h2>❤ Favoritos</h2><button onclick="UI.closeModal()">✕</button></div>
        ${favSongs.length ? `
          <button class="btn-primary" onclick="UI.closeModal();App.playSong(${JSON.stringify({id:favSongs[0].id})}.id?State.songs.find(s=>s.id===${favSongs[0].id}):null,${JSON.stringify(favSongs.map(s=>({id:s.id})))}.map(r=>State.songs.find(s=>s.id===r.id)),0)">▶ Tocar Favoritos</button>
          <div class="pl-songs-list">
            ${favSongs.map((s,i)=>`
              <div class="pl-song-row">
                <div class="pl-song-info" onclick="UI.closeModal();App.playSong(State.songs.find(x=>x.id===${s.id}),${JSON.stringify(favSongs.map(x=>({id:x.id})))}.map(r=>State.songs.find(x=>x.id===r.id)),${i})">
                  <span class="pl-song-num">${i+1}</span>
                  <span class="pl-song-title">${this.esc(s.title||'Sem título')}</span>
                  <span class="pl-song-artist">${this.esc(s.artist||'Artista')}</span>
                </div>
              </div>`).join('')}
          </div>` : '<div class="empty-state small"><div class="empty-icon">♡</div><p>Nenhum favorito ainda</p></div>'}
      </div>`);
  },

  showHistory() {
    const hist = State.history;
    this.openModal(`
      <div class="modal-card playlist-detail-modal">
        <div class="modal-header"><h2>◷ Histórico</h2><button onclick="UI.closeModal()">✕</button></div>
        ${hist.length ? `
          <div class="pl-songs-list">
            ${hist.map(h => {
              const s = State.songs.find(x=>x.id===h.songId);
              if(!s) return '';
              const d = new Date(h.playedAt);
              return `<div class="pl-song-row">
                <div class="pl-song-info" onclick="UI.closeModal();App.playSong(State.songs.find(x=>x.id===${s.id}),State.songs,State.songs.findIndex(x=>x.id===${s.id}))">
                  <span class="pl-song-title">${this.esc(s.title||'Sem título')}</span>
                  <span class="pl-song-artist">${this.esc(s.artist||'Artista')} · ${d.toLocaleDateString('pt-BR')}</span>
                </div>
              </div>`;
            }).filter(Boolean).join('')}
          </div>` : '<div class="empty-state small"><p>Nenhum histórico ainda</p></div>'}
      </div>`);
  },

  // ── LEARNING MODALS ──
  startQuiz() {
    const q = Learning.startQuiz();
    if (!q) { this.showNotification('Adicione músicas com gênero definido para o quiz!', 'error'); return; }
    this.openModal(`
      <div class="modal-card quiz-modal">
        <div class="modal-header"><h2>🎯 Quiz Musical</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="quiz-question">${this.esc(q.question)}</div>
        <div class="quiz-options">
          ${q.options.map(opt => `
            <button class="quiz-opt" onclick="UI.answerQuiz(this,'${this.esc(opt)}','${this.esc(q.correct)}')">
              ${this.esc(opt)}
            </button>`).join('')}
        </div>
        <div class="quiz-result hidden" id="quizResult"></div>
      </div>`);
  },

  answerQuiz(btn, answer, correct) {
    document.querySelectorAll('.quiz-opt').forEach(b => b.disabled = true);
    const isCorrect = answer === correct;
    btn.classList.add(isCorrect ? 'correct' : 'wrong');
    if (!isCorrect) document.querySelectorAll('.quiz-opt').forEach(b => { if (b.textContent.trim() === correct) b.classList.add('correct'); });
    const res = document.getElementById('quizResult');
    res.classList.remove('hidden');
    res.innerHTML = `<div class="${isCorrect?'quiz-win':'quiz-lose'}">${isCorrect ? '🎉 Correto! Muito bem!' : `❌ Era: ${correct}`}</div>
      <button class="btn-primary" onclick="UI.closeModal();setTimeout(()=>UI.startQuiz(),200)">Próxima Pergunta →</button>`;
  },

  startFlashcards() {
    const fc = Learning.startFlashcard();
    this.openModal(`
      <div class="modal-card flashcard-modal">
        <div class="modal-header"><h2>📚 Flashcards</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="flashcard" id="flashcard" onclick="UI.flipCard()">
          <div class="flashcard-inner" id="flashcardInner">
            <div class="flashcard-front">
              <div class="fc-category">${fc.category}</div>
              <div class="fc-text">${fc.front}</div>
              <div class="fc-hint">Toque para revelar</div>
            </div>
            <div class="flashcard-back">
              <div class="fc-category">Notas do acorde</div>
              <div class="fc-text">${fc.back}</div>
            </div>
          </div>
        </div>
        <div class="fc-actions">
          <button class="btn-ghost" onclick="UI.closeModal();setTimeout(()=>UI.startFlashcards(),200)">Próximo Card →</button>
        </div>
      </div>`);
  },

  flipCard() {
    document.getElementById('flashcardInner')?.classList.toggle('flipped');
  },

  showInstruments() {
    this.openModal(`
      <div class="modal-card instruments-modal">
        <div class="modal-header"><h2>🎸 Instrumentos</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="instruments-grid">
          ${Learning.instruments.map(inst => {
            const [icon, ...nameParts] = inst.split(' ');
            const name = nameParts.join(' ');
            return `<div class="instrument-card">
              <div class="inst-icon">${icon}</div>
              <div class="inst-name">${name}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`);
  },

  showGenreExplorer() {
    this.openModal(`
      <div class="modal-card genre-modal">
        <div class="modal-header"><h2>🌍 Gêneros Musicais</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="genre-explorer">
          ${Object.entries({'Rock':null,'Jazz':null,'Samba':null,'MPB':null,'Electronic':null,'Classical':null}).map(([g])=>{
            const info = Learning.getGenreInfo(g);
            return `<div class="genre-explore-card" onclick="UI.showGenreDetail('${g}')">
              <div class="ge-emoji">${info.emoji}</div>
              <div class="ge-name">${g}</div>
              <div class="ge-mood">${info.mood}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`);
  },

  showGenreDetail(genre) {
    const info = Learning.getGenreInfo(genre);
    const songsInGenre = State.songs.filter(s => s.genre === genre);
    this.openModal(`
      <div class="modal-card">
        <div class="modal-header"><h2>${info.emoji} ${genre}</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="genre-detail">
          <div class="gd-desc">${info.desc}</div>
          <div class="gd-stats">
            <div class="gd-stat"><span>⚡ BPM</span><strong>${info.bpm}</strong></div>
            <div class="gd-stat"><span>😊 Mood</span><strong>${info.mood}</strong></div>
            <div class="gd-stat"><span>🎵 Suas músicas</span><strong>${songsInGenre.length}</strong></div>
          </div>
          ${songsInGenre.length ? `
            <div class="gd-songs">
              <h3>Suas músicas de ${genre}</h3>
              ${songsInGenre.slice(0,5).map(s=>`<div class="gd-song" onclick="App.playSong(State.songs.find(x=>x.id===${s.id}),${JSON.stringify(songsInGenre.map(x=>({id:x.id})))}.map(r=>State.songs.find(x=>x.id===r.id)),${songsInGenre.indexOf(s)});UI.closeModal()">▶ ${this.esc(s.title||'Sem título')}</div>`).join('')}
            </div>` : ''}
        </div>
        <button class="btn-ghost" onclick="UI.showGenreExplorer()">← Voltar</button>
      </div>`);
  },

  showNotes() {
    const noteFreqs = {'Dó':'261.6 Hz','Ré':'293.7 Hz','Mi':'329.6 Hz','Fá':'349.2 Hz','Sol':'392.0 Hz','Lá':'440.0 Hz','Si':'493.9 Hz'};
    this.openModal(`
      <div class="modal-card">
        <div class="modal-header"><h2>🎵 Notas Musicais</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="notes-grid">
          ${Learning.notes.map((n,i)=>{
            const colors2=['#FF2F7B','#FF7B2F','#FFD700','#2FFF7B','#2F7BFF','#7B2FFF','#FF2FD7'];
            return `<div class="note-card" style="--note-color:${colors2[i]}">
              <div class="note-name">${n}</div>
              <div class="note-freq">${noteFreqs[n]}</div>
              <div class="note-en">${['C','D','E','F','G','A','B'][i]}</div>
            </div>`;
          }).join('')}
        </div>
        <div class="notes-info">A escala musical tem 7 notas naturais que formam a base de toda a música ocidental.</div>
      </div>`);
  },

  showChords() {
    this.openModal(`
      <div class="modal-card">
        <div class="modal-header"><h2>🎹 Acordes</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="chords-list">
          ${Object.entries(Learning.chords).map(([name,notes])=>`
            <div class="chord-row">
              <div class="chord-name">${name}</div>
              <div class="chord-notes">${notes}</div>
            </div>`).join('')}
        </div>
        <div class="notes-info">Acordes são combinações de notas tocadas simultaneamente. Os acordes maiores soam alegres; os menores, mais melancólicos.</div>
      </div>`);
  },

  showRhythms() {
    const rhythms = [
      ['4/4','O mais comum. Quatro batidas por compasso. Usado no rock, pop, blues.'],
      ['3/4','Três batidas por compasso. Som de valsa. Muito usado no jazz.'],
      ['6/8','Seis colcheias por compasso. Sensação ondulante. Baladas e blues lentos.'],
      ['2/4','Duas batidas por compasso. Marchas e sambas rápidos.'],
      ['5/4','Cinco batidas — incomum e tenso. Take Five de Dave Brubeck.'],
      ['7/8','Sete colcheias — complexo e assimétrico. Muito usado no prog-rock.'],
    ];
    this.openModal(`
      <div class="modal-card">
        <div class="modal-header"><h2>🥁 Compassos e Ritmos</h2><button onclick="UI.closeModal()">✕</button></div>
        <div class="rhythms-list">
          ${rhythms.map(([name,desc])=>`
            <div class="rhythm-row">
              <div class="rhythm-name">${name}</div>
              <div class="rhythm-desc">${desc}</div>
            </div>`).join('')}
        </div>
      </div>`);
  },

  openModal(html) {
    const o = document.getElementById('modalOverlay');
    o.innerHTML = html;
    o.classList.remove('hidden');
    o.addEventListener('click', e => { if (e.target === o) this.closeModal(); }, { once: true });
  },

  // ── UPDATE FUNCTIONS ──
  updateNowPlaying() {
    const song = State.currentSong;
    if (!song) return;
    const fpTitle = document.getElementById('fpTitle');
    const fpArtist = document.getElementById('fpArtist');
    const fpPlayBtn = document.getElementById('fpPlayBtn');
    const fpFavBtn = document.getElementById('fpFavBtn');
    if (fpTitle) fpTitle.textContent = song.title || 'Sem título';
    if (fpArtist) fpArtist.textContent = song.artist || 'Artista';
    if (fpPlayBtn) fpPlayBtn.textContent = State.isPlaying ? '⏸' : '▶';
    if (fpFavBtn) {
      const isFav = State.favorites.includes(song.id);
      fpFavBtn.innerHTML = `${isFav?'❤':'♡'} Favoritar`;
      fpFavBtn.classList.toggle('active', isFav);
    }
  },

  updateMiniPlayer() {
    const song = State.currentSong;
    const title = document.getElementById('playerTitle');
    const artist = document.getElementById('playerArtist');
    const heart = document.getElementById('miniHeartBtn');
    if (title) title.textContent = song ? (song.title || 'Sem título') : '—';
    if (artist) artist.textContent = song ? (song.artist || 'Artista') : 'Selecione uma música';
    if (heart && song) heart.textContent = State.favorites.includes(song.id) ? '❤' : '♡';
  },

  showPlayerBar() {
    document.getElementById('playerBar')?.classList.remove('hidden');
  },

  updatePlayButton() {
    const btn = document.getElementById('playBtn');
    const fpBtn = document.getElementById('fpPlayBtn');
    if (btn) btn.textContent = State.isPlaying ? '⏸' : '▶';
    if (fpBtn) fpBtn.textContent = State.isPlaying ? '⏸' : '▶';
  },

  updateProgress() {
    const pct = State.duration ? (State.progress / State.duration) * 100 : 0;
    const fill = document.getElementById('progressFill');
    const range = document.getElementById('progressRange');
    const fpRange = document.getElementById('fpRange');
    const fpCurrent = document.getElementById('fpCurrent');
    const fpDuration = document.getElementById('fpDuration');
    if (fill) fill.style.width = `${pct}%`;
    if (range) range.value = pct;
    if (fpRange) fpRange.value = pct;
    if (fpCurrent) fpCurrent.textContent = this.formatTime(State.progress);
    if (fpDuration) fpDuration.textContent = this.formatTime(State.duration);
  },

  updateFavoriteButtons(songId, isFav) {
    document.querySelectorAll(`[data-id="${songId}"] .heart-btn, [data-id="${songId}"] .fav-btn`).forEach(b => {
      b.textContent = isFav ? '❤' : '♡';
      b.classList.toggle('fav', isFav);
    });
    const mini = document.getElementById('miniHeartBtn');
    if (mini && State.currentSong?.id === songId) mini.textContent = isFav ? '❤' : '♡';
    const fpFavBtn = document.getElementById('fpFavBtn');
    if (fpFavBtn && State.currentSong?.id === songId) {
      fpFavBtn.innerHTML = `${isFav?'❤':'♡'} Favoritar`;
      fpFavBtn.classList.toggle('active', isFav);
    }
  },

  // ── VISUALIZER ──
  startVisualizerLoop() {
    if (this.vizAnimId) cancelAnimationFrame(this.vizAnimId);
    const draw = () => {
      this.vizAnimId = requestAnimationFrame(draw);
      const data = Audio.getFreqData();
      if (!data) return;
      // Mini player canvas
      const mc = document.getElementById('miniViz');
      if (mc) this.drawMiniViz(mc, data);
      // Full player canvas
      const fc = document.getElementById('fpViz');
      if (fc) this.drawFullViz(fc, data);
    };
    draw();
  },

  drawMiniViz(canvas, data) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0,0,W,H);
    const bars = 24;
    const bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const val = data[Math.floor(i * data.length / bars)] / 255;
      const h = val * H;
      const hue = 260 + i * 5;
      ctx.fillStyle = `hsla(${hue},100%,60%,0.9)`;
      ctx.fillRect(i*bw+1, H-h, bw-2, h);
    }
  },

  drawFullViz(canvas, data) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0,0,W,H);
    const bars = 64;
    const bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const val = data[Math.floor(i * data.length / bars)] / 255;
      const h = val * H * 0.9;
      const grd = ctx.createLinearGradient(0, H, 0, H-h);
      grd.addColorStop(0, '#7B2FFF');
      grd.addColorStop(1, '#00F0FF');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.roundRect(i*bw+1, H-h, bw-2, h, 3);
      ctx.fill();
    }
  },

  showInstallBanner() {
    if (State.isInstalled) return;
    document.getElementById('installBanner')?.classList.remove('hidden');
  },

  hideInstallBanner() {
    document.getElementById('installBanner')?.classList.add('hidden');
  },

  showNotification(msg, type = 'info') {
    const n = document.getElementById('notification');
    if (!n) return;
    n.textContent = msg;
    n.className = `notification ${type}`;
    n.classList.remove('hidden');
    clearTimeout(this._notifTimeout);
    this._notifTimeout = setTimeout(() => n.classList.add('hidden'), 3000);
  },

  applyTheme(theme) {
    State.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    window.PlayLuzDB.setSetting('theme', theme);
    // Update nav button icon if rendered
    const themeBtn = document.querySelector('.theme-toggle-btn .nav-icon');
    const themeLbl = document.querySelector('.theme-toggle-btn .nav-label');
    if (themeBtn) themeBtn.textContent = theme === 'dark' ? '☀' : '🌙';
    if (themeLbl) themeLbl.textContent = theme === 'dark' ? 'Claro' : 'Escuro';
    // Update meta theme-color
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#050810' : '#F5F7FF';
  },

  toggleTheme() {
    const newTheme = State.theme === 'dark' ? 'light' : 'dark';
    this.applyTheme(newTheme);
    this.showNotification(newTheme === 'dark' ? '🌙 Modo Escuro' : '☀️ Modo Claro', 'info');
  },

  bindGlobalEvents() {
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); App.togglePlay(); }
      if (e.code === 'ArrowRight') App.next();
      if (e.code === 'ArrowLeft') App.prev();
    });
  },

  bindViewEvents(tab) {
    if (tab === 'search') {
      setTimeout(() => {
        const inp = document.getElementById('searchInput');
        if (inp && !State.searchQuery) inp.focus();
      }, 100);
    }
  },

  formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2,'0')}`;
  },

  esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  },

  // ── CSS ──
  injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root,[data-theme="light"]{
  --bg:#F5F7FF;--bg2:#FFFFFF;--bg3:#EEF1FA;--bg4:#E2E7F5;
  --accent:#6B1FEF;--accent2:#0090CC;--accent3:#E0215A;
  --text:#0D1117;--muted:#5A6480;--border:#D0D8EE;
  --player-h:72px;--nav-h:64px;
  --radius:16px;--radius-sm:10px;
  --font:'Syne',sans-serif;--mono:'Space Mono',monospace;
  --shadow:0 2px 12px rgba(0,0,0,.08);
}
[data-theme="dark"]{
  --bg:#050810;--bg2:#0d1117;--bg3:#141a24;--bg4:#1a2235;
  --accent:#7B2FFF;--accent2:#00F0FF;--accent3:#FF2F7B;
  --text:#F0F4FF;--muted:#8892AA;--border:#1e2a3d;
  --shadow:0 2px 12px rgba(0,0,0,.4);
}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:var(--font)}
.app-shell{height:100vh;height:100dvh;display:flex;flex-direction:column;overflow:hidden;position:relative}
.main-content{flex:1;overflow-y:auto;overflow-x:hidden;padding-bottom:calc(var(--player-h) + var(--nav-h) + env(safe-area-inset-bottom));scroll-behavior:smooth}
.main-content::-webkit-scrollbar{width:4px}.main-content::-webkit-scrollbar-thumb{background:var(--accent);border-radius:4px}
.view{padding:16px 16px 8px;max-width:600px;margin:0 auto}

/* ── HOME ── */
.home-header{padding:20px 0 16px;text-align:center}
.greeting{font-size:0.85rem;color:var(--muted);text-transform:uppercase;letter-spacing:2px;margin-bottom:4px}
.home-title{font-size:2.2rem;font-weight:800;background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1}
.daily-fact{margin-top:12px;background:var(--bg3);border:1px solid var(--border);border-left:3px solid var(--accent);padding:10px 14px;border-radius:var(--radius-sm);font-size:0.82rem;color:var(--muted);line-height:1.5;text-align:left}

.quick-actions{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0 20px}
.quick-btn{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:12px 8px;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;color:var(--text);font-family:var(--font);font-size:0.75rem;font-weight:600;transition:all .2s}
.quick-btn:active{transform:scale(.95)}.quick-btn .qa-icon{font-size:1.4rem}
.quick-btn.shuffle-all{border-color:var(--accent);background:linear-gradient(135deg,#7B2FFF22,var(--bg3))}
.quick-btn.favorites{border-color:var(--accent3);background:linear-gradient(135deg,#FF2F7B22,var(--bg3))}

.home-section{margin-bottom:24px}.section-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.section-header h2{font-size:1.05rem;font-weight:700}.section-header button{background:none;border:none;color:var(--accent);font-size:0.8rem;cursor:pointer;font-family:var(--font)}

.song-scroll{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;scrollbar-width:none}
.song-scroll::-webkit-scrollbar{display:none}
.song-card{flex:0 0 130px;cursor:pointer;transition:transform .2s}
.song-card:active{transform:scale(.95)}
.song-card-cover{width:130px;height:130px;border-radius:var(--radius);display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.song-card.playing .song-card-cover{box-shadow:0 0 20px var(--accent)}
.cover-letter{font-size:2.5rem;font-weight:800}
.song-card-info{margin-top:8px}.song-card-title{font-size:.85rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.song-card-artist{font-size:.75rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.playing-anim{position:absolute;bottom:8px;right:8px;display:flex;align-items:flex-end;gap:2px;height:16px}
.playing-anim span{width:3px;background:var(--accent2);border-radius:2px;animation:eq 0.8s ease-in-out infinite}
.playing-anim span:nth-child(1){animation-delay:0s;height:8px}.playing-anim span:nth-child(2){animation-delay:.2s;height:14px}.playing-anim span:nth-child(3){animation-delay:.4s;height:10px}
@keyframes eq{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.3)}}

.playlist-scroll{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;scrollbar-width:none}.playlist-scroll::-webkit-scrollbar{display:none}
.playlist-card{flex:0 0 120px;cursor:pointer}.pl-card-cover{width:120px;height:120px;border-radius:var(--radius);background:linear-gradient(135deg,var(--accent)44,var(--bg3));display:flex;align-items:center;justify-content:center;font-size:2rem}
.pl-card-name{margin-top:6px;font-size:.82rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ── VIEW HEADER ── */
.view-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-top:8px}
.view-header h1{font-size:1.6rem;font-weight:800}
.header-actions{display:flex;gap:8px;align-items:center}

/* ── SONG ROW ── */
.library-stats{font-size:.8rem;color:var(--muted);margin-bottom:12px;display:flex;gap:16px}
.songs-list{display:flex;flex-direction:column;gap:2px}
.song-row{display:flex;align-items:center;gap:10px;padding:8px;border-radius:var(--radius-sm);background:transparent;transition:background .15s;position:relative}
.song-row:active{background:var(--bg3)}.song-row.playing{background:var(--bg3)}.song-row.selected{background:#7B2FFF22;border:1px solid var(--accent)}
.song-row-cover{width:48px;height:48px;flex-shrink:0;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;position:relative;overflow:hidden}
.row-cover-letter{font-size:1.2rem;font-weight:800}
.row-playing{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;padding-bottom:4px;gap:2px;background:#00000088}
.row-playing span{width:3px;background:var(--accent2);border-radius:2px;animation:eq 0.8s ease-in-out infinite}
.row-playing span:nth-child(1){height:8px;animation-delay:0s}.row-playing span:nth-child(2){height:14px;animation-delay:.2s}.row-playing span:nth-child(3){height:10px;animation-delay:.4s}
.song-row-info{flex:1;min-width:0;cursor:pointer}
.song-row-title{font-size:.9rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.song-row-artist{font-size:.78rem;color:var(--muted);display:flex;align-items:center;gap:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.song-row-meta{display:flex;align-items:center;gap:4px;flex-shrink:0}
.song-dur{font-size:.75rem;color:var(--muted);font-family:var(--mono);min-width:38px;text-align:right}
.genre-tag{background:var(--bg4);border:1px solid var(--border);border-radius:20px;padding:1px 8px;font-size:.7rem;color:var(--muted)}

/* ── SEARCH ── */
.search-header{padding-top:8px;margin-bottom:12px;display:flex;flex-direction:column;gap:8px}
.search-box{display:flex;align-items:center;background:var(--bg3);border:1px solid var(--border);border-radius:40px;padding:0 16px;gap:8px}
.search-icon{font-size:1.1rem;color:var(--muted)}
#searchInput{flex:1;background:none;border:none;outline:none;color:var(--text);font-family:var(--font);font-size:.95rem;padding:12px 0}
.clear-search{background:none;border:none;color:var(--muted);cursor:pointer;font-size:.9rem;padding:4px}
.search-suggestions h3{font-size:.85rem;color:var(--muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:1px}
.genre-chips{display:flex;flex-wrap:wrap;gap:8px}
.genre-chip{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:6px 14px;color:var(--text);font-family:var(--font);font-size:.82rem;cursor:pointer;transition:all .15s}
.genre-chip:active{background:var(--accent);border-color:var(--accent)}
.results-count{font-size:.8rem;color:var(--muted);margin-bottom:8px}
.sel-actions{display:flex;gap:8px}

/* ── PLAYLISTS ── */
.playlists-grid{display:flex;flex-direction:column;gap:8px}
.playlist-item{display:flex;align-items:center;gap:12px;padding:10px;background:var(--bg3);border-radius:var(--radius);border:1px solid var(--border)}
.pl-item-cover{width:56px;height:56px;border-radius:10px;background:linear-gradient(135deg,var(--accent)44,var(--bg4));display:flex;align-items:center;justify-content:center;font-size:1.5rem;cursor:pointer;flex-shrink:0}
.pl-item-info{flex:1;min-width:0;cursor:pointer}
.pl-item-name{font-size:.95rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pl-item-desc{font-size:.78rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pl-item-actions{display:flex;gap:4px}

/* ── LEARN ── */
.learn-hero{margin-bottom:16px}
.learn-fact-card{background:linear-gradient(135deg,#7B2FFF22,#00F0FF11);border:1px solid var(--accent);border-radius:var(--radius);padding:16px;display:flex;align-items:flex-start;gap:12px}
.fact-emoji{font-size:1.8rem;flex-shrink:0}.fact-text{font-size:.9rem;line-height:1.5;flex:1}.fact-label{font-size:.7rem;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.learn-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:20px}
.learn-stat{background:var(--bg3);border-radius:var(--radius-sm);padding:12px;text-align:center;display:flex;flex-direction:column;gap:2px}
.stat-n{font-size:1.6rem;font-weight:800;color:var(--accent)}.stat-l{font-size:.75rem;color:var(--muted)}
.learn-section-title{font-size:1rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
.learn-modes{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px}
.learn-mode-btn{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:16px 12px;text-align:left;cursor:pointer;color:var(--text);font-family:var(--font);transition:all .2s}
.learn-mode-btn:active{transform:scale(.97);border-color:var(--accent)}
.mode-icon{font-size:1.6rem;margin-bottom:8px}.mode-name{font-size:.9rem;font-weight:700}.mode-desc{font-size:.75rem;color:var(--muted);margin-top:3px;line-height:1.4}
.theory-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.theory-card{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 8px;text-align:center;cursor:pointer;transition:all .2s}
.theory-card:active{border-color:var(--accent2)}.theory-icon{font-size:1.5rem;margin-bottom:6px}.theory-title{font-size:.82rem;font-weight:700}.theory-desc{font-size:.7rem;color:var(--muted);margin-top:2px;line-height:1.3}

/* ── PLAYER BAR ── */
.player-bar{position:fixed;bottom:calc(var(--nav-h) + env(safe-area-inset-bottom));left:0;right:0;background:rgba(245,247,255,.92);backdrop-filter:blur(20px);border-top:1px solid var(--border);z-index:100}
.player-bar.hidden{display:none}
.player-progress-wrap{height:3px;background:var(--bg4);position:relative}
.player-progress-bg{height:100%;position:relative;overflow:hidden}
.player-progress-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width .1s linear}
.progress-range{position:absolute;top:-8px;left:0;width:100%;height:19px;opacity:0;cursor:pointer;-webkit-appearance:none}
.player-main{display:flex;align-items:center;padding:8px 12px;gap:8px;height:var(--player-h)}
.player-info{flex:1;display:flex;align-items:center;gap:10px;min-width:0;cursor:pointer}
.player-cover{width:48px;height:48px;border-radius:10px;overflow:hidden;flex-shrink:0;position:relative;background:var(--bg3)}
.mini-viz{position:absolute;top:0;left:0;width:100%;height:100%;border-radius:10px}
.player-text{flex:1;min-width:0}
.player-title{font-size:.9rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.player-artist{font-size:.75rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.player-controls{display:flex;align-items:center;gap:4px}
.ctrl-btn{background:none;border:none;color:var(--text);font-size:1.1rem;padding:8px;cursor:pointer;border-radius:50%;transition:background .15s;line-height:1}
.ctrl-btn:active{background:var(--bg3)}
.play-btn{background:var(--accent)!important;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:50%;font-size:1rem}
.fav-btn.active,.heart-btn.fav{color:var(--accent3)}

/* ── BOTTOM NAV ── */
.bottom-nav{position:fixed;bottom:0;left:0;right:0;height:calc(var(--nav-h) + env(safe-area-inset-bottom));display:flex;background:rgba(245,247,255,.95);backdrop-filter:blur(20px);border-top:1px solid var(--border);padding-bottom:env(safe-area-inset-bottom);z-index:101}
.nav-btn{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;background:none;border:none;color:var(--muted);cursor:pointer;font-family:var(--font);padding:8px 4px;transition:color .2s;position:relative}
.nav-btn.active{color:var(--accent)}
.nav-btn.active::before{content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);width:32px;height:2px;background:var(--accent);border-radius:0 0 3px 3px}
.nav-icon{font-size:1.3rem;line-height:1}.nav-label{font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.5px}

/* ── MODAL ── */
.modal-overlay{position:fixed;inset:0;background:rgba(13,17,23,.45);backdrop-filter:blur(4px);z-index:200;display:flex;align-items:flex-end;justify-content:center;padding:16px}
.modal-overlay.hidden{display:none}
.modal-overlay.modal-fullplayer{padding:0;align-items:stretch}
.modal-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius) var(--radius) 0 0;padding:16px;width:100%;max-height:85vh;overflow-y:auto;animation:slideUp .2s ease-out}
@keyframes slideUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px}
.modal-header h2{font-size:1.1rem;font-weight:700;flex:1}.modal-header button{background:none;border:none;color:var(--muted);font-size:1.2rem;cursor:pointer;padding:4px;border-radius:8px}
.modal-form{display:flex;flex-direction:column;gap:10px;margin-bottom:16px}
.modal-input{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;color:var(--text);font-family:var(--font);font-size:.95rem;outline:none;width:100%}
.modal-input:focus{border-color:var(--accent)}.modal-textarea{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;color:var(--text);font-family:var(--font);font-size:.9rem;outline:none;width:100%;resize:none}
.modal-actions{display:flex;gap:10px;flex-direction:column}.modal-subtitle{color:var(--muted);font-size:.85rem;margin-bottom:12px}
.menu-actions{display:flex;flex-direction:column;gap:2px}
.menu-action{background:none;border:none;color:var(--text);font-family:var(--font);font-size:.95rem;padding:14px;text-align:left;border-radius:var(--radius-sm);cursor:pointer;transition:background .15s}
.menu-action:active{background:var(--bg3)}.menu-action.danger{color:var(--accent3)}
.pl-select-list{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
.pl-select-item{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;display:flex;align-items:center;gap:10px;color:var(--text);font-family:var(--font);font-size:.9rem;cursor:pointer;transition:border-color .15s;text-align:left}
.pl-select-item:active{border-color:var(--accent)}.pl-sel-icon{font-size:1.2rem}
.pl-detail-desc{font-size:.8rem;color:var(--muted);margin-top:2px}
.pl-detail-actions{display:flex;gap:8px;margin-bottom:12px}
.pl-songs-list{display:flex;flex-direction:column;gap:2px;max-height:50vh;overflow-y:auto}
.pl-song-row{display:flex;align-items:center;gap:8px;padding:8px;border-radius:var(--radius-sm);transition:background .15s}
.pl-song-row:active{background:var(--bg3)}.pl-song-info{display:flex;align-items:center;gap:8px;flex:1;cursor:pointer;min-width:0}
.pl-song-num{color:var(--muted);font-size:.8rem;min-width:20px;font-family:var(--mono)}
.pl-song-title{font-size:.9rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pl-song-artist{font-size:.78rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-left:auto}

/* ── FULL PLAYER ── */
.full-player{position:relative;width:100%;height:100%;background:var(--bg);overflow-y:auto;animation:slideIn .3s ease-out}
@keyframes slideIn{from{transform:translateY(100%)}to{transform:translateY(0)}}
.full-player-bg{position:fixed;inset:0;pointer-events:none;z-index:0}
.fp-close{position:fixed;top:calc(12px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:6px 24px;color:var(--muted);font-size:1.2rem;cursor:pointer;z-index:2}
.fp-content{position:relative;z-index:1;padding:calc(60px + env(safe-area-inset-top)) 24px calc(24px + env(safe-area-inset-bottom));max-width:500px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.fp-cover-wrap{display:flex;justify-content:center}
.fp-cover{width:min(280px,75vw);height:min(280px,75vw);border-radius:24px;display:flex;align-items:center;justify-content:center;box-shadow:0 20px 60px rgba(123,47,255,.3)}
.fp-cover-letter{font-size:4rem;font-weight:800}
.fp-song-info{text-align:center}
.fp-title{font-size:1.4rem;font-weight:800;margin-bottom:4px}
.fp-artist{font-size:1rem;color:var(--muted)}
.fp-meta{display:flex;justify-content:center;gap:8px;margin-top:6px}
.fp-progress{display:flex;flex-direction:column;gap:6px}
.fp-progress input[type=range]{-webkit-appearance:none;width:100%;height:4px;background:var(--bg4);border-radius:4px;outline:none}
.fp-progress input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--accent);cursor:pointer}
.fp-times{display:flex;justify-content:space-between;font-size:.78rem;color:var(--muted);font-family:var(--mono)}
.fp-controls{display:flex;align-items:center;justify-content:center;gap:12px}
.fp-btn{background:none;border:none;color:var(--text);cursor:pointer;font-size:1.4rem;padding:10px;border-radius:50%;transition:all .15s}
.fp-btn:active{background:var(--bg3);transform:scale(.9)}
.fp-btn.play{background:var(--accent);width:64px;height:64px;display:flex;align-items:center;justify-content:center;border-radius:50%;font-size:1.5rem;box-shadow:0 8px 24px var(--accent)66}
.fp-btn.active{color:var(--accent)}
.fp-extras{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.fp-extra-btn{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:8px 16px;color:var(--text);font-family:var(--font);font-size:.82rem;cursor:pointer;transition:all .15s}
.fp-extra-btn:active{border-color:var(--accent)}.fp-extra-btn.active{color:var(--accent3);border-color:var(--accent3)}
.fp-volume{display:flex;align-items:center;gap:10px;font-size:1rem}
.fp-volume input[type=range]{flex:1;-webkit-appearance:none;height:4px;background:var(--bg4);border-radius:4px}
.fp-volume input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--accent2);cursor:pointer}
.fp-visualizer{width:100%;height:80px;border-radius:var(--radius-sm);background:var(--bg3)}

/* ── BUTTONS ── */
.btn-primary{background:var(--accent);color:white;border:none;border-radius:var(--radius-sm);padding:12px 20px;font-family:var(--font);font-size:.9rem;font-weight:700;cursor:pointer;width:100%;transition:all .15s}
.btn-primary:active{transform:scale(.97)}.btn-primary:disabled{opacity:.4;cursor:not-allowed}
.btn-ghost{background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 20px;font-family:var(--font);font-size:.9rem;font-weight:600;cursor:pointer;width:100%;transition:all .15s}
.btn-ghost:active{border-color:var(--accent)}.btn-ghost.mt{margin-top:8px}
.btn-accent{background:#7B2FFF22;color:var(--accent);border:1px solid var(--accent);border-radius:20px;padding:6px 14px;font-family:var(--font);font-size:.82rem;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap}
.btn-accent:active{background:var(--accent);color:white}
.btn-danger{background:#FF2F7B22;color:var(--accent3);border:1px solid var(--accent3);border-radius:var(--radius-sm);padding:12px 20px;font-family:var(--font);font-size:.9rem;font-weight:700;cursor:pointer;width:100%}
.icon-btn{background:none;border:none;color:var(--muted);font-size:1rem;padding:6px;cursor:pointer;border-radius:8px;transition:color .15s;font-family:var(--font)}
.icon-btn:active{color:var(--text)}.icon-btn.danger{color:var(--accent3)}

/* ── CHECKBOXES ── */
.song-checkbox{position:relative;width:24px;height:24px;flex-shrink:0;cursor:pointer}
.song-checkbox input{opacity:0;position:absolute;width:0;height:0}
.checkmark{position:absolute;inset:0;background:var(--bg3);border:2px solid var(--border);border-radius:6px;transition:all .15s}
.song-checkbox input:checked ~ .checkmark{background:var(--accent);border-color:var(--accent)}
.song-checkbox input:checked ~ .checkmark::after{content:'✓';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:white;font-size:.8rem;font-weight:700}

/* ── EQ MODAL ── */
.eq-sliders{display:flex;flex-direction:column;gap:14px;margin-bottom:16px}
.eq-band{display:flex;align-items:center;gap:10px}
.eq-label{width:80px;font-size:.85rem;font-weight:600;flex-shrink:0}
.eq-band input[type=range]{flex:1;-webkit-appearance:none;height:4px;background:var(--bg4);border-radius:4px}
.eq-band input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:var(--accent2);cursor:pointer}
.eq-val{width:30px;text-align:right;font-size:.8rem;font-family:var(--mono);color:var(--muted)}
.eq-presets{margin-bottom:14px}.eq-preset-label{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.preset-btn{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:6px 14px;color:var(--text);font-family:var(--font);font-size:.8rem;cursor:pointer;margin-right:6px;margin-bottom:6px;transition:border-color .15s}
.preset-btn:active{border-color:var(--accent)}

/* ── TIMER MODAL ── */
.timer-options{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.timer-btn{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;color:var(--text);font-family:var(--font);font-size:.9rem;font-weight:600;cursor:pointer;transition:all .15s}
.timer-btn:active{background:var(--accent);border-color:var(--accent)}

/* ── QUIZ MODAL ── */
.quiz-question{font-size:1rem;font-weight:700;margin-bottom:16px;line-height:1.4}
.quiz-options{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.quiz-opt{background:var(--bg3);border:2px solid var(--border);border-radius:var(--radius-sm);padding:14px;color:var(--text);font-family:var(--font);font-size:.9rem;text-align:left;cursor:pointer;transition:all .15s}
.quiz-opt:active{border-color:var(--accent)}.quiz-opt.correct{border-color:#00FF88;background:#00FF8822;color:#00FF88}
.quiz-opt.wrong{border-color:var(--accent3);background:#FF2F7B22;color:var(--accent3)}
.quiz-result{text-align:center;padding:12px 0}.quiz-win{color:#00FF88;font-size:1rem;font-weight:700;margin-bottom:12px}
.quiz-lose{color:var(--accent3);font-size:1rem;font-weight:700;margin-bottom:12px}

/* ── FLASHCARD ── */
.flashcard{perspective:1000px;height:180px;cursor:pointer;margin-bottom:16px}
.flashcard-inner{position:relative;width:100%;height:100%;transform-style:preserve-3d;transition:transform .5s}
.flashcard-inner.flipped{transform:rotateY(180deg)}
.flashcard-front,.flashcard-back{position:absolute;inset:0;backface-visibility:hidden;background:linear-gradient(135deg,var(--accent)44,var(--bg3));border:1px solid var(--accent);border-radius:var(--radius);padding:20px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px}
.flashcard-back{transform:rotateY(180deg);background:linear-gradient(135deg,var(--accent2)33,var(--bg3));border-color:var(--accent2)}
.fc-category{font-size:.72rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted)}
.fc-text{font-size:1.4rem;font-weight:800;text-align:center}
.fc-hint{font-size:.75rem;color:var(--muted);margin-top:4px}
.fc-actions{text-align:center}

/* ── INSTRUMENTS ── */
.instruments-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.instrument-card{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px 8px;text-align:center}
.inst-icon{font-size:2rem;margin-bottom:6px}.inst-name{font-size:.82rem;font-weight:600}

/* ── GENRE EXPLORER ── */
.genre-explorer{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
.genre-explore-card{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px 8px;text-align:center;cursor:pointer;transition:border-color .15s}
.genre-explore-card:active{border-color:var(--accent)}
.ge-emoji{font-size:1.6rem;margin-bottom:4px}.ge-name{font-size:.85rem;font-weight:700}.ge-mood{font-size:.72rem;color:var(--muted);margin-top:2px}
.genre-detail{margin-bottom:12px}.gd-desc{font-size:.9rem;line-height:1.6;margin-bottom:12px;color:var(--muted)}
.gd-stats{display:flex;gap:10px;margin-bottom:12px}
.gd-stat{background:var(--bg3);border-radius:var(--radius-sm);padding:10px;flex:1;text-align:center;display:flex;flex-direction:column;gap:3px}
.gd-stat span{font-size:.72rem;color:var(--muted)}.gd-stat strong{font-size:.9rem;font-weight:700}
.gd-songs h3{font-size:.9rem;font-weight:700;margin-bottom:8px}.gd-song{padding:8px;cursor:pointer;color:var(--accent);font-size:.88rem;border-radius:6px}
.gd-song:active{background:var(--bg3)}

/* ── NOTES ── */
.notes-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:12px}
.note-card{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 4px;text-align:center;border-top:3px solid var(--note-color)}
.note-name{font-size:.9rem;font-weight:800}.note-freq{font-size:.6rem;color:var(--muted);font-family:var(--mono);margin-top:2px}
.note-en{font-size:.7rem;color:var(--note-color);font-weight:700;margin-top:2px}
.notes-info{font-size:.82rem;color:var(--muted);line-height:1.5;background:var(--bg3);border-radius:var(--radius-sm);padding:10px}

/* ── CHORDS ── */
.chords-list{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.chord-row{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg3);border-radius:var(--radius-sm)}
.chord-name{font-size:.9rem;font-weight:700}.chord-notes{font-size:.85rem;color:var(--accent2);font-family:var(--mono)}

/* ── RHYTHMS ── */
.rhythms-list{display:flex;flex-direction:column;gap:8px}
.rhythm-row{padding:12px;background:var(--bg3);border-radius:var(--radius-sm)}
.rhythm-name{font-size:1.1rem;font-weight:800;color:var(--accent);margin-bottom:4px}
.rhythm-desc{font-size:.82rem;color:var(--muted);line-height:1.4}

/* ── SONG INFO ── */
.song-info-grid{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
.info-row{display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--border)}
.info-key{font-size:.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}.info-val{font-size:.88rem;text-align:right;max-width:60%}

/* ── EMPTY STATE ── */
.empty-state{text-align:center;padding:40px 20px;display:flex;flex-direction:column;align-items:center;gap:12px}
.empty-state.small{padding:20px}.empty-icon{font-size:3rem}
.empty-state h2{font-size:1.2rem;font-weight:700}.empty-state p{color:var(--muted);font-size:.9rem}

/* ── ADD MUSIC MODAL ── */
.add-music-options{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.add-option{display:flex;align-items:center;gap:14px;padding:14px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;transition:border-color .15s}
.add-option:active,.add-option:hover{border-color:var(--accent)}
.add-opt-icon{font-size:1.6rem;flex-shrink:0}.add-opt-title{font-size:.9rem;font-weight:700}.add-opt-desc{font-size:.78rem;color:var(--muted);margin-top:2px}
.drop-zone.drag-over{border-color:var(--accent);background:var(--accent)11}
.add-progress{margin-top:12px;display:flex;flex-direction:column;gap:6px}.add-progress.hidden{display:none}
.progress-bar-wrap{height:6px;background:var(--bg4);border-radius:4px;overflow:hidden}
.progress-bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:4px;transition:width .2s}

/* ── NOTIFICATION ── */
.notification{position:fixed;top:calc(16px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 20px;font-size:.85rem;font-weight:600;z-index:300;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.4);animation:notifIn .2s ease-out}
.notification.hidden{display:none}.notification.success{border-color:#00FF88;color:#00FF88}.notification.error{border-color:var(--accent3);color:var(--accent3)}.notification.info{border-color:var(--accent);color:var(--accent)}
@keyframes notifIn{from{transform:translateX(-50%) translateY(-10px);opacity:0}to{transform:translateX(-50%) translateY(0);opacity:1}}

/* ── INSTALL BANNER ── */
.install-banner{background:linear-gradient(90deg,var(--accent)33,var(--accent2)22);border-bottom:1px solid var(--accent);padding:10px 16px;display:flex;align-items:center;gap:10px;font-size:.85rem;font-weight:600;z-index:50}
.install-banner.hidden{display:none}.btn-install{background:var(--accent);color:white;border:none;border-radius:20px;padding:6px 16px;font-family:var(--font);font-size:.8rem;font-weight:700;cursor:pointer;margin-left:auto}
.btn-close-banner{background:none;border:none;color:var(--muted);font-size:1rem;cursor:pointer;padding:4px}

/* ── LOADING ── */
.loading-state{text-align:center;padding:20px;color:var(--muted)}

/* ── SCROLLBAR ── */
::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}

@media(min-width:600px){
  .learn-modes{grid-template-columns:repeat(4,1fr)}
  .notes-grid{grid-template-columns:repeat(7,1fr)}
  .fp-content{padding-top:80px}
}
[data-theme="dark"] .player-bar{background:rgba(5,8,16,.9)}
[data-theme="dark"] .bottom-nav{background:rgba(5,8,16,.95)}
[data-theme="dark"] .modal-overlay{background:rgba(0,0,0,.6)}
[data-theme="dark"] .full-player{background:var(--bg)}
[data-theme="light"] .home-title{background:linear-gradient(135deg,#6B1FEF,#0090CC);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
[data-theme="light"] .notification{box-shadow:0 8px 24px rgba(0,0,0,.15)}
[data-theme="light"] .song-row:active{background:var(--bg4)}
[data-theme="light"] .song-row.playing{background:var(--bg3);box-shadow:var(--shadow)}
[data-theme="light"] .modal-card{box-shadow:0 -8px 32px rgba(0,0,0,.1)}
[data-theme="light"] .player-bar{box-shadow:0 -2px 12px rgba(0,0,0,.08)}
[data-theme="light"] .bottom-nav{box-shadow:0 -2px 12px rgba(0,0,0,.06)}`;
    document.head.appendChild(style);
  }
};

// Install PWA
App.installPWA = async function() {
  if (State.installPrompt) {
    State.installPrompt.prompt();
    const { outcome } = await State.installPrompt.userChoice;
    if (outcome === 'accepted') { State.isInstalled = true; UI.hideInstallBanner(); }
    State.installPrompt = null;
  }
};

App.shuffleAll = function() {
  if (!State.songs.length) { UI.showNotification('Adicione músicas primeiro!', 'error'); return; }
  const shuffled = [...State.songs].sort(() => Math.random() - 0.5);
  App.playSong(shuffled[0], shuffled, 0);
};

// Init
document.addEventListener('DOMContentLoaded', () => App.init());
