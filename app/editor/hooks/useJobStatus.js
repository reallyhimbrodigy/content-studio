import { useEffect, useState, useRef } from 'react';

export function useJobStatus(jobId) {
  const [jobStatus, setJobStatus] = useState({
    status: 'idle',
    progress: 0,
    step: '',
    message: '',
    videoUrl: null,
    error: null,
  });

  const esRef = useRef(null);

  useEffect(() => {
    if (!jobId) {
      setJobStatus({ status: 'idle', progress: 0, step: '', message: '', videoUrl: null, error: null });
      return;
    }

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const es = new EventSource(`/api/video-jobs/${jobId}/stream`);
    esRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setJobStatus({
          status: data.status || 'processing',
          progress: data.progress || 0,
          step: data.step || '',
          message: data.message || '',
          videoUrl: data.videoUrl || null,
          error: data.error || null,
        });
        if (data.status === 'completed' || data.status === 'failed') {
          es.close();
          esRef.current = null;
        }
      } catch (e) {
        console.error('[useJobStatus] SSE parse error:', e);
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects — no action needed
    };

    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [jobId]);

  return jobStatus;
}
