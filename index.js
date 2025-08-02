const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 10000;

const embedRouter = require('./routes/embed');

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/embed', embedRouter);

app.get('/', (req, res) => {
  res.send('🎬 Bilm API is running!');
});

app.listen(PORT, () => {
  console.log(`Server is live on port ${PORT}`);
});