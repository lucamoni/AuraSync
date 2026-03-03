from pythonosc import dispatcher
from pythonosc import osc_server

def trigger_handler(address, *args):
    print(f"Received OSC on {address}: {args}")

def main():
    ip = "127.0.0.1"
    port = 7700

    dispatch = dispatcher.Dispatcher()
    dispatch.map("/qlc/*", trigger_handler)
    dispatch.set_default_handler(trigger_handler)

    server = osc_server.BlockingOSCUDPServer((ip, port), dispatch)
    print(f"Listening for OSC on {ip}:{port}...")
    print("Press Ctrl+C to stop.")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping listener...")

if __name__ == "__main__":
    main()
