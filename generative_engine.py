import math
import time
import random

class LFO:
    def __init__(self, shape="sine", frequency=1.0, amplitude=1.0, offset=0.0, phase=0.0):
        self.shape = shape
        self.frequency = frequency # Hz
        self.amplitude = amplitude # 0.0 to 1.0
        self.offset = offset       # 0.0 to 1.0
        self.phase = phase         # 0.0 to 2*pi
        self.last_time = time.time()
        self.current_phase = phase

    def update(self, delta_time):
        self.current_phase += 2 * math.pi * self.frequency * delta_time
        if self.current_phase > 2 * math.pi:
            self.current_phase -= 2 * math.pi
        
        return self.get_value()

    def get_value(self):
        if self.shape == "sine":
            val = math.sin(self.current_phase)
        elif self.shape == "saw":
            val = (self.current_phase / (2 * math.pi)) * 2 - 1
        elif self.shape == "triangle":
            val = abs((self.current_phase / (2 * math.pi)) * 4 - 2) - 1
        elif self.shape == "square":
            val = 1.0 if self.current_phase < math.pi else -1.0
        elif self.shape == "random":
            val = random.uniform(-1, 1)
        else:
            val = 0
            
        # Map from [-1, 1] to [0, 1] and apply amplitude/offset
        normalized = (val + 1) / 2
        return max(0.0, min(1.0, normalized * self.amplitude + self.offset))

class LissajousLFO:
    """Special LFO for dual-axis movements (Pan/Tilt)."""
    def __init__(self, x_freq=1.0, y_freq=1.0, x_amp=1.0, y_amp=1.0, phase_offset=math.pi/2):
        self.x_freq = x_freq
        self.y_freq = y_freq
        self.x_amp = x_amp
        self.y_amp = y_amp
        self.phase_offset = phase_offset
        self.time_acc = 0.0

    def update(self, dt):
        self.time_acc += dt
        x = math.sin(2 * math.pi * self.x_freq * self.time_acc) * self.x_amp
        y = math.sin(2 * math.pi * self.y_freq * self.time_acc + self.phase_offset) * self.y_amp
        
        # Map from [-1, 1] to [0, 1]
        return (x + 1) / 2, (y + 1) / 2

class BeatSyncLFO(LFO):
    """LFO that synchronizes its frequency with the current BPM."""
    def __init__(self, multiplier=1.0, **kwargs):
        super().__init__(**kwargs)
        self.multiplier = multiplier # 1.0 = 1 beat, 0.25 = 1/4 note, etc.

    def update_bpm(self, bpm):
        if bpm > 0:
            # frequency = beats per second / multiplier
            self.frequency = (bpm / 60.0) / self.multiplier

class TargetGenerator:
    """Calculates Pan/Tilt values to point a light at a 3D target (X,Y,Z)."""
    def __init__(self, fix_pos, pan_range=540, tilt_range=270, inverted_pan=False, inverted_tilt=False):
        self.fix_pos = fix_pos # (x, y, z)
        self.pan_range = pan_range # degrees
        self.tilt_range = tilt_range # degrees
        self.inverted_pan = inverted_pan
        self.inverted_tilt = inverted_tilt

    def calculate(self, target_pos):
        """Returns (pan_norm, tilt_norm) where 0.0 to 1.0 represents full range."""
        dx = target_pos[0] - self.fix_pos[0]
        dy = target_pos[1] - self.fix_pos[1]
        dz = target_pos[2] - self.fix_pos[2]

        # Horizontal angle (Pan)
        # Assuming y is up, or z is up? Let's assume QLC+ Monitor: X is horizontal, Y is vertical, Z is depth.
        # Actually in QLC+ 2D monitor X/Y are floor plan. Z is height.
        # Let's use: X, Y (floor-plan), Z (height)
        pan_rad = math.atan2(dx, dy)
        pan_deg = math.degrees(pan_rad)
        
        # Vertical angle (Tilt)
        dist_field = math.sqrt(dx**2 + dy**2)
        tilt_rad = math.atan2(dz, dist_field)
        tilt_deg = math.degrees(tilt_rad)

        # Map to [0, 1] range based on hardware limits
        # Note: Professional lights usually centered (Pan 0 deg = 50% DMX)
        pan_norm = (pan_deg / self.pan_range) + 0.5
        tilt_norm = (tilt_deg / self.tilt_range) + 0.5
        
        if self.inverted_pan: pan_norm = 1.0 - pan_norm
        if self.inverted_tilt: tilt_norm = 1.0 - tilt_norm

        return max(0.0, min(1.0, pan_norm)), max(0.0, min(1.0, tilt_norm))

class ChainedLFO:
    """Combines multiple LFOs using a specified operation (add, multiply, max, min)."""
    def __init__(self, lfos, operation="add"):
        self.lfos = lfos # List of LFO objects
        self.operation = operation

    def update(self, dt):
        values = [lfo.update(dt) for lfo in self.lfos]
        if not values: return 0.0
        
        if self.operation == "add":
            return min(1.0, sum(values))
        elif self.operation == "multiply":
            res = 1.0
            for v in values: res *= v
            return res
        elif self.operation == "max":
            return max(values)
        elif self.operation == "min":
            return min(values)
        return values[0]

class CubicBezier:
    """Utility to calculate points on a cubic bezier curve."""
    @staticmethod
    def calculate(t, p0, p1, p2, p3):
        """t in [0, 1]. Points are tuples (x, y, z) or (x, y)."""
        res = []
        for i in range(len(p0)):
            val = (1-t)**3 * p0[i] + \
                  3 * (1-t)**2 * t * p1[i] + \
                  3 * (1-t) * t**2 * p2[i] + \
                  t**3 * p3[i]
            res.append(val)
        return tuple(res)

class BezierPathMovement:
    """Generates Pan/Tilt values by following a multi-segment Bezier path."""
    def __init__(self, points, duration=4.0, loop=True):
        self.points = points # List of points (x, y, z)
        # We need 4 points per segment (P0, P1, P2, P3). 
        # For a smooth sequence: [P0, CP1, CP2, P1, CP3, CP4, P2...]
        self.duration = duration
        self.loop = loop
        self.time_acc = 0.0
        self.generator = TargetGenerator((0, 0, 0)) # Position relative to path

    def update(self, dt, fix_pos):
        self.time_acc += dt
        if self.loop:
            self.time_acc %= self.duration
        else:
            self.time_acc = min(self.time_acc, self.duration)

        t_total = self.time_acc / self.duration
        
        # Determine segment
        num_segments = (len(self.points) - 1) // 3
        if num_segments < 1: return 0.5, 0.5
        
        segment_t_full = t_total * num_segments
        segment_idx = min(num_segments - 1, int(segment_t_full))
        t_segment = segment_t_full - segment_idx
        
        p_idx = segment_idx * 3
        p0 = self.points[p_idx]
        p1 = self.points[p_idx + 1]
        p2 = self.points[p_idx + 2]
        p3 = self.points[p_idx + 3]
        
        target_pos = CubicBezier.calculate(t_segment, p0, p1, p2, p3)
        
        # Calculate P/T using TargetGenerator logic
        self.generator.fix_pos = fix_pos
        return self.generator.calculate(target_pos)

class GenerativeEngine:
    def __init__(self, dmx_engine):
        self.dmx_engine = dmx_engine
        self.active_items = {} # { "id": { "type": "lfo/path/target", "obj": object, "target": (uni, chs...) } }
        self.last_update = time.time()
        self.current_bpm = 120.0

    def add_lfo(self, item_id, shape, frequency, amplitude, offset, universe, channel, multiplier=None):
        if multiplier:
            lfo = BeatSyncLFO(multiplier=multiplier, shape=shape, amplitude=amplitude, offset=offset)
            lfo.update_bpm(self.current_bpm)
        else:
            lfo = LFO(shape, frequency, amplitude, offset)
            
        self.active_items[item_id] = {
            "type": "lfo",
            "obj": lfo,
            "target": (universe, channel)
        }

    def add_chained_lfo(self, item_id, configs, operation, universe, channel):
        """configs: list of {shape, frequency, amplitude, offset, multiplier}"""
        lfos = []
        for cfg in configs:
            if cfg.get("multiplier"):
                lfo = BeatSyncLFO(multiplier=cfg["multiplier"], shape=cfg["shape"], 
                                 amplitude=cfg["amplitude"], offset=cfg["offset"])
                lfo.update_bpm(self.current_bpm)
            else:
                lfo = LFO(cfg["shape"], cfg["frequency"], cfg["amplitude"], cfg["offset"])
            lfos.append(lfo)
            
        self.active_items[item_id] = {
            "type": "lfo",
            "obj": ChainedLFO(lfos, operation),
            "target": (universe, channel)
        }

    def add_bezier_path(self, item_id, points, duration, universe, pan_ch, tilt_ch, fix_pos=(0,0,0), loop=True):
        self.active_items[item_id] = {
            "type": "path",
            "obj": BezierPathMovement(points, duration, loop),
            "fix_pos": fix_pos,
            "target": (universe, pan_ch, tilt_ch)
        }

    def add_target_tracker(self, item_id, fix_pos, universe, pan_ch, tilt_ch, target_pos=(0, 0, 0)):
        self.active_items[item_id] = {
            "type": "target",
            "obj": TargetGenerator(fix_pos),
            "target_pos": target_pos,
            "target": (universe, pan_ch, tilt_ch)
        }

    def remove_item(self, item_id):
        self.active_items.pop(item_id, None)

    def update_bpm(self, bpm):
        self.current_bpm = bpm
        for data in self.active_items.values():
            if data["type"] == "lfo":
                obj = data["obj"]
                if isinstance(obj, ChainedLFO):
                    for l in obj.lfos:
                        if isinstance(l, BeatSyncLFO): l.update_bpm(bpm)
                elif isinstance(obj, BeatSyncLFO):
                    obj.update_bpm(bpm)

    def update(self):
        now = time.time()
        dt = now - self.last_update
        self.last_update = now

        for item_id, data in self.active_items.items():
            t = data["type"]
            obj = data["obj"]
            
            if t == "lfo":
                val = obj.update(dt)
                u, c = data["target"]
                self.dmx_engine.set_channel(u, c, int(val * 255))
            elif t == "path":
                pan, tilt = obj.update(dt, data["fix_pos"])
                u, p_c, t_c = data["target"]
                self.dmx_engine.set_channel(u, p_c, int(pan * 255))
                self.dmx_engine.set_channel(u, t_c, int(tilt * 255))
            elif t == "target":
                pan, tilt = obj.calculate(data["target_pos"])
                u, p_c, t_c = data["target"]
                self.dmx_engine.set_channel(u, p_c, int(pan * 255))
                self.dmx_engine.set_channel(u, t_c, int(tilt * 255))

    def get_state(self):
        state = {"items": {}}
        for item_id, data in self.active_items.items():
            state["items"][item_id] = {
                "type": data["type"],
                "target": data["target"]
            }
        return state
