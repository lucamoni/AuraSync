import time
import threading
import json
import os
import math

class FunctionManager:
    """Manages Scenes, Chasers, and EFX engines for AuraSync Pro."""
    def __init__(self, dmx_engine, functions_path="functions.json"):
        self.dmx = dmx_engine
        self.functions_path = functions_path
        self.functions = self._load_functions()
        self.active_functions = {} # {function_id: thread_object}
        self.running = True

    def _load_functions(self):
        if os.path.exists(self.functions_path):
            with open(self.functions_path, 'r') as f:
                return json.load(f)
        return {"scenes": {}, "chasers": {}, "efx": {}, "collections": {}}

    def _save_functions(self):
        with open(self.functions_path, 'w') as f:
            json.dump(self.functions, f, indent=2)

    # --- SCENES ---
    def save_scene(self, scene_id, name, dmx_data):
        """dmx_data: {universe: {channel: value}}"""
        self.functions["scenes"][scene_id] = {
            "name": name,
            "data": dmx_data
        }
        self._save_functions()

    def run_scene(self, scene_id, fade_time=0):
        if scene_id in self.functions["scenes"]:
            scene = self.functions["scenes"][scene_id]
            self.dmx.set_source_data(f"Scene_{scene_id}", scene["data"])
            self.active_functions[scene_id] = True # Mark active without a thread

    # --- CHASERS ---
    def run_chaser(self, chaser_id):
        if chaser_id in self.active_functions:
            return # Already running
            
        if chaser_id in self.functions["chasers"]:
            thread = threading.Thread(target=self._chaser_loop, args=(chaser_id,), daemon=True)
            self.active_functions[chaser_id] = thread
            thread.start()

    def _chaser_loop(self, chaser_id):
        chaser = self.functions["chasers"][chaser_id]
        steps = chaser.get("steps", [])
        
        while chaser_id in self.active_functions and self.running:
            for step in steps:
                scene_id = step["scene_id"]
                hold = step.get("hold", 1000) / 1000.0
                fade = step.get("fade", 0) / 1000.0
                
                # Set the Chaser's source data to the current step's scene
                if scene_id in self.functions["scenes"]:
                    scene_data = self.functions["scenes"][scene_id]["data"]
                    self.dmx.set_source_data(f"Chaser_{chaser_id}", scene_data)
                
                time.sleep(hold)
                
                if chaser_id not in self.active_functions:
                    break

    def stop_function(self, function_id):
        self.active_functions.pop(function_id, None)
        self.dmx.release_source(f"Scene_{function_id}")
        self.dmx.release_source(f"Chaser_{function_id}")
        self.dmx.release_source(f"EFX_{function_id}")

    # --- EFX Engine ---
    def run_efx(self, efx_id):
        if efx_id in self.active_functions:
            return
        if efx_id in self.functions["efx"]:
            thread = threading.Thread(target=self._efx_loop, args=(efx_id,), daemon=True)
            self.active_functions[efx_id] = thread
            thread.start()

    def _efx_loop(self, efx_id):
        efx = self.functions["efx"][efx_id]
        fixtures = efx.get("fixtures", [])
        pattern = efx.get("pattern", "circle")
        speed = efx.get("speed", 1.0)
        width = efx.get("width", 50)
        height = efx.get("height", 50)
        
        t = 0
        while efx_id in self.active_functions and self.running:
            phase_offset = 0
            for f_id in fixtures:
                # Calculate movement based on pattern
                if pattern == "circle":
                    pan = 127 + math.cos(t + phase_offset) * width
                    tilt = 127 + math.sin(t + phase_offset) * height
                elif pattern == "eight":
                    pan = 127 + math.sin(t + phase_offset) * width
                    tilt = 127 + math.sin(2 * (t + phase_offset)) * height
                else: # sine
                    pan = 127 + math.sin(t + phase_offset) * width
                    tilt = 127
                
                # Apply to DMX (assuming standard P/T channels for demo)
                # In real use, we'd lookup fixture profile
                # self.dmx.set_channel(0, f_pan_channel, pan, is_manual=True)
                
                phase_offset += 0.5 # Spread fixtures
                
            t += 0.1 * speed
            time.sleep(0.05) # 20Hz update for EFX

    # --- GENERIC PERSISTENCE ---
    def save_function(self, func_data):
        """Saves any function (Scene, Chaser, EFX) based on its type."""
        fid = func_data.get("id")
        ftype = func_data.get("type", "scene")
        bucket = "scenes" if ftype == "scene" else "chasers" if ftype == "chaser" else "efx"
        
        if not fid:
            fid = str(int(time.time() * 1000))
            func_data["id"] = fid
            
        self.functions[bucket][fid] = func_data
        self._save_functions()
        return fid

    def delete_function(self, func_id):
        """Removes a function from any bucket."""
        for bucket in ["scenes", "chasers", "efx", "collections"]:
            if func_id in self.functions[bucket]:
                del self.functions[bucket][func_id]
                self._save_functions()
                return True
        return False

    # --- DMX DUMP ---
    def dump_current_state(self, scene_id, name):
        state = {}
        for u_id, data in self.dmx.back_buffer.items():
            state[u_id] = {i+1: val for i, val in enumerate(data) if val > 0}
        self.save_scene(scene_id, name, state)
        return scene_id
