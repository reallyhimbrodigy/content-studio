import { supabase } from '@/lib/supabase-server';

export const config = {
  api: {
    bodyParser: false,
  },
};

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const ALLOWED_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo'];
const ALLOWED_EXTENSIONS = ['.mp4', '.mov', '.avi'];

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function stripMultipartHeader(part) {
  const index = part.indexOf('\r\n\r\n');
  if (index === -1) return { headers: '', body: Buffer.alloc(0) };
  const headers = part.slice(0, index).toString('utf8');
  let body = part.slice(index + 4);
  if (body.slice(-2).toString() === '\r\n') {
    body = body.slice(0, -2);
  }
  return { headers, body };
}

function parseMultipart(buffer, contentType = '') {
  const boundaryMatch = contentType.match(/boundary=(.+)$/i);
  if (!boundaryMatch) throw new Error('Invalid multipart form data: missing boundary');
  const boundary = Buffer.from(`--${boundaryMatch[1]}`);

  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    const next = buffer.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = buffer.slice(start + boundary.length + 2, next - 2);
    if (part.length > 0) parts.push(part);
    start = next;
  }

  const result = { fields: {}, files: {} };
  for (const part of parts) {
    const { headers, body } = stripMultipartHeader(part);
    const nameMatch = headers.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;

    const fieldName = nameMatch[1];
    const filenameMatch = headers.match(/filename="([^"]*)"/i);
    const typeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

    if (filenameMatch && filenameMatch[1]) {
      result.files[fieldName] = {
        name: filenameMatch[1],
        type: typeMatch ? typeMatch[1].trim() : '',
        size: body.length,
        buffer: body,
      };
    } else {
      result.fields[fieldName] = body.toString('utf8');
    }
  }

  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawBody = await readRequestBody(req);
    const { fields, files } = parseMultipart(rawBody, req.headers['content-type'] || '');

    const file = files.video;
    const userId = fields.userId;

    if (!file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    if (file.size > MAX_FILE_SIZE) {
      return res.status(400).json({ error: 'File size exceeds 500MB limit' });
    }

    const fileExtension = file.name.toLowerCase().match(/\.[^.]*$/)?.[0] || '';
    if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXTENSIONS.includes(fileExtension)) {
      return res.status(400).json({ error: 'Only MP4, MOV, and AVI files are allowed' });
    }

    const timestamp = Date.now();
    const sanitizedFilename = file.name
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      .replace(/_{2,}/g, '_');
    const storagePath = `${userId}/${timestamp}-${sanitizedFilename}`;

    const { error } = await supabase.storage
      .from('videos')
      .upload(storagePath, file.buffer, {
        contentType: file.type,
        upsert: false,
      });

    if (error) {
      console.error('Supabase upload error:', error);
      return res.status(500).json({ error: 'Failed to upload video to storage' });
    }

    const { data: urlData } = supabase.storage
      .from('videos')
      .getPublicUrl(storagePath);

    return res.status(200).json({
      success: true,
      videoUrl: urlData.publicUrl,
      fileName: sanitizedFilename,
      fileSize: file.size,
      storagePath,
    });
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ error: 'Internal server error during upload' });
  }
}
