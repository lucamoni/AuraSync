import json
import zipfile
import os
import io
import shutil

class ProjectManager:
    def __init__(self, base_path="/Users/lucamoni/.gemini/antigravity/scratch/qlc-bridge"):
        self.base_path = base_path
        self.projects_dir = os.path.join(base_path, "projects")
        if not os.path.exists(self.projects_dir):
            os.makedirs(self.projects_dir)

    def save_project(self, project_name, state_data):
        """
        Saves the project as a .ai-dmx (ZIP) file containing:
        - project.json (Full state)
        - fixtures/ (Any custom QXF files)
        """
        filename = f"{project_name}.ai-dmx"
        filepath = os.path.join(self.projects_dir, filename)
        
        # Create an in-memory ZIP
        memory_zip = io.BytesIO()
        with zipfile.ZipFile(memory_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
            # 1. Project metadata and state
            zf.writestr('project.json', json.dumps(state_data, indent=4))
            
            # 2. Bundle custom fixtures if any
            fixtures_path = os.path.join(self.base_path, "LucaFixtures")
            if os.path.exists(fixtures_path):
                for f in os.listdir(fixtures_path):
                    if f.endswith(".qxf"):
                        zf.write(os.path.join(fixtures_path, f), f"fixtures/{f}")

        # Write memory ZIP to disk
        with open(filepath, 'wb') as f:
            f.write(memory_zip.getvalue())
            
        return filepath

    def load_project(self, project_path):
        """
        Loads a .ai-dmx file and restores its components.
        Returns the project state as a dictionary.
        """
        if not os.path.exists(project_path):
            raise FileNotFoundError(f"Project not found: {project_path}")

        state_data = {}
        with zipfile.ZipFile(project_path, 'r') as zf:
            # 1. Read project.json
            with zf.open('project.json') as f:
                state_data = json.loads(f.read().decode('utf-8'))
            
            # 2. Extract fixtures to local LucaFixtures
            fixtures_path = os.path.join(self.base_path, "LucaFixtures")
            if not os.path.exists(fixtures_path):
                os.makedirs(fixtures_path)
            
            for item in zf.namelist():
                if item.startswith('fixtures/') and item.endswith('.qxf'):
                    filename = os.path.basename(item)
                    with zf.open(item) as source, open(os.path.join(fixtures_path, filename), 'wb') as target:
                        shutil.copyfileobj(source, target)
        
        return state_data

    def list_projects(self):
        """Lists all .ai-dmx projects in the projects directory."""
        projects = []
        for f in os.listdir(self.projects_dir):
            if f.endswith(".ai-dmx"):
                projects.append(f)
        return projects
