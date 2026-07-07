// Run once: node generate-icons.js
// Generates PNG icons needed for PWA (iOS requires PNG for apple-touch-icon)
'use strict';

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function generateIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const radius = size * 0.18;

  // Background
  ctx.fillStyle = '#0d0d0d';
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(size - radius, 0);
  ctx.quadraticCurveTo(size, 0, size, radius);
  ctx.lineTo(size, size - radius);
  ctx.quadraticCurveTo(size, size, size - radius, size);
  ctx.lineTo(radius, size);
  ctx.quadraticCurveTo(0, size, 0, size - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.fill();

  const fontSize = Math.round(size * 0.27);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${fontSize}px Georgia, serif`;

  // FIT in white
  ctx.fillStyle = '#ffffff';
  ctx.fillText('FIT', size / 2, size * 0.38);

  // ANYA in orange
  ctx.fillStyle = '#FF5C00';
  ctx.fillText('ANYA', size / 2, size * 0.68);

  return canvas.toBuffer('image/png');
}

const outDir = path.join(__dirname, 'public/icons');
fs.mkdirSync(outDir, { recursive: true });

[192, 512].forEach(size => {
  const buf = generateIcon(size);
  const out = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(out, buf);
  console.log(`✓ Generated icon-${size}.png`);
});

console.log('Done! Icons saved to public/icons/');
