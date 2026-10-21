import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { env } from '../config/env';
import { db } from '../config/db';
import { ApiError } from '../utils/apiError';

export const uploadRoot = path.resolve(process.cwd(), env.upload.dir);
export const uploadPublicPath = '/uploads';
fs.mkdirSync(uploadRoot, { recursive: true });

// Allowed upload types mapped to the extension the file is stored under.
// The extension MUST come from this map (never from the client-supplied
// filename): express.static picks the response Content-Type from the stored
// extension, so honouring an attacker-chosen name like "x.html" or "x.svg"
// would let uploaded files execute as HTML/SVG (stored XSS).
const ALLOWED: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  // Voice messages & round video notes recorded by the browser.
  'audio/webm': '.weba',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/wav': '.wav',
  'audio/x-m4a': '.m4a',
};

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadRoot),
  filename: (_req, file, cb) => {
    const ext = ALLOWED[file.mimetype] ?? '.bin';
    const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    cb(null, name);
  },
});

if (env.cloudinary.enabled) {
  cloudinary.config({
    cloud_name: env.cloudinary.cloudName,
    api_key: env.cloudinary.apiKey,
    api_secret: env.cloudinary.apiSecret,
    secure: true,
  });
}

export const upload = multer({
  storage:
    env.cloudinary.enabled || env.isProd
      ? multer.memoryStorage()
      : diskStorage,
  limits: { fileSize: env.upload.maxBytes },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype in ALLOWED) cb(null, true);
    else cb(new ApiError(400, `Unsupported file type: ${file.mimetype}`));
  },
});

function uploadToCloudinary(file: Express.Multer.File): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: env.cloudinary.folder,
        resource_type: 'auto',
        use_filename: false,
        unique_filename: true,
      },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error('Cloudinary did not return an upload result'));
          return;
        }
        resolve(result);
      },
    );

    stream.end(file.buffer);
  });
}

// Stores an uploaded file permanently when Cloudinary is configured and
// otherwise returns the URL of the local disk copy created by Multer.
export async function storeUploadedFile(file: Express.Multer.File): Promise<string> {
  if (env.cloudinary.enabled) {
    const result = await uploadToCloudinary(file);
    return result.secure_url;
  }

  if (env.isProd) {
    if (!file.buffer) throw new Error('Uploaded file is missing its memory buffer');
    const stored = await db.storedUpload.create({
      data: {
        data: file.buffer,
        mimeType: file.mimetype,
        originalName: file.originalname.slice(0, 255),
        size: file.size,
      },
      select: { id: true },
    });
    return `${env.apiUrl}${uploadPublicPath}/${stored.id}`;
  }

  if (!file.filename) throw new Error('Uploaded file is missing its local filename');
  return `${env.apiUrl}${uploadPublicPath}/${file.filename}`;
}

export async function serveStoredUpload(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const stored = await db.storedUpload.findUnique({
    where: { id: req.params.id },
    select: { data: true, mimeType: true, size: true },
  });
  if (!stored) {
    next();
    return;
  }

  res.set({
    'Content-Type': stored.mimeType,
    'Content-Length': String(stored.size),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    // Uploads must never execute as documents, even if a browser mishandles
    // the declared media type.
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  res.send(Buffer.from(stored.data));
}
