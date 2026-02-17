/**
 * Cron job endpoint for processing queued video editing jobs
 *
 * Triggered by Vercel Cron every 10 seconds (configured in vercel.json)
 *
 * Workflow:
 * 1. Verify cron secret for security
 * 2. Fetch up to 3 queued jobs
 * 3. Process each job through the full pipeline
 * 4. Return summary of processed jobs
 *
 * Security: Requires CRON_SECRET in Authorization header
 */

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase-server';
import { processEditJob } from '@/lib/video-processor/process-job';

/**
 * Process queued edit jobs via cron.
 * @param {Request} request
 * @returns {Promise<NextResponse>}
 */
export async function GET(request) {
  try {
    // STEP 1: Verify cron secret
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // STEP 2: Fetch queued jobs
    const { data: jobs, error } = await supabase
      .from('edit_jobs')
      .select('*')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(3);

    if (error) {
      throw new Error(`Failed to fetch queued jobs: ${error.message}`);
    }

    // STEP 3: No jobs queued
    if (!jobs || jobs.length === 0) {
      return NextResponse.json({ message: 'No queued jobs', processed: 0 });
    }

    // STEP 4: Process jobs sequentially
    const results = [];
    for (const job of jobs) {
      try {
        console.log(`[cron/process-jobs] Processing job ${job.id}...`);
        const finalVideoUrl = await processEditJob(job);
        results.push({ jobId: job.id, success: true, videoUrl: finalVideoUrl });
        console.log(`[cron/process-jobs] ✅ Job ${job.id} completed: ${finalVideoUrl}`);
      } catch (jobError) {
        console.error(`[cron/process-jobs] ❌ Job ${job.id} failed:`, jobError?.message || jobError);
        results.push({ jobId: job.id, success: false, error: jobError?.message || 'Unknown job error' });
      }
    }

    // STEP 5: Return summary
    return NextResponse.json({
      message: 'Cron job completed',
      processed: jobs.length,
      results,
    });
  } catch (error) {
    console.error('[cron/process-jobs] Fatal cron endpoint error:', error);
    return NextResponse.json({ error: error?.message || 'Internal cron error' }, { status: 500 });
  }
}

