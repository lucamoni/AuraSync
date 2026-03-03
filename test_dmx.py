import time
from dmx_engine import DMXEngine

# Test script for DMX stability
print("Testing DMX Stability...")
engine = DMXEngine(universes_count=1)
engine.start(output_mode="usb")

try:
    print("Setting Universe 0, Channel 1 to 255 (Full Intensity)")
    print("Toggle every 1s. Check hardware.")
    while True:
        engine.set_channel(0, 1, 255)
        print("ON")
        time.sleep(1.0)
        engine.set_channel(0, 1, 0)
        print("OFF")
        time.sleep(1.0)
except KeyboardInterrupt:
    engine.stop()
    print("Stopped.")
