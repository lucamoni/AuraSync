from pythonosc import udp_client

class OSCSender:
    """Sends OSC messages to QLC+."""
    
    def __init__(self, ip="127.0.0.1", port=7700):
        self.ip = ip
        self.port = port
        self.client = udp_client.SimpleUDPClient(self.ip, self.port)
        print(f"OSC Sender initialized targeting {self.ip}:{self.port}")

    def send_trigger(self, address="/qlc/button/1", value=1.0):
        """Sends a trigger value to a specific OSC address."""
        self.client.send_message(address, value)
        # Often QLC+ buttons toggle on 1.0, so we might need to send 0.0 quickly after
        # or just rely on the next beat. For now, we send the value as is.
        print(f"Sent {value} to {address}")

    def send_ping(self):
        """Utility to test connection."""
        self.send_trigger("/ping", 1.0)
