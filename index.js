const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send('🎬 Bilm API is running!');
});

app.get('/api/embed/:imdb', (req, res) => {
  const { imdb } = req.params;

  // TEMPORARY: Return a real video file or stream
  const sampleHLS = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'; // replace later

  res.json({
    embed: sampleHLS,
    imdb
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
