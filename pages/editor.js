
import { useState, useEffect, useRef } from 'react';
import { useJobStatus } from '@/app/editor/hooks/useJobStatus';
import UploadZone from '@/app/editor/components/UploadZone';
import VibeInput from '@/app/editor/components/VibeInput';

export default function EditorPage() {
  const [userId] = useState(() => `user-${Math.random().toString(36).substr(2, 9)}`);
  const [videoUrl, setVideoUrl] = useState(null);
  const [videoFileName, setVideoFileName] = useState(null);
  const [jobId, setJobId] = useState(null);

  const jobStatus = useJobStatus(jobId);
  const { status, progress, message, videoUrl: outputVideoUrl, error: jobError } = jobStatus;

  // Typing animation state
  const [displayedMessage, setDisplayedMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const typingRef = useRef(null);
  const messageRef = useRef('');

  useEffect(() => {
    const incoming = message || 'Getting started...';
    if (incoming === messageRef.current) return;
    messageRef.current = incoming;

    // Clear any running animation
    if (typingRef.current) clearInterval(typingRef.current);
    setIsTyping(true);
    setDisplayedMessage('');

    let i = 0;
    typingRef.current = setInterval(() => {
      i++;
      setDisplayedMessage(incoming.slice(0, i));
      if (i >= incoming.length) {
        clearInterval(typingRef.current);
        setIsTyping(false);
      }
    }, 28);

    return () => {
      if (typingRef.current) clearInterval(typingRef.current);
    };
  }, [message]);

  const handleUploadComplete = (url, fileName) => {
    setVideoUrl(url);
    setVideoFileName(fileName);
  };

  const handleVibeSubmit = async (vibeInput) => {
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          videoUrl,
          vibeInput,
          userId,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to create job');
      }

      const data = await response.json();
      setJobId(data.jobId);
    } catch (error) {
      console.error('Error creating job:', error);
      alert('Failed to start video generation. Please try again.');
    }
  };

  const handleReset = () => {
    setVideoUrl(null);
    setVideoFileName(null);
    setJobId(null);
  };

  const getEstimatedTime = (currentStatus) => {
    switch (currentStatus) {
      case 'queued':
        return '~2 minutes';
      case 'analyzing':
        return '~1.5 minutes';
      case 'editing':
        return '~1 minute';
      case 'rendering':
        return '~30 seconds';
      default:
        return '~2 minutes';
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 py-4 px-6">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-2xl font-bold text-gray-900">
            🎬 AI Video Editor
          </h1>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">
        {/* State 1: No video uploaded */}
        {!videoUrl && !jobId && (
          <div className="space-y-6">
            <div className="text-center mb-8">
              <h2 className="text-3xl font-bold text-gray-900 mb-2">
                Upload Your Video
              </h2>
              <p className="text-gray-600">
                Transform your raw footage into engaging content with AI
              </p>
            </div>
            <UploadZone onUploadComplete={handleUploadComplete} userId={userId} />
          </div>
        )}

        {/* State 2: Video uploaded, no job started */}
        {videoUrl && !jobId && (
          <div className="space-y-8">
            <div className="bg-green-50 border border-green-200 rounded-lg p-6">
              <div className="flex items-center space-x-3">
                <span className="text-3xl">✅</span>
                <div>
                  <p className="font-semibold text-green-900">Video uploaded successfully!</p>
                  <p className="text-sm text-green-700">{videoFileName}</p>
                </div>
              </div>
            </div>

            <div className="text-center mb-8">
              <h2 className="text-3xl font-bold text-gray-900 mb-2">
                Describe Your Vision
              </h2>
              <p className="text-gray-600">
                Tell us what kind of edit you want
              </p>
            </div>

            <VibeInput onSubmit={handleVibeSubmit} />
          </div>
        )}

        {/* Initial Loading */}
        {jobId && status === 'idle' && (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center space-y-4">
            <div className="text-6xl">⏳</div>
            <h3 className="text-2xl font-semibold">Starting...</h3>
            <p className="text-gray-600">Initializing your video editing job</p>
          </div>
        )}

        {/* State 3: Job processing */}
        {jobId && status && status !== 'completed' && status !== 'failed' && status !== 'idle' && (
          <div className="space-y-6">
            <div className="bg-white border border-gray-200 rounded-lg p-8 space-y-8">

              {/* Animated message — Claude/ChatGPT style */}
              <div className="flex items-start space-x-3">
                <div className="flex-shrink-0 w-8 h-8 bg-black rounded-full flex items-center justify-center mt-0.5">
                  <span className="text-white text-xs font-bold">P</span>
                </div>
                <div className="flex-1 min-h-[2rem]">
                  <p className="text-base text-gray-900 leading-relaxed">
                    {displayedMessage}
                    {isTyping && (
                      <span className="inline-block w-0.5 h-4 bg-gray-900 ml-0.5 align-middle animate-pulse" />
                    )}
                    {!isTyping && displayedMessage && (
                      <span className="inline-flex space-x-1 ml-2 align-middle">
                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </span>
                    )}
                  </p>
                </div>
              </div>

              {/* Progress bar */}
              <div className="space-y-2">
                <div className="w-full bg-gray-100 rounded-full h-1 overflow-hidden">
                  <div
                    className="bg-black h-full rounded-full transition-all duration-700 ease-out"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-xs text-gray-400 text-right">{progress}%</p>
              </div>

            </div>
          </div>
        )}

        {/* State 4: Job completed */}
        {status === 'completed' && outputVideoUrl && (
          <div className="space-y-6">
            <div className="text-center mb-8">
              <h2 className="text-3xl font-bold text-gray-900 mb-2">
                Your Video is Ready! 🎉
              </h2>
              <p className="text-gray-600">
                Download or share your AI-edited masterpiece
              </p>
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
              <video
                src={outputVideoUrl}
                controls
                className="w-full rounded-lg"
              >
                Your browser does not support the video tag.
              </video>

              <div className="flex space-x-4">
                <a
                  href={outputVideoUrl}
                  download
                  className="flex-1 px-6 py-3 bg-black text-white font-semibold rounded-lg hover:bg-gray-800 transition-colors text-center"
                >
                  Download Video
                </a>
                <button
                  onClick={handleReset}
                  className="flex-1 px-6 py-3 bg-gray-200 text-gray-900 font-semibold rounded-lg hover:bg-gray-300 transition-colors"
                >
                  Edit Another Video
                </button>
              </div>
            </div>
          </div>
        )}

        {/* State 5: Job error */}
        {(status === 'failed' || jobError) && (
          <div className="space-y-6">
            <div className="bg-red-50 border border-red-200 rounded-lg p-6">
              <div className="flex items-center space-x-3 mb-4">
                <span className="text-3xl">❌</span>
                <div>
                  <p className="font-semibold text-red-900">Something went wrong</p>
                  <p className="text-sm text-red-700">
                    {jobError || 'Failed to process your video'}
                  </p>
                </div>
              </div>

              <button
                onClick={handleReset}
                className="w-full px-6 py-3 bg-red-600 text-white font-semibold rounded-lg hover:bg-red-700 transition-colors"
              >
                Try Again
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
