// PlayLuz IndexedDB Database Layer
const DB_NAME = 'PlayLuzDB';
const DB_VERSION = 1;

class PlayLuzDB {
  constructor() {
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        // Songs store
        if (!db.objectStoreNames.contains('songs')) {
          const songs = db.createObjectStore('songs', { keyPath: 'id', autoIncrement: true });
          songs.createIndex('title', 'title', { unique: false });
          songs.createIndex('artist', 'artist', { unique: false });
          songs.createIndex('genre', 'genre', { unique: false });
        }
        // Playlists store
        if (!db.objectStoreNames.contains('playlists')) {
          const pl = db.createObjectStore('playlists', { keyPath: 'id', autoIncrement: true });
          pl.createIndex('name', 'name', { unique: false });
        }
        // Playlist-Songs junction
        if (!db.objectStoreNames.contains('playlist_songs')) {
          const ps = db.createObjectStore('playlist_songs', { keyPath: 'id', autoIncrement: true });
          ps.createIndex('playlistId', 'playlistId', { unique: false });
          ps.createIndex('songId', 'songId', { unique: false });
        }
        // Learning progress
        if (!db.objectStoreNames.contains('learning')) {
          const lrn = db.createObjectStore('learning', { keyPath: 'id', autoIncrement: true });
          lrn.createIndex('songId', 'songId', { unique: false });
          lrn.createIndex('type', 'type', { unique: false });
        }
        // Stats / history
        if (!db.objectStoreNames.contains('history')) {
          const hist = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
          hist.createIndex('songId', 'songId', { unique: false });
          hist.createIndex('playedAt', 'playedAt', { unique: false });
        }
        // Settings
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        // Favorites
        if (!db.objectStoreNames.contains('favorites')) {
          const fav = db.createObjectStore('favorites', { keyPath: 'songId' });
        }
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(this); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  _tx(stores, mode = 'readonly') {
    return this.db.transaction(stores, mode);
  }

  async addSong(song) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('songs', 'readwrite');
      const req = tx.objectStore('songs').add({ ...song, addedAt: Date.now(), playCount: 0 });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getSongs() {
    return new Promise((resolve, reject) => {
      const tx = this._tx('songs');
      const req = tx.objectStore('songs').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getSong(id) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('songs');
      const req = tx.objectStore('songs').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async updateSong(song) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('songs', 'readwrite');
      const req = tx.objectStore('songs').put(song);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteSong(id) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('songs', 'readwrite');
      tx.objectStore('songs').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async searchSongs(query) {
    const all = await this.getSongs();
    const q = query.toLowerCase();
    return all.filter(s =>
      (s.title||'').toLowerCase().includes(q) ||
      (s.artist||'').toLowerCase().includes(q) ||
      (s.album||'').toLowerCase().includes(q) ||
      (s.genre||'').toLowerCase().includes(q)
    );
  }

  async addPlaylist(name, description = '') {
    return new Promise((resolve, reject) => {
      const tx = this._tx('playlists', 'readwrite');
      const req = tx.objectStore('playlists').add({ name, description, createdAt: Date.now(), cover: null });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getPlaylists() {
    return new Promise((resolve, reject) => {
      const tx = this._tx('playlists');
      const req = tx.objectStore('playlists').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async deletePlaylist(id) {
    return new Promise((resolve, reject) => {
      const tx = this._tx(['playlists','playlist_songs'], 'readwrite');
      tx.objectStore('playlists').delete(id);
      const idx = tx.objectStore('playlist_songs').index('playlistId');
      const req = idx.getAll(id);
      req.onsuccess = () => {
        req.result.forEach(r => tx.objectStore('playlist_songs').delete(r.id));
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async addSongsToPlaylist(playlistId, songIds) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('playlist_songs', 'readwrite');
      const store = tx.objectStore('playlist_songs');
      songIds.forEach(songId => store.add({ playlistId, songId, addedAt: Date.now() }));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getPlaylistSongs(playlistId) {
    const psList = await new Promise((resolve, reject) => {
      const tx = this._tx('playlist_songs');
      const req = tx.objectStore('playlist_songs').index('playlistId').getAll(playlistId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const songs = await Promise.all(psList.map(ps => this.getSong(ps.songId)));
    return songs.filter(Boolean);
  }

  async removeSongFromPlaylist(playlistId, songId) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('playlist_songs', 'readwrite');
      const idx = tx.objectStore('playlist_songs').index('playlistId');
      const req = idx.getAll(playlistId);
      req.onsuccess = () => {
        const entry = req.result.find(r => r.songId === songId);
        if (entry) tx.objectStore('playlist_songs').delete(entry.id);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async toggleFavorite(songId) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('favorites', 'readwrite');
      const store = tx.objectStore('favorites');
      const getReq = store.get(songId);
      getReq.onsuccess = () => {
        if (getReq.result) { store.delete(songId); resolve(false); }
        else { store.add({ songId, addedAt: Date.now() }); resolve(true); }
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async getFavorites() {
    return new Promise((resolve, reject) => {
      const tx = this._tx('favorites');
      const req = tx.objectStore('favorites').getAll();
      req.onsuccess = () => resolve(req.result.map(r => r.songId));
      req.onerror = () => reject(req.error);
    });
  }

  async isFavorite(songId) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('favorites');
      const req = tx.objectStore('favorites').get(songId);
      req.onsuccess = () => resolve(!!req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async addHistory(songId) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('history', 'readwrite');
      const req = tx.objectStore('history').add({ songId, playedAt: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async getHistory(limit = 50) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('history');
      const req = tx.objectStore('history').getAll();
      req.onsuccess = () => resolve(req.result.sort((a,b) => b.playedAt - a.playedAt).slice(0, limit));
      req.onerror = () => reject(req.error);
    });
  }

  async incrementPlayCount(songId) {
    const song = await this.getSong(songId);
    if (song) { song.playCount = (song.playCount || 0) + 1; await this.updateSong(song); }
  }

  async getSetting(key, def = null) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('settings');
      const req = tx.objectStore('settings').get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : def);
      req.onerror = () => reject(req.error);
    });
  }

  async setSetting(key, value) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('settings', 'readwrite');
      const req = tx.objectStore('settings').put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async saveLearningProgress(songId, type, data) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('learning', 'readwrite');
      const store = tx.objectStore('learning');
      // Check existing
      const idx = store.index('songId');
      const getReq = idx.getAll(songId);
      getReq.onsuccess = () => {
        const existing = getReq.result.find(r => r.type === type);
        if (existing) {
          store.put({ ...existing, ...data, updatedAt: Date.now() });
        } else {
          store.add({ songId, type, ...data, createdAt: Date.now(), updatedAt: Date.now() });
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getLearningForSong(songId) {
    return new Promise((resolve, reject) => {
      const tx = this._tx('learning');
      const req = tx.objectStore('learning').index('songId').getAll(songId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}

window.PlayLuzDB = new PlayLuzDB();
