const express = require('express');
const router = express.Router();
const scrapeEmbed = require('../scrapers/vidSrcScraper');

router.get('/:imdb', async (req, res) => {
  const { imdb } = req.params;
  try {
    const embed = await scrapeEmbed(imdb);
    res.json({ embed, imdb });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get embed link.' });
  }
});

module.exports = router;
