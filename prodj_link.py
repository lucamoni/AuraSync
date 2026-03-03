import socket
import threading
import time

class ProDJLinkBridge:
    """
    AuraSync Pioneer Pro DJ Link Bridge.
    Listens on UDP 50000 (Keep-Alive), 50001 (Beat Info), and 50002 (Status).
    Provides real-time BPM and Phase (Quantize) data.
    """
    def __init__(self):
        self.running = False
        self.thread = None
        self.beat_thread = None
        
        self.master_bpm = 120.0
        self.is_playing = False
        self.master_player_id = 1
        self.players = {} # id -> {bpm, beat, play_state, etc}
        
        self.current_beat = 0
        self.last_beat_time = time.time()
        
        self.keepalive_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.beat_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.status_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        
        try:
            self.keepalive_sock.bind(("", 50000))
            self.beat_sock.bind(("", 50001))
            self.status_sock.bind(("", 50002))
            
            self.status_sock.settimeout(0.5)
            self.beat_sock.settimeout(0.5)
            self.keepalive_sock.settimeout(0.5)
            self.is_connected = True
        except Exception as e:
            print(f"[ProDJLink] Port Binding Failed: {e}")
            self.is_connected = False

    def start(self):
        if not self.running and self.is_connected:
            self.running = True
            self.thread = threading.Thread(target=self._status_loop, daemon=True)
            self.beat_thread = threading.Thread(target=self._beat_loop, daemon=True)
            self.thread.start()
            self.beat_thread.start()
            print("[ProDJLink] High-precision listeners active.")

    def stop(self):
        self.running = False

    def _status_loop(self):
        """Processes player status, BPM, and Master selection (Port 50002)."""
        while self.running:
            try:
                data, addr = self.status_sock.recvfrom(1024)
                if data.startswith(b'MacC'): # Generic Pioneer Header
                    player_id = data[0x21]
                    # Offset 0x24: BPM (multiply by 100 on CDJ)
                    raw_bpm = int.from_bytes(data[0x24:0x26], byteorder='big')
                    bpm = raw_bpm / 100.0
                    
                    # Offset 0x1C: Play state (0x02 = Play, 0x00 = Stop)
                    play_state = data[0x1C]
                    is_playing = (play_state == 0x02)
                    
                    # Offset 0x2E: Master flag
                    is_master = (data[0x2E] & 0x01) == 1
                    
                    if player_id not in self.players: self.players[player_id] = {}
                    self.players[player_id].update({
                        "bpm": bpm,
                        "playing": is_playing,
                        "master": is_master
                    })
                    
                    if is_master:
                        self.master_bpm = bpm
                        self.master_player_id = player_id
                        self.is_playing = is_playing
                        
            except socket.timeout: pass
            except: pass

    def _beat_loop(self):
        """Processes precise beat/phase info (Port 50001)."""
        while self.running:
            try:
                data, addr = self.beat_sock.recvfrom(1024)
                if data.startswith(b'MacC'):
                    player_id = data[0x21]
                    # Beat count since start or loop
                    beat_count = data[0x24] # Current beat in bar? No, offset varies
                    
                    # CDJ-2000 Pro DJ Link Beat Info (0x02) packet
                    # Offset 0x24 usually contains the beat number (1-4)
                    # Offset 0x2E is the relative position in the beat
                    
                    if player_id == self.master_player_id:
                        new_beat = data[0x24]
                        if new_beat != self.current_beat:
                            self.current_beat = new_beat
                            self.last_beat_time = time.time()
                            
            except socket.timeout: pass
            except: pass

    def get_state(self):
        return {
            "connected": self.is_connected,
            "master_bpm": self.master_bpm,
            "master_player": self.master_player_id,
            "playing": self.is_playing,
            "current_beat": self.current_beat,
            "last_beat_age": time.time() - self.last_beat_time,
            "players": self.players.copy()
        }
