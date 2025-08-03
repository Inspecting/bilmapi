const express = require('express');
const app = express();
const path = require('path');
const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/embed/:imdb', (req, res) => {
    const imdb = req.params.imdb;
    res.json({
        title: "Public Domain Movie",
        video: "/sample-video.m3u8",
        subtitles: "/subs/sample.vtt"
    });
});

app.listen(PORT, () => {
    console.log(`Server is live on port ${PORT}`);
});