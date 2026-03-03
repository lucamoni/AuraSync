import webview
import threading
import uvicorn
import sys
import os
import time

# Setup paths for PyInstaller bundle
if getattr(sys, 'frozen', False):
    application_path = sys._MEIPASS
else:
    application_path = os.path.dirname(os.path.abspath(__file__))

os.chdir(application_path)
sys.path.append(application_path)

# Import the FastAPI app
try:
    from app import app
except ImportError as e:
    print(f"Error importing app: {e}")
    sys.exit(1)

def run_server():
    """Runs the FastAPI server in a background thread."""
    try:
        # We use 127.0.0.1 for local communication
        uvicorn.run(app, host="127.0.0.1", port=8001, log_level="info")
    except Exception as e:
        print(f"Server error: {e}")

if __name__ == '__main__':
    # Start FastAPI in a separate thread
    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()

    # Wait a moment for server to initialize (lifespan, etc.)
    # The frontend will retry if it's too fast, but 1s is usually safe
    time.sleep(2.0)  # Slightly longer wait for server startup

    # Create the window
    window = webview.create_window(
        'AuraSync Pro', 
        'http://127.0.0.1:8001', 
        width=1400, 
        height=900,
        min_size=(1024, 768),
        background_color='#0f172a' # Matches the app's dark theme
    )
    
    # Start the webview
    # In a frozen app, we don't want debug mode usually
    webview.start(debug=True)  # Enable debug to capture console errors
