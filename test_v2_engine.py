import requests
import time
import random

BASE_URL = "http://localhost:8000/api"

def test_chained_lfo():
    print("Testing Chained LFO...")
    payload = {
        "id": "chained_test",
        "universe": 1,
        "channel": 1, # Intensity of first fixture usually
        "operation": "add",
        "configs": [
            {"shape": "sine", "frequency": 0.5, "amplitude": 0.3, "offset": 0.2},
            {"shape": "triangle", "frequency": 2.2, "amplitude": 0.1, "offset": 0.0}
        ]
    }
    r = requests.post(f"{BASE_URL}/generative/add_chained_lfo", json=payload)
    print(r.json())

def test_bezier_path():
    print("Testing Bezier Path...")
    # 4 points: P0, CP1, CP2, P1
    # CubicBezier.calculate(t, p0, p1, p2, p3)
    # Stage is roughly -10 to 10 wide, 0 to 12 height
    points = [
        (0, 0, 5),    # Start
        (10, 5, 10),  # CP1
        (-10, 5, 10), # CP2
        (0, 0, 5)     # End (Looping back)
    ]
    payload = {
        "id": "path_test",
        "universe": 1,
        "pan_channel": 4, # Dummy pan/tilt channels for testing
        "tilt_channel": 5,
        "points": points,
        "duration": 5.0,
        "fix_pos": (0, 0, 10), # Fixture suspended at top center
        "loop": True
    }
    r = requests.post(f"{BASE_URL}/generative/add_bezier_path", json=payload)
    print(r.json())

if __name__ == "__main__":
    test_chained_lfo()
    test_bezier_path()
    time.sleep(10)
    print("Stopping tests...")
    requests.post(f"{BASE_URL}/generative/stop", json={})
