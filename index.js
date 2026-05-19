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

app.post('/extract', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const id = Date.now().toString();
  const tmpPath = path.join(AUDIO_DIR, `${id}.mp3`);

  try {
    let title = 'TikTok Sound';
    let creator = 'Unknown';
    try {
      const metaRaw = execSync(
        `yt-dlp --print "%(title)s|||%(uploader)s" --no-download "${url}"`,
        { timeout: 30000 }
      ).toString().trim();
      const parts = metaRaw.split('|||');
      if (parts[0]) title = parts[0].trim();
      if (parts[1]) creator = '@' + parts[1].trim();
    } catch (e) {
      console.log('Metadata fetch failed, using defaults');
    }

    execSync(
      `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${tmpPath}" "${url}"`,
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
    console.error(err);
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

initDb().then(() => {
  app.listen(3000, () => {
    console.log('LoopLib server running on port 3000');
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
