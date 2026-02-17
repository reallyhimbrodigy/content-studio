import { supabase } from '@/lib/supabase-server';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const { videoUrl, vibeInput, userId } = body;

    if (!videoUrl) {
      return res.status(400).json({ error: 'Video URL is required' });
    }

    if (!vibeInput) {
      return res.status(400).json({ error: 'Vibe input is required' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    let fileName = 'unknown';
    try {
      const url = new URL(videoUrl);
      const pathParts = url.pathname.split('/');
      fileName = pathParts[pathParts.length - 1] || 'unknown';
    } catch (e) {
      fileName = videoUrl.split('/').pop()?.split('?')[0] || 'unknown';
    }

    const { data, error } = await supabase
      .from('edit_jobs')
      .insert({
        user_id: userId,
        video_url: videoUrl,
        video_filename: fileName,
        vibe_input: vibeInput,
        status: 'queued',
        progress: 0,
      })
      .select()
      .single();

    if (error) {
      console.error('Database error:', error);
      return res.status(500).json({ error: 'Failed to create job' });
    }

    return res.status(200).json({ jobId: data.id });
  } catch (error) {
    console.error('Generate error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
