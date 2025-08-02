const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.static(__dirname)); // serve static files like embed.html

app.get('/', (req, res) => {
  res.send('🎬 Bilm API is running!');
});

app.get('/api/embed/:imdb', (req, res) => {
  const { imdb } = req.params;
  res.json({
    embed: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', // sample .m3u8 stream
    imdb
  });
});

app.listen(PORT, () => {
  console.log(`Server is live on port ${PORT}`);
});
