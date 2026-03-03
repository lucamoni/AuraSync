import time
import threading
import spotipy
import os
import requests
from io import BytesIO
from PIL import Image
from spotipy.oauth2 import SpotifyOAuth

class SpotifyBridge:
    """
    AuraSync Spotify Integration.
    Handles OAuth2 and polls currently playing track metadata (BPM, Key, Mood).
    Enhanced V2: Fetches detailed audio analysis for structural mapping.
    """
    def __init__(self, client_id=None, client_secret=None, redirect_uri='http://127.0.0.1:8000/callback'):
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.cache_path = ".spotify_cache"
        self.spotify = None
        self.is_connected = False
        self.active_device_id = None
        
        self.current_track = {
            "id": None,
            "name": "No Track",
            "artist": "Unknown",
            "cover_url": "",
            "bpm": 0,
            "key": -1,
            "energy": 0.0,
            "danceability": 0.0,
            "dominant_color": (255, 255, 255),
            "sections": [],
            "beats": [],
            "current_section_index": -1,
            "progress_ms": 0,
            "is_playing": False
        }
        
        self.last_sync_time = time.time()
        self.last_sync_progress = 0
        
        self.running = False
        self.thread = None
        self.analysis_available = True # Flag for 403 errors
        
        # Auto-reconnect if cache exists
        if os.path.exists(self.cache_path) and self.client_id and self.client_secret:
            print("[Spotify] Cache found, attempting auto-reconnect...")
            self.connect()

    def connect(self):
        try:
            auth_manager = SpotifyOAuth(
                client_id=self.client_id,
                client_secret=self.client_secret,
                redirect_uri=self.redirect_uri,
                scope="user-read-currently-playing user-read-playback-state user-modify-playback-state",
                cache_path=self.cache_path,
                open_browser=False
            )
            self.spotify = spotipy.Spotify(auth_manager=auth_manager)
            token_info = auth_manager.get_cached_token()
            if token_info:
                self.is_connected = True
                print("Spotify Web API Connected.")
        except Exception as e:
            print(f"Spotify Auth Error: {e}")
            self.is_connected = False

    def start_polling(self, interval=3.0):
        if not self.running and self.is_connected:
            self.running = True
            self.thread = threading.Thread(target=self._poll_loop, args=(interval,), daemon=True)
            self.thread.start()

    def stop_polling(self):
        self.running = False

    def get_current_progress(self):
        """Estimates current track progress in ms using a virtual clock."""
        if not self.current_track["is_playing"]:
            return self.last_sync_progress
        
        dt = (time.time() - self.last_sync_time) * 1000
        return self.last_sync_progress + dt

    def _update_analysis(self, track_id):
        """Fetches detailed structural info for the track."""
        try:
            print(f"[Spotify] Fetching analysis for {track_id}...")
            features = self.spotify.audio_features(track_id)[0]
            analysis = self.spotify.audio_analysis(track_id)
            
            self.current_track.update({
                "bpm": features.get("tempo", 120),
                "key": features.get("key", -1),
                "energy": features.get("energy", 0.5),
                "danceability": features.get("danceability", 0.5),
                "valence": features.get("valence", 0.5),
                "sections": analysis.get("sections", []),
                "beats": analysis.get("beats", [])
            })
            print(f"[Spotify] Analysis complete: {self.current_track['bpm']} BPM, {len(self.current_track['sections'])} sections.")
            self.analysis_available = True
        except Exception as e:
            if "high" in str(e).lower() or "403" in str(e):
                print("[Spotify] 403 Forbidden. Audio Features / Analysis are restricted to Partners. Switching to Hybrid AI Sync.")
                self.analysis_available = False
            else:
                print(f"[Spotify] Analysis Error: {e}")
            
            # Ensure safe fallback data
            self.current_track.update({"bpm": 0, "sections": [], "beats": [], "energy": 0.5})

    def _poll_loop(self, interval):
        last_track_id = None
        last_cover_url = ""
        
        while self.running:
            try:
                playback = self.spotify.current_playback()
                if playback and playback.get('item'):
                    item = playback['item']
                    track_id = item['id']
                    is_playing = playback.get('is_playing', False)
                    progress_ms = playback.get('progress_ms', 0)
                    
                    self.last_sync_time = time.time()
                    self.last_sync_progress = progress_ms
                    
                    if track_id != last_track_id:
                        last_track_id = track_id
                        self.current_track["id"] = track_id
                        self._update_analysis(track_id)
                        
                        # Dominant color analysis
                        new_cover_url = item['album']['images'][0]['url'] if item['album']['images'] else ""
                        if new_cover_url and new_cover_url != last_cover_url:
                            last_cover_url = new_cover_url
                            try:
                                res = requests.get(new_cover_url, timeout=3)
                                img = Image.open(BytesIO(res.content)).convert("RGB").resize((10, 10))
                                colors = img.getcolors(100)
                                if colors:
                                    sorted_colors = sorted(colors, key=lambda t: t[0], reverse=True)
                                    self.current_track["dominant_color"] = sorted_colors[0][1]
                            except: pass

                    # Update dynamic play state
                    self.current_track.update({
                        "name": item['name'],
                        "artist": item['artists'][0]['name'],
                        "cover_url": last_cover_url,
                        "is_playing": is_playing,
                        "progress_ms": progress_ms,
                        "duration_ms": item.get('duration_ms', 0),
                        "device_id": playback.get('device', {}).get('id')
                    })
                    
                    # Track Section Index
                    cur_p = progress_ms / 1000.0
                    sections = self.current_track.get("sections", [])
                    new_idx = -1
                    for i, s in enumerate(sections):
                        if cur_p >= s['start'] and cur_p < (s['start'] + s['duration']):
                            new_idx = i
                            break
                    self.current_track["current_section_index"] = new_idx

            except Exception as e:
                print(f"[Spotify] Poll Error: {e}")
            
            time.sleep(interval)

    def _ensure_device(self):
        if self.active_device_id: return self.active_device_id
        devices = self.spotify.devices().get('devices', [])
        for d in devices:
            if d.get('is_active'):
                self.active_device_id = d.get('id')
                return self.active_device_id
        return devices[0].get('id') if devices else None

    def play(self):
        try: self.spotify.start_playback(device_id=self._ensure_device())
        except: pass
        
    def pause(self):
        try: self.spotify.pause_playback(device_id=self._ensure_device())
        except: pass
        
    def next_track(self):
        try: self.spotify.next_track(device_id=self._ensure_device())
        except: pass
        
    def previous_track(self):
        try: self.spotify.previous_track(device_id=self._ensure_device())
        except: pass

    def set_volume(self, vol):
        try: self.spotify.volume(vol, device_id=self._ensure_device())
        except: pass

    def seek(self, pos):
        try: self.spotify.seek_track(pos, device_id=self._ensure_device())
        except: pass

    def shuffle(self, state):
        try: self.spotify.shuffle(state, device_id=self._ensure_device())
        except: pass

    def repeat(self, state):
        try: self.spotify.repeat(state, device_id=self._ensure_device())
        except: pass

    def get_state(self):
        # Sync the estimated progress before returning
        self.current_track["progress_ms"] = self.get_current_progress()
        return {
            "connected": self.is_connected,
            "track": self.current_track.copy()
        }
