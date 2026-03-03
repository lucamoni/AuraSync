import numpy as np
import time
import math

class RGBMatrixEngine:
    def __init__(self, dmx):
        self.dmx = dmx
        self.matrices = {} # matrix_id -> {group_data, pattern, options}
        self.running = False
        
    def add_matrix(self, matrix_id, group_data, pattern="plasma", options=None):
        self.matrices[matrix_id] = {
            "group": group_data,
            "pattern": pattern,
            "options": options or {},
            "start_time": time.time()
        }
        self.running = True

    def remove_matrix(self, matrix_id):
        if matrix_id in self.matrices:
            del self.matrices[matrix_id]
        if not self.matrices:
            self.running = False

    def update(self, fixtures_map):
        """Called by DMX loop to update LED grids."""
        if not self.running: return

        t = time.time()
        for mid, m in self.matrices.items():
            pattern = m["pattern"]
            group = m["group"]
            opts = m["options"]
            
            # Generate patterns
            if pattern == "plasma":
                self._update_plasma(t, group, fixtures_map)
            elif pattern == "spectrum":
                # Audio driven pattern (needs analyzer access or passed data)
                pass 
            elif pattern == "color_fade":
                self._update_color_fade(t, group, fixtures_map, opts)

    def _update_plasma(self, t, group, fixtures_map):
        w, h = group["width"], group["height"]
        scale = 0.5
        speed = 2.0
        
        for head in group["heads"]:
            x, y = head["x"], head["y"]
            fix_id = head["fixture"]
            
            # Plasma math
            v = math.sin(x * scale + t * speed)
            v += math.sin((y * scale + t * speed) * 0.5)
            v += math.sin((x * scale + y * scale + t * speed) * 0.5)
            cx = x * scale + 0.5 * math.sin(t * speed / 5.0)
            cy = y * scale + 0.5 * math.cos(t * speed / 3.0)
            v += math.sin(math.sqrt(cx*cx + cy*cy + 1.0) + t * speed)
            v = v / 2.0 # Normalize roughly

            # Map to RGB
            r = int(127 * (1.0 + math.sin(v * math.pi)))
            g = int(127 * (1.0 + math.cos(v * math.pi)))
            b = int(127 * (1.0 + math.sin(v * math.pi + 2.0 * math.pi / 3.0)))
            
            self._apply_rgb(fix_id, r, g, b, fixtures_map)

    def _update_color_fade(self, t, group, fixtures_map, opts):
        color = opts.get("color", [255, 0, 255])
        speed = opts.get("speed", 1.0)
        phase = (math.sin(t * speed) + 1.0) / 2.0
        
        r, g, b = [int(c * phase) for c in color]
        
        for head in group["heads"]:
            self._apply_rgb(head["fixture"], r, g, b, fixtures_map)

    def _apply_rgb(self, fixture_id, r, g, b, fixtures_map):
        # Resolve fixture by ID
        fixture = fixtures_map.get(fixture_id)
        if not fixture: return
        
        uni = fixture.get("universe", 0)
        base = fixture.get("address", 1)
        channels = fixture.get("channel_details", [])
        
        # Simple heuristic for RGB mapping
        for i, ch in enumerate(channels):
            name = ch.get("name", "").lower()
            if "red" in name: self.dmx.set_channel(uni, base + i, r)
            elif "green" in name: self.dmx.set_channel(uni, base + i, g)
            elif "blue" in name: self.dmx.set_channel(uni, base + i, b)
            elif "dim" in name or "intens" in name: self.dmx.set_channel(uni, base + i, 255)
