import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase-server';

export async function POST(req) {
  try {
    const body = await req.json();
    const { videoUrl, vibeInput, userId } = body;

    // Validate required fields
    if (!videoUrl) {
      return NextResponse.json(
        { error: 'Video URL is required' },
        { status: 400 }
      );
    }

    if (!vibeInput) {
      return NextResponse.json(
        { error: 'Vibe input is required' },
        { status: 400 }
      );
    }

    if (!userId) {
      return NextResponse.json(
        { error: 'User ID is required' },
        { status: 400 }
      );
    }

    // Extract filename from videoUrl
    let fileName = 'unknown';
    try {
      const url = new URL(videoUrl);
      const pathParts = url.pathname.split('/');
      fileName = pathParts[pathParts.length - 1] || 'unknown';
    } catch (e) {
      fileName = videoUrl.split('/').pop()?.split('?')[0] || 'unknown';
    }

    // Insert job into database
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
      return NextResponse.json(
        { error: 'Failed to create job' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      jobId: data.id,
    });
  } catch (error) {
    console.error('Generate error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
