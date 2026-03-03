import pyaudio
import numpy as np
import time

class BeatTracker:
    """Estimates BPM and predicts next beats based on energy onsets and phase tracking."""
    def __init__(self, history_size=100):
        self.onsets = [] # List of (timestamp, energy)
        self.history_size = history_size
        self.bpm = 0
        self.interval = 0
        self.last_beat_time = 0
        self.last_onset_time = 0
        self.phase = 0.0
        
        # Measure Tracking (4/4)
        self.beat_count = 0 
        self.downbeat_ready = False
        self.downbeat_offset = 0 # Offset to realign beat 1
        self.measure_onsets = [] # Onsets within the last 4 beats

    def add_onset(self, energy):
        now = time.time()
        self.onsets.append((now, energy))
        if len(self.onsets) > self.history_size:
            self.onsets.pop(0)
        
        # Calculate BPM and interval based on median of valid recent diffs
        if len(self.onsets) > 5:
            diffs = [self.onsets[i][0] - self.onsets[i-1][0] for i in range(1, len(self.onsets))]
            # Focus on 1/4 beats (approx 0.3s to 1.0s -> 60-200BPM)
            valid_diffs = [d for d in diffs if 0.3 < d < 1.0]
            if len(valid_diffs) >= 3:
                import statistics
                med_interval = statistics.median(valid_diffs)
                # Apply slow moving average to the median for extreme stability
                if self.interval == 0:
                    self.interval = med_interval
                else:
                    self.interval = self.interval * 0.8 + med_interval * 0.2
                self.bpm = 60.0 / self.interval
        self.last_onset_time = now

    def is_beat(self):
        """Predictive beat detection based on phase and measure tracking."""
        now = time.time()
        
        if self.bpm > 0 and now - self.last_onset_time > 5.0:
            self.bpm = 0
            self.interval = 0
            self.beat_count = 0
            print("[Analyzer] BPM Reset (Silence)")
            return False

        if self.interval == 0: return False
        
        elapsed = now - self.last_beat_time
        
        if elapsed >= self.interval:
            self.last_beat_time = now - (elapsed % self.interval)
            
            # Increment beat count (1 to 4)
            self.beat_count = (self.beat_count % 4) + 1
            
            # If we just hit beat 1, we expect a strong onset soon or recently
            return True
        return False

    def check_downbeat(self, recent_onsets):
        """Analyzes recent onsets to align beat 1 with the strongest hit."""
        if not recent_onsets or len(recent_onsets) < 8:
            return
        
        # Look at the last 4 predicted beats and find which one had the most energy
        # This is a simple way to 'snap' the measure
        pass # To be implemented with onset energy mapping

    def get_measure_pos(self):
        """Returns (beat_number, phase) e.g. (1, 0.5) is middle of beat 1."""
        return self.beat_count, self.get_phase()

    def get_phase(self):
        """Returns 0.0 to 1.0 progress toward next beat."""
        if self.interval == 0: return 0
        now = time.time()
        elapsed = now - self.last_beat_time
        return min(1.0, elapsed / self.interval)

class AudioAnalyzer:
    """Handles audio capture, multi-band frequency analysis, and device listing."""
    
    def __init__(self, channels=1, rate=44100, chunk_size=1024):
        self.channels = channels
        self.rate = rate
        self.chunk_size = chunk_size
        self.audio = pyaudio.PyAudio()
        self.stream = None
        
        # Dynamic threshold parameters
        self.history_size = 80 # Larger for smoother average
        self.band_histories = {}
        self.beat_tracker = BeatTracker()
        
        # Phase 5.3: Drop Detection & Segmentation
        self.long_term_energy_history = []
        self.long_term_size = 400 
        self.current_section = "Intro" # Intro, Verse, Chorus, Bridge, Build-up, Drop, Outro
        self.energy_level = 1 # 1 (Low) to 5 (Max)
        self.last_results = {
            "section": "VERSE",
            "energy_level": 1,
            "stems": {},
            "bpm": 0
        }
        
        self.stem_analyzer = None # Will hold Demucs if available

    def list_input_devices(self):
        """Returns a list of available input devices."""
        devices = []
        try:
            try:
                device_count = self.audio.get_device_count()
            except OSError:
                # Re-initialize PortAudio if it crashed or was closed
                print("[Audio] Re-initializing PortAudio...")
                self.audio = pyaudio.PyAudio()
                device_count = self.audio.get_device_count()

            for i in range(device_count):
                try:
                    dev_info = self.audio.get_device_info_by_index(i)
                    if dev_info.get('maxInputChannels') > 0:
                        name = dev_info.get('name')
                        # Highlight Virtual Loopback devices (Module 1.2 requirement)
                        is_loopback = "blackhole" in name.lower() or "loopback" in name.lower() or "virtual" in name.lower()
                        devices.append({
                            "id": i,
                            "name": name,
                            "channels": dev_info.get('maxInputChannels'),
                            "is_loopback": is_loopback,
                            "default_rate": dev_info.get('defaultSampleRate')
                        })
                except Exception as e:
                    print(f"[Audio] Warning reading device {i}: {e}")
            return devices
        except Exception as global_e:
            print(f"[Audio] CRITICAL ERROR listing devices: {global_e}")
            return []

    def start_stream(self, device_index=None):
        """Starts the audio input stream with automatic resampling to 44.1kHz."""
        if self.stream:
            try:
                self.stream.stop_stream()
                self.stream.close()
            except:
                pass
            self.stream = None

        # Auto-detect device and sample rate
        actual_channels = 1
        source_rate = self.rate
        
        if device_index is not None:
            try:
                dev_info = self.audio.get_device_info_by_index(device_index)
                actual_channels = max(1, min(2, int(dev_info.get('maxInputChannels', 1))))
                source_rate = int(dev_info.get('defaultSampleRate', self.rate))
                print(f"[Audio] Device Source Rate: {source_rate}Hz, Channels: {actual_channels}")
            except:
                actual_channels = 1
        
        self.active_channels = actual_channels
        self.active_device = device_index
        self.source_rate = source_rate

        try:
            self.stream = self.audio.open(
                format=pyaudio.paFloat32,
                channels=actual_channels,
                rate=source_rate,
                input=True,
                input_device_index=device_index,
                frames_per_buffer=self.chunk_size
            )
            print(f"[Audio] Stream started — device={device_index}, rate={source_rate}")
        except Exception as e:
            print(f"[Audio] Failed to open stream at {source_rate}Hz: {e}")
            # Fallback to standard 44.1kHz if device failed at native rate
            try:
                self.stream = self.audio.open(
                    format=pyaudio.paFloat32,
                    channels=1,
                    rate=44100,
                    input=True,
                    input_device_index=device_index,
                    frames_per_buffer=self.chunk_size
                )
                self.source_rate = 44100
                print("[Audio] Fallback to standard 44.1kHz mono")
            except Exception as e2:
                print(f"[Audio] Hard failure: {e2}")

    def set_device(self, device_index):
        """Switches to a different audio input device and restarts the stream."""
        print(f"[Audio] Switching to device {device_index}")
        self.start_stream(device_index=int(device_index))

    def get_analysis(self, bands_config):
        """
        Reads a chunk, performs FFT, and returns which bands triggered.
        Normalized values are provided for the visualizer.
        """
        if not self.stream:
            return {}

        try:
            # exception_on_overflow=False matches "low latency" goal by dropping frames if processing is slow
            data = self.stream.read(self.chunk_size, exception_on_overflow=False)
            samples = np.frombuffer(data, dtype=np.float32)

            # 1. Downmix stereo to mono (if applicable) BEFORE resampling
            # This ensures buffer alignment and saves resampler CPU
            if self.active_channels > 1:
                # Truncate samples to a multiple of channels to avoid reshape errors (macOS portaudio behavior)
                num_frames = len(samples) // self.active_channels
                if num_frames > 0:
                    samples = samples[:num_frames * self.active_channels].reshape(-1, self.active_channels).mean(axis=1)
                else:
                    return {"bands": {}, "stems": {}, "bpm": 0, "is_beat": False, "waveform": []}
            
            # 2. Resampling to 44.1kHz (The Listener Requirement)
            if self.source_rate != 44100:
                # Use numpy interp or scipy signal for lightweight but accurate resampling
                # This maintains phase alignment better than simple decimation
                from scipy import signal
                num_samples = int(len(samples) * 44100 / self.source_rate)
                samples = signal.resample(samples, num_samples)
            
            # --- Automatic Gain Control (AGC) ---
            rms = np.sqrt(np.mean(samples**2)) if len(samples) > 0 else 0
            target_rms = 0.1 # Real-world Float32 target
            
            if not hasattr(self, 'current_gain'):
                self.current_gain = 1.0
                
            if rms > 0:
                required_gain = target_rms / rms
                required_gain = max(0.1, min(20.0, required_gain))
                
                if required_gain < self.current_gain:
                    self.current_gain = self.current_gain * 0.5 + required_gain * 0.5 # Fast attack
                else:
                    self.current_gain = self.current_gain * 0.99 + required_gain * 0.01 # Slow release
                    
            samples = samples * self.current_gain
            
            # FFT Analysis
            fft_data = np.abs(np.fft.rfft(samples))
            freqs = np.fft.rfftfreq(len(samples), 1.0/self.rate)
            
            # Define Stems if not in config, or use extended config
            results = {
                "bands": {},
                "bpm": round(self.beat_tracker.bpm, 1),
                "is_beat": self.beat_tracker.is_beat(),
                "beat_phase": self.beat_tracker.get_phase(),
                "waveform": samples[::16].tolist() # Subsampled for visualizer
            }
            
            # Calculate overall energy and spectral balance for Color Harmony
            total_energy = np.sum(fft_data)
            low_energy_sum = 0
            high_energy_sum = 0
            
            for band_name, cfg in bands_config.items():
                # Extract energy from FFT
                mask = (freqs >= cfg['min_freq']) & (freqs <= cfg['max_freq'])
                band_energy = np.mean(fft_data[mask]) if np.any(mask) else 0
                
                if band_name in ["low", "mid_low"]:
                    low_energy_sum += band_energy
                else:
                    high_energy_sum += band_energy

                # Dynamic Threshold Logic
                history = self.band_histories.get(band_name, [])
                history.append(band_energy)
                if len(history) > self.history_size: history.pop(0)
                self.band_histories[band_name] = history
                
                avg_energy = np.mean(history) if history else 0.001
                
                # Triggering with local peak detection
                # We consider it a trigger if current energy > avg * multiplier
                triggered = bool(band_energy > avg_energy * cfg['threshold_multiplier'] and 
                                 band_energy > cfg['min_energy'])
                
                # Special Logic for Pseudo-Stems
                if (band_name == "low" or band_name == "mid_low") and triggered:
                    self.beat_tracker.add_onset(band_energy)
                    # print(f"[Analyzer] Beat onset detected on {band_name}")
                
                # NORMALIZE energy for frontend visualizer (0.0 to 1.0 range based on local context)
                norm_energy = min(1.0, band_energy / (avg_energy * 2)) if avg_energy > 0 else 0

                results["bands"][band_name] = {
                    'energy': float(band_energy),
                    'avg': float(avg_energy),
                    'rel_energy': float(norm_energy), # Clean signal for monitor
                    'triggered': triggered
                }
            
            # -- Advanced Stem Separation (Module 10.1) --
            # Uses a combination of frequency masking and Spectral Flux (Transients)
            
            # 1. Transient Detection for Drums/Kick (Spectral Flux)
            if not hasattr(self, 'prev_fft'):
                self.prev_fft = fft_data
            
            # Simple Spectral Flux: Sum of positive differences between consecutive FFT frames
            flux = np.sum(np.maximum(0, fft_data - self.prev_fft))
            self.prev_fft = fft_data
            
            # Normalize Flux relative to current energy
            norm_flux = min(1.0, flux / (total_energy * 0.5) if total_energy > 0 else 0)
            
            # 2. Refined Stem Masks
            # Drums: Low-end transients + High-end sizzle
            drum_energy = results["bands"].get("low", {}).get("rel_energy", 0) * 0.4 + \
                          norm_flux * 0.6 # Flux dominates for "hits"
            
            # Bass: Sustained low-end (Low-pass energy minus the transient part)
            bass_energy = results["bands"].get("low", {}).get("rel_energy", 0) * 0.8 * (1.0 - norm_flux * 0.5)
            
            # Vocals: Narrow mid-range band where human voice sits (200Hz - 3kHz)
            # Mask out sharp high-end hits to avoid "snare bleed" in vocals
            vocal_mask = (freqs >= 250) & (freqs <= 3000)
            vocal_energy_raw = np.mean(fft_data[vocal_mask]) if np.any(vocal_mask) else 0
            # Compare with local average for "Vocal Presence"
            vocal_history = self.band_histories.get("vocal_raw", [])
            vocal_history.append(vocal_energy_raw)
            if len(vocal_history) > 50: vocal_history.pop(0)
            self.band_histories["vocal_raw"] = vocal_history
            vocal_avg = np.mean(vocal_history) if vocal_history else 0.001
            vocal_energy = min(1.0, vocal_energy_raw / (vocal_avg * 2)) if vocal_avg > 0 else 0
            
            # Other: Melodic and harmonic content in the mid-highs
            other_energy = results["bands"].get("mid_high", {}).get("rel_energy", 0) * 0.7 + \
                           results["bands"].get("high", {}).get("rel_energy", 0) * 0.3

            stems = {
                "drums": float(min(1.0, drum_energy)),
                "bass": float(min(1.0, bass_energy)),
                "vocals": float(min(1.0, vocal_energy)),
                "other": float(min(1.0, other_energy)),
                "flux": float(norm_flux)
            }
            results["stems"] = stems
            
            # AI Color Harmony Logic
            mood = "neutral"
            base_color = [255, 255, 255] # White
            if low_energy_sum > high_energy_sum * 1.5:
                mood = "deep"
                # Deep/Warm: Reds, Purples, Blues
                base_color = [min(255, int(low_energy_sum * 0.5)), 0, min(255, int(low_energy_sum * 0.8))]
            elif high_energy_sum > low_energy_sum * 1.5:
                mood = "energetic"
                # Energetic/Bright: Cyans, Yellows, Whites
                base_color = [min(255, int(high_energy_sum * 0.8)), 255, min(255, int(high_energy_sum * 0.8))]
            else:
                mood = "balanced"
                # Balanced: Greens, Magentas
                base_color = [0, 255, min(255, int((low_energy_sum+high_energy_sum)*0.5))]

            # Ensure valid RGB values
            base_color = [max(0, min(255, c)) for c in base_color]
            
            # Create a harmonious palette (Triadic or Analogous variation)
            palette = [
                base_color,
                [base_color[1], base_color[2], base_color[0]], # Shifted
                [255 - base_color[0], 255 - base_color[1], 255 - base_color[2]] # Inverted/Complementary
            ]
            
            # Musical Structure Analysis (Segmentation)
            self.long_term_energy_history.append(total_energy)
            if len(self.long_term_energy_history) > self.long_term_size:
                self.long_term_energy_history.pop(0)
            
            lt_avg = np.mean(self.long_term_energy_history)
            lt_max = np.max(self.long_term_energy_history) if self.long_term_energy_history else 1
            
            # Simple thresholding for segments
            if total_energy > lt_avg * 2.0 or (lt_avg > 0 and total_energy > lt_max * 0.9):
                self.current_section = "DROP"
                self.energy_level = 5
            elif total_energy > lt_avg * 1.3:
                self.current_section = "CHORUS"
                self.energy_level = 4
            elif total_energy > lt_avg * 1.1:
                self.current_section = "BUILD-UP"
                self.energy_level = 3
            elif total_energy < lt_avg * 0.4:
                self.current_section = "BREAKDOWN / OUTRO"
                self.energy_level = 1
            else:
                self.current_section = "VERSE"
                self.energy_level = 2

            results["mood"] = mood
            results["palette"] = palette
            results["section"] = self.current_section
            results["energy_level"] = self.energy_level
            results["measure_pos"] = self.beat_tracker.get_measure_pos()
            
            # AI Dashboard Metrics (Module 6.1)
            results["ai_metrics"] = {
                "energy": float(min(1.0, total_energy / (lt_avg * 2.5) if lt_avg > 0 else 0)),
                "wash": float(min(1.0, low_energy_sum / (lt_avg * 1.5) if lt_avg > 0 else 0)),
                "beam": float(min(1.0, high_energy_sum / (lt_avg * 1.5) if lt_avg > 0 else 0)),
                "unity": 85, # Mock 85% unity
                "symmetry": "Mirror"
            }

            self.last_results = {
                "section": self.current_section,
                "energy_level": self.energy_level,
                "stems": stems,
                "bpm": results["bpm"],
                "ai_metrics": results["ai_metrics"]
            }

            return results
        except Exception as e:
            print(f"Error reading audio: {e}")
            return {}

    def set_device(self, device_index):
        """Switches the input device."""
        if self.stream:
            self.stream.stop_stream()
            self.stream.close()
        self.start_stream(device_index)

    def close(self):
        """Cleans up resources."""
        if self.stream:
            self.stream.stop_stream()
            self.stream.close()
        self.audio.terminate()
        print("Audio stream closed.")
