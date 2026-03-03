import xml.etree.ElementTree as ET
import xml.dom.minidom as minidom

class WorkspaceExporter:
    """Exports the current AuraSync Pro state to a QLC+ .qxw file."""
    
    def __init__(self, workspace_state):
        self.state = workspace_state
        self.fixtures = workspace_state.get("fixtures", [])
        
    def export(self):
        root = ET.Element("Workspace")
        root.set("xmlns", "http://www.qlcplus.org/Workspace")
        
        # Engine Node
        engine = ET.SubElement(root, "Engine")
        
        # Add Input/Output definitions (hardcoded default mapping)
        io = ET.SubElement(engine, "InputOutputMap")
        for uni_id in range(4):
            uni = ET.SubElement(io, "Universe")
            uni.set("Name", f"Universe {uni_id + 1}")
            uni.set("ID", str(uni_id))
            out = ET.SubElement(uni, "Output")
            out.set("Plugin", "ArtNet" if uni_id == 0 else "None")
            out.set("Line", "0")

        # Add Fixtures
        for f in self.fixtures:
            fix_el = ET.SubElement(engine, "Fixture")
            
            # Use original ID if available, otherwise generate a numeric one
            # The QLC+ id needs to be numeric usually, but AuraSync generates string UUIDs sometimes.
            # We'll hash the string ID to a short int if it's not a digit.
            q_id = str(f.get("id"))
            if not q_id.isdigit():
                q_id = str(abs(hash(q_id)) % 100000)
                
            ET.SubElement(fix_el, "Manufacturer").text = f.get("manufacturer", "Generic")
            ET.SubElement(fix_el, "Model").text = f.get("model", "Generic")
            ET.SubElement(fix_el, "Mode").text = f.get("mode", "Standard")
            ET.SubElement(fix_el, "ID").text = q_id
            ET.SubElement(fix_el, "Name").text = f.get("name", "New Fixture")
            ET.SubElement(fix_el, "Universe").text = str(f.get("universe", 0))
            ET.SubElement(fix_el, "Address").text = str(int(f.get("address", 1)) - 1) # QLC uses 0-511
            
            # Simple 1-channel dimmer fallback if not properly defined
            if not f.get("channel_details"):
                ET.SubElement(fix_el, "Channels").text = "1"
            else:
                ET.SubElement(fix_el, "Channels").text = str(len(f.get("channel_details")))
        
        # Fixture Group / Workspace layout context (Monitor)
        # Not strictly necessary for basic patching but good for 3D
        fixture_groups = ET.SubElement(root, "FixtureGroup")
        fixture_groups.set("ID", "0")
        
        # Attempt to format it nicely
        xml_string = ET.tostring(root, 'utf-8')
        parsed = minidom.parseString(xml_string)
        return parsed.toprettyxml(indent="  ")
