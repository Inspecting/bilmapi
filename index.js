const express = require('express');
const cors = require('cors');
const path = require('path');
const { getVideoFromIMDb } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('🎬 Bilm API is running!');
});

app.get('/api/embed/:imdb', async (req, res) => {
  const { imdb } = req.params;
  try {
    const video = await getVideoFromIMDb(imdb);
    res.json({ embed: video, imdb });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch video' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is live on port ${PORT}`);
});
