import serial
import time
import sys

def test_break_condition(port):
    print(f"Testing break_condition on {port}...")
    try:
        ser = serial.Serial(port, baudrate=250000)
        ser.break_condition = True
        time.sleep(0.01)
        ser.break_condition = False
        print("Success: break_condition worked.")
        ser.close()
        return True
    except Exception as e:
        print(f"FAILED: break_condition error: {e}")
        return False

def test_baudrate_hack(port):
    print(f"Testing baudrate_hack on {port}...")
    try:
        ser = serial.Serial(port, baudrate=250000)
        # Switch to low baudrate to simulate break
        ser.baudrate = 9600
        ser.write(b'\x00')
        ser.flush()
        # Switch back
        ser.baudrate = 250000
        print("Success: baudrate_hack worked.")
        ser.close()
        return True
    except Exception as e:
        print(f"FAILED: baudrate_hack error: {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 test_dmx_macos.py /dev/cu.usbserial-XXXX")
        sys.exit(1)
    
    port = sys.argv[1]
    res1 = test_break_condition(port)
    res2 = test_baudrate_hack(port)
    
    if res1 or res2:
        print("\nConclusion: STANDALONE IS POSSIBLE.")
    else:
        print("\nConclusion: STANDALONE FAILS on standard driver.")
