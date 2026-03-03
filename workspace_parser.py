import xml.etree.ElementTree as ET
import os

def _gtxt(element, ns, tag):
    """Safely get text of a child element, supports both namespaced and plain XML."""
    el = element.find(f'{ns}{tag}')
    return el.text if el is not None else None

class WorkspaceParser:
    """Parses QLC+ .qxw files to extract fixtures and functions."""
    
    def __init__(self, file_path):
        self.file_path = file_path
        self.fixtures = []
        self.functions = []
        self.groups = []
        self.monitor_items = {} # {id: {x, y, z}}

    def parse(self):
        """Parses the XML file and populates fixtures and functions lists."""
        if not os.path.exists(self.file_path):
            print(f"File not found: {self.file_path}")
            return False

        try:
            tree = ET.parse(self.file_path)
            root = tree.getroot()

            # Detect namespace (QLC+ uses xmlns="http://www.qlcplus.org/Workspace")
            ns = ''
            if root.tag.startswith('{'):
                ns = root.tag.split('}')[0] + '}'

            # Parse Fixtures — they are direct children of Engine/Fixtures
            # Try Engine > Fixtures first, then try root (for files without deep nesting)
            engine = root.find(f'{ns}Engine') or root
            fixtures_container = engine.find(f'{ns}Fixtures') or engine

            for fixture in fixtures_container.findall(f'{ns}Fixture'):
                manufacturer = _gtxt(fixture, ns, 'Manufacturer') or 'Generic'
                model_name   = _gtxt(fixture, ns, 'Model') or 'Unknown'
                fix_id       = _gtxt(fixture, ns, 'ID') or str(len(self.fixtures))
                fix_name     = _gtxt(fixture, ns, 'Name') or f'{model_name} #{fix_id}'
                fix_uni      = _gtxt(fixture, ns, 'Universe') or '0'
                fix_addr     = _gtxt(fixture, ns, 'Address') or '0'
                fix_channels = _gtxt(fixture, ns, 'Channels') or '1'
                fix_mode     = _gtxt(fixture, ns, 'Mode') or ''

                # Convert address to 1-indexed for display
                try:
                    display_addr = int(fix_addr) + 1
                except:
                    display_addr = fix_addr

                fix_data = {
                    "id": fix_id,
                    "name": fix_name,
                    "universe": int(fix_uni) if fix_uni.isdigit() else 0,
                    "address": display_addr,
                    "channels": int(fix_channels) if fix_channels.isdigit() else 1,
                    "manufacturer": manufacturer,
                    "model": model_name,
                    "mode": fix_mode,
                    "channel_details": []  # Optional: filled if .qxf found
                }

                # Attempt to find and parse matching .qxf for channel names
                qxf_data = self._find_and_parse_qxf(manufacturer, model_name)
                if qxf_data:
                    fix_data["channel_details"] = qxf_data.get("channel_details", [])
                    fix_data["modes"] = qxf_data.get("modes", {})

                self.fixtures.append(fix_data)

            for function in engine.findall(f'{ns}Function'):
                f_type = function.get("Type")
                func_data = {
                    "id": function.get("ID"),
                    "name": function.get("Name"),
                    "type": f_type,
                    "path": function.get("Path", ""),
                    "data": {},    # For Scenes
                    "steps": [],   # For Chasers
                }

                if f_type == "Scene":
                    scene_data = {}
                    # 1. Check legacy <Fixture><Channel> format
                    for fixture in function.findall(f'{ns}Fixture'):
                        f_id = fixture.get("ID")
                        fixture_channels = {}
                        for channel in fixture.findall(f'{ns}Channel'):
                            ch_num = channel.get("Number")
                            ch_val = channel.text
                            if ch_num and ch_val:
                                fixture_channels[int(ch_num)] = int(ch_val)
                        if fixture_channels:
                            if f_id not in scene_data: scene_data[f_id] = {}
                            scene_data[f_id].update(fixture_channels)

                    # 2. Check modern <FixtureVal> format
                    for fv in function.findall(f'{ns}FixtureVal'):
                        f_id = fv.get("ID")
                        vals = fv.text.split(',') if fv.text else []
                        fixture_channels = {}
                        for i in range(0, len(vals), 2):
                            if i + 1 < len(vals):
                                fixture_channels[int(vals[i])] = int(vals[i+1])
                        if fixture_channels:
                            if f_id not in scene_data: scene_data[f_id] = {}
                            scene_data[f_id].update(fixture_channels)
                    
                    func_data["data"] = scene_data

                elif f_type in ["Chaser", "Sequence"]:
                    steps = []
                    bound_scene = function.get("BoundScene")
                    for step in function.findall(f'{ns}Step'):
                        steps.append({
                            "scene_id": step.text if f_type == "Chaser" else bound_scene,
                            "fade": int(step.get("FadeIn", 0)),
                            "hold": int(step.get("Hold", 1000)),
                            "values": step.text if f_type == "Sequence" else "" # Raw sequence data
                        })
                    func_data["steps"] = steps

                elif f_type == "EFX":
                    # EFX contains Fixtures and pattern params
                    func_data["fixtures"] = [f.find(f'{ns}ID').text for f in function.findall(f'{ns}Fixture') if f.find(f'{ns}ID') is not None]
                    func_data["pattern"] = _gtxt(function, ns, "Pattern") or "circle"
                    func_data["width"] = int(_gtxt(function, ns, "Width") or 50)
                    func_data["height"] = int(_gtxt(function, ns, "Height") or 50)
                    func_data["speed"] = float(_gtxt(function, ns, "Speed") or 1.0)

                self.functions.append(func_data)

            # Parse Fixture Groups (Grids for RGB Matrix)
            for group in engine.findall(f'{ns}FixtureGroup'):
                grp_id = group.get("ID")
                name = _gtxt(group, ns, "Name")
                size = group.find(f"{ns}Size")
                width = int(size.get("X")) if size is not None else 1
                height = int(size.get("Y")) if size is not None else 1
                
                heads = []
                for head in group.findall(f"{ns}Head"):
                    heads.append({
                        "x": int(head.get("X")),
                        "y": int(head.get("Y")),
                        "fixture": head.get("Fixture"),
                        "head_idx": head.text
                    })
                
                self.groups.append({
                    "id": grp_id,
                    "name": name,
                    "width": width,
                    "height": height,
                    "heads": heads
                })

            # Parse Monitor Items (Positions)
            monitor = engine.find(f'{ns}Monitor')
            if monitor is not None:
                for item in monitor.findall(f'{ns}FxItem'):
                    fix_id = item.get("ID")
                    
                    # QLC+ 4 uses large scale coordinates (0-10000 or screen pixels)
                    # We normalize them to a reasonable 3D stage size (approx -10 to 10 meters)
                    try:
                        raw_x = float(item.get("XPos", 0))
                        raw_y = float(item.get("YPos", 0))
                        raw_z = float(item.get("ZPos", 0))
                        
                        # Heuristic: If values are very large, they are likely QLC+ scaled pixels
                        if abs(raw_x) > 50 or abs(raw_y) > 50:
                            # Map 0-10000 range to -15 to 15 meters
                            x = (raw_x / 5000.0 * 15.0) - 7.5
                            z = (raw_y / 5000.0 * 15.0) - 7.5
                            y = (raw_z / 1000.0 * 5.0) + 5.0 # Hanging from truss (y=5)
                        else:
                            x, y, z = raw_x, raw_y, raw_z
                            
                        self.monitor_items[fix_id] = {"x": x, "y": y, "z": z}
                    except:
                        pass

            # Map Monitor Positions to Fixtures
            for fixture in self.fixtures:
                f_id = fixture["id"]
                if f_id in self.monitor_items:
                    fixture["position"] = self.monitor_items[f_id]
                else:
                    # Default layout if No Monitor Data
                    idx = self.fixtures.index(fixture)
                    fixture["position"] = {
                        "x": (idx % 8 - 4) * 2,
                        "y": 5, 
                        "z": (idx // 8) * 2
                    }

            return True

        except Exception as e:
            print(f"Error parsing QLC+ workspace: {e}")
            import traceback
            traceback.print_exc()
            return False

    def _find_and_parse_qxf(self, manufacturer, model):
        """Search for .qxf in common paths and parse channel names. Safe against None inputs."""
        if not manufacturer or not model:
            return None

        # Normalize strings for searching
        m_norm = manufacturer.lower().strip()
        mod_norm = model.lower().strip()
        mod_clean = mod_norm.replace(" ", "-").replace("_", "-")

        search_dirs = [
            os.path.dirname(self.file_path),
            os.path.expanduser("~/Library/Application Support/QLC+/Fixtures"),
            "/Applications/QLC+.app/Contents/Resources/Fixtures",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "LucaFixtures"),
        ]

        # Candidates (broad to specific)
        candidates = [
            f"{manufacturer}-{model}.qxf",
            f"{manufacturer}-{mod_clean}.qxf",
            f"{mod_clean}.qxf",
            f"{mod_norm}.qxf",
            f"{manufacturer}_{model}.qxf".replace(" ","_")
        ]

        for pd in search_dirs:
            if not pd or not os.path.exists(pd):
                continue
            
            # 1. Try direct matches
            for c in candidates:
                fp = os.path.join(pd, c)
                if os.path.exists(fp): return self._parse_qxf(fp)
                # Try in manufacturer sub-folder
                sub = os.path.join(pd, manufacturer, f"{model}.qxf")
                if os.path.exists(sub): return self._parse_qxf(sub)
                sub_norm = os.path.join(pd, manufacturer, f"{mod_clean}.qxf")
                if os.path.exists(sub_norm): return self._parse_qxf(sub_norm)

            # 2. Try case-insensitive listing match
            try:
                files = os.listdir(pd)
                for f in files:
                    fn = f.lower()
                    if mod_clean in fn or mod_norm in fn:
                        return self._parse_qxf(os.path.join(pd, f))
            except: pass

        return None
        return None

    def _parse_qxf(self, path):
        """Parses a .qxf file and extracts channel names, groups, and modes."""
        try:
            tree = ET.parse(path)
            root = tree.getroot()
            ns = ''
            if root.tag.startswith('{'):
                ns = root.tag.split('}')[0] + '}'

            channel_details = []
            for c in root.findall(f'{ns}Channel'):
                name = c.get('Name', '')
                group_el = c.find(f'{ns}Group')
                group = group_el.text if group_el is not None else ''
                channel_details.append({"name": name, "group": group})

            channel_names = [c["name"] for c in channel_details]

            modes = {}
            for mode in root.findall(f'{ns}Mode'):
                mode_name = mode.get('Name', 'Default')
                chs = [c.text for c in mode.findall(f'{ns}Channel') if c.text]
                modes[mode_name] = chs

            return {"channel_details": channel_details, "channel_names": channel_names, "modes": modes}
        except Exception as e:
            print(f"[Parser] Error reading .qxf {path}: {e}")
            return None

    def get_fixtures(self):
        return self.fixtures

    def get_functions(self):
        return self.functions

    def get_groups(self):
        return self.groups
