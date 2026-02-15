'use client';

import { useEffect, useState } from 'react';
import { supabaseClient } from '@/lib/supabase-client';

export function useJobStatus(jobId) {
  const [jobStatus, setJobStatus] = useState({
    status: 'idle',
    progress: 0,
    videoUrl: null,
    error: null,
  });

  useEffect(() => {
    if (!jobId) {
      setJobStatus({
        status: 'idle',
        progress: 0,
        videoUrl: null,
        error: null,
      });
      return;
    }

    // Fetch initial job data
    const fetchJob = async () => {
      const { data, error } = await supabaseClient
        .from('edit_jobs')
        .select('status, progress, rendered_video_url, error')
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
          progress: data.progress,
          videoUrl: data.rendered_video_url,
          error: data.error,
        });
      }
    };

    fetchJob();

    // Subscribe to realtime updates
    const channel = supabaseClient
      .channel(`job-${jobId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'edit_jobs',
          filter: `id=eq.${jobId}`,
        },
        (payload) => {
          const data = payload.new;
          setJobStatus({
            status: data.status,
            progress: data.progress,
            videoUrl: data.rendered_video_url,
            error: data.error,
          });
        }
      )
      .subscribe();

    // Cleanup subscription on unmount
    return () => {
      supabaseClient.removeChannel(channel);
    };
  }, [jobId]);

  return jobStatus;
}
