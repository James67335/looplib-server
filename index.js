require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());
app.use(express.json());

const AUDIO_DIR = path.join(__dirname, 'audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      title TEXT,
      creator TEXT,
      audio_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database ready');
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/yt-dlp-version', (req, res) => {
  try {
    const version = execSync('yt-dlp --version').toString().trim();
    res.json({ version });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/extract', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

   // Resolve short URLs, strip tracking params, rewrite /photo/ to /video/
  try {
    const resolved = execSync(`curl -Ls -o /dev/null -w "%{url_effective}" "${url}"`).toString().trim();
    if (resolved) {
      const u = new URL(resolved);
      url = `${u.origin}${u.pathname}`.replace('/photo/', '/video/');
    }
  } catch (e) {}

  const id = Date.now().toString();
  const tmpPath = path.join(AUDIO_DIR, `${id}.mp3`);

  try {
    let title = 'TikTok Sound';
    let creator = 'Unknown';
    try {
      const metaRaw = execSync(
        `yt-dlp --print "%(title)s|||%(uploader)s" --no-download --no-playlist "${url}"`,
        { timeout: 30000 }
      ).toString().trim();
      const parts = metaRaw.split('|||');
      if (parts[0]) title = parts[0].trim();
      if (parts[1]) creator = '@' + parts[1].trim();
    } catch (e) {
      console.log('Metadata fetch failed, using defaults');
    }

    execSync(
      `yt-dlp -x --audio-format mp3 --audio-quality 0 --no-playlist -o "${tmpPath}" "${url}"`,
      { timeout: 60000 }
    );

    if (!fs.existsSync(tmpPath)) {
      return res.status(500).json({ error: 'Audio extraction failed' });
    }

    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: `${id}.mp3`,
      Body: fs.readFileSync(tmpPath),
      ContentType: 'audio/mpeg',
    }));

    fs.unlinkSync(tmpPath);

    const audioUrl = `${process.env.R2_PUBLIC_URL}/${id}.mp3`;

    await pool.query(
      `INSERT INTO tracks (id, title, creator, audio_url) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [id, title, creator, audioUrl]
    );

    res.json({ id, audioUrl, title, creator });

  } catch (err) {
    const stdout = err.stdout ? err.stdout.toString() : '';
    const stderr = err.stderr ? err.stderr.toString() : '';
    console.error('EXTRACTION ERROR:', err.message);
    console.error('STDOUT:', stdout);
    console.error('STDERR:', stderr);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    res.status(500).json({ error: 'Failed to extract audio' });
  }
});

app.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  try {
    const { rows } = await pool.query(
      `SELECT id, title, creator, audio_url, created_at FROM tracks
       WHERE title ILIKE $1 OR creator ILIKE $1
       ORDER BY created_at DESC LIMIT 20`,
      [`%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.post('/process', async (req, res) => {
  const { audioUrl, trimStart, trimEnd, speed, bass, volume } = req.body;
  if (!audioUrl) return res.status(400).json({ error: 'No audioUrl provided' });

  const id = Date.now().toString();
  const tmpInput = path.join(AUDIO_DIR, `input_${id}.mp3`);
  const tmpOutput = path.join(AUDIO_DIR, `output_${id}.mp3`);

  try {
    // Download original from R2
    const { execSync: exec } = require('child_process');
    execSync(`curl -s -o "${tmpInput}" "${audioUrl}"`, { timeout: 30000 });

    if (!fs.existsSync(tmpInput)) {
      return res.status(500).json({ error: 'Failed to download audio' });
    }

    // Get duration for trim calculation
    const durationRaw = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tmpInput}"`
    ).toString().trim();
    const totalDuration = parseFloat(durationRaw);

    const start = (trimStart ?? 0) * totalDuration;
    const end = (trimEnd ?? 1) * totalDuration;
    const speedVal = Math.max(0.5, Math.min(2.0, speed ?? 1.0));
    const bassVal = Math.max(-10, Math.min(10, bass ?? 0));
    const volumeVal = Math.max(0.5, Math.min(2.0, (volume ?? 100) / 100));

    // Build ffmpeg filter chain
    const filters = [];
    filters.push(`atempo=${speedVal}`);
    if (bassVal !== 0) {
      const gain = bassVal > 0 ? bassVal * 3 : bassVal * 3;
      filters.push(`equalizer=f=100:width_type=o:width=2:g=${gain}`);
    }
    filters.push(`volume=${volumeVal}`);

    const filterStr = filters.join(',');

    execSync(
      `ffmpeg -y -ss ${start} -to ${end} -i "${tmpInput}" -af "${filterStr}" -codec:a libmp3lame -q:a 2 "${tmpOutput}"`,
      { timeout: 120000 }
    );

    if (!fs.existsSync(tmpOutput)) {
      return res.status(500).json({ error: 'Audio processing failed' });
    }

    // Upload processed file to R2
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: `processed_${id}.mp3`,
      Body: fs.readFileSync(tmpOutput),
      ContentType: 'audio/mpeg',
    }));

    const processedUrl = `${process.env.R2_PUBLIC_URL}/processed_${id}.mp3`;

    // Log to Postgres
    await pool.query(
      `INSERT INTO tracks (id, title, creator, audio_url) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [`processed_${id}`, 'Processed Sound', 'Spectr Studio', processedUrl]
    );

    res.json({ audioUrl: processedUrl });

  } catch (err) {
    console.error('PROCESS ERROR:', err.message);
    res.status(500).json({ error: 'Failed to process audio' });
  } finally {
    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
    if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
  }
});

initDb().then(() => {
  app.listen(3000, () => {
    console.log('LoopLib server running on port 3000');
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});