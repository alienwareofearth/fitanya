'use strict';

const cloudinary = require('cloudinary').v2;
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// Memory storage — we stream the buffer to Cloudinary
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

async function uploadBuffer(buffer, opts = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'fitaniya', resource_type: 'image', ...opts },
      (err, result) => {
        if (err) return reject(err);
        resolve({ url: result.secure_url, public_id: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

async function destroyImage(publicId) {
  try { await cloudinary.uploader.destroy(publicId); } catch {}
}

module.exports = { upload, uploadBuffer, destroyImage };
