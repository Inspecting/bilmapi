const express = require('express');
const cors = require('cors');
const embedRouter = require('./routes/embed');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use('/api/embed', embedRouter);

app.get('/', (req, res) => {
  res.send('🎬 Bilm API is live and scraping!');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
