import sys
import time
import json
import os
from audio_analyzer import AudioAnalyzer
from osc_sender import OSCSender

def load_config():
    config_path = os.path.join(os.path.dirname(__file__), 'config.json')
    try:
        with open(config_path, 'r') as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading config: {e}")
        sys.exit(1)

def main():
    print("=== QLC+ Audio Bridge (SoundSwitch Clone) ===")
    
    config = load_config()
    
    # Initialize components
    analyzer = AudioAnalyzer()
    sender = OSCSender(
        ip=config['osc_settings']['ip'],
        port=config['osc_settings']['port']
    )
    
    # List devices to help the user choose
    analyzer.list_devices()
    
    print("Tip: If you want to use system audio, make sure you have BlackHole/Loopback selected as default input.")
    
    try:
        device_id = input("Enter Input Device ID (default is system default): ")
        device_id = int(device_id) if device_id.strip() else None
    except ValueError:
        device_id = None

    analyzer.start_stream(device_id)
    
    print("\nBridge is running! Press Ctrl+C to stop.")
    print("Frequency Mapping:")
    for band, cfg in config['bands'].items():
        print(f"  - {band.upper()}: {cfg['min_freq']}-{cfg['max_freq']}Hz -> {cfg['osc_path']}")

    try:
        while True:
            analysis = analyzer.get_analysis(config['bands'])
            
            # Print a simple visual meter
            meter_line = "\r"
            for band_name, data in analysis.items():
                if data['triggered']:
                    meter_line += f"[{band_name.upper()}] "
                    # Send pulse
                    sender.send_trigger(config['bands'][band_name]['osc_path'], 1.0)
                    # We'll send the 0.0 pulse after a tiny non-blocking delay? 
                    # For simplicity in this script, we'll pulse 1.0 and then 0.0 
                    # either next loop or with a very short sleep if needed by QLC+
                else:
                    meter_line += f" {band_name.upper()}  "
            
            print(meter_line, end="", flush=True)

            # Optional: momentary pulse reset
            # In a more advanced version, we'd use a timer to reset triggers
            # For now, let's send 0.0 briefly if we triggered anything
            triggered_any = any(d['triggered'] for d in analysis.values())
            if triggered_any:
                time.sleep(config['pulse_delay'])
                for band_name, data in analysis.items():
                    if data['triggered']:
                        sender.send_trigger(config['bands'][band_name]['osc_path'], 0.0)

            # Small throttle
            time.sleep(0.01)
            
    except KeyboardInterrupt:
        print("\nStopping bridge...")
    finally:
        analyzer.close()
        print("Done.")

if __name__ == "__main__":
    main()
