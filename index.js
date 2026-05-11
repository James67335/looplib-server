const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const AUDIO_DIR = path.join(__dirname, 'audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/extract', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  try {
    const id = Date.now().toString();
    const outputPath = path.join(AUDIO_DIR, `${id}.mp3`);

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
      `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${outputPath}" "${url}"`,
      { timeout: 60000 }
    );

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Audio extraction failed' });
    }

    res.json({
      id,
      audioUrl: `https://looplib-server-production.up.railway.app/audio/${id}.mp3`,
      title,
      creator
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to extract audio' });
  }
});

app.use('/audio', express.static(AUDIO_DIR));

app.listen(3000, () => {
  console.log('LoopLib server running on port 3000');
});