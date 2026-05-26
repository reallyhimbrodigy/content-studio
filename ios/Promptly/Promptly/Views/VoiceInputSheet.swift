import SwiftUI
import Speech
import AVFoundation

/// Full-screen voice input modal — ChatGPT iOS parity.
///
/// Tap the mic in the composer, this sheet rises with a live transcript
/// and an animated waveform. Tap Done to commit the transcript into the
/// composer, tap × to discard. Silence-detection auto-commits after
/// 1.6s of quiet so the natural cadence of "talk → done" doesn't even
/// require a tap when you stop speaking.
///
/// Uses Apple's on-device SFSpeechRecognizer when available (zero
/// server cost, sub-second turnaround, private). Falls back to the
/// hosted recognizer if on-device isn't supported for the user's
/// locale — still no server hop from our side.
struct VoiceInputSheet: View {
    @Binding var isPresented: Bool
    let onCommit: (String) -> Void

    @StateObject private var recognizer = VoiceRecognizer()
    @State private var animationPhase: CGFloat = 0

    var body: some View {
        ZStack {
            // Deep background — sits above the keyboard layer.
            Color.black.ignoresSafeArea()

            if recognizer.permissionDenied {
                permissionDeniedView
            } else {
                listeningView
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            recognizer.start()
        }
        .onDisappear {
            recognizer.stop()
        }
        .onChange(of: recognizer.silenceTimedOut) { _, timedOut in
            // Auto-commit after sustained silence. Matches ChatGPT's
            // behavior: stop talking → text drops into the box.
            if timedOut, !recognizer.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                commit()
            }
        }
    }

    // MARK: - Listening (happy path)

    @ViewBuilder
    private var listeningView: some View {
        VStack(spacing: 28) {
            Spacer(minLength: 24)

            // Transcript area. Live text grows from top, fading the
            // earliest lines if it's getting long. Empty state is a
            // soft prompt that tells the user to start talking.
            ScrollView(showsIndicators: false) {
                Text(displayText)
                    .font(.system(size: 28, weight: .regular, design: .default))
                    .tracking(0.2)
                    .foregroundColor(.white)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 28)
                    .padding(.top, 8)
                    .padding(.bottom, 80)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .mask(
                LinearGradient(
                    colors: [.clear, .black, .black, .black, .black],
                    startPoint: .top, endPoint: .bottom
                )
            )

            Spacer(minLength: 0)

            // Live audio-level waveform. Centered, animated.
            waveform
                .frame(height: 60)
                .padding(.horizontal, 40)

            // Bottom action row: cancel × on left, big Done on right.
            HStack {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    recognizer.stop()
                    isPresented = false
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(.white)
                        .frame(width: 56, height: 56)
                        .background(Color.white.opacity(0.12))
                        .clipShape(Circle())
                }

                Spacer()

                Button {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    commit()
                } label: {
                    Image(systemName: "checkmark")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundColor(.black)
                        .frame(width: 64, height: 64)
                        .background(Color.white)
                        .clipShape(Circle())
                }
                .disabled(recognizer.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .opacity(recognizer.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
            }
            .padding(.horizontal, 32)
            .padding(.bottom, 32)
        }
    }

    // MARK: - Permission denied
    //
    // Shown when the user has previously denied mic OR speech
    // recognition permission. We can't reprompt — once denied, iOS
    // requires the user to flip the toggle in Settings. So we tell
    // them exactly that and offer a one-tap deeplink.

    private var permissionDeniedView: some View {
        VStack(spacing: 18) {
            Spacer()

            ZStack {
                Circle()
                    .fill(Color.white.opacity(0.08))
                    .frame(width: 84, height: 84)
                Image(systemName: "mic.slash.fill")
                    .font(.system(size: 32, weight: .semibold))
                    .foregroundColor(.white)
            }
            .padding(.bottom, 6)

            Text("Microphone access needed")
                .font(.system(size: 22, weight: .semibold))
                .foregroundColor(.white)

            Text("Promptly needs microphone and speech recognition access to convert what you say into text. Enable both in Settings.")
                .font(.system(size: 15))
                .foregroundColor(Color.white.opacity(0.7))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            Spacer()

            VStack(spacing: 10) {
                Button {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                    isPresented = false
                } label: {
                    Text("Open Settings")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(.black)
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .background(Color.white)
                        .clipShape(Capsule())
                }

                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    isPresented = false
                } label: {
                    Text("Not now")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(Color.white.opacity(0.7))
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                }
            }
            .padding(.horizontal, 32)
            .padding(.bottom, 28)
        }
    }

    private var displayText: String {
        let trimmed = recognizer.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return "Listening…"
        }
        return trimmed
    }

    private func commit() {
        let text = recognizer.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        recognizer.stop()
        if !text.isEmpty { onCommit(text) }
        isPresented = false
    }

    // MARK: - Waveform

    private var waveform: some View {
        GeometryReader { geo in
            HStack(spacing: 4) {
                ForEach(0..<28, id: \.self) { i in
                    Capsule()
                        .fill(Color.white.opacity(0.85))
                        .frame(width: 4, height: barHeight(index: i, height: geo.size.height))
                        .animation(
                            .easeInOut(duration: 0.18)
                            .delay(Double(i % 5) * 0.02),
                            value: recognizer.audioLevel
                        )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
    }

    private func barHeight(index: Int, height: CGFloat) -> CGFloat {
        let center = 14.0
        let dist = abs(Double(index) - center)
        // Falloff so center bars are taller — feels like a real meter.
        let falloff = max(0.25, 1.0 - dist / 18.0)
        let baseline = 6.0
        let dynamic = Double(recognizer.audioLevel) * Double(height) * falloff
        return CGFloat(max(baseline, dynamic))
    }
}

// MARK: - Speech recognizer wrapper
//
// Wraps SFSpeechRecognizer + AVAudioEngine. Publishes:
//  - transcript: the live, partial transcript
//  - audioLevel: 0..1, smoothed mic loudness — drives the waveform
//  - silenceTimedOut: flips true after 1.6s of quiet (auto-commit)
//  - permissionDenied: user said no to mic or speech recognition

@MainActor
final class VoiceRecognizer: ObservableObject {
    @Published var transcript: String = ""
    @Published var audioLevel: Float = 0
    @Published var silenceTimedOut: Bool = false
    @Published var permissionDenied: Bool = false

    private let audioEngine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer(locale: Locale.current)
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silenceTimer: Task<Void, Never>?
    private var lastVoiceAt: Date = Date()

    func start() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard status == .authorized else {
                    self.permissionDenied = true
                    return
                }
                AVAudioApplication.requestRecordPermission { granted in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        if granted {
                            self.beginCapture()
                        } else {
                            self.permissionDenied = true
                        }
                    }
                }
            }
        }
    }

    func stop() {
        silenceTimer?.cancel()
        silenceTimer = nil
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func beginCapture() {
        guard let recognizer, recognizer.isAvailable else {
            permissionDenied = true
            return
        }

        // Configure session for record + playback (so any in-flight
        // player audio doesn't fight us for the input route).
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            permissionDenied = true
            return
        }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if #available(iOS 13, *) {
            req.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        }
        self.request = req

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            req.append(buffer)
            // Compute a smoothed RMS for the waveform.
            guard let data = buffer.floatChannelData?[0] else { return }
            let length = Int(buffer.frameLength)
            var sum: Float = 0
            for i in 0..<length { sum += data[i] * data[i] }
            let rms = sqrt(sum / Float(length))
            let scaled = min(1.0, rms * 8.0)
            Task { @MainActor [weak self] in
                guard let self else { return }
                // Exponential smoothing so the bars don't jitter.
                self.audioLevel = self.audioLevel * 0.55 + scaled * 0.45
                if scaled > 0.12 { self.lastVoiceAt = Date() }
            }
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            permissionDenied = true
            return
        }

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                }
                if error != nil || (result?.isFinal ?? false) {
                    // Recognizer ended — keep the audio engine going so
                    // the user can keep talking; we just no-op until
                    // stop() is called by the sheet.
                }
            }
        }

        // Silence detection — 1.6s without sound auto-commits.
        silenceTimer = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(300))
                guard let self else { return }
                if !self.transcript.isEmpty,
                   Date().timeIntervalSince(self.lastVoiceAt) > 1.6 {
                    self.silenceTimedOut = true
                    return
                }
            }
        }
    }
}
