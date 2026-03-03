import json
import os

class PatchBay:
    """
    Manages the mapping between virtual fixtures and physical DMX addresses.
    Handles collision detection and auto-patching.
    """
    def __init__(self, universes_count=1):
        self.universes_count = universes_count
        self.patch = {} # {id: {"universe": u, "address": a, "channels": c}}

    def can_patch(self, universe, address, channels, ignore_id=None):
        """Checks if a range of channels is available."""
        if universe < 0 or universe >= self.universes_count:
            return False, "Universo non valido"
        if address < 1 or address + channels - 1 > 512:
            return False, "Indirizzo fuori range (1-512)"

        new_range = set(range(address, address + channels))
        
        for fix_id, p in self.patch.items():
            if fix_id == ignore_id:
                continue
            if p["universe"] == universe:
                existing_range = set(range(p["address"], p["address"] + p["channels"]))
                intersection = new_range.intersection(existing_range)
                if intersection:
                    return False, f"Collisione con fixture ID {fix_id} agli indirizzi {sorted(list(intersection))}"
        
        return True, "OK"

    def patch_fixture(self, fix_id, universe, address, channels):
        """Patches a fixture to a specific address."""
        ok, msg = self.can_patch(universe, address, channels, ignore_id=fix_id)
        if ok:
            self.patch[fix_id] = {
                "universe": universe,
                "address": address,
                "channels": channels
            }
            return True, "Patched"
        return False, msg

    def unpatch_fixture(self, fix_id):
        if fix_id in self.patch:
            del self.patch[fix_id]
            return True
        return False

    def auto_patch(self, fixtures, start_universe=0, start_address=1):
        """Automatically patches a list of fixtures in sequence."""
        current_uni = start_universe
        current_addr = start_address
        results = []

        for f in fixtures:
            fix_id = f.get("id")
            channels = int(f.get("channels", 1))
            
            # Find next available slot
            while current_uni < self.universes_count:
                ok, _ = self.can_patch(current_uni, current_addr, channels)
                if ok:
                    self.patch_fixture(fix_id, current_uni, current_addr, channels)
                    results.append({"id": fix_id, "universe": current_uni, "address": current_addr})
                    current_addr += channels
                    if current_addr > 512:
                        current_addr = 1
                        current_uni += 1
                    break
                else:
                    current_addr += 1
                    if current_addr > 512:
                        current_addr = 1
                        current_uni += 1
        
        return results

    def get_patch_status(self):
        return self.patch
