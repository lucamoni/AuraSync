#!/bin/bash

echo "=== Avvio QLC+ Audio Bridge Web Dashboard ==="
echo "Assicurati che BlackHole o il tuo microfono siano impostati come input predefiniti."
echo "Il dashboard sarà disponibile su: http://localhost:8000"
echo "------------------------------------------------------"

# Kill any existing processes on port 8000 if necessary
# fuser -k 8000/tcp 2>/dev/null

python3 app.py
