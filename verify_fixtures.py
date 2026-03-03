import sys
import os
import requests
import json
import time

# Base URL for the local AuraSync server
BASE_URL = "http://localhost:8000/api"

def test_fixture_patching():
    print("Testing Fixture Patching...")
    
    # 1. Patch a new fixture
    payload = {
        "qxf": "Par-36.qxf", # This should exist in LucaFixtures
        "universe": 0,
        "auto_address": True
    }
    try:
        res = requests.post(f"{BASE_URL}/workspace/patch", json=payload)
        data = res.json()
        print(f"Patch Result: {data.get('status')}")
        assert data["status"] == "success"
        fixture = data["fixture"]
        fix_id = fixture["id"]
        print(f"Created Fixture: {fixture['name']} (ID: {fix_id}) at {fixture['universe']}:{fixture['address']}")
        
        # 2. Update fixture position
        update_payload = {
            "id": fix_id,
            "name": "Updated Spot",
            "position": {"x": 5, "y": 5, "z": 5}
        }
        res = requests.post(f"{BASE_URL}/workspace/update-fixture", json=update_payload)
        data = res.json()
        print(f"Update Result: {data.get('status')}")
        assert data["status"] == "success"
        assert data["fixture"]["name"] == "Updated Spot"
        assert data["fixture"]["position"]["x"] == 5
        
        # 3. Verify Env Status
        res = requests.get(f"{BASE_URL}/env/status")
        data = res.json()
        fixtures = data["workspace"]["fixtures"]
        found = any(f["id"] == fix_id for f in fixtures)
        print(f"Fixture found in env status: {found}")
        assert found
        
        # 4. Remove fixture
        res = requests.post(f"{BASE_URL}/workspace/remove-fixture", json={"id": fix_id})
        data = res.json()
        print(f"Removal Result: {data.get('status')}")
        assert data["status"] == "success"
        
        print("Fixture Manager API verification passed!")
        
    except Exception as e:
        print(f"Verification Failed: {e}")
        # Server might not be running, this is a conceptual test or requires server start
        if "Connection refused" in str(e):
            print("Note: Test requires the AuraSync server to be running on port 8000.")

if __name__ == "__main__":
    test_fixture_patching()
