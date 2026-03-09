
import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';

const LANDSCAPE_ERROR =
  'Promptly supports vertical and square videos for TikTok, Reels, and Shorts. Please upload a vertical video or re-record in portrait mode.';

const getVideoDimensions = (file) =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      try {
        video.load();
      } catch (_) {}
    };

    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const width = Number(video.videoWidth) || null;
      const height = Number(video.videoHeight) || null;
      cleanup();
      resolve({ width, height });
    };
    video.onerror = () => {
      cleanup();
      resolve({ width: null, height: null });
    };
    video.src = url;
  });

export default function UploadZone({ onUploadComplete, userId }) {
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState(null);

  const onDrop = useCallback(
    async (acceptedFiles) => {
      if (acceptedFiles.length === 0) return;

      const file = acceptedFiles[0];
      const { width, height } = await getVideoDimensions(file);
      if (width && height && width > height) {
        setError(LANDSCAPE_ERROR);
        setIsUploading(false);
        setUploadProgress(0);
        return;
      }

      setError(null);
      setIsUploading(true);
      setUploadProgress(0);

      const formData = new FormData();
      formData.append('video', file);
      formData.append('userId', userId);

      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const progress = Math.round((e.loaded / e.total) * 100);
          setUploadProgress(progress);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          const response = JSON.parse(xhr.responseText);
          onUploadComplete(response.videoUrl, response.fileName);
          setIsUploading(false);
        } else {
          const response = JSON.parse(xhr.responseText);
          setError(response.error || 'Upload failed');
          setIsUploading(false);
          setUploadProgress(0);
        }
      });

      xhr.addEventListener('error', () => {
        setError('Network error during upload');
        setIsUploading(false);
        setUploadProgress(0);
      });

      xhr.open('POST', '/api/upload');
      xhr.send(formData);
    },
    [onUploadComplete, userId]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'video/mp4': ['.mp4'],
      'video/quicktime': ['.mov'],
      'video/x-msvideo': ['.avi'],
    },
    maxSize: 500 * 1024 * 1024, // 500MB
    multiple: false,
    disabled: isUploading,
  });

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div
        {...getRootProps()}
        className={`
          border-2 border-dashed rounded-lg p-12 text-center cursor-pointer
          transition-all duration-200
          ${isDragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'}
          ${isUploading ? 'opacity-50 cursor-not-allowed bg-gray-50' : ''}
        `}
      >
        <input {...getInputProps()} />
        
        {!isUploading ? (
          <>
            <div className="text-6xl mb-4">📤</div>
            <p className="text-xl font-semibold text-gray-700 mb-2">
              {isDragActive ? 'Drop your video here' : 'Drop your video here'}
            </p>
            <p className="text-sm text-gray-500 mb-4">
              or click to browse
            </p>
            <p className="text-xs text-gray-400">
              MP4, MOV, or AVI • Max 500MB
            </p>
          </>
        ) : (
          <div className="space-y-4">
            <p className="text-lg font-semibold text-gray-700">
              Uploading...
            </p>
            <div className="w-full bg-gray-200 rounded-full h-4 overflow-hidden">
              <div
                className="bg-blue-600 h-full transition-all duration-300 ease-out"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <p className="text-sm text-gray-600">{uploadProgress}%</p>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-700 text-sm font-medium">
            ❌ {error}
          </p>
        </div>
      )}
    </div>
  );
}
