#!/bin/zsh -l
# AuraSync Pro Standalone Launcher
cd "$(dirname "$0")"
echo "Avvio AuraSync Pro..."
# Use Python and open the browser automatically
python3 -u app.py > app_log.txt 2>&1 &
sleep 2
open "http://127.0.0.1:8000"
echo "AuraSync è attivo. Chiudi questa finestra per terminare."
# Wait for the process to be killed
trap 'kill %1' SIGINT SIGTERM EXIT
wait
