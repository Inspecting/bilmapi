const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.send('🎬 Bilm API is running!');
});

app.get('/api/embed/:imdb', (req, res) => {
  const { imdb } = req.params;
  res.json({ embed: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', imdb });
});

app.listen(PORT, () => {
  console.log(`Server is live on port ${PORT}`);
});
