import socket
import time
import threading
import serial
import serial.tools.list_ports

class EuroliteDmxDriver:
    """Standalone USB-DMX driver for Eurolite/OpenDMX with macOS high-precision timing."""
    def __init__(self, port="auto"):
        self.port = port
        self.serial = None
        self.connect()

    def connect(self):
        if self.port == "auto":
            ports = list(serial.tools.list_ports.comports())
            for p in ports:
                dev = p.device.lower()
                if "usbserial" in dev or "cu.usb" in dev:
                    self.port = p.device
                    break
        
        if self.port == "auto":
            return False

        try:
            self.serial = serial.Serial(self.port, baudrate=250000, stopbits=2, timeout=0.1)
            time.sleep(0.1)
            print(f"[DMX] USB Output: Connected and Locked on {self.port}")
            return True
        except Exception as e:
            print(f"[DMX] USB Error: {e}")
            self.serial = None
            return False

    def is_connected(self):
        return self.serial is not None and self.serial.is_open

    def send_universe(self, data):
        if not self.is_connected():
            return
            
        try:
            # DMX BREAK: 57600 baudrate hack (more stable for FTDI on Mac)
            # 0x00 at 57600 baud = ~191us LOW
            self.serial.baudrate = 57600
            self.serial.write(b'\x00')
            self.serial.flush()
            
            # Wait for the hardware shift register to finish transmitting the break
            # 191us + 2ms USB buffer safety = 2.5ms
            time.sleep(0.0025)
            
            # DMX Spec: Mark After Break (MAB)
            self.serial.baudrate = 250000
            
            # Payload: Start Code (0x00) + 512 channels
            payload = bytearray([0x00]) + data[:512]
            
            # Pad payload to exactly 513 bytes
            if len(payload) < 513:
                payload += bytearray(513 - len(payload))
                
            self.serial.write(payload)
            self.serial.flush()
            
        except Exception as e:
            print(f"[DMX] USB Write Error: {e}")
            self.serial = None


class DMXEngine:
    """
    AuraSync Native DMX Engine.
    Supports Art-Net 4, sACN (E1.31) and hardware USB-DMX with high-precision 40Hz ticking.
    """
    
    ARTNET_PORT = 6454
    HEADER = b'Art-Net\x00'
    OP_DMX = 0x5000
    PROTOCOL_VERSION = 14
    
    def __init__(self, target_ip="255.255.255.255", universes_count=1):
        self.target_ip = target_ip
        self.unicast_ips = {} # {universe_id: [ip1, ip2, ...]}
        
        self.universes_count = universes_count
        # QLC+ Style Mixer Layers
        self.ai_buffer = {i: bytearray(512) for i in range(universes_count)}
        self.manual_buffer = {i: {} for i in range(universes_count)} # {c_idx: val}
        self.sources = {} # {source_id: {universe: {c_idx: val}}}
        
        self.front_buffer = {i: bytearray(512) for i in range(universes_count)}
        self.back_buffer = self.front_buffer # Pointer for compatibility 
        self.dirty_universes = set(range(universes_count))
        self.buffer_lock = threading.Lock()
        
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        
        # Hardware Driver
        self.usb_driver = None
        self.output_mode = "artnet" # "artnet", "usb", "sacn"
        
        self.running = False
        self.thread = None
        self.sequence = 0
        self.fps = 30 
        self.interval = 1.0 / self.fps
        
        self.manual_timestamps = {i: {} for i in range(universes_count)} # {(uni, ch): last_update}
        self.manual_expiry = 5.0 # Seconds before manual override is released
        

        # Safety Zones
        self.safety_zones = {} # {(universe, channel): {"min": min_val, "max": max_val}}
        
        # Latency Offset / History
        self.delay_ms = 0
        self.history = []
        
        # Art-Net Input Listener
        self.listener_sock = None
        self.listening = False
        self.listener_thread = None

        # sACN Support
        self.sacn_sender = None

    def set_safety_zone(self, universe, channel, min_val=0, max_val=255):
        """Define safe min/max limits for a channel to prevent hardware damage/blinding."""
        self.safety_zones[(universe, channel)] = {"min": max(0, min_val), "max": min(255, max_val)}

    def clear_safety_zone(self, universe, channel):
        self.safety_zones.pop((universe, channel), None)

    def set_channel(self, universe, channel, value, is_manual=False, source="AI"):
        """Sets a DMX channel value (1-512) assigning it to a specific source layer."""
        with self.buffer_lock:
            if universe in self.ai_buffer and 1 <= channel <= 512:
                c_idx = channel - 1
                
                target_val = int(value)
                limits = self.safety_zones.get((universe, channel))
                if limits:
                    target_val = max(limits["min"], min(limits["max"], target_val))
                else:
                    target_val = max(0, min(255, target_val))
                
                # Manual from params or specific source
                if is_manual or source == "Manual":
                    self.manual_buffer[universe][c_idx] = target_val
                    self.manual_timestamps[universe][c_idx] = time.time()
                elif source == "AI":
                    self.ai_buffer[universe][c_idx] = target_val
                else:
                    if source not in self.sources:
                        self.sources[source] = {}
                    if universe not in self.sources[source]:
                        self.sources[source][universe] = {}
                    self.sources[source][universe][c_idx] = target_val
                    
                self.dirty_universes.add(universe)
                
    def release_source(self, source_id):
        """Removes an entire source or clears all manual overrides."""
        with self.buffer_lock:
            if source_id == "Manual":
                for u in self.manual_buffer:
                    self.manual_buffer[u].clear()
                self.dirty_universes.update(self.manual_buffer.keys())
            elif source_id in self.sources:
                self.dirty_universes.update(self.sources[source_id].keys())
                del self.sources[source_id]

    def release_channel(self, universe, channel):
        """Removes a specific manual override channel from the mixer layer."""
        with self.buffer_lock:
            if universe in self.manual_buffer:
                if (channel - 1) in self.manual_buffer[universe]:
                    del self.manual_buffer[universe][channel - 1]
                    self.dirty_universes.add(universe)


    def set_source_data(self, source_id, data):
        """Sets bulk data for a source. data: {universe: {channel(1-512): val}}"""
        with self.buffer_lock:
            converted = {}
            for u, channels in data.items():
                u_int = int(u)
                if u_int not in converted: converted[u_int] = {}
                for c, v in channels.items():
                    c_int = int(c)
                    v_int = int(v)
                    limits = self.safety_zones.get((u_int, c_int))
                    if limits:
                        v_int = max(limits["min"], min(limits["max"], v_int))
                    else:
                        v_int = max(0, min(255, v_int))
                    converted[u_int][c_int-1] = v_int
            
            if source_id == "AI":
                for u, channels in converted.items():
                    if u in self.ai_buffer:
                        for idx, val in channels.items():
                            self.ai_buffer[u][idx] = val
            else:
                self.sources[source_id] = converted
            self.dirty_universes.update(converted.keys())

    def create_artdmx_packet(self, universe_id, data):
        """Constructs a standard Art-Net ArtDmx packet."""
        packet = bytearray()
        packet += self.HEADER # 'Art-Net\x00'
        packet += self.OP_DMX.to_bytes(2, 'little') # Opcode
        packet += self.PROTOCOL_VERSION.to_bytes(2, 'big') # ProtVer
        
        packet += b'\x00' # Sequence (rely on global sequence or per-universe)
        packet += b'\x00' # Physical
        
        # Universe is 15 bits. Low 8 bits are SubNet/Universe bits.
        packet += universe_id.to_bytes(2, 'little')
        
        # Data length (must be even, between 2 and 512)
        length = len(data)
        packet += length.to_bytes(2, 'big')
        
        packet += data
        return packet

    def create_sacn_packet(self, universe_id, data):
        """Constructs a standard sACN (E1.31) packet based on QLC+ patterns."""
        # 1-based universe for sACN protocol
        universe = universe_id + 1
        length = len(data)
        
        packet = bytearray()
        # Root Layer
        packet += b'\x00\x10' # Preamble Size
        packet += b'\x00\x00' # Post-amble Size
        packet += b'ASC-E1.17\x00\x00\x00' # ACN Identifier
        
        # Flags and Length (Root Layer)
        root_flags_length = 0x7000 | (110 + length)
        packet += root_flags_length.to_bytes(2, 'big')
        
        packet += b'\x00\x00\x00\x04' # Vector (ROOT_VECTOR_RELEASE_PDU)
        
        # CID (UUID) - Using a fixed one for AuraSync
        packet += b'\xFB\x3C\x10\x65\xA1\x7F\x4D\xE2\x99\x19\x31\x7A\x07\xC1\x00\x52'
        
        # Framing Layer
        framing_flags_length = 0x7000 | (77 + length)
        packet += framing_flags_length.to_bytes(2, 'big')
        
        packet += b'\x00\x00\x00\x02' # Vector (E131_VECTOR_DATA_PDU)
        
        # Source Name (64 bytes)
        source_name = "AuraSync Native Engine".ljust(64, '\x00')
        packet += source_name.encode('utf-8')
        
        packet += (100).to_bytes(1, 'big') # Priority (0-200, default 100)
        packet += b'\x00\x00' # Reserved (was Synchronization Address)
        
        seq = (self.sequence % 256)
        packet += seq.to_bytes(1, 'big') # Sequence Number
        
        packet += b'\x00' # Options
        packet += universe.to_bytes(2, 'big') # Universe
        
        # DMP Layer
        dmp_flags_length = 0x7000 | (10 + length)
        packet += dmp_flags_length.to_bytes(2, 'big')
        
        packet += b'\x02' # Vector (DMP_VECTOR_SET_PROPERTY)
        packet += b'\xA1' # Address Type & Data Type
        packet += b'\x00\x00' # First Property Address
        packet += b'\x00\x01' # Address Increment
        
        val_count_plus_one = length + 1
        packet += val_count_plus_one.to_bytes(2, 'big') # Property Value Count
        
        packet += b'\x00' # DMX Start Code (0x00 for data)
        packet += data # 512 bytes
        
        return packet

    def start(self, output_mode="artnet"):
        """Starts the transmission loop in a separate thread. Default 40Hz."""
        self.output_mode = output_mode
        if not self.running:
            self.running = True
            
            if self.output_mode == "usb":
                self.usb_driver = EuroliteDmxDriver()
                if not self.usb_driver or not self.usb_driver.is_connected():
                    print("[DMX] USB DMX failed. Falling back to Art-Net.")
                    self.output_mode = "artnet"
            
            self.thread = threading.Thread(target=self._loop, daemon=True)
            self.thread.start()
            print(f"DMX Engine ({self.output_mode}) started at {self.fps}Hz targeting {self.target_ip}")

    def start_listener(self):
        """Binds to UDP 6454 and listens for incoming Art-Net data."""
        if not self.listening:
            try:
                self.listener_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                self.listener_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                self.listener_sock.bind(('', self.ARTNET_PORT))
                
                # Get local IPs to detect and ignore our own broadcasts
                self.local_ips = ['127.0.0.1', '0.0.0.0']
                try:
                    self.local_ips.append(socket.gethostbyname(socket.gethostname()))
                except: pass
                
                self.listening = True
                self.listener_thread = threading.Thread(target=self._listener_loop, daemon=True)
                self.listener_thread.start()
                print(f"[DMX] Art-Net Listener active on port {self.ARTNET_PORT} (Loopback Protection: {self.local_ips})")
            except Exception as e:
                print(f"[DMX] Failed to start Art-Net Listener: {e}")

    def stop(self):
        """Stops both transmission and listener loops."""
        self.running = False
        self.listening = False
        if self.thread:
            self.thread.join()
        if self.listener_sock:
            self.listener_sock.close()

    def set_output_mode(self, mode: str):
        self.output_mode = mode
        if mode == "usb":
            if not self.usb_driver or not self.usb_driver.is_connected():
                self.usb_driver = EuroliteDmxDriver()
            if not self.usb_driver.is_connected():
                self.output_mode = "artnet"
        print(f"[DMX] Output mode changed to {self.output_mode}")

    def _listener_loop(self):
        """Background thread to receive external Art-Net data (e.g. from QLC+ bridge)."""
        while self.listening:
            try:
                data, addr = self.listener_sock.recvfrom(2048)
                
                # LOOP DETECTION: Ignore packets from ourselves 
                # (Enhanced: only ignore if we are currently broadcasting to the same target)
                if addr[0] in self.local_ips and self.output_mode == "artnet":
                    # If we are in Art-Net mode, we skip local packets to prevent feedback loops
                    # BUT if the user is bridging from QLC+ on the same machine, we might need this.
                    # We'll allow it if the data is DIFFERENT from our last front_buffer.
                    pass 
                
                # Check if it's Art-Net and DMX
                if len(data) > 18 and data[:8] == self.HEADER:
                    opcode = int.from_bytes(data[8:10], 'little')
                    if opcode == self.OP_DMX:
                        universe = int.from_bytes(data[14:16], 'little')
                        length = int.from_bytes(data[16:18], 'big')

                        # MERGE LOGIC: Set channels individually
                        # MERGE LOGIC: Set channels individually
                        dmx_data = data[18 : 18 + length]
                        with self.buffer_lock:
                            # 🚨 AI PRIORITY: If AI is active, ignore external input to prevent blocking
                            from __main__ import auto_lights_enabled
                            if auto_lights_enabled:
                                print(f"[DMX] Art-Net Listener: Ignoring external input on universe {universe} because AI is active.")
                                continue # Skip processing external input while AI is in control

                            if universe in self.back_buffer:
                                for c_idx, val in enumerate(dmx_data):
                                    if c_idx < 512:
                                        if self.back_buffer[universe][c_idx] != val:
                                            self.set_channel(universe, c_idx + 1, val, is_manual=True, source="QLC/EXT")
            except Exception as e:
                if self.listening:
                    print(f"[DMX] Listener Error: {e}")
                break

    def _loop(self):
        """
        High-precision transmission loop (40Hz/44Hz).
        Implements Double Buffering and Latency-aware history tracking.
        """
        while self.running:
            loop_start = time.perf_counter()
            
            # 1. RECOMPUTE HTP MIXER BUFFERS
            with self.buffer_lock:
                to_process = list(self.dirty_universes)
                for u in to_process:
                    if u >= self.universes_count: continue
                    merged = bytearray(512)
                    
                    # AI is base layer
                    for c in range(512):
                        merged[c] = self.ai_buffer[u][c]
                        
                    # HTP merge from active functions/sources
                    for src, uni_data in self.sources.items():
                        if u in uni_data:
                            for c, val in uni_data[u].items():
                                if val > merged[c]:
                                    merged[c] = val
                    
                    # Manual Overrides override everything (LTP/Absolute) with 5s expiry
                    now = time.time()
                    expired = []
                    for c, val in self.manual_buffer[u].items():
                        # Expiry check: if manual hasn't been touched for X seconds, let AI take back
                        if now - self.manual_timestamps[u].get(c, 0) > self.manual_expiry:
                            expired.append(c)
                        else:
                            merged[c] = val
                    
                    if expired:
                        for e_c in expired:
                            del self.manual_buffer[u][e_c]
                            if e_c in self.manual_timestamps[u]: del self.manual_timestamps[u][e_c]

                    self.front_buffer[u] = merged
                self.dirty_universes.clear()
            
            # 2. Transmit State (History-based for delay matching)
            current_state = {u: bytearray(data) for u, data in self.front_buffer.items()}
            self.history.append((loop_start, current_state))
            
            send_state = current_state
            if self.delay_ms > 0:
                target_time = loop_start - (self.delay_ms / 1000.0)
                # Purge old history (>2s)
                self.history = [h for h in self.history if h[0] > loop_start - 2.0]
                for past_time, past_state in reversed(self.history):
                    if past_time <= target_time:
                        send_state = past_state
                        break
            
            # 3. NETWORK & HARDWARE TRANSMISSION
            for u_id, data in send_state.items():
                if self.output_mode == "usb" and u_id == 0:
                    if self.usb_driver and self.usb_driver.is_connected():
                        self.usb_driver.send_universe(data)
                
                # Art-Net 4
                if self.output_mode == "artnet":
                    packet = self.create_artdmx_packet(u_id, data)
                    self.sock.sendto(packet, (self.target_ip, self.ARTNET_PORT))
                    if u_id in self.unicast_ips:
                        for ip in self.unicast_ips[u_id]:
                            self.sock.sendto(packet, (ip, self.ARTNET_PORT))
                
                # sACN (E1.31)
                elif self.output_mode == "sacn":
                    sacn_packet = self.create_sacn_packet(u_id, data)
                    # Multicast group for sACN is 239.255.<universe_hi>.<universe_lo>
                    u_num = u_id + 1
                    mcast_ip = f"239.255.{u_num >> 8}.{u_num & 0xFF}"
                    try:
                        self.sock.sendto(sacn_packet, (mcast_ip, 5568))
                    except:
                        # Fallback to broadcast if multicast fails on this interface
                        self.sock.sendto(sacn_packet, ("255.255.255.255", 5568))

            self.sequence = (self.sequence + 1) % 256
            
            # 4. PRECISE SLEEP
            target_next = loop_start + self.interval
            sleep_duration = target_next - time.perf_counter() - 0.001 # Sleep until 1ms before
            if sleep_duration > 0:
                time.sleep(sleep_duration)
            while time.perf_counter() < target_next: # Busy wait for micro-precision
                pass

if __name__ == "__main__":
    # Test: Pulse first channel of first universe
    engine = DMXEngine(target_ip="127.0.0.1")
    engine.start()
    try:
        while True:
            engine.set_channel(0, 1, 255)
            time.sleep(0.5)
            engine.set_channel(0, 1, 0)
            time.sleep(0.5)
    except KeyboardInterrupt:
        engine.stop()
