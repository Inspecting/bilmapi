const express = require('express');
const router = express.Router();

// Sample fallback for public domain content
router.get('/:id', (req, res) => {
  const id = req.params.id;

  if (id === 'tt0017136') {
    return res.json({
      source: "https://archive.org/download/Metropolis1927/Metropolis_1927.mp4",
      subtitles: "https://example.com/subs/metropolis.vtt"
    });
  }

  res.status(404).json({ error: "Movie not available." });
});

module.exports = router;
