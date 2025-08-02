const express = require('express');
const router = express.Router();
const path = require('path');

// For now, return a test stream
router.get('/:imdb', (req, res) => {
  const { imdb } = req.params;
  res.json({
    embed: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    imdb
  });
});

module.exports = router;