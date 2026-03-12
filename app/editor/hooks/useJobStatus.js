
import { useEffect, useState } from 'react';
import { supabaseClient } from '@/lib/supabase-client';

export function useJobStatus(jobId) {
  const [jobStatus, setJobStatus] = useState({
    status: 'idle',
    progress: 0,
    step: '',
    message: '',
    videoUrl: null,
    error: null,
  });

  useEffect(() => {
    if (!jobId) {
      setJobStatus({ status: 'idle', progress: 0, step: '', message: '', videoUrl: null, error: null });
      return;
    }

    const fetchJob = async () => {
      const { data, error } = await supabaseClient
        .from('video_jobs')
        .select('status, progress, current_step, step_message, rendered_video_url, error_message')
        .eq('id', jobId)
        .single();

      if (error) {
        console.error('Error fetching job:', error);
        setJobStatus((prev) => ({ ...prev, error: 'Failed to fetch job status' }));
        return;
      }

      if (data) {
        setJobStatus({
          status: data.status,
          progress: data.progress || 0,
          step: data.current_step || '',
          message: data.step_message || '',
          videoUrl: data.rendered_video_url,
          error: data.error_message,
        });
      }
    };

    fetchJob();

    const channel = supabaseClient
      .channel(`job-${jobId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'video_jobs',
          filter: `id=eq.${jobId}`,
        },
        (payload) => {
          const data = payload.new;
          setJobStatus({
            status: data.status,
            progress: data.progress || 0,
            step: data.current_step || '',
            message: data.step_message || '',
            videoUrl: data.rendered_video_url,
            error: data.error_message,
          });
        }
      )
      .subscribe();

    return () => {
      supabaseClient.removeChannel(channel);
    };
  }, [jobId]);

  return jobStatus;
}
