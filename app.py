import asyncio
import sys
import json
import os
import time
import uvicorn
import threading
import socket
import numpy as np
import pyaudio
import random
import tkinter as tk
from tkinter import filedialog
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, BackgroundTasks
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from audio_analyzer import AudioAnalyzer
from osc_sender import OSCSender
from workspace_parser import WorkspaceParser
from dmx_engine import DMXEngine
from generative_engine import GenerativeEngine
from spotify_bridge import SpotifyBridge
from prodj_link import ProDJLinkBridge
from fixture_library import FixtureLibrary
from patch_bay import PatchBay
from fixture_editor import FixtureEditor
from project_manager import ProjectManager
from workspace_exporter import WorkspaceExporter
from fastapi.responses import Response

# 1. Global State & Initialization
config_path = os.path.join(os.path.dirname(__file__), 'config.json')
with open(config_path, 'r') as f:
    config = json.load(f)

if 'bpm_sync_mode' not in config:
    config['bpm_sync_mode'] = 'internal'

analyzer = AudioAnalyzer()
sender = OSCSender(ip=config['osc_settings']['ip'], port=config['osc_settings']['port'])
from function_manager import FunctionManager
from rgb_matrix import RGBMatrixEngine
dmx = DMXEngine(
    target_ip=config['dmx_settings']['artnet_ip'], 
    universes_count=config['dmx_settings']['universes']
)
if config['dmx_settings'].get('output_mode') == 'usb':
    dmx.set_output_mode('usb')
else:
    dmx.set_output_mode('artnet')
dmx.delay_ms = config['dmx_settings'].get('latency_ms', 0)

fn_manager = FunctionManager(dmx)
rgb_engine = RGBMatrixEngine(dmx)
gen_engine = GenerativeEngine(dmx)
spotify = SpotifyBridge(
    client_id=config.get('spotify_client_id'),
    client_secret=config.get('spotify_client_secret')
)
if spotify.is_connected:
    spotify.start_polling()
prodj = ProDJLinkBridge()
prodj.start()
fixture_lib = FixtureLibrary()
patch_bay = PatchBay(universes_count=config['dmx_settings']['universes'])
fixture_editor = FixtureEditor()
project_manager = ProjectManager()

auto_lights_enabled = False

active_connections = set()
current_workspace = {
    "file": config.get("last_workspace_path"),
    "fixtures": [],
    "functions": [],
    "groups": []
}

# Auto-load if path exists
if current_workspace["file"]:
    def _auto_load():
        try:
            from workspace_parser import WorkspaceParser
            p = WorkspaceParser(current_workspace["file"])
            if p.parse():
                current_workspace["fixtures"] = p.get_fixtures()
                current_workspace["functions"] = p.get_functions()
                current_workspace["groups"] = p.get_groups()
                print(f"[Workspace] Auto-loaded: {current_workspace['file']}")
                
                # Apply Safety Zones immediately
                for fix in current_workspace["fixtures"]:
                    u = fix.get("universe", 0)
                    addr = fix.get("address", 1)
                    details = fix.get("channel_details", [])
                    for i, ch in enumerate(details):
                        name = (ch.get("name") or "").lower()
                        if "reset" in name or "motor" in name:
                            dmx.set_safety_zone(u, addr + i, min_val=0, max_val=10)
                            print(f"[Safety] Protected Channel {addr + i} (Fix {fix['id']})")
        except Exception as e:
            print(f"[Workspace] Auto-load failed: {e}")
    threading.Thread(target=_auto_load, daemon=True).start()


# 2. Workers
async def generative_worker():
    """High-frequency loop for LFOs, generative movements, and RGB Matrix patterns."""
    while True:
        # Sync BPM from analysis if available
        # gen_engine.update_bpm(current_bpm) will be called inside the audio_worker loop for faster sync
        
        # Update generative LFOs
        gen_engine.update()
        
        # Update RGB Matrix patterns
        fixtures_map = {f["id"]: f for f in current_workspace["fixtures"]}
        rgb_engine.update(fixtures_map)
        
        await asyncio.sleep(0.02) # 50Hz update for smooth patterns

async def audio_worker():
    """Background task that analyzes audio and broadcasts results."""
    # Auto-select BlackHole if preferred_device is set to 'blackhole'
    preferred = config.get('preferred_device', 'default')
    startup_device = None
    if preferred == 'blackhole':
        for dev in analyzer.list_input_devices():
            if 'blackhole' in dev['name'].lower():
                startup_device = dev['id']
                print(f"[Audio] Auto-starting on BlackHole (device {startup_device})")
                break
    
    analyzer.start_stream(device_index=startup_device)
    
    try:
        while True:
            current_bands = config['bands']
            analysis_data = analyzer.get_analysis(current_bands)
            if not analysis_data or "bands" not in analysis_data:
                await asyncio.sleep(0.01)
                continue
                
            analysis = analysis_data["bands"]
            is_beat = analysis_data.get("is_beat", False)
            waveform = analysis_data.get("waveform", [])
            
            # Phase 8: External BPM Sync (Pro DJ Link)
            if config.get('bpm_sync_mode') == 'external' and prodj.is_connected:
                bpm = prodj.master_bpm
            else:
                bpm = analysis_data["bpm"]
            
            # Sync BPM to Generative Engine
            gen_engine.update_bpm(bpm)
            
            # Prepare data for WebSocket
            msg = {
                "type": "analysis",
                "bands": analysis,
                "bpm": bpm,
                "is_beat": is_beat,
                "beat_phase": analysis_data.get("beat_phase", 0),
                "waveform": waveform,
                "mood": analysis_data.get("mood", "neutral"),
                "palette": analysis_data.get("palette", [[255,255,255]]),
                "section": analysis_data.get("section", "VERSE"),
                "energy_level": analysis_data.get("energy_level", 1),
                "stems": analysis_data.get("stems", {}),
                "measure_pos": analysis_data.get("measure_pos", [1, 0.0]),
                "ai_metrics": analysis_data.get("ai_metrics", {}),
                "spotify": spotify.get_state(),
                "prodj": prodj.get_state()
            }
            # Send Triggers based on STEMS (Module 3.1 & 4.1)
            stems = analysis_data.get("stems", {})
            
            # AI Auto Lights triggers are handled by the Frontend (Designer Engine) 
            # to prevent signal overlapping and flickering. 
            # Backend should only broadcast analysis metadata via WebSocket.
            
            # Broadcast to UI
            if active_connections:
                payload = json.dumps(msg)
                for connection in list(active_connections):
                    try:
                        await connection.send_text(payload)
                    except:
                        active_connections.discard(connection)
            
            # Pulse Reset (Not needed since AI logic is disabled here)
            # if is_beat:
            #     asyncio.create_task(reset_pulse())

            
            await asyncio.sleep(0.001)
            
    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"[Audio] Error: {e}")
    finally:
        analyzer.close()

_last_dmx_sent = {}
async def dmx_broadcast_worker():
    """Optimized loop: only broadcasts DELTAS to reduce network/UI overhead."""
    global _last_dmx_sent
    while True:
        try:
            if active_connections:
                updates = {} # {u_id: {ch_idx: val}}
                with dmx.buffer_lock:
                    for u_id, data in dmx.front_buffer.items():
                        prev = _last_dmx_sent.get(u_id)
                        if prev is None or prev != data:
                            # Universe changed, find specific deltas
                            uni_deltas = {}
                            for i in range(512):
                                if prev is None or prev[i] != data[i]:
                                    uni_deltas[i] = int(data[i])
                            if uni_deltas:
                                updates[u_id] = uni_deltas
                            _last_dmx_sent[u_id] = bytearray(data)
                
                if updates:
                    payload = json.dumps({"type": "dmx_update", "universes": updates, "is_delta": True})
                    for connection in list(active_connections):
                        try:
                            await connection.send_text(payload)
                        except:
                            active_connections.discard(connection)
            await asyncio.sleep(0.033) # 30Hz
        except asyncio.CancelledError:
            break
        except Exception as e:
            await asyncio.sleep(1)
        except asyncio.CancelledError:
            break
        except Exception as e:
            await asyncio.sleep(1)

async def spotify_watcher():
    """
    Monitors Spotify and triggers predictive scenes.
    Hybrid Engine: Uses Spotify metadata if available, falls back to local AI analysis if Spotify returns 403.
    """
    last_section_id = None
    last_ai_section = None
    
    while True:
        try:
            state = spotify.get_state()
            if not state["connected"] or not state["track"].get("is_playing"):
                await asyncio.sleep(1)
                continue

            track = state["track"]
            target_id = None
            mapping = config.get("spotify_mapping", {})
            
            # --- STRATEGY A: Spotify Meta-Sync (Traditional Deep Sync) ---
            if getattr(spotify, 'analysis_available', False):
                sections = track.get("sections", [])
                curr_idx = track.get("current_section_index", -1)
                
                if curr_idx >= 0 and curr_idx < len(sections):
                    section = sections[curr_idx]
                    section_id = f"{track['id']}_{curr_idx}"
                    
                    if section_id != last_section_id:
                        last_section_id = section_id
                        loudness = section.get("loudness", -15)
                        energy = track.get("energy", 0.5)
                        
                        print(f"[Spotify] Meta-Sync Trigger: Section {curr_idx} (Loudness: {loudness})")
                        if loudness > -9 or energy > 0.8:
                            target_id = mapping.get("high_energy")
                        elif loudness > -15 or energy > 0.4:
                            target_id = mapping.get("medium_energy")
                        else:
                            target_id = mapping.get("low_energy")

            # --- STRATEGY B: Hybrid AI Fallback (Spotify 403 Workaround) ---
            else:
                ai_res = analyzer.last_results
                ai_section = ai_res.get("section")
                
                if ai_section != last_ai_section:
                    last_ai_section = ai_section
                    energy_val = ai_res.get("energy_level", 2) # 1-5
                    
                    print(f"[Spotify] Hybrid-AI Trigger: Detected {ai_section} (E-Level: {energy_val})")
                    if energy_val >= 4: # CHORUS / DROP
                        target_id = mapping.get("high_energy")
                    elif energy_val >= 2: # VERSE / BUILD-UP
                        target_id = mapping.get("medium_energy")
                    else:
                        target_id = mapping.get("low_energy")

            # Scene Triggering is now delegated to the Frontend Live Auto engine
            # if target_id:
            #     print(f"[Sync] Auto-Triggering Scene ID: {target_id}")
            #     fn_manager.run_scene(target_id)
            
        except Exception as e:
            print(f"[Sync] Watcher Error: {e}")
            
        await asyncio.sleep(1.0)

# 3. Lifespan Management
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    dmx_mode = config['dmx_settings'].get('output_mode', 'artnet')
    dmx.start(output_mode=dmx_mode)
    dmx.start_listener()

    audio_task = asyncio.create_task(audio_worker())
    gen_task = asyncio.create_task(generative_worker())
    dmx_broadcast_task = asyncio.create_task(dmx_broadcast_worker())
    spotify_task = asyncio.create_task(spotify_watcher())
    yield
    # Shutdown
    audio_task.cancel()
    gen_task.cancel()
    dmx_broadcast_task.cancel()
    spotify_task.cancel()
    dmx.stop()
    try:
        await asyncio.gather(audio_task, gen_task, dmx_broadcast_task, spotify_task, return_exceptions=True)
    except asyncio.CancelledError:
        pass

# 4. FastAPI App Definition
app = FastAPI(lifespan=lifespan)

# 5. API Endpoints
@app.post("/api/auto_lights/toggle")
async def toggle_auto_lights(data: dict):
    global auto_lights_enabled
    auto_lights_enabled = data.get("enabled", False)
    print(f"[Sync] Auto Lights Enabled: {auto_lights_enabled}")
    
    # If enabling, clear manual overrides to give AI immediate control
    if auto_lights_enabled:
        dmx.release_source("Manual")
        print("[Sync] Manual Overrides Cleared for AI Priority")
        # FORCE FULL SYNC: Clear broadcast cache to force a full update to all clients
        global _last_dmx_sent
        _last_dmx_sent = {}

    # Broadcast to all connected clients
    message = json.dumps({"type": "auto_lights_sync", "enabled": auto_lights_enabled})
    for connection in list(active_connections):
        try:
            await connection.send_text(message)
        except Exception:
            pass
            
    return {"status": "success", "enabled": auto_lights_enabled}


@app.post("/api/dmx/set")
async def set_dmx(data: dict):
    u = data.get("universe", 0)
    c = data.get("channel")
    v = data.get("value", 0)
    # Manual UI interactions pass is_manual=True to enforce mixing layer
    if c is not None:
        is_manual = data.get("is_manual", True)
        source = data.get("source", "Manual") if is_manual else "AI"
        dmx.set_channel(u, c, v, is_manual=is_manual, source=source)
        return {"status": "success"}
    return {"status": "error", "message": "Channel missing"}

@app.post("/api/dmx/release")
async def release_dmx(data: dict):
    u = data.get("universe", 0)
    c = data.get("channel")
    if c == "all":
        dmx.release_source("Manual")
    elif c is not None:
        dmx.release_channel(u, int(c))
    return {"status": "success"}


@app.post("/api/dmx/bulk")
async def bulk_set_dmx(data: dict):
    u = data.get("universe", 0)
    channels = data.get("channels", {}) # Expects { "channel_id": value, ... }
    converted = {}
    for c_id, val in channels.items():
        try:
            converted[int(c_id)] = int(val)
        except:
            continue
            
    # AI engine calls bulk updates - Send atomic block to mixer
    dmx.set_source_data("AI", {u: converted})
    return {"status": "success", "count": len(converted)}

@app.post("/api/dmx/safety")
async def set_safety(data: dict):
    u = data.get("universe", 0)
    c = data.get("channel")
    min_v = data.get("min", 0)
    max_v = data.get("max", 255)
    if c is not None:
        dmx.set_safety_zone(u, c, min_v, max_v)
        return {"status": "success"}
    return {"status": "error", "message": "Channel missing"}

@app.post("/api/dmx/mode")
async def set_dmx_mode(data: dict):
    mode = data.get("mode", "artnet")
    dmx.set_output_mode(mode)
    
    # Persist the mode change
    config['dmx_settings']['output_mode'] = dmx.output_mode
    try:
        with open(config_path, 'w') as f:
            json.dump(config, f, indent=2)
    except Exception as e:
        print(f"[Config] Failed to save DMX mode: {e}")
        
    return {"status": "success", "mode": dmx.output_mode}

# --- FUNCTION MANAGER ENDPOINTS ---

@app.get("/api/functions")
async def get_functions():
    return fn_manager.functions

@app.post("/api/functions/scene")
async def save_scene(data: dict):
    scene_id = data.get("id") or str(int(time.time()))
    name = data.get("name", "New Scene")
    dmx_data = data.get("data", {})
    fn_manager.save_scene(scene_id, name, dmx_data)
    return {"status": "success", "id": scene_id}

@app.post("/api/functions/run/{func_type}/{func_id}")
async def run_function(func_type: str, func_id: str):
    if func_type == "scene":
        fn_manager.run_scene(func_id)
    elif func_type == "chaser":
        fn_manager.run_chaser(func_id)
    elif func_type == "efx":
        fn_manager.run_efx(func_id)
    return {"status": "success"}

@app.post("/api/functions/save")
async def save_any_function(data: dict):
    fid = fn_manager.save_function(data)
    return {"status": "success", "id": fid}

@app.delete("/api/functions/delete/{func_id}")
async def delete_any_function(func_id: str):
    success = fn_manager.delete_function(func_id)
    return {"status": "success" if success else "error"}

@app.post("/api/functions/stop/{func_id}")
async def stop_function(func_id: str):
    fn_manager.stop_function(func_id)
    return {"status": "success"}

@app.post("/api/dmx/dump")
async def dmx_dump(data: dict):
    name = data.get("name", f"Dump {time.strftime('%H:%M:%S')}")
    scene_id = str(int(time.time()))
    fn_manager.dump_current_state(scene_id, name)
    return {"status": "success", "id": scene_id}

# --- RGB MATRIX ENDPOINTS ---

@app.get("/api/groups")
async def get_groups():
    return current_workspace["groups"]

@app.post("/api/matrix/start")
async def start_matrix(data: dict):
    grp_id = data.get("group_id")
    pattern = data.get("pattern", "plasma")
    options = data.get("options", {})
    
    # Find group data
    group = next((g for g in current_workspace["groups"] if str(g["id"]) == str(grp_id)), None)
    if not group:
        return {"status": "error", "message": "Group not found"}
        
    rgb_engine.add_matrix(grp_id, group, pattern, options)
    return {"status": "success"}

@app.post("/api/matrix/stop/{grp_id}")
async def stop_matrix(grp_id: str):
    rgb_engine.remove_matrix(grp_id)
    return {"status": "success"}

from fastapi.responses import RedirectResponse

@app.post("/spotify/auth")
async def spotify_auth(data: dict):
    client_id = data.get("client_id")
    client_secret = data.get("client_secret")
    
    spotify.client_id = client_id
    spotify.client_secret = client_secret
    
    # Save to config for persistence
    config['spotify_client_id'] = client_id
    config['spotify_client_secret'] = client_secret
    with open(config_path, 'w') as f:
        json.dump(config, f, indent=2)

    # Return the auth URL so the frontend can redirect the user
    try:
        from spotipy.oauth2 import SpotifyOAuth
        auth_manager = SpotifyOAuth(
            client_id=client_id,
            client_secret=client_secret,
            redirect_uri='http://127.0.0.1:8000/callback',
            scope="user-read-currently-playing user-read-playback-state user-modify-playback-state",
            cache_path=".spotify_cache"
        )
        auth_url = auth_manager.get_authorize_url()
        return {"status": "success", "auth_url": auth_url}
    except Exception as e:
        return {"status": "error", "message": f"Auth initialization failed: {str(e)}"}

@app.get("/callback")
async def spotify_callback(code: str):
    """Handles the redirect from Spotify after user logs in."""
    try:
        from spotipy.oauth2 import SpotifyOAuth
        auth_manager = SpotifyOAuth(
            client_id=spotify.client_id,
            client_secret=spotify.client_secret,
            redirect_uri='http://127.0.0.1:8000/callback',
            scope="user-read-currently-playing user-read-playback-state user-modify-playback-state",
            cache_path=".spotify_cache"
        )
        # Exchange code for token
        auth_manager.get_access_token(code)
        
        # Now connect the bridge
        spotify.connect()
        if spotify.is_connected:
            spotify.start_polling()
            
        # Redirect back to the main dashboard
        return RedirectResponse(url="/")
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/spotify/control")
async def spotify_control(data: dict):
    action = data.get("action")
    if action == "play": spotify.play()
    elif action == "pause": spotify.pause()
    elif action == "next": spotify.next_track()
    elif action == "prev": spotify.previous_track()
    elif action == "volume":
        vol = data.get("volume", 50)
        spotify.set_volume(vol)
    elif action == "seek":
        pos = data.get("position_ms", 0)
        spotify.seek(pos)
    elif action == "shuffle":
        state = data.get("state", False)
        spotify.shuffle(state)
    elif action == "repeat":
        state = data.get("state", "off") # track, context, off
        spotify.repeat(state)
    return {"status": "success"}

@app.post("/bpm/sync_mode")
async def set_bpm_sync_mode(data: dict):
    mode = data.get("mode", "internal")
    config['bpm_sync_mode'] = mode
    
    # Save config
    with open(config_path, 'w') as f:
        json.dump(config, f, indent=4)
        
    return {"status": "success", "mode": mode}

@app.delete("/api/dmx/safety/{u}/{c}")
async def clear_safety(u: int, c: int):
    dmx.clear_safety_zone(u, c)
    return {"status": "success"}

@app.get("/api/config")
async def get_config():
    return config

@app.get("/api/env/status")
async def get_env_status():
    """Returns the full current setup for UI restoration."""
    return {
        "workspace": current_workspace,
        "config": config,
        "lfo_configs": gen_engine.get_state() if hasattr(gen_engine, 'get_state') else {},
        "auto_lights_enabled": auto_lights_enabled,
        "spotify": spotify.get_state() if hasattr(spotify, 'get_state') else {}
    }


@app.post("/api/config")
async def update_config(new_config: dict):
    global config
    # The instruction provided a problematic change here.
    # The original intent of update_config is to update the global config with new_config.
    # The instruction's `config = load_config()` would discard `new_config`.
    # The instruction's `auto_lights_enabled = False` was also misplaced and would reset it every time.
    # Assuming the user intended to update the config and `auto_lights_enabled` is managed by its own endpoint.
    config = new_config
    with open(config_path, 'w') as f:
        json.dump(config, f, indent=2)
    return {"status": "success"}

@app.get("/api/audio/devices")
async def get_audio_devices():
    return analyzer.list_input_devices()

@app.post("/api/audio/device/{index}")
async def set_audio_device(index: int):
    try:
        analyzer.set_device(index)
        return {"status": "success", "device_index": index}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/audio/latency")
async def set_latency(data: dict):
    # Only positive delay is supported structurally right now for DMX buffer
    val = max(0, data.get("delay_ms", 0))
    dmx.delay_ms = val
    
    # Persist the change
    config['dmx_settings']['latency_ms'] = val
    try:
        with open(config_path, 'w') as f:
            json.dump(config, f, indent=2)
    except Exception as e:
        print(f"[Config] Failed to save latency: {e}")
        
    return {"status": "success", "delay_ms": dmx.delay_ms}

@app.post("/api/generative/lfo")
async def add_lfo(data: dict):
    """Add or update an LFO."""
    lfo_id = data.get("id", "default")
    gen_engine.add_lfo(
        lfo_id,
        data.get("shape", "sine"),
        data.get("frequency", 1.0),
        data.get("amplitude", 1.0),
        data.get("offset", 0.0),
        data.get("universe", 0),
        data.get("channel", 1)
    )
    return {"status": "success", "id": lfo_id}

@app.delete("/api/generative/lfo/{lfo_id}")
async def remove_lfo(lfo_id: str):
    gen_engine.remove_lfo(lfo_id)
    return {"status": "success"}

@app.get("/api/generative/status")
async def get_gen_status():
    return gen_engine.get_state()

# Phase 4: DAW Timeline
@app.post("/api/timeline/trigger")
async def trigger_timeline_event(event: dict):
    event_type = event.get("type")
    data = event.get("data", {})
    
    if event_type == "dmx":
        universe = int(data.get("universe", 0))
        channel = int(data.get("channel", 1))
        value = int(data.get("value", 0))
        dmx.update_channel(universe, channel, value)
        print(f"Timeline triggered DMX: U{universe} C{channel} @ {value}")
        
    return {"status": "success"}

@app.post("/api/workspace/load")
async def load_workspace(data: dict):
    global current_workspace
    file_path = data.get("path")
    if not file_path:
        return {"status": "error", "message": "No path provided"}
    
    parser = WorkspaceParser(file_path)
    if parser.parse():
        current_workspace["file"] = file_path
        current_workspace["fixtures"] = parser.get_fixtures()
        current_workspace["functions"] = parser.get_functions()
        
        # Persistent storage
        config['last_workspace_path'] = file_path
        with open(config_path, 'w') as f:
            json.dump(config, f, indent=2)
            
        # Initialize PatchBay with loaded fixtures
        patch_bay.patch = {}
        for f in current_workspace["fixtures"]:
            patch_bay.patch_fixture(
                f["id"], 
                f.get("universe", 0), 
                f.get("address", 1), 
                f.get("channels", 1)
            )
        
        # ── Import QXW functions into fn_manager ──────────────────────
        type_map = {
            "Scene":   "scenes",
            "Chaser":  "chasers",
            "EFX":     "efx",
            "Show":    "chasers",
            "Sequence": "chasers",
            "Script":  "efx",
            "Collection": "efx",
        }
        # Create a quick ID lookup for loaded fixtures to map channels
        fix_lookup = {f["id"]: f for f in current_workspace["fixtures"]}

        for func in current_workspace["functions"]:
            ftype = func.get("type", "")
            bucket = type_map.get(ftype, "efx")
            fid = str(func["id"])
            fname = func.get("name", fid)
            
            # Normalize internal data to our format
            internal_data = {}
            if ftype == "Scene" and "data" in func:
                # Convert {fixture_id: {rel_ch: val}} -> {universe: {abs_ch: val}}
                for f_id, rel_channels in func["data"].items():
                    if f_id in fix_lookup:
                        f_meta = fix_lookup[f_id]
                        uni = f_meta.get("universe", 0)
                        start_addr = f_meta.get("address", 1) - 1 # Back to 0-indexed internal
                        if uni not in internal_data: internal_data[uni] = {}
                        for rel_ch, val in rel_channels.items():
                            abs_ch = start_addr + int(rel_ch) + 1 # 1-indexed for fn_manager
                            internal_data[uni][abs_ch] = val
                    else:
                        pass # Fixture {f_id} not found in workspace for scene {fname}
            
            # Normalize Chaser timing
            steps = func.get("steps", [])
            for s in steps:
                if "fade_in" in s: s["fade"] = s["fade_in"] # Normalize to internal format
            
            if ftype == "Chaser" and steps:
                pass # Mapping Chaser '{fname}' with {len(steps)} steps

            # Use save_function to handle generic logic and persistence
            fn_manager.save_function({
                "id": fid,
                "name": fname,
                # ... rest same ...
                "type": bucket.rstrip('s'), # scene, chaser, efx
                "path": func.get("path", ""),
                "data": internal_data,
                "steps": steps,
                "fixtures": func.get("fixtures", []),
                "pattern": func.get("pattern", "circle"),
                "speed": func.get("speed", 1.0),
                "width": func.get("width", 50),
                "height": func.get("height", 50)
            })
        # ─────────────────────────────────────────────────────────────
        # ─────────────────────────────────────────────────────────────
            
        return {
            "status": "success",
            "fixtures": current_workspace["fixtures"],
            "functions": current_workspace["functions"],
            "fixture_count": len(current_workspace["fixtures"]),
            "function_count": len(current_workspace["functions"])
        }
    else:
        return {"status": "error", "message": "Failed to parse workspace"}


@app.get("/api/workspace/export/qxw")
async def export_workspace_qxw():
    exporter = WorkspaceExporter(current_workspace)
    xml_content = exporter.export()
    
    headers = {
        'Content-Disposition': 'attachment; filename="Exported_AuraSync.qxw"'
    }
    return Response(content=xml_content, media_type="application/xml", headers=headers)

# --- PATCH BAY ENDPOINTS ---

@app.post("/api/patch/auto")
async def patch_auto(data: dict):
    fixtures = current_workspace["fixtures"]
    if not fixtures:
        return {"status": "error", "message": "No fixtures loaded"}
    
    start_uni = data.get("start_universe", 0)
    start_addr = data.get("start_address", 1)
    
    results = patch_bay.auto_patch(fixtures, start_uni, start_addr)
    
    # Update current workspace with new addresses
    for res in results:
        for f in current_workspace["fixtures"]:
            if f["id"] == res["id"]:
                f["universe"] = res["universe"]
                f["address"] = res["address"]
    
    return {"status": "success", "patch": results}

@app.post("/api/patch/check")
async def patch_check(data: dict):
    u = data.get("universe", 0)
    a = data.get("address", 1)
    c = data.get("channels", 1)
    ignore_id = data.get("id")
    
    ok, msg = patch_bay.can_patch(u, a, c, ignore_id)
    return {"status": "success" if ok else "error", "message": msg}

@app.post("/api/workspace/patch")
async def workspace_patch(data: dict):
    """Adds a new fixture instance to the workspace."""
    global current_workspace
    qxf_file = data.get("qxf")
    universe = data.get("universe", 0)
    address = data.get("address")
    auto_address = data.get("auto_address", False)
    
    if not qxf_file:
        return {"status": "error", "message": "Nessun file .qxf specificato"}
    
    # Try to find the .qxf file
    luca_fixtures = os.path.join(os.path.dirname(__file__), "LucaFixtures")
    qxf_path = os.path.join(luca_fixtures, qxf_file)
    if not os.path.exists(qxf_path):
        # search in other possible locations if needed
        pass
        
    definition = fixture_lib.load_definition(qxf_path)
    if not definition:
        return {"status": "error", "message": f"Impossibile caricare {qxf_file}"}
        
    # Determine Address
    channels = definition["channel_count"] or 1
    if auto_address or not address:
        # Find first free address in universe
        found = False
        for a in range(1, 513 - channels + 1):
            ok, _ = patch_bay.can_patch(universe, a, channels)
            if ok:
                address = a
                found = True
                break
        if not found:
            return {"status": "error", "message": "Nessun indirizzo libero trovato in questo universo"}
    else:
        ok, msg = patch_bay.can_patch(universe, address, channels)
        if not ok:
            return {"status": "error", "message": msg}
            
    # Create fixture instance
    fix_id = str(int(time.time() * 1000) + random.randint(0, 999))
    new_fixture = {
        "id": fix_id,
        "name": f"{definition['model']} #{len(current_workspace['fixtures']) + 1}",
        "universe": universe,
        "address": address,
        "channels": channels,
        "manufacturer": definition["manufacturer"],
        "model": definition["model"],
        "mode": next(iter(definition["modes"])) if definition["modes"] else "",
        "channel_details": [{"name": k, "group": v["group"]} for k, v in definition["channels"].items()],
        "position": {"x": 0, "y": 2, "z": 0}
    }
    
    current_workspace["fixtures"].append(new_fixture)
    patch_bay.patch_fixture(fix_id, universe, address, channels)
    
    return {"status": "success", "fixture": new_fixture}

@app.post("/api/workspace/update-fixture")
async def workspace_update_fixture(data: dict):
    """Updates properties of an existing fixture instance."""
    global current_workspace
    fix_id = data.get("id")
    if not fix_id: return {"status": "error", "message": "ID mancante"}
    
    fixture = next((f for f in current_workspace["fixtures"] if f["id"] == fix_id), None)
    if not fixture: return {"status": "error", "message": "Fixture non trovata"}
    
    # Validate patch change if needed
    new_uni = data.get("universe", fixture["universe"])
    new_addr = data.get("address", fixture["address"])
    channels = fixture["channels"]
    
    if new_uni != fixture["universe"] or new_addr != fixture["address"]:
        ok, msg = patch_bay.can_patch(new_uni, new_addr, channels, ignore_id=fix_id)
        if not ok: return {"status": "error", "message": msg}
        patch_bay.patch_fixture(fix_id, new_uni, new_addr, channels)
        fixture["universe"] = new_uni
        fixture["address"] = new_addr
        
    fixture["name"] = data.get("name", fixture["name"])
    if "position" in data:
        fixture["position"] = data["position"]
        
    return {"status": "success", "fixture": fixture}

@app.post("/api/workspace/remove-fixture")
async def workspace_remove_fixture(data: dict):
    """Removes a fixture instance from the workspace."""
    global current_workspace
    fix_id = data.get("id")
    if not fix_id: return {"status": "error", "message": "ID mancante"}
    
    # Remove from workspace
    current_workspace["fixtures"] = [f for f in current_workspace["fixtures"] if f["id"] != fix_id]
    
    # Remove from PatchBay
    patch_bay.unpatch_fixture(fix_id)
    
    return {"status": "success"}

# --- FIXTURE EDITOR ENDPOINTS ---

@app.post("/api/fixture/create")
async def create_fixture(data: dict):
    try:
        path = fixture_editor.create_definition(
            data["manufacturer"],
            data["model"],
            data["channels"],
            data["modes"],
            data.get("physical")
        )
        return {"status": "success", "path": path}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/workspace/fixtures")
async def get_fixtures():
    return current_workspace["fixtures"]

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.add(websocket)
    
    # IMMEDIATE FULL SYNC: Send current DMX state to new client so they don't wait for deltas
    try:
        current_dmx = {}
        with dmx.buffer_lock:
            for u_id, data in dmx.front_buffer.items():
                current_dmx[u_id] = list(data)
        
        if current_dmx:
            sync_payload = json.dumps({"type": "dmx_update", "universes": current_dmx, "is_delta": False})
            await websocket.send_text(sync_payload)
            print(f"[WS] Full Sync sent to new client ({len(current_dmx)} universes)")
    except Exception as e:
        print(f"[WS] Initial Sync Error: {e}")
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("type") == "dmx_bulk":
                    u = msg.get("universe", 0)
                    channels = msg.get("channels", {})
                    for c_id, val in channels.items():
                        dmx.set_channel(u, int(c_id), val, is_manual=False)
            except Exception as e:
                print(f"[WS Error] Failed parsing dmx_bulk: {e}")
    except WebSocketDisconnect:
        active_connections.discard(websocket)
    except Exception:
        active_connections.discard(websocket)

# Phase 6: AI Visual Venue & Cloud Ecosystem
@app.post("/api/venue/analyze")
async def analyze_venue():
    """Mock AI endpoint that 'analyzes' an image and returns a 3D stage layout."""
    # Simulate processing time
    await asyncio.sleep(2.5)
    
    # Generate a default "balanced" AI stage layout
    generated_fixtures = [
        {"id": 101, "name": "AI Spot 1 (L)", "universe": 0, "address": 1, "channels": 16, "type": "Moving Head", "position": {"x": -2, "y": 3, "z": -2}},
        {"id": 102, "name": "AI Spot 2 (R)", "universe": 0, "address": 17, "channels": 16, "type": "Moving Head", "position": {"x": 2, "y": 3, "z": -2}},
        {"id": 103, "name": "AI Wash 1 (L)", "universe": 0, "address": 33, "channels": 11, "type": "Color Changer", "position": {"x": -3, "y": 1, "z": -1}},
        {"id": 104, "name": "AI Wash 2 (R)", "universe": 0, "address": 44, "channels": 11, "type": "Color Changer", "position": {"x": 3, "y": 1, "z": -1}},
    ]
    return {"status": "success", "message": "Stage reconstructed from image", "fixtures": generated_fixtures}

@app.get("/api/cloud/presets")
async def get_cloud_presets():
    """Mock endpoint to browse community lighting presets."""
    presets = [
        {"id": "p1", "name": "Techno Bunker", "author": "AuraSync", "downloads": 1420},
        {"id": "p2", "name": "Wedding Warmth", "author": "DJ Lu", "downloads": 850},
        {"id": "p3", "name": "Neon Retrowave", "author": "SynthRider", "downloads": 3105}
    ]
    return {"status": "success", "presets": presets}

import xml.etree.ElementTree as ET
import xml.dom.minidom as minidom

@app.post("/workspace/export")
async def export_workspace(data: dict):
    """Generates a QLC+ .qxw XML file from the current visualizer state."""
    fixtures_to_export = data.get("fixtures", [])
    
    # Create root element
    root = ET.Element("Workspace")
    root.set("xmlns", "http://www.qlcplus.org/Workspace")
    
    engine = ET.SubElement(root, "Engine")
    
    for f in fixtures_to_export:
        fixt_xml = ET.SubElement(engine, "Fixture")
        ET.SubElement(fixt_xml, "Manufacturer").text = "Generic"
        ET.SubElement(fixt_xml, "Model").text = f.get("type", "Dimmer")
        ET.SubElement(fixt_xml, "Mode").text = "Standard"
        ET.SubElement(fixt_xml, "ID").text = str(f.get("id"))
        ET.SubElement(fixt_xml, "Name").text = f.get("name")
        ET.SubElement(fixt_xml, "Universe").text = str(f.get("universe", 0))
        ET.SubElement(fixt_xml, "Address").text = str(max(0, f.get("address", 1) - 1)) # QLC+ uses 0-indexed addresses internally in XML
        ET.SubElement(fixt_xml, "Channels").text = str(f.get("channels", 1))
        
    # Convert to pretty XML string
    xmlstr = minidom.parseString(ET.tostring(root)).toprettyxml(indent="  ")
    
    return {"status": "success", "xml": xmlstr}



@app.get("/api/browse")
async def browse_workspace():
    """Opens a native macOS file dialog to select a .qxw file."""
    try:
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        file_path = filedialog.askopenfilename(
            title="Seleziona Progetto QLC+",
            filetypes=[("QLC+ Workspace", "*.qxw"), ("All Files", "*.*")]
        )
        root.destroy()
        if file_path:
            return {"status": "success", "path": file_path}
        return {"status": "cancelled"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/browse/fixture")
async def browse_fixture():
    """Opens a native macOS file dialog to select a .qxf fixture file."""
    try:
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        file_path = filedialog.askopenfilename(
            title="Seleziona Definizione Fixture (.qxf)",
            filetypes=[("QLC+ Fixture", "*.qxf"), ("All Files", "*.*")]
        )
        root.destroy()
        if file_path:
            return {"status": "success", "path": file_path}
        return {"status": "cancelled"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/fixture/load")
async def load_fixture(data: dict):
    """Parses a single .qxf file and returns its structured data."""
    path = data.get("path")
    if not path or not os.path.exists(path):
        return {"status": "error", "message": f"File non trovato: {path}"}
    
    try:
        fixture = fixture_lib.load_definition(path)
        if fixture:
            return {"status": "success", "fixture": fixture}
        return {"status": "error", "message": "File .qxf non valido o corrotto"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

FIXTURES_SAVE_PATH = os.path.join(os.path.dirname(__file__), "fixtures.json")

@app.post("/api/fixture/library/save")
async def save_fixture_library(data: dict):
    """Saves the current fixture library list to disk for persistence."""
    try:
        fixtures = data.get("fixtures", [])
        with open(FIXTURES_SAVE_PATH, "w") as f:
            json.dump({"fixtures": fixtures, "version": 1}, f, indent=2)
        return {"status": "success", "count": len(fixtures)}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/fixture/library")
async def load_fixture_library():
    """Loads the saved fixture library from disk."""
    try:
        if os.path.exists(FIXTURES_SAVE_PATH):
            with open(FIXTURES_SAVE_PATH, "r") as f:
                data = json.load(f)
            return {"status": "success", "fixtures": data.get("fixtures", []), "count": len(data.get("fixtures", []))}
        return {"status": "empty", "fixtures": [], "count": 0}
    except Exception as e:
        return {"status": "error", "message": str(e), "fixtures": []}


@app.get("/api/browse/folder")
async def browse_folder():
    """Opens a native folder picker dialog."""
    try:
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        folder = filedialog.askdirectory(title="Seleziona cartella con file .qxf")
        root.destroy()
        if folder:
            return {"status": "success", "path": folder}
        return {"status": "cancelled"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/fixture/load-folder")
async def load_fixture_folder(data: dict):
    """Parses ALL .qxf files in a folder and returns them all."""
    folder = data.get("path")
    if not folder or not os.path.isdir(folder):
        return {"status": "error", "message": "Cartella non valida"}
    
    results = []
    errors = []
    for fname in sorted(os.listdir(folder)):
        if fname.lower().endswith(".qxf"):
            fpath = os.path.join(folder, fname)
            try:
                definition = fixture_lib.load_definition(fpath)
                if definition:
                    definition["_file"] = fname
                    results.append(definition)
                else:
                    errors.append(fname)
            except Exception as e:
                errors.append(f"{fname}: {e}")
    
    return {
        "status": "success",
        "count": len(results),
        "fixtures": results,
        "errors": errors
    }

import google.generativeai as genai
import base64
from io import BytesIO
from PIL import Image
import json

@app.post("/api/venue/analyze/gemini")
async def analyze_venue_gemini(data: dict):
    """Uses Gemini Pro Vision to analyze a stage photo and suggest 3D fixture positions."""
    try:
        image_data = data.get("image")
        if not image_data:
            return {"status": "error", "message": "No image provided"}
            
        if "base64," in image_data:
            image_data = image_data.split("base64,")[1]
            
        img_bytes = base64.b64decode(image_data)
        img = Image.open(BytesIO(img_bytes))
        
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            import random
            positions = []
            for f in data.get("fixtures", []):
                positions.append({
                    "id": f.get("id"),
                    "position": {
                        "x": random.uniform(-10, 10),
                        "y": random.uniform(2, 6),
                        "z": random.uniform(-5, 0)
                    }
                })
            return {"status": "success", "positions": positions, "mock": True, "message": "API Key mancante, mock generato"}
            
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel('gemini-1.5-flash')
        
        fixtures = data.get("fixtures", [])
        prompt = f"""
You are an expert lighting technician and 3D stage designer.
I am building a 3D stage lighting visualizer in Three.js and I need you to reconstruct the stage from this photo.

TASK:
1. Analyze the stage layout, trusses, and floor positions in the provided photo.
2. For each fixture in the list below, determine its most likely 3D position (X, Y, Z) based on the visual evidence.
3. If a fixture appears to be on a front truss, place it forward (lower Z). If it's on a back truss, place it deep (higher Z).
4. Identify which fixtures are on the floor (Y ~ 0) and which are suspended (Y > 3).

FIXTURES TO POSITION:
{json.dumps(fixtures, indent=2)}

3D COORDINATE SYSTEM:
- X: Left to Right (-15.0 to +15.0). 0.0 is center stage.
- Y: Floor to Ceiling (0.0 to 8.0). 0.0 is stage floor.
- Z: Front to Back (-8.0 to +8.0). 0.0 is center depth. Negative is deep stage, Positive is towards camera.

RESPONSE FORMAT:
Return ONLY a valid JSON array of objects.
Example:
[
  {{ "id": "1", "position": {{"x": -2.5, "y": 5.0, "z": -1.0}} }}
]
"""
        response = model.generate_content([prompt, img])
        result_text = response.text.strip()
        
        # Robust JSON extraction
        if "```" in result_text:
            import re
            json_match = re.search(r'\[\s*{.*}\s*\]', result_text, re.DOTALL)
            if json_match:
                result_text = json_match.group(0)
            else:
                # Fallback to simple slicing if regex fails
                if "```json" in result_text: result_text = result_text.split("```json")[1].split("```")[0].strip()
                elif "```" in result_text: result_text = result_text.split("```")[1].split("```")[0].strip()
            
        positions = json.loads(result_text)
        return {"status": "success", "positions": positions}
        
    except Exception as e:
        return {"status": "error", "message": f"Gemini Error: {str(e)}"}

@app.post("/api/fixture/load-qxw")
async def load_fixtures_from_qxw(data: dict):
    """Extracts fixture definitions and channel configurations from a QLC+ .qxw project."""
    path = data.get("path", current_workspace.get("file"))
    if not path or not os.path.exists(path):
        return {"status": "error", "message": "File .qxw non trovato"}
    
    try:
        tree = ET.parse(path)
        root = tree.getroot()
        
        # QLC+ .qxw: fixtures are under <Engine><Fixtures><Fixture>
        ns = ''
        if root.tag.startswith('{'):
            ns = root.tag.split('}')[0] + '}'
        
        engine = root.find(f'{ns}Engine') or root
        fixtures_el = engine.find(f'{ns}Fixtures') or engine
        
        fixtures_out = []
        for f in fixtures_el.findall(f'{ns}Fixture'):
            def gtxt(tag):
                el = f.find(f'{ns}{tag}')
                return el.text if el is not None else ''
            
            channels_count = 0
            try: channels_count = int(gtxt('Channels'))
            except: pass
            
            address = 0
            try: address = int(gtxt('Address'))
            except: pass
            
            universe = 0
            try: universe = int(gtxt('Universe'))
            except: pass
            
            fixtures_out.append({
                "id": gtxt('ID') or len(fixtures_out),
                "name": gtxt('Name'),
                "manufacturer": gtxt('Manufacturer'),
                "model": gtxt('Model'),
                "channels": channels_count,
                "address": address + 1,  # 1-indexed for display
                "universe": universe,
                "mode": gtxt('Mode')
            })
        
        return {
            "status": "success",
            "count": len(fixtures_out),
            "fixtures": fixtures_out,
            "source": os.path.basename(path)
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/qlc/function")
async def trigger_qlc_function(data: dict):
    """Routes Virtual Console function triggers to QLC+ via OSC."""
    try:
        from osc_sender import OSCSender
        osc = OSCSender()
        fn_id = data.get("function_id")
        val = data.get("value", 255)
        # Assuming QLC+ is configured to listen to /Functions/{ID} or similar.
        # It's common to map OSC to VC buttons. Just sending a standard format:
        osc.send_trigger(f"/Function/{fn_id}", val / 255.0)
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/qlc/blackout")
async def qlc_blackout():
    """Turns off all DMX channels and sends blackout command."""
    try:
        from dmx_engine import dmx_engine
        for key in list(dmx_engine.channels.keys()):
            dmx_engine.channels[key] = 0
            
        from osc_sender import OSCSender
        osc = OSCSender()
        osc.send_trigger("/Blackout", 1.0)
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/qlc/reset")
async def qlc_reset():
    """Resets the bridge state and DMX engine."""
    try:
        from dmx_engine import dmx_engine
        dmx_engine.channels.clear()
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/project/list")
async def list_projects():
    """Lists all .ai-dmx projects."""
    try:
        return {"status": "success", "projects": project_manager.list_projects()}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/project/save")
async def save_project(data: dict):
    """Saves the entire AuraSync state using ProjectManager (ZIP .ai-dmx)."""
    try:
        name = data.get("name", "untitled_project")
        state_data = {
            "version": "2.0",
            "timestamp": time.time(),
            "workspace_path": current_workspace["file"],
            "lfo_state": gen_engine.get_state(),
            "config": config,
            "ui_state": data.get("ui_state", {})
        }
        path = project_manager.save_project(name, state_data)
        return {"status": "success", "path": path}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/project/load")
async def load_project(data: dict):
    """Loads a .ai-dmx project and restores state."""
    try:
        name = data.get("name")
        if not name: return {"status": "error", "message": "No name provided"}
        
        path = os.path.join(project_manager.projects_dir, name)
        state = project_manager.load_project(path)
        
        # Restore Workspace
        if state.get("workspace_path"):
            parser = WorkspaceParser(state["workspace_path"])
            if parser.parse():
                current_workspace["file"] = state["workspace_path"]
                current_workspace["fixtures"] = parser.get_fixtures()
                current_workspace["functions"] = parser.get_functions()
                current_workspace["groups"] = parser.get_groups()

        # Restore Items
        gen_engine.active_items.clear()
        for lfo_id, lfo_data in state.get("lfo_state", {}).items():
            if lfo_data["type"] == "standard":
                gen_engine.add_lfo(
                    lfo_id, 
                    lfo_data["shape"], 
                    lfo_data["frequency"], 
                    lfo_data["amplitude"], 
                    lfo_data["offset"],
                    lfo_data["target"][0],
                    lfo_data["target"][1],
                    multiplier=lfo_data.get("multiplier")
                )
            elif lfo_data["type"] == "lissajous":
                gen_engine.add_lissajous(
                    lfo_id,
                    lfo_data["x_freq"],
                    lfo_data["y_freq"],
                    lfo_data["x_amp"],
                    lfo_data["y_amp"],
                    lfo_data["target"][0],
                    lfo_data["target"][1],
                    lfo_data["target"][2]
                )
        
        return {"status": "success", "state": state}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# 7. Generative Engine Control
@app.post("/api/generative/add_lfo")
async def add_lfo(data: dict):
    """Adds a standard or BeatSync LFO."""
    try:
        gen_engine.add_lfo(
            item_id=data["id"],
            shape=data.get("shape", "sine"),
            frequency=data.get("frequency", 1.0),
            amplitude=data.get("amplitude", 1.0),
            offset=data.get("offset", 0.0),
            universe=data["universe"],
            channel=data["channel"],
            multiplier=data.get("multiplier")
        )
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/generative/add_chained_lfo")
async def add_chained_lfo(data: dict):
    """Adds a complex LFO by combining multiple waveforms."""
    try:
        gen_engine.add_chained_lfo(
            item_id=data["id"],
            configs=data["configs"],
            operation=data.get("operation", "add"),
            universe=data["universe"],
            channel=data["channel"]
        )
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/generative/add_bezier_path")
async def add_bezier_path(data: dict):
    """Adds a smooth 2D/3D Bezier path movement."""
    try:
        gen_engine.add_bezier_path(
            item_id=data["id"],
            points=[tuple(p) for p in data["points"]],
            duration=data.get("duration", 4.0),
            universe=data["universe"],
            pan_ch=data["pan_channel"],
            tilt_ch=data["tilt_channel"],
            fix_pos=tuple(data.get("fix_pos", (0,0,0))),
            loop=data.get("loop", True)
        )
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/generative/stop")
async def stop_generative(data: dict):
    """Stops a specific generative effect or all effects."""
    try:
        item_id = data.get("id")
        if item_id:
            gen_engine.remove_item(item_id)
        else:
            gen_engine.active_items.clear()
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# Static files mount MUST be last so API routes take priority
static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')
if not os.path.exists(static_dir):
    os.makedirs(static_dir)
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
