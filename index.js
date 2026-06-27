const express = require("express");
const app = express();

// Render provides the port through an environment variable.
// Locally it falls back to 3000.
const PORT = process.env.PORT || 3000;

// A simple health-check route so we can confirm the server is alive.
app.get("/", (req, res) => {
  res.send("VaultContext backend is live.");
});

// Start listening.
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});