# AuraSync

AuraSync is a high-performance audio-to-DMX bridge designed for real-time light synchronization. It connects audio analysis with QLC+, Art-Net, sACN, and USB-DMX hardware.

## Features

- **Real-time Audio Analysis**: Advanced peak detection, energy estimation, and beat tracking.
- **3D Visualizer**: Live studio visualization using Three.js for DMX signal verification.
- **Multi-Protocol Support**: Art-Net, sACN (E1.31), and USB-DMX.
- **AI-Driven Generative Engine**: Automatic lighting scenes based on music mood and energy.
- **Spotify Integration**: Sync lights with Spotify playback metadata.
- **Pro DJ Link Support**: Cross-sync with Pioneer DJ equipment.

## Setup

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
2. Configure your DMX settings in `config.json`.
3. Launch the application:
   ```bash
   python app.py
   ```

## License
MIT
