const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/', (req, res) => {
  res.send('🎬 Bilm API is running!');
});

app.get('/api/embed/:imdb', (req, res) => {
  const { imdb } = req.params;
  res.json({ embed: `https://vidsrc.xyz/embed/movie/${imdb}` });
});

app.listen(PORT, () => {
  console.log(`Server is live on port ${PORT}`);
});
