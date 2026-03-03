import xml.etree.ElementTree as ET
import xml.dom.minidom as minidom
import os

class FixtureEditor:
    """
    Handles creation and modification of custom fixture definitions (.qxf).
    Includes 3D geometry and physical dimensions.
    """
    def __init__(self, output_dir="LucaFixtures"):
        self.output_dir = output_dir
        if not os.path.exists(self.output_dir):
            os.makedirs(self.output_dir)

    def create_definition(self, manufacturer, model, channels, modes, physical=None):
        """
        Creates a .qxf XML structure.
        physical: {"width": w, "height": h, "depth": d, "weight": wt, "power": p}
        channels: [{"name": n, "group": g, "capabilities": [{"range": [min, max], "res": r}]}]
        modes: [{"name": n, "channels": [name1, name2]}]
        """
        root = ET.Element("FixtureDefinition")
        root.set("xmlns", "http://www.qlcplus.org/FixtureDefinition")
        
        ET.SubElement(root, "Creator")
        ET.SubElement(root, "Manufacturer").text = manufacturer
        ET.SubElement(root, "Model").text = model
        ET.SubElement(root, "Type").text = "Other"

        # Channels
        for ch in channels:
            ch_el = ET.SubElement(root, "Channel")
            ch_el.set("Name", ch["name"])
            
            grp_el = ET.SubElement(ch_el, "Group")
            grp_el.set("Byte", "0")
            grp_el.text = ch.get("group", "Intensity")
            
            for cap in ch.get("capabilities", []):
                cap_el = ET.SubElement(ch_el, "Capability")
                cap_el.set("Min", str(cap["range"][0]))
                cap_el.set("Max", str(cap["range"][1]))
                cap_el.text = cap.get("res", "Default")

        # Modes
        for mode in modes:
            mode_el = ET.SubElement(root, "Mode")
            mode_el.set("Name", mode["name"])
            
            # Physical
            if physical:
                phys_el = ET.SubElement(mode_el, "Physical")
                bulb = ET.SubElement(phys_el, "Bulb")
                bulb.set("Type", "LED")
                bulb.set("Lumens", "0")
                bulb.set("ColourTemp", "0")
                
                dim_el = ET.SubElement(phys_el, "Dimensions")
                dim_el.set("Width", str(physical.get("width", 0)))
                dim_el.set("Height", str(physical.get("height", 0)))
                dim_el.set("Depth", str(physical.get("depth", 0)))
                dim_el.set("Weight", str(physical.get("weight", 0)))
                
                lens = ET.SubElement(phys_el, "Lens")
                lens.set("Name", "Other")
                lens.set("DegreesMin", "0")
                lens.set("DegreesMax", "0")
                
                focus = ET.SubElement(phys_el, "Focus")
                focus.set("Type", "Fixed")
                focus.set("PanMax", "0")
                focus.set("TiltMax", "0")

            for ch_name in mode["channels"]:
                ch_ref = ET.SubElement(mode_el, "Channel")
                ch_ref.set("Number", str(mode["channels"].index(ch_name)))
                ch_ref.text = ch_name

        filename = f"{manufacturer}-{model}.qxf".replace(" ", "_").replace("/", "-")
        filepath = os.path.join(self.output_dir, filename)
        
        xml_str = minidom.parseString(ET.tostring(root)).toprettyxml(indent="  ")
        with open(filepath, "w") as f:
            f.write(xml_str)
            
        return filepath
