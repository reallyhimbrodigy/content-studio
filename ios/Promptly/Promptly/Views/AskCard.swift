import SwiftUI
import PhotosUI
import Photos

/// Phase D ask-back card. Rendered inside the Lumen/progress bubble when a job
/// is parked at `needs_input`. Shows Lumen's warm, optional question and the
/// answer affordances for its `answer_kinds`, plus a prominent penalty-free
/// Skip. On submit it uploads any image/clip to S3, then resubmits on the
/// re-edit rail; `onResolved` optimistically returns the bubble to "processing"
/// so the bar resumes without waiting for the next poll.
struct AskCard: View {
    let ask: AskPayload
    let jobId: String
    /// Called after a successful submit OR a safe server no-op (already
    /// resumed / self-completed) — the parent flips the bubble to processing.
    let onResolved: () -> Void

    @State private var text = ""
    @State private var pickedImageItem: PhotosPickerItem?
    @State private var imageData: Data?
    @State private var imageName = "answer.jpg"
    @State private var clipAsset: PickedVideo?
    @State private var showClipPicker = false
    @State private var selectedChoice: String?
    @State private var isSubmitting = false
    @State private var errorText: String?

    private var trimmedText: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasAnswer: Bool {
        !trimmedText.isEmpty || imageData != nil || clipAsset != nil || selectedChoice != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Lumen's question — warm, forward-framed.
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "sparkles")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(LinearGradient(colors: [Color(red: 1, green: 0.78, blue: 0.42), .white],
                                                    startPoint: .leading, endPoint: .trailing))
                    .padding(.top, 2)
                Text(ask.prompt)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(.white.opacity(0.95))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let ctx = ask.context, !ctx.isEmpty {
                Text(ctx)
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.5))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if ask.accepts(.choice), let choices = ask.choices, !choices.isEmpty {
                choiceChips(choices)
            }
            if ask.accepts(.text) {
                textField
            }
            if ask.accepts(.image) || ask.accepts(.clip) {
                attachmentRow
            }

            if let err = errorText {
                Text(err)
                    .font(.system(size: 12))
                    .foregroundColor(.red.opacity(0.9))
            }

            actions
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color(red: 1, green: 0.82, blue: 0.5).opacity(0.28), lineWidth: 0.5))
        )
        .frame(maxWidth: 340, alignment: .leading)
        .disabled(isSubmitting)
        .opacity(isSubmitting ? 0.6 : 1)
        .onChange(of: pickedImageItem) { _, item in loadImage(item) }
        .sheet(isPresented: $showClipPicker) {
            NativeVideoPicker(maxSelection: 1) { picked in
                if let first = picked.first { clipAsset = first }
            }
            .ignoresSafeArea()
        }
    }

    // MARK: affordances

    @ViewBuilder private func choiceChips(_ choices: [AskChoice]) -> some View {
        FlowChips(choices: choices, selected: selectedChoice) { c in
            selectedChoice = (selectedChoice == c.value) ? nil : c.value
        }
    }

    private var textField: some View {
        TextField("Add a little context…", text: $text, axis: .vertical)
            .font(.system(size: 14))
            .foregroundColor(.white)
            .tint(.white)
            .lineLimit(1...4)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.06)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5))
    }

    private var attachmentRow: some View {
        HStack(spacing: 8) {
            if ask.accepts(.image) {
                PhotosPicker(selection: $pickedImageItem, matching: .images) {
                    attachChip(icon: imageData != nil ? "checkmark.circle.fill" : "photo",
                               label: imageData != nil ? "Screenshot added" : "Add a screenshot",
                               active: imageData != nil)
                }
                .buttonStyle(.plain)
            }
            if ask.accepts(.clip) {
                Button { showClipPicker = true } label: {
                    attachChip(icon: clipAsset != nil ? "checkmark.circle.fill" : "video.badge.plus",
                               label: clipAsset != nil ? "Clip added" : "Add a clip",
                               active: clipAsset != nil)
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
    }

    private func attachChip(icon: String, label: String, active: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 12, weight: .semibold))
            Text(label).font(.system(size: 13, weight: .medium)).lineLimit(1)
        }
        .foregroundColor(active ? Color(red: 0.55, green: 0.95, blue: 0.7) : .white.opacity(0.85))
        .padding(.horizontal, 11).padding(.vertical, 8)
        .background(Capsule().fill(Color.white.opacity(0.06)))
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5))
    }

    private var actions: some View {
        HStack(spacing: 10) {
            Button { submit(skip: true) } label: {
                Text("Skip — use what I have")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.white.opacity(0.6))
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)

            if isSubmitting {
                ProgressView().tint(.white).scaleEffect(0.8)
            } else {
                Button { submit(skip: false) } label: {
                    Text("Send")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(hasAnswer ? .black : .white.opacity(0.35))
                        .padding(.horizontal, 16).padding(.vertical, 8)
                        .background(Capsule().fill(hasAnswer ? Color.white : Color.white.opacity(0.08)))
                }
                .buttonStyle(.plain)
                .disabled(!hasAnswer)
            }
        }
        .padding(.top, 2)
    }

    // MARK: submit

    private func loadImage(_ item: PhotosPickerItem?) {
        guard let item else { return }
        Task {
            if let data = try? await item.loadTransferable(type: Data.self) {
                await MainActor.run { imageData = data; imageName = "answer-\(jobId.prefix(6)).jpg" }
            }
        }
    }

    private func submit(skip: Bool) {
        isSubmitting = true
        errorText = nil
        Task {
            do {
                var answer = AskAnswer()
                if skip {
                    answer = .skipped
                } else {
                    if ask.accepts(.text) { answer.text = trimmedText.isEmpty ? nil : trimmedText }
                    answer.choice = selectedChoice
                    if let d = imageData {
                        answer.imageKey = try await upload(data: d, name: imageName, mime: "image/jpeg")
                    }
                    if let clip = clipAsset {
                        let fileUrl = try await resolveClip(clip.asset)
                        defer { try? FileManager.default.removeItem(at: fileUrl) }
                        // Stream from disk via the BACKGROUND session (survives
                        // suspension/kill, no ~2x-file RAM copy) — a clip can be
                        // hundreds of MB, which Data(contentsOf:) would OOM.
                        answer.clipKey = try await uploadFile(fileUrl: fileUrl, mime: "video/quicktime")
                    }
                }
                _ = try await APIService.shared.answerAsk(originalJobId: jobId, askId: ask.askId, answer: answer)
                // .resumed OR .alreadyHandled → resolve; the poll shows the truth.
                await MainActor.run { onResolved() }
            } catch {
                await MainActor.run {
                    errorText = "Couldn't send that — check your connection and try again."
                    isSubmitting = false
                }
            }
        }
    }

    private func upload(data: Data, name: String, mime: String) async throws -> String {
        let resp = try await APIService.shared.getUploadUrl(fileName: name)
        guard let url = resp.uploadUrl, let key = resp.key else {
            throw APIError.jobCreationFailed("Upload URL unavailable")
        }
        try await APIService.shared.uploadToS3(url: url, data: data, mimeType: mime)
        return key
    }

    /// Upload a materialized temp file via the background session (for clips) —
    /// streams from disk, survives suspension, no whole-file RAM load.
    private func uploadFile(fileUrl: URL, mime: String) async throws -> String {
        let resp = try await APIService.shared.getUploadUrl(fileName: fileUrl.lastPathComponent)
        guard let url = resp.uploadUrl, let key = resp.key else {
            throw APIError.jobCreationFailed("Upload URL unavailable")
        }
        try await APIService.shared.uploadFileToS3(url: url, fileUrl: fileUrl, mimeType: mime, publicUrl: resp.publicUrl)
        return key
    }

    /// Write a picked PHAsset's original video to a temp file (works for
    /// on-device and iCloud assets via isNetworkAccessAllowed), for upload.
    private func resolveClip(_ asset: PHAsset) async throws -> URL {
        let resources = PHAssetResource.assetResources(for: asset)
        guard let res = resources.first(where: { $0.type == .video }) ?? resources.first else {
            throw APIError.jobCreationFailed("Couldn't read that clip")
        }
        let ext = (res.originalFilename as NSString).pathExtension
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(ext.isEmpty ? "mov" : ext)
        let opts = PHAssetResourceRequestOptions()
        opts.isNetworkAccessAllowed = true
        return try await withCheckedThrowingContinuation { cont in
            PHAssetResourceManager.default().writeData(for: res, toFile: tmp, options: opts) { err in
                if let err {
                    try? FileManager.default.removeItem(at: tmp)   // clean the partial write
                    cont.resume(throwing: err)
                } else {
                    cont.resume(returning: tmp)
                }
            }
        }
    }
}

/// Simple wrapping chip row for `choice` asks.
private struct FlowChips: View {
    let choices: [AskChoice]
    let selected: String?
    let onTap: (AskChoice) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(choices) { choice in
                Button { onTap(choice) } label: {
                    HStack(spacing: 6) {
                        Image(systemName: selected == choice.value ? "largecircle.fill.circle" : "circle")
                            .font(.system(size: 13))
                        Text(choice.label).font(.system(size: 14, weight: .medium))
                            .fixedSize(horizontal: false, vertical: true)
                            .multilineTextAlignment(.leading)
                    }
                    .foregroundColor(selected == choice.value ? .white : .white.opacity(0.8))
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10)
                        .fill(selected == choice.value ? Color.white.opacity(0.1) : Color.white.opacity(0.04)))
                    .overlay(RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(selected == choice.value ? Color.white.opacity(0.25) : Color.white.opacity(0.1), lineWidth: 0.5))
                }
                .buttonStyle(.plain)
            }
        }
    }
}
