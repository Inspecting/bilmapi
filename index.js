const express = require('express');
const cors = require('cors');
const path = require('path');
const scrape = require('./scrapers/main');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('🎬 BilmAPI is running!');
});

app.get('/api/embed/:imdb', async (req, res) => {
  const { imdb } = req.params;
  try {
    const streamUrl = await scrape(imdb);
    res.json({ embed: streamUrl, imdb });
  } catch (err) {
    res.status(500).json({ error: 'Video not found' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});