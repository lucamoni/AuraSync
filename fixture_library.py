import xml.etree.ElementTree as ET
import os

class FixtureLibrary:
    """Parses and manages QLC+ Fixture Definitions (.qxf)."""
    
    def __init__(self, search_dirs=None):
        self.search_dirs = search_dirs or []
        self.definitions = {} # Cache: {model_name: definition_data}

    def load_definition(self, file_path):
        """Parses a .qxf file and returns its structured data."""
        if not os.path.exists(file_path):
            return None
            
        try:
            tree = ET.parse(file_path)
            root = tree.getroot()

            # QLC+ .qxf files use a namespace — strip it for simple tag lookups
            ns = ''
            if root.tag.startswith('{'):
                ns = root.tag.split('}')[0] + '}'

            def find(elem, tag):
                result = elem.find(f'{ns}{tag}')
                return result

            def findall(elem, tag):
                return elem.findall(f'{ns}{tag}')

            model_el = find(root, 'Model')
            manufacturer_el = find(root, 'Manufacturer')
            model = model_el.text if model_el is not None else 'Sconosciuto'
            manufacturer = manufacturer_el.text if manufacturer_el is not None else 'Sconosciuto'
            
            channels = {}
            for channel in findall(root, 'Channel'):
                name = channel.get('Name', 'N/A')
                group_el = find(channel, 'Group')
                preset = channel.get('Preset', '')
                group = group_el.get('Byte', '0') if group_el is not None else (preset or 'Generic')
                channels[name] = {'group': group}
            
            modes = {}
            for mode in findall(root, 'Mode'):
                mode_name = mode.get('Name', 'Default')
                channels_in_mode = [c.text for c in findall(mode, 'Channel') if c.text]
                modes[mode_name] = channels_in_mode
                
            def_data = {
                'manufacturer': manufacturer,
                'model': model,
                'channels': channels,
                'modes': modes,
                'channel_count': len(channels)
            }
            self.definitions[model] = def_data
            return def_data
        except Exception as e:
            print(f"Error parsing .qxf: {e}")
            return None

    def find_definition(self, manufacturer, model):
        """Attempts to find a .qxf file in search directories."""
        # Simple search for now
        for directory in self.search_dirs:
            filename = f"{manufacturer}-{model}.qxf".replace(" ", "_")
            full_path = os.path.join(directory, filename)
            if os.path.exists(full_path):
                return self.load_definition(full_path)
        return None
