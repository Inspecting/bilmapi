const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/', (req, res) => {
  res.send('🎬 Bilm API is running!');
});

// Updated route to show video player directly
app.get('/api/embed/:imdb', (req, res) => {
  const { imdb } = req.params;

  // Embed player from a free source
  const embedUrl = `https://vidsrc.to/embed/movie/${imdb}`;

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Bilm Player</title>
      <style>
        html, body {
          margin: 0;
          padding: 0;
          height: 100%;
          background: black;
          overflow: hidden;
        }
        iframe {
          width: 100%;
          height: 100%;
          border: none;
        }
      </style>
    </head>
    <body>
      <iframe src="${embedUrl}" allowfullscreen allow="autoplay; fullscreen"></iframe>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Server is live on port ${PORT}`);
});
