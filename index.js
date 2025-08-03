const express = require('express');
const cors = require('cors');
const path = require('path');
const vidsrcScraper = require('./scrapers/vidsrc');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.static('public'));

app.get('/api/embed/:imdb', async (req, res) => {
  const imdb = req.params.imdb;
  try {
    const embed = await vidsrcScraper(imdb);
    if (!embed) throw new Error('No video found');
    res.json({ embed, imdb });
  } catch (err) {
    res.status(500).json({ error: 'Unable to fetch video', details: err.message });
  }
});

app.get('/embed.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'embed.html'));
});

app.listen(PORT, () => {
  console.log(`Server is live on port ${PORT}`);
});