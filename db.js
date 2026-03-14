const DB_NAME='PlayLuzDB',DB_VERSION=2;
class PlayLuzDB{
  constructor(){this.db=null}
  async init(){return new Promise((res,rej)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=e=>{const db=e.target.result;const stores={songs:{key:'id',auto:true,idx:[['title','title'],['artist','artist'],['genre','genre'],['bpm','bpm']]},playlists:{key:'id',auto:true,idx:[['name','name']]},playlist_songs:{key:'id',auto:true,idx:[['playlistId','playlistId'],['songId','songId']]},learning:{key:'id',auto:true,idx:[['songId','songId'],['type','type']]},history:{key:'id',auto:true,idx:[['songId','songId'],['playedAt','playedAt']]},settings:{key:'key'},favorites:{key:'songId'},ratings:{key:'songId'},stats:{key:'date'},xp:{key:'id',auto:true,idx:[['type','type']]}};for(const[name,cfg]of Object.entries(stores)){let st;if(!db.objectStoreNames.contains(name)){st=db.createObjectStore(name,{keyPath:cfg.key,autoIncrement:!!cfg.auto});(cfg.idx||[]).forEach(([n,k])=>st.createIndex(n,k,{unique:false}))}};};r.onsuccess=e=>{this.db=e.target.result;res(this)};r.onerror=e=>rej(e.target.error)})}
  _tx(s,m='readonly'){return this.db.transaction(s,m)}
  async _all(store){return new Promise((res,rej)=>{const r=this._tx(store).objectStore(store).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
  async _get(store,key){return new Promise((res,rej)=>{const r=this._tx(store).objectStore(store).get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
  async _put(store,val){return new Promise((res,rej)=>{const tx=this._tx(store,'readwrite');const r=tx.objectStore(store).put(val);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
  async _add(store,val){return new Promise((res,rej)=>{const tx=this._tx(store,'readwrite');const r=tx.objectStore(store).add(val);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
  async _del(store,key){return new Promise((res,rej)=>{const tx=this._tx(store,'readwrite');tx.objectStore(store).delete(key);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error)})}
  async addSong(s){return this._add('songs',{...s,addedAt:Date.now(),playCount:0,rating:0})}
  async getSongs(){return this._all('songs')}
  async getSong(id){return this._get('songs',id)}
  async updateSong(s){return this._put('songs',s)}
  async deleteSong(id){return this._del('songs',id)}
  async searchSongs(q){const all=await this.getSongs();const lq=q.toLowerCase();return all.filter(s=>(s.title||'').toLowerCase().includes(lq)||(s.artist||'').toLowerCase().includes(lq)||(s.album||'').toLowerCase().includes(lq)||(s.genre||'').toLowerCase().includes(lq))}
  async addPlaylist(name,desc=''){return this._add('playlists',{name,description:desc,createdAt:Date.now()})}
  async getPlaylists(){return this._all('playlists')}
  async updatePlaylist(pl){return this._put('playlists',pl)}
  async deletePlaylist(id){const tx=this._tx(['playlists','playlist_songs'],'readwrite');tx.objectStore('playlists').delete(id);const req=tx.objectStore('playlist_songs').index('playlistId').getAll(id);return new Promise((res,rej)=>{req.onsuccess=()=>{req.result.forEach(r=>tx.objectStore('playlist_songs').delete(r.id))};tx.oncomplete=res;tx.onerror=rej})}
  async addSongsToPlaylist(plId,songIds){return new Promise((res,rej)=>{const tx=this._tx('playlist_songs','readwrite');const st=tx.objectStore('playlist_songs');songIds.forEach(songId=>st.add({playlistId:plId,songId,addedAt:Date.now()}));tx.oncomplete=res;tx.onerror=rej})}
  async getPlaylistSongs(plId){const list=await new Promise((res,rej)=>{const r=this._tx('playlist_songs').objectStore('playlist_songs').index('playlistId').getAll(plId);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});const songs=await Promise.all(list.map(ps=>this.getSong(ps.songId)));return songs.filter(Boolean)}
  async removeSongFromPlaylist(plId,songId){return new Promise((res,rej)=>{const tx=this._tx('playlist_songs','readwrite');const req=tx.objectStore('playlist_songs').index('playlistId').getAll(plId);req.onsuccess=()=>{const e=req.result.find(r=>r.songId===songId);if(e)tx.objectStore('playlist_songs').delete(e.id)};tx.oncomplete=res;tx.onerror=rej})}
  async toggleFavorite(songId){return new Promise((res,rej)=>{const tx=this._tx('favorites','readwrite');const st=tx.objectStore('favorites');const r=st.get(songId);r.onsuccess=()=>{if(r.result){st.delete(songId);res(false)}else{st.add({songId,addedAt:Date.now()});res(true)}};r.onerror=()=>rej(r.error)})}
  async getFavorites(){const r=await this._all('favorites');return r.map(x=>x.songId)}
  async setRating(songId,stars){return this._put('ratings',{songId,stars,updatedAt:Date.now()})}
  async getRating(songId){const r=await this._get('ratings',songId);return r?r.stars:0}
  async getAllRatings(){const r=await this._all('ratings');return Object.fromEntries(r.map(x=>[x.songId,x.stars]))}
  async addHistory(songId){return this._add('history',{songId,playedAt:Date.now()})}
  async getHistory(limit=100){const all=await this._all('history');return all.sort((a,b)=>b.playedAt-a.playedAt).slice(0,limit)}
  async incrementPlayCount(songId){const s=await this.getSong(songId);if(s){s.playCount=(s.playCount||0)+1;await this.updateSong(s)}}
  async getSetting(k,def=null){const r=await this._get('settings',k);return r?r.value:def}
  async setSetting(k,v){return this._put('settings',{key:k,value:v})}
  async saveLearning(songId,type,data){const all=await new Promise((res,rej)=>{const r=this._tx('learning').objectStore('learning').index('songId').getAll(songId);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});const ex=all.find(r=>r.type===type);if(ex)return this._put('learning',{...ex,...data,updatedAt:Date.now()});return this._add('learning',{songId,type,...data,createdAt:Date.now(),updatedAt:Date.now()})}
  async getLearning(songId){return new Promise((res,rej)=>{const r=this._tx('learning').objectStore('learning').index('songId').getAll(songId);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
  async addXP(type,amount,desc){return this._add('xp',{type,amount,desc,date:Date.now()})}
  async getTotalXP(){const all=await this._all('xp');return all.reduce((s,x)=>s+x.amount,0)}
  async getXPHistory(){return this._all('xp')}
  async saveStats(date,data){return this._put('stats',{date,...data})}
  async getStats(days=30){const all=await this._all('stats');return all.sort((a,b)=>a.date>b.date?1:-1).slice(-days)}
}
window.PlayLuzDB=new PlayLuzDB();
